//! Typed, paged Stata reads. Calendar formats become SQL temporal values in a private catalog.
use ::dta::stata::dta::variable_type::VariableType;
use dfv_table_dta::{self as dta, Cell};
use dfv_table_duckdb::{Engine, Error, Kind, TableLoad, Value, duckdb::quote_ident};
use std::path::Path;

#[derive(Clone, Copy)]
enum Profile {
    Storage(VariableType),
    Day,
    Clock,
    Period(char),
}
fn error(e: dta::Error) -> Error {
    match e {
        dta::Error::Unsupported(_) => Error::Unsupported(e.to_string()),
        dta::Error::TooLarge(_) => Error::TooLarge(e.to_string()),
        _ => Error::Engine(e.to_string()),
    }
}
fn profile(format: &str, storage: VariableType) -> Result<Profile, Error> {
    if !format.starts_with("%t") {
        return Ok(Profile::Storage(storage));
    }
    Ok(match format.as_bytes().get(2).copied() {
        Some(b'd') => Profile::Day,
        Some(b'c') => Profile::Clock,
        Some(c @ (b'w' | b'm' | b'q' | b'h' | b'y')) => Profile::Period(char::from(c)),
        _ => {
            return Err(Error::Unsupported(format!(
                "Stata temporal format {format} needs a calendar-aware conversion that this worker does not provide."
            )));
        }
    })
}
fn sql_type(profile: Profile) -> &'static str {
    match profile {
        Profile::Storage(VariableType::Byte) => "TINYINT",
        Profile::Storage(VariableType::Int) => "SMALLINT",
        Profile::Storage(VariableType::Long) => "INTEGER",
        Profile::Storage(VariableType::Float) => "REAL",
        Profile::Storage(VariableType::Double) => "DOUBLE",
        Profile::Storage(VariableType::FixedString(_) | VariableType::LongString) => "VARCHAR",
        _ => "BIGINT",
    }
}
fn integer(cell: &Cell) -> Result<i64, Error> {
    match cell {
        Cell::Integer(n) => Ok(*n),
        Cell::Float(n)
            if n.is_finite()
                && n.fract() == 0.0
                && *n >= i64::MIN as f64
                && *n < i64::MAX as f64 =>
        {
            Ok(*n as i64)
        }
        _ => Err(Error::Unsupported(
            "A Stata calendar value must be an exact whole number in range.".into(),
        )),
    }
}
fn clock(cell: &Cell) -> Result<i64, Error> {
    // Integer milliseconds are multiplied as integers so large timestamps never round through f64.
    let micros = match cell {
        Cell::Integer(_) => integer(cell)?.checked_mul(1000),
        Cell::Float(n) if n.fract() == 0.0 => integer(cell)?.checked_mul(1000),
        Cell::Float(n) => {
            let scaled = n * 1000.0;
            (scaled.is_finite()
                && scaled.fract() == 0.0
                && scaled >= i64::MIN as f64
                && scaled < i64::MAX as f64
                && (scaled as i64) as f64 / 1000.0 == *n)
                .then_some(scaled as i64)
        }
        _ => None,
    };
    micros
        .and_then(|n| n.checked_sub(315_619_200_000_000))
        .ok_or_else(|| {
            Error::Unsupported(
                "A Stata timestamp exceeds the exact microsecond query range.".into(),
            )
        })
}
fn cell(cell: Cell, profile: Profile) -> Result<Value, Error> {
    if matches!(cell, Cell::Missing(_)) {
        return Ok(Value::Null);
    }
    Ok(match profile {
        Profile::Day | Profile::Period(_) => Value::BigInt(integer(&cell)?),
        Profile::Clock => Value::BigInt(clock(&cell)?),
        Profile::Storage(storage) => match (cell,storage) {
            (Cell::Integer(n),VariableType::Byte) => Value::TinyInt(i8::try_from(n).map_err(|_|Error::Engine("Invalid Stata byte.".into()))?),
            (Cell::Integer(n),VariableType::Int) => Value::SmallInt(i16::try_from(n).map_err(|_|Error::Engine("Invalid Stata int.".into()))?),
            (Cell::Integer(n),VariableType::Long) => Value::Int(i32::try_from(n).map_err(|_|Error::Engine("Invalid Stata long.".into()))?),
            (Cell::Float(n),VariableType::Float) => Value::Float(n as f32),
            (Cell::Float(n),VariableType::Double) => Value::Double(n),
            (Cell::Text(s),VariableType::FixedString(_) | VariableType::LongString) => Value::Text(s),
            (Cell::Binary(_),_) => return Err(Error::Unsupported("Binary Stata strL values need a binary query profile; no text conversion was applied.".into())),
            _ => return Err(Error::Engine("A Stata value disagrees with its declared storage type.".into())),
        },
    })
}

