//! Level-5 element grammar: tags, array headers, struct field tables and numeric decoding.
use crate::body::Body;
use crate::types::*;

pub(crate) const MI_INT8: u32 = 1;
pub(crate) const MI_INT32: u32 = 5;
pub(crate) const MI_UINT32: u32 = 6;

pub(crate) fn u32_at(b: &[u8], le: bool) -> u32 {
    let a = [b[0], b[1], b[2], b[3]];
    if le {
        u32::from_le_bytes(a)
    } else {
        u32::from_be_bytes(a)
    }
}

/// A sub-element located inside a container: payload offset/length and the next element's offset.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Elem {
    pub dtype: u32,
    pub off: u64,
    pub n: u64,
    pub next: u64,
}
pub(crate) fn elem(b: &Body, pos: u64, le: bool) -> Result<Elem> {
    let w = u32_at(&b.read(pos, 4)?, le);
    let (dtype, n, hdr, total) = if w >> 16 != 0 {
        (w & 0xffff, u64::from(w >> 16), 4, 8)
    } else {
        let n = u64::from(u32_at(&b.read(pos + 4, 4)?, le));
        (w, n, 8, 8 + n.div_ceil(8) * 8)
    };
    if hdr + n > total || pos + hdr + n > b.len() {
        return truncated("An element is larger than its container.");
    }
    Ok(Elem {
        dtype,
        off: pos + hdr,
        n,
        next: (pos + total).min(b.len()),
    })
}

/// Parsed array header (flags, dimensions, name) of one miMATRIX body.
#[derive(Debug, Clone)]
pub(crate) struct Layout {
    pub class: Class,
    pub complex: bool,
    pub global: bool,
    pub sparse: bool,
    pub nzmax: u64,
    pub dims: Vec<u64>,
    pub name: String,
    pub class_name: Option<String>,
    /// Offset of the first element after the header (and class name for objects).
    pub next: u64,
}
impl Layout {
    pub fn numel(&self) -> Result<u64> {
        numel(&self.dims)
    }
    pub fn class_string(&self) -> String {
        match (&self.class_name, self.class) {
            (Some(n), Class::Object | Class::Opaque) => n.clone(),
            (_, c) => c.name(),
        }
    }
    pub fn support(&self) -> Support {
        let mo = |code, reason: &str| Support::MetadataOnly {
            code,
            reason: reason.into(),
        };
        match self.class {
            Class::Object => mo(
                "unsupported_object",
                "MATLAB objects are shown as metadata only.",
            ),
            Class::Opaque => mo(
                "unsupported_object",
                "MATLAB class instances (string, table, datetime and similar) are shown as metadata only.",
            ),
            Class::FunctionHandle => mo(
                "unsupported_function_handle",
                "Function handles are shown as metadata only.",
            ),
            Class::Unknown(n) => Support::MetadataOnly {
                code: "unsupported_class",
                reason: format!("Class code {n} is not recognised; values are not decoded."),
            },
            _ => Support::Full,
        }
    }
    pub fn info(&self) -> Info {
        Info {
            name: self.name.clone(),
            class: self.class,
            class_name: self.class_string(),
            dims: self.dims.clone(),
            complex: self.complex,
            sparse: self.sparse,
            global: self.global,
            nzmax: self.nzmax,
            nnz: None,
            fields: vec![],
            children: None,
            support: self.support(),
        }
    }
}
pub(crate) fn numel(dims: &[u64]) -> Result<u64> {
    dims.iter()
        .try_fold(1u64, |a, d| a.checked_mul(*d))
        .ok_or(Error::TooLarge {
            what: "element count",
            got: u128::MAX,
            limit: u64::MAX.into(),
        })
}
fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b)
        .trim_end_matches('\0')
        .to_string()
}

