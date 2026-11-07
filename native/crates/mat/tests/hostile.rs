//! Hostile and malformed MAT-files: nothing panics, nothing allocates what a header merely claims,
//! sparse matrices are never densified, and every refusal carries a stable typed code.
use dfv_table_mat::*;
use flate2::{Compression, write::ZlibEncoder};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    io::Write,
    path::PathBuf,
};

thread_local! {
    // const-initialised, so touching it inside the allocator never allocates.
    static BIGGEST: Cell<usize> = const { Cell::new(0) };
}
struct Peak;
fn note(n: usize) {
    let _ = BIGGEST.try_with(|b| b.set(b.get().max(n)));
}
unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        note(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        note(l.size());
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        note(n);
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static ALLOC: Peak = Peak;
/// Largest single allocation made by this thread since the last reset.
fn peak() -> usize {
    BIGGEST.with(Cell::get)
}
fn reset() {
    BIGGEST.with(|b| b.set(0));
}

fn fx(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}
fn tight() -> Limits {
    Limits {
        variables: 2_000,
        variable_bytes: 5 << 20,
        page_cells: 2_000,
        children_page: 100,
        ..Limits::default()
    }
}

#[cfg(unix)]
#[test]
fn named_pipes_and_directories_are_refused_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stream.mat");
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_eq!(code(MatFile::open(&path, &tight())), "io");
    assert_eq!(code(MatFile::open(dir.path(), &tight())), "io");
}

// --- a minimal Level-5 writer for hand-made hostile files -------------------------------------
fn w32(le: bool, v: u32) -> [u8; 4] {
    if le { v.to_le_bytes() } else { v.to_be_bytes() }
}
fn pad8(mut v: Vec<u8>) -> Vec<u8> {
    while !v.len().is_multiple_of(8) {
        v.push(0);
    }
    v
}
fn el(le: bool, dt: u32, payload: &[u8]) -> Vec<u8> {
    el_len(le, dt, payload.len() as u32, payload)
}
/// Like `el` but the tag claims `len` bytes, whatever the payload really holds.
fn el_len(le: bool, dt: u32, len: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = [w32(le, dt), w32(le, len)].concat();
    v.extend_from_slice(payload);
    pad8(v)
}
fn ints(le: bool, v: &[i64], width: usize) -> Vec<u8> {
    v.iter()
        .flat_map(|x| {
            if le {
                x.to_le_bytes()[..width].to_vec()
            } else {
                x.to_be_bytes()[8 - width..].to_vec()
            }
        })
        .collect()
}
/// One miMATRIX element: flags, dims, name, then `parts` (already tagged elements).
fn matrix(le: bool, cls: u32, flags: u32, dims: &[i32], name: &str, parts: &[Vec<u8>]) -> Vec<u8> {
    let mut b = el(le, 6, &[w32(le, cls | flags << 8), w32(le, 0)].concat());
    b.extend(el(
        le,
        5,
        &dims
            .iter()
            .flat_map(|d| w32(le, *d as u32))
            .collect::<Vec<_>>(),
    ));
    b.extend(el(le, 1, name.as_bytes()));
    for p in parts {
        b.extend_from_slice(p);
    }
    el(le, 14, &b)
}
fn doubles(le: bool, v: &[f64]) -> Vec<u8> {
    el(
        le,
        9,
        &v.iter()
            .flat_map(|x| if le { x.to_le_bytes() } else { x.to_be_bytes() })
            .collect::<Vec<_>>(),
    )
}
fn dbl(name: &str, dims: &[i32], v: &[f64]) -> Vec<u8> {
    matrix(true, 6, 0, dims, name, &[doubles(true, v)])
}
fn mat_file(le: bool, elems: &[Vec<u8>]) -> Vec<u8> {
    let mut f = b"MATLAB 5.0 MAT-file, hostile fixture".to_vec();
    f.resize(124, b' ');
    f.extend(if le { [0u8, 1] } else { [1, 0] });
    f.extend(if le { b"IM" } else { b"MI" });
    for e in elems {
        f.extend_from_slice(e);
    }
    f
}
fn zlib(data: &[u8]) -> Vec<u8> {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
    z.write_all(data).unwrap();
    z.finish().unwrap()
}
/// A top-level miCOMPRESSED element (MATLAB does not pad these).
fn compressed(matrix_elem: &[u8]) -> Vec<u8> {
    let z = zlib(matrix_elem);
    [
        w32(true, 15).to_vec(),
        w32(true, z.len() as u32).to_vec(),
        z,
    ]
    .concat()
}
fn open(bytes: Vec<u8>) -> Result<MatFile> {
    MatFile::from_bytes(bytes, &Limits::default())
}
fn code<T>(r: Result<T>) -> &'static str {
    r.err().expect("expected a refusal").code()
}
fn page(f: &MatFile, i: usize) -> Result<Slice> {
    let e = &f.catalog()[i];
    f.read_slice(&e.node, &Region::first_page(&e.info.dims, 2_000))
}

