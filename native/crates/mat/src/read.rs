//! Region reads of dense numeric, char and sparse arrays; nothing here allocates more than the region.
use crate::body::Body;
use crate::parse::*;
use crate::types::*;

struct Part {
    dtype: u32,
    off: u64,
    n: u64,
    next: u64,
}
fn part(b: &Body, pos: u64, le: bool) -> Result<Part> {
    let e = elem(b, pos, le)?;
    Ok(Part {
        dtype: e.dtype,
        off: e.off,
        n: e.n,
        next: e.next,
    })
}
fn numeric_part(b: &Body, pos: u64, le: bool, count: u64) -> Result<Part> {
    let p = part(b, pos, le)?;
    if p.n != count.saturating_mul(dsize(p.dtype)?) {
        return corrupt("A data element length does not match the array dimensions.");
    }
    Ok(p)
}

/// Check a one-based region against `dims` and return its cell count.
fn check_region(dims: &[u64], r: &Region, max_cells: Option<u64>) -> Result<u64> {
    let bad = |m: &str| Err(Error::BadRequest(m.into()));
    if r.start.len() != dims.len() || r.count.len() != dims.len() {
        return bad("The region needs one start and one count per dimension.");
    }
    let mut cells = 1u64;
    for (k, &dim) in dims.iter().enumerate() {
        let (s, c) = (r.start[k], r.count[k]);
        if s == 0 {
            return bad("Indices are one-based; a start of 0 is invalid.");
        }
        if dim == 0 {
            if s != 1 || c != 0 {
                return bad("An empty dimension requires start one and count zero.");
            }
            cells = 0;
            continue;
        }
        if c == 0 || s.checked_add(c - 1).is_none_or(|e| e > dim) {
            return bad("The region lies outside the variable.");
        }
        cells = cells.saturating_mul(c);
    }
    if let Some(m) = max_cells {
        bound("slice cells", cells.into(), m.into())?;
    }
    Ok(cells)
}

/// Call `f(linear_start, run_len)` for each dim-0 run of the region in column-major order.
fn runs(dims: &[u64], r: &Region, mut f: impl FnMut(u64, u64) -> Result<()>) -> Result<()> {
    let nd = dims.len();
    let mut stride = vec![1u64; nd];
    for k in 1..nd {
        stride[k] = stride[k - 1] * dims[k - 1];
    }
    let mut idx = vec![0u64; nd];
    loop {
        let lin: u64 = (0..nd).map(|k| (r.start[k] - 1 + idx[k]) * stride[k]).sum();
        f(lin, r.count[0])?;
        let mut k = 1;
        loop {
            if k >= nd {
                return Ok(());
            }
            idx[k] += 1;
            if idx[k] < r.count[k] {
                break;
            }
            idx[k] = 0;
            k += 1;
        }
    }
}

pub(crate) fn slice_body(
    b: &Body,
    lay: &Layout,
    r: &Region,
    le: bool,
    lim: &Limits,
) -> Result<Data> {
    if let Support::MetadataOnly { code, reason } = lay.support() {
        return Err(Error::Unsupported {
            code,
            detail: reason,
        });
    }
    let empty = lay.dims.contains(&0);
    match lay.class {
        Class::Cell | Class::Struct => {
            return Err(Error::BadRequest(
                "Cells and structs are read with children().".into(),
            ));
        }
        Class::Char => {
            if empty {
                return Ok(Data::Char {
                    rows: vec![],
                    lossy: false,
                });
            }
            return char_region(b, lay, r, le, lim);
        }
        _ => {}
    }
    if empty {
        return Ok(Data::Numeric {
            class: lay.class,
            re: vec![],
            im: lay.complex.then(Vec::new),
        });
    }
    if lay.sparse {
        return sparse_window(b, lay, r, le, lim);
    }
    let cells = check_region(&lay.dims, r, Some(lim.page_cells))?;
    let count = lay.numel()?;
    let re = numeric_part(b, lay.next, le, count)?;
    let im = if lay.complex {
        Some(numeric_part(b, re.next, le, count)?)
    } else {
        None
    };
    let pull = |p: &Part| -> Result<Vec<Scalar>> {
        let (mut out, sz) = (Vec::with_capacity(cells as usize), dsize(p.dtype)?);
        runs(&lay.dims, r, |lin, n| {
            decode(
                lay.class,
                p.dtype,
                &b.read(p.off + lin * sz, n * sz)?,
                le,
                &mut out,
            )
        })?;
        Ok(out)
    };
    Ok(Data::Numeric {
        class: lay.class,
        re: pull(&re)?,
        im: im.as_ref().map(pull).transpose()?,
    })
}

