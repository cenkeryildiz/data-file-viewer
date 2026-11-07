//! Query policy (`queryPolicy.ts`): host-owned limits, size budgets, the engine lock-down list and the
//! parser-backed read-only authorization. The AST comes from DuckDB's `json_serialize_sql`, supplied
//! through [`QueryEngine`] so this crate never links the engine.
use crate::safety::{is_js_space, is_word};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;

/// Host-owned limits; these are not grants that webview messages can change.
pub struct Limits {
    pub sql_bytes: usize,
    pub result_bytes: usize,
    pub cell_bytes: usize,
    pub catalog_bytes: usize,
    pub filters: usize,
    pub filter_chars: usize,
    pub queued_requests: usize,
    pub deadline_ms: u64,
}
pub const QUERY_LIMITS: Limits = Limits {
    sql_bytes: 256 * 1024,
    result_bytes: 32 * 1024 * 1024,
    cell_bytes: 4 * 1024 * 1024,
    catalog_bytes: 1024 * 1024,
    filters: 100,
    filter_chars: 4000,
    queued_requests: 8,
    deadline_ms: 30_000,
};

/// Why a request was refused, before anything reached the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    SqlSize,
    NotSingleSelect,
    ExternalReader,
    FunctionUnavailable,
    RelationUnavailable,
    ViewNotInspectable,
    ViewNesting,
    SqlNesting,
    CellSize,
    ResultSize,
    Engine,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::SqlSize => "sql_size",
            Self::NotSingleSelect => "not_single_select",
            Self::ExternalReader => "external_reader",
            Self::FunctionUnavailable => "function_unavailable",
            Self::RelationUnavailable => "relation_unavailable",
            Self::ViewNotInspectable => "view_not_inspectable",
            Self::ViewNesting => "view_nesting",
            Self::SqlNesting => "sql_nesting",
            Self::CellSize => "cell_size",
            Self::ResultSize => "result_size",
            Self::Engine => "engine",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyError {
    pub kind: Refusal,
    pub message: String,
}
impl PolicyError {
    pub fn new(kind: Refusal, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}
impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for PolicyError {}

const SQL_SIZE_MESSAGE: &str = "Enter a SQL query no larger than 256 KiB.";

pub fn validate_sql_size(sql: &str) -> Result<(), PolicyError> {
    if sql.trim_matches(is_js_space).is_empty() || sql.len() > QUERY_LIMITS.sql_bytes {
        return Err(PolicyError::new(Refusal::SqlSize, SQL_SIZE_MESSAGE));
    }
    Ok(())
}
/// For untyped webview payloads: anything that is not a string is refused like an empty one.
pub fn validate_sql_value(sql: &Value) -> Result<&str, PolicyError> {
    let text = sql
        .as_str()
        .ok_or_else(|| PolicyError::new(Refusal::SqlSize, SQL_SIZE_MESSAGE))?;
    validate_sql_size(text)?;
    Ok(text)
}

/// Half the cores, never fewer than one: a runaway query can take at most half the machine until the
/// parent's deadline stops it. Computed per machine, not fixed.
pub fn reader_threads() -> usize {
    reader_threads_for(std::thread::available_parallelism().map_or(1, usize::from))
}
pub fn reader_threads_for(cores: usize) -> usize {
    (cores / 2).max(1)
}

/// Statements the engine must run, in order, after host-selected extension bootstrap and before
/// binding dataset views. `paths` must be canonical host-derived paths, never SQL or webview input.
/// `lock_configuration` is last so none of the earlier settings can be reopened. This is an engine
/// capability restriction, not a sandbox for native-code exploits. With the native DuckDB API the same
/// names may instead be applied through `Config` before open; the resulting settings must be identical.
pub fn engine_restrictions(paths: &[&str], threads: usize) -> Vec<String> {
    let literals = paths
        .iter()
        .map(|p| format!("'{}'", p.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    vec![
        format!("set allowed_paths = [{literals}]"),
        "set autoinstall_known_extensions = false".into(),
        "set autoload_known_extensions = false".into(),
        "set allow_persistent_secrets = false".into(),
        "set enable_external_access = false".into(),
        "set memory_limit = '512MB'".into(),
        format!("set threads = {threads}"),
        "set max_temp_directory_size = '0B'".into(),
        "set enable_logging = false".into(),
        "set lock_configuration = true".into(),
    ]
}
/// Settings the engine must read back from `duckdb_settings()` after the lock-down (name, value).
/// `threads` is `reader_threads()` and is checked separately.
pub const LOCKED_SETTING_READBACK: [(&str, &str); 2] = [
    ("enable_external_access", "false"),
    ("max_temp_directory_size", "0 bytes"),
];
/// Statements that must fail once locked; the engine should self-test them at startup.
pub const MUST_FAIL_AFTER_LOCK: [&str; 4] = [
    "set enable_external_access=true",
    "set lock_configuration=false",
    "set autoload_known_extensions=true",
    "set allowed_paths=['/']",
];

fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

struct CountingWriter(usize);
impl std::io::Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Refuse large values explicitly; never present clipped text as complete data.
pub fn validate_result_size(value: &Value) -> Result<(), PolicyError> {
    let too_big = || {
        PolicyError::new(
            Refusal::ResultSize,
            "Query result exceeds 32 MiB. Select fewer columns or rows.",
        )
    };
    let mut stack = vec![value];
    let mut string_bytes = 0usize;
    while let Some(item) = stack.pop() {
        match item {
            Value::String(s) => {
                if s.len() > QUERY_LIMITS.cell_bytes {
                    return Err(PolicyError::new(
                        Refusal::CellSize,
                        "A result value exceeds 4 MiB. Select fewer columns or explicitly shorten that value in SQL.",
                    ));
                }
                string_bytes += s.len();
                if string_bytes > QUERY_LIMITS.result_bytes {
                    return Err(too_big());
                }
            }
            Value::Array(items) => stack.extend(items),
            Value::Object(map) => stack.extend(map.values()),
            _ => {}
        }
    }
    let mut counter = CountingWriter(0);
    serde_json::to_writer(&mut counter, value)
        .map_err(|e| PolicyError::new(Refusal::Engine, e.to_string()))?;
    if counter.0 > QUERY_LIMITS.result_bytes {
        return Err(too_big());
    }
    Ok(())
}

/// A relation the host exposes to user SQL. `trusted_view`: a host-created format view built from approved paths.
#[derive(Debug, Clone, Default)]
pub struct QueryRelation {
    pub catalog: String,
    pub schema: String,
    pub name: String,
    pub trusted_view: bool,
    pub view_sql: Option<String>,
}

/// One row of the function catalog scan: `scalar_safe` = every overload internal, scalar/aggregate/macro
/// and free of side effects; `table_safe` = one of range/generate_series/unnest and internal.
#[derive(Debug, Clone)]
pub struct FunctionRow {
    pub name: String,
    pub scalar_safe: bool,
    pub table_safe: bool,
}

/// Both allowlists from one scan of the catalog (the scan is the cost, ~10 ms). The engine runs this.
pub const FUNCTION_CATALOG_SQL: &str = "select function_name,
           system.main.bool_and(internal)
             and system.main.bool_and(function_type in ('scalar','aggregate','macro'))
             and not system.main.bool_or(coalesce(has_side_effects,false)) as scalar_safe,
           function_name in ('range','generate_series','unnest') and system.main.bool_and(internal) as table_safe
         from system.main.duckdb_functions()
         group by function_name";
/// `json_serialize_sql(?::varchar)` is run on `inspection_sql(sql)`; this is the statement.
pub const SERIALIZE_SQL: &str = "select system.main.json_serialize_sql(?::varchar)";

/// The engine surface the policy needs; implemented over DuckDB by the worker.
pub trait QueryEngine {
    /// Parse `sql` (never executes it) and return the parsed JSON AST.
    fn serialize_sql(&mut self, sql: &str) -> Result<Value, PolicyError>;
    fn function_catalog(&mut self) -> Result<Vec<FunctionRow>, PolicyError>;
}

fn is_ws_at(s: &str, i: usize) -> bool {
    s[i..].chars().next().is_some_and(is_js_space)
}
fn word_boundary_at(b: &[u8], i: usize) -> bool {
    b.get(i).is_none_or(|c| !is_word(*c))
}
fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.as_bytes()
        .get(..prefix.len())
        .is_some_and(|h| h.eq_ignore_ascii_case(prefix.as_bytes()))
}

/// Remove only a read-only inspection wrapper (explain/describe/summarize) for AST authorization.
/// Execution always receives the original SQL.
pub fn inspection_sql(sql: &str) -> String {
    let mut start = 0;
    loop {
        while start < sql.len() && is_ws_at(sql, start) {
            start += sql[start..].chars().next().map_or(1, char::len_utf8);
        }
        if sql[start..].starts_with("--") {
            start = sql[start + 2..]
                .find('\n')
                .map_or(sql.len(), |e| start + 2 + e + 1);
            continue;
        }
        if sql[start..].starts_with("/*") {
            let mut depth = 1;
            start += 2;
            while start < sql.len() && depth > 0 {
                if sql[start..].starts_with("/*") {
                    depth += 1;
                    start += 2;
                } else if sql[start..].starts_with("*/") {
                    depth -= 1;
                    start += 2;
                } else {
                    start += sql[start..].chars().next().map_or(1, char::len_utf8);
                }
            }
            continue;
        }
        break;
    }
    let text = &sql[start..];
    let tb = text.as_bytes();
    // ^(explain(?:\s+analyze)?|describe|summarize)\b\s*  — with regex backtracking from "explain analyze" to "explain".
    let mut kw_len = None;
    if starts_with_ci(text, "explain") {
        let mut j = 7;
        let ws_start = j;
        while j < text.len() && is_ws_at(text, j) {
            j += text[j..].chars().next().map_or(1, char::len_utf8);
        }
        if j > ws_start && starts_with_ci(&text[j..], "analyze") && word_boundary_at(tb, j + 7) {
            kw_len = Some(j + 7);
        } else if word_boundary_at(tb, 7) {
            kw_len = Some(7);
        }
    } else if starts_with_ci(text, "describe") && word_boundary_at(tb, 8) {
        kw_len = Some(8);
    } else if starts_with_ci(text, "summarize") && word_boundary_at(tb, 9) {
        kw_len = Some(9);
    }
    let Some(mut end) = kw_len else {
        return sql.to_owned();
    };
    let explain = starts_with_ci(text, "explain");
    while end < text.len() && is_ws_at(text, end) {
        end += text[end..].chars().next().map_or(1, char::len_utf8);
    }
    let inner = &text[end..];
    if explain {
        return inner.to_owned();
    }
    let selects = ["select", "with", "from"]
        .iter()
        .any(|k| starts_with_ci(inner, k) && word_boundary_at(inner.as_bytes(), k.len()));
    if selects {
        inner.to_owned()
    } else {
        format!("SELECT * FROM {inner}")
    }
}

/// Syntactic table references. `getTableNames` would expand existing views and lose worksheet names;
/// the serialized AST preserves references without interpreting quoted text as one.
pub fn referenced_tables(ast: &Value) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut stack = vec![ast];
    while let Some(node) = stack.pop() {
        match node {
            Value::Array(items) => stack.extend(items),
            Value::Object(map) => {
                if map.get("type").and_then(Value::as_str) == Some("BASE_TABLE") {
                    names.insert(js_str(map.get("table_name")));
                }
                stack.extend(map.values());
            }
            _ => {}
        }
    }
    names
}
pub fn referenced_query_tables(
    engine: &mut dyn QueryEngine,
    sql: &str,
) -> Result<HashSet<String>, PolicyError> {
    Ok(referenced_tables(
        &engine.serialize_sql(&inspection_sql(sql))?,
    ))
}

/// The SELECT body of DuckDB's canonical `CREATE VIEW` text. The body is parsed by the engine afterwards;
/// this header scanner never interprets it.
pub fn view_body(sql: &str) -> Result<&str, PolicyError> {
    let b = sql.as_bytes();
    let (mut i, mut depth) = (0, 0i32);
    while i < b.len() {
        let ch = b[i];
        if ch == b'"' || ch == b'\'' {
            i += 1;
            while i < b.len() {
                let c = b[i];
                i += 1;
                if c != ch {
                    continue;
                }
                if b.get(i) == Some(&ch) {
                    i += 1;
                    continue;
                }
                break;
            }
        } else if ch == b'(' {
            depth += 1;
            i += 1;
        } else if ch == b')' {
            depth -= 1;
            i += 1;
        } else if ch.is_ascii_alphabetic() || ch == b'_' {
            let start = i;
            i += 1;
            while i < b.len() && is_word(b[i]) {
                i += 1;
            }
            if depth == 0 && sql[start..i].eq_ignore_ascii_case("as") {
                return Ok(&sql[i..]);
            }
        } else {
            i += 1;
        }
    }
    Err(PolicyError::new(
        Refusal::ViewNotInspectable,
        "This stored view cannot be inspected safely.",
    ))
}

fn denied_function(name: &str) -> bool {
    const PREFIXES: [&str; 6] = [
        "duckdb_",
        "pragma_",
        "read_",
        "sqlite_",
        "json_execute",
        "write_",
    ];
    const EXACT: [&str; 7] = [
        "query",
        "query_table",
        "current_setting",
        "getenv",
        "which_secret",
        "nextval",
        "setseed",
    ];
    PREFIXES.iter().any(|p| name.starts_with(p)) || EXACT.contains(&name)
}

/// Parser-backed authorization of user expressions. Binding and execution still run under the locked
/// engine policy; generated host schema queries never enter this user-facing channel.
pub struct ReadSqlPolicy<'a, E: QueryEngine> {
    engine: &'a mut E,
    catalog: String,
    functions: Option<(HashSet<String>, HashSet<String>)>,
}

