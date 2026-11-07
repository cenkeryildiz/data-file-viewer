//! Reader tests against genuine MATLAB R2026b fixtures (oracles from `create_mat_fixtures.m`) and
//! SciPy/h5py fixtures (`tools/make_fixtures.py`, verified by SciPy's own reader).
use dfv_table_mat::*;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}
fn json_of(name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(fixtures().join(name)).unwrap()).unwrap()
}
fn open(name: &str) -> MatFile {
    MatFile::open(&fixtures().join(name), &Limits::default())
        .unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn scalar_text(s: &Scalar) -> String {
    match s {
        Scalar::Bool(b) => u8::from(*b).to_string(),
        Scalar::Int(n) => n.to_string(),
        Scalar::UInt(n) => n.to_string(),
        Scalar::F32(x) => format!("{:08x}", x.to_bits()),
        Scalar::F64(x) => format!("{:016x}", x.to_bits()),
    }
}
fn texts(v: &[Scalar]) -> Value {
    json!(v.iter().map(scalar_text).collect::<Vec<_>>())
}
fn all_children(f: &MatFile, node: &Node) -> Vec<Child> {
    let (mut out, mut offset) = (vec![], 0);
    loop {
        let page = f.children(node, offset, 1000).unwrap();
        offset += page.items.len() as u64;
        out.extend(page.items);
        if offset >= page.total {
            return out;
        }
    }
}

/// Canonical dump of one node; the same shape `norm` gives an oracle (and `expected.json` uses).
fn dump(f: &MatFile, node: &Node) -> Value {
    let info = f.describe(node).unwrap();
    let mut o = Map::new();
    o.insert("class".into(), json!(info.class_name));
    o.insert(
        "size".into(),
        json!(if CORE.contains(&info.class_name.as_str()) {
            info.dims.clone()
        } else {
            vec![]
        }),
    );
    let numel: u64 = info.dims.iter().product();
    match info.class {
        Class::Cell => {
            let items: Vec<Value> = all_children(f, node)
                .iter()
                .map(|c| dump(f, &c.node))
                .collect();
            o.insert("items".into(), json!(items));
        }
        Class::Struct => {
            o.insert("fields".into(), json!(info.fields));
            if numel == 1 {
                let values: Map<String, Value> = all_children(f, node)
                    .iter()
                    .zip(&info.fields)
                    .map(|(c, n)| (n.clone(), dump(f, &c.node)))
                    .collect();
                o.insert("values".into(), Value::Object(values));
            }
        }
        _ if info.support != Support::Full => {}
        _ if info.sparse => {
            let region = Region {
                start: vec![1, 1],
                count: info.dims.clone(),
            };
            let (mut rows, mut cols, mut vals, mut imag, mut skip) =
                (vec![], vec![], vec![], vec![], 0);
            loop {
                let page = f.read_sparse(node, &region, skip, 10_000).unwrap();
                skip += page.entries.len() as u64;
                for e in &page.entries {
                    rows.push(e.row);
                    cols.push(e.col);
                    vals.push(e.re);
                    if let Some(im) = e.im {
                        imag.push(im);
                    }
                }
                if !page.has_more {
                    break;
                }
            }
            o.insert("sparse".into(), json!(true));
            o.insert("nnz".into(), json!(info.nnz.unwrap()));
            o.insert("rows".into(), json!(rows));
            o.insert("cols".into(), json!(cols));
            if info.class == Class::Logical {
                o.insert(
                    "bits".into(),
                    texts(&vals)
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| json!(v.as_str().unwrap().parse::<u8>().unwrap()))
                        .collect::<Vec<_>>()
                        .into(),
                );
            } else {
                o.insert("hex".into(), texts(&vals));
                if info.complex {
                    o.insert("imag_hex".into(), texts(&imag));
                }
            }
        }
        Class::Char => {
            let units: Vec<u16> = if numel == 0 {
                vec![]
            } else {
                let s = f
                    .read_slice(node, &Region::first_page(&info.dims, 10_000))
                    .unwrap();
                let Data::Char { rows, lossy } = s.data else {
                    panic!("not text")
                };
                assert!(!lossy || rows.iter().any(|r| r.contains('\u{FFFD}')));
                let cols = rows[0].encode_utf16().count();
                let enc: Vec<Vec<u16>> = rows.iter().map(|r| r.encode_utf16().collect()).collect();
                (0..cols)
                    .flat_map(|j| enc.iter().map(move |r| r[j]))
                    .collect()
            };
            o.insert("units".into(), json!(units));
        }
        _ => {
            let (re, im) = if numel == 0 {
                (vec![], None)
            } else {
                let s = f
                    .read_slice(node, &Region::first_page(&info.dims, 10_000))
                    .unwrap();
                let Data::Numeric { re, im, .. } = s.data else {
                    panic!("not numeric")
                };
                (re, im)
            };
            match info.class {
                Class::Logical => {
                    o.insert(
                        "bits".into(),
                        json!(
                            re.iter()
                                .map(|s| scalar_text(s).parse::<u8>().unwrap())
                                .collect::<Vec<_>>()
                        ),
                    );
                }
                Class::Double | Class::Single => {
                    o.insert("complex".into(), json!(info.complex));
                    o.insert("hex".into(), texts(&re));
                    if let Some(im) = im {
                        o.insert("imag_hex".into(), texts(&im));
                    }
                }
                _ => {
                    o.insert("dec".into(), texts(&re));
                }
            }
        }
    }
    Value::Object(o)
}

