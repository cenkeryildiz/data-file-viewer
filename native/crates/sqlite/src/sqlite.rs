//! Port of `src/sqliteTypes.ts` and the SQLite identity rules of `duckdbConnection.ts`.
//!
//! The TypeScript reference had to rebuild DuckDB views because DuckDB's scanner reads a column
//! declared with no type as BLOB. Here SQLite is read directly, so every cell keeps its own
//! storage class and the BLOB mangling cannot happen. What survives from the reference is the
//! *decision*: which uniform untyped columns are presented as text / whole numbers / numbers,
//! which numeric columns must be shown as exact text, and which row identity an edit may use.
use rusqlite::config::DbConfig;
use rusqlite::{Connection, ErrorCode, OpenFlags, params_from_iter, types::Value, types::ValueRef};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;
use std::time::Duration;

/// 2^53: integers beyond it cannot share a lossless DOUBLE column.
const SAFE_INTEGER: i64 = 9_007_199_254_740_992;

/// What an untyped column's values turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retype {
    Varchar,
    BigInt,
    Double,
}

/// Typed outcomes; the worker maps each to a protocol refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqliteError {
    NotFound(String),
    NotADatabase,
    Corrupt,
    /// The header names a file format version this SQLite does not read (a damaged or much newer file).
    UnsupportedFormat,
    /// Another connection holds a conflicting lock (rollback journal or WAL checkpoint).
    Locked,
    /// SQLite must write to open this file but only read access exists: a WAL database whose `-shm`/`-wal` files
    /// cannot be created, or a hot rollback journal (a crashed writer) that needs recovery.
    NeedsWrite(String),
    /// The table changed after the plan was made; re-plan.
    SchemaChanged,
    /// No usable row identity (see [`NoIdentity`]).
    NoIdentity(NoIdentity),
    /// `check_editable`: the column holds numbers but has no declared type.
    UntypedNumbers(String),
    Other(String),
}

impl fmt::Display for SqliteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(p) => write!(f, "SQLite file not found: {p}"),
            Self::NotADatabase => f.write_str("The file is not a SQLite database."),
            Self::Corrupt => f.write_str("The SQLite database is corrupt."),
            Self::UnsupportedFormat => {
                f.write_str("The SQLite file format version is not supported.")
            }
            Self::Locked => f.write_str("The SQLite database is locked by another process."),
            Self::NeedsWrite(m) => {
                write!(
                    f,
                    "The database needs write access to be opened (WAL index or crash recovery): {m}"
                )
            }
            Self::SchemaChanged => f.write_str("The table changed while it was being read."),
            Self::NoIdentity(n) => write!(
                f,
                "No unshadowed rowid is available ({n:?}); the edit was refused."
            ),
            Self::UntypedNumbers(c) => write!(
                f,
                "\"{c}\" is declared with no type and its values are stored as numbers; saving text would change what other programs read."
            ),
            Self::Other(m) => f.write_str(m),
        }
    }
}
impl std::error::Error for SqliteError {}

impl SqliteError {
    fn from_rusqlite(error: rusqlite::Error, path: Option<&Path>) -> Self {
        let rusqlite::Error::SqliteFailure(failure, message) = &error else {
            return Self::Other(error.to_string());
        };
        let text = message.clone().unwrap_or_else(|| error.to_string());
        match failure.code {
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => Self::Locked,
            ErrorCode::NotADatabase => Self::NotADatabase,
            ErrorCode::DatabaseCorrupt => Self::Corrupt,
            ErrorCode::SchemaChanged => Self::SchemaChanged,
            ErrorCode::Unknown if text.contains("unsupported file format") => {
                Self::UnsupportedFormat
            }
            ErrorCode::ReadOnly => Self::NeedsWrite(text),
            ErrorCode::CannotOpen => match path {
                Some(p) if !p.exists() => Self::NotFound(p.display().to_string()),
                _ => Self::NeedsWrite(text),
            },
            _ => Self::Other(text),
        }
    }
}

/// How the file is opened. Both modes are read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    /// Normal read-only: sees committed WAL content and honours locks.
    ReadOnly,
    /// `immutable=1`: no locking and the WAL is ignored. Only for files known to be static.
    Immutable,
}