impl<'a, E: QueryEngine> ReadSqlPolicy<'a, E> {
    pub fn new(engine: &'a mut E, catalog: impl Into<String>) -> Self {
        Self {
            engine,
            catalog: catalog.into(),
            functions: None,
        }
    }

    pub fn validate(&mut self, sql: &str, relations: &[QueryRelation]) -> Result<(), PolicyError> {
        validate_sql_size(sql)?;
        if self.functions.is_none() {
            let rows = self.engine.function_catalog()?;
            let pick = |f: fn(&FunctionRow) -> bool| {
                rows.iter()
                    .filter(|r| f(r))
                    .map(|r| r.name.to_lowercase())
                    .collect::<HashSet<_>>()
            };
            self.functions = Some((pick(|r| r.scalar_safe), pick(|r| r.table_safe)));
        }
        self.inspect(sql, relations, &mut HashSet::new(), 0)
    }

    fn inspect(
        &mut self,
        text: &str,
        relations: &[QueryRelation],
        inspected: &mut HashSet<String>,
        view_depth: u32,
    ) -> Result<(), PolicyError> {
        if view_depth > 32 {
            return Err(PolicyError::new(
                Refusal::ViewNesting,
                "Stored view nesting exceeds the query limit.",
            ));
        }
        let ast = self.engine.serialize_sql(&inspection_sql(text))?;
        let statements = ast.get("statements").and_then(Value::as_array);
        if js_truthy(ast.get("error")) || statements.is_none_or(|s| s.len() != 1) {
            return Err(PolicyError::new(
                Refusal::NotSingleSelect,
                "Enter one SELECT query. SQL writes and configuration commands are unavailable; use the existing cell editor for changes.",
            ));
        }
        self.walk(&ast, 0, &HashSet::new(), relations, inspected, view_depth)
    }

