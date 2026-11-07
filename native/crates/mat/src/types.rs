//! Public value, limit and error types of the read-only MATLAB codec.
use serde_json::{Value, json};
use std::fmt::Display;

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    /// Not a MAT-file at all.
    NotMat(String),
    /// A recognised but unsupported file version or variable class; `code` is stable.
    Unsupported {
        code: &'static str,
        detail: String,
    },
    Truncated(String),
    Corrupt(String),
    TooLarge {
        what: &'static str,
        got: u128,
        limit: u128,
    },
    /// The source file changed after this handle was created.
    Stale,
    BadRequest(String),
    /// MAT is view-only; every mutation is refused.
    ReadOnly(String),
}
impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::NotMat(_) => "not_mat",
            Self::Unsupported { code, .. } => code,
            Self::Truncated(_) => "truncated",
            Self::Corrupt(_) => "corrupt",
            Self::TooLarge { .. } => "too_large",
            Self::Stale => "stale_handle",
            Self::BadRequest(_) => "bad_request",
            Self::ReadOnly(_) => "read_only",
        }
    }
}
impl Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => e.fmt(f),
            Self::Unsupported { detail, .. } => detail.fmt(f),
            Self::NotMat(s) | Self::Truncated(s) | Self::Corrupt(s) | Self::BadRequest(s) => {
                s.fmt(f)
            }
            Self::TooLarge { what, got, limit } => {
                write!(f, "{what} exceeds its limit ({got} > {limit}).")
            }
            Self::Stale => f.write_str("The MAT source changed; reopen it."),
            Self::ReadOnly(m) => write!(f, "MATLAB files are view-only; {m} is refused."),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub(crate) fn corrupt<T>(s: impl Into<String>) -> Result<T> {
    Err(Error::Corrupt(s.into()))
}
pub(crate) fn truncated<T>(s: impl Into<String>) -> Result<T> {
    Err(Error::Truncated(s.into()))
}
pub(crate) fn bound(what: &'static str, got: u128, limit: u128) -> Result<()> {
    if got > limit {
        Err(Error::TooLarge { what, got, limit })
    } else {
        Ok(())
    }
}
/// The worker boundary calls this for every write-shaped request.
pub fn refuse_mutation(method: &str) -> Error {
    Error::ReadOnly(method.into())
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub variables: usize,
    /// Largest decompressed or in-memory variable body, and largest compressed element.
    pub variable_bytes: u64,
    /// Most cells (or sparse entries) one slice returns; the plan's preview maximum.
    pub page_cells: u64,
    pub children_page: u64,
    pub dims: usize,
    pub name_bytes: u64,
    pub fields: u64,
    pub depth: usize,
    pub cell_elements: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            variables: 100_000,
            variable_bytes: 256 << 20,
            page_cells: 10_000,
            children_page: 1_000,
            dims: 32,
            name_bytes: 1_024,
            fields: 65_536,
            depth: 64,
            cell_elements: 16 << 20,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Double,
    Single,
    Int8,
    UInt8,
    Int16,
    UInt16,
    Int32,
    UInt32,
    Int64,
    UInt64,
    Logical,
    Char,
    Cell,
    Struct,
    Object,
    FunctionHandle,
    Opaque,
    Unknown(u8),
}
impl Class {
    pub fn name(self) -> String {
        match self {
            Self::Double => "double",
            Self::Single => "single",
            Self::Int8 => "int8",
            Self::UInt8 => "uint8",
            Self::Int16 => "int16",
            Self::UInt16 => "uint16",
            Self::Int32 => "int32",
            Self::UInt32 => "uint32",
            Self::Int64 => "int64",
            Self::UInt64 => "uint64",
            Self::Logical => "logical",
            Self::Char => "char",
            Self::Cell => "cell",
            Self::Struct => "struct",
            Self::Object => "object",
            Self::FunctionHandle => "function_handle",
            Self::Opaque => "opaque",
            Self::Unknown(n) => return format!("unknown({n})"),
        }
        .into()
    }
}

