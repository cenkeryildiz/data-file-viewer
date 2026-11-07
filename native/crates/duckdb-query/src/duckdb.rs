//! The DuckDB connection: open a `.duckdb`, `.parquet` or `.csv` file read-only, apply the policy's
//! engine lock-down, and bridge the connection to the SQL policy. Everything the viewer may run goes
//! through [`Engine`]; nothing here writes to the source.
use crate::csv::LocaleReport;
use dfv_table_policy::{
    FUNCTION_CATALOG_SQL, FunctionRow, LOCKED_SETTING_READBACK, MUST_FAIL_AFTER_LOCK, PolicyError,
    QUERY_LIMITS, QueryEngine, QueryRelation, Refusal, SERIALIZE_SQL, engine_restrictions,
    reader_threads,
};
use duckdb::{AccessMode, Config, Connection, InterruptHandle};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Duckdb,
    Parquet,
    Csv,
    /// The kinds below are decoded by their own accepted crates and loaded into the engine's
    /// in-memory catalog (`materialized.rs`); the engine never reads their files itself.
    Sqlite,
    Arrow,
    Feather,
    Xlsx,
    Dta,
    Kdb,
}
impl Kind {
    /// The protocol's `FileKind` word.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Duckdb => "duckdb",
            Self::Parquet => "parquet",
            Self::Csv => "csv",
            Self::Sqlite => "sqlite",
            Self::Arrow => "arrow",
            Self::Feather => "feather",
            Self::Xlsx => "xlsx",
            Self::Dta => "dta",
            Self::Kdb => "kdb",
        }
    }
}

/// A typed outcome: the caller can tell a refusal from a cancel, a timeout and an engine failure.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    Policy(PolicyError),
    Interrupted,
    TimedOut,
    Invalid(String),
    Unsupported(String),
    /// A source beyond what this engine may hold or read (the protocol's `RESOURCE_LIMIT`).
    TooLarge(String),
    /// The file changed or a DuckDB journal appeared since it was opened.
    SourceChanged,
    Engine(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Policy(e) => write!(f, "{e}"),
            Self::Interrupted => f.write_str("Query cancelled."),
            Self::TimedOut => f.write_str("Query timed out. Reduce the query and try again."),
            Self::Invalid(m) | Self::Unsupported(m) | Self::TooLarge(m) | Self::Engine(m) => {
                f.write_str(m)
            }
            Self::SourceChanged => {
                f.write_str("The file changed after opening. Reopen it before querying.")
            }
        }
    }
}
impl std::error::Error for Error {}
impl From<PolicyError> for Error {
    fn from(e: PolicyError) -> Self {
        Self::Policy(e)
    }
}
impl From<duckdb::Error> for Error {
    fn from(e: duckdb::Error) -> Self {
        let text = e.to_string();
        if text.contains("INTERRUPT") {
            Self::Interrupted
        } else {
            Self::Engine(text)
        }
    }
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
pub fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// What the host may choose at open. Everything else is derived from the file.
#[derive(Debug, Clone, Default)]
pub struct OpenOptions {
    /// `None` sniffs the CSV's decimal convention; `Some` states it (the user's `numberLocale` setting).
    pub number_locale: Option<crate::locale::NumberLocale>,
    /// Cell texts read as "no value" in a CSV (`dataFileViewer.nullText`); `None` is the Excel error list,
    /// `Some(vec![])` turns the interpretation off.
    pub null_text: Option<Vec<String>>,
}

pub struct Engine {
    pub(crate) conn: Connection,
    pub kind: Kind,
    pub path: PathBuf,
    /// `system.main.current_database()`: the file stem for a `.duckdb`, `memory` for a flat file.
    pub catalog: String,
    /// Host-created views over approved paths; the policy trusts these bodies.
    pub(crate) trusted_views: HashSet<String>,
    pub open_warnings: Vec<String>,
    /// Why results of this file must not be edited (values shown that the file does not hold exactly).
    pub edit_blockers: Vec<String>,
    pub number_locale: Option<LocaleReport>,
    pub read_only: bool,
    pub deadline: Duration,
    interrupt: Arc<InterruptHandle>,
    stamp: (u64, std::time::SystemTime),
    /// Other files whose change makes this engine stale (a SQLite `-wal`, the sibling): `None` = absent.
    pub(crate) extra_stamps: Vec<(PathBuf, Option<(u64, std::time::SystemTime)>)>,
    /// The other half of a hot/cold pair, attached read-only as its own catalog.
    pub sibling: Option<Sibling>,
    /// SQL text from `build_combined_query`: only these may read the sibling catalog (bounded, oldest out).
    pub(crate) combined: std::sync::Mutex<std::collections::VecDeque<String>>,
    /// Tables that exist for querying but are not navigation entries (detected sheet tables).
    pub derived_tables: std::sync::Mutex<HashSet<String>>,
}

/// The attached other half of a hot/cold pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sibling {
    pub catalog: String,
    /// A SQLite file is the hot half whichever side it is attached on.
    pub sqlite: bool,
}