fn flat_u64(v: &Value) -> Vec<u64> {
    match v {
        Value::Array(a) => a.iter().flat_map(flat_u64).collect(),
        Value::Number(n) => vec![n.as_f64().unwrap() as u64],
        _ => panic!("not a number list: {v}"),
    }
}
const CORE: [&str; 14] = [
    "double", "single", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
    "logical", "char", "cell", "struct",
];
/// Bring a MATLAB oracle (or expected.json) value to the canonical dump shape.
fn norm(v: &Value) -> Value {
    let class = v["class"].as_str().unwrap();
    let mut o = Map::new();
    o.insert("class".into(), v["class"].clone());
    if !CORE.contains(&class) {
        // string, table, datetime, function_handle: only the class is read; MCOS sizes live in the subsystem.
        o.insert("size".into(), json!([]));
        return Value::Object(o);
    }
    o.insert("size".into(), json!(flat_u64(&v["size"])));
    for (k, x) in v.as_object().unwrap() {
        let y = match k.as_str() {
            "class" | "size" => continue,
            "units" | "bits" | "rows" | "cols" | "nnz" => json!(flat_u64(x)),
            "hex" | "imag_hex" | "dec" => json!(
                x.as_array()
                    .unwrap()
                    .iter()
                    .filter(|s| s.as_str() != Some(""))
                    .collect::<Vec<_>>()
            ),
            "items" => json!(x.as_array().unwrap().iter().map(norm).collect::<Vec<_>>()),
            "values" => Value::Object(
                x.as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), norm(v)))
                    .collect(),
            ),
            _ => x.clone(),
        };
        o.insert(k.clone(), y);
    }
    if let Some(n) = o.get("nnz") {
        o.insert("nnz".into(), json!(n[0]));
    }
    Value::Object(o)
}

fn compare_file(name: &str, expected: &Map<String, Value>) -> usize {
    let before = std::fs::read(fixtures().join(name)).unwrap();
    let f = open(name);
    let mut checked = 0;
    let names: Vec<&str> = f.catalog().iter().map(|e| e.info.name.as_str()).collect();
    let want: Vec<&str> = expected
        .keys()
        .filter(|k| *k != "x__whos")
        .map(String::as_str)
        .collect();
    let (mut a, mut b) = (names.clone(), want.clone());
    a.sort_unstable();
    b.sort_unstable();
    assert_eq!(a, b, "{name}: variable names");
    for e in f.catalog() {
        let got = dump(&f, &e.node);
        assert_eq!(got, norm(&expected[&e.info.name]), "{name}/{}", e.info.name);
        checked += 1;
    }
    if let Some(whos) = expected.get("x__whos") {
        let list = if whos.is_array() {
            whos.as_array().unwrap().clone()
        } else {
            vec![whos.clone()]
        };
        assert_eq!(list.len(), f.catalog().len(), "{name}: whos count");
        for w in list {
            let e = f
                .catalog()
                .iter()
                .find(|e| e.info.name == w["name"].as_str().unwrap())
                .unwrap();
            assert_eq!(
                e.info.class_name,
                w["class"].as_str().unwrap(),
                "{name}/{} whos class",
                e.info.name
            );
            if CORE.contains(&e.info.class_name.as_str()) {
                assert_eq!(
                    json!(e.info.dims),
                    json!(flat_u64(&w["size"])),
                    "{name}/{} whos size",
                    e.info.name
                );
            }
        }
    }
    assert_eq!(
        std::fs::read(fixtures().join(name)).unwrap(),
        before,
        "{name}: source bytes unchanged"
    );
    checked
}