// --- byte-flip and truncation sweeps -----------------------------------------------------------
fn compressed_small_fixture() -> Vec<u8> {
    let plain = fx("scipy_v5_plain.mat");
    let mut out = plain[..128].to_vec();
    let mut pos = 128;
    while pos < plain.len() {
        assert_eq!(
            u32::from_le_bytes(plain[pos..pos + 4].try_into().unwrap()),
            14
        );
        let n = u32::from_le_bytes(plain[pos + 4..pos + 8].try_into().unwrap()) as usize;
        out.extend(compressed(&plain[pos..pos + 8 + n]));
        pos += 8 + n.div_ceil(8) * 8;
    }
    out
}

/// Open and walk everything a viewer could ask for; errors are fine, panics are not.
fn walk(bytes: Vec<u8>) -> Option<Vec<String>> {
    let f = MatFile::from_bytes(bytes, &tight()).ok()?;
    for e in f.catalog() {
        let _ = f.describe(&e.node);
        if matches!(e.info.class, Class::Cell | Class::Struct) {
            let _ = f.children(&e.node, 0, 100);
        } else if e.info.sparse {
            let full = Region {
                start: vec![1, 1],
                count: e.info.dims.clone(),
            };
            let _ = f.read_sparse(&e.node, &full, 0, 100);
            let _ = f.read_slice(&e.node, &Region::first_page(&e.info.dims, 2_000));
        } else {
            let _ = f.read_slice(&e.node, &Region::first_page(&e.info.dims, 2_000));
        }
    }
    Some(f.catalog().iter().map(|e| e.info.name.clone()).collect())
}

#[test]
fn flipped_bytes_never_panic_or_allocate_what_a_header_claims() {
    let mut fixtures: Vec<_> = [
        "scipy_v5_plain.mat",
        "projection_v7.mat",
        "projection_v6.mat",
        "be_v5.mat",
        "unsupported_table.mat",
    ]
    .into_iter()
    .map(|name| (name, fx(name)))
    .collect();
    // Keep the exhaustive compressed sweep small; the million-column source has its own boundary gate.
    fixtures.push(("compressed_small_scipy", compressed_small_fixture()));
    let expected = fixtures
        .iter()
        .map(|(_, bytes)| bytes.len() * 2)
        .sum::<usize>();
    reset();
    let mut flips = 0;
    for (file, good) in fixtures {
        assert!(walk(good.clone()).is_some(), "{file}");
        for at in 0..good.len() {
            for mask in [0xff, 0x80] {
                let mut bad = good.clone();
                bad[at] ^= mask;
                assert!(
                    std::panic::catch_unwind(|| walk(bad)).is_ok(),
                    "{file} byte {at} mask {mask:#x} panicked"
                );
                flips += 1;
            }
        }
    }
    assert_eq!(flips, expected);
    assert!(
        peak() <= 12 << 20,
        "peak single allocation {} bytes",
        peak()
    );
}

