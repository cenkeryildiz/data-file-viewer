//! Sources the engine does not read itself (SQLite, Arrow, XLSX, DTA, kdb) and the hot/cold sibling.
//! A format crate decodes the file; this module loads the decoded rows into the engine's in-memory
//! catalog *before* the lock-down, so after it the connection can read nothing but that catalog.
//! `D3.17`: the routes that depend only on the session catalog (tables, siblings, combined, cadence).
use crate::duckdb::{Engine, Error, Kind, Sibling, quote_ident, quote_literal, stamp_of};
use crate::operations::{build_combined_query, poll_cadence, series_frequency};
use dfv_table_policy::reader_threads;
use duckdb::types::Value;
use duckdb::{Config, Connection, appender_params_from_iter};
use std::path::{Path, PathBuf};

/// Rows between two cancellation checks while loading.
const CHECK_EVERY: usize = 1024;
const SIBLING: &str = "sibling";
const RESERVED_CATALOGS: [&str; 3] = ["memory", "system", "temp"];
/// Combined statements remembered as sibling-readable; the oldest drops out (the reference's 64).
const COMBINED_MEMORY: usize = 64;

/// One decoded table: SQL column types (DuckDB spelling) and its rows in file order.
pub struct TableLoad<'a> {
    pub name: String,
    pub columns: Vec<(String, String)>,
    pub rows: Box<dyn Iterator<Item = Result<Vec<Value>, Error>> + 'a>,
}

/// What a loader may do while the connection is still unlocked.
pub struct Loader<'a> {
    conn: &'a Connection,
    cancel: &'a dyn Fn() -> Result<(), Error>,
    pub warnings: Vec<String>,
    catalog: Option<String>,
    sibling: Option<Sibling>,
    sibling_path: Option<PathBuf>,
    derived: Vec<String>,
}

impl Loader<'_> {
    /// The still-unlocked connection, for a format crate that derives its own tables (xlsx).
    pub fn conn(&self) -> &Connection {
        self.conn
    }

    /// Mark `name` as queryable but not a navigation entry (a detected sheet table).
    pub fn derive(&mut self, name: &str) {
        self.derived.push(name.to_owned());
    }

    /// A half-built sibling is not a sibling: detach it, so the pair is simply absent (as the reference does).
    pub fn drop_sibling(&mut self) {
        let _ = self
            .conn
            .execute_batch(&format!("detach {}", quote_ident(SIBLING)));
        self.sibling = None;
        self.sibling_path = None;
    }

    /// Make `name` the catalog the user queries (the file stem for SQLite, as the reference does).
    /// A reserved name keeps the default catalog.
    pub fn use_catalog(&mut self, name: &str) -> Result<(), Error> {
        if RESERVED_CATALOGS.contains(&name.to_ascii_lowercase().as_str()) || name.is_empty() {
            return Ok(());
        }
        self.conn
            .execute_batch(&format!("attach ':memory:' as {}", quote_ident(name)))?;
        self.catalog = Some(name.to_owned());
        Ok(())
    }

    /// Create `table` in the user catalog, or in the sibling catalog when `sibling` is set.
    pub fn table(&mut self, table: TableLoad<'_>, sibling: bool) -> Result<(), Error> {
        if table.columns.is_empty() {
            return Err(Error::Invalid(format!(
                "\"{}\" has no columns.",
                table.name
            )));
        }
        let catalog = if sibling {
            Some(SIBLING)
        } else {
            self.catalog.as_deref()
        };
        let qualified = |name: &str| match catalog {
            Some(c) => format!("{}.main.{}", quote_ident(c), quote_ident(name)),
            None => quote_ident(name),
        };
        let definition = table
            .columns
            .iter()
            .map(|(name, sql_type)| format!("{} {sql_type}", quote_ident(name)))
            .collect::<Vec<_>>()
            .join(", ");
        self.conn.execute_batch(&format!(
            "create table {} ({definition})",
            qualified(&table.name)
        ))?;
        let mut appender = match catalog {
            Some(c) => self
                .conn
                .appender_to_catalog_and_db(&table.name, c, "main")?,
            None => self.conn.appender(&table.name)?,
        };
        let width = table.columns.len();
        for (n, row) in table.rows.enumerate() {
            if n % CHECK_EVERY == 0 {
                (self.cancel)()?;
            }
            let row = row?;
            if row.len() != width {
                return Err(Error::Invalid(format!(
                    "\"{}\" has a row with {} cells under {width} columns.",
                    table.name,
                    row.len()
                )));
            }
            appender.append_row(appender_params_from_iter(row))?;
        }
        appender.flush()?;
        Ok(())
    }

    /// Attach the other half of a hot/cold pair that is a DuckDB file, read-only.
    pub fn attach_duckdb_sibling(&mut self, path: &Path) -> Result<(), Error> {
        self.conn.execute_batch(&format!(
            "attach {} as {} (read_only)",
            quote_literal(&path.to_string_lossy()),
            quote_ident(SIBLING)
        ))?;
        self.set_sibling(path, false);
        Ok(())
    }

    /// Start an in-memory sibling for a decoded (SQLite) other half; fill it with `table(.., true)`.
    pub fn begin_memory_sibling(&mut self, path: &Path) -> Result<(), Error> {
        // A read-only DuckDB primary otherwise applies its access mode to this private catalog.
        self.conn.execute_batch(&format!(
            "attach ':memory:' as {} (read_write)",
            quote_ident(SIBLING)
        ))?;
        self.set_sibling(path, true);
        Ok(())
    }

    fn set_sibling(&mut self, path: &Path, sqlite: bool) {
        self.sibling = Some(Sibling {
            catalog: SIBLING.into(),
            sqlite,
        });
        self.sibling_path = Some(path.to_owned());
    }
}