/// The policy's view of a connection: parse-only and catalog reads, nothing user-controlled executes.
/// Public so a caller holding its own connection (the tests do) can run the same policy.
pub struct Bridge<'a>(pub &'a Connection);
impl QueryEngine for Bridge<'_> {
    fn serialize_sql(&mut self, sql: &str) -> Result<Value, PolicyError> {
        let engine = |e: duckdb::Error| PolicyError::new(Refusal::Engine, e.to_string());
        let text: String = self
            .0
            .query_row(SERIALIZE_SQL, [sql], |r| r.get(0))
            .map_err(engine)?;
        serde_json::from_str(&text).map_err(|e| PolicyError::new(Refusal::Engine, e.to_string()))
    }
    fn function_catalog(&mut self) -> Result<Vec<FunctionRow>, PolicyError> {
        let engine = |e: duckdb::Error| PolicyError::new(Refusal::Engine, e.to_string());
        let mut stmt = self.0.prepare(FUNCTION_CATALOG_SQL).map_err(engine)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(FunctionRow {
                    name: r.get(0)?,
                    scalar_safe: r.get(1)?,
                    table_safe: r.get(2)?,
                })
            })
            .map_err(engine)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(engine)
    }
}

fn kind_of(path: &Path) -> Result<Kind, Error> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("duckdb") => Ok(Kind::Duckdb),
        Some("parquet") => Ok(Kind::Parquet),
        Some("csv") => Ok(Kind::Csv),
        _ => Err(Error::Unsupported(
            "This engine opens .duckdb, .parquet and .csv files.".into(),
        )),
    }
}
pub(crate) fn stamp_of(path: &Path) -> Result<(u64, std::time::SystemTime), Error> {
    let meta = std::fs::metadata(path)
        .map_err(|e| Error::Invalid(format!("Could not read \"{}\": {e}", path.display())))?;
    Ok((
        meta.len(),
        meta.modified().map_err(|e| Error::Invalid(e.to_string()))?,
    ))
}

