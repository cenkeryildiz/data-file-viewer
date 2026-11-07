//! D3.15c: one-cell edits on Arrow IPC stream / file (Feather V2) containers. Produces bytes only;
//! staging, verification and publication belong to D3.12. The container kind, schema and field
//! metadata, file footer metadata, dictionaries and compression codec of the source are preserved.
use arrow_array::cast::AsArray;
use arrow_array::{
    Array, ArrayRef, BooleanArray, RecordBatch, Scalar, StringArray, UInt64Array, make_array,
    new_null_array,
};
use arrow_cast::{CastOptions, cast_with_options};
use arrow_data::ArrayData;
use arrow_ipc::CompressionType;
use arrow_ipc::writer::{FileWriter, IpcWriteOptions, StreamWriter};
use arrow_schema::{DataType, Field};
use arrow_select::zip::zip;
use dfv_table_arrow_ipc::{Codec, Container, Limits, Source, cell_text, open};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

/// Mirrors the TypeScript `updateCell`: `row` identifies the cell's row by the displayed text of the
/// listed columns (`None` = null); `value` is the new text (`None` = null).
pub struct CellEdit<'a> {
    pub column: &'a str,
    pub value: Option<&'a str>,
    pub row: &'a [(&'a str, Option<&'a str>)],
}

#[derive(Debug)]
pub enum Error {
    Source(dfv_table_arrow_ipc::Error),
    /// The edit named no row columns: it would be every row.
    NoRowIdentity,
    NoSuchColumn(String),
    NoMatch,
    Ambiguous(u64),
    NotNullable(String),
    UnsupportedType(String),
    /// The text cannot be stored exactly in the column's type.
    InvalidValue(String),
    Unsupported(String),
    Write(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Source(e) => write!(f, "{e}"),
            Self::NoRowIdentity => {
                f.write_str("The edit did not say which row it is for, so nothing was changed.")
            }
            Self::NoSuchColumn(c) => write!(f, "No column named \"{c}\"."),
            Self::NoMatch => f.write_str("No row matched the edit; nothing was changed."),
            Self::Ambiguous(n) => write!(
                f,
                "{n} rows are identical across every column given, so there is no way to tell which one was edited. Nothing was changed."
            ),
            Self::NotNullable(c) => write!(f, "Column \"{c}\" does not allow nulls."),
            Self::UnsupportedType(m)
            | Self::InvalidValue(m)
            | Self::Unsupported(m)
            | Self::Write(m) => f.write_str(m),
        }
    }
}
impl std::error::Error for Error {}
impl From<dfv_table_arrow_ipc::Error> for Error {
    fn from(e: dfv_table_arrow_ipc::Error) -> Self {
        Self::Source(e)
    }
}
fn write_err(e: impl std::fmt::Display) -> Error {
    Error::Write(e.to_string())
}

/// Convenience over [`edit_cell_to`] for callers that stage the bytes themselves.
pub fn edit_cell(path: &Path, limits: &Limits, edit: &CellEdit) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    edit_cell_to(path, limits, edit, &mut out)?;
    Ok(out)
}

/// Every refusal (unknown column, no/ambiguous match, unsupported type, inexact value, dictionary
/// value, mixed codecs) happens before the first byte reaches `out`.
pub fn edit_cell_to<W: Write>(
    path: &Path,
    limits: &Limits,
    edit: &CellEdit,
    out: W,
) -> Result<(), Error> {
    if edit.row.is_empty() {
        return Err(Error::NoRowIdentity);
    }
    let src = open(path, limits)?;
    let schema = src.original_schema.clone();
    let col = schema
        .index_of(edit.column)
        .map_err(|_| Error::NoSuchColumn(edit.column.into()))?;
    let field = schema.field(col);
    check_type(field)?;
    let keys: Vec<(usize, Option<String>)> = edit
        .row
        .iter()
        .map(|(name, v)| {
            let index = schema
                .index_of(name)
                .map_err(|_| Error::NoSuchColumn((*name).into()))?;
            Ok((index, identity_text(schema.field(index).data_type(), *v)))
        })
        .collect::<Result<_, Error>>()?;
    let options = write_options(&src)?;
    // arrow-rs stores incompressible Decimal128 buffers raw behind the 8-byte length prefix, at an offset
    // that is not 16-aligned; Polars panics on such files. Refuse rather than hand back a file it cannot open.
    if !src.codecs.is_empty() && schema.fields().iter().any(|f| has_decimal(f.data_type())) {
        return Err(Error::Unsupported("This compressed file has decimal columns; rewriting it with the available writer produces a file Polars cannot read, so nothing was written.".into()));
    }
    if src.has_message_metadata {
        return Err(Error::Unsupported("This file has message metadata the available writer cannot preserve, so nothing was written.".into()));
    }
    let custom = src.custom_metadata()?;

    // Pass 1: find the one matching row, on the displayed text (what the grid shows and sends back).
    let (mut found, mut hit) = (0u64, (0usize, 0usize));
    for (bi, batch) in src.batches()?.enumerate() {
        let shown = src.display_batch(&batch?)?;
        for row in 0..shown.num_rows() {
            let mut all = true;
            for (ci, want) in &keys {
                if cell_text(shown.column(*ci).as_ref(), row)?.as_deref() != want.as_deref() {
                    all = false;
                    break;
                }
            }
            if all {
                found += 1;
                hit = (bi, row);
            }
        }
    }
    match found {
        0 => return Err(Error::NoMatch),
        1 => {}
        n => return Err(Error::Ambiguous(n)),
    }
    if edit.value.is_none() && !field.is_nullable() {
        return Err(Error::NotNullable(edit.column.into()));
    }

    // Build the replacement batch before anything is written.
    let target = src.batches()?.nth(hit.0).ok_or(Error::NoMatch)??;
    let new_value = scalar_for(value_type(field.data_type()), edit.value)?;
    let mut cols = target.columns().to_vec();
    cols[col] = replace_cell(&cols[col], hit.1, &new_value)?;
    let replaced = RecordBatch::try_new(schema.clone(), cols).map_err(write_err)?;

    // Pass 2: stream every batch through the container's own writer.
    macro_rules! copy {
        ($w:expr) => {{
            let mut w = $w;
            for (bi, batch) in src.batches()?.enumerate() {
                let batch = batch?;
                w.write(if bi == hit.0 { &replaced } else { &batch })
                    .map_err(write_err)?;
            }
            w
        }};
    }
    match src.container {
        Container::Stream => {
            let mut w = copy!(
                StreamWriter::try_new_with_options(out, &schema, options).map_err(write_err)?
            );
            w.finish().map_err(write_err)?;
        }
        Container::File => {
            let mut w =
                FileWriter::try_new_with_options(out, &schema, options).map_err(write_err)?;
            for (k, v) in custom {
                w.write_metadata(k, v);
            }
            let mut w = copy!(w);
            w.finish().map_err(write_err)?;
        }
    }
    Ok(())
}