#[test]
fn wide_compressed_sparse_boundaries_do_not_panic_or_allocate_from_claimed_sizes() {
    let good = fx("scipy_v5_zlib.mat");
    reset();
    assert!(walk(good.clone()).is_some());
    for at in (124..138).chain(good.len() - 4..good.len()) {
        for mask in [0xff, 0x80] {
            let mut bad = good.clone();
            bad[at] ^= mask;
            assert!(
                std::panic::catch_unwind(|| walk(bad)).is_ok(),
                "byte {at} mask {mask:#x}"
            );
        }
    }
    assert!(
        peak() <= 12 << 20,
        "peak single allocation {} bytes",
        peak()
    );
}

#[test]
fn every_truncation_is_refused_or_is_a_clean_prefix_of_the_variables() {
    reset();
    for file in [
        "scipy_v5_plain.mat",
        "scipy_v5_zlib.mat",
        "projection_v7.mat",
        "be_v5.mat",
    ] {
        let good = fx(file);
        let all = walk(good.clone()).unwrap();
        for cut in 0..good.len() {
            match MatFile::from_bytes(good[..cut].to_vec(), &tight()) {
                Err(e) => assert!(
                    [
                        "truncated",
                        "not_mat",
                        "unsupported_version_v4",
                        "corrupt",
                        "too_large"
                    ]
                    .contains(&e.code()),
                    "{file} {cut}: {}",
                    e.code()
                ),
                Ok(f) => {
                    // A cut exactly between two variables is a valid shorter file.
                    let names: Vec<String> =
                        f.catalog().iter().map(|e| e.info.name.clone()).collect();
                    assert_eq!(names, all[..names.len()], "{file} cut {cut}");
                }
            }
        }
        for cut in [0, 5, 127] {
            assert!(MatFile::from_bytes(good[..cut].to_vec(), &tight()).is_err());
        }
    }
    assert!(peak() <= 12 << 20);
}

// --- hand-made hostile structure --------------------------------------------------------------
#[test]
fn header_only_file_is_an_empty_catalog_and_short_or_foreign_files_are_typed() {
    assert_eq!(open(mat_file(true, &[])).unwrap().catalog().len(), 0);
    assert_eq!(code(open(b"MATLAB 5.0 MAT-file".to_vec())), "truncated");
    assert_eq!(code(open(vec![])), "not_mat");
    assert_eq!(code(open(b"hello".to_vec())), "not_mat");
    let mut v73 = mat_file(true, &[]);
    v73[124] = 0;
    v73[125] = 2;
    assert_eq!(code(open(v73)), "unsupported_version_v73");
    let mut odd = mat_file(true, &[]);
    odd[125] = 9;
    assert_eq!(code(open(odd)), "unsupported_version");
    let mut noend = mat_file(true, &[]);
    noend[126..128].copy_from_slice(b"XX");
    assert_eq!(code(open(noend)), "not_mat");
}

#[test]
fn big_endian_utf16_text_and_exact_integers_decode() {
    let text = matrix(
        false,
        4,
        0,
        &[1, 3],
        "t",
        &[el(false, 4, &[0x01, 0x30, 0x03, 0xa3, 0x00, 0x41])],
    );
    let big = matrix(
        false,
        14,
        0,
        &[1, 2],
        "i",
        &[el(false, 12, &ints(false, &[i64::MIN, i64::MAX], 8))],
    );
    let f = open(mat_file(false, &[text, big])).unwrap();
    assert!(!f.header().little_endian);
    let Data::Char { rows, lossy } = page(&f, 0).unwrap().data else {
        panic!()
    };
    assert_eq!((rows, lossy), (vec!["\u{130}\u{3a3}A".to_string()], false));
    let Data::Numeric { re, .. } = page(&f, 1).unwrap().data else {
        panic!()
    };
    assert_eq!(re, [Scalar::Int(i64::MIN), Scalar::Int(i64::MAX)]);
}

#[test]
fn lone_surrogates_are_replaced_and_flagged_not_dropped() {
    let t = matrix(
        true,
        4,
        0,
        &[1, 3],
        "t",
        &[el(true, 4, &[0x61, 0, 0x3d, 0xd8, 0x62, 0])],
    );
    let f = open(mat_file(true, &[t])).unwrap();
    let Data::Char { rows, lossy } = page(&f, 0).unwrap().data else {
        panic!()
    };
    assert_eq!((rows[0].as_str(), lossy), ("a\u{fffd}b", true));
}