fn char_region(b: &Body, lay: &Layout, r: &Region, le: bool, lim: &Limits) -> Result<Data> {
    let cells = check_region(&lay.dims, r, Some(lim.page_cells))?;
    if r.count[2..].iter().any(|c| *c != 1) {
        return Err(Error::BadRequest(
            "Text is read one two-dimensional slice at a time.".into(),
        ));
    }
    let count = lay.numel()?;
    let p = part(b, lay.next, le)?;
    // UTF-8/16/32 storage is decoded once (bounded by the variable limit); fixed widths stream.
    let decoded: Option<Vec<u16>> = match p.dtype {
        16..=18 => {
            bound("text variable", p.n.into(), lim.variable_bytes.into())?;
            let raw = b.read(p.off, p.n)?;
            let units: Vec<u16> = match p.dtype {
                16 => String::from_utf8_lossy(&raw).encode_utf16().collect(),
                17 => raw
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| unit(4, c, le))
                    .collect(),
                _ => raw
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|c| {
                        let ch = char::from_u32(u32_at(c, le)).unwrap_or('\u{FFFD}');
                        let mut t = [0u16; 2];
                        ch.encode_utf16(&mut t).to_vec()
                    })
                    .collect(),
            };
            if units.len() as u64 != count {
                return corrupt("The text length does not match the array dimensions.");
            }
            Some(units)
        }
        1..=4 => {
            if p.n != count * dsize(p.dtype)? {
                return corrupt("A data element length does not match the array dimensions.");
            }
            None
        }
        t => return corrupt(format!("Unsupported character storage type {t}.")),
    };
    let mut units: Vec<u16> = Vec::with_capacity(cells as usize);
    runs(&lay.dims, r, |lin, n| {
        match &decoded {
            Some(d) => units.extend_from_slice(&d[lin as usize..(lin + n) as usize]),
            None => {
                let sz = dsize(p.dtype)?;
                units.extend(
                    b.read(p.off + lin * sz, n * sz)?
                        .chunks_exact(sz as usize)
                        .map(|c| unit(p.dtype, c, le)),
                );
            }
        }
        Ok(())
    })?;
    let (rows, cols) = (r.count[0] as usize, r.count[1] as usize);
    let mut lossy = false;
    let out = (0..rows)
        .map(|i| {
            let row: Vec<u16> = (0..cols).map(|j| units[i + j * rows]).collect();
            String::from_utf16(&row).unwrap_or_else(|_| {
                lossy = true;
                String::from_utf16_lossy(&row)
            })
        })
        .collect();
    Ok(Data::Char { rows: out, lossy })
}

struct Sparse {
    ir: Part,
    jc: Part,
    pr: Part,
    pi: Option<Part>,
    nnz: u64,
    rows: u64,
    cols: u64,
}
fn sparse_parts(b: &Body, lay: &Layout, le: bool) -> Result<Sparse> {
    let (rows, cols) = (lay.dims[0], lay.dims[1]);
    let ir = part(b, lay.next, le)?;
    let jc = part(b, ir.next, le)?;
    let pr = part(b, jc.next, le)?;
    let pi = if lay.complex {
        Some(part(b, pr.next, le)?)
    } else {
        None
    };
    if ir.dtype != MI_INT32 || jc.dtype != MI_INT32 || ir.n % 4 != 0 || jc.n != (cols + 1) * 4 {
        return corrupt("The sparse index arrays are malformed.");
    }
    let nnz = u64::from(u32_at(&b.read(jc.off + cols * 4, 4)?, le));
    for p in [Some(&pr), pi.as_ref()].into_iter().flatten() {
        if nnz * dsize(p.dtype)? > p.n {
            return corrupt("The sparse value array is shorter than the nonzero count.");
        }
    }
    if nnz * 4 > ir.n {
        return corrupt("The sparse row array is shorter than the nonzero count.");
    }
    Ok(Sparse {
        ir,
        jc,
        pr,
        pi,
        nnz,
        rows,
        cols,
    })
}
pub(crate) fn sparse_nnz(b: &Body, lay: &Layout, le: bool) -> Result<u64> {
    Ok(sparse_parts(b, lay, le)?.nnz)
}