/// What a loader leaves behind for the engine to adopt.
pub(crate) struct Parts {
    warnings: Vec<String>,
    catalog: Option<String>,
    sibling: Option<Sibling>,
    sibling_path: Option<PathBuf>,
    derived: Vec<String>,
}

impl<'a> Loader<'a> {
    pub(crate) fn new(conn: &'a Connection, cancel: &'a dyn Fn() -> Result<(), Error>) -> Self {
        Self {
            conn,
            cancel,
            warnings: vec![],
            catalog: None,
            sibling: None,
            sibling_path: None,
            derived: vec![],
        }
    }

    pub(crate) fn finish(self) -> Parts {
        Parts {
            warnings: self.warnings,
            catalog: self.catalog,
            sibling: self.sibling,
            sibling_path: self.sibling_path,
            derived: self.derived,
        }
    }
}

impl Engine {
    /// Open `path` (already decoded by `kind`'s crate) as an in-memory engine. `load` runs while the
    /// connection can still write; `cancel` is polled between rows. `watch` lists sidecar files whose
    /// change must also make the engine stale (a SQLite `-wal`).
    pub fn open_loaded(
        path: &Path,
        kind: Kind,
        watch: &[PathBuf],
        cancel: &dyn Fn() -> Result<(), Error>,
        load: impl FnOnce(&mut Loader<'_>) -> Result<(), Error>,
    ) -> Result<Self, Error> {
        let path = std::fs::canonicalize(path)
            .map_err(|e| Error::Invalid(format!("Could not open \"{}\": {e}", path.display())))?;
        if !std::fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            return Err(Error::Invalid(format!(
                "\"{}\" is not a regular file.",
                path.display()
            )));
        }
        let stamp = stamp_of(&path)?;
        let config = Config::default()
            .threads(reader_threads() as i64)?
            .max_memory("512MB")?;
        let conn = Connection::open_in_memory_with_flags(config)
            .map_err(|e| Error::Engine(format!("Could not open \"{}\": {e}", path.display())))?;
        let mut engine = Self::bare(conn, kind, path, stamp);
        engine.extra_stamps = watch
            .iter()
            .map(|p| (p.clone(), stamp_of(p).ok()))
            .collect();
        engine.check_source()?;
        let mut loader = Loader::new(&engine.conn, cancel);
        load(&mut loader)?;
        let parts = loader.finish();
        // Every table is already in memory: the locked engine is granted no file at all.
        engine.adopt(parts, &[])?;
        engine.check_source()?;
        Ok(engine)
    }

    /// Take what the loader built, lock the connection down, and name the catalog the user queries.
    pub(crate) fn adopt(&mut self, parts: Parts, granted: &[&str]) -> Result<(), Error> {
        if let Some(c) = &parts.catalog {
            self.conn
                .execute_batch(&format!("use {}", quote_ident(c)))?;
        }
        self.lock_down(granted)?;
        self.catalog = self
            .conn
            .query_row("select system.main.current_database()", [], |r| r.get(0))?;
        if let Some(path) = parts.sibling_path {
            if parts.sibling.as_ref().is_some_and(|s| s.sqlite) {
                let mut wal = path.as_os_str().to_owned();
                wal.push("-wal");
                let wal = PathBuf::from(wal);
                self.extra_stamps.push((wal.clone(), stamp_of(&wal).ok()));
            }
            self.extra_stamps.push((path.clone(), stamp_of(&path).ok()));
        }
        self.sibling = parts.sibling;
        self.derive_tables(parts.derived);
        self.open_warnings.extend(parts.warnings);
        Ok(())
    }

    /// Whether `sql` is a statement `combined_query` produced (the only text that may read the sibling).
    pub(crate) fn is_combined(&self, sql: &str) -> bool {
        self.sibling.is_some()
            && self
                .combined
                .lock()
                .is_ok_and(|seen| seen.iter().any(|s| s == sql))
    }