#[test]
fn claimed_dimensions_never_become_allocations() {
    reset();
    let huge = dbl("h", &[i32::MAX, i32::MAX], &[1.0]);
    let cube = dbl("c", &[i32::MAX, i32::MAX, i32::MAX], &[1.0]);
    let f = open(mat_file(true, &[huge, cube])).unwrap();
    assert_eq!(f.catalog()[0].info.dims, [2147483647, 2147483647]);
    assert_eq!(code(page(&f, 0)), "corrupt");
    assert_eq!(code(page(&f, 1)), "too_large"); // element count overflows 64 bits
    let all = Region {
        start: vec![1, 1],
        count: vec![2147483647, 2147483647],
    };
    assert_eq!(code(f.read_slice(&f.catalog()[0].node, &all)), "too_large");
    assert!(peak() < 1 << 20, "peak {}", peak());
}

#[test]
fn negative_and_missing_dimensions_are_corrupt_and_oversized_cells_are_refused() {
    let neg = dbl("n", &[-1, 2], &[]);
    assert_eq!(code(open(mat_file(true, &[neg]))), "corrupt");
    let one = matrix(true, 6, 0, &[3], "o", &[doubles(true, &[1.0])]);
    assert_eq!(code(open(mat_file(true, &[one]))), "corrupt");
    let cell = matrix(true, 1, 0, &[100_000, 100_000], "c", &[]);
    let f = open(mat_file(true, &[cell])).unwrap();
    assert_eq!(code(f.describe(&f.catalog()[0].node)), "too_large");
    assert_eq!(code(f.children(&f.catalog()[0].node, 0, 10)), "too_large");
    let short = matrix(true, 1, 0, &[1000, 1], "s", &[dbl("", &[1, 1], &[1.0])]);
    let f = open(mat_file(true, &[short])).unwrap();
    assert!(f.describe(&f.catalog()[0].node).is_err());
    assert!(f.children(&f.catalog()[0].node, 0, 10).is_err());
}

#[test]
fn struct_field_tables_are_bounded() {
    let field_len = |w: i32, names: &[u8]| {
        matrix(
            true,
            2,
            0,
            &[1, 1],
            "s",
            &[el(true, 5, &w.to_le_bytes()), el(true, 1, names)],
        )
    };
    let describe = |bytes: Vec<u8>| {
        let f = MatFile::from_bytes(
            mat_file(true, &[bytes]),
            &Limits {
                fields: 4,
                ..Limits::default()
            },
        )
        .unwrap();
        f.describe(&f.catalog()[0].node).map(|i| i.fields)
    };
    assert_eq!(
        describe(field_len(4, b"abc\0efg\0")).unwrap(),
        ["abc", "efg"]
    );
    assert_eq!(code(describe(field_len(0, b"abcd"))), "corrupt");
    assert_eq!(code(describe(field_len(3, b"abcd"))), "corrupt");
    assert_eq!(code(describe(field_len(i32::MAX, b"abcd"))), "corrupt");
    assert_eq!(code(describe(field_len(1, b"abcdefgh"))), "too_large"); // 8 fields > 4
    assert_eq!(
        code(describe(field_len(1 << 20, &vec![b'x'; 1 << 20]))),
        "too_large"
    );
}

