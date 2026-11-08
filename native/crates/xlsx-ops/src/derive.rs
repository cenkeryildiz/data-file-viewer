//! Typed in-memory tables made from a parsed worksheet: the raw sheet (every cell as text, A1-anchored)
//! and one detected table (typed per column from the cells' own kinds). The workbook is never written.
use crate::{ErrKind, OpsError};
use dfv_table_duckdb::duckdb::quote_ident;
use dfv_table_duckdb::locale::{NumberLocale, js_trim, parse_en, parse_eu};
use dfv_table_duckdb::text::{TextColumnVerdict, classify_text_column, is_excel_error};
use dfv_table_xlsx::sheet_tables::{RowSpan, SheetTable};
use dfv_table_xlsx::xlsx_read::{Sheet, Style, Value as XValue, XlCell};
use duckdb::Connection;
use duckdb::types::{TimeUnit, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColType {
    Double,
    Timestamp,
    Boolean,
    Varchar,
}
impl ColType {
    fn sql(self) -> &'static str {
        match self {
            Self::Double => "DOUBLE",
            Self::Timestamp => "TIMESTAMP",
            Self::Boolean => "BOOLEAN",
            Self::Varchar => "VARCHAR",
        }
    }
}

/// A column's type, whether markers read as empty beside it, and how its text-stored numbers are written.
type Kind = (ColType, bool, NumberLocale);

/// One cell as a typed read sees it.
enum Seen {
    /// Absent, or text that is empty / whitespace (`Some` keeps non-empty whitespace for a text column).
    Blank(Option<String>),
    /// An Excel error (`#DIV/0!`): read as empty, as the reference's `ignore_errors` read does.
    Error,
    /// Text that is one of the `nullText` markers.
    Marker(String),
    Num(f64),
    Date(i64),
    Bool(bool),
    Text,
}

pub(crate) struct Typer<'a> {
    pub sheet: &'a Sheet,
    pub styles: &'a [Style],
    pub date1904: bool,
    pub null_text: &'a [String],
}

/// Excel serial -> microseconds; serial 60 repeats February 28 (Excel's fictitious leap day).
fn serial_micros(serial: f64, date1904: bool) -> Option<i64> {
    let days = if date1904 {
        serial + 1462.0
    } else if serial < 60.0 {
        serial + 1.0
    } else {
        serial
    };
    let micros = ((days - 25_569.0) * 86_400_000_000.0).round();
    (micros.is_finite() && micros.abs() < 9.0e18).then_some(micros as i64)
}

fn create(db: &Connection, name: &str, columns: &[(String, &str)]) -> Result<(), OpsError> {
    let defs: Vec<String> = columns
        .iter()
        .map(|(n, t)| format!("{} {t}", quote_ident(n)))
        .collect();
    db.execute_batch(&format!(
        "create table {} ({})",
        quote_ident(name),
        defs.join(", ")
    ))
    .map_err(OpsError::from)
}

fn fill(
    db: &Connection,
    name: &str,
    rows: impl Iterator<Item = Vec<Value>>,
) -> Result<(), OpsError> {
    let mut appender = db.appender(name).map_err(OpsError::from)?;
    for row in rows {
        appender
            .append_row(duckdb::appender_params_from_iter(row))
            .map_err(OpsError::from)?;
    }
    appender.flush().map_err(OpsError::from)
}

/// The sheet verbatim: `A`, `B`, ... columns, all text, row n is Excel row n.
pub(crate) fn create_raw(
    db: &Connection,
    name: &str,
    grid: &[Vec<Option<String>>],
    rows: usize,
    cols: usize,
) -> Result<(), OpsError> {
    let cols = cols.max(1);
    let columns: Vec<(String, &str)> = (0..cols)
        .map(|c| {
            (
                dfv_table_xlsx::xlsx_read::column_letters(c as u32),
                "VARCHAR",
            )
        })
        .collect();
    let drop_partial = |e: OpsError| {
        let _ = db.execute_batch(&format!("drop table if exists {}", quote_ident(name)));
        e
    };
    create(db, name, &columns)?;
    fill(
        db,
        name,
        grid.iter().take(rows).map(|row| {
            (0..cols)
                .map(|c| {
                    row.get(c)
                        .cloned()
                        .flatten()
                        .map_or(Value::Null, Value::Text)
                })
                .collect()
        }),
    )
    .map_err(drop_partial)
}

