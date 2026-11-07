//! Catalog, paged and sorted reads, counts, statistics and chart reads (`DuckDbFile.runQuery` and friends).
//! User SQL is authorised once by the parser-backed policy; every derived statement (sort, count, stats,
//! chart) wraps that same text and is generated here, never taken from the caller.
use crate::duckdb::{Engine, Error, quote_ident, quote_literal};
use dfv_table_policy::{
    PolicyError, QUERY_LIMITS, Refusal, inspection_sql, validate_result_size, validate_sql_size,
};
use duckdb::arrow::datatypes::DataType;
use regex::Regex;
use serde_json::{Value as J, json};
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatsKind {
    Numeric,
    Datetime,
    Other,
}
impl StatsKind {
    fn of(t: &DataType) -> Self {
        use DataType::*;
        match t {
            Int8 | Int16 | Int32 | Int64 | UInt8 | UInt16 | UInt32 | UInt64 | Float16 | Float32
            | Float64 | Decimal128(..) | Decimal256(..) => Self::Numeric,
            Date32 | Date64 | Time32(_) | Time64(_) | Timestamp(..) | Interval(_) => Self::Datetime,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<J>>,
    pub column_stats_kind: Vec<StatsKind>,
    /// Set when a `max_rows` cap actually cut the result short.
    pub truncated: bool,
}

/// Query results for the exact native protocol, independent of the display JSON API.
#[derive(Debug, Clone, PartialEq)]
pub struct WireQueryResult {
    pub columns: Vec<J>,
    pub rows: Vec<Vec<J>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogRelation {
    pub catalog: String,
    pub schema: String,
    pub name: String,
    pub sql_name: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    pub data_type: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct TopValues {
    pub total_rows: i64,
    pub non_null_rows: i64,
    pub null_count: i64,
    pub distinct_count: i64,
    pub top_values: Vec<(J, i64)>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct DescriptiveStats {
    pub total_rows: i64,
    pub non_null_rows: i64,
    pub null_count: i64,
    pub min: J,
    pub max: J,
    pub mean: J,
    pub p5: J,
    pub p95: J,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Asc,
    Desc,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XAxis {
    Time,
    Category,
}

#[derive(Debug, Clone, Copy)]
pub enum ChartAxis {
    Automatic { text: bool, category: bool },
    Rows,
    Dates,
}

/// How many non-null values a chart samples before deciding a text column can be a time axis, and how
/// many of them have to parse.
const TEXT_AXIS_PROBE_ROWS: usize = 5000;
const TEXT_AXIS_MIN_PARSE_RATE: f64 = 0.95;

pub fn strip_trailing_semicolon(sql: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r";\s*$").unwrap());
    RE.replace(sql.trim(), "").into_owned()
}
/// The newlines are load-bearing: a closing `)` on a line ending in `--` would be part of the comment.
pub fn wrap_as_subquery(sql: &str) -> String {
    format!("(\n{sql}\n)")
}
// `$`-anchored so only the outermost final LIMIT matches; a LIMIT nested in a subquery is left alone.
static TRAILING_LIMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s+limit\s+[0-9]+(?:\s+offset\s+[0-9]+)?\s*;?\s*$").unwrap());
pub fn has_trailing_limit(sql: &str) -> bool {
    TRAILING_LIMIT.is_match(sql)
}
/// `(without the limit, the limit clause)`.
fn extract_trailing_limit(sql: &str) -> Option<(String, String)> {
    let m = TRAILING_LIMIT.find(sql)?;
    let clause = m
        .as_str()
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    Some((sql[..m.start()].to_owned(), clause.to_owned()))
}

/// One value as display JSON, or as an exact wire value of its own logical type.
fn cell(
    value: duckdb::types::Value,
    logical: &duckdb::core::LogicalTypeHandle,
    wire: bool,
) -> Result<J, Error> {
    if wire {
        return crate::value::to_wire(value, &crate::value::wire_type(logical)?);
    }
    let utc = matches!(logical.id(), duckdb::core::LogicalTypeId::TimestampTZ);
    Ok(crate::value::to_json_with_timezone(value, utc))
}

fn int(v: &J) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .or_else(|| v["v"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

impl Engine {
    pub fn list_tables(&self) -> Result<Vec<String>, Error> {
        let mut stmt = self.conn.prepare(
            "select table_name from information_schema.tables where table_catalog = system.main.current_database() order by table_name",
        )?;
        Ok(stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?)
    }

    /// One page (100) of the relations the query editor may offer.
    pub fn query_catalog(&self, offset: usize) -> Result<Vec<CatalogRelation>, Error> {
        if offset > 1_000_000 {
            return Err(Error::Invalid("Invalid catalog page.".into()));
        }
        let mut stmt = self.conn.prepare(&format!(
            "select table_catalog, table_schema, table_name from information_schema.tables \
             where table_catalog=system.main.current_database() order by table_schema, table_name limit 100 offset {offset}"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let page: Vec<CatalogRelation> = rows
            .map(|r| {
                let (catalog, schema, name) = r?;
                let sql_name = [&catalog, &schema, &name].map(|p| quote_ident(p)).join(".");
                Ok(CatalogRelation {
                    catalog,
                    schema,
                    name,
                    sql_name,
                })
            })
            .collect::<Result<_, Error>>()?;
        // The reference host refuses a catalog page over 1 MiB; hostile identifiers must not bypass it.
        let bytes = serde_json::to_vec(
            &page
                .iter()
                .map(|r| json!({"catalog":r.catalog,"schema":r.schema,"name":r.name,"sql_name":r.sql_name}))
                .collect::<Vec<_>>(),
        )
        .map_or(usize::MAX, |b| b.len());
        if bytes > QUERY_LIMITS.catalog_bytes {
            return Err(
                PolicyError::new(Refusal::ResultSize, "The catalog page exceeds 1 MiB.").into(),
            );
        }
        Ok(page)
    }

    pub fn query_columns(
        &self,
        catalog: &str,
        schema: &str,
        name: &str,
    ) -> Result<Vec<Column>, Error> {
        if catalog != self.catalog {
            return Err(Error::Invalid("Unknown query catalog.".into()));
        }
        let mut stmt = self.conn.prepare(&format!(
            "select column_name, data_type from information_schema.columns where table_catalog={} and table_schema={} \
             and table_name={} order by ordinal_position",
            quote_literal(catalog),
            quote_literal(schema),
            quote_literal(name)
        ))?;
        let columns: Vec<Column> = stmt
            .query_map([], |r| {
                Ok(Column {
                    name: r.get(0)?,
                    data_type: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let bytes = serde_json::to_vec(
            &columns
                .iter()
                .map(|c| json!({"name":c.name,"source_type":c.data_type}))
                .collect::<Vec<_>>(),
        )
        .map_or(usize::MAX, |b| b.len());
        if bytes > QUERY_LIMITS.catalog_bytes {
            return Err(
                PolicyError::new(Refusal::ResultSize, "The column list exceeds 1 MiB.").into(),
            );
        }
        Ok(columns)
    }

    /// Run user SQL: policy first, then the guarded execution. `max_rows == 0` means uncapped.
    pub fn run_query(&self, sql: &str, max_rows: usize) -> Result<QueryResult, Error> {
        validate_sql_size(sql)?;
        self.assert_read_sql(sql)?;
        self.guarded(|| self.run_query_once(sql, max_rows))
    }

    pub fn run_query_wire(&self, sql: &str, max_rows: usize) -> Result<WireQueryResult, Error> {
        validate_sql_size(sql)?;
        self.assert_read_sql(sql)?;
        self.guarded(|| self.wire_once(sql, max_rows))
    }

    /// Execute already-authorised SQL. Capped reads fetch one row past the cap, which is what tells
    /// "exactly max_rows rows exist" from "there were more", and ask DuckDB for no more than that.
    fn run_query_once(&self, sql: &str, max_rows: usize) -> Result<QueryResult, Error> {
        self.read_query_once(sql, max_rows, false)
            .map(|(result, _)| result)
    }

    fn read_query_once(
        &self,
        sql: &str,
        max_rows: usize,
        wire: bool,
    ) -> Result<(QueryResult, Vec<J>), Error> {
        // shortcut: explain/describe/summarize cannot be a subquery, so they run uncapped (their results
        // are small); upgrade to the streaming API if a capped inspection of a huge result is needed.
        let capped = max_rows > 0 && inspection_sql(sql) == sql;
        let text = if capped {
            format!(
                "select * from {} as _capped limit {}",
                wrap_as_subquery(&strip_trailing_semicolon(sql)),
                max_rows
                    .checked_add(1)
                    .ok_or_else(|| Error::Invalid("The row limit is too large.".into()))?
            )
        } else {
            sql.to_owned()
        };
        let mut stmt = self.conn.prepare(&text)?;
        let mut rows = stmt.query([])?;
        let (columns, kinds) = {
            let s = rows
                .as_ref()
                .ok_or_else(|| Error::Engine("The statement has no result.".into()))?;
            (
                s.column_names(),
                (0..s.column_count())
                    .map(|i| StatsKind::of(&s.column_type(i)))
                    .collect::<Vec<_>>(),
            )
        };
        let wire_columns = if wire {
            let stmt = rows
                .as_ref()
                .ok_or_else(|| Error::Engine("The statement has no result.".into()))?;
            columns.iter().enumerate().map(|(i,name)| {
                let logical = stmt.column_logical_type(i);
                let ty = crate::value::wire_type(&logical)?;
                Ok(json!({"name":name,"type":ty,"nullable":true,"source_type":format!("{logical:?}"),"stats_kind":match kinds[i]{StatsKind::Numeric=>"numeric",StatsKind::Datetime=>"datetime",StatsKind::Other=>"other"}}))
            }).collect::<Result<Vec<_>, Error>>()?
        } else {
            Vec::new()
        };
        // A TIMESTAMPTZ arrives as a UTC instant; DuckDB (no ICU, session zone UTC) prints it with "+00".
        let tz: Vec<bool> = {
            let s = rows
                .as_ref()
                .ok_or_else(|| Error::Engine("The statement has no result.".into()))?;
            (0..columns.len())
                .map(|i| {
                    matches!(
                        s.column_logical_type(i).id(),
                        duckdb::core::LogicalTypeId::TimestampTZ
                    )
                })
                .collect()
        };
        let (mut out, mut bytes) = (Vec::new(), 0usize);
        while let Some(row) = rows.next()? {
            let cells: Vec<J> = (0..columns.len())
                .map(|i| {
                    let value = row.get::<_, duckdb::types::Value>(i)?;
                    if wire {
                        return crate::value::to_wire(value, &wire_columns[i]["type"]);
                    }
                    Ok(crate::value::to_json_with_timezone(value, tz[i]))
                })
                .collect::<Result<_, Error>>()?;
            // The size budget is enforced while reading, so an oversized result stops early.
            bytes += serde_json::to_string(&cells).map_or(0, |s| s.len());
            if bytes > QUERY_LIMITS.result_bytes {
                return Err(PolicyError::new(
                    Refusal::ResultSize,
                    "Query result exceeds 32 MiB. Select fewer columns or rows.",
                )
                .into());
            }
            out.push(cells);
        }
        let truncated = capped && out.len() > max_rows;
        out.truncate(if capped { max_rows } else { out.len() });
        if wire {
            validate_result_size(&json!({"columns":wire_columns,"rows":out}))?;
        } else {
            validate_result_size(&json!({"columns":columns,"rows":out}))?;
        }
        Ok((
            QueryResult {
                columns,
                rows: out,
                column_stats_kind: kinds,
                truncated,
            },
            wire_columns,
        ))
    }

    /// The statement that sorts the WHOLE result, not the rows a trailing LIMIT already picked: strip that
    /// LIMIT, sort, then re-apply it outside.
    fn sorted_sql(
        &self,
        base_sql: &str,
        column: &str,
        direction: Direction,
    ) -> Result<String, Error> {
        validate_sql_size(base_sql)?;
        self.assert_read_sql(base_sql)?;
        let stripped = strip_trailing_semicolon(base_sql);
        let extracted = extract_trailing_limit(&stripped);
        let (inner, limit) = extracted.map_or((stripped.clone(), String::new()), |(w, l)| {
            (w, format!(" {l}"))
        });
        // `direction` is a closed enum: the only message-supplied value that reaches this SQL unquoted.
        let dir = if direction == Direction::Desc {
            "desc"
        } else {
            "asc"
        };
        Ok(format!(
            "select * from {} as _sorted order by {} {dir} nulls last{limit}",
            wrap_as_subquery(&inner),
            quote_ident(column)
        ))
    }

    /// Sort the WHOLE result. Returns the sorted SQL too, so a backup diff can use the same ordering.
    pub fn run_sorted_query(
        &self,
        base_sql: &str,
        column: &str,
        direction: Direction,
        max_rows: usize,
    ) -> Result<(QueryResult, String), Error> {
        let sorted = self.sorted_sql(base_sql, column, direction)?;
        let result = self.guarded(|| self.run_query_once(&sorted, max_rows))?;
        Ok((result, sorted))
    }

    /// [`Self::run_sorted_query`] with exact wire values and column metadata.
    pub fn run_sorted_query_wire(
        &self,
        base_sql: &str,
        column: &str,
        direction: Direction,
        max_rows: usize,
    ) -> Result<(WireQueryResult, String), Error> {
        let sorted = self.sorted_sql(base_sql, column, direction)?;
        let result = self.guarded(|| self.wire_once(&sorted, max_rows))?;
        Ok((result, sorted))
    }

    fn wire_once(&self, sql: &str, max_rows: usize) -> Result<WireQueryResult, Error> {
        let (result, columns) = self.read_query_once(sql, max_rows, true)?;
        Ok(WireQueryResult {
            columns,
            rows: result.rows,
            truncated: result.truncated,
        })
    }

    /// How many rows the query matches, ignoring its trailing LIMIT. `None` rather than an error: a count
    /// is a nicety, and a query whose shape defeats the wrapper must still show its rows.
    pub fn count_matching_rows(&self, sql: &str) -> Option<i64> {
        self.count_matching_rows_checked(sql).ok().flatten()
    }

    /// As [`Self::count_matching_rows`], but refusals, cancellation, deadlines and a changed source stay
    /// typed; only an engine failure of the wrapped count itself becomes `None`.
    pub fn count_matching_rows_checked(&self, sql: &str) -> Result<Option<i64>, Error> {
        validate_sql_size(sql)?;
        self.assert_read_sql(sql)?;
        let stripped = strip_trailing_semicolon(sql);
        let inner = extract_trailing_limit(&stripped).map_or(stripped, |(w, _)| w);
        match self.guarded(|| {
            Ok(self.conn.query_row(
                &format!(
                    "select system.main.count(*) from {} as _rowcount",
                    wrap_as_subquery(&inner)
                ),
                [],
                |r| r.get::<_, i64>(0),
            )?)
        }) {
            Ok(n) => Ok(Some(n)),
            Err(Error::Engine(_)) => Ok(None),
            Err(other) => Err(other),
        }
    }

    fn one_row(&self, sql: &str) -> Result<Vec<J>, Error> {
        self.one_row_as(sql, false)
    }

    /// One result row as display JSON, or as exact wire values when `wire`.
    fn one_row_as(&self, sql: &str, wire: bool) -> Result<Vec<J>, Error> {
        self.guarded(|| {
            let mut stmt = self.conn.prepare(sql)?;
            let raw = stmt.query_row([], |r| {
                (0..r.as_ref().column_count())
                    .map(|i| {
                        Ok((
                            r.get::<_, duckdb::types::Value>(i)?,
                            r.as_ref().column_logical_type(i),
                        ))
                    })
                    .collect::<Result<Vec<_>, duckdb::Error>>()
            })?;
            raw.into_iter().map(|(v, t)| cell(v, &t, wire)).collect()
        })
    }

    pub fn column_top_values(
        &self,
        base_sql: &str,
        column: &str,
        limit: usize,
    ) -> Result<TopValues, Error> {
        self.top_values_as(base_sql, column, limit, false)
    }

    /// As [`Self::column_top_values`], with each value (and the counts) as exact wire values.
    pub fn column_top_values_wire(
        &self,
        base_sql: &str,
        column: &str,
        limit: usize,
    ) -> Result<TopValues, Error> {
        self.top_values_as(base_sql, column, limit, true)
    }

    fn top_values_as(
        &self,
        base_sql: &str,
        column: &str,
        limit: usize,
        wire: bool,
    ) -> Result<TopValues, Error> {
        validate_sql_size(base_sql)?;
        self.assert_read_sql(base_sql)?;
        // `limit` is interpolated into a LIMIT clause, so it is clamped here whatever the caller did.
        let limit = if (1..=200).contains(&limit) {
            limit
        } else {
            20
        };
        let wrapped = wrap_as_subquery(&strip_trailing_semicolon(base_sql));
        let col = quote_ident(column);
        let s = self.one_row(&format!(
            "select system.main.count(*), system.main.count({col}), system.main.count(*) - system.main.count({col}), system.main.count(distinct {col}) from {wrapped} as _stats_source"
        ))?;
        let top = self.guarded(|| {
            let mut stmt = self.conn.prepare(&format!(
                "select {col} as value, system.main.count(*) as frequency from {wrapped} as _stats_source where {col} is not null \
                 group by {col} order by frequency desc, value limit {limit}"
            ))?;
            let raw = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, duckdb::types::Value>(0)?,
                        r.as_ref().column_logical_type(0),
                        r.get::<_, i64>(1)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            raw.into_iter()
                .map(|(v, t, n)| Ok((cell(v, &t, wire)?, n)))
                .collect::<Result<Vec<_>, Error>>()
        })?;
        // Distinct values can be arbitrarily large cells; the same budgets as a query result apply.
        validate_result_size(&json!({"top_values": top}))?;
        Ok(TopValues {
            total_rows: int(&s[0]),
            non_null_rows: int(&s[1]),
            null_count: int(&s[2]),
            distinct_count: int(&s[3]),
            top_values: top,
        })
    }

    /// Descriptive stats of a numeric or datetime column; `approx_quantile` is approximate by design.
    pub fn column_descriptive_stats(
        &self,
        base_sql: &str,
        column: &str,
        kind: StatsKind,
    ) -> Result<DescriptiveStats, Error> {
        self.descriptive_stats_as(base_sql, column, kind, false)
    }

    /// As [`Self::column_descriptive_stats`], with min/max/mean/quantiles as exact wire values.
    pub fn column_descriptive_stats_wire(
        &self,
        base_sql: &str,
        column: &str,
        kind: StatsKind,
    ) -> Result<DescriptiveStats, Error> {
        self.descriptive_stats_as(base_sql, column, kind, true)
    }

    fn descriptive_stats_as(
        &self,
        base_sql: &str,
        column: &str,
        kind: StatsKind,
        wire: bool,
    ) -> Result<DescriptiveStats, Error> {
        validate_sql_size(base_sql)?;
        self.assert_read_sql(base_sql)?;
        let mean = match kind {
            StatsKind::Numeric => format!("system.main.avg({})", quote_ident(column)),
            StatsKind::Datetime => format!(
                "system.main.to_timestamp(system.main.avg(system.main.epoch({})))",
                quote_ident(column)
            ),
            StatsKind::Other => {
                return Err(Error::Invalid(
                    "Statistics need a numeric or datetime column.".into(),
                ));
            }
        };
        let (wrapped, col) = (
            wrap_as_subquery(&strip_trailing_semicolon(base_sql)),
            quote_ident(column),
        );
        let r = self.one_row_as(&format!(
            "select system.main.count(*), system.main.count({col}), system.main.count(*) - system.main.count({col}), system.main.min({col}), system.main.max({col}), {mean}, \
             system.main.approx_quantile({col}, 0.05), system.main.approx_quantile({col}, 0.95) from {wrapped} as _stats_source"
        ), wire)?;
        validate_result_size(&J::Array(r.clone()))?;
        Ok(DescriptiveStats {
            total_rows: int(&r[0]),
            non_null_rows: int(&r[1]),
            null_count: int(&r[2]),
            min: r[3].clone(),
            max: r[4].clone(),
            mean: r[5].clone(),
            p5: r[6].clone(),
            p95: r[7].clone(),
        })
    }

    /// Share of the NON-NULL values of a text column that parse, judged on a bounded sample.
    fn text_axis_parse_rate(
        &self,
        inner: &str,
        x_column: &str,
        read_as: Option<&str>,
    ) -> Result<f64, Error> {
        let x = quote_ident(x_column);
        let expr = read_as.map_or_else(|| format!("try_cast({x} as timestamp)"), str::to_owned);
        let sample = format!(
            "select {x} from {} as _probe where {x} is not null limit {TEXT_AXIS_PROBE_ROWS}",
            wrap_as_subquery(inner)
        );
        let r = self.one_row(&format!(
            "select system.main.count(*), system.main.count({expr}) from {} as _probe_rows",
            wrap_as_subquery(&sample)
        ))?;
        let (n, ok) = (int(&r[0]), int(&r[1]));
        Ok(if n > 0 { ok as f64 / n as f64 } else { 0.0 })
    }

    /// A chart of the query on screen: the trailing LIMIT is KEPT (inside the subquery, so the points are the
    /// rows the grid shows, not the earliest by x). A text or numeric-year x column is tried as a time axis.
    /// Returns the statement to run and the axis it implies.
    fn chart_sql(
        &self,
        base_sql: &str,
        x_column: &str,
        y_columns: &[&str],
        x_is_text: bool,
        x_is_category: bool,
    ) -> Result<(String, XAxis), Error> {
        validate_sql_size(base_sql)?;
        self.assert_read_sql(base_sql)?;
        let stripped = strip_trailing_semicolon(base_sql);
        let inner =
            extract_trailing_limit(&stripped).map_or(stripped.clone(), |(w, l)| format!("{w} {l}"));
        let x = quote_ident(x_column);
        let ys = y_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        // A YEAR is a point in time: 1996 becomes 1996-01-01. Bounded so `Year` holding 1, 2, 3 stays a count.
        let year = format!(
            "case when try_cast({x} as bigint) between 1000 and 3000 then system.main.make_date(cast({x} as bigint), 1, 1) end"
        );
        let as_year = x_is_category
            && self.text_axis_parse_rate(&inner, x_column, Some(&year))?
                >= TEXT_AXIS_MIN_PARSE_RATE;
        let as_time = as_year
            || (!x_is_category
                && (!x_is_text
                    || self.text_axis_parse_rate(&inner, x_column, None)?
                        >= TEXT_AXIS_MIN_PARSE_RATE));
        let wrapped = wrap_as_subquery(&inner);
        if as_time {
            let expr = if as_year {
                year
            } else if x_is_text {
                format!("try_cast({x} as timestamp)")
            } else {
                x.clone()
            };
            return Ok((
                format!(
                    "select {expr} as {x}, {ys} from {wrapped} as _chart where {expr} is not null order by 1 asc"
                ),
                XAxis::Time,
            ));
        }
        Ok((
            format!("select {x}, {ys} from {wrapped} as _chart where {x} is not null"),
            XAxis::Category,
        ))
    }

    pub fn run_chart_query(
        &self,
        base_sql: &str,
        x_column: &str,
        y_columns: &[&str],
        x_is_text: bool,
        max_points: usize,
        x_is_category: bool,
    ) -> Result<(QueryResult, XAxis), Error> {
        let (sql, axis) =
            self.chart_sql(base_sql, x_column, y_columns, x_is_text, x_is_category)?;
        Ok((
            self.guarded(|| self.run_query_once(&sql, max_points))?,
            axis,
        ))
    }

    /// [`Self::run_chart_query`] with exact wire values and column metadata.
    pub fn run_chart_query_wire(
        &self,
        base_sql: &str,
        x_column: &str,
        y_columns: &[&str],
        x_is_text: bool,
        max_points: usize,
        x_is_category: bool,
    ) -> Result<(WireQueryResult, XAxis), Error> {
        let (sql, axis) =
            self.chart_sql(base_sql, x_column, y_columns, x_is_text, x_is_category)?;
        Ok((self.guarded(|| self.wire_once(&sql, max_points))?, axis))
    }

    /// Explicit axes preserve the query's rows and limit; date interpretation checks every value.
    pub fn run_chart_query_axis_wire(
        &self,
        base_sql: &str,
        x_column: &str,
        y_columns: &[&str],
        max_points: usize,
        axis: ChartAxis,
    ) -> Result<(WireQueryResult, XAxis, Option<String>), Error> {
        if let ChartAxis::Automatic { text, category } = axis {
            let (rows, axis) = self
                .run_chart_query_wire(base_sql, x_column, y_columns, text, max_points, category)?;
            return Ok((rows, axis, None));
        }
        validate_sql_size(base_sql)?;
        self.assert_read_sql(base_sql)?;
        let source = wrap_as_subquery(&strip_trailing_semicolon(base_sql));
        let ys = y_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        if matches!(axis, ChartAxis::Rows) {
            let mut name = x_column.to_owned();
            let mut suffix = 2;
            while y_columns
                .iter()
                .any(|c| c.to_lowercase() == name.to_lowercase())
            {
                name = format!("{x_column} ({suffix})");
                suffix += 1;
            }
            let sql = format!(
                "select cast(system.main.row_number() over () as integer) as {}, {ys} from {source} as _chart",
                quote_ident(&name)
            );
            return Ok((
                self.guarded(|| self.wire_once(&sql, max_points))?,
                XAxis::Category,
                None,
            ));
        }
        if y_columns.contains(&x_column) {
            return Err(Error::Invalid(
                "The date axis cannot also be a plotted series.".into(),
            ));
        }
        let x = quote_ident(x_column);
        let ty: String = self.conn.query_row(
            &format!("describe select {x} from {source} as _t"),
            [],
            |r| r.get(1),
        )?;
        let native = ty == "DATE" || ty.starts_with("TIMESTAMP");
        let numeric = matches!(
            ty.as_str(),
            "TINYINT"
                | "SMALLINT"
                | "INTEGER"
                | "BIGINT"
                | "HUGEINT"
                | "UTINYINT"
                | "USMALLINT"
                | "UINTEGER"
                | "UBIGINT"
                | "UHUGEINT"
                | "FLOAT"
                | "DOUBLE"
        ) || ty.starts_with("DECIMAL");
        if !native && !numeric && ty != "VARCHAR" {
            return Err(Error::Invalid(
                "This column cannot be read as dates.".into(),
            ));
        }
        let ts = format!(
            "case when system.main.year(try_cast({x} as timestamp)) between 1000 and 3000 then try_cast({x} as timestamp) end"
        );
        let year = format!(
            "case when try_cast({x} as double) = try_cast({x} as bigint) and try_cast({x} as bigint) between 1000 and 3000 then system.main.make_date(try_cast({x} as bigint), 1, 1) end"
        );
        let offset = format!(
            r"system.main.regexp_extract(cast({x} as varchar), '[0-9]:[0-9]{{2}}(?::[0-9]{{2}}(?:\.[0-9]+)?)?\s*(Z|[+-][0-9]{{2}}(?::?[0-9]{{2}})?)$', 1)"
        );
        let ts_ok = if ty == "VARCHAR" { ts.as_str() } else { "null" };
        let year_ok = if native { "null" } else { year.as_str() };
        let stats = self.one_row(&format!("select system.main.count({x}), system.main.count(*), system.main.count({ts_ok}), system.main.count({year_ok}), system.main.count(distinct case when {ts_ok} is not null then {offset} end), system.main.min(case when {ts_ok} is not null then {offset} end) from {source} as _t"))?;
        let (non_null, total, ts_parsed, year_parsed, offsets) = (
            int(&stats[0]),
            int(&stats[1]),
            int(&stats[2]),
            int(&stats[3]),
            int(&stats[4]),
        );
        if non_null == 0 {
            return Err(Error::Invalid("This column has no dates to plot.".into()));
        }
        let mut note = String::new();
        let expr = if native {
            &x
        } else if ts_parsed == non_null {
            if offsets > 1 {
                return Err(Error::Invalid(
                    "This date column mixes UTC offsets (or some values have none).".into(),
                ));
            }
            if let Some(offset) = stats[5].as_str().filter(|s| !s.is_empty()) {
                note = format!("times plotted as written; UTC offset {offset} not applied");
            }
            &ts
        } else if year_parsed == non_null {
            &year
        } else {
            return Err(Error::Invalid("Not every value is an ISO date or a whole year from 1000 to 3000; ambiguous day/month text and epoch numbers are refused.".into()));
        };
        let missing = total - non_null;
        if missing > 0 {
            note = format!(
                "{missing} row{} with no date left out{}",
                if missing == 1 { "" } else { "s" },
                if note.is_empty() {
                    String::new()
                } else {
                    format!("; {note}")
                }
            );
        }
        let sql = format!(
            "select {expr} as {x}, {ys} from {source} as _chart where {expr} is not null order by 1 asc"
        );
        Ok((
            self.guarded(|| self.wire_once(&sql, max_points))?,
            XAxis::Time,
            if note.is_empty() { None } else { Some(note) },
        ))
    }
}