#[test]
fn compressed_streams_are_bounded_by_the_declared_and_the_actual_size() {
    // (1) The tag claims a 2 GB matrix inside a tiny stream.
    reset();
    let lie = zlib(&[w32(true, 14).to_vec(), w32(true, u32::MAX - 16).to_vec()].concat());
    let z = [
        w32(true, 15).to_vec(),
        w32(true, lie.len() as u32).to_vec(),
        lie,
    ]
    .concat();
    assert_eq!(code(open(mat_file(true, &[z]))), "too_large");
    assert!(peak() < 1 << 20, "peak {}", peak());

    // (2) A real 64 MB variable that compresses to a few hundred KB, against a 1 MB limit.
    let n = 8 << 20;
    let bomb = compressed(&matrix(
        true,
        6,
        0,
        &[n, 1],
        "b",
        &[doubles(true, &vec![0.0; n as usize])],
    ));
    assert!(bomb.len() < 200_000, "{}", bomb.len());
    let lim = Limits {
        variable_bytes: 1 << 20,
        ..Limits::default()
    };
    reset();
    assert_eq!(
        code(MatFile::from_bytes(mat_file(true, &[bomb]), &lim)),
        "too_large"
    );
    assert!(peak() < 2 << 20, "peak {}", peak());

    // (3) The tag says 100 KB but the stream keeps going for 40 MB.
    let honest = matrix(
        true,
        6,
        0,
        &[12_500, 1],
        "b",
        &[doubles(true, &vec![0.0; 12_500])],
    );
    let mut inner = honest.clone();
    inner.extend(vec![0u8; 40 << 20]);
    let z = zlib(&inner);
    let top = [
        w32(true, 15).to_vec(),
        w32(true, z.len() as u32).to_vec(),
        z,
    ]
    .concat();
    reset();
    let f = open(mat_file(true, &[top])).unwrap();
    assert_eq!(code(page(&f, 0)), "corrupt");
    assert!(peak() < 4 << 20, "peak {}", peak());

    // (4) The tag says 100 KB and the stream ends early.
    let short = zlib(&honest[..honest.len() - 1000]);
    let top = [
        w32(true, 15).to_vec(),
        w32(true, short.len() as u32).to_vec(),
        short,
    ]
    .concat();
    let f = open(mat_file(true, &[top]));
    assert!(f.is_err() || page(&f.unwrap(), 0).is_err());

    // (5) Corrupt zlib data, and a compressed element that is not a matrix.
    let mut z = compressed(&dbl("x", &[1, 2], &[1.0, 2.0]));
    let last = z.len() - 6;
    z[last] ^= 0x55;
    let f = open(mat_file(true, &[z]));
    assert!(f.is_err() || page(&f.unwrap(), 0).is_err());
    let not_matrix = zlib(&el(true, 6, &[0; 8]));
    let top = [
        w32(true, 15).to_vec(),
        w32(true, not_matrix.len() as u32).to_vec(),
        not_matrix,
    ]
    .concat();
    assert_eq!(code(open(mat_file(true, &[top]))), "corrupt");
}

#[test]
fn top_level_elements_must_fit_the_file_and_be_matrices() {
    let mut cut = mat_file(true, &[dbl("a", &[1, 2], &[1.0, 2.0])]);
    cut.truncate(cut.len() - 3);
    assert_eq!(code(open(cut)), "truncated");
    let far = el_len(true, 14, 1 << 30, &[0; 8]);
    assert_eq!(code(open(mat_file(true, &[far]))), "truncated");
    assert_eq!(
        code(open(mat_file(true, &[el(true, 5, &[0; 8])]))),
        "corrupt"
    );
    let mut tail = mat_file(true, &[dbl("a", &[1, 1], &[1.0])]);
    tail.extend([1, 2, 3]);
    assert_eq!(code(open(tail)), "truncated");
    let many: Vec<Vec<u8>> = (0..20)
        .map(|i| dbl(&format!("v{i}"), &[1, 1], &[1.0]))
        .collect();
    let lim = Limits {
        variables: 10,
        ..Limits::default()
    };
    assert_eq!(
        code(MatFile::from_bytes(mat_file(true, &many), &lim)),
        "too_large"
    );
    let long = "n".repeat(2_000);
    assert_eq!(
        code(open(mat_file(true, &[dbl(&long, &[1, 1], &[1.0])]))),
        "too_large"
    );
}

