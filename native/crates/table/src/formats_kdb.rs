//! The accepted kdb decoder feeds a private query catalog; the source is never rewritten.
use dfv_table_duckdb::{Engine, Error, Kind, TableLoad, TimeUnit, Value as Dv};
use dfv_table_kdb::{KdbError, Limits, Value, parse_kdb_file, table_name};
use serde_json::{Value as Json, json};
use std::path::Path;

fn error(e: KdbError) -> Error {
    match e {
        KdbError::FileTooLarge { .. }
        | KdbError::TooManyValues { .. }
        | KdbError::TooDeep { .. } => Error::TooLarge(e.to_string()),
        KdbError::Compressed | KdbError::UnsupportedAtom(_) | KdbError::UnsupportedObject(_) => {
            Error::Unsupported(e.to_string())
        }
        _ => Error::Engine(e.to_string()),
    }
}

fn sql_type(t: i8) -> &'static str {
    match t {
        1 => "BOOLEAN",
        4 => "UTINYINT",
        5 => "SMALLINT",
        6 => "INTEGER",
        7 | 16 => "BIGINT",
        8 => "REAL",
        9 => "DOUBLE",
        12 | 15 => "TIMESTAMP",
        13 | 14 => "DATE",
        17..=19 => "TIME",
        _ => "VARCHAR",
    }
}

fn nested(v: &Value) -> Result<Json, Error> {
    Ok(match v {
        Value::List(items) => Json::Array(items.iter().map(nested).collect::<Result<_, _>>()?),
        Value::Dict { keys, values } => json!({"keys":nested(keys)?,"values":nested(values)?}),
        other => dfv_table_duckdb::value::to_json(cell(other)?),
    })
}

fn cell(v: &Value) -> Result<Dv, Error> {
    Ok(match v {
        Value::Null => Dv::Null,
        Value::Bool(b) => Dv::Boolean(*b),
        Value::Byte(n) => Dv::UTinyInt(*n),
        Value::Short(n) => Dv::SmallInt(*n),
        Value::Int(n) => Dv::Int(*n),
        Value::Long(n) | Value::TimespanNanos(n) => Dv::BigInt(*n),
        Value::Real(n) => Dv::Float(*n),
        Value::Float(n) => Dv::Double(*n),
        Value::TimestampMicros(n) | Value::DatetimeMicros(n) => {
            Dv::Timestamp(TimeUnit::Microsecond, *n)
        }
        Value::MonthDays(n) | Value::DateDays(n) => {
            // shortcut: out-of-range dates refuse; add a lossless text profile before widening.
            Dv::Date32(i32::try_from(*n).map_err(|_| {
                Error::Unsupported("A kdb date exceeds this query engine's date range.".into())
            })?)
        }
        Value::MinuteMicros(n) | Value::SecondMicros(n) | Value::TimeMicros(n) => {
            Dv::Time64(TimeUnit::Microsecond, *n)
        }
        Value::Char(c) => Dv::Text(c.to_string()),
        Value::Symbol(s) | Value::Guid(s) => Dv::Text(s.clone()),
        Value::List(_) | Value::Dict { .. } => Dv::Text(nested(v)?.to_string()),
    })
}

pub(super) fn open(path: &Path, cancel: &dyn Fn() -> Result<(), Error>) -> Result<Engine, Error> {
    Engine::open_loaded(path, Kind::Kdb, &[], cancel, |loader| {
        cancel()?;
        let table = parse_kdb_file(path, Limits::default()).map_err(error)?;
        cancel()?;
        let name = table_name(path).ok_or_else(|| Error::Invalid("No kdb table name.".into()))?;
        let columns = table
            .columns
            .iter()
            .map(|c| (c.name.clone(), sql_type(c.q_type).to_owned()))
            .collect();
        let rows = (0..table.row_count)
            .map(|r| table.columns.iter().map(|c| cell(&c.values[r])).collect());
        loader.table(
            TableLoad {
                name,
                columns,
                rows: Box::new(rows),
            },
            false,
        )
    })
}
