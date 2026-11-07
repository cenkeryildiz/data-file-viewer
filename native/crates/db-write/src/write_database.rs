//! D3.14, SQLite half: `updateCell` for a `.sqlite` source.
//!
//! Decision: the edit runs IN PLACE in one `BEGIN IMMEDIATE` transaction on the source file, not on a staged copy
//! published by rename. SQLite already gives a crash-safe commit (rollback journal or WAL) and a staged copy would
//! (a) lose or orphan `-wal`/`-journal` sidecars and any hot journal, (b) swap the inode under every other reader,
//! (c) copy the whole database for one cell. The transaction itself is the writer lock: `BEGIN IMMEDIATE` takes
//! SQLite's reserved lock, so a second writer is `Locked`, and it is held until commit or rollback.
//! `synchronous=FULL` makes the commit durable. D3.12 receipts are for staged-and-renamed formats and are not used.
//!
//! The lookup, the schema re-check and the UPDATE all happen inside that transaction, so nothing can change between
//! "which row" and "write it". A row rewritten by someone else is matched by its pre-edit value and updates nothing.
use dfv_table_sqlite::{
    Cell, Lookup, OpenMode, Plan, Retype, RowIdentity, SqliteError, TablePlan, check_editable,
    find_row, open_read_only, plan_tables, quote_ident,
};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, ErrorCode, OpenFlags, Transaction, TransactionBehavior};
use std::fmt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Duration;

/// Which file the plan was made from. A path that now names another inode was replaced behind the plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    dev: u64,
    ino: u64,
}

impl FileStamp {
    pub fn of(path: &Path) -> Result<Self, WriteError> {
        let m = std::fs::metadata(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                WriteError::Sqlite(SqliteError::NotFound(path.display().to_string()))
            }
            _ => WriteError::Sqlite(SqliteError::Other(e.to_string())),
        })?;
        Ok(Self {
            dev: m.dev(),
            ino: m.ino(),
        })
    }
}

/// One edit as the grid sends it: the column, its new value, and every cell of the row as it was shown.
#[derive(Debug, Clone)]
pub struct CellEdit {
    pub table: String,
    pub column: String,
    pub new_value: Cell,
    /// Pre-edit value of every column of the row, as `read_rows` presented it.
    pub row: Vec<(String, Cell)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// No row holds those values any more (the TypeScript reported 0 changed rows).
    NoMatch,
    /// Exactly one cell changed. `stored` is what SQLite now holds (column affinity can convert the value).
    Updated { rowid: i64, stored: Cell },
}