#[test]
fn stored_values_must_fit_the_declared_class_exactly() {
    let wide = matrix(
        true,
        8,
        0,
        &[1, 1],
        "i8",
        &[el(true, 3, &300i16.to_le_bytes())],
    );
    let f = open(mat_file(true, &[wide])).unwrap();
    assert_eq!(code(page(&f, 0)), "corrupt");
    let narrow = matrix(
        true,
        8,
        0,
        &[1, 3],
        "i8",
        &[el(true, 3, &ints(true, &[-128, 0, 127], 2))],
    );
    let f = open(mat_file(true, &[narrow])).unwrap();
    assert!(page(&f, 0).is_ok());
    // A double that cannot hold the stored 64-bit integer exactly is corruption, never rounded.
    let rounded = matrix(
        true,
        6,
        0,
        &[1, 1],
        "d",
        &[el(true, 12, &((1i64 << 60) + 1).to_le_bytes())],
    );
    let f = open(mat_file(true, &[rounded])).unwrap();
    assert_eq!(code(page(&f, 0)), "corrupt");
    let exact = matrix(
        true,
        14,
        0,
        &[1, 1],
        "q",
        &[el(true, 12, &((1i64 << 60) + 1).to_le_bytes())],
    );
    let f = open(mat_file(true, &[exact])).unwrap();
    let Data::Numeric { re, .. } = page(&f, 0).unwrap().data else {
        panic!()
    };
    assert_eq!(re, [Scalar::Int((1 << 60) + 1)]);
    // A data element whose byte length disagrees with the dimensions.
    let size = matrix(true, 6, 0, &[2, 2], "m", &[doubles(true, &[1.0, 2.0, 3.0])]);
    let f = open(mat_file(true, &[size])).unwrap();
    assert_eq!(code(page(&f, 0)), "corrupt");
    let txt = matrix(true, 4, 0, &[1, 5], "t", &[el(true, 4, &[0x61, 0])]);
    let f = open(mat_file(true, &[txt])).unwrap();
    assert_eq!(code(page(&f, 0)), "corrupt");
}

fn sparse(rows: i32, cols: i32, ir: &[i32], jc: &[i32], pr: &[f64]) -> Vec<u8> {
    let i32s = |v: &[i32]| {
        el(
            true,
            5,
            &v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<_>>(),
        )
    };
    let mut b = el(
        true,
        6,
        &[w32(true, 5), w32(true, ir.len().max(1) as u32)].concat(),
    );
    b.extend(el(
        true,
        5,
        &[rows.to_le_bytes(), cols.to_le_bytes()].concat(),
    ));
    b.extend(el(true, 1, b"sp"));
    for p in [i32s(ir), i32s(jc), doubles(true, pr)] {
        b.extend(p);
    }
    el(true, 14, &b)
}

#[test]
fn a_million_column_sparse_matrix_is_listed_by_entries_and_never_densified() {
    let mut jc = vec![0, 1];
    jc.resize(1_000_001, 2);
    let file = mat_file(
        true,
        &[sparse(
            1_000_000,
            1_000_000,
            &[0, 999_999],
            &jc,
            &[1.5, -2.5],
        )],
    );
    reset();
    let f = open(file).unwrap();
    let node = f.catalog()[0].node.clone();
    assert_eq!(f.describe(&node).unwrap().nnz, Some(2));
    let all = Region {
        start: vec![1, 1],
        count: vec![1_000_000, 1_000_000],
    };
    let l = f.read_sparse(&node, &all, 0, 10).unwrap();
    assert_eq!(
        l.entries.iter().map(|e| (e.row, e.col)).collect::<Vec<_>>(),
        [(1, 1), (999_999 + 1, 2)]
    );
    assert_eq!(code(f.read_slice(&node, &all)), "too_large");
    assert!(peak() < 1 << 20, "peak {}", peak());
}