/// Exact element value. Integers keep their full 64-bit range; only floats are inexact by type.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scalar {
    Bool(bool),
    Int(i64),
    UInt(u64),
    F32(f32),
    F64(f64),
}
macro_rules! float_text {
    ($name:ident, $t:ty) => {
        fn $name(x: $t) -> String {
            if x.is_nan() {
                return "NaN".into();
            }
            if x.is_infinite() {
                return if x < 0.0 { "-Infinity" } else { "Infinity" }.into();
            }
            let a = x.abs();
            if a == 0.0 || (1e-5..1e15).contains(&a) {
                return format!("{x}");
            }
            let s = format!("{x:e}");
            match s.split_once('e') {
                Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
                _ => s,
            }
        }
    };
}
float_text!(f64_text, f64);
float_text!(f32_text, f32);
impl Scalar {
    /// D1.9 tagged exact value: integers as decimal strings, floats as canonical float text.
    pub fn to_wire(self, class: Class) -> Value {
        match self {
            Self::Bool(b) => json!(b),
            Self::Int(n) => json!({"$t": class.name(), "v": n.to_string()}),
            Self::UInt(n) => json!({"$t": class.name(), "v": n.to_string()}),
            Self::F32(x) => json!({"$t": "float32", "v": f32_text(x)}),
            Self::F64(x) => json!({"$t": "float64", "v": f64_text(x)}),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Data {
    /// Column-major region cells; `im` is present for complex arrays.
    Numeric {
        class: Class,
        re: Vec<Scalar>,
        im: Option<Vec<Scalar>>,
    },
    /// One string per region row; `lossy` marks lone UTF-16 surrogates replaced by U+FFFD.
    Char { rows: Vec<String>, lossy: bool },
}
impl Data {
    pub fn to_wire(&self) -> Value {
        match self {
            Self::Numeric { class, re, im } => {
                let f = |v: &Vec<Scalar>| v.iter().map(|s| s.to_wire(*class)).collect::<Vec<_>>();
                json!({"kind": "numeric", "class": class.name(), "re": f(re), "im": im.as_ref().map(f)})
            }
            Self::Char { rows, lossy } => json!({"kind": "char", "rows": rows, "lossy": lossy}),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Support {
    Full,
    /// Metadata only: values are not decoded for this class.
    MetadataOnly {
        code: &'static str,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Info {
    pub name: String,
    pub class: Class,
    /// MATLAB class string; for objects, the object's own class name when it is recorded.
    pub class_name: String,
    pub dims: Vec<u64>,
    pub complex: bool,
    pub sparse: bool,
    pub global: bool,
    /// Sparse storage capacity as declared by the file.
    pub nzmax: u64,
    /// Exact sparse nonzero count; only `describe` fills it.
    pub nnz: Option<u64>,
    /// Struct field names; only `describe` fills them.
    pub fields: Vec<String>,
    /// Cell elements, or struct elements times fields; only `describe` fills it.
    pub children: Option<u64>,
    pub support: Support,
}
impl Info {
    pub fn to_wire(&self) -> Value {
        let support = match &self.support {
            Support::Full => json!({"supported": true}),
            Support::MetadataOnly { code, reason } => {
                json!({"supported": false, "code": code, "reason": reason})
            }
        };
        json!({"name": self.name, "class": self.class.name(), "className": self.class_name,
            "dims": self.dims.iter().map(|d| d.to_string()).collect::<Vec<_>>(),
            "complex": self.complex, "sparse": self.sparse, "global": self.global,
            "nzmax": self.nzmax.to_string(), "nnz": self.nnz.map(|n| n.to_string()),
            "fields": self.fields, "children": self.children.map(|n| n.to_string()),
            "support": support})
    }
}

/// One step into a cell or struct. Indices are one-based, column-major.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Cell(u64),
    Field { element: u64, field: u32 },
}
/// Stable path to a variable or a value inside one; bound to one source generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub generation: u64,
    pub variable: usize,
    pub path: Vec<Step>,
}

/// One-based inclusive-start region: `start[d]..start[d]+count[d]` in every dimension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Region {
    pub start: Vec<u64>,
    pub count: Vec<u64>,
}
impl Region {
    /// Origin-anchored region of at most `max_cells`, filling dimensions in order.
    pub fn first_page(dims: &[u64], max_cells: u64) -> Self {
        let mut left = max_cells.max(1);
        let count = dims
            .iter()
            .map(|&d| {
                let c = d.min(left);
                left /= c.max(1);
                c
            })
            .collect();
        Self {
            start: vec![1; dims.len()],
            count,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Slice {
    pub dims: Vec<u64>,
    pub region: Region,
    pub data: Data,
}
#[derive(Debug, Clone, PartialEq)]
pub struct SparseEntry {
    pub row: u64,
    pub col: u64,
    pub re: Scalar,
    pub im: Option<Scalar>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct SparseSlice {
    pub class: Class,
    pub shape: [u64; 2],
    pub nnz: u64,
    pub skipped: u64,
    /// Region entries in column-major order; implicit entries are zero.
    pub entries: Vec<SparseEntry>,
    pub has_more: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Child {
    pub node: Node,
    /// Stable display path step such as `{2,3}`, `.name` or `(2).name`.
    pub label: String,
    pub info: Info,
    /// Value for scalars and short text, so a page of children is useful without more calls.
    pub preview: Option<Data>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ChildPage {
    pub total: u64,
    pub offset: u64,
    pub items: Vec<Child>,
}
