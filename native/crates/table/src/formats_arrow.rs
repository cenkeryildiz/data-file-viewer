//! Stream the accepted IPC decoder into typed private tables, with lossless query adaptations.
use dfv_table_arrow_ipc as ipc;
use dfv_table_duckdb::{Engine, Error, Kind, duckdb::quote_ident};
use duckdb::arrow::{
    array::{ArrayRef, AsArray, make_array},
    compute::cast,
    datatypes::{
        DataType, Field, Fields, IntervalMonthDayNanoType, IntervalUnit, Schema, TimeUnit,
    },
    record_batch::RecordBatch,
};
use std::{path::Path, sync::Arc};

fn resource_limit() -> Error {
    Error::TooLarge("The Arrow query exceeds its nesting or decoded-storage budget.".into())
}

fn schema_depth(schema: &Schema) -> Result<(), Error> {
    let mut pending = schema
        .fields()
        .iter()
        .map(|f| (f.data_type(), 0))
        .collect::<Vec<_>>();
    while let Some((kind, depth)) = pending.pop() {
        // Match the native wire profile before any recursive query-schema adaptation.
        if depth > 32 {
            return Err(resource_limit());
        }
        use DataType::*;
        match kind {
            List(f)
            | LargeList(f)
            | ListView(f)
            | LargeListView(f)
            | FixedSizeList(f, _)
            | Map(f, _) => pending.push((f.data_type(), depth + 1)),
            Struct(fields) => pending.extend(fields.iter().map(|f| (f.data_type(), depth + 1))),
            Dictionary(key, value) => {
                pending.extend([(key.as_ref(), depth + 1), (value.as_ref(), depth + 1)])
            }
            Union(fields, _) => pending.extend(
                fields
                    .iter()
                    .map(|(_, field)| (field.data_type(), depth + 1)),
            ),
            RunEndEncoded(run_ends, values) => pending.extend([
                (run_ends.data_type(), depth + 1),
                (values.data_type(), depth + 1),
            ]),
            _ => {}
        }
    }
    Ok(())
}

fn row_width(kind: &DataType) -> u64 {
    use DataType::*;
    kind.primitive_width()
        .map(|n| n as u64)
        .unwrap_or_else(|| match kind {
            Boolean => 1,
            FixedSizeBinary(n) => (*n).max(0) as u64,
            FixedSizeList(f, n) => row_width(f.data_type()).saturating_mul((*n).max(0) as u64),
            Struct(fields) => fields
                .iter()
                .fold(0u64, |n, f| n.saturating_add(row_width(f.data_type()))),
            LargeUtf8 | LargeBinary | LargeList(_) => 8,
            _ => 4,
        })
}