const CHUNK: u64 = 65_536;
/// Region entries in column-major order after skipping `skip`, at most `limit`.
pub(crate) fn sparse_slice(
    b: &Body,
    lay: &Layout,
    r: &Region,
    skip: u64,
    limit: u64,
    le: bool,
) -> Result<SparseSlice> {
    check_region(&lay.dims, r, None)?;
    let s = sparse_parts(b, lay, le)?;
    let (r0, rc, c0, cc) = (r.start[0], r.count[0], r.start[1], r.count[1]);
    let (mut entries, mut seen, mut has_more) = (Vec::new(), 0u64, false);
    let mut col = c0 - 1; // zero-based
    'cols: while col < c0 - 1 + cc {
        let blk = (c0 - 1 + cc - col).min(CHUNK);
        let jb = b.read(s.jc.off + col * 4, (blk + 1) * 4)?;
        let jc: Vec<u64> = jb
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| u64::from(u32_at(c, le)))
            .collect();
        for i in 0..blk as usize {
            let (mut lo, hi) = (jc[i], jc[i + 1]);
            if lo > hi || hi > s.nnz {
                return corrupt("The sparse column pointers are not monotone.");
            }
            while lo < hi {
                let n = (hi - lo).min(CHUNK);
                let irb = b.read(s.ir.off + lo * 4, n * 4)?;
                let prsz = dsize(s.pr.dtype)?;
                let prb = b.read(s.pr.off + lo * prsz, n * prsz)?;
                let pib = match &s.pi {
                    Some(p) => Some(b.read(p.off + lo * dsize(p.dtype)?, n * dsize(p.dtype)?)?),
                    None => None,
                };
                for (e, c) in irb.as_chunks::<4>().0.iter().enumerate() {
                    let row = u64::from(u32_at(c, le));
                    if row >= s.rows {
                        return corrupt("A sparse row index is outside the matrix.");
                    }
                    if row + 1 < r0 || row + 1 >= r0 + rc {
                        continue;
                    }
                    seen += 1;
                    if seen <= skip {
                        continue;
                    }
                    if entries.len() as u64 == limit {
                        has_more = true;
                        break 'cols;
                    }
                    let one = |bytes: &[u8], dtype: u32| -> Result<Scalar> {
                        let sz = dsize(dtype)? as usize;
                        let mut v = Vec::with_capacity(1);
                        decode(lay.class, dtype, &bytes[e * sz..(e + 1) * sz], le, &mut v)?;
                        Ok(v[0])
                    };
                    entries.push(SparseEntry {
                        row: row + 1,
                        col: col + i as u64 + 1,
                        re: one(&prb, s.pr.dtype)?,
                        im: match (&pib, &s.pi) {
                            (Some(x), Some(p)) => Some(one(x, p.dtype)?),
                            _ => None,
                        },
                    });
                }
                lo += n;
            }
        }
        col += blk;
    }
    Ok(SparseSlice {
        class: lay.class,
        shape: [s.rows, s.cols],
        nnz: s.nnz,
        skipped: skip.min(seen),
        entries,
        has_more,
    })
}

fn sparse_window(b: &Body, lay: &Layout, r: &Region, le: bool, lim: &Limits) -> Result<Data> {
    let cells = check_region(&lay.dims, r, Some(lim.page_cells))?;
    let sp = sparse_slice(b, lay, r, 0, cells, le)?;
    let zero = if lay.class == Class::Logical {
        Scalar::Bool(false)
    } else {
        Scalar::F64(0.0)
    };
    let mut re = vec![zero; cells as usize];
    let mut im = lay.complex.then(|| vec![zero; cells as usize]);
    for e in &sp.entries {
        let at = ((e.row - r.start[0]) + (e.col - r.start[1]) * r.count[0]) as usize;
        re[at] = e.re;
        if let (Some(v), Some(x)) = (im.as_mut(), e.im) {
            v[at] = x;
        }
    }
    Ok(Data::Numeric {
        class: lay.class,
        re,
        im,
    })
}