#[test]
fn genuine_matlab_files_match_matlab_oracles() {
    let mut vars = 0;
    for name in [
        "projection_v7",
        "projection_v6",
        "refusals_v7",
        "many_v7",
        "native_v7",
        "unsupported_table",
    ] {
        vars += compare_file(
            &format!("{name}.mat"),
            json_of(&format!("{name}.oracle.json")).as_object().unwrap(),
        );
    }
    assert!(vars > 1_050, "{vars}");
}

#[test]
fn scipy_files_match_scipys_own_reader_including_big_endian_and_compression() {
    let truth = json_of("expected.json");
    let mut files = 0;
    for (name, e) in truth.as_object().unwrap() {
        if name.starts_with('_') || e.get("variables").is_none() {
            continue;
        }
        compare_file(name, e["variables"].as_object().unwrap());
        files += 1;
    }
    assert_eq!(files, 3);
    assert!(!open("be_v5.mat").header().little_endian);
    assert!(open("scipy_v5_zlib.mat").header().little_endian);
}
fn by_name<'a>(f: &'a MatFile, name: &str) -> &'a Entry {
    f.catalog()
        .iter()
        .find(|e| e.info.name == name)
        .unwrap_or_else(|| panic!("no variable {name}"))
}

#[test]
fn integers_keep_every_bit_and_cross_the_wire_as_decimal_text() {
    let f = open("projection_v7.mat");
    let s = f
        .read_slice(&by_name(&f, "i64").node, &Region::first_page(&[5, 1], 10))
        .unwrap();
    let Data::Numeric { class, re, .. } = &s.data else {
        panic!()
    };
    assert_eq!(*class, Class::Int64);
    assert_eq!(re[0], Scalar::Int(i64::MIN));
    assert_eq!(re[1], Scalar::Int(-(1 << 53) - 1));
    assert_eq!(re[3], Scalar::Int((1 << 53) + 1));
    assert_eq!(re[4], Scalar::Int(i64::MAX));
    assert_eq!(
        re[4].to_wire(*class),
        json!({"$t": "int64", "v": "9223372036854775807"})
    );
    let u = f
        .read_slice(&by_name(&f, "row").node, &Region::first_page(&[1, 3], 10))
        .unwrap();
    let Data::Numeric { re, .. } = &u.data else {
        panic!()
    };
    assert_eq!(re[2], Scalar::UInt(u64::MAX));
    assert_eq!(
        re[2].to_wire(Class::UInt64),
        json!({"$t": "uint64", "v": "18446744073709551615"})
    );
}