/// Conservative cast-storage projection: shared dictionaries/views must not hide expansion.
fn projected(array: &ArrayRef, target: &DataType) -> u64 {
    use DataType::*;
    let rows = array.len() as u64;
    if let Some(dict) = array.as_any_dictionary_opt() {
        let values = dict.values();
        let maximum = match values.data_type() {
            Utf8 => values
                .as_string::<i32>()
                .iter()
                .flatten()
                .map(str::len)
                .max()
                .unwrap_or(0) as u64,
            LargeUtf8 => values
                .as_string::<i64>()
                .iter()
                .flatten()
                .map(str::len)
                .max()
                .unwrap_or(0) as u64,
            Utf8View => values
                .as_string_view()
                .iter()
                .flatten()
                .map(str::len)
                .max()
                .unwrap_or(0) as u64,
            _ if target.primitive_width().is_some() => 0,
            _ => projected(values, target),
        };
        return rows.saturating_mul(row_width(target).saturating_add(maximum));
    }
    let mut bytes = if matches!(target, Struct(_) | FixedSizeList(_, _)) {
        0
    } else {
        rows.saturating_mul(row_width(target))
    };
    let payload = match array.data_type() {
        Utf8 => array
            .as_string::<i32>()
            .iter()
            .flatten()
            .map(str::len)
            .fold(0u64, |n, k| n.saturating_add(k as u64)),
        LargeUtf8 => array
            .as_string::<i64>()
            .iter()
            .flatten()
            .map(str::len)
            .fold(0u64, |n, k| n.saturating_add(k as u64)),
        Utf8View => array
            .as_string_view()
            .iter()
            .flatten()
            .map(str::len)
            .fold(0u64, |n, k| n.saturating_add(k as u64)),
        Binary => array
            .as_binary::<i32>()
            .iter()
            .flatten()
            .map(<[u8]>::len)
            .fold(0u64, |n, k| n.saturating_add(k as u64)),
        LargeBinary => array
            .as_binary::<i64>()
            .iter()
            .flatten()
            .map(<[u8]>::len)
            .fold(0u64, |n, k| n.saturating_add(k as u64)),
        BinaryView => array
            .as_binary_view()
            .iter()
            .flatten()
            .map(<[u8]>::len)
            .fold(0u64, |n, k| n.saturating_add(k as u64)),
        _ => array.get_buffer_memory_size() as u64,
    };
    if matches!(
        array.data_type(),
        Utf8 | LargeUtf8 | Utf8View | Binary | LargeBinary | BinaryView
    ) {
        bytes = bytes.saturating_add(payload);
    }
    let data = array.to_data();
    match target {
        List(f) | LargeList(f) | FixedSizeList(f, _) | Map(f, _) => {
            if let Some(child) = data.child_data().first() {
                bytes = bytes.saturating_add(projected(&make_array(child.clone()), f.data_type()));
            }
        }
        Struct(fields) => {
            for (child, field) in data.child_data().iter().zip(fields) {
                bytes =
                    bytes.saturating_add(projected(&make_array(child.clone()), field.data_type()));
            }
        }
        _ => {}
    }
    bytes.max(payload)
}

fn error(e: ipc::Error) -> Error {
    match e {
        ipc::Error::TooLarge(_) => Error::TooLarge(e.to_string()),
        ipc::Error::Unsupported(_) | ipc::Error::FeatherV1 => Error::Unsupported(e.to_string()),
        _ => Error::Engine(e.to_string()),
    }
}
fn unsupported(t: &DataType) -> Error {
    Error::Unsupported(format!(
        "Arrow {t} cannot be represented exactly by this query engine."
    ))
}

/// Adapt only representation differences; every adapted array must round-trip to its source values.
fn query_type(t: &DataType) -> Result<DataType, Error> {
    use DataType::*;
    Ok(match t {
        Null => Int32,
        Dictionary(_, value) => query_type(value)?,
        Utf8View => Utf8,
        BinaryView => Binary,
        Date64 => Date32,
        Time32(_) | Time64(_) => Time64(TimeUnit::Microsecond),
        Timestamp(_, Some(zone)) => Timestamp(TimeUnit::Microsecond, Some(zone.clone())),
        Duration(_) => Duration(TimeUnit::Microsecond),
        Interval(_) => Interval(IntervalUnit::MonthDayNano),
        Decimal32(p, s) | Decimal64(p, s) | Decimal128(p, s) | Decimal256(p, s) => {
            let width = u16::from(*p) + u16::from(s.unsigned_abs()) * u16::from(*s < 0);
            if width > 38 || *s > 38 {
                return Err(unsupported(t));
            }
            Decimal128(width as u8, (*s).max(0))
        }
        List(f) => List(Arc::new(
            f.as_ref()
                .clone()
                .with_data_type(query_type(f.data_type())?),
        )),
        LargeList(f) => LargeList(Arc::new(
            f.as_ref()
                .clone()
                .with_data_type(query_type(f.data_type())?),
        )),
        FixedSizeList(f, n) if *n > 0 => FixedSizeList(
            Arc::new(
                f.as_ref()
                    .clone()
                    .with_data_type(query_type(f.data_type())?),
            ),
            *n,
        ),
        Struct(fields) => Struct(
            fields
                .iter()
                .map(|f| {
                    Ok(Arc::new(
                        f.as_ref()
                            .clone()
                            .with_data_type(query_type(f.data_type())?),
                    ))
                })
                .collect::<Result<Fields, Error>>()?,
        ),
        Map(f, sorted) => Map(
            Arc::new(
                f.as_ref()
                    .clone()
                    .with_data_type(query_type(f.data_type())?),
            ),
            *sorted,
        ),
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
        | Binary
        | LargeBinary
        | FixedSizeBinary(_)
        | Date32
        | Timestamp(_, None) => t.clone(),
        _ => return Err(unsupported(t)),
    })
}