    fn remember_combined(&self, sql: &str) {
        if let Ok(mut seen) = self.combined.lock() {
            if seen.len() >= COMBINED_MEMORY {
                seen.pop_front();
            }
            seen.push_back(sql.to_owned());
        }
    }

    fn sibling_catalog(&self) -> Result<&str, Error> {
        self.sibling
            .as_ref()
            .map(|s| s.catalog.as_str())
            .ok_or_else(|| {
                Error::Unsupported("No sibling attached — buildCombinedQuery requires one.".into())
            })
    }

    /// Mark tables created after open (a retried sheet preparation) as queryable but not navigation entries.
    pub fn derive_tables(&self, names: impl IntoIterator<Item = String>) {
        if let Ok(mut set) = self.derived_tables.lock() {
            set.extend(names);
        }
    }

    /// Navigation entries: queryable objects minus the derived (detected) sheet tables.
    pub fn list_sidebar_tables(&self) -> Result<Vec<String>, Error> {
        let mut tables = self.list_tables()?;
        if self.kind == Kind::Xlsx {
            let derived = self
                .derived_tables
                .lock()
                .map_err(|_| Error::Engine("The derived-table list is unavailable.".into()))?;
            tables.retain(|t| !derived.contains(t));
        }
        Ok(tables)
    }

    fn tables_of(&self, catalog: &str) -> Result<Vec<String>, Error> {
        self.guarded(|| {
            let mut stmt = self.conn.prepare(
                "select table_name from information_schema.tables where table_catalog = ? order by table_name",
            )?;
            Ok(stmt
                .query_map([catalog], |r| r.get(0))?
                .collect::<Result<_, _>>()?)
        })
    }

    pub fn list_sibling_tables(&self) -> Result<Vec<String>, Error> {
        match &self.sibling {
            Some(s) => self.tables_of(&s.catalog),
            None => Ok(vec![]),
        }
    }

    /// Table names present on both sides of the pair.
    pub fn combinable_table_names(&self) -> Result<Vec<String>, Error> {
        let main = self.list_tables()?;
        Ok(self
            .list_sibling_tables()?
            .into_iter()
            .filter(|t| main.contains(t))
            .collect())
    }

    fn column_names(&self, catalog: &str, table: &str) -> Result<Vec<String>, Error> {
        self.guarded(|| {
            let mut stmt = self.conn.prepare(
                "select column_name from information_schema.columns where table_catalog = ? and table_name = ? order by ordinal_position",
            )?;
            Ok(stmt
                .query_map([catalog, table], |r| r.get(0))?
                .collect::<Result<_, _>>()?)
        })
    }

    /// The synthesized `<table>_combined` statement; only this exact text may then read the sibling.
    pub fn combined_query(
        &self,
        table: &str,
        limit: Option<u64>,
    ) -> Result<(String, Option<&'static str>), Error> {
        let sibling = self.sibling_catalog()?;
        let (main, other) = (
            self.column_names(&self.catalog, table)?,
            self.column_names(sibling, table)?,
        );
        let main: Vec<&str> = main.iter().map(String::as_str).collect();
        let other: Vec<&str> = other.iter().map(String::as_str).collect();
        let built = build_combined_query(table, &self.catalog, sibling, &main, &other, limit)?;
        self.remember_combined(&built.sql);
        Ok((built.sql, built.time_column))
    }

    /// Catalogs to look for a `sheet_metadata` row in, the hot (SQLite) side first.
    fn metadata_catalogs(&self) -> Vec<String> {
        let main_hot = self.kind == Kind::Sqlite;
        let sibling = self.sibling.as_ref();
        let mut out = vec![];
        if main_hot {
            out.push(self.catalog.clone());
        }
        if let Some(s) = sibling.filter(|s| s.sqlite) {
            out.push(s.catalog.clone());
        }
        if !main_hot {
            out.push(self.catalog.clone());
        }
        if let Some(s) = sibling.filter(|s| !s.sqlite) {
            out.push(s.catalog.clone());
        }
        out
    }

    /// The first usable hint among the metadata catalogs; a missing table, row or column is no hint.
    fn metadata_hint<T>(
        &self,
        table: &str,
        column: &str,
        read: impl Fn(&str) -> Option<T>,
    ) -> Result<Option<T>, Error> {
        for catalog in self.metadata_catalogs() {
            if let Some(text) = self.metadata_text(&catalog, table, column)?
                && let Some(hint) = read(&text)
            {
                return Ok(Some(hint));
            }
        }
        Ok(None)
    }

    /// Optional cadence hint; the hot half of a pair is asked first.
    pub fn poll_cadence_seconds(&self, table: &str) -> Result<Option<f64>, Error> {
        self.metadata_hint(table, "extra_json", poll_cadence)
    }

    pub fn series_frequency(&self, table: &str) -> Result<Option<&'static str>, Error> {
        self.metadata_hint(table, "frequency", series_frequency)
    }
}
