//! Read-only table worker over the policy-locked DuckDB engine.
#![forbid(unsafe_code)]

pub mod formats;
pub mod resource;
pub mod routes;
mod safe_mode;
pub mod session;
pub mod source;
#[cfg(feature = "test-doc")]
pub mod testdoc;
mod write_dispatch;
mod write_support;
pub mod xlsx;

use dfv_table_duckdb::duckdb::OpenOptions;
use dfv_table_duckdb::locale::NumberLocale;
use dfv_table_duckdb::parquet::SchemaProvenance;
use dfv_table_duckdb::query::{ChartAxis, Direction, XAxis};
use dfv_table_duckdb::{Engine, Error, StatsKind, WireQueryResult};
use dfv_table_protocol::errors::*;
use dfv_table_protocol::{Capabilities, Control, ErrorBody, Lane, Route};
use resource::Resources;
use serde_json::{Map, Value, json};
use session::Sessions;
use source::Source;
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

const MAX_ROWS: usize = 100_000;
const MAX_CHART_POINTS: usize = 200_000;
const MAX_PAGE: usize = 1000;

pub struct Tables {
    sessions: Sessions,
    sources: HashMap<String, Box<dyn Source>>,
    resources: Resources,
    writes: HashMap<String, safe_mode::State>,
    requests: HashMap<String, formats::OpenRequest>,
}
impl Default for Tables {
    fn default() -> Self {
        Self {
            sessions: Sessions::new(4),
            sources: HashMap::new(),
            resources: Resources::default(),
            writes: HashMap::new(),
            requests: HashMap::new(),
        }
    }
}
fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, ErrorBody> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ErrorBody::new(MALFORMED_VALUE, format!("`{key}` must be a string.")))
}
fn size(
    args: &Map<String, Value>,
    key: &str,
    default: usize,
    max: usize,
) -> Result<usize, ErrorBody> {
    match args.get(key) {
        None => Ok(default),
        Some(v) => v
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0 && *n <= max)
            .ok_or_else(|| {
                ErrorBody::new(
                    MALFORMED_VALUE,
                    format!("`{key}` must be between 1 and {max}."),
                )
            }),
    }
}
fn counter(args: &Map<String, Value>, key: &str) -> Result<Option<u64>, ErrorBody> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::String(s))
            if !s.is_empty()
                && (s.len() == 1 || !s.starts_with('0'))
                && s.bytes().all(|c| c.is_ascii_digit()) =>
        {
            s.parse()
                .map(Some)
                .map_err(|_| ErrorBody::new(MALFORMED_VALUE, format!("`{key}` exceeds uint64.")))
        }
        _ => Err(ErrorBody::new(
            MALFORMED_VALUE,
            format!("`{key}` must be canonical uint64 text."),
        )),
    }
}
fn flag(args: &Map<String, Value>, key: &str) -> Result<bool, ErrorBody> {
    match args.get(key) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(ErrorBody::new(
            MALFORMED_VALUE,
            format!("`{key}` must be a boolean."),
        )),
    }
}
fn open_options(args: &Map<String, Value>) -> Result<OpenOptions, ErrorBody> {
    let number_locale = match args.get("number_locale") {
        None => None,
        Some(Value::String(s)) if s == "auto" => None,
        Some(Value::String(s)) if s == "en" => Some(NumberLocale::En),
        Some(Value::String(s)) if s == "eu" => Some(NumberLocale::Eu),
        _ => {
            return Err(ErrorBody::new(
                MALFORMED_VALUE,
                "Choose auto, en or eu for the number locale.",
            ));
        }
    };
    let null_text = match args.get("null_text") {
        None => None,
        Some(Value::Array(tokens)) if tokens.len() <= 256 => Some(
            tokens
                .iter()
                .map(|token| {
                    token
                        .as_str()
                        .filter(|s| s.len() <= 256)
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            ErrorBody::new(
                                MALFORMED_VALUE,
                                "Null-text markers must be strings of at most 256 bytes.",
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        _ => {
            return Err(ErrorBody::new(
                MALFORMED_VALUE,
                "The null-text list must contain at most 256 strings.",
            ));
        }
    };
    Ok(OpenOptions {
        number_locale,
        null_text,
    })
}
/// Counts cross the wire as canonical uint64 text, like every other exact integer.
fn count_text(n: i64) -> Value {
    json!(n.max(0).to_string())
}
fn failure(error: Error) -> ErrorBody {
    let (code, message) = match error {
        Error::Policy(error) => match error.kind.code() {
            "sql_size" | "cell_size" | "result_size" => (
                RESOURCE_LIMIT,
                "This query exceeds the permitted read size.",
            ),
            "engine" => (
                QUERY_FAILED,
                "The table engine could not inspect this query.",
            ),
            _ => (
                POLICY_REFUSED,
                "This query is outside the permitted read-only policy.",
            ),
        },
        Error::Interrupted => (CANCELLED, "The query was cancelled."),
        Error::TimedOut => (DEADLINE_EXCEEDED, "The query deadline passed."),
        Error::SourceChanged => (STALE_SOURCE, "The source changed; close and reopen it."),
        Error::Unsupported(_) => (UNSUPPORTED, "This source or value type is unsupported."),
        Error::TooLarge(_) => (
            RESOURCE_LIMIT,
            "This source is larger than this worker may read.",
        ),
        Error::Invalid(_) => (
            MALFORMED_VALUE,
            "The source or query arguments are invalid.",
        ),
        Error::Engine(_) => (
            QUERY_FAILED,
            "The table engine could not complete this read.",
        ),
    };
    ErrorBody::new(code, message)
}

/// Cancellation reaches DuckDB while its native call is active, not just after it returns.
fn controlled<T>(
    engine: &Engine,
    control: &Control,
    work: impl FnOnce() -> Result<T, Error>,
) -> Result<T, ErrorBody> {
    control.check()?;
    let interrupt = engine.interrupt_handle();
    std::thread::scope(|scope| {
        let (done, wait) = mpsc::channel();
        scope.spawn(move || {
            while wait.recv_timeout(Duration::from_millis(5))
                == Err(mpsc::RecvTimeoutError::Timeout)
            {
                if control.check().is_err() {
                    // DuckDB can clear an interrupt between policy inspection and execution.
                    interrupt.interrupt();
                }
            }
        });
        let result = work().map_err(failure);
        let _ = done.send(());
        control.check()?;
        result
    })
}
impl Tables {
    /// A changed source invalidates every read; it is never silently attached to the old connection.
    fn revision(&mut self, id: &str, expected: Option<u64>) -> Result<u64, ErrorBody> {
        let (generation, changed) = self.sessions.refresh(id)?;
        let source_error = self
            .sources
            .get(id)
            .and_then(|source| source.engine().check_source().err());
        if changed || source_error.is_some() {
            self.sources.remove(id);
            self.resources.release_session(id);
        }
        if let Some(error) = source_error {
            return Err(failure(error));
        }
        if changed || expected.is_some_and(|n| n != generation.revision) {
            return Err(ErrorBody::new(
                STALE_SOURCE,
                "The source changed; close and reopen it.",
            ));
        }
        Ok(generation.revision)
    }
    fn engine(&self, id: &str) -> Result<&Engine, ErrorBody> {
        self.sources
            .get(id)
            .map(|source| source.engine())
            .ok_or_else(|| ErrorBody::new(NOT_OPEN, "No such open table."))
    }
    /// The session a read names, refreshed against its source; the revision the answer must still match.
    fn read_session(&mut self, args: &Map<String, Value>) -> Result<(String, u64), ErrorBody> {
        let id = text(args, "session")?.to_owned();
        let revision = self.revision(&id, counter(args, "expected_revision")?)?;
        if !self.sources.contains_key(&id) {
            // A dropped stale source must never reach the routes that expect it open.
            return Err(ErrorBody::new(NOT_OPEN, "No such open table."));
        }
        Ok((id, revision))
    }
    /// Hold a finished result as a bounded resource and answer with its first page. Every failure after
    /// the allocation releases the handle, so an error never leaves a result behind.
    fn store(
        &mut self,
        id: &str,
        revision: u64,
        control: &Control,
        result: WireQueryResult,
        sql: &str,
        page_size: usize,
    ) -> Result<Value, ErrorBody> {
        control.check()?;
        let handle = self
            .resources
            .add_query(id, revision, result, sql, || control.check())?;
        let page = self.page(
            &serde_json::from_value(json!({"resource":handle,"page_size":page_size}))
                .expect("object"),
        );
        if page.is_err() {
            self.resources.release(&handle);
        }
        page
    }
    fn page(&mut self, args: &Map<String, Value>) -> Result<Value, ErrorBody> {
        let handle = text(args, "resource")?;
        let id = resource::session_of(handle)
            .ok_or_else(|| ErrorBody::new(NOT_OPEN, "No such result handle."))?;
        let revision = self.revision(&id, None)?;
        let entry = self.resources.get(handle)?;
        if revision != entry.revision {
            return Err(ErrorBody::new(
                STALE_SOURCE,
                "This result belongs to an earlier source revision.",
            ));
        }
        let offset = counter(args, "offset")?.unwrap_or(0);
        let offset = usize::try_from(offset)
            .map_err(|_| ErrorBody::new(MALFORMED_VALUE, "The page offset is too large."))?;
        let length = size(args, "page_size", 100, MAX_PAGE)?;
        let page = entry.query_page(offset, length)?;
        Ok(
            json!({"resource":{"id":handle,"source_revision":revision.to_string()},
            "columns":page.columns,"rows":page.rows,"sql":page.sql,
            "page":{"offset":offset.to_string(),"row_count":page.rows.len().to_string(),
                "total_rows":if page.truncated {Value::Null} else {json!(page.total_rows.to_string())},
                "next_offset":if page.end<page.total_rows{json!(page.end.to_string())}else{Value::Null},"truncated":page.truncated}}),
        )
    }
}
impl Lane for Tables {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            name: "dfv-table",
            version: env!("CARGO_PKG_VERSION"),
            methods: vec![
                "ping",
                "open",
                "close",
                "getQueryCatalog",
                "getQueryColumns",
                "runQuery",
                "runSortedQuery",
                "runChartQuery",
                "countMatchingRows",
                "getColumnTopValues",
                "getColumnDescriptiveStats",
                "readResource",
                "releaseResource",
                "listTables",
                "listSidebarTables",
                "listSiblingTables",
                "getCombinableTableNames",
                "buildCombinedQuery",
                "getPollCadenceSeconds",
                "getSeriesFrequency",
                "buildDetectedTableQuery",
                "runDetectedTableQuery",
                "locateXlsxEdit",
                "retrySheetPreparation",
                "checkEditableSelect",
                "compareToBackup",
                "diffQueryAgainstBackup",
                "createBackup",
                "setSafeMode",
                "updateCell",
                "queryMutationOutcome",
            ],
            formats: ["csv", "parquet", "duckdb", "sqlite", "xlsx", "arrow", "feather", "dta", "kdb"].into_iter().map(|kind| {
                let write = match kind {
                    "duckdb" | "sqlite" => "transactional",
                    "xlsx" => "cell_patch",
                    "dta" | "kdb" => "none",
                    _ => "table_rewrite",
                };
                json!({"file_kind":kind,"read":true,"write":write,"backup":write != "none","compression":[]})
            }).collect(),
            value_tags: dfv_table_duckdb::value::WIRE_TAGS.to_vec(),
            time_units: vec!["s", "ms", "us", "ns"],
        }
    }
    fn router(&self) -> fn(&str, &Map<String, Value>) -> Route {
        |method, args| {
            let session = if matches!(method, "readResource" | "releaseResource") {
                args.get("resource")
                    .and_then(Value::as_str)
                    .and_then(resource::session_of)
            } else {
                args.get("session")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            Route {
                closes: method == "close" && session.is_some(),
                session,
            }
        }
    }
    fn call(
        &mut self,
        method: &str,
        args: &Map<String, Value>,
        control: &Control,
    ) -> Result<Value, ErrorBody> {
        control.check()?;
        let mut result = (|| {
            xlsx::prepare_read(self, method, args, control)?;
            match method {
                "ping" => Ok(json!({})),
                "open" => {
                    let options = open_options(args)?;
                    let force_kind = match args.get("force_kind") {
                        None => None,
                        Some(word) => {
                            Some(word.as_str().and_then(formats::kind_named).ok_or_else(|| {
                                ErrorBody::new(MALFORMED_VALUE, "`force_kind` must be a file kind.")
                            })?)
                        }
                    };
                    let sibling_path = match args.get("sibling_path") {
                        None | Some(Value::Null) => None,
                        Some(_) => Some(text(args, "sibling_path")?.into()),
                    };
                    let session = self.sessions.open(Path::new(text(args, "path")?))?;
                    let id = session.id.clone();
                    let path = session.current.identity.path.clone();
                    let result = (|| {
                        let cancel = || {
                            control.check().map_err(|e| {
                                if e.code == DEADLINE_EXCEEDED {
                                    Error::TimedOut
                                } else {
                                    Error::Interrupted
                                }
                            })
                        };
                        let request = formats::OpenRequest {
                            path,
                            force_read_only: flag(args, "force_read_only")?,
                            force_kind,
                            options,
                            sibling_path,
                            sheets: xlsx::sheet_open(args)?,
                        };
                        let opened = formats::open(&request, &cancel).map_err(failure)?;
                        control.check()?;
                        let revision = self.revision(&id, Some(1))?;
                        let source = opened.source;
                        let engine = source.engine();
                        let provenance = match engine.kind.schema_provenance() {
                            SchemaProvenance::Declared => "declared",
                            SchemaProvenance::Inferred => "inferred",
                        };
                        let identity = &self.sessions.get(&id)?.current.identity;
                        let mut answer = formats::read_metadata(&*source, identity, revision);
                        if request.force_read_only {
                            answer.insert("read_only".into(), json!(true));
                        }
                        answer.insert("session".into(), json!(id));
                        answer.insert("source_revision".into(), json!(revision.to_string()));
                        answer.insert("schema_provenance".into(), json!(provenance));
                        answer.insert("edit_blockers".into(), json!(engine.edit_blockers));
                        let backup = match args.get("backup_path") {
                            None | Some(Value::Null) => None,
                            Some(_) => Some(write_dispatch::restore_backup(
                                &request.path,
                                engine.kind,
                                text(args, "backup_path")?,
                                control,
                            )?),
                        };
                        self.sources.insert(id.clone(), source);
                        self.requests.insert(id.clone(), request);
                        self.writes.insert(
                            id.clone(),
                            safe_mode::State {
                                backup,
                                ..Default::default()
                            },
                        );
                        Ok(Value::Object(answer))
                    })();
                    if result.is_err() {
                        self.sessions.close(&id);
                    }
                    result
                }
                "close" => {
                    let id = text(args, "session")?;
                    self.sources.remove(id);
                    self.writes.remove(id);
                    self.requests.remove(id);
                    Ok(
                        json!({"closed":self.sessions.close(id),"released":self.resources.release_session(id)}),
                    )
                }
                "getQueryCatalog" => {
                    let id = text(args, "session")?;
                    let revision = self.revision(id, counter(args, "expected_revision")?)?;
                    let offset = counter(args, "offset")?.unwrap_or(0);
                    if offset > 1_000_000 {
                        return Err(ErrorBody::new(
                            MALFORMED_VALUE,
                            "The catalog offset exceeds the permitted range.",
                        ));
                    }
                    let engine = self.engine(id)?;
                    let relations = match xlsx::catalog(
                        &**self.sources.get(id).expect("open source checked"),
                        offset as usize,
                        control,
                    )? {
                        Some(page) => page,
                        None => {
                            controlled(engine, control, || engine.query_catalog(offset as usize))?
                        }
                    };
                    self.revision(id, Some(revision))?;
                    Ok(
                        json!({"relations":relations.iter().map(|r|json!({"catalog":r.catalog,"schema":r.schema,"name":r.name,"sql_name":r.sql_name})).collect::<Vec<_>>(),
                    "next_offset":if relations.len()==100 {json!((offset+100).to_string())} else {Value::Null}}),
                    )
                }
                "getQueryColumns" => {
                    let (id, revision) = self.read_session(args)?;
                    let (catalog, schema, name) = (
                        text(args, "catalog")?,
                        text(args, "schema")?,
                        text(args, "name")?,
                    );
                    let engine = self.engine(&id)?;
                    let columns = controlled(engine, control, || {
                        engine.query_columns(catalog, schema, name)
                    })?;
                    self.revision(&id, Some(revision))?;
                    Ok(
                        json!({"columns":columns.iter().map(|c|json!({"name":c.name,"source_type":c.data_type})).collect::<Vec<_>>()}),
                    )
                }
                "runQuery" => {
                    let (id, revision) = self.read_session(args)?;
                    let sql = text(args, "sql")?;
                    let max_rows = size(args, "max_rows", 10_000, MAX_ROWS)?;
                    let page_size = size(args, "page_size", 100, MAX_PAGE)?;
                    xlsx::prepare_selected(self, &id, args, control)?;
                    let engine = self.engine(&id)?;
                    let result =
                        controlled(engine, control, || engine.run_query_wire(sql, max_rows))?;
                    let metadata = xlsx::metadata(self, &id, control)?;
                    let mut answer = self.store(&id, revision, control, result, sql, page_size)?;
                    if let Some(metadata) = metadata {
                        answer["workbook_metadata"] = metadata;
                    }
                    Ok(answer)
                }
                "runSortedQuery" => {
                    let (id, revision) = self.read_session(args)?;
                    let (sql, column) = (text(args, "sql")?, text(args, "column")?);
                    let direction = match text(args, "direction")? {
                        "asc" => Direction::Asc,
                        "desc" => Direction::Desc,
                        _ => {
                            return Err(ErrorBody::new(
                                MALFORMED_VALUE,
                                "`direction` must be \"asc\" or \"desc\".",
                            ));
                        }
                    };
                    let max_rows = size(args, "max_rows", 10_000, MAX_ROWS)?;
                    let page_size = size(args, "page_size", 100, MAX_PAGE)?;
                    let engine = self.engine(&id)?;
                    let (result, sorted) = controlled(engine, control, || {
                        engine.run_sorted_query_wire(sql, column, direction, max_rows)
                    })?;
                    // The page's `sql` is the statement that produced the order, for a backup diff.
                    self.store(&id, revision, control, result, &sorted, page_size)
                }
                "runChartQuery" => {
                    let (id, revision) = self.read_session(args)?;
                    let (sql, x) = (text(args, "sql")?, text(args, "x_column")?);
                    let ys = args
                        .get("y_columns")
                        .and_then(Value::as_array)
                        .filter(|a| !a.is_empty() && a.len() <= 64)
                        .and_then(|a| a.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
                        .ok_or_else(|| {
                            ErrorBody::new(
                                MALFORMED_VALUE,
                                "`y_columns` must hold 1 to 64 column names.",
                            )
                        })?;
                    let (x_is_text, x_is_category) =
                        (flag(args, "x_is_text")?, flag(args, "x_is_category")?);
                    let axis = match (
                        flag(args, "x_is_row")?,
                        flag(args, "x_as_date")?,
                        flag(args, "x_as_value")?,
                    ) {
                        (true, false, false) => ChartAxis::Rows,
                        (false, true, false) => ChartAxis::Dates,
                        (false, false, true) => ChartAxis::Values,
                        (false, false, false) => ChartAxis::Automatic {
                            text: x_is_text,
                            category: x_is_category,
                        },
                        _ => {
                            return Err(ErrorBody::new(
                                MALFORMED_VALUE,
                                "Choose one x axis: row numbers, dates or numbers.",
                            ));
                        }
                    };
                    let max_points = size(args, "max_points", 10_000, MAX_CHART_POINTS)?;
                    let page_size = size(args, "page_size", 100, MAX_PAGE)?;
                    let engine = self.engine(&id)?;
                    let (result, axis, note) = controlled(engine, control, || {
                        engine.run_chart_query_axis_wire(sql, x, &ys, max_points, axis)
                    })?;
                    let page = self.store(&id, revision, control, result, sql, page_size)?;
                    let mut answer = json!({"x_axis_mode":match axis {XAxis::Time => "time", XAxis::Category => "category", XAxis::Value => "value"},"result":page});
                    if let Some(note) = note {
                        answer["note"] = json!(note);
                    }
                    Ok(answer)
                }
                "countMatchingRows" => {
                    let (id, revision) = self.read_session(args)?;
                    let sql = text(args, "sql")?;
                    let engine = self.engine(&id)?;
                    let count =
                        controlled(engine, control, || engine.count_matching_rows_checked(sql))?;
                    self.revision(&id, Some(revision))?;
                    Ok(json!({"count":count.map_or(Value::Null, count_text)}))
                }
                "getColumnTopValues" => {
                    let (id, revision) = self.read_session(args)?;
                    let (sql, column) = (text(args, "sql")?, text(args, "column")?);
                    // The reference clamps an out-of-range limit to its default instead of refusing, so the engine does.
                    let limit = match args.get("limit") {
                        None => 20,
                        Some(v) => v
                            .as_u64()
                            .and_then(|n| usize::try_from(n).ok())
                            .ok_or_else(|| {
                                ErrorBody::new(
                                    MALFORMED_VALUE,
                                    "`limit` must be a non-negative integer.",
                                )
                            })?,
                    };
                    let engine = self.engine(&id)?;
                    let top = controlled(engine, control, || {
                        engine.column_top_values_wire(sql, column, limit)
                    })?;
                    self.revision(&id, Some(revision))?;
                    Ok(
                        json!({"total_rows":count_text(top.total_rows),"non_null_rows":count_text(top.non_null_rows),
                    "null_count":count_text(top.null_count),"distinct_count":count_text(top.distinct_count),
                    "top_values":top.top_values.into_iter().map(|(value,frequency)|json!({"value":value,"frequency":count_text(frequency)})).collect::<Vec<_>>()}),
                    )
                }
                "getColumnDescriptiveStats" => {
                    let (id, revision) = self.read_session(args)?;
                    let (sql, column) = (text(args, "sql")?, text(args, "column")?);
                    let kind = match text(args, "stats_kind")? {
                        "numeric" => StatsKind::Numeric,
                        "datetime" => StatsKind::Datetime,
                        _ => {
                            return Err(ErrorBody::new(
                                MALFORMED_VALUE,
                                "`stats_kind` must be \"numeric\" or \"datetime\".",
                            ));
                        }
                    };
                    let engine = self.engine(&id)?;
                    let stats = controlled(engine, control, || {
                        engine.column_descriptive_stats_wire(sql, column, kind)
                    })?;
                    self.revision(&id, Some(revision))?;
                    Ok(
                        json!({"total_rows":count_text(stats.total_rows),"non_null_rows":count_text(stats.non_null_rows),
                    "null_count":count_text(stats.null_count),"min":stats.min,"max":stats.max,"mean":stats.mean,
                    "p5":stats.p5,"p95":stats.p95}),
                    )
                }
                "listTables" => routes::read(self, method, args, control),
                "listSidebarTables" => routes::read(self, method, args, control),
                "listSiblingTables" => routes::read(self, method, args, control),
                "getCombinableTableNames" => routes::read(self, method, args, control),
                "buildCombinedQuery" => routes::read(self, method, args, control),
                "getPollCadenceSeconds" => routes::read(self, method, args, control),
                "getSeriesFrequency" => routes::read(self, method, args, control),
                "buildDetectedTableQuery" => xlsx::read(self, method, args, control),
                "runDetectedTableQuery" => xlsx::run(self, args, control),
                "locateXlsxEdit" => xlsx::read(self, method, args, control),
                "retrySheetPreparation" => xlsx::read(self, method, args, control),
                "checkEditableSelect" | "compareToBackup" | "diffQueryAgainstBackup" => {
                    safe_mode::read(self, method, args, control)
                }
                "createBackup" | "setSafeMode" | "updateCell" | "queryMutationOutcome" => {
                    write_dispatch::call(self, method, args, control)
                }
                "readResource" => self.page(args),
                "releaseResource" => {
                    Ok(json!({"released":self.resources.release(text(args, "resource")?)}))
                }
                _ => Err(ErrorBody::new(UNKNOWN_METHOD, "Unknown table operation.")),
            }
        })();
        if let Some(id) = args.get("session").and_then(Value::as_str)
            && let Some(source) = self.sources.get(id)
        {
            if let Err(error) = xlsx::finish_source(&**source) {
                if let Ok(value) = result {
                    self.discard(method, value);
                }
                return Err(error);
            }
            if let Ok(value) = &mut result
                && matches!(
                    method,
                    "runQuery"
                        | "runSortedQuery"
                        | "runChartQuery"
                        | "runDetectedTableQuery"
                        | "getQueryCatalog"
                        | "getQueryColumns"
                )
                && let Some(metadata) = xlsx::metadata(self, id, control)?
            {
                value["workbook_metadata"] = metadata;
            }
        }
        result
    }
    fn discard(&mut self, method: &str, result: Value) {
        match method {
            "open" => {
                if let Some(id) = result["session"].as_str() {
                    self.sources.remove(id);
                    self.resources.release_session(id);
                    self.sessions.close(id);
                }
            }
            "runQuery" | "runSortedQuery" | "runChartQuery" | "runDetectedTableQuery" => {
                let page = if method == "runChartQuery" {
                    &result["result"]
                } else {
                    &result
                };
                if let Some(handle) = page["resource"]["id"].as_str() {
                    self.resources.release(handle);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Source(std::path::PathBuf);
    impl Source {
        fn csv() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "dfv-table-read-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir(&dir).unwrap();
            let path = dir.join("rows.csv");
            std::fs::write(&path, b"id,name\n1,alpha\n2,beta\n3,gamma\n").unwrap();
            Self(path)
        }
    }
    impl Drop for Source {
        fn drop(&mut self) {
            std::fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
        }
    }
    fn call(tables: &mut Tables, method: &str, args: Value) -> Result<Value, ErrorBody> {
        tables.call(method, args.as_object().unwrap(), &Control::unbounded())
    }
    fn open(tables: &mut Tables, source: &Source) -> String {
        let result = call(
            tables,
            "open",
            json!({"path":source.0,"force_read_only":true}),
        )
        .unwrap();
        assert_eq!(result["read_only"], true);
        assert_eq!(result["file_kind"], "csv");
        result["session"].as_str().unwrap().to_owned()
    }
    #[test]
    fn real_csv_catalog_exact_query_paging_release_and_close_preserve_source() {
        let source = Source::csv();
        let original = std::fs::read(&source.0).unwrap();
        let mut tables = Tables::default();
        let id = open(&mut tables, &source);
        let catalog = call(&mut tables, "getQueryCatalog", json!({"session":id})).unwrap();
        assert_eq!(catalog["relations"][0]["name"], "rows");
        let page = call(&mut tables,"runQuery",json!({"session":id,"sql":"select id, name, 9007199254740993::BIGINT as exact from rows order by id","page_size":1,"max_rows":2})).unwrap();
        assert_eq!(page["rows"][0][1], "alpha");
        assert_eq!(
            page["rows"][0][2],
            json!({"$t":"int64","v":"9007199254740993"})
        );
        assert_eq!(page["page"]["next_offset"], "1");
        assert_eq!(page["page"]["total_rows"], Value::Null);
        assert_eq!(page["page"]["truncated"], true);
        let handle = page["resource"]["id"].as_str().unwrap();
        let next = call(
            &mut tables,
            "readResource",
            json!({"resource":handle,"offset":"1","page_size":1}),
        )
        .unwrap();
        assert_eq!(next["rows"][0][1], "beta");
        assert_eq!(next["page"]["next_offset"], Value::Null);
        assert_eq!(
            call(&mut tables, "releaseResource", json!({"resource":handle})).unwrap()["released"],
            true
        );
        assert_eq!(
            call(&mut tables, "readResource", json!({"resource":handle}))
                .unwrap_err()
                .code,
            NOT_OPEN
        );
        assert_eq!(
            call(&mut tables, "close", json!({"session":id})).unwrap()["closed"],
            true
        );
        assert_eq!(
            call(&mut tables, "getQueryCatalog", json!({"session":id}))
                .unwrap_err()
                .code,
            NOT_OPEN
        );
        assert_eq!(std::fs::read(&source.0).unwrap(), original);
    }
    #[test]
    fn catalog_continues_past_one_hundred_relations_without_hiding_tables() {
        let mut source = Source::csv();
        source.0.set_file_name("catalog.duckdb");
        {
            let connection = duckdb::Connection::open(&source.0).unwrap();
            let sql = (0..105)
                .map(|i| format!("create table table_{i:03}(id bigint); "))
                .collect::<String>();
            connection.execute_batch(&sql).unwrap();
        }
        let original = std::fs::read(&source.0).unwrap();
        let mut tables = Tables::default();
        let opened = call(&mut tables, "open", json!({"path":source.0})).unwrap();
        let id = opened["session"].as_str().unwrap();
        let first = call(&mut tables, "getQueryCatalog", json!({"session":id})).unwrap();
        assert_eq!(first["relations"].as_array().unwrap().len(), 100);
        assert_eq!(first["next_offset"], "100");
        let second = call(
            &mut tables,
            "getQueryCatalog",
            json!({"session":id,"offset":first["next_offset"]}),
        )
        .unwrap();
        assert_eq!(second["relations"].as_array().unwrap().len(), 5);
        assert_eq!(second["relations"][0]["name"], "table_100");
        assert_eq!(second["relations"][4]["name"], "table_104");
        assert_eq!(second["next_offset"], Value::Null);
        assert_eq!(std::fs::read(&source.0).unwrap(), original);
    }
    #[test]
    fn source_changes_invalidate_cached_results_and_the_old_connection() {
        let source = Source::csv();
        let mut tables = Tables::default();
        let id = open(&mut tables, &source);
        let page = call(
            &mut tables,
            "runQuery",
            json!({"session":id,"sql":"select * from rows"}),
        )
        .unwrap();
        let handle = page["resource"]["id"].as_str().unwrap();
        std::fs::write(&source.0, b"id,name\n1,delta\n2,beta\n3,gamma\n").unwrap();
        assert_eq!(
            call(&mut tables, "readResource", json!({"resource":handle}))
                .unwrap_err()
                .code,
            STALE_SOURCE
        );
        assert_eq!(
            call(
                &mut tables,
                "runQuery",
                json!({"session":id,"sql":"select * from rows"})
            )
            .unwrap_err()
            .code,
            NOT_OPEN
        );
        assert_eq!(tables.resources.count(), 0);
        assert_eq!(tables.resources.held_bytes(), 0);
        assert!(tables.sources.is_empty());
    }
    #[test]
    fn duckdb_journals_invalidate_cached_pages_without_changing_main_file() {
        for suffix in [".wal", ".wal.checkpoint", ".wal.recovery"] {
            let mut source = Source::csv();
            source.0.set_file_name("journal.duckdb");
            {
                let connection = duckdb::Connection::open(&source.0).unwrap();
                connection
                    .execute_batch("create table rows as select 42 as id")
                    .unwrap();
            }
            let original = std::fs::read(&source.0).unwrap();
            let mut tables = Tables::default();
            let opened = call(&mut tables, "open", json!({"path":source.0})).unwrap();
            let id = opened["session"].as_str().unwrap();
            let page = call(
                &mut tables,
                "runQuery",
                json!({"session":id,"sql":"select * from rows"}),
            )
            .unwrap();
            let handle = page["resource"]["id"].as_str().unwrap();
            let mut journal = source.0.as_os_str().to_owned();
            journal.push(suffix);
            let journal = std::path::PathBuf::from(journal);
            std::fs::write(&journal, b"external journal sentinel").unwrap();
            assert_eq!(
                call(&mut tables, "readResource", json!({"resource":handle}))
                    .unwrap_err()
                    .code,
                STALE_SOURCE
            );
            assert_eq!(tables.resources.count(), 0);
            assert!(!tables.sources.contains_key(id));
            assert_eq!(
                call(
                    &mut tables,
                    "runQuery",
                    json!({"session":id,"sql":"select 1"})
                )
                .unwrap_err()
                .code,
                NOT_OPEN
            );
            assert_eq!(std::fs::read(&source.0).unwrap(), original);
            assert_eq!(
                std::fs::read(&journal).unwrap(),
                b"external journal sentinel"
            );
        }
    }
    #[test]
    fn cancellation_still_interrupts_after_an_earlier_statement_consumes_it() {
        let source = Source::csv();
        let engine = Engine::open(&source.0).unwrap();
        let control = Control::unbounded();
        let start = std::time::Instant::now();
        let result = controlled(&engine, &control, || {
            control.cancel();
            for _ in 0..10 {
                std::thread::sleep(Duration::from_millis(10));
                let _ = engine.run_query_wire("select 1", 1);
            }
            engine.run_query_wire(
                "select sum(a.range * b.range) from range(100000) a, range(100000) b",
                1,
            )
        });
        assert_eq!(result.unwrap_err().code, CANCELLED);
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(engine.run_query_wire("select 1", 1).is_ok());
    }
    #[test]
    fn policy_bounds_and_deadline_refusals_leave_the_connection_usable() {
        let source = Source::csv();
        let original = std::fs::read(&source.0).unwrap();
        let mut tables = Tables::default();
        let id = open(&mut tables, &source);
        let refusal = call(
            &mut tables,
            "runQuery",
            json!({"session":id,"sql":"delete from rows where name='private-secret'"}),
        )
        .unwrap_err();
        assert_eq!(refusal.code, POLICY_REFUSED);
        assert!(!refusal.message.contains("private-secret"));
        assert_eq!(
            call(
                &mut tables,
                "runQuery",
                json!({"session":id,"sql":"select 1","page_size":1001})
            )
            .unwrap_err()
            .code,
            MALFORMED_VALUE
        );
        let control = Control::new(std::time::Instant::now() + Duration::from_millis(30));
        let start = std::time::Instant::now();
        let heavy = json!({"session":id,"sql":"select sum(a.range * b.range) from range(100000) a, range(100000) b"});
        assert_eq!(
            tables
                .call("runQuery", heavy.as_object().unwrap(), &control)
                .unwrap_err()
                .code,
            DEADLINE_EXCEEDED
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(
            call(
                &mut tables,
                "runQuery",
                json!({"session":id,"sql":"select 1"})
            )
            .is_ok()
        );
        assert_eq!(std::fs::read(&source.0).unwrap(), original);
    }

    /// Every read method, with a heavy aggregate under it, stops promptly on a deadline or a cancel,
    /// leaves no resource behind and leaves the connection usable.
    #[test]
    fn every_read_method_is_stopped_by_deadline_and_cancel_and_leaves_nothing_behind() {
        const HEAVY: &str =
            "select sum(a.range * b.range) as n from range(100000) a, range(100000) b";
        let source = Source::csv();
        let original = std::fs::read(&source.0).unwrap();
        let mut tables = Tables::default();
        let id = open(&mut tables, &source);
        let methods = [
            ("runQuery", json!({"sql":HEAVY})),
            (
                "runSortedQuery",
                json!({"sql":HEAVY,"column":"n","direction":"asc"}),
            ),
            (
                "runChartQuery",
                json!({"sql":HEAVY,"x_column":"n","y_columns":["n"]}),
            ),
            ("countMatchingRows", json!({"sql":HEAVY})),
            (
                "getColumnTopValues",
                json!({"sql":HEAVY,"column":"n","limit":5}),
            ),
            (
                "getColumnDescriptiveStats",
                json!({"sql":HEAVY,"column":"n","stats_kind":"numeric"}),
            ),
        ];
        for (method, mut args) in methods {
            args["session"] = json!(id);
            let args = args.as_object().unwrap();
            let start = std::time::Instant::now();
            let control = Control::new(std::time::Instant::now() + Duration::from_millis(50));
            assert_eq!(
                tables.call(method, args, &control).unwrap_err().code,
                DEADLINE_EXCEEDED,
                "{method}"
            );
            let control = Control::unbounded();
            let outcome = std::thread::scope(|scope| {
                scope.spawn(|| {
                    std::thread::sleep(Duration::from_millis(50));
                    control.cancel();
                });
                tables.call(method, args, &control)
            });
            assert_eq!(outcome.unwrap_err().code, CANCELLED, "{method}");
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "{method} took {:?}",
                start.elapsed()
            );
            assert_eq!(
                (tables.resources.count(), tables.resources.held_bytes()),
                (0, 0),
                "{method}"
            );
            assert!(
                call(
                    &mut tables,
                    "runQuery",
                    json!({"session":id,"sql":"select 1"})
                )
                .is_ok(),
                "{method} left the connection unusable"
            );
            tables.resources.release_session(&id);
        }
        assert_eq!(std::fs::read(&source.0).unwrap(), original);
    }

    #[test]
    fn chart_default_cap_accepts_row_and_date_axes_without_raising_ordinary_read_limits() {
        let source = Source::csv();
        let original = std::fs::read(&source.0).unwrap();
        let mut tables = Tables::default();
        let id = open(&mut tables, &source);
        for (sql, axis_args, expected) in [
            (
                "select * from rows",
                json!({"x_column":"Row","y_columns":["id"],"x_is_row":true}),
                "category",
            ),
            (
                "select '2024-01-01' as when_seen,id from rows",
                json!({"x_column":"when_seen","y_columns":["id"],"x_as_date":true}),
                "time",
            ),
        ] {
            let mut args = axis_args;
            args["session"] = json!(id);
            args["sql"] = json!(sql);
            args["max_points"] = json!(200_000);
            let chart = call(&mut tables, "runChartQuery", args.clone()).unwrap();
            assert_eq!(chart["x_axis_mode"], expected);
            assert_eq!(chart["result"]["rows"].as_array().unwrap().len(), 3);
            let resource = chart["result"]["resource"]["id"].as_str().unwrap();
            tables.resources.release(resource);
            args["max_points"] = json!(200_001);
            assert_eq!(
                call(&mut tables, "runChartQuery", args).unwrap_err().code,
                MALFORMED_VALUE
            );
        }
        assert_eq!(
            call(
                &mut tables,
                "runQuery",
                json!({"session":id,"sql":"select * from rows","max_rows":100_001})
            )
            .unwrap_err()
            .code,
            MALFORMED_VALUE
        );
        assert_eq!(std::fs::read(&source.0).unwrap(), original);
    }

    #[test]
    fn read_methods_return_exact_typed_answers_and_malformed_arguments_are_refused() {
        let source = Source::csv();
        let mut tables = Tables::default();
        let id = open(&mut tables, &source);
        let sorted = call(&mut tables, "runSortedQuery", json!({"session":id,"sql":"select * from rows limit 2","column":"id","direction":"desc"})).unwrap();
        assert_eq!(sorted["rows"][0][1], "gamma");
        assert!(
            sorted["sql"]
                .as_str()
                .unwrap()
                .contains("order by \"id\" desc nulls last limit 2")
        );
        assert_eq!(
            call(
                &mut tables,
                "countMatchingRows",
                json!({"session":id,"sql":"select * from rows limit 1"})
            )
            .unwrap()["count"],
            "3"
        );
        // An unusable query is a typed refusal here, where the reference answers "unknown".
        assert_eq!(
            call(
                &mut tables,
                "countMatchingRows",
                json!({"session":id,"sql":"drop table rows"})
            )
            .unwrap_err()
            .code,
            POLICY_REFUSED
        );
        let top = call(
            &mut tables,
            "getColumnTopValues",
            json!({"session":id,"sql":"select * from rows","column":"name","limit":0}),
        )
        .unwrap();
        assert_eq!(
            (
                top["total_rows"].clone(),
                top["top_values"].as_array().unwrap().len()
            ),
            (json!("3"), 3)
        );
        let stats = call(&mut tables, "getColumnDescriptiveStats", json!({"session":id,"sql":"select 9007199254740993::BIGINT as b","column":"b","stats_kind":"numeric"})).unwrap();
        assert_eq!(stats["max"], json!({"$t":"int64","v":"9007199254740993"}));
        let chart = call(&mut tables, "runChartQuery", json!({"session":id,"sql":"select * from rows","x_column":"name","y_columns":["id"],"x_is_text":true})).unwrap();
        assert_eq!(chart["x_axis_mode"], "category");
        assert_eq!(chart["result"]["rows"][0][0], "alpha");
        let cols = call(
            &mut tables,
            "getQueryColumns",
            json!({"session":id,"catalog":"memory","schema":"main","name":"rows"}),
        )
        .unwrap();
        assert_eq!(cols["columns"][0]["name"], "id");
        for (method, args) in [
            (
                "runSortedQuery",
                json!({"sql":"select 1 as a","column":"a","direction":"sideways"}),
            ),
            (
                "runChartQuery",
                json!({"sql":"select 1 as a","x_column":"a","y_columns":[]}),
            ),
            (
                "runChartQuery",
                json!({"sql":"select 1 as a","x_column":"a","y_columns":["a"],"x_is_text":"yes"}),
            ),
            (
                "getColumnDescriptiveStats",
                json!({"sql":"select 1 as a","column":"a","stats_kind":"other"}),
            ),
            (
                "getColumnTopValues",
                json!({"sql":"select 1 as a","column":"a","limit":-1}),
            ),
            (
                "getQueryColumns",
                json!({"catalog":"memory","schema":"main"}),
            ),
        ] {
            let mut args = args;
            args["session"] = json!(id);
            assert_eq!(
                call(&mut tables, method, args).unwrap_err().code,
                MALFORMED_VALUE,
                "{method}"
            );
        }
        assert_eq!(
            tables.resources.count(),
            2,
            "the sorted and chart results are held"
        );
        assert_eq!(
            call(&mut tables, "close", json!({"session":id})).unwrap()["released"],
            2
        );
        assert_eq!(
            (tables.resources.count(), tables.resources.held_bytes()),
            (0, 0)
        );
    }

    #[cfg(unix)]
    mod late_results {
        use super::*;
        use std::io::{BufRead, BufReader, Write};
        use std::net::Shutdown;
        use std::os::unix::net::UnixStream;
        use std::sync::mpsc::{Receiver, Sender};

        struct GatedTables {
            tables: Tables,
            method: Option<&'static str>,
            allocated: Sender<Value>,
            resume: Receiver<()>,
            discarded: Sender<(usize, usize, usize, usize)>,
        }
        impl Lane for GatedTables {
            fn capabilities(&self) -> Capabilities {
                self.tables.capabilities()
            }
            fn router(&self) -> fn(&str, &Map<String, Value>) -> Route {
                self.tables.router()
            }
            fn call(
                &mut self,
                method: &str,
                args: &Map<String, Value>,
                control: &Control,
            ) -> Result<Value, ErrorBody> {
                let result = self.tables.call(method, args, control);
                if self.method == Some(method)
                    && let Ok(value) = &result
                {
                    self.method = None;
                    self.allocated.send(value.clone()).unwrap();
                    self.resume.recv().unwrap();
                }
                result
            }
            fn discard(&mut self, method: &str, result: Value) {
                self.tables.discard(method, result);
                self.discarded
                    .send((
                        self.tables.sessions.count(),
                        self.tables.sources.len(),
                        self.tables.resources.count(),
                        self.tables.resources.held_bytes(),
                    ))
                    .unwrap();
            }
        }

        fn send(socket: &mut UnixStream, id: u64, method: &str, args: Value, deadline: u64) {
            writeln!(socket, "{}", json!({"protocol":"dfv-table","version":1,"kind":"request","id":id.to_string(),"method":method,"args":args,"deadline_ms":deadline.to_string()})).unwrap();
        }
        fn reply(reader: &mut BufReader<UnixStream>) -> Value {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            serde_json::from_str(&line).unwrap()
        }

        fn check_discard(method: &'static str, stop: &str) {
            let source = Source::csv();
            let before = std::fs::read(&source.0).unwrap();
            let (allocated_tx, allocated) = mpsc::channel();
            let (resume, resume_rx) = mpsc::channel();
            let (discard_tx, discarded) = mpsc::channel();
            let (mut socket, server) = UnixStream::pair().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let input = BufReader::new(server.try_clone().unwrap());
            let worker = std::thread::spawn(move || {
                dfv_table_protocol::serve_scheduled(
                    move || GatedTables {
                        tables: Tables::default(),
                        method: Some(method),
                        allocated: allocated_tx,
                        resume: resume_rx,
                        discarded: discard_tx,
                    },
                    input,
                    server,
                    dfv_table_protocol::Limits::default(),
                )
                .unwrap()
            });
            assert_eq!(reply(&mut reader)["kind"], "capabilities");
            let (id, args) = if method == "open" {
                (None, json!({"path":source.0}))
            } else {
                send(&mut socket, 1, "open", json!({"path":source.0}), 10000);
                let opened = reply(&mut reader);
                assert_eq!(opened["ok"], true, "{opened}");
                let id = opened["result"]["session"].as_str().unwrap().to_owned();
                (
                    Some(id.clone()),
                    match method {
                        "runSortedQuery" => {
                            json!({"session":id,"sql":"select * from rows","column":"id","direction":"desc"})
                        }
                        "runChartQuery" => {
                            json!({"session":id,"sql":"select * from rows","x_column":"id","y_columns":["name"]})
                        }
                        _ => json!({"session":id,"sql":"select * from rows"}),
                    },
                )
            };
            send(
                &mut socket,
                2,
                method,
                args,
                if stop == "deadline" { 3000 } else { 10000 },
            );
            let owned = allocated.recv_timeout(Duration::from_secs(10)).unwrap();
            match stop {
                "cancel" => writeln!(
                    socket,
                    "{}",
                    json!({"protocol":"dfv-table","version":1,"kind":"cancel","id":"2"})
                )
                .unwrap(),
                "close" => send(
                    &mut socket,
                    3,
                    "close",
                    json!({"session":id.as_ref().unwrap()}),
                    10000,
                ),
                "deadline" => {}
                _ => unreachable!(),
            }
            let cancelled = reply(&mut reader);
            assert_eq!(cancelled["id"], "2");
            assert_eq!(
                cancelled["error"]["code"],
                if stop == "deadline" {
                    DEADLINE_EXCEEDED
                } else {
                    CANCELLED
                }
            );
            resume.send(()).unwrap();
            let remaining = discarded.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(
                remaining,
                if method == "open" {
                    (0, 0, 0, 0)
                } else {
                    (1, 1, 0, 0)
                },
                "late results must not retain unreported ownership"
            );
            let session = if method == "open" {
                send(&mut socket, 4, "open", json!({"path":source.0}), 10000);
                let reopened = reply(&mut reader);
                assert_eq!(
                    reopened["ok"], true,
                    "the cancelled open must release its source and slot"
                );
                reopened["result"]["session"].as_str().unwrap().to_owned()
            } else {
                if stop == "close" {
                    let closed = reply(&mut reader);
                    assert_eq!(closed["id"], "3");
                    assert_eq!(closed["result"]["closed"], true);
                    assert_eq!(closed["result"]["released"], 0);
                }
                let handle = if method == "runChartQuery" {
                    &owned["result"]["resource"]["id"]
                } else {
                    &owned["resource"]["id"]
                }
                .as_str()
                .unwrap();
                send(
                    &mut socket,
                    4,
                    "releaseResource",
                    json!({"resource":handle}),
                    10000,
                );
                assert_eq!(reply(&mut reader)["result"]["released"], false);
                id.unwrap()
            };
            send(&mut socket, 5, "close", json!({"session":session}), 10000);
            assert_eq!(reply(&mut reader)["ok"], true);
            socket.shutdown(Shutdown::Write).unwrap();
            assert_eq!(worker.join().unwrap(), 0);
            assert_eq!(std::fs::read(&source.0).unwrap(), before);
        }

        const RESULT_METHODS: [&str; 3] = ["runQuery", "runSortedQuery", "runChartQuery"];
        #[test]
        fn cancelled_real_open_and_query_results_release_unreported_ownership() {
            check_discard("open", "cancel");
            for method in RESULT_METHODS {
                check_discard(method, "cancel");
            }
        }
        #[test]
        fn expired_real_open_and_query_results_release_unreported_ownership() {
            check_discard("open", "deadline");
            for method in RESULT_METHODS {
                check_discard(method, "deadline");
            }
        }
        #[test]
        fn close_reclaims_a_completed_query_before_disposing_its_session() {
            for method in RESULT_METHODS {
                check_discard(method, "close");
            }
        }
    }
}