/// Percent-encodes a path for a SQLite `file:` URI (unreserved characters and `/` stay).
fn uri_path(path: &Path) -> String {
    let mut out = String::from("file:");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Opens `path` read-only (with double-quoted string literals disabled, so callers that plan on this connection are safe). `busy` is how long a lock is waited for; zero reports [`SqliteError::Locked`] at once.
/// Copy a consistent SQLite image, including committed WAL pages, into a private caller-owned file.
/// A competing writer refuses immediately instead of waiting indefinitely or copying a partial image.
pub fn backup_snapshot(source: &Path, destination: &Path) -> Result<(), SqliteError> {
    let source = open_read_only(source, OpenMode::ReadOnly, Duration::ZERO)?;
    let mut destination =
        Connection::open(destination).map_err(|e| SqliteError::from_rusqlite(e, None))?;
    destination
        .busy_timeout(Duration::ZERO)
        .map_err(|e| SqliteError::from_rusqlite(e, None))?;
    let backup = rusqlite::backup::Backup::new(&source, &mut destination)
        .map_err(|e| SqliteError::from_rusqlite(e, None))?;
    match backup
        .step(-1)
        .map_err(|e| SqliteError::from_rusqlite(e, None))?
    {
        rusqlite::backup::StepResult::Done => Ok(()),
        _ => Err(SqliteError::Locked),
    }
}

pub fn open_read_only(
    path: &Path,
    mode: OpenMode,
    busy: Duration,
) -> Result<Connection, SqliteError> {
    if !path.exists() {
        return Err(SqliteError::NotFound(path.display().to_string()));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = match mode {
        OpenMode::ReadOnly => Connection::open_with_flags(path, flags),
        OpenMode::Immutable => Connection::open_with_flags(
            format!("{}?immutable=1", uri_path(path)),
            flags | OpenFlags::SQLITE_OPEN_URI,
        ),
    }
    .map_err(|e| SqliteError::from_rusqlite(e, Some(path)))?;
    connection
        .busy_timeout(busy)
        .map_err(|e| SqliteError::from_rusqlite(e, Some(path)))?;
    // A double-quoted name that no longer resolves would silently read as the string literal of that name,
    // turning a changed schema into wrong data instead of an error.
    for option in [
        DbConfig::SQLITE_DBCONFIG_DQS_DML,
        DbConfig::SQLITE_DBCONFIG_DQS_DDL,
    ] {
        connection
            .set_db_config(option, false)
            .map_err(|e| SqliteError::from_rusqlite(e, Some(path)))?;
    }
    // Opening is lazy: read the header now so "not a database" surfaces here, not on the first query.
    connection
        .query_row("select count(*) from sqlite_master", [], |_| Ok(()))
        .map_err(|e| SqliteError::from_rusqlite(e, Some(path)))?;
    Ok(connection)
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The type a set of storage classes justifies, or `None` to leave the column alone.
/// `null` is ignored; blobs (or text mixed with numbers) justify nothing.
pub fn type_for_classes(classes: &[&str]) -> Option<Retype> {
    let present: BTreeSet<&str> = classes.iter().copied().filter(|c| *c != "null").collect();
    match (
        present.len(),
        present.contains("text"),
        present.contains("integer"),
    ) {
        (0, _, _) => None,
        (1, true, _) => Some(Retype::Varchar),
        (1, _, true) => Some(Retype::BigInt),
        _ if present.iter().all(|c| *c == "integer" || *c == "real") => Some(Retype::Double),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    /// Exactly as declared; empty means "no type".
    pub declared: String,
}

/// Why a table has no row identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoIdentity {
    /// Columns shadow `rowid`, `oid` and `_rowid_`.
    Shadowed,
    WithoutRowid,
    View,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowIdentity {
    /// The alias to select; `rowid` unless a user column shadows it.
    Alias(&'static str),
    Unavailable(NoIdentity),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TablePlan {
    pub columns: Vec<Column>,
    /// Columns declared with no type.
    pub undeclared: Vec<String>,
    pub retyped: BTreeMap<String, Retype>,
    /// Numeric values that cannot share a lossless DOUBLE are presented as exact text.
    pub numeric_text: BTreeSet<String>,
    pub identity: RowIdentity,
}

/// Table name -> how it is read. Every table gets an entry, retyped or not.
pub type Plan = BTreeMap<String, TablePlan>;

/// One cell in its own storage class. Text that is not valid UTF-8 is returned as `Blob` so no byte is lost.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Cell {
    fn from_ref(value: ValueRef<'_>) -> Self {
        match value {
            ValueRef::Null => Self::Null,
            ValueRef::Integer(i) => Self::Integer(i),
            ValueRef::Real(r) => Self::Real(r),
            ValueRef::Text(t) => std::str::from_utf8(t)
                .map_or_else(|_| Self::Blob(t.to_vec()), |s| Self::Text(s.to_owned())),
            ValueRef::Blob(b) => Self::Blob(b.to_vec()),
        }
    }
    fn to_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Integer(i) => Value::Integer(*i),
            Self::Real(r) => Value::Real(*r),
            Self::Text(s) => Value::Text(s.clone()),
            Self::Blob(b) => Value::Blob(b.clone()),
        }
    }
}

fn err(e: rusqlite::Error) -> SqliteError {
    SqliteError::from_rusqlite(e, None)
}

fn declared_columns(connection: &Connection, table: &str) -> Result<Vec<Column>, SqliteError> {
    // table_xinfo: generated columns (hidden 2/3) appear in `select *`; virtual-table hidden columns (1) do not.
    let mut statement = connection
        .prepare(
            "select name, type from pragma_table_xinfo(?1) where hidden in (0, 2, 3) order by cid",
        )
        .map_err(err)?;
    statement
        .query_map([table], |r| {
            Ok(Column {
                name: r.get(0)?,
                declared: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)
}

/// The first of `rowid`, `oid`, `_rowid_` that no user column shadows.
/// A sole `INTEGER PRIMARY KEY` column *is* the rowid, so it does not count as shadowing.
fn row_identity(
    connection: &Connection,
    table: &str,
    columns: &[Column],
) -> Result<RowIdentity, SqliteError> {
    let (kind, without_rowid): (String, bool) = connection
        .query_row(
            "select type, wr from pragma_table_list where name = ?1 and schema = 'main'",
            [table],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
        )
        .map_err(err)?;
    if kind == "view" {
        return Ok(RowIdentity::Unavailable(NoIdentity::View));
    }
    if without_rowid {
        return Ok(RowIdentity::Unavailable(NoIdentity::WithoutRowid));
    }
    let pk: Vec<(String, String)> = {
        let mut s = connection
            .prepare("select name, type from pragma_table_info(?1) where pk > 0")
            .map_err(err)?;
        s.query_map([table], |r| Ok((r.get(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?
    };
    // `INTEGER PRIMARY KEY DESC` is the documented exception: it is an ordinary unique column backed by an index
    // (origin 'pk'), not the rowid, so it must keep shadowing.
    let has_pk_index: bool = connection
        .query_row(
            "select count(*) > 0 from pragma_index_list(?1) where origin = 'pk'",
            [table],
            |r| r.get(0),
        )
        .map_err(err)?;
    let is_alias = |name: &str| {
        pk.len() == 1
            && !has_pk_index
            && pk[0].0.eq_ignore_ascii_case(name)
            && pk[0].1.eq_ignore_ascii_case("integer")
    };
    for alias in ["rowid", "oid", "_rowid_"] {
        let shadowed = columns
            .iter()
            .any(|c| c.name.eq_ignore_ascii_case(alias) && !is_alias(&c.name));
        if shadowed {
            continue;
        }
        // Confirms the alias resolves (virtual tables may have none).
        if connection
            .prepare(&format!(
                "select {alias} from {} limit 0",
                quote_ident(table)
            ))
            .is_ok()
        {
            return Ok(RowIdentity::Alias(alias));
        }
    }
    Ok(RowIdentity::Unavailable(NoIdentity::Shadowed))
}

fn table_names(connection: &Connection) -> Result<Vec<String>, SqliteError> {
    let mut s = connection
        .prepare("select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite\\_%' escape '\\' order by name")
        .map_err(err)?;
    s.query_map([], |r| r.get(0))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)
}

/// Storage classes present in each column, from SQLite's own `typeof()`.
pub fn classes_of(
    connection: &Connection,
    table: &str,
    columns: &[String],
) -> Result<Vec<Vec<String>>, SqliteError> {
    let parts: Vec<String> = columns
        .iter()
        .map(|c| format!("group_concat(distinct typeof({}))", quote_ident(c)))
        .collect();
    let sql = format!("select {} from {}", parts.join(", "), quote_ident(table));
    connection
        .query_row(&sql, [], |r| {
            (0..columns.len())
                .map(|i| {
                    Ok(r.get::<_, Option<String>>(i)?
                        .map(|s| {
                            s.split(',')
                                .map(|c| c.trim().to_lowercase())
                                .filter(|c| !c.is_empty())
                                .collect()
                        })
                        .unwrap_or_default())
                })
                .collect()
        })
        .map_err(err)
}

/// Text SQLite accepted can still be invalid UTF-8; such a column is not retyped, its bytes stay bytes.
fn text_is_utf8(connection: &Connection, table: &str, column: &str) -> Result<bool, SqliteError> {
    let sql = format!(
        "select {c} from {t} where typeof({c}) = 'text'",
        c = quote_ident(column),
        t = quote_ident(table)
    );
    let mut statement = connection.prepare(&sql).map_err(err)?;
    let mut rows = statement.query([]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        if let ValueRef::Text(bytes) = row.get_ref(0).map_err(err)?
            && std::str::from_utf8(bytes).is_err()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Plans every table. `previous` lets a live refresh skip fully declared tables whose schema is unchanged;
/// tables with untyped columns are always rescanned because storage classes change without any DDL.
pub fn plan_tables(connection: &Connection, previous: Option<&Plan>) -> Result<Plan, SqliteError> {
    // One read transaction so the schema, classes and identity describe the same snapshot.
    let snapshot = connection.unchecked_transaction().map_err(err)?;
    let mut plan = Plan::new();
    for table in table_names(connection)? {
        let columns = declared_columns(connection, &table)?;
        let identity = row_identity(connection, &table, &columns)?;
        let undeclared: Vec<String> = columns
            .iter()
            .filter(|c| c.declared.trim().is_empty())
            .map(|c| c.name.clone())
            .collect();
        if let Some(before) = previous.and_then(|p| p.get(&table))
            && undeclared.is_empty()
            && before.undeclared.is_empty()
            && before.columns == columns
            && before.identity == identity
        {
            plan.insert(table, before.clone());
            continue;
        }
        let mut retyped = BTreeMap::new();
        let mut numeric_text = BTreeSet::new();
        if !undeclared.is_empty() {
            for (column, classes) in
                undeclared
                    .iter()
                    .zip(classes_of(connection, &table, &undeclared)?)
            {
                let refs: Vec<&str> = classes.iter().map(String::as_str).collect();
                let Some(kind) = type_for_classes(&refs) else {
                    continue;
                };
                if kind == Retype::Varchar && !text_is_utf8(connection, &table, column)? {
                    continue;
                }
                retyped.insert(column.clone(), kind);
            }
            let doubles: Vec<String> = retyped
                .iter()
                .filter(|(_, t)| **t == Retype::Double)
                .map(|(c, _)| c.clone())
                .collect();
            for column in doubles {
                let q = quote_ident(&column);
                let wide: i64 = connection
                    .query_row(
                        &format!(
                            "select coalesce(max(typeof({q}) = 'integer' and ({q} > {SAFE_INTEGER} or {q} < -{SAFE_INTEGER})), 0) from {}",
                            quote_ident(&table)
                        ),
                        [],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                if wide == 1 {
                    retyped.insert(column.clone(), Retype::Varchar);
                    numeric_text.insert(column);
                }
            }
        }
        plan.insert(
            table,
            TablePlan {
                columns,
                undeclared,
                retyped,
                numeric_text,
                identity,
            },
        );
    }
    snapshot.commit().map_err(err)?;
    Ok(plan)
}

/// Says so when an untyped column is presented as what its values are (the reference's open warnings).
pub fn retype_notices(plan: &Plan) -> Vec<String> {
    plan.iter()
        .filter(|(_, t)| !t.retyped.is_empty())
        .map(|(table, t)| {
            let described: Vec<String> = t
                .retyped
                .iter()
                .map(|(column, kind)| {
                    let what = if t.numeric_text.contains(column) {
                        "exact numeric text (integers exceed the safe DOUBLE range)"
                    } else {
                        match kind {
                            Retype::Varchar => "text",
                            Retype::BigInt => "whole numbers",
                            Retype::Double => "numbers",
                        }
                    };
                    format!("\"{column}\" as {what}")
                })
                .collect();
            format!(
                "\"{table}\": {} — the file declares no type for {}, so each is read as what its stored values are.",
                described.join(", "),
                if t.retyped.len() == 1 { "that column" } else { "those columns" }
            )
        })
        .collect()
}

fn present(plan: &TablePlan, column: &str, cell: Cell) -> Cell {
    match (
        plan.retyped.get(column),
        plan.numeric_text.contains(column),
        cell,
    ) {
        // Exact text: integers as digits, reals in shortest round-trip form.
        // shortcut: not byte-identical to DuckDB's VARCHAR cast for exponents, same value; align if the UI compares strings.
        (_, true, Cell::Integer(i)) => Cell::Text(i.to_string()),
        (_, true, Cell::Real(r)) => Cell::Text(format!("{r:?}")),
        (Some(Retype::Double), false, Cell::Integer(i)) => Cell::Real(i as f64),
        (_, _, cell) => cell,
    }
}

/// Fails with `SchemaChanged` when the live table no longer matches the plan.
fn guard_schema(
    connection: &Connection,
    table: &str,
    plan: &TablePlan,
    original: rusqlite::Error,
) -> SqliteError {
    match declared_columns(connection, table) {
        Ok(now) if now == plan.columns => err(original),
        Ok(_) => SqliteError::SchemaChanged,
        Err(e) => e,
    }
}

/// Reads up to `limit` rows in table order; the flag reports whether more exist.
pub fn read_rows(
    connection: &Connection,
    table: &str,
    plan: &TablePlan,
    limit: usize,
) -> Result<(Vec<Vec<Cell>>, bool), SqliteError> {
    // Pin schema validation and row reads to one snapshot, reusing a caller's write transaction.
    let _snapshot = if connection.is_autocommit() {
        Some(connection.unchecked_transaction().map_err(err)?)
    } else {
        None
    };
    if declared_columns(connection, table)? != plan.columns {
        return Err(SqliteError::SchemaChanged);
    }
    let names: Vec<String> = plan.columns.iter().map(|c| quote_ident(&c.name)).collect();
    let sql = format!("select {} from {}", names.join(", "), quote_ident(table));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|e| guard_schema(connection, table, plan, e))?;
    if statement.column_count() != plan.columns.len() {
        return Err(SqliteError::SchemaChanged);
    }
    let mut out = Vec::new();
    let mut truncated = false;
    let mut rows = statement
        .query([])
        .map_err(|e| guard_schema(connection, table, plan, e))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| guard_schema(connection, table, plan, e))?
    {
        if out.len() == limit {
            truncated = true;
            break;
        }
        out.push(
            plan.columns
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    row.get_ref(i)
                        .map(|v| present(plan, &c.name, Cell::from_ref(v)))
                })
                .collect::<Result<_, _>>()
                .map_err(err)?,
        );
    }
    Ok((out, truncated))
}

/// A numeric column with no declared type can only be written back as text, which other readers would see.
pub fn check_editable(plan: &TablePlan, column: &str) -> Result<(), SqliteError> {
    match plan.retyped.get(column) {
        Some(kind) if *kind != Retype::Varchar => {
            Err(SqliteError::UntypedNumbers(column.to_owned()))
        }
        _ if plan.numeric_text.contains(column) => {
            Err(SqliteError::UntypedNumbers(column.to_owned()))
        }
        _ => Ok(()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    NoMatch,
    One(i64),
    /// Two or more identical rows (the search stops at two).
    Ambiguous,
}

/// Finds the row whose cells equal `key` (null-safe, storage-class exact) and returns its rowid.
/// Never matches through a user column that shadows `rowid`.
pub fn find_row(
    connection: &Connection,
    table: &str,
    plan: &TablePlan,
    key: &[(String, Cell)],
) -> Result<Lookup, SqliteError> {
    let _snapshot = if connection.is_autocommit() {
        Some(connection.unchecked_transaction().map_err(err)?)
    } else {
        None
    };
    let columns = declared_columns(connection, table)?;
    if columns != plan.columns || row_identity(connection, table, &columns)? != plan.identity {
        return Err(SqliteError::SchemaChanged);
    }
    let RowIdentity::Alias(alias) = &plan.identity else {
        let RowIdentity::Unavailable(why) = &plan.identity else {
            unreachable!()
        };
        return Err(SqliteError::NoIdentity(why.clone()));
    };
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    for (name, cell) in key {
        if !plan.columns.iter().any(|c| &c.name == name) {
            return Err(SqliteError::Other(format!("no such column: {name}")));
        }
        let q = quote_ident(name);
        // Exact-text numeric columns are matched numerically: the text came from `present`.
        let cell = match (plan.numeric_text.contains(name), cell) {
            (true, Cell::Text(s)) => s
                .parse::<i64>()
                .map(Cell::Integer)
                .or_else(|_| s.parse::<f64>().map(Cell::Real))
                .map_err(|_| {
                    SqliteError::Other(format!("\"{name}\" is not an exact number: {s}"))
                })?,
            (_, c) => c.clone(),
        };
        clauses.push(format!("{q} is ?"));
        values.push(cell.to_value());
    }
    let wherever = if clauses.is_empty() {
        "1".to_owned()
    } else {
        clauses.join(" and ")
    };
    let sql = format!(
        "select {alias} from {} where {wherever} limit 2",
        quote_ident(table)
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|e| guard_schema(connection, table, plan, e))?;
    let found: Vec<i64> = statement
        .query_map(params_from_iter(values), |r| r.get(0))
        .map_err(|e| guard_schema(connection, table, plan, e))?
        .collect::<Result<_, _>>()
        .map_err(|e| guard_schema(connection, table, plan, e))?;
    Ok(match found.as_slice() {
        [] => Lookup::NoMatch,
        [one] => Lookup::One(*one),
        _ => Lookup::Ambiguous,
    })
}