fn write_options(src: &Source) -> Result<IpcWriteOptions, Error> {
    let options = IpcWriteOptions::default();
    let mut distinct = src.codecs.clone();
    distinct.dedup();
    match distinct.as_slice() {
        [] => Ok(options),
        [one] => options
            .try_with_compression(Some(match one {
                Codec::Lz4Frame => CompressionType::LZ4_FRAME,
                Codec::Zstd => CompressionType::ZSTD,
            }))
            .map_err(write_err),
        _ => Err(Error::Unsupported("The source mixes compression codecs; rewriting it would change them, so nothing was written.".into())),
    }
}

fn has_decimal(dt: &DataType) -> bool {
    match dt {
        DataType::Decimal128(..) | DataType::Decimal256(..) => true,
        DataType::List(f)
        | DataType::LargeList(f)
        | DataType::FixedSizeList(f, _)
        | DataType::Map(f, _) => has_decimal(f.data_type()),
        DataType::Struct(fs) => fs.iter().any(|f| has_decimal(f.data_type())),
        DataType::Dictionary(_, v) => has_decimal(v),
        _ => false,
    }
}

fn value_type(dt: &DataType) -> &DataType {
    match dt {
        DataType::Dictionary(_, v) => v,
        other => other,
    }
}

pub fn check_type(field: &Field) -> Result<(), Error> {
    use DataType::*;
    let scalar = |dt: &DataType| {
        matches!(
            dt,
            Boolean
                | Int8
                | Int16
                | Int32
                | Int64
                | UInt8
                | UInt16
                | UInt32
                | UInt64
                | Float32
                | Float64
                | Utf8
                | LargeUtf8
                | Utf8View
                | Decimal128(..)
                | Date32
                | Date64
                | Timestamp(..)
        )
    };
    let ok = match field.data_type() {
        Dictionary(k, v) => k.is_integer() && scalar(v),
        other => scalar(other),
    };
    ok.then_some(()).ok_or_else(|| {
        Error::UnsupportedType(format!(
            "Column \"{}\" has type {}, which cannot be edited.",
            field.name(),
            field.data_type()
        ))
    })
}

/// Compare temporal identities in the source type's display form, including its exact time unit.
pub fn identity_text(dt: &DataType, text: Option<&str>) -> Option<String> {
    let text = text?;
    let dt = value_type(dt);
    if matches!(
        dt,
        DataType::Timestamp(..)
            | DataType::Date32
            | DataType::Date64
            | DataType::Time32(..)
            | DataType::Time64(..)
    ) && let Ok(value) = scalar_for(dt, Some(text))
        && let Ok(value) = cell_text(value.as_ref(), 0)
    {
        return value;
    }
    // Already-formatted identities (including unsupported named-zone displays) keep exact matching.
    Some(text.to_owned())
}