impl Typer<'_> {
    fn classify(&self, cell: Option<&XlCell>) -> Seen {
        let Some(cell) = cell else {
            return Seen::Blank(None);
        };
        // A formula with no cached result is an empty cell, as the text grid reads it.
        if cell.formula.is_some() && cell.value == XValue::Text(String::new()) {
            return Seen::Blank(None);
        }
        match &cell.value {
            XValue::Error(_) => Seen::Error,
            XValue::Text(s) if js_trim(s).is_empty() => {
                Seen::Blank((!s.is_empty()).then(|| s.clone()))
            }
            XValue::Text(s) if is_excel_error(s, self.null_text) => Seen::Marker(s.clone()),
            XValue::Text(_) => Seen::Text,
            XValue::Bool(b) => Seen::Bool(*b),
            XValue::Number(s) => match s.parse::<f64>().ok().filter(|f| f.is_finite()) {
                None => Seen::Text,
                Some(f)
                    if self
                        .styles
                        .get(cell.style as usize)
                        .is_some_and(|st| st.is_date) =>
                {
                    serial_micros(f, self.date1904).map_or(Seen::Text, Seen::Date)
                }
                Some(f) => Seen::Num(f),
            },
        }
    }

    fn cell(&self, row: usize, col: usize) -> Option<&XlCell> {
        self.sheet
            .cells
            .get(&(u32::try_from(row).ok()?, u32::try_from(col).ok()?))
    }

    /// Per column: the one type every value fits, else text that keeps every cell exactly. Markers
    /// become empty only beside values of a single type; in a text column they are values.
    /// A column of numbers with some stored as text (`3.03e-09` typed in as text) is numeric: it converts only
    /// when it holds real numbers too and every text cell parses. A column that is all text stays text, since
    /// it may be identifiers such as `007`.
    fn column_types(&self, table: &SheetTable) -> Vec<Kind> {
        (table.region.left..table.region.right)
            .map(|col| {
                let (mut num, mut date, mut boolean, mut text) = (false, false, false, false);
                let mut texts: Vec<Option<String>> = vec![];
                for span in &table.data_rows {
                    for row in span.start..span.end {
                        match self.classify(self.cell(row, col)) {
                            Seen::Num(_) => num = true,
                            Seen::Date(_) => date = true,
                            Seen::Bool(_) => boolean = true,
                            Seen::Text => {
                                text = true;
                                if let Some(XlCell {
                                    value: XValue::Text(s),
                                    ..
                                }) = self.cell(row, col)
                                {
                                    texts.push(Some(s.clone()));
                                }
                            }
                            Seen::Blank(Some(_)) => {}
                            Seen::Blank(None) | Seen::Error | Seen::Marker(_) => {}
                        }
                    }
                }
                let en = NumberLocale::En;
                if num
                    && text
                    && !date
                    && !boolean
                    && let TextColumnVerdict::Numeric { locale, .. } =
                        classify_text_column(&texts, self.null_text)
                {
                    return (ColType::Double, true, locale);
                }
                match (num, date, boolean, text) {
                    (true, false, false, false) => (ColType::Double, true, en),
                    (false, true, false, false) => (ColType::Timestamp, true, en),
                    (false, false, true, false) => (ColType::Boolean, true, en),
                    (false, false, false, text) => (ColType::Varchar, !text, en),
                    _ => (ColType::Varchar, false, en),
                }
            })
            .collect()
    }

    fn value(&self, row: usize, col: usize, kind: Kind) -> Value {
        let cell = self.cell(row, col);
        match (self.classify(cell), kind.0) {
            (Seen::Error | Seen::Blank(None), _) => Value::Null,
            (Seen::Marker(_), _) if kind.1 => Value::Null,
            (Seen::Marker(s), _) => Value::Text(s),
            (Seen::Num(f), ColType::Double) => Value::Double(f),
            (Seen::Date(m), ColType::Timestamp) => Value::Timestamp(TimeUnit::Microsecond, m),
            (Seen::Bool(b), ColType::Boolean) => Value::Boolean(b),
            (Seen::Text, ColType::Double) => {
                let parse = if kind.2 == NumberLocale::En {
                    parse_en
                } else {
                    parse_eu
                };
                cell.and_then(|c| parse(&c.text()))
                    .map_or(Value::Null, Value::Double)
            }
            (Seen::Blank(_), t) if t != ColType::Varchar => Value::Null,
            // Text columns keep each cell exactly as the file holds it.
            (_, ColType::Varchar) => cell.map_or(Value::Null, |c| Value::Text(c.text())),
            _ => Value::Null,
        }
    }

    /// Create `name` as the typed table for `table`; `names` are its (unique) column names.
    pub(crate) fn create_table(
        &self,
        db: &Connection,
        name: &str,
        table: &SheetTable,
        names: &[String],
    ) -> Result<usize, OpsError> {
        let kinds = self.column_types(table);
        let columns: Vec<(String, &str)> = names
            .iter()
            .cloned()
            .zip(kinds.iter().map(|k| k.0.sql()))
            .collect();
        create(db, name, &columns)?;
        let rows = table
            .data_rows
            .iter()
            .flat_map(|RowSpan { start, end }| *start..*end)
            .map(|row| {
                kinds
                    .iter()
                    .enumerate()
                    .map(|(i, kind)| self.value(row, table.region.left + i, *kind))
                    .collect::<Vec<_>>()
            });
        fill(db, name, rows).inspect_err(|_| {
            let _ = db.execute_batch(&format!("drop table if exists {}", quote_ident(name)));
        })?;
        Ok(self.converted_text_cells(table, &kinds))
    }

    /// How many text cells were read as numbers in the numeric columns that hold some.
    fn converted_text_cells(&self, table: &SheetTable, kinds: &[Kind]) -> usize {
        kinds
            .iter()
            .enumerate()
            .filter(|(_, k)| k.0 == ColType::Double)
            .map(|(i, _)| {
                table
                    .data_rows
                    .iter()
                    .flat_map(|RowSpan { start, end }| *start..*end)
                    .filter(|&row| {
                        matches!(
                            self.classify(self.cell(row, table.region.left + i)),
                            Seen::Text
                        )
                    })
                    .count()
            })
            .sum()
    }
}

impl From<duckdb::Error> for OpsError {
    fn from(e: duckdb::Error) -> Self {
        let text = e.to_string();
        let kind = if text.contains("INTERRUPT") {
            ErrKind::Interrupted
        } else {
            ErrKind::Engine
        };
        OpsError::new(kind, text)
    }
}
