//! `buildDetectedTableQuery`'s SQL: filters, sort and limit over one detected table. Ports
//! `DuckDbFile.buildDetectedTableQuery`, `filterValueForType` and `validateTableFilters`.
use crate::{ErrKind, OpsError};
use dfv_table_duckdb::duckdb::{quote_ident, quote_literal};
use dfv_table_duckdb::locale::both_readings;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

const MAX_FILTERS: usize = 100;
const MAX_TEXT: usize = 4000;
const MAX_LIMIT: u64 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Contains,
    Equals,
    NotEquals,
    Gt,
    Gte,
    Lt,
    Lte,
    Between,
    IsBlank,
    IsNotBlank,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filter {
    pub column: String,
    pub op: Op,
    pub value: String,
    pub value_to: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sort {
    pub column: String,
    pub desc: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Request {
    pub filters: Vec<Filter>,
    pub sort: Option<Sort>,
    pub limit: u64,
}

fn invalid() -> OpsError {
    OpsError::new(ErrKind::Invalid, "Invalid or oversized query request.")
}

fn text(v: &Value, max: usize) -> Result<&str, OpsError> {
    v.as_str()
        .filter(|s| s.chars().count() <= max)
        .ok_or_else(invalid)
}

impl Request {
    /// `validateTableFilters`: closed key sets, closed operators, bounded sizes. Anything else is refused
    /// before a table is looked up.
    pub fn from_args(args: &Map<String, Value>) -> Result<Self, OpsError> {
        let limit = match args.get("limit") {
            None => 0,
            // Counts cross the wire as uint64 text.
            Some(v) => v
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .or_else(|| v.as_u64())
                .filter(|n| *n <= MAX_LIMIT)
                .ok_or_else(invalid)?,
        };
        let mut filters = vec![];
        match args.get("filters") {
            None => {}
            Some(Value::Array(list)) if list.len() <= MAX_FILTERS => {
                for item in list {
                    let o = item.as_object().ok_or_else(invalid)?;
                    if o.keys().any(|k| {
                        !["column", "operator", "value", "value_to", "valueTo"]
                            .contains(&k.as_str())
                    }) {
                        return Err(invalid());
                    }
                    let op = match text(o.get("operator").ok_or_else(invalid)?, 80)? {
                        "contains" => Op::Contains,
                        "equals" => Op::Equals,
                        "notEquals" => Op::NotEquals,
                        "gt" => Op::Gt,
                        "gte" => Op::Gte,
                        "lt" => Op::Lt,
                        "lte" => Op::Lte,
                        "between" => Op::Between,
                        "isBlank" => Op::IsBlank,
                        "isNotBlank" => Op::IsNotBlank,
                        _ => return Err(invalid()),
                    };
                    let opt = |key: &str| -> Result<String, OpsError> {
                        o.get(key)
                            .map_or(Ok(String::new()), |v| text(v, MAX_TEXT).map(str::to_owned))
                    };
                    filters.push(Filter {
                        column: text(o.get("column").ok_or_else(invalid)?, MAX_TEXT)?.to_owned(),
                        op,
                        value: opt("value")?,
                        value_to: if o.contains_key("valueTo") {
                            opt("valueTo")?
                        } else {
                            opt("value_to")?
                        },
                    });
                }
            }
            Some(_) => return Err(invalid()),
        }
        let sort = match args.get("sort") {
            None | Some(Value::Null) => None,
            Some(Value::Object(o)) => {
                if o.keys().any(|k| k != "column" && k != "direction") {
                    return Err(invalid());
                }
                let desc = match text(o.get("direction").ok_or_else(invalid)?, 8)? {
                    "asc" => false,
                    "desc" => true,
                    _ => return Err(invalid()),
                };
                Some(Sort {
                    column: text(o.get("column").ok_or_else(invalid)?, MAX_TEXT)?.to_owned(),
                    desc,
                })
            }
            Some(_) => return Err(invalid()),
        };
        Ok(Self {
            filters,
            sort,
            limit,
        })
    }
}

static NUMERIC_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:u?(?:tiny|small|big|huge)?int|integer|decimal|numeric|double|float|real)")
        .expect("regex")
});
static TEMPORAL_TYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:date$|timestamp|time$)").expect("regex"));
// shortcut: only ISO-style dates are accepted (JS Date.parse takes more, but DuckDB's cast would refuse
// those anyway); widen if the filter box ever needs locale dates.
static ISO_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\s*$")
        .expect("regex")
});