/// One-element array of `dt` holding exactly `text`; refuses anything the type would round or clip.
pub fn scalar_for(dt: &DataType, text: Option<&str>) -> Result<ArrayRef, Error> {
    let Some(s) = text else {
        return Ok(new_null_array(dt, 1));
    };
    let bad = |why: &str| {
        Error::InvalidValue(format!("\"{s}\" cannot be stored exactly as {dt}: {why}."))
    };
    let fraction = s.split_once('.').map_or(0, |(_, f)| {
        f.chars().take_while(char::is_ascii_digit).count()
    });
    match dt {
        DataType::Decimal128(_, scale) if s.contains(['e', 'E']) || fraction > *scale as usize => {
            return Err(bad(
                "more fractional digits than the scale, or exponent notation",
            ));
        }
        DataType::Timestamp(unit, _) => {
            let digits = match unit {
                arrow_schema::TimeUnit::Second => 0,
                arrow_schema::TimeUnit::Millisecond => 3,
                arrow_schema::TimeUnit::Microsecond => 6,
                arrow_schema::TimeUnit::Nanosecond => 9,
            };
            if fraction > digits {
                return Err(bad("finer than the column's time unit"));
            }
        }
        _ => {}
    }
    let text_array: ArrayRef = Arc::new(StringArray::from(vec![s]));
    let opts = CastOptions {
        safe: false,
        ..Default::default()
    };
    // shortcut: only "UTC"/"GMT"/"Z"-style zones and fixed offsets parse (no chrono-tz offline); other named zones are refused.
    let out = match dt {
        DataType::Timestamp(unit, Some(tz))
            if matches!(
                tz.to_ascii_uppercase().as_str(),
                "UTC" | "GMT" | "Z" | "ETC/UTC" | "ETC/GMT"
            ) =>
        {
            let as_offset = DataType::Timestamp(*unit, Some("+00:00".into()));
            let parsed = cast_with_options(&text_array, &as_offset, &opts)
                .map_err(|e| bad(&e.to_string()))?;
            let raw = cast_with_options(&parsed, &DataType::Int64, &opts)
                .map_err(|e| bad(&e.to_string()))?;
            cast_with_options(&raw, dt, &opts).map_err(|e| bad(&e.to_string()))?
        }
        _ => cast_with_options(&text_array, dt, &opts).map_err(|e| bad(&e.to_string()))?,
    };
    let non_finite = match out.data_type() {
        DataType::Float64 => !out
            .as_primitive::<arrow_array::types::Float64Type>()
            .value(0)
            .is_finite(),
        DataType::Float32 => !out
            .as_primitive::<arrow_array::types::Float32Type>()
            .value(0)
            .is_finite(),
        _ => false,
    };
    let literal = matches!(
        s.trim().to_ascii_lowercase().trim_start_matches(['+', '-']),
        "inf" | "infinity" | "nan"
    );
    if non_finite && !literal {
        return Err(bad("out of range"));
    }
    Ok(out)
}

pub fn replace_cell(arr: &ArrayRef, row: usize, new: &ArrayRef) -> Result<ArrayRef, Error> {
    let mask = BooleanArray::from_iter((0..arr.len()).map(|i| Some(i == row)));
    let unsupported = |e: arrow_schema::ArrowError| {
        Error::Unsupported(format!(
            "The cell could not be replaced in a {} column: {e}",
            arr.data_type()
        ))
    };
    let DataType::Dictionary(key_type, _) = arr.data_type() else {
        let out = zip(&mask, &Scalar::new(new.clone()), arr).map_err(unsupported)?;
        return (out.data_type() == arr.data_type())
            .then_some(out)
            .ok_or_else(|| {
                Error::Unsupported(
                    "The replacement changed the column type; nothing was written.".into(),
                )
            });
    };
    let dict = arr.as_any_dictionary();
    let new_key: ArrayRef = if new.is_null(0) {
        new_null_array(key_type, 1)
    } else {
        // Only a value the batch's dictionary already holds: extending it would change the shared
        // dictionary other batches (and the file format's no-replacement rule) depend on.
        let want = cell_text(new.as_ref(), 0)?;
        let values = dict.values();
        let index = (0..values.len())
            .find(|&i| !values.is_null(i) && cell_text(values.as_ref(), i).ok() == Some(want.clone()))
            .ok_or_else(|| Error::Unsupported(format!("\"{}\" is not in this column's dictionary; adding values to a dictionary is not supported.", want.unwrap_or_default())))?;
        let idx: ArrayRef = Arc::new(UInt64Array::from(vec![index as u64]));
        cast_with_options(
            &idx,
            key_type,
            &CastOptions {
                safe: false,
                ..Default::default()
            },
        )
        .map_err(unsupported)?
    };
    let keys = zip(&mask, &Scalar::new(new_key), &dict.keys()).map_err(unsupported)?;
    let kd = keys.to_data();
    if kd.offset() != 0 {
        return Err(Error::Unsupported(
            "Unexpected sliced dictionary keys.".into(),
        ));
    }
    let data = ArrayData::builder(arr.data_type().clone())
        .len(arr.len())
        .add_buffer(kd.buffers()[0].clone())
        .nulls(kd.nulls().cloned())
        .add_child_data(dict.values().to_data())
        .build()
        .map_err(unsupported)?;
    Ok(make_array(data))
}