struct Rows<'a> {
    source: &'a dta::Source,
    profiles: &'a [Profile],
    next: u64,
    page_size: usize,
    page: std::vec::IntoIter<Vec<Cell>>,
    failed: bool,
}
impl Iterator for Rows<'_> {
    type Item = Result<Vec<Value>, Error>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed {
            return None;
        }
        if self.page.len() == 0 {
            if self.next >= self.source.header.observation_count() {
                return None;
            }
            let expected = (self.source.header.observation_count() - self.next)
                .min(self.page_size as u64) as usize;
            match self.source.read_rows(self.next, self.page_size) {
                Ok(page) if page.len() != expected => {
                    self.failed = true;
                    return Some(Err(Error::Engine(
                        "A Stata page ended before its declared row count.".into(),
                    )));
                }
                Ok(page) => {
                    self.next += page.len() as u64;
                    self.page = page.into_iter();
                }
                Err(e) => {
                    self.failed = true;
                    return Some(Err(error(e)));
                }
            }
        }
        self.page.next().map(|row| {
            row.into_iter()
                .zip(self.profiles)
                .map(|(v, p)| cell(v, *p))
                .collect()
        })
    }
}

fn temporal_sql(column: &str, profile: Profile) -> Option<(&'static str, String)> {
    let n = quote_ident(column);
    let period =
        |months: i64| format!("cast(date '1960-01-01' + to_months({n} * {months}) as date)");
    Some(match profile {
        Profile::Day => ("DATE", format!("date '1960-01-01' + cast({n} as integer)")),
        Profile::Clock => ("TIMESTAMP", format!("make_timestamp({n})")),
        Profile::Period('m') => ("DATE", period(1)),
        Profile::Period('q') => ("DATE", period(3)),
        Profile::Period('h') => ("DATE", period(6)),
        Profile::Period('y') => ("DATE", format!("make_date({n},1,1)")),
        Profile::Period('w') => {
            // Stata has 52 weeks in every year; its last week includes the year's remaining days.
            let week = format!("(({n} % 52 + 52) % 52)");
            (
                "DATE",
                format!("make_date(1960+({n}-{week})//52,1,1)+cast({week}*7 as integer)"),
            )
        }
        _ => return None,
    })
}

pub(super) fn open(path: &Path, cancel: &dyn Fn() -> Result<(), Error>) -> Result<Engine, Error> {
    Engine::open_loaded(path, Kind::Dta, &[], cancel, |loader| {
        cancel()?;
        let limits = dta::Limits::default();
        let source = dta::open(path, &limits).map_err(error)?;
        cancel()?;
        let profiles = source
            .schema
            .variables()
            .iter()
            .map(|v| profile(v.format(), v.variable_type()))
            .collect::<Result<Vec<_>, _>>()?;
        let columns = source
            .schema
            .variables()
            .iter()
            .zip(&profiles)
            .map(|(v, p)| (v.name().to_owned(), sql_type(*p).to_owned()))
            .collect();
        let name = path
            .file_stem()
            .ok_or_else(|| Error::Invalid("No Stata table name.".into()))?
            .to_string_lossy()
            .into_owned();
        let rows = Rows {
            source: &source,
            profiles: &profiles,
            next: 0,
            page_size: 1024.min(limits.page_cells / profiles.len().max(1)).max(1),
            page: Vec::new().into_iter(),
            failed: false,
        };
        loader.table(
            TableLoad {
                name: name.clone(),
                columns,
                rows: Box::new(rows),
            },
            false,
        )?;
        for (variable, profile) in source.schema.variables().iter().zip(profiles) {
            cancel()?;
            if let Some((kind, expression)) = temporal_sql(variable.name(), profile) {
                loader.conn().execute_batch(&format!(
                    "alter table {} alter column {} type {kind} using {expression}",
                    quote_ident(&name),
                    quote_ident(variable.name())
                ))?;
            }
        }
        cancel()
    })
}
