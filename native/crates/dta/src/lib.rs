//! Bounded, read-only Stata 117–119 input. The codec never sees unchecked allocation lengths.
mod preflight;
use dta::stata::dta::{
    dta_reader::DtaReader, header::Header, record_reader::RecordReader, schema::Schema,
    value::Value, value_label::ValueLabelSet, variable_type::VariableType,
};
use dta::stata::{
    stata_byte::StataByte, stata_double::StataDouble, stata_float::StataFloat, stata_int::StataInt,
    stata_long::StataLong,
};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{Cursor, Read},
    path::Path,
    sync::Arc,
};

#[derive(Debug, Clone)]
pub struct Limits {
    pub file_bytes: usize,
    pub metadata_bytes: usize,
    pub columns: usize,
    pub row_bytes: usize,
    pub cell_bytes: usize,
    pub metadata_entries: usize,
    pub page_cells: usize,
    pub page_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: 256 << 20,
            metadata_bytes: 32 << 20,
            columns: 16_384,
            row_bytes: 8 << 20,
            cell_bytes: 4 << 20,
            metadata_entries: 100_000,
            page_cells: 1_000_000,
            page_bytes: 16 << 20,
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Unsupported(String),
    TooLarge(String),
    Malformed(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => e.fmt(f),
            Self::Unsupported(s) | Self::TooLarge(s) | Self::Malformed(s) => s.fmt(f),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<dta::stata::dta::dta_error::DtaError> for Error {
    fn from(e: dta::stata::dta::dta_error::DtaError) -> Self {
        Self::Malformed(e.to_string())
    }
}
fn bad(s: &str) -> Error {
    Error::Malformed(s.into())
}
fn bound(n: usize, cap: usize, name: &str) -> Result<(), Error> {
    if n > cap {
        Err(Error::TooLarge(format!(
            "{name} exceeds its limit ({n} > {cap})."
        )))
    } else {
        Ok(())
    }
}

/// Missing tags remain distinct here; a display adapter may show them as null without losing the tag.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Integer(i64),
    Float(f64),
    Text(String),
    Binary(Vec<u8>),
    Missing(String),
}
impl Cell {
    fn bytes(&self) -> usize {
        match self {
            Self::Text(s) | Self::Missing(s) => s.len(),
            Self::Binary(b) => b.len(),
            _ => 8,
        }
    }
}

#[derive(Debug)]
pub struct Source {
    bytes: Arc<[u8]>,
    limits: Limits,
    pub header: Header,
    pub schema: Schema,
    pub value_labels: Vec<ValueLabelSet>,
    long_strings: BTreeMap<(u32, u64), Cell>,
}
type Reader = RecordReader<Cursor<Arc<[u8]>>>;

pub fn storage_width(t: VariableType) -> usize {
    match t {
        VariableType::Byte => 1,
        VariableType::Int => 2,
        VariableType::Long | VariableType::Float => 4,
        VariableType::Double | VariableType::LongString => 8,
        VariableType::FixedString(n) => usize::from(n),
    }
}

pub fn open(path: &Path, limits: &Limits) -> Result<Source, Error> {
    let mut file = File::open(path)?;
    if file.metadata()?.len() > limits.file_bytes as u64 {
        return Err(Error::TooLarge("DTA file exceeds its byte budget.".into()));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limits.file_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    from_bytes(bytes.into(), limits)
}

pub fn from_bytes(bytes: Arc<[u8]>, limits: &Limits) -> Result<Source, Error> {
    bound(bytes.len(), limits.file_bytes, "DTA file")?;
    // Legacy and future releases have different layouts; never feed them to the modern preflight.
    let prefix = b"<stata_dta><header><release>";
    let release = bytes.get(prefix.len()..prefix.len() + 3);
    if !bytes.starts_with(prefix) || !matches!(release, Some(b"117" | b"118" | b"119")) {
        return Err(Error::Unsupported("Native DTA viewing supports Stata releases 117, 118 and 119. Convert other releases using ETL.".into()));
    }
    let mut cursor = Cursor::new(bytes.clone());
    let header = {
        let reader = DtaReader::new().from_reader(&mut cursor).read_header()?;
        reader.header().clone()
    };
    bound(
        header.variable_count() as usize,
        limits.columns,
        "DTA columns",
    )?;
    // Each schema field has a release-defined fixed width, at most 1293 bytes.
    bound(
        (header.variable_count() as usize).saturating_mul(1500),
        limits.metadata_bytes,
        "DTA schema",
    )?;
    preflight::check(&bytes, cursor.position() as usize, &header, limits)?;
    let reader = DtaReader::new()
        .from_reader(Cursor::new(bytes.clone()))
        .read_header()?
        .read_schema()?;
    let schema = reader.schema().clone();
    let mut names = HashSet::new();
    for variable in schema.variables() {
        if !names.insert(variable.name()) {
            return Err(bad("Duplicate DTA variable name."));
        }
    }
    let row_bytes: usize = schema
        .variables()
        .iter()
        .map(|v| storage_width(v.variable_type()))
        .sum();
    bound(row_bytes, limits.row_bytes, "DTA row")?;
    preflight::check_data(&bytes, cursor.position() as usize, &header, row_bytes)?;
    let mut strings_reader = reader.seek_long_strings()?;
    let encoding = strings_reader.encoding();
    let mut long_strings = BTreeMap::new();
    while let Some(s) = strings_reader.read_long_string()? {
        let value = if s.is_binary() {
            Cell::Binary(s.data().to_vec())
        } else {
            Cell::Text(
                s.data_str(encoding)
                    .ok_or_else(|| bad("Invalid DTA long-string encoding."))?
                    .into_owned(),
            )
        };
        long_strings.insert((s.variable(), s.observation()), value);
    }
    let mut labels_reader = strings_reader.into_value_label_reader()?;
    let mut value_labels: Vec<ValueLabelSet> = Vec::new();
    let mut label_names = HashSet::new();
    while let Some(set) = labels_reader.read_value_label_set()? {
        if !label_names.insert(set.name().to_owned()) {
            return Err(bad("Duplicate DTA value-label set."));
        }
        let mut values = HashSet::new();
        if set
            .entries()
            .iter()
            .any(|entry| !values.insert(entry.value()))
        {
            return Err(bad("Duplicate value in a DTA label set."));
        }
        value_labels.push(set);
    }
    Ok(Source {
        bytes,
        limits: limits.clone(),
        header,
        schema,
        value_labels,
        long_strings,
    })
}

impl Source {
    pub fn read_only(&self) -> bool {
        true
    }

    fn reader(&self) -> Result<Reader, Error> {
        Ok(DtaReader::new()
            .from_reader(Cursor::new(self.bytes.clone()))
            .read_header()?
            .read_schema()?
            .seek_records()?)
    }

    /// Zero-based paging; seek directly to the requested record instead of decoding preceding rows.
    pub fn read_rows(&self, offset: u64, count: usize) -> Result<Vec<Vec<Cell>>, Error> {
        let n = self
            .header
            .observation_count()
            .saturating_sub(offset)
            .min(count as u64) as usize;
        bound(
            n.saturating_mul(self.schema.variables().len()),
            self.limits.page_cells,
            "DTA page cells",
        )?;
        if n == 0 {
            return Ok(Vec::new());
        }
        let mut reader = self.reader()?;
        reader.seek_to_record(offset)?;
        let mut rows = Vec::new();
        let mut bytes = n.saturating_mul(std::mem::size_of::<Vec<Cell>>());
        bound(bytes, self.limits.page_bytes, "DTA page bytes")?;
        for _ in 0..n {
            let record = reader
                .read_record()?
                .ok_or_else(|| bad("Truncated DTA data."))?;
            let mut row = Vec::new();
            for value in record.values() {
                macro_rules! number {
                    ($v:expr, $kind:ident, $present:expr) => {
                        match $v {
                            $kind::Present(v) => $present(*v),
                            $kind::Missing(m) => Cell::Missing(m.to_string()),
                        }
                    };
                }
                let cell = match value {
                    Value::Byte(v) => number!(v, StataByte, |n| Cell::Integer(i64::from(n))),
                    Value::Int(v) => number!(v, StataInt, |n| Cell::Integer(i64::from(n))),
                    Value::Long(v) => number!(v, StataLong, |n| Cell::Integer(i64::from(n))),
                    Value::Float(v) => number!(v, StataFloat, |n| Cell::Float(f64::from(n))),
                    Value::Double(v) => number!(v, StataDouble, Cell::Float),
                    Value::String(s) => Cell::Text(s.to_string()),
                    Value::LongStringRef(r) if r.variable() == 0 && r.observation() == 0 => {
                        Cell::Text(String::new())
                    }
                    Value::LongStringRef(r) => self
                        .long_strings
                        .get(&(r.variable(), r.observation()))
                        .ok_or_else(|| bad("Missing DTA long-string reference."))?
                        .clone(),
                };
                if matches!(&cell, Cell::Float(n) if !n.is_finite()) {
                    return Err(bad("Invalid non-finite DTA numeric value."));
                }
                bound(cell.bytes(), self.limits.cell_bytes, "DTA cell")?;
                bytes = bytes
                    .saturating_add(cell.bytes())
                    .saturating_add(std::mem::size_of::<Cell>());
                bound(bytes, self.limits.page_bytes, "DTA page bytes")?;
                row.push(cell);
            }
            rows.push(row);
        }
        Ok(rows)
    }
}