fn has_duckdb_journal(path: &Path) -> bool {
    [".wal", ".wal.checkpoint", ".wal.recovery"]
        .iter()
        .any(|suffix| {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            !matches!(
                std::fs::symlink_metadata(Path::new(&sidecar)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound
            )
        })
}

impl Engine {
    /// Open `path` read-only. The path is canonicalised, must be a regular file (a FIFO would block),
    /// and is the only path the locked engine may read.
    pub fn open(path: &Path) -> Result<Self, Error> {
        Self::open_with(path, &OpenOptions::default())
    }

    pub fn open_with(path: &Path, options: &OpenOptions) -> Result<Self, Error> {
        Self::open_with_pre(path, options, &|| Ok(()), |_| Ok(()))
    }

    /// As [`Self::open_with`], with `pre` run before the lock-down so a DuckDB/Parquet/CSV engine can
    /// attach the other half of a hot/cold pair (it is already open once the lock closes the filesystem).
    pub fn open_with_pre(
        path: &Path,
        options: &OpenOptions,
        cancel: &dyn Fn() -> Result<(), Error>,
        pre: impl FnOnce(&mut crate::materialized::Loader<'_>) -> Result<(), Error>,
    ) -> Result<Self, Error> {
        let path = std::fs::canonicalize(path)
            .map_err(|e| Error::Invalid(format!("Could not open \"{}\": {e}", path.display())))?;
        let kind = kind_of(&path)?;
        if !std::fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            return Err(Error::Invalid(format!(
                "\"{}\" is not a regular file.",
                path.display()
            )));
        }
        let stamp = stamp_of(&path)?;
        // shortcut: journaled DuckDB sources need transaction-aware snapshots before support.
        if kind == Kind::Duckdb && has_duckdb_journal(&path) {
            return Err(Error::Unsupported(
                "DuckDB files with recovery journals are not supported. Checkpoint and close the database before opening it.".into(),
            ));
        }
        let threads = reader_threads();
        let config = Config::default()
            .threads(threads as i64)?
            .max_memory("512MB")?;
        let conn = match kind {
            Kind::Duckdb => {
                Connection::open_with_flags(&path, config.access_mode(AccessMode::ReadOnly)?)
            }
            _ => Connection::open_in_memory_with_flags(config),
        }
        .map_err(|e| Error::Engine(format!("Could not open \"{}\": {e}", path.display())))?;
        let mut engine = Self::bare(conn, kind, path.clone(), stamp);
        engine.check_source()?;
        let mut loader = crate::materialized::Loader::new(&engine.conn, cancel);
        pre(&mut loader)?;
        let parts = loader.finish();
        engine.adopt(parts, &[&path.to_string_lossy()])?;
        let stem = path
            .file_stem()
            .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
        match kind {
            Kind::Duckdb => {}
            Kind::Parquet => engine.open_parquet(&stem)?,
            Kind::Csv => engine.open_csv(&path, &stem, options)?,
            _ => unreachable!("kind_of only yields flat DuckDB kinds"),
        }
        engine.check_source()?;
        Ok(engine)
    }

    pub(crate) fn bare(
        conn: Connection,
        kind: Kind,
        path: PathBuf,
        stamp: (u64, std::time::SystemTime),
    ) -> Self {
        Self {
            interrupt: conn.interrupt_handle(),
            conn,
            kind,
            path,
            catalog: String::new(),
            trusted_views: HashSet::new(),
            open_warnings: vec![],
            edit_blockers: vec![],
            number_locale: None,
            read_only: true,
            deadline: Duration::from_millis(QUERY_LIMITS.deadline_ms),
            stamp,
            extra_stamps: vec![],
            sibling: None,
            combined: Default::default(),
            derived_tables: Default::default(),
        }
    }

    pub(crate) fn create_view(&mut self, name: &str, read_expr: &str) -> Result<(), Error> {
        self.conn.execute_batch(&format!(
            "create or replace view {} as select * from {read_expr}",
            quote_ident(name)
        ))?;
        self.trusted_views.insert(name.to_owned());
        Ok(())
    }

    /// Apply the policy's restrictions, then prove them: the settings read back as locked and every
    /// re-opening statement fails. A lock-down that cannot be shown to hold refuses the open.
    pub(crate) fn lock_down(&self, granted: &[&str]) -> Result<(), Error> {
        // Journaled sources are refused before opening; grant only the files the engine itself reads.
        for statement in engine_restrictions(granted, reader_threads()) {
            self.conn.execute_batch(&statement)?;
        }
        for (name, expected) in LOCKED_SETTING_READBACK {
            let value: String = self.conn.query_row(
                "select value from system.main.duckdb_settings() where name = ?",
                [name],
                |r| r.get(0),
            )?;
            if value != expected {
                return Err(Error::Engine(format!(
                    "Engine lock-down failed: {name} reads {value}, expected {expected}."
                )));
            }
        }
        for statement in MUST_FAIL_AFTER_LOCK {
            if self.conn.execute_batch(statement).is_ok() {
                return Err(Error::Engine(format!(
                    "Engine lock-down failed: \"{statement}\" was accepted after the lock."
                )));
            }
        }
        Ok(())
    }

    /// The lock-down as the engine reports it now: `(name, value)` for the settings the policy pins.
    pub fn locked_settings(&self) -> Result<Vec<(String, String)>, Error> {
        let mut stmt = self.conn.prepare(
            "select name, value from system.main.duckdb_settings() \
             where name in ('enable_external_access','max_temp_directory_size','threads','lock_configuration','memory_limit') order by name",
        )?;
        Ok(stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?)
    }

    /// The handle another thread uses to cancel the running query.
    /// The locked connection, for crates that derive tables on it after open (xlsx detected tables).
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn interrupt_handle(&self) -> Arc<InterruptHandle> {
        self.interrupt.clone()
    }

    /// Validate the source before serving queries or cached resources.
    pub fn check_source(&self) -> Result<(), Error> {
        if (self.kind != Kind::Duckdb || !has_duckdb_journal(&self.path))
            && stamp_of(&self.path).is_ok_and(|stamp| stamp == self.stamp)
            && self
                .extra_stamps
                .iter()
                .all(|(path, was)| stamp_of(path).ok() == *was)
        {
            Ok(())
        } else {
            Err(Error::SourceChanged)
        }
    }

    /// Run `work`, interrupting the connection when the deadline passes. A timeout is reported as
    /// [`Error::TimedOut`]; a cancel from another thread stays [`Error::Interrupted`].
    pub(crate) fn guarded<T>(&self, work: impl FnOnce() -> Result<T, Error>) -> Result<T, Error> {
        self.check_source()?;
        let (done, wait) = mpsc::channel::<()>();
        let (handle, deadline) = (self.interrupt.clone(), self.deadline);
        let timer = std::thread::spawn(move || {
            let expired = wait.recv_timeout(deadline) == Err(mpsc::RecvTimeoutError::Timeout);
            if expired {
                handle.interrupt();
            }
            expired
        });
        let result = work();
        let _ = done.send(());
        let expired = timer.join().unwrap_or(false);
        self.check_source()?;
        match result {
            Err(Error::Interrupted) if expired => Err(Error::TimedOut),
            other => other,
        }
    }

    /// Relations the policy may let user SQL read (`approvedQueryRelations`).
    pub(crate) fn approved_relations(
        &self,
        include_sibling: bool,
    ) -> Result<Vec<QueryRelation>, Error> {
        let sibling = self
            .sibling
            .as_ref()
            .filter(|_| include_sibling)
            .map_or_else(String::new, |s| {
                format!(" or t.table_catalog={}", quote_literal(&s.catalog))
            });
        let mut stmt = self.conn.prepare(&format!(
            "select t.table_catalog, t.table_schema, t.table_name, v.view_definition \
             from information_schema.tables t left join information_schema.views v \
             on t.table_catalog=v.table_catalog and t.table_schema=v.table_schema and t.table_name=v.table_name \
             where t.table_catalog=system.main.current_database(){sibling}"
        ))?;
        let rows = stmt.query_map([], |r| {
            let name: String = r.get(2)?;
            Ok(QueryRelation {
                catalog: r.get(0)?,
                schema: r.get(1)?,
                trusted_view: self.trusted_views.contains(&name),
                name,
                view_sql: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Parser-backed authorisation of user SQL against the approved relations.
    pub fn referenced_query_tables(&self, sql: &str) -> Result<HashSet<String>, Error> {
        dfv_table_policy::validate_sql_size(sql)?;
        self.check_source()?;
        Ok(dfv_table_policy::referenced_query_tables(
            &mut Bridge(&self.conn),
            sql,
        )?)
    }

    /// Parser-backed authorisation of user SQL against the approved relations.
    pub fn assert_read_sql(&self, sql: &str) -> Result<(), Error> {
        let relations = self.approved_relations(self.is_combined(sql))?;
        let mut bridge = Bridge(&self.conn);
        dfv_table_policy::ReadSqlPolicy::new(&mut bridge, self.catalog.clone())
            .validate(sql, &relations)?;
        Ok(())
    }
}