#[test]
fn malformed_sparse_structure_is_corrupt_never_a_panic() {
    let run = |rows, cols, ir: &[i32], jc: &[i32], pr: &[f64]| {
        let f = open(mat_file(true, &[sparse(rows, cols, ir, jc, pr)])).unwrap();
        let e = &f.catalog()[0];
        let all = Region {
            start: vec![1, 1],
            count: e.info.dims.clone(),
        };
        f.describe(&e.node)?;
        f.read_sparse(&e.node, &all, 0, 100)
            .map(|s| s.entries.len())
    };
    assert_eq!(run(3, 2, &[0, 1], &[0, 1, 2], &[1.0, 2.0]).unwrap(), 2);
    assert_eq!(code(run(3, 2, &[0, 5], &[0, 1, 2], &[1.0, 2.0])), "corrupt"); // row outside the matrix
    assert_eq!(code(run(3, 2, &[0, 1], &[0, 2, 1], &[1.0, 2.0])), "corrupt"); // pointers not monotone
    assert_eq!(
        code(run(3, 2, &[0, 1], &[0, 1, 100], &[1.0, 2.0])),
        "corrupt"
    ); // nnz beyond the arrays
    assert_eq!(code(run(3, 2, &[0, 1], &[0, 1], &[1.0, 2.0])), "corrupt"); // wrong pointer count
    assert_eq!(code(run(3, 2, &[0, 1], &[0, 1, 2], &[1.0])), "corrupt"); // values shorter than nnz
}

#[test]
fn nesting_beyond_the_depth_limit_and_unknown_classes_are_refused_or_metadata_only() {
    let mut inner = dbl("", &[1, 1], &[1.0]);
    for _ in 0..70 {
        inner = matrix(true, 1, 0, &[1, 1], "", &[inner]);
    }
    let top = matrix(true, 1, 0, &[1, 1], "deep", &[inner]);
    let f = open(mat_file(true, &[top])).unwrap();
    let mut node = f.catalog()[0].node.clone();
    let mut depth = 0;
    let err = loop {
        match f.children(&node, 0, 1) {
            Ok(p) => {
                node = p.items[0].node.clone();
                depth += 1;
            }
            Err(e) => break e,
        }
    };
    assert_eq!((depth, err.code()), (64, "too_large"));
    let odd = matrix(true, 99, 0, &[1, 1], "odd", &[doubles(true, &[1.0])]);
    let f = open(mat_file(true, &[odd])).unwrap();
    assert!(matches!(
        f.catalog()[0].info.support,
        Support::MetadataOnly {
            code: "unsupported_class",
            ..
        }
    ));
    assert_eq!(code(page(&f, 0)), "unsupported_class");
}

#[test]
fn empty_sparse_coordinate_regions_preserve_shape_and_validate_bounds() {
    for (rows, cols) in [(0, 3), (3, 0), (0, 0)] {
        let f = open(mat_file(
            true,
            &[sparse(rows, cols, &[], &vec![0; cols as usize + 1], &[])],
        ))
        .unwrap();
        let entry = &f.catalog()[0];
        let r = Region::first_page(&entry.info.dims, 100);
        reset();
        let v = f.read_sparse(&entry.node, &r, 0, 100).unwrap();
        assert_eq!(v.shape, [rows as u64, cols as u64]);
        assert_eq!(v.nnz, 0);
        assert!(v.entries.is_empty() && !v.has_more);
        assert!(peak() < 65536);
        for k in 0..2 {
            let mut invalid = r.clone();
            invalid.start[k] = 0;
            assert_eq!(
                code(f.read_sparse(&entry.node, &invalid, 0, 100)),
                "bad_request"
            );
            if entry.info.dims[k] == 0 {
                invalid = r.clone();
                invalid.count[k] = 1;
                assert_eq!(
                    code(f.read_sparse(&entry.node, &invalid, 0, 100)),
                    "bad_request"
                );
            }
        }
    }
}

#[test]
fn huge_empty_char_dimensions_never_allocate_one_string_per_claimed_row() {
    for dims in [[i32::MAX, 0], [0, i32::MAX]] {
        let bytes = mat_file(
            true,
            &[matrix(true, 4, 0, &dims, "empty_text", &[el(true, 4, &[])])],
        );
        let f = open(bytes).unwrap();
        let entry = &f.catalog()[0];
        let region = Region {
            start: vec![1, 1],
            count: dims.iter().map(|d| *d as u64).collect(),
        };
        reset();
        let v = f.read_slice(&entry.node, &region).unwrap();
        assert_eq!(v.dims, dims.map(|d| d as u64));
        assert_eq!(
            v.data,
            Data::Char {
                rows: vec![],
                lossy: false
            }
        );
        assert!(
            peak() < 65536,
            "empty shape must not allocate strings for claimed rows"
        );
    }
}