fn sql_type(t: &DataType) -> Result<String, Error> {
    use DataType::*;
    Ok(match t {
        Boolean => "BOOLEAN".into(),
        Int8 => "TINYINT".into(),
        Int16 => "SMALLINT".into(),
        Int32 => "INTEGER".into(),
        Int64 => "BIGINT".into(),
        UInt8 => "UTINYINT".into(),
        UInt16 => "USMALLINT".into(),
        UInt32 => "UINTEGER".into(),
        UInt64 => "UBIGINT".into(),
        Float32 => "REAL".into(),
        Float64 => "DOUBLE".into(),
        Utf8 | LargeUtf8 => "VARCHAR".into(),
        Binary | LargeBinary | FixedSizeBinary(_) => "BLOB".into(),
        Date32 => "DATE".into(),
        Time64(TimeUnit::Microsecond) => "TIME".into(),
        Timestamp(_, Some(_)) => "TIMESTAMPTZ".into(),
        Timestamp(unit, None) => match unit {
            TimeUnit::Second => "TIMESTAMP_S",
            TimeUnit::Millisecond => "TIMESTAMP_MS",
            TimeUnit::Microsecond => "TIMESTAMP",
            TimeUnit::Nanosecond => "TIMESTAMP_NS",
        }
        .into(),
        Duration(_) | Interval(_) => "INTERVAL".into(),
        Decimal128(p, s) => format!("DECIMAL({p},{s})"),
        List(f) | LargeList(f) => format!("{}[]", sql_field(f)?),
        FixedSizeList(f, n) => format!("{}[{n}]", sql_field(f)?),
        Struct(fields) if !fields.is_empty() => format!(
            "STRUCT({})",
            fields
                .iter()
                .map(|f| Ok(format!("{} {}", quote_ident(f.name()), sql_field(f)?)))
                .collect::<Result<Vec<_>, Error>>()?
                .join(",")
        ),
        Map(field, _) => {
            let Struct(fields) = field.data_type() else {
                return Err(unsupported(t));
            };
            if fields.len() != 2 {
                return Err(unsupported(t));
            }
            format!("MAP({},{})", sql_field(&fields[0])?, sql_field(&fields[1])?)
        }
        _ => return Err(unsupported(t)),
    })
}

fn sql_field(field: &Field) -> Result<String, Error> {
    if field.extension_type_name() == Some("arrow.uuid") {
        return if field.data_type() == &DataType::FixedSizeBinary(16) {
            Ok("UUID".into())
        } else {
            Err(unsupported(field.data_type()))
        };
    }
    sql_type(field.data_type())
}

fn precision(array: &ArrayRef) -> Result<(), Error> {
    if array.data_type() == &DataType::Interval(IntervalUnit::MonthDayNano)
        && array
            .as_primitive::<IntervalMonthDayNanoType>()
            .iter()
            .flatten()
            .any(|v| v.nanoseconds % 1000 != 0)
    {
        return Err(Error::Unsupported(
            "A submicrosecond Arrow interval cannot be represented exactly.".into(),
        ));
    }
    for child in array.to_data().child_data() {
        precision(&make_array(child.clone()))?;
    }
    Ok(())
}