#[derive(Debug, Clone, PartialEq)]
pub enum WriteError {
    /// Two or more rows are identical across every column: nothing was changed.
    Ambiguous,
    /// Another connection holds a conflicting lock; nothing was changed.
    Locked,
    /// The file or directory is not writable; nothing was changed.
    ReadOnly,
    /// The path no longer names the file the plan was made from. Nothing was written, or (`committed`) the edit
    /// went into the old file, which is no longer the one at the path.
    SourceReplaced {
        committed: bool,
    },
    /// The table's columns or storage classes differ from the plan: re-plan.
    SchemaChanged,
    UnknownColumn(String),
    /// A value SQLite cannot hold as given (NaN would silently become NULL; a BLOB for a text-presented column).
    InvalidValue(String),
    /// A UNIQUE / CHECK / NOT NULL / FOREIGN KEY rule refused the value; rolled back.
    Constraint(String),
    /// The write changed other than exactly one cell (a trigger, or a driver misreport); rolled back.
    UnexpectedChanges(i64),
    /// COMMIT itself failed; the transaction was rolled back and the file is unchanged unless the message says otherwise.
    CommitFailed(String),
    /// Refusals and read errors from the reads crate (no identity, untyped numbers, corrupt file, ...).
    Sqlite(SqliteError),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ambiguous => f.write_str(
                "Two or more rows are identical across every column, so there is no way to tell which one you edited. The file was not changed.",
            ),
            Self::Locked => f.write_str("The SQLite database is locked by another process; the file was not changed."),
            Self::ReadOnly => f.write_str("The SQLite database is read-only; the file was not changed."),
            Self::SourceReplaced { committed: false } => f.write_str(
                "The file was replaced after it was opened; nothing was written to it.",
            ),
            Self::SourceReplaced { committed: true } => f.write_str(
                "The file was replaced while the edit was saved; the edit is in the old file, not in the one now at the path.",
            ),
            Self::SchemaChanged => f.write_str("The table changed since it was read; re-read it and try again."),
            Self::UnknownColumn(c) => write!(f, "no such column: {c}"),
            Self::InvalidValue(m) => f.write_str(m),
            Self::Constraint(m) => write!(f, "The database refused the value: {m}"),
            Self::UnexpectedChanges(n) => write!(
                f,
                "The SQLite edit changed {n} cells instead of exactly one; rolled back."
            ),
            Self::CommitFailed(m) => write!(f, "The edit could not be committed: {m}"),
            Self::Sqlite(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for WriteError {}

impl From<SqliteError> for WriteError {
    fn from(e: SqliteError) -> Self {
        match e {
            SqliteError::Locked => Self::Locked,
            SqliteError::SchemaChanged => Self::SchemaChanged,
            other => Self::Sqlite(other),
        }
    }
}

fn map(e: rusqlite::Error) -> WriteError {
    let rusqlite::Error::SqliteFailure(failure, message) = &e else {
        return WriteError::Sqlite(SqliteError::Other(e.to_string()));
    };
    let text = message.clone().unwrap_or_else(|| e.to_string());
    match failure.code {
        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => WriteError::Locked,
        ErrorCode::ReadOnly | ErrorCode::PermissionDenied => WriteError::ReadOnly,
        ErrorCode::ConstraintViolation => WriteError::Constraint(text),
        ErrorCode::SchemaChanged => WriteError::SchemaChanged,
        ErrorCode::NotADatabase => WriteError::Sqlite(SqliteError::NotADatabase),
        ErrorCode::DatabaseCorrupt => WriteError::Sqlite(SqliteError::Corrupt),
        _ => WriteError::Sqlite(SqliteError::Other(text)),
    }
}

// Pause hooks exist only in the explicit test build; production ignores all test env.
fn checkpoint(stage: &str) {
    #[cfg(feature = "test-mutations")]
    if std::env::var("DFV_TEST_DBWRITE_FAULT").is_ok_and(|f| f == format!("pause:{stage}")) {
        eprintln!("D314_TEST checkpoint {stage}");
        std::thread::sleep(Duration::from_secs(15));
    }
    #[cfg(not(feature = "test-mutations"))]
    let _ = stage;
}

fn value(cell: &Cell) -> Value {
    match cell {
        Cell::Null => Value::Null,
        Cell::Integer(i) => Value::Integer(*i),
        Cell::Real(r) => Value::Real(*r),
        Cell::Text(s) => Value::Text(s.clone()),
        Cell::Blob(b) => Value::Blob(b.clone()),
    }
}

fn cell(v: ValueRef<'_>) -> Cell {
    match v {
        ValueRef::Null => Cell::Null,
        ValueRef::Integer(i) => Cell::Integer(i),
        ValueRef::Real(r) => Cell::Real(r),
        ValueRef::Text(t) => std::str::from_utf8(t)
            .map_or_else(|_| Cell::Blob(t.to_vec()), |s| Cell::Text(s.to_owned())),
        ValueRef::Blob(b) => Cell::Blob(b.to_vec()),
    }
}

/// A column presented as text because it has no declared type and holds only text is written back as text, whatever
/// the grid sent (the reference's `sqlite_all_varchar` step); every other column is handed to SQLite as given and
/// its declared affinity decides, exactly as for any other writer.
fn coerce(plan: &TablePlan, column: &str, new: &Cell) -> Result<Cell, WriteError> {
    if let Cell::Real(r) = new
        && r.is_nan()
    {
        return Err(WriteError::InvalidValue(
            "NaN cannot be stored: SQLite would write NULL instead.".into(),
        ));
    }
    if plan.retyped.get(column) == Some(&Retype::Varchar) {
        return match new {
            Cell::Null | Cell::Text(_) => Ok(new.clone()),
            Cell::Integer(i) => Ok(Cell::Text(i.to_string())),
            Cell::Real(r) => Ok(Cell::Text(r.to_string())),
            Cell::Blob(_) => Err(WriteError::InvalidValue(format!(
                "\"{column}\" holds text; bytes cannot be saved into it."
            ))),
        };
    }
    Ok(new.clone())
}

fn open_write(path: &Path, busy: Duration) -> Result<Connection, WriteError> {
    // No CREATE: a vanished file must not be recreated empty.
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(map)?;
    c.busy_timeout(busy).map_err(map)?;
    // A double-quoted name that no longer resolves must fail, not read as a string literal.
    for option in [
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_DQS_DML,
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_DQS_DDL,
    ] {
        c.set_db_config(option, false).map_err(map)?;
    }
    c.execute_batch("pragma synchronous = full").map_err(map)?;
    Ok(c)
}

/// Writes one cell. `plan` and `stamp` come from the read that produced the grid; `busy` is how long a lock is waited for.
pub fn update_cell(
    path: &Path,
    plan: &Plan,
    stamp: &FileStamp,
    edit: &CellEdit,
    busy: Duration,
) -> Result<Outcome, WriteError> {
    let table_plan = plan.get(&edit.table).ok_or(WriteError::SchemaChanged)?;
    if !table_plan.columns.iter().any(|c| c.name == edit.column) {
        return Err(WriteError::UnknownColumn(edit.column.clone()));
    }
    // No row values means no WHERE clause; the reference refuses so it can never be "every row".
    if edit.row.is_empty() {
        return Err(WriteError::InvalidValue(format!(
            "The edit did not say which row of \"{}\" it is for, so nothing was changed.",
            edit.table
        )));
    }
    let previous = edit
        .row
        .iter()
        .find(|(n, _)| n == &edit.column)
        .map(|(_, c)| c.clone())
        .ok_or_else(|| WriteError::UnknownColumn(edit.column.clone()))?;
    check_editable(table_plan, &edit.column)?;
    let RowIdentity::Alias(alias) = &table_plan.identity else {
        let RowIdentity::Unavailable(why) = &table_plan.identity else {
            unreachable!()
        };
        return Err(SqliteError::NoIdentity(why.clone()).into());
    };
    let new = coerce(table_plan, &edit.column, &edit.new_value)?;

    if FileStamp::of(path)? != *stamp {
        return Err(WriteError::SourceReplaced { committed: false });
    }
    let mut connection = open_write(path, busy)?;
    let tx = Transaction::new(&mut connection, TransactionBehavior::Immediate).map_err(map)?;
    checkpoint("after_begin");
    // The lock is ours now: re-check identity and re-plan against what is really in the file.
    if FileStamp::of(path)? != *stamp {
        return Err(WriteError::SourceReplaced { committed: false });
    }
    {
        // A reader may join while a writer holds RESERVED, in both journal modes.
        let reader = open_read_only(path, OpenMode::ReadOnly, busy)?;
        let fresh = plan_tables(&reader, Some(plan))?;
        if fresh.get(&edit.table) != Some(table_plan) {
            return Err(WriteError::SchemaChanged);
        }
    }
    let rowid = match find_row(&tx, &edit.table, table_plan, &edit.row)? {
        Lookup::NoMatch => return Ok(Outcome::NoMatch),
        Lookup::Ambiguous => return Err(WriteError::Ambiguous),
        Lookup::One(rowid) => rowid,
    };
    // `rowid` says WHICH row and the cell's pre-edit value says it is still the one on screen.
    let sql = format!(
        "update {t} set {c} = ?1 where {alias} = ?2 and {c} is ?3",
        t = quote_ident(&edit.table),
        c = quote_ident(&edit.column)
    );
    let before = tx.total_changes();
    let direct = tx
        .execute(&sql, [value(&new), Value::Integer(rowid), value(&previous)])
        .map_err(map)?;
    checkpoint("after_update");
    // total_changes also counts rows a trigger touched; both must say "one cell".
    let touched = tx.total_changes() - before;
    if direct != 1 || touched != 1 {
        return Err(WriteError::UnexpectedChanges(touched as i64));
    }
    // A reader still holding SHARED in rollback-journal mode makes COMMIT busy; that is a lock, not a failed disk.
    tx.commit().map_err(|e| match map(e) {
        WriteError::Locked => WriteError::Locked,
        other => WriteError::CommitFailed(other.to_string()),
    })?;
    checkpoint("after_commit");
    let stored = connection
        .query_row(
            &format!(
                "select {} from {} where {alias} = ?1",
                quote_ident(&edit.column),
                quote_ident(&edit.table)
            ),
            [rowid],
            |r| Ok(cell(r.get_ref(0)?)),
        )
        .map_err(map)?;
    if FileStamp::of(path)? != *stamp {
        return Err(WriteError::SourceReplaced { committed: true });
    }
    Ok(Outcome::Updated { rowid, stored })
}