pub(crate) fn layout(b: &Body, le: bool, lim: &Limits) -> Result<Layout> {
    let f = elem(b, 0, le)?;
    if f.dtype != MI_UINT32 || f.n != 8 {
        return corrupt("The array flags element is malformed.");
    }
    let fb = b.read(f.off, 8)?;
    let (w0, nzmax) = (u32_at(&fb, le), u64::from(u32_at(&fb[4..], le)));
    let (class_id, flags) = ((w0 & 0xff) as u8, ((w0 >> 8) & 0xff) as u8);
    if class_id == 17 {
        return opaque_layout(b, f.next, nzmax, flags, le, lim);
    }
    let d = elem(b, f.next, le)?;
    if d.dtype != MI_INT32 || d.n % 4 != 0 || d.n / 4 < 2 {
        return corrupt("The dimensions element is malformed.");
    }
    bound("dimensions", u128::from(d.n / 4), lim.dims as u128)?;
    let db = b.read(d.off, d.n)?;
    let mut dims = Vec::new();
    for c in db.as_chunks::<4>().0 {
        let v = u32_at(c, le) as i32;
        if v < 0 {
            return corrupt("A dimension is negative.");
        }
        dims.push(v as u64);
    }
    let n = elem(b, d.next, le)?;
    if n.dtype != MI_INT8 {
        return corrupt("The array name element is malformed.");
    }
    bound("variable name", n.n.into(), lim.name_bytes.into())?;
    let name = text(&b.read(n.off, n.n)?);
    let mut next = n.next;
    let sparse = class_id == 5;
    let class = match class_id {
        1 => Class::Cell,
        2 => Class::Struct,
        3 => Class::Object,
        4 => Class::Char,
        5 if flags & 2 != 0 => Class::Logical,
        5 | 6 => Class::Double,
        7 => Class::Single,
        8 => Class::Int8,
        9 if flags & 2 != 0 => Class::Logical,
        9 => Class::UInt8,
        10 => Class::Int16,
        11 => Class::UInt16,
        12 => Class::Int32,
        13 => Class::UInt32,
        14 => Class::Int64,
        15 => Class::UInt64,
        16 => Class::FunctionHandle,
        17 => Class::Opaque,
        x => Class::Unknown(x),
    };
    if sparse && dims.len() != 2 {
        return corrupt("A sparse array must be two-dimensional.");
    }
    let mut class_name = None;
    if matches!(class, Class::Object) {
        let c = elem(b, next, le)?;
        class_name = Some(text(&b.read(c.off, c.n.min(lim.name_bytes))?));
        next = c.next;
    }
    Ok(Layout {
        class,
        complex: flags & 8 != 0,
        global: flags & 4 != 0,
        sparse,
        nzmax,
        dims,
        name,
        class_name,
        next,
    })
}

/// MCOS class instances (string, table, datetime, ...): flags, name, "MCOS", class name, then a
/// uint32 reference array. The instance's real size lives in the subsystem block, which this reader
/// does not parse, so dims stay empty rather than show the reference array's misleading 1x1.
fn opaque_layout(
    b: &Body,
    at: u64,
    nzmax: u64,
    flags: u8,
    le: bool,
    lim: &Limits,
) -> Result<Layout> {
    let n = elem(b, at, le)?;
    if n.dtype != MI_INT8 {
        return corrupt("The array name element is malformed.");
    }
    bound("variable name", n.n.into(), lim.name_bytes.into())?;
    let name = text(&b.read(n.off, n.n)?);
    let sys = elem(b, n.next, le).ok().filter(|e| e.dtype == MI_INT8);
    let cls = sys
        .and_then(|s| elem(b, s.next, le).ok())
        .filter(|c| c.dtype == MI_INT8 && c.n <= lim.name_bytes);
    let class_name = cls.and_then(|c| b.read(c.off, c.n).ok().map(|x| text(&x)));
    Ok(Layout {
        class: Class::Opaque,
        complex: false,
        global: flags & 4 != 0,
        sparse: false,
        nzmax,
        dims: vec![],
        name,
        class_name,
        next: n.next,
    })
}

/// Struct field names and the offset of the first field value.
pub(crate) fn struct_fields(
    b: &Body,
    lay: &Layout,
    le: bool,
    lim: &Limits,
) -> Result<(Vec<String>, u64)> {
    let l = elem(b, lay.next, le)?;
    if l.dtype != MI_INT32 || l.n != 4 {
        return corrupt("The struct field-name length is malformed.");
    }
    let width = u64::from(u32_at(&b.read(l.off, 4)?, le));
    let t = elem(b, l.next, le)?;
    if t.dtype != MI_INT8 || width == 0 || t.n % width != 0 {
        return corrupt("The struct field-name table is malformed.");
    }
    bound("struct fields", u128::from(t.n / width), lim.fields.into())?;
    bound("field name", width.into(), lim.name_bytes.into())?;
    let raw = b.read(t.off, t.n)?;
    Ok((raw.chunks_exact(width as usize).map(text).collect(), t.next))
}