fn adapted(array: &ArrayRef, target: &DataType) -> Result<ArrayRef, Error> {
    if array.data_type() == target {
        precision(array)?;
        return Ok(array.clone());
    }
    // Compare dictionary values after decoding: their integer codes are container representation.
    let original = if let DataType::Dictionary(_, value) = array.data_type() {
        cast(array.as_ref(), value).map_err(|e| Error::Unsupported(e.to_string()))?
    } else {
        array.clone()
    };
    let out = cast(original.as_ref(), target).map_err(|e| Error::Unsupported(e.to_string()))?;
    precision(&out)?;
    let back =
        cast(out.as_ref(), original.data_type()).map_err(|e| Error::Unsupported(e.to_string()))?;
    if back.to_data() != original.to_data() {
        return Err(Error::Unsupported(
            "An Arrow query conversion would change a value or its precision.".into(),
        ));
    }
    Ok(out)
}

pub(super) fn open(
    path: &Path,
    kind: Kind,
    cancel: &dyn Fn() -> Result<(), Error>,
) -> Result<Engine, Error> {
    Engine::open_loaded(path, kind, &[], cancel, |loader| {
        cancel()?;
        let budget = crate::resource::Limits::default().max_bytes as u64;
        let limits = ipc::Limits {
            max_decoded_bytes: budget,
            ..ipc::Limits::default()
        };
        let source = ipc::open(path, &limits).map_err(error)?;
        cancel()?;
        // Codec snapshotting/schema parsing precedes these loader bounds and has its own limits.
        schema_depth(source.original_schema.as_ref())?;
        let fields = source
            .display_schema
            .fields()
            .iter()
            .map(|f| {
                Ok(f.as_ref()
                    .clone()
                    .with_data_type(query_type(f.data_type())?))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        if fields.is_empty() {
            return Err(Error::Unsupported(
                "An Arrow source with no columns is not queryable.".into(),
            ));
        }
        let schema = Arc::new(Schema::new(fields));
        let width = schema
            .fields()
            .iter()
            .fold(0u64, |n, f| n.saturating_add(row_width(f.data_type())));
        if source.rows.saturating_mul(width) > budget {
            return Err(resource_limit());
        }
        let name = path
            .file_stem()
            .ok_or_else(|| Error::Invalid("No Arrow table name.".into()))?
            .to_string_lossy();
        let definition = schema
            .fields()
            .iter()
            .map(|f| Ok(format!("{} {}", quote_ident(f.name()), sql_field(f)?)))
            .collect::<Result<Vec<_>, Error>>()?
            .join(",");
        loader.conn().execute_batch(&format!(
            "create table {} ({definition})",
            quote_ident(&name)
        ))?;
        let mut appender = loader.conn().appender(&name)?;
        let mut decoded = 0u64;
        for batch in source.batches().map_err(error)? {
            cancel()?;
            let raw = batch.map_err(error)?;
            let estimate = raw
                .columns()
                .iter()
                .zip(schema.fields())
                .fold(0u64, |n, (array, field)| {
                    n.saturating_add(projected(array, field.data_type()))
                })
                .max(raw.get_array_memory_size() as u64);
            if estimate > budget.saturating_sub(decoded) {
                return Err(resource_limit());
            }
            let batch = source.display_batch(&raw).map_err(error)?;
            let columns = batch
                .columns()
                .iter()
                .zip(schema.fields())
                .map(|(a, f)| adapted(a, f.data_type()))
                .collect::<Result<Vec<_>, Error>>()?;
            let batch = RecordBatch::try_new(schema.clone(), columns)
                .map_err(|e| Error::Engine(e.to_string()))?;
            let held = estimate
                .max(raw.get_array_memory_size() as u64)
                .max(batch.get_array_memory_size() as u64);
            decoded = decoded
                .checked_add(held)
                .filter(|n| *n <= budget)
                .ok_or_else(resource_limit)?;
            for start in (0..batch.num_rows()).step_by(1024) {
                cancel()?;
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    appender.append_record_batch(
                        batch.slice(start, (batch.num_rows() - start).min(1024)),
                    )
                }))
                .map_err(|_| {
                    Error::Engine("Arrow values disagree with their query schema.".into())
                })??;
            }
        }
        appender.flush()?;
        cancel()
    })
}