#[test]
fn floats_keep_signed_zero_nan_infinity_and_extremes_in_wire_text() {
    let f = open("projection_v7.mat");
    let e = by_name(&f, "edges");
    let s = f
        .read_slice(&e.node, &Region::first_page(&e.info.dims, 20))
        .unwrap();
    let Data::Numeric { re, .. } = &s.data else {
        panic!()
    };
    let w: Vec<String> = re
        .iter()
        .map(|x| x.to_wire(Class::Double)["v"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(w[0], "9.007199254740992e+15");
    assert_eq!(w[3], "-0");
    assert_eq!(w[4], "NaN");
    assert_eq!((w[5].as_str(), w[6].as_str()), ("Infinity", "-Infinity"));
    assert_eq!(w[7], "2.2250738585072014e-308");
    assert_eq!(w[8], "1.7976931348623157e+308");
    assert_eq!(w[9], "2.220446049250313e-16");
    assert_eq!(w[10], "0.1");
    assert_eq!(
        re[3].to_wire(Class::Double),
        json!({"$t": "float64", "v": "-0"})
    );
}

#[test]
fn text_is_utf16_exact_with_surrogate_pairs_and_lone_surrogates_flagged() {
    let f = open("projection_v7.mat");
    let t = by_name(&f, "text");
    let s = f
        .read_slice(&t.node, &Region::first_page(&t.info.dims, 100))
        .unwrap();
    let Data::Char { rows, lossy } = &s.data else {
        panic!()
    };
    assert_eq!(rows, &[" \u{130}\u{131}\u{15f}\u{11f} \u{1F600} "]);
    assert!(!lossy);
    let r = by_name(&f, "text_rows");
    let s = f
        .read_slice(&r.node, &Region::first_page(&r.info.dims, 100))
        .unwrap();
    let Data::Char { rows, .. } = &s.data else {
        panic!()
    };
    assert_eq!(rows, &["ab ", "\u{e7}d "]);
}

#[test]
fn slices_cut_any_window_of_a_three_dimensional_array() {
    let f = open("scipy_v5_zlib.mat");
    let cube = by_name(&f, "cube");
    assert_eq!(cube.info.dims, [2, 3, 4]);
    let region = Region {
        start: vec![2, 2, 1],
        count: vec![1, 2, 2],
    };
    let s = f.read_slice(&cube.node, &region).unwrap();
    let Data::Numeric { re, .. } = s.data else {
        panic!()
    };
    // cube(i,j,k) holds the zero-based column-major index: i + 2 j + 6 k.
    let want: Vec<f64> = [(1, 1, 0), (1, 2, 0), (1, 1, 1), (1, 2, 1)]
        .iter()
        .map(|&(i, j, k)| (i + 2 * j + 6 * k) as f64)
        .collect();
    assert_eq!(re, want.into_iter().map(Scalar::F64).collect::<Vec<_>>());
    let bad = Region {
        start: vec![2, 2, 1],
        count: vec![2, 2, 2],
    };
    assert_eq!(
        f.read_slice(&cube.node, &bad).unwrap_err().code(),
        "bad_request"
    );
    let zero = Region {
        start: vec![0, 1, 1],
        count: vec![1, 1, 1],
    };
    assert_eq!(
        f.read_slice(&cube.node, &zero).unwrap_err().code(),
        "bad_request"
    );
    let tiny = MatFile::open(
        &fixtures().join("scipy_v5_zlib.mat"),
        &Limits {
            page_cells: 5,
            ..Limits::default()
        },
    )
    .unwrap();
    let all = Region::first_page(&[2, 3, 4], 100);
    assert_eq!(
        tiny.read_slice(&by_name(&tiny, "cube").node, &all)
            .unwrap_err()
            .code(),
        "too_large"
    );
}

#[test]
fn a_million_square_sparse_matrix_is_listed_by_entries_and_never_densified() {
    let f = open("scipy_v5_zlib.mat");
    let e = by_name(&f, "sparse_big");
    let info = f.describe(&e.node).unwrap();
    assert!(info.sparse);
    assert_eq!(
        (info.dims.clone(), info.nnz),
        (vec![1_000_000, 1_000_000], Some(2))
    );
    let all = Region {
        start: vec![1, 1],
        count: vec![1_000_000, 1_000_000],
    };
    let page = f.read_sparse(&e.node, &all, 0, 10).unwrap();
    assert_eq!((page.nnz, page.entries.len(), page.has_more), (2, 2, false));
    assert_eq!(
        (page.entries[1].row, page.entries[1].col, page.entries[1].re),
        (1_000_000, 1_000_000, Scalar::F64(-2.0))
    );
    let one = f.read_sparse(&e.node, &all, 0, 1).unwrap();
    assert!(one.has_more && one.entries.len() == 1);
    let later = f.read_sparse(&e.node, &all, 1, 1).unwrap();
    assert_eq!(later.entries[0].row, 1_000_000);
    // A dense read of the whole matrix would need 10^12 cells and must be refused up front.
    assert_eq!(f.read_slice(&e.node, &all).unwrap_err().code(), "too_large");
    // A small corner is a bounded dense window with implicit zeros.
    let corner = Region {
        start: vec![1, 1],
        count: vec![2, 3],
    };
    let Data::Numeric { re, .. } = f.read_slice(&e.node, &corner).unwrap().data else {
        panic!()
    };
    assert_eq!(re.len(), 6);
    assert_eq!(re[2], Scalar::F64(5.0));
    assert_eq!(re.iter().filter(|s| **s == Scalar::F64(0.0)).count(), 5);
    let small = by_name(&f, "sparse_small");
    let window = Region {
        start: vec![2, 1],
        count: vec![2, 2],
    };
    let page = f.read_sparse(&small.node, &window, 0, 10).unwrap();
    assert_eq!(
        page.entries
            .iter()
            .map(|e| (e.row, e.col))
            .collect::<Vec<_>>(),
        [(2, 1)]
    );
}

#[test]
fn cells_and_structs_page_with_stable_labels_and_previews() {
    let f = open("native_v7.mat");
    let cells = by_name(&f, "cells");
    let page = f.children(&cells.node, 0, 3).unwrap();
    assert_eq!((page.total, page.items.len()), (4, 3));
    assert_eq!(page.items[0].label, "{1,1}");
    assert_eq!(page.items[2].label, "{1,2}");
    assert!(page.items[0].preview.is_some());
    assert_eq!(f.children(&cells.node, 3, 100).unwrap().items.len(), 1);
    assert_eq!(f.children(&cells.node, 9, 100).unwrap().items.len(), 0);
    let rec = by_name(&f, "record");
    let page = f.children(&rec.node, 0, 10).unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|c| c.label.as_str())
            .collect::<Vec<_>>(),
        [".count", ".amount"]
    );
    // A handle from a page reads its own value.
    let Data::Numeric { re, .. } = f
        .read_slice(&page.items[0].node, &Region::first_page(&[2, 1], 10))
        .unwrap()
        .data
    else {
        panic!()
    };
    assert_eq!(re, [Scalar::Int(1), Scalar::Int(2)]);
    assert_eq!(
        f.children(&by_name(&f, "matrix").node, 0, 1)
            .unwrap_err()
            .code(),
        "bad_request"
    );
    let sa = open("refusals_v7.mat");
    let arr = sa.describe(&by_name(&sa, "struct_array").node).unwrap();
    assert_eq!(
        (arr.fields.as_slice(), arr.children),
        (&["a".to_string()][..], Some(2))
    );
    let kids = sa
        .children(&by_name(&sa, "struct_array").node, 0, 10)
        .unwrap();
    assert_eq!(kids.items[1].label, "(1,2).a");
    // create_mat_fixtures.m generates struct('a', {1,2}); verify actual member values too.
    for (child, expected) in kids.items.iter().zip([1.0, 2.0]) {
        let Data::Numeric { re, im, .. } = sa
            .read_slice(&child.node, &Region::first_page(&[1, 1], 1))
            .unwrap()
            .data
        else {
            panic!("numeric struct member")
        };
        assert_eq!(re, [Scalar::F64(expected)]);
        assert!(im.is_none());
    }
}