/// Offset of child `k` (zero-based), skipping siblings by their tags.
pub(crate) fn nth_child(b: &Body, mut pos: u64, k: u64, le: bool) -> Result<u64> {
    for _ in 0..k {
        pos = elem(b, pos, le)?.next;
    }
    Ok(pos)
}
/// Body of the matrix element at `pos`.
pub(crate) fn matrix_at(b: &Body, pos: u64, le: bool) -> Result<Body> {
    let e = elem(b, pos, le)?;
    if e.dtype != crate::body::MI_MATRIX {
        return corrupt("A cell or struct member is not a matrix element.");
    }
    b.sub(e.off, e.n)
}

pub(crate) fn dsize(dtype: u32) -> Result<u64> {
    Ok(match dtype {
        1 | 2 => 1,
        3 | 4 => 2,
        5..=7 => 4,
        9 | 12 | 13 => 8,
        _ => return corrupt(format!("Unsupported numeric storage type {dtype}.")),
    })
}
#[derive(Clone, Copy)]
enum Num {
    I(i128),
    F(f64),
}
fn num(dtype: u32, c: &[u8], le: bool) -> Num {
    macro_rules! rd {
        ($t:ty) => {{
            let mut a = [0u8; std::mem::size_of::<$t>()];
            a.copy_from_slice(c);
            if le {
                <$t>::from_le_bytes(a)
            } else {
                <$t>::from_be_bytes(a)
            }
        }};
    }
    match dtype {
        1 => Num::I(i128::from(c[0] as i8)),
        2 => Num::I(i128::from(c[0])),
        3 => Num::I(i128::from(rd!(i16))),
        4 => Num::I(i128::from(rd!(u16))),
        5 => Num::I(i128::from(rd!(i32))),
        6 => Num::I(i128::from(rd!(u32))),
        7 => Num::F(f64::from(rd!(f32))),
        9 => Num::F(rd!(f64)),
        12 => Num::I(i128::from(rd!(i64))),
        _ => Num::I(i128::from(rd!(u64))),
    }
}
fn int_in(n: Num, lo: i128, hi: i128) -> Result<i128> {
    let v = match n {
        Num::I(v) => v,
        Num::F(f) if f.fract() == 0.0 && f.abs() < 1.8e19 => f as i128,
        Num::F(_) => return corrupt("A non-integer value is stored in an integer array."),
    };
    if (lo..=hi).contains(&v) {
        Ok(v)
    } else {
        corrupt("A stored value is outside its array class range.")
    }
}
fn conv(class: Class, n: Num) -> Result<Scalar> {
    Ok(match class {
        Class::Double => match n {
            Num::F(f) => Scalar::F64(f),
            Num::I(i) if (i as f64) as i128 == i => Scalar::F64(i as f64),
            Num::I(_) => return corrupt("An integer is not exactly representable as double."),
        },
        Class::Single => Scalar::F32(match n {
            Num::F(f) => f as f32,
            Num::I(i) => i as f32,
        }),
        Class::Logical => Scalar::Bool(match n {
            Num::I(i) => i != 0,
            Num::F(f) if !f.is_nan() => f != 0.0,
            Num::F(_) => return corrupt("A logical value is NaN."),
        }),
        Class::Int8 => Scalar::Int(int_in(n, -128, 127)? as i64),
        Class::Int16 => Scalar::Int(int_in(n, -32_768, 32_767)? as i64),
        Class::Int32 => Scalar::Int(int_in(n, i32::MIN.into(), i32::MAX.into())? as i64),
        Class::Int64 => Scalar::Int(int_in(n, i64::MIN.into(), i64::MAX.into())? as i64),
        Class::UInt8 => Scalar::UInt(int_in(n, 0, 255)? as u64),
        Class::UInt16 => Scalar::UInt(int_in(n, 0, 65_535)? as u64),
        Class::UInt32 => Scalar::UInt(int_in(n, 0, u32::MAX.into())? as u64),
        Class::UInt64 => Scalar::UInt(int_in(n, 0, u64::MAX.into())? as u64),
        _ => return corrupt("The class has no numeric storage."),
    })
}
/// Convert stored values to the array class, value-preserving (a lossy conversion is corruption).
pub(crate) fn decode(
    class: Class,
    dtype: u32,
    bytes: &[u8],
    le: bool,
    out: &mut Vec<Scalar>,
) -> Result<()> {
    let sz = dsize(dtype)? as usize;
    for c in bytes.chunks_exact(sz) {
        out.push(conv(class, num(dtype, c, le))?);
    }
    Ok(())
}
pub(crate) fn unit(dtype: u32, c: &[u8], le: bool) -> u16 {
    match num(dtype, c, le) {
        Num::I(i) => i as u16,
        Num::F(f) => f as u16,
    }
}
