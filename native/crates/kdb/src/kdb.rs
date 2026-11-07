//! Reads real, on-disk kdb+ objects written via q's `` `:path set table`` (flat, uncompressed,
//! non-enumerated, single table). Not the IPC wire protocol: same type-tagged body, shorter header.
//! Splayed/partitioned tables, `kxzipped` compression and enumerated symbol columns are refused.
//!
//! Port of `src/kdbParser.ts`; the body decoding follows `michaelwittig/node-q` `lib/c.js` (MIT).
//! Deliberate differences from the TypeScript (each has a test):
//! * every read is bounds-checked and every length is checked against the bytes that remain,
//!   so a corrupt count can never allocate more than the file justifies;
//! * file size, decoded value count and nesting depth are capped (`Limits`);
//! * columns of unequal length are refused instead of silently misaligning rows;
//! * datetimes are rounded from the exact value of the stored double, not from two f64 operations;
//! * months use an exact calendar (JS `Date.UTC` maps years 0-99 to 1900-1999);
//! * the nested-table dict byte must be 99; function objects and unknown negative types are typed errors.
use std::{fmt, fs::File, io::Read, path::Path};

/// kdb+ files are only ever read; nothing in this crate writes.
pub const WRITABLE: bool = false;
/// What the table worker may advertise for a kdb+ file: readable, never writable, no Safe Mode backup
/// (`src/duckdbConnection.ts`: "Safe Mode isn't applicable to a read-only kdb+ table").
pub const WRITE_MODE: &str = "none";
/// Days from 1970-01-01 to the kdb+ epoch 2000-01-01.
pub const KDB_EPOCH_DAYS: i64 = 10957;
const HEADER_LEN: usize = 2;
const SHORT_NULL: i16 = i16::MIN;
const INT_NULL: i32 = i32::MIN;
const LONG_NULL: i64 = i64::MIN;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_file_bytes: u64,
    /// Total decoded values (cells, including nested ones).
    pub max_values: u64,
    pub max_depth: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: 512 << 20,
            max_values: 32 << 20,
            max_depth: 64,
        }
    }
}