#[test]
fn many_variables_catalog_pages_and_read_selectively() {
    let f = open("many_v7.mat");
    assert_eq!(f.catalog().len(), 1000);
    assert_eq!(f.catalog_page(990, 50).len(), 10);
    assert_eq!(f.catalog_page(5000, 50).len(), 0);
    let e = &f.catalog_page(499, 1)[0];
    let Data::Numeric { re, .. } = f
        .read_slice(&e.node, &Region::first_page(&[1, 1], 1))
        .unwrap()
        .data
    else {
        panic!()
    };
    let k: i64 = e.info.name[1..].parse().unwrap();
    assert_eq!(re, [Scalar::Int(k * 1_000_000_007)]);
}

#[test]
fn unsupported_classes_are_metadata_only_and_never_decoded() {
    let f = open("refusals_v7.mat");
    for (name, class) in [
        ("string_obj", "string"),
        ("table_obj", "table"),
        ("datetime_obj", "datetime"),
        ("handle", "function_handle"),
    ] {
        let e = by_name(&f, name);
        assert_eq!(e.info.class_name, class, "{name}");
        assert!(
            matches!(e.info.support, Support::MetadataOnly { .. }),
            "{name}"
        );
        let err = f
            .read_slice(&e.node, &Region::first_page(&e.info.dims, 10))
            .unwrap_err();
        assert!(
            err.code().starts_with("unsupported_"),
            "{name}: {}",
            err.code()
        );
    }
    assert_eq!(by_name(&f, "ok").info.support, Support::Full);
}