/// A filter value checked against the column it is compared to, in the one spelling DuckDB accepts.
fn value_for_type(value: &str, sql_type: &str, column: &str) -> Result<String, OpsError> {
    if NUMERIC_TYPE.is_match(sql_type) {
        let (en, eu) = both_readings(value);
        return en.or(eu).map(|n| n.to_string()).ok_or_else(|| {
            OpsError::new(
                ErrKind::Invalid,
                format!("\"{value}\" is not a number, so {column} cannot be compared to it."),
            )
        });
    }
    if TEMPORAL_TYPE.is_match(sql_type) && !ISO_DATE.is_match(value) {
        return Err(OpsError::new(
            ErrKind::Invalid,
            format!("\"{value}\" is not a date, so {column} cannot be compared to it."),
        ));
    }
    Ok(value.to_owned())
}

/// The statement for `table` given its column types (`name -> DuckDB type`).
pub fn build_sql(
    table: &str,
    types: &HashMap<String, String>,
    req: &Request,
) -> Result<String, OpsError> {
    let missing = |c: &str| {
        OpsError::new(
            ErrKind::Invalid,
            format!("Column \"{c}\" does not exist in \"{table}\"."),
        )
    };
    let mut predicates: Vec<String> = vec![];
    for f in &req.filters {
        let sql_type = types.get(&f.column).ok_or_else(|| missing(&f.column))?;
        let col = quote_ident(&f.column);
        let typed = |v: &str| -> Result<String, OpsError> {
            Ok(format!(
                "cast_to_type({}, {col})",
                quote_literal(&value_for_type(v, sql_type, &f.column)?)
            ))
        };
        match f.op {
            Op::Contains if !f.value.is_empty() => predicates.push(format!(
                "contains(lower(cast({col} as varchar)), lower({}))",
                quote_literal(&f.value)
            )),
            Op::Equals if !f.value.is_empty() => {
                predicates.push(format!("{col} = {}", typed(&f.value)?))
            }
            Op::NotEquals if !f.value.is_empty() => {
                predicates.push(format!("{col} <> {}", typed(&f.value)?))
            }
            Op::Gt | Op::Gte | Op::Lt | Op::Lte if !f.value.is_empty() => {
                let sign = match f.op {
                    Op::Gt => ">",
                    Op::Gte => ">=",
                    Op::Lt => "<",
                    _ => "<=",
                };
                predicates.push(format!("{col} {sign} {}", typed(&f.value)?));
            }
            Op::Between if !f.value.is_empty() && !f.value_to.is_empty() => {
                predicates.push(format!(
                    "{col} between {} and {}",
                    typed(&f.value)?,
                    typed(&f.value_to)?
                ))
            }
            Op::IsBlank => predicates.push(format!(
                "({col} is null or trim(cast({col} as varchar)) = '')"
            )),
            Op::IsNotBlank => {
                predicates.push(format!(
                    "({col} is not null and trim(cast({col} as varchar)) <> '')"
                ));
            }
            _ => {}
        }
    }
    let mut sql = format!("select * from {}", quote_ident(table));
    if !predicates.is_empty() {
        sql.push_str(&format!(" where {}", predicates.join(" and ")));
    }
    if let Some(sort) = &req.sort {
        if !types.contains_key(&sort.column) {
            return Err(missing(&sort.column));
        }
        sql.push_str(&format!(
            " order by {} {} nulls last",
            quote_ident(&sort.column),
            if sort.desc { "desc" } else { "asc" }
        ));
    }
    if req.limit > 0 {
        sql.push_str(&format!(" limit {}", req.limit));
    }
    Ok(sql)
}