/// One decoded kdb+ value. `Null` is the type's null sentinel.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Guid(String),
    Byte(u8),
    Short(i16),
    Int(i32),
    Long(i64),
    Real(f32),
    Float(f64),
    Char(char),
    Symbol(String),
    /// Microseconds since the Unix epoch (nanosecond input truncated toward zero, as the TS does).
    TimestampMicros(i64),
    /// Unix-epoch day number of the month's first day.
    MonthDays(i64),
    DateDays(i64),
    DatetimeMicros(i64),
    /// Raw nanosecond duration, not an instant.
    TimespanNanos(i64),
    MinuteMicros(i64),
    SecondMicros(i64),
    TimeMicros(i64),
    List(Vec<Value>),
    /// A nested dict, or a nested table kept structurally (keys, values).
    Dict {
        keys: Box<Value>,
        values: Box<Value>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct KdbColumn {
    pub name: String,
    /// kdb+ vector type code, e.g. 9 = float, 14 = date, 11 = symbol.
    pub q_type: i8,
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KdbTable {
    pub columns: Vec<KdbColumn>,
    pub row_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum KdbError {
    Io(String),
    NotRegularFile,
    FileTooLarge {
        len: u64,
        max: u64,
    },
    Compressed,
    BadHeader,
    Truncated {
        offset: usize,
    },
    BadLength {
        offset: usize,
        len: i32,
    },
    NotATable {
        found: i8,
    },
    MalformedTable(&'static str),
    UnsupportedAtom(i8),
    UnsupportedObject(i8),
    ErrorObject(String),
    TooManyValues {
        max: u64,
    },
    TooDeep {
        max: u32,
    },
    DatetimeOutOfRange,
    RaggedColumns {
        column: usize,
        expected: usize,
        found: usize,
    },
}

impl KdbError {
    /// Stable machine code for the protocol layer.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "kdb_io",
            Self::NotRegularFile => "kdb_not_regular_file",
            Self::FileTooLarge { .. } => "kdb_file_too_large",
            Self::Compressed => "kdb_compressed",
            Self::BadHeader => "kdb_bad_header",
            Self::Truncated { .. } => "kdb_truncated",
            Self::BadLength { .. } => "kdb_bad_length",
            Self::NotATable { .. } => "kdb_not_a_table",
            Self::MalformedTable(_) => "kdb_malformed_table",
            Self::UnsupportedAtom(_) => "kdb_unsupported_type",
            Self::UnsupportedObject(_) => "kdb_unsupported_object",
            Self::ErrorObject(_) => "kdb_error_object",
            Self::TooManyValues { .. } => "kdb_too_many_values",
            Self::TooDeep { .. } => "kdb_too_deep",
            Self::DatetimeOutOfRange => "kdb_datetime_out_of_range",
            Self::RaggedColumns { .. } => "kdb_ragged_columns",
        }
    }
}

impl fmt::Display for KdbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(m) => write!(f, "Could not read the kdb+ file: {m}"),
            Self::NotRegularFile => f.write_str("A kdb+ file must be a regular file."),
            Self::FileTooLarge { len, max } => write!(f, "The kdb+ file is {len} bytes; the limit is {max}."),
            Self::Compressed => f.write_str("This kdb+ file uses on-disk compression (\"kxzipped\"), which is not supported."),
            Self::BadHeader => f.write_str(
                "Unrecognized kdb+ file header. Only plain, uncompressed single-object files written via `set` are \
                 supported (splayed/partitioned tables and other on-disk header variants are not).",
            ),
            Self::Truncated { offset } => write!(f, "Malformed kdb+ file: it ends unexpectedly at byte {offset}."),
            Self::BadLength { offset, len } => write!(f, "Malformed kdb+ file: invalid length {len} at byte {offset}."),
            Self::NotATable { found } => write!(
                f,
                "Expected a kdb+ table (type 98) at the top level of this file, got type {found}."
            ),
            Self::MalformedTable(m) => write!(f, "Malformed kdb+ table: {m}"),
            Self::UnsupportedAtom(t @ 20..=76) => write!(
                f,
                "Enumerated symbol columns (kdb+ type {t}) are not supported; write the table with plain symbols."
            ),
            Self::UnsupportedAtom(t) => write!(f, "Unsupported kdb+ atom type -{t}."),
            Self::UnsupportedObject(t) => {
                write!(f, "Unsupported kdb+ object type {t} (function/lambda objects are not supported).")
            }
            Self::ErrorObject(m) => write!(f, "kdb+ error object encountered: {m}"),
            Self::TooManyValues { max } => write!(f, "The kdb+ table has more than {max} values."),
            Self::TooDeep { max } => write!(f, "The kdb+ object is nested more than {max} levels deep."),
            Self::DatetimeOutOfRange => f.write_str("A kdb+ datetime value is outside the representable range."),
            Self::RaggedColumns { column, expected, found } => write!(
                f,
                "Malformed kdb+ table: column {column} has {found} rows but the first column has {expected}."
            ),
        }
    }
}

impl std::error::Error for KdbError {}

type R<T> = Result<T, KdbError>;

/// Smallest on-disk size of one element of atom/vector type `t`, or `None` when unsupported.
fn atom_size(t: i8) -> Option<usize> {
    Some(match t {
        1 | 4 | 10 | 11 => 1,
        2 => 16,
        5 => 2,
        6 | 8 | 13 | 14 | 17 | 18 | 19 => 4,
        7 | 9 | 12 | 15 | 16 => 8,
        _ => return None,
    })
}

fn floor_div(a: i64, b: i64) -> i64 {
    a.div_euclid(b)
}