#[test]
fn version_refusals_are_typed_and_files_are_never_modified() {
    let truth = json_of("expected.json");
    for (name, e) in truth.as_object().unwrap() {
        let Some(code) = e.get("refusal") else {
            continue;
        };
        let path = fixtures().join(name);
        let before = std::fs::read(&path).unwrap();
        let err = MatFile::open(&path, &Limits::default())
            .err()
            .unwrap_or_else(|| panic!("{name} opened"));
        assert_eq!(err.code(), code.as_str().unwrap(), "{name}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    let err = MatFile::open(&fixtures().join("native_v73.mat"), &Limits::default())
        .err()
        .unwrap();
    assert_eq!(err.code(), "unsupported_version_v73");
    assert!(err.to_string().contains("HDF5"));
    assert_eq!(refuse_mutation("updateCell").code(), "read_only");
    assert!(MatFile::open(Path::new("/nonexistent/none.mat"), &Limits::default()).is_err());
}

#[test]
fn changing_the_source_makes_every_handle_stale() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.mat");
    std::fs::copy(fixtures().join("projection_v7.mat"), &path).unwrap();
    let f = MatFile::open(&path, &Limits::default()).unwrap();
    let node = by_name(&f, "i64").node.clone();
    f.describe(&node).unwrap();
    f.verify_source().unwrap();
    // Replace the file (new inode) and also touch it in place; both must be detected.
    let other = dir.path().join("b.mat");
    std::fs::copy(fixtures().join("projection_v6.mat"), &other).unwrap();
    std::fs::rename(&other, &path).unwrap();
    assert_eq!(f.describe(&node).unwrap_err().code(), "stale_handle");
    assert_eq!(f.verify_source().unwrap_err().code(), "stale_handle");
    // A handle from another open generation is refused too.
    let g = MatFile::open(&path, &Limits::default()).unwrap();
    assert_eq!(g.describe(&node).unwrap_err().code(), "stale_handle");
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, &bytes[..bytes.len() - 8]).unwrap();
    assert_eq!(g.verify_source().unwrap_err().code(), "stale_handle");
}

#[test]
fn matlab_support_matrix_closes_complex_sparse_class_and_struct_array_oracle_gaps() {
    for stem in ["support_v6", "support_v7"] {
        compare_file(
            &format!("{stem}.mat"),
            json_of(&format!("{stem}.oracle.json")).as_object().unwrap(),
        );
        let path = fixtures().join(format!("{stem}.mat"));
        let before = std::fs::read(&path).unwrap();
        let f = open(&format!("{stem}.mat"));
        let members = json_of(&format!("{stem}.struct_members.oracle.json"));
        for name in ["struct_array", "ndstruct"] {
            let node = &by_name(&f, name).node;
            let info = f.describe(node).unwrap();
            let kids = all_children(&f, node);
            let expected = members[name].as_array().unwrap();
            assert_eq!(kids.len(), expected.len() * info.fields.len());
            for (children, element) in kids.chunks(info.fields.len()).zip(expected) {
                for (child, field) in children.iter().zip(&info.fields) {
                    assert_eq!(
                        dump(&f, &child.node),
                        norm(&element["values"][field]),
                        "{stem}/{name}/{}",
                        child.label
                    );
                }
            }
        }
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}