    fn walk(
        &mut self,
        node: &Value,
        depth: u32,
        inherited: &HashSet<String>,
        relations: &[QueryRelation],
        inspected: &mut HashSet<String>,
        view_depth: u32,
    ) -> Result<(), PolicyError> {
        if depth > 256 {
            return Err(PolicyError::new(
                Refusal::SqlNesting,
                "SQL nesting exceeds the query limit.",
            ));
        }
        match node {
            Value::Array(items) => {
                for v in items {
                    self.walk(v, depth + 1, inherited, relations, inspected, view_depth)?;
                }
                return Ok(());
            }
            Value::Object(_) => {}
            _ => return Ok(()),
        }
        let n = node.as_object().expect("checked object");
        let mut ctes = inherited.clone();
        if let Some(entries) = n
            .get("cte_map")
            .and_then(|m| m.get("map"))
            .and_then(Value::as_array)
        {
            ctes.extend(entries.iter().map(|e| js_str(e.get("key")).to_lowercase()));
        }
        let (functions, table_functions) = self.functions.as_ref().expect("loaded by validate");
        let kind = n.get("type").and_then(Value::as_str);
        if kind == Some("TABLE_FUNCTION") {
            let name =
                js_str(n.get("function").and_then(|f| f.get("function_name"))).to_lowercase();
            if !table_functions.contains(&name) {
                return Err(PolicyError::new(
                    Refusal::ExternalReader,
                    "Query the opened document tables. External readers and system table functions are unavailable.",
                ));
            }
        }
        if n.get("class").and_then(Value::as_str) == Some("FUNCTION") {
            let name = js_str(n.get("function_name")).to_lowercase();
            let safe_table = table_functions.contains(&name);
            let schema = n.get("schema");
            if (!functions.contains(&name) && !safe_table)
                || denied_function(&name)
                || js_truthy(n.get("catalog"))
                || (js_truthy(schema) && schema.and_then(Value::as_str) != Some("main"))
            {
                return Err(PolicyError::new(
                    Refusal::FunctionUnavailable,
                    "This function is unavailable in document queries.",
                ));
            }
        }
        if kind == Some("BASE_TABLE") {
            let name = js_str(n.get("table_name"));
            let (cat, sch) = (n.get("catalog_name"), n.get("schema_name"));
            if !js_truthy(cat) && !js_truthy(sch) && ctes.contains(&name.to_lowercase()) {
                return Ok(());
            }
            let want_cat = if js_truthy(cat) {
                js_str(cat)
            } else {
                self.catalog.clone()
            }
            .to_lowercase();
            let want_sch = if js_truthy(sch) {
                js_str(sch)
            } else {
                "main".into()
            }
            .to_lowercase();
            let relation = relations
                .iter()
                .find(|r| r.name.to_lowercase() == name.to_lowercase() && r.catalog.to_lowercase() == want_cat && r.schema.to_lowercase() == want_sch)
                .ok_or_else(|| {
                    PolicyError::new(Refusal::RelationUnavailable, "Select a table from this document’s query catalog. System and unrelated catalogs are unavailable.")
                })?;
            if let Some(view_sql) = relation
                .view_sql
                .as_deref()
                .filter(|_| !relation.trusted_view)
            {
                let key =
                    serde_json::to_string(&[&relation.catalog, &relation.schema, &relation.name])
                        .unwrap_or_default();
                if inspected.insert(key) {
                    self.inspect(view_body(view_sql)?, relations, inspected, view_depth + 1)?;
                }
            }
        }
        for v in n.values() {
            self.walk(v, depth + 1, &ctes, relations, inspected, view_depth)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    // ---- AST builders: the shape DuckDB's json_serialize_sql emits (empty strings for absent names). ----
    fn sel(select_list: Value, from: Value) -> Value {
        json!({"error": false, "statements": [{"node": {"type": "SELECT_NODE", "cte_map": {"map": []}, "select_list": select_list, "from_table": from}}]})
    }
    fn base(name: &str) -> Value {
        json!({"type": "BASE_TABLE", "catalog_name": "", "schema_name": "", "table_name": name})
    }
    fn base_in(catalog: &str, schema: &str, name: &str) -> Value {
        json!({"type": "BASE_TABLE", "catalog_name": catalog, "schema_name": schema, "table_name": name})
    }
    fn func(name: &str) -> Value {
        json!({"class": "FUNCTION", "type": "FUNCTION", "function_name": name, "schema": "", "catalog": "", "children": []})
    }
    fn table_func(name: &str) -> Value {
        json!({"type": "TABLE_FUNCTION", "function": func(name)})
    }
    fn star() -> Value {
        json!([{"class": "STAR"}])
    }
    fn error_ast() -> Value {
        json!({"error": true, "error_type": "not implemented"})
    }

    /// Maps (trimmed) inspection SQL to the AST DuckDB would return; anything unregistered is a parse error,
    /// so a policy that asks for the wrong text fails rather than passing by accident.
    #[derive(Default)]
    struct Fake {
        asts: HashMap<String, Value>,
        rows: Vec<FunctionRow>,
        asked: Vec<String>,
        catalog_scans: usize,
    }
    impl Fake {
        fn with(mut self, sql: &str, ast: Value) -> Self {
            self.asts.insert(sql.trim().to_owned(), ast);
            self
        }
    }
    impl QueryEngine for Fake {
        fn serialize_sql(&mut self, sql: &str) -> Result<Value, PolicyError> {
            self.asked.push(sql.to_owned());
            Ok(self.asts.get(sql.trim()).cloned().unwrap_or_else(error_ast))
        }
        fn function_catalog(&mut self) -> Result<Vec<FunctionRow>, PolicyError> {
            self.catalog_scans += 1;
            Ok(self.rows.clone())
        }
    }
    fn row(name: &str, scalar_safe: bool, table_safe: bool) -> FunctionRow {
        FunctionRow {
            name: name.into(),
            scalar_safe,
            table_safe,
        }
    }
    fn rows() -> Vec<FunctionRow> {
        vec![
            row("count", true, false),
            row("sum", true, false),
            row("Lower", true, false),
            row("range", false, true),
            row("generate_series", false, true),
            row("current_setting", true, false), // internal scalar: only the deny list stops it
            row("nextval", false, false),
            row("duckdb_databases", false, false),
            row("read_text", false, false),
        ]
    }
    fn relations() -> Vec<QueryRelation> {
        let view = |name: &str, sql: &str| QueryRelation {
            catalog: "memory".into(),
            schema: "main".into(),
            name: name.into(),
            view_sql: Some(sql.into()),
            ..Default::default()
        };
        vec![
            QueryRelation {
                catalog: "memory".into(),
                schema: "main".into(),
                name: "data".into(),
                ..Default::default()
            },
            view("good", "CREATE VIEW good AS SELECT * FROM data;"),
            view(
                "bad",
                "CREATE VIEW bad AS SELECT * FROM duckdb_databases();",
            ),
        ]
    }
    fn check(fake: &mut Fake, sql: &str) -> Result<(), PolicyError> {
        ReadSqlPolicy::new(fake, "memory").validate(sql, &relations())
    }
    fn fixture() -> Fake {
        let with_x = json!({"error": false, "statements": [{"node": {"type": "SELECT_NODE",
            "cte_map": {"map": [{"key": "X", "value": {"query": {"node": {"type": "SELECT_NODE", "from_table": base("data")}}}}]},
            "select_list": star(), "from_table": base("x")}}]});
        let join = sel(
            star(),
            json!({"type": "JOIN", "left": base("data"), "right": base("data")}),
        );
        let mut f = Fake {
            rows: rows(),
            ..Default::default()
        }
        .with("select * from data", sel(star(), base("data")))
        .with("SELECT * FROM data", sel(star(), base("data"))) // `describe data`
        .with("SELECT * FROM data;", sel(star(), base("data"))) // body of the stored `good` view
        .with("select * from good", sel(star(), base("good")))
        .with(
            "select count(*) from data where i > 0",
            sel(json!([func("count")]), base("data")),
        )
        .with("with x as (select * from data) select * from x", with_x)
        .with("select * from data a join data b on a.i=b.i", join)
        .with(
            "select sum(i) from range(10) t(i)",
            sel(json!([func("sum")]), table_func("range")),
        )
        .with("select * from bad", sel(star(), base("bad")))
        .with(
            "SELECT * FROM duckdb_databases();",
            sel(star(), table_func("duckdb_databases")),
        ) // body of `bad`
        .with(
            "SELECT * FROM duckdb_databases()",
            sel(star(), table_func("duckdb_databases")),
        );
        f = f.with(
            "select * from duckdb_databases()",
            sel(star(), table_func("duckdb_databases")),
        );
        f
    }

    // ---- ported from test/queryPolicy.test.ts ----
    #[test]
    fn sql_payload_budget_uses_bytes_and_rejects_invalid_values_before_engine_access() {
        let big = "é".repeat(131_073);
        for value in [
            json!(null),
            json!([]),
            json!({}),
            json!(""),
            json!(" "),
            json!(big),
            json!(12),
            json!(true),
        ] {
            assert_eq!(
                validate_sql_value(&value).unwrap_err().kind,
                Refusal::SqlSize,
                "{value}"
            );
        }
        assert!(validate_sql_value(&json!("select 1")).is_ok());
        assert!(validate_sql_value(&json!("x".repeat(262_144))).is_ok());
        let mut fake = fixture();
        assert_eq!(
            check(&mut fake, &"x".repeat(262_145)).unwrap_err().kind,
            Refusal::SqlSize
        );
        assert!(
            fake.asked.is_empty() && fake.catalog_scans == 0,
            "refused before touching the engine"
        );
    }

    #[test]
    fn ast_policy_accepts_ordinary_queries() {
        let mut fake = fixture();
        for sql in [
            "select * from data",
            "select * from good",
            "select count(*) from data where i > 0",
            "with x as (select * from data) select * from x",
            "select * from data a join data b on a.i=b.i",
            "select sum(i) from range(10) t(i)",
            "explain select * from data",
            "explain analyze select * from data",
            "describe data",
            "summarize select * from data",
            "/* outer /* nested */ comment */ explain select * from data",
        ] {
            check(&mut fake, sql).unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        assert_eq!(
            fake.catalog_scans, 11,
            "one scan per policy instance, not per query"
        );
    }

    #[test]
    fn ast_policy_rejects_side_effects_macros_and_metadata_through_views() {
        let nested_cte = json!({"error": false, "statements": [{"node": {"type": "SELECT_NODE",
            "cte_map": {"map": [{"key": "x", "value": {"query": {"node": {"type": "SELECT_NODE",
                "cte_map": {"map": [{"key": "sqlite_master", "value": {}}]}, "from_table": base("sqlite_master")}}}}]},
            "from_table": base("sqlite_master")}}]});
        let mut fake = fixture()
            .with("select secret()", sel(json!([func("secret")]), json!(null)))
            .with("select current_setting('temp_directory')", sel(json!([func("current_setting")]), json!(null)))
            .with("select * from information_schema.tables", sel(star(), base_in("", "information_schema", "tables")))
            .with("select * from backup_cmp.data", sel(star(), base_in("backup_cmp", "", "data")))
            .with("select * from read_text('/tmp/synthetic')", sel(star(), table_func("read_text")))
            .with("select 1; delete from data", json!({"error": false, "statements": [{}, {}]}))
            .with("select nextval('x')", sel(json!([func("nextval")]), json!(null)))
            .with("select * from main.range()", sel(json!([{"class": "FUNCTION", "function_name": "count", "schema": "pg_catalog", "catalog": ""}]), json!(null)))
            .with("select count(*) from c.count()", sel(json!([{"class": "FUNCTION", "function_name": "count", "schema": "", "catalog": "c"}]), json!(null)))
            .with("with x as (with sqlite_master as (select 1) select 1) select * from sqlite_master", nested_cte);
        let cases: [(&str, Refusal); 17] = [
            ("select * from bad", Refusal::ExternalReader),
            ("select secret()", Refusal::FunctionUnavailable),
            (
                "select current_setting('temp_directory')",
                Refusal::FunctionUnavailable,
            ),
            ("select * from duckdb_databases()", Refusal::ExternalReader),
            (
                "select * from information_schema.tables",
                Refusal::RelationUnavailable,
            ),
            (
                "select * from backup_cmp.data",
                Refusal::RelationUnavailable,
            ),
            (
                "select * from read_text('/tmp/synthetic')",
                Refusal::ExternalReader,
            ),
            ("select 1; delete from data", Refusal::NotSingleSelect),
            (
                "with x as (select 1) delete from data",
                Refusal::NotSingleSelect,
            ),
            ("call checkpoint()", Refusal::NotSingleSelect),
            ("select nextval('x')", Refusal::FunctionUnavailable),
            ("explain analyze select * from bad", Refusal::ExternalReader),
            ("describe duckdb_databases()", Refusal::ExternalReader),
            (
                "with x as (with sqlite_master as (select 1) select 1) select * from sqlite_master",
                Refusal::RelationUnavailable,
            ),
            ("select * from main.range()", Refusal::FunctionUnavailable),
            (
                "select count(*) from c.count()",
                Refusal::FunctionUnavailable,
            ),
            ("this is not sql", Refusal::NotSingleSelect),
        ];
        for (sql, kind) in cases {
            assert_eq!(check(&mut fake, sql).unwrap_err().kind, kind, "{sql}");
        }
    }

    #[test]
    fn result_budget_refuses_rather_than_truncating_a_large_single_value() {
        assert!(validate_result_size(&json!({"rows": [["unchanged"]]})).is_ok());
        assert_eq!(
            validate_result_size(&json!({"rows": [["x".repeat(32 * 1024 * 1024)]]}))
                .unwrap_err()
                .kind,
            Refusal::CellSize
        );
    }

    #[test]
    fn result_budget_enforces_cell_bytes_and_aggregate_payload_independently() {
        assert!(validate_result_size(&json!({"rows": [["x".repeat(4 * 1024 * 1024)]]})).is_ok());
        let e = validate_result_size(&json!({"rows": [["é".repeat(2 * 1024 * 1024 + 1)]]}))
            .unwrap_err();
        assert!(e.message.contains("4 MiB"), "{e}");
        let rows: Vec<Value> = (0..9)
            .map(|_| json!(["x".repeat(4 * 1024 * 1024)]))
            .collect();
        let e = validate_result_size(&json!({"rows": rows})).unwrap_err();
        assert!(e.message.contains("32 MiB"), "{e}");
        let ints: Vec<Value> = (0..200_000).map(|i| json!([i])).collect();
        assert!(validate_result_size(&json!({"rows": ints})).is_ok());
        // Serialized JSON can exceed the budget even when every string is small (many numbers).
        let wide: Vec<Value> = (0..4_000_000).map(|_| json!([1234567890123u64])).collect();
        assert_eq!(
            validate_result_size(&json!({"rows": wide}))
                .unwrap_err()
                .kind,
            Refusal::ResultSize
        );
    }

    #[test]
    fn engine_policy_locks_capabilities_bounds_memory_and_disables_spill() {
        let sql = engine_restrictions(&["/data/a.csv", "/data/o'brien.csv"], 5);
        assert_eq!(
            sql[0],
            "set allowed_paths = ['/data/a.csv','/data/o''brien.csv']"
        );
        assert_eq!(engine_restrictions(&[], 1)[0], "set allowed_paths = []");
        for needed in [
            "set autoinstall_known_extensions = false",
            "set autoload_known_extensions = false",
            "set allow_persistent_secrets = false",
            "set enable_external_access = false",
            "set memory_limit = '512MB'",
            "set threads = 5",
            "set max_temp_directory_size = '0B'",
            "set enable_logging = false",
        ] {
            assert!(sql.iter().any(|s| s == needed), "{needed}");
        }
        assert_eq!(
            sql.last().unwrap(),
            "set lock_configuration = true",
            "lock must follow every other setting"
        );
        assert_eq!(sql.len(), 10);
        assert_eq!(
            LOCKED_SETTING_READBACK[0],
            ("enable_external_access", "false")
        );
        assert!(MUST_FAIL_AFTER_LOCK.iter().all(|s| s.starts_with("set ")));
        assert!(
            !MUST_FAIL_AFTER_LOCK
                .iter()
                .any(|s| sql.iter().any(|a| a == s)),
            "self-test statements must differ from applied ones"
        );
    }

    #[test]
    fn reader_threads_is_half_the_cores_never_below_one() {
        assert_eq!(
            [
                reader_threads_for(0),
                reader_threads_for(1),
                reader_threads_for(2),
                reader_threads_for(10),
                reader_threads_for(11)
            ],
            [1, 1, 1, 5, 5]
        );
        assert!(reader_threads() >= 1);
    }

    #[test]
    fn user_macros_cannot_inherit_the_grants_for_builtin_range_functions() {
        // A user macro named range() makes the overload set non-internal, so neither allowlist keeps it.
        let mut fake = Fake {
            rows: vec![row("range", false, false)],
            ..Default::default()
        }
        .with("select range()", sel(json!([func("range")]), json!(null)));
        let e = ReadSqlPolicy::new(&mut fake, "memory")
            .validate("select range()", &[])
            .unwrap_err();
        assert!(e.message.contains("unavailable"), "{e}");
    }

    #[test]
    fn allowlists_come_from_one_scan_lowercased_and_exclude_user_macros() {
        let mut fake = Fake {
            rows: vec![
                row("Lower", true, false),
                row("lower_macro", false, false),
                row("unnest", false, false),
                row("Range", false, true),
            ],
            ..Default::default()
        }
        .with("select 1", sel(json!([func("lower")]), json!(null)));
        let mut policy = ReadSqlPolicy::new(&mut fake, "memory");
        policy.validate("select 1", &[]).unwrap();
        policy.validate("select 1", &[]).unwrap();
        let (functions, tables) = policy.functions.clone().unwrap();
        assert!(functions.contains("lower") && !functions.contains("lower_macro"));
        assert!(
            tables.contains("range") && !tables.contains("unnest"),
            "a user macro named unnest is not granted"
        );
        assert_eq!(fake.catalog_scans, 1);
    }

    // ---- additional coverage for ported helpers ----
    #[test]
    fn inspection_sql_strips_only_read_only_wrappers() {
        let cases = [
            ("select 1", "select 1"),
            ("explain select 1", "select 1"),
            ("EXPLAIN   ANALYZE  select 1", "select 1"),
            ("explain analyzeX select 1", "analyzeX select 1"),
            ("explainer select 1", "explainer select 1"),
            ("describe t", "SELECT * FROM t"),
            ("DESCRIBE select 1", "select 1"),
            ("summarize from t", "from t"),
            ("summarize t", "SELECT * FROM t"),
            (
                "-- c\n/* a /* b */ c */  explain with x as (select 1) select * from x",
                "with x as (select 1) select * from x",
            ),
            ("  \u{a0}describe\u{3000}t", "SELECT * FROM t"),
            ("describewith t", "describewith t"),
        ];
        for (input, want) in cases {
            assert_eq!(inspection_sql(input), want, "{input}");
        }
        assert_eq!(
            inspection_sql("/* unterminated explain select 1"),
            "/* unterminated explain select 1"
        );
    }

    #[test]
    fn view_body_finds_the_top_level_as_only() {
        assert_eq!(
            view_body("CREATE VIEW good AS SELECT * FROM data;").unwrap(),
            " SELECT * FROM data;"
        );
        assert_eq!(
            view_body("CREATE VIEW \"as\" AS SELECT 2").unwrap(),
            " SELECT 2"
        );
        assert_eq!(
            view_body("CREATE VIEW v(\"a as b\", c) aS SELECT 1").unwrap(),
            " SELECT 1"
        );
        assert_eq!(
            view_body("CREATE VIEW v(as_col) AS SELECT 'x as y'").unwrap(),
            " SELECT 'x as y'"
        );
        assert_eq!(
            view_body("CREATE VIEW v\u{e9}w AS SELECT 3").unwrap(),
            " SELECT 3"
        );
        for bad in [
            "",
            "CREATE VIEW v",
            "CREATE VIEW v (as SELECT 1)",
            "CREATE VIEW 'as",
        ] {
            assert_eq!(
                view_body(bad).unwrap_err().kind,
                Refusal::ViewNotInspectable,
                "{bad}"
            );
        }
    }

    #[test]
    fn referenced_tables_reads_syntax_not_quoted_text() {
        let ast = sel(
            json!([{"class": "CONSTANT", "value": "base_table_name_in_text"}]),
            json!({"type": "JOIN", "left": base("a"), "right": base_in("c", "s", "B")}),
        );
        assert_eq!(
            referenced_tables(&ast),
            HashSet::from(["a".to_owned(), "B".to_owned()])
        );
        let mut fake = Fake::default().with("select * from a", ast);
        assert_eq!(
            referenced_query_tables(&mut fake, "select * from a")
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn untrusted_view_cycles_terminate_trusted_views_are_not_inspected_and_deep_chains_are_refused()
    {
        let rel = |name: &str, sql: &str, trusted: bool| QueryRelation {
            catalog: "memory".into(),
            schema: "main".into(),
            name: name.into(),
            view_sql: Some(sql.into()),
            trusted_view: trusted,
        };
        // a -> b -> a: the inspected set breaks the cycle.
        let mut fake = Fake {
            rows: rows(),
            ..Default::default()
        }
        .with("select * from a", sel(star(), base("a")))
        .with("SELECT * FROM b", sel(star(), base("b")))
        .with("SELECT * FROM a", sel(star(), base("a")));
        let cyc = [
            rel("a", "CREATE VIEW a AS SELECT * FROM b", false),
            rel("b", "CREATE VIEW b AS SELECT * FROM a", false),
        ];
        ReadSqlPolicy::new(&mut fake, "memory")
            .validate("select * from a", &cyc)
            .unwrap();
        // A trusted host view is never parsed: its (unparseable here) body is not asked for.
        let mut fake = Fake {
            rows: rows(),
            ..Default::default()
        }
        .with("select * from t", sel(star(), base("t")));
        ReadSqlPolicy::new(&mut fake, "memory")
            .validate(
                "select * from t",
                &[rel(
                    "t",
                    "CREATE VIEW t AS SELECT * FROM read_csv('x')",
                    true,
                )],
            )
            .unwrap();
        assert_eq!(fake.asked.len(), 1);
        // A 40-deep chain exceeds the view nesting limit.
        let mut fake = Fake {
            rows: rows(),
            ..Default::default()
        }
        .with("select * from v0", sel(star(), base("v0")));
        let mut chain = Vec::new();
        for i in 0..40 {
            chain.push(rel(
                &format!("v{i}"),
                &format!("CREATE VIEW v{i} AS SELECT * FROM v{}", i + 1),
                false,
            ));
            fake = fake.with(
                &format!("SELECT * FROM v{}", i + 1),
                sel(star(), base(&format!("v{}", i + 1))),
            );
        }
        chain.push(QueryRelation {
            catalog: "memory".into(),
            schema: "main".into(),
            name: "v40".into(),
            ..Default::default()
        });
        assert_eq!(
            ReadSqlPolicy::new(&mut fake, "memory")
                .validate("select * from v0", &chain)
                .unwrap_err()
                .kind,
            Refusal::ViewNesting
        );
    }

    #[test]
    fn pathological_ast_nesting_is_refused() {
        let mut deep = json!({"leaf": true});
        for _ in 0..300 {
            deep = json!({"n": deep});
        }
        let mut fake = Fake {
            rows: rows(),
            ..Default::default()
        }
        .with("select 1", json!({"error": false, "statements": [deep]}));
        assert_eq!(
            ReadSqlPolicy::new(&mut fake, "memory")
                .validate("select 1", &[])
                .unwrap_err()
                .kind,
            Refusal::SqlNesting
        );
    }

    #[test]
    fn refusal_codes_are_stable_and_unique() {
        let all = [
            Refusal::SqlSize,
            Refusal::NotSingleSelect,
            Refusal::ExternalReader,
            Refusal::FunctionUnavailable,
            Refusal::RelationUnavailable,
            Refusal::ViewNotInspectable,
            Refusal::ViewNesting,
            Refusal::SqlNesting,
            Refusal::CellSize,
            Refusal::ResultSize,
            Refusal::Engine,
        ];
        assert_eq!(
            all.iter().map(|k| k.code()).collect::<HashSet<_>>().len(),
            all.len()
        );
    }
}