/// Unix-epoch day number of a proleptic-Gregorian civil date (Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = floor_div(y, 400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// Microseconds since 1970 of `v` days since 2000 (a q datetime), rounded half up from the *exact* value of the
/// stored double. The TypeScript did `Math.round((v + 10957) * 86_400_000_000)` in f64, whose two roundings add up
/// to a microsecond of noise on a type that only has millisecond resolution (e.g. 2100.06.15T01:02:03.004 gave .004001).
/// `None` when the instant does not fit an i64 (or `v` is infinite).
fn datetime_micros(v: f64) -> Option<i64> {
    const MICROS_PER_DAY: i128 = 86_400_000_000;
    let bits = v.to_bits();
    let (negative, exponent, fraction) = (
        bits >> 63 == 1,
        ((bits >> 52) & 0x7ff) as i32,
        bits & ((1 << 52) - 1),
    );
    if exponent == 0x7ff {
        return None;
    }
    // v = m * 2^e exactly (subnormals have no implicit bit).
    let (m, e) = if exponent == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1 << 52), exponent - 1075)
    };
    let m = i128::from(m) * if negative { -1 } else { 1 };
    let base = i128::from(KDB_EPOCH_DAYS) * MICROS_PER_DAY;
    let micros = if e >= 0 {
        if e > 64 && m != 0 {
            return None;
        }
        base.checked_add(m.checked_shl(e as u32)?.checked_mul(MICROS_PER_DAY)?)?
    } else {
        let s = -e;
        // floor(m*864e8 / 2^s + 1/2); below 2^-10 of a microsecond it is 0 for either sign.
        let delta = if s >= 100 {
            0
        } else {
            (2 * m * MICROS_PER_DAY + (1_i128 << s)) >> (s + 1)
        };
        base + delta
    };
    i64::try_from(micros).ok()
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    limits: Limits,
    values: u64,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> R<&'a [u8]> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|e| *e <= self.buf.len())
            .ok_or(KdbError::Truncated { offset: self.pos })?;
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn arr<const N: usize>(&mut self) -> R<[u8; N]> {
        Ok(self.take(N)?.try_into().expect("take returned N bytes"))
    }
    fn i8(&mut self) -> R<i8> {
        Ok(self.arr::<1>()?[0] as i8)
    }
    fn u8(&mut self) -> R<u8> {
        Ok(self.arr::<1>()?[0])
    }
    fn i16(&mut self) -> R<i16> {
        Ok(i16::from_le_bytes(self.arr()?))
    }
    fn i32(&mut self) -> R<i32> {
        Ok(i32::from_le_bytes(self.arr()?))
    }
    fn i64(&mut self) -> R<i64> {
        Ok(i64::from_le_bytes(self.arr()?))
    }

    /// Null-terminated symbol; empty is q's null symbol.
    fn symbol(&mut self) -> R<Option<String>> {
        let rest = &self.buf[self.pos..];
        let end = rest
            .iter()
            .position(|b| *b == 0)
            .ok_or(KdbError::Truncated {
                offset: self.buf.len(),
            })?;
        let s = String::from_utf8_lossy(&rest[..end]).into_owned();
        self.pos += end + 1;
        Ok((!s.is_empty()).then_some(s))
    }

    fn spend(&mut self, n: usize) -> R<()> {
        self.values = self.values.saturating_add(n as u64);
        if self.values > self.limits.max_values {
            return Err(KdbError::TooManyValues {
                max: self.limits.max_values,
            });
        }
        Ok(())
    }

    fn atom(&mut self, t: i8) -> R<Value> {
        Ok(match t {
            1 => Value::Bool(self.i8()? == 1),
            2 => {
                let b = self.take(16)?;
                if b.iter().all(|x| *x == 0) {
                    Value::Null
                } else {
                    let mut s = String::with_capacity(36);
                    for (i, x) in b.iter().enumerate() {
                        if matches!(i, 4 | 6 | 8 | 10) {
                            s.push('-');
                        }
                        s.push_str(&format!("{x:02x}"));
                    }
                    Value::Guid(s)
                }
            }
            4 => Value::Byte(self.u8()?),
            5 => match self.i16()? {
                SHORT_NULL => Value::Null,
                v => Value::Short(v),
            },
            6 => match self.i32()? {
                INT_NULL => Value::Null,
                v => Value::Int(v),
            },
            7 => match self.i64()? {
                LONG_NULL => Value::Null,
                v => Value::Long(v),
            },
            8 => {
                let v = f32::from_le_bytes(self.arr()?);
                if v.is_nan() {
                    Value::Null
                } else {
                    Value::Real(v)
                }
            }
            9 => {
                let v = f64::from_le_bytes(self.arr()?);
                if v.is_nan() {
                    Value::Null
                } else {
                    Value::Float(v)
                }
            }
            10 => match self.u8()? {
                32 => Value::Null,
                c => Value::Char(char::from(c)),
            },
            11 => self.symbol()?.map_or(Value::Null, Value::Symbol),
            // ns since 2000 -> us since 1970; BigInt division truncates toward zero like Rust's `/`.
            12 => match self.i64()? {
                LONG_NULL => Value::Null,
                v => Value::TimestampMicros(v / 1000 + KDB_EPOCH_DAYS * 86_400_000_000),
            },
            13 => match self.i32()? {
                INT_NULL => Value::Null,
                v => {
                    let v = i64::from(v);
                    Value::MonthDays(days_from_civil(
                        2000 + floor_div(v, 12),
                        v.rem_euclid(12) + 1,
                        1,
                    ))
                }
            },
            14 => match self.i32()? {
                INT_NULL => Value::Null,
                v => Value::DateDays(i64::from(v) + KDB_EPOCH_DAYS),
            },
            15 => {
                let v = f64::from_le_bytes(self.arr()?);
                if v.is_nan() {
                    Value::Null
                } else {
                    Value::DatetimeMicros(datetime_micros(v).ok_or(KdbError::DatetimeOutOfRange)?)
                }
            }
            16 => match self.i64()? {
                LONG_NULL => Value::Null,
                v => Value::TimespanNanos(v),
            },
            17 => self.i32_scaled(60_000_000, Value::MinuteMicros)?,
            18 => self.i32_scaled(1_000_000, Value::SecondMicros)?,
            19 => self.i32_scaled(1000, Value::TimeMicros)?,
            _ => return Err(KdbError::UnsupportedAtom(t)),
        })
    }

    fn i32_scaled(&mut self, scale: i64, wrap: fn(i64) -> Value) -> R<Value> {
        Ok(match self.i32()? {
            INT_NULL => Value::Null,
            v => wrap(i64::from(v) * scale),
        })
    }

    /// Length prefix: non-negative and, at `min` bytes per element, no larger than what remains.
    fn len(&mut self, min: usize) -> R<usize> {
        let offset = self.pos;
        let n = self.i32()?;
        let n = usize::try_from(n).map_err(|_| KdbError::BadLength { offset, len: n })?;
        if n.checked_mul(min)
            .is_none_or(|b| b > self.buf.len() - self.pos)
        {
            return Err(KdbError::Truncated {
                offset: self.buf.len(),
            });
        }
        Ok(n)
    }

    /// List body once type and attribute bytes are consumed; reads the length itself.
    fn list_body(&mut self, t: i8, depth: u32) -> R<Vec<Value>> {
        if t < 0 {
            return Err(KdbError::UnsupportedObject(t));
        }
        if t != 0 && atom_size(t).is_none() {
            // Mirrors the TS: an empty vector of an unsupported type is harmless, a non-empty one is refused.
            let offset = self.pos;
            return match self.i32()? {
                0 => Ok(Vec::new()),
                n if n < 0 => Err(KdbError::BadLength { offset, len: n }),
                _ => Err(KdbError::UnsupportedAtom(t)),
            };
        }
        let n = self.len(atom_size(t).unwrap_or(1))?;
        if t == 10 {
            // A char vector is one string; split it back into one code point per row.
            let chars: Vec<Value> = String::from_utf8_lossy(self.take(n)?)
                .chars()
                .map(Value::Char)
                .collect();
            self.spend(chars.len())?;
            return Ok(chars);
        }
        self.spend(n)?;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(if t == 0 {
                self.any(depth + 1)?
            } else {
                self.atom(t)?
            });
        }
        Ok(out)
    }

    /// Full recursive object reader for general-list elements and nested values.
    fn any(&mut self, depth: u32) -> R<Value> {
        if depth > self.limits.max_depth {
            return Err(KdbError::TooDeep {
                max: self.limits.max_depth,
            });
        }
        let t = self.i8()?;
        match t {
            -128 => Err(KdbError::ErrorObject(self.symbol()?.unwrap_or_default())),
            -19..=-1 => {
                self.spend(1)?;
                self.atom(-t)
            }
            i8::MIN..=-1 => Err(KdbError::UnsupportedObject(t)),
            100..=127 => Err(KdbError::UnsupportedObject(t)),
            99 => {
                let keys = Box::new(self.any(depth + 1)?);
                let values = Box::new(self.any(depth + 1)?);
                Ok(Value::Dict { keys, values })
            }
            98 => {
                self.take(1)?; // attribute byte
                if self.i8()? != 99 {
                    return Err(KdbError::MalformedTable(
                        "a nested table must wrap a dict (type 99).",
                    ));
                }
                let keys = Box::new(self.any(depth + 1)?);
                let values = Box::new(self.any(depth + 1)?);
                Ok(Value::Dict { keys, values })
            }
            _ => {
                self.take(1)?; // attribute byte, uniform for every list-shaped type
                Ok(Value::List(self.list_body(t, depth)?))
            }
        }
    }

    /// Plain typed vector: type byte + attribute byte + length + payload.
    fn typed_vector(&mut self) -> R<(i8, Vec<Value>)> {
        let t = self.i8()?;
        self.take(1)?;
        Ok((t, self.list_body(t, 1)?))
    }

    fn table(&mut self) -> R<KdbTable> {
        let t = self.i8()?;
        if t != 98 {
            return Err(KdbError::NotATable { found: t });
        }
        self.take(1)?;
        if self.i8()? != 99 {
            return Err(KdbError::MalformedTable(
                "expected a dict (type 99) inside the flip.",
            ));
        }
        let (key_type, keys) = self.typed_vector()?;
        if key_type != 11 {
            return Err(KdbError::MalformedTable(
                "expected column names as a symbol vector (type 11); enumerated (indexed) symbol columns are not supported.",
            ));
        }
        if self.i8()? != 0 {
            return Err(KdbError::MalformedTable(
                "expected column data as a general list (type 0).",
            ));
        }
        self.take(1)?;
        let offset = self.pos;
        let n_cols = self.i32()?;
        if usize::try_from(n_cols).ok() != Some(keys.len()) {
            return Err(if n_cols < 0 {
                KdbError::BadLength {
                    offset,
                    len: n_cols,
                }
            } else {
                KdbError::MalformedTable("column name count does not match column data count.")
            });
        }
        let mut columns = Vec::with_capacity(keys.len());
        for (i, name) in keys.into_iter().enumerate() {
            let (q_type, values) = self.typed_vector()?;
            let name = match name {
                Value::Symbol(s) => s,
                _ => format!("column_{i}"),
            };
            columns.push(KdbColumn {
                name,
                q_type,
                values,
            });
        }
        let row_count = columns.first().map_or(0, |c| c.values.len());
        if let Some((column, c)) = columns
            .iter()
            .enumerate()
            .find(|(_, c)| c.values.len() != row_count)
        {
            return Err(KdbError::RaggedColumns {
                column,
                expected: row_count,
                found: c.values.len(),
            });
        }
        Ok(KdbTable { columns, row_count })
    }
}

/// True for the files the extension routes to the kdb+ viewer: no extension, inside a directory named `*_kdb`
/// (`package.json`: `**/*_kdb/*`, `resourceExtname == '' && resourcePath =~ /_kdb\//`). Content is never sniffed.
pub fn is_kdb_path(path: &Path) -> bool {
    path.extension().is_none()
        && path.file_name().is_some()
        && path.parent().is_some_and(|p| {
            p.components()
                .any(|c| c.as_os_str().to_string_lossy().ends_with("_kdb"))
        })
}

/// The name the table is listed under: the file name without its extension (`basename(path, extname(path))`).
pub fn table_name(path: &Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().into_owned())
}

pub fn parse_kdb_buffer(buf: &[u8], limits: Limits) -> R<KdbTable> {
    if buf.len() as u64 > limits.max_file_bytes {
        return Err(KdbError::FileTooLarge {
            len: buf.len() as u64,
            max: limits.max_file_bytes,
        });
    }
    if buf.starts_with(b"kxzipped") {
        return Err(KdbError::Compressed);
    }
    if buf.len() < HEADER_LEN + 1 || buf[0] != 0xff || buf[1] != 0x01 {
        return Err(KdbError::BadHeader);
    }
    Reader {
        buf,
        pos: HEADER_LEN,
        limits,
        values: 0,
    }
    .table()
}

pub fn parse_kdb_file(path: &Path, limits: Limits) -> R<KdbTable> {
    let io = |e: std::io::Error| KdbError::Io(e.to_string());
    // Check before opening: opening a FIFO with no writer would block forever.
    if !std::fs::metadata(path).map_err(io)?.is_file() {
        return Err(KdbError::NotRegularFile);
    }
    let file = File::open(path).map_err(io)?;
    let meta = file.metadata().map_err(io)?;
    if !meta.is_file() {
        return Err(KdbError::NotRegularFile);
    }
    if meta.len() > limits.max_file_bytes {
        return Err(KdbError::FileTooLarge {
            len: meta.len(),
            max: limits.max_file_bytes,
        });
    }
    // One byte past the limit detects a file that grew after the metadata check.
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.take(limits.max_file_bytes + 1)
        .read_to_end(&mut buf)
        .map_err(io)?;
    parse_kdb_buffer(&buf, limits)
}
