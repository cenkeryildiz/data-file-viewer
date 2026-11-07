//! A DuckDB edit commits in a private snapshot, then publishes back to the original dataset path.
//! A descriptor-owned source lock and read-only connection stay alive through publication and receipt.
use dfv_table_duckdb::duckdb::quote_ident;
use dfv_table_policy::{engine_restrictions, reader_threads};
use dfv_table_publication::{
    Identity, PublishError, Publisher, Receipt, SourceState, WriterLock, digest_reader,
};
use duckdb::{
    AccessMode, Config, Connection, params_from_iter,
    types::{TimeUnit, Value},
};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, Write},
    path::Path,
};

#[derive(Debug)]
pub enum Error {
    Locked(String),
    Unsupported(String),
    Invalid(String),
    SourceChanged,
    SchemaChanged,
    Ambiguous,
    InexactValue,
    UnexpectedChanges,
    Database(String),
    Io(std::io::Error),
    Publish(PublishError),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Locked(s) | Self::Unsupported(s) | Self::Invalid(s) | Self::Database(s) => {
                s.fmt(f)
            }
            Self::SourceChanged => {
                f.write_str("The DuckDB source changed; reopen it before editing.")
            }
            Self::SchemaChanged => {
                f.write_str("The DuckDB table schema changed; reopen it before editing.")
            }
            Self::Ambiguous => {
                f.write_str("More than one row matches the edit; nothing was published.")
            }
            Self::InexactValue => {
                f.write_str("The requested value cannot be stored exactly in this column.")
            }
            Self::UnexpectedChanges => f.write_str(
                "The edit changed cells outside its intended target; nothing was published.",
            ),
            Self::Io(e) => e.fmt(f),
            Self::Publish(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<PublishError> for Error {
    fn from(e: PublishError) -> Self {
        Self::Publish(e)
    }
}
impl From<duckdb::Error> for Error {
    fn from(e: duckdb::Error) -> Self {
        let text = e.to_string();
        if text.contains("Could not set lock")
            || text.contains("Conflicting lock")
            || text.contains("different configuration")
        {
            Self::Locked(text)
        } else {
            Self::Database(text)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    pub data_type: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TablePlan {
    pub schema: String,
    pub name: String,
    pub columns: Vec<Column>,
    pub definition: String,
}
#[derive(Debug, Clone)]
pub struct Plan {
    pub source: SourceState,
    pub sha256: String,
    identity: Identity,
    pub tables: Vec<TablePlan>,
}
pub struct CellEdit {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub value: Value,
    pub row: Vec<(String, Value)>,
}
#[derive(Debug)]
pub enum Outcome {
    NoMatch,
    Updated { stored: Value, receipt: Receipt },
}

fn open(path: &Path, access: AccessMode) -> Result<Connection, Error> {
    let threads = reader_threads();
    let config = Config::default()
        .access_mode(access)?
        .threads(threads as i64)?
        .max_memory("512MB")?
        .enable_external_access(false)?
        .enable_autoload_extension(false)?
        .with("autoinstall_known_extensions", "false")?
        .with("allow_persistent_secrets", "false")?;
    let connection = Connection::open_with_flags(path, config)?;
    let text = path
        .to_str()
        .ok_or_else(|| Error::Invalid("The database path is not UTF-8.".into()))?;
    // No external readers are needed: leave allowed_paths empty and apply every other restriction.
    // DuckDB forbids changing allowed_paths once external access has already been disabled at open.
    for statement in engine_restrictions(&[text], threads).into_iter().skip(1) {
        connection.execute_batch(&statement)?;
    }
    Ok(connection)
}

fn no_journal(path: &Path) -> Result<(), Error> {
    for suffix in [".wal", ".wal.checkpoint", ".wal.recovery"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        if !matches!(fs::symlink_metadata(Path::new(&name)),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        {
            return Err(Error::Unsupported(
                "Checkpoint and close journaled DuckDB files before editing.".into(),
            ));
        }
    }
    Ok(())
}

fn tables(connection: &Connection) -> Result<Vec<TablePlan>, Error> {
    let mut stmt=connection.prepare("select schema_name,table_name,sql from system.main.duckdb_tables() where database_name=system.main.current_database() and not internal and not temporary order by schema_name,table_name")?;
    let names = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = Vec::new();
    for (schema, name, definition) in names {
        let mut stmt=connection.prepare("select column_name,data_type from information_schema.columns where table_catalog=system.main.current_database() and table_schema=? and table_name=? order by ordinal_position")?;
        let columns = stmt
            .query_map([&schema, &name], |r| {
                Ok(Column {
                    name: r.get(0)?,
                    data_type: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        result.push(TablePlan {
            schema,
            name,
            columns,
            definition,
        });
    }
    Ok(result)
}

pub fn plan(path: &Path) -> Result<Plan, Error> {
    let source = SourceState::capture(path)?;
    no_journal(path)?;
    let connection = open(path, AccessMode::ReadOnly)?;
    no_journal(path)?;
    let tables = tables(&connection)?;
    let mut source_file = source_file(path)?;
    let identity = Identity::of(&source_file.metadata()?);
    let length = source_file.metadata()?.len();
    let sha256 = digest_reader(&mut source_file, length)?;
    if SourceState::capture(path)? != source {
        return Err(Error::SourceChanged);
    }
    Ok(Plan {
        source,
        tables,
        sha256,
        identity,
    })
}

fn source_file(path: &Path) -> Result<fs::File, Error> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(Error::Unsupported(
            "The source must be a regular file with one link.".into(),
        ));
    }
    // POSIX locks are lost when *any* descriptor for the inode closes, including Publisher's hashes.
    // An OFD read lock conflicts with native DuckDB writers and survives those unrelated closes.
    let lock = libc::flock {
        l_type: libc::F_RDLCK as _,
        l_whence: libc::SEEK_SET as _,
        l_start: 0,
        l_len: 0,
        l_pid: 0,
    };
    // SAFETY: the descriptor is owned by file, and the fully initialized flock is valid for this call.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_OFD_SETLK, &lock) } == -1 {
        let error = std::io::Error::last_os_error();
        return Err(
            if matches!(error.raw_os_error(), Some(libc::EACCES | libc::EAGAIN)) {
                Error::Locked(error.to_string())
            } else {
                Error::Unsupported(format!(
                    "An independent DuckDB source lock is unavailable: {error}"
                ))
            },
        );
    }
    Ok(file)
}

fn rows(
    connection: &Connection,
    sql: &str,
    values: &[Value],
    columns: usize,
) -> Result<Vec<Vec<Value>>, Error> {
    let mut stmt = connection.prepare(sql)?;
    let mut query = stmt.query(params_from_iter(values.iter()))?;
    let mut result = Vec::new();
    while let Some(row) = query.next()? {
        result.push((0..columns).map(|i| row.get(i)).collect::<Result<_, _>>()?);
        if result.len() > 1 {
            break;
        }
    }
    Ok(result)
}

fn sequences(connection: &Connection) -> Result<Vec<(String, String, String)>, Error> {
    // SQL includes the *next* counter. last_value cannot distinguish an unused sequence from its first use.
    let mut query=connection.prepare("select schema_name,sequence_name,sql from system.main.duckdb_sequences() where database_name=system.main.current_database() order by schema_name,sequence_name")?;
    Ok(query
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?)
}

fn integer(value: &Value) -> Option<String> {
    Some(match value {
        Value::TinyInt(v) => v.to_string(),
        Value::SmallInt(v) => v.to_string(),
        Value::Int(v) => v.to_string(),
        Value::BigInt(v) => v.to_string(),
        Value::HugeInt(v) => v.to_string(),
        Value::UTinyInt(v) => v.to_string(),
        Value::USmallInt(v) => v.to_string(),
        Value::UInt(v) => v.to_string(),
        Value::UBigInt(v) => v.to_string(),
        Value::UHugeInt(v) => v.to_string(),
        _ => return None,
    })
}
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Timestamp(a, av), Value::Timestamp(b, bv))
        | (Value::Time64(a, av), Value::Time64(b, bv)) => {
            fn nanos(unit: TimeUnit, v: i64) -> i128 {
                i128::from(v)
                    * match unit {
                        TimeUnit::Second => 1_000_000_000,
                        TimeUnit::Millisecond => 1_000_000,
                        TimeUnit::Microsecond => 1_000,
                        TimeUnit::Nanosecond => 1,
                    }
            }
            nanos(*a, *av) == nanos(*b, *bv)
        }
        (Value::Float(a), Value::Float(b)) => {
            a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
        }
        (Value::Double(a), Value::Double(b)) => {
            a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
        }
        (Value::Enum(a), Value::Text(b)) | (Value::Text(a), Value::Enum(b)) => a == b,
        _ => {
            if let (Some(a), Some(b)) = (integer(a), integer(b)) {
                a == b
            } else {
                a == b
            }
        }
    }
}
// duckdb-rs binds timestamps through microseconds; explicit NS construction avoids truncation.
fn parameter(value: &Value) -> Result<(String, Value), Error> {
    match value {
        Value::Timestamp(TimeUnit::Nanosecond, n) => {
            Ok(("system.main.make_timestamp_ns(?)".into(), Value::BigInt(*n)))
        }
        Value::Enum(text) => Ok(("?".into(), Value::Text(text.clone()))),
        Value::Timestamp(unit, n) | Value::Time64(unit, n) => {
            let factor = match unit {
                TimeUnit::Second => 1_000_000,
                TimeUnit::Millisecond => 1_000,
                _ => 1,
            };
            n.checked_mul(factor).ok_or(Error::InexactValue)?;
            Ok(("?".into(), value.clone()))
        }
        _ => Ok(("?".into(), value.clone())),
    }
}
fn scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::Null
            | Value::Boolean(_)
            | Value::TinyInt(_)
            | Value::SmallInt(_)
            | Value::Int(_)
            | Value::BigInt(_)
            | Value::HugeInt(_)
            | Value::UTinyInt(_)
            | Value::USmallInt(_)
            | Value::UInt(_)
            | Value::UBigInt(_)
            | Value::UHugeInt(_)
            | Value::Float(_)
            | Value::Double(_)
            | Value::Decimal(_)
            | Value::Timestamp(..)
            | Value::Text(_)
            | Value::Blob(_)
            | Value::Date32(_)
            | Value::Time64(..)
            | Value::Interval { .. }
            | Value::Enum(_)
    )
}

/// `source_lock` must remain held across Safe Mode backup, this edit, and its returned publication receipt.
pub fn update_cell(
    publisher: &Publisher,
    source_lock: &WriterLock,
    plan: &Plan,
    edit: &CellEdit,
    work_root: &Path,
) -> Result<Outcome, Error> {
    let target = source_lock.target();
    if SourceState::capture(target)? != plan.source {
        return Err(Error::SourceChanged);
    }
    no_journal(target)?;
    let guard = open(target, AccessMode::ReadOnly)?;
    no_journal(target)?;
    if SourceState::capture(target)? != plan.source {
        return Err(Error::SourceChanged);
    }
    let expected = plan
        .tables
        .iter()
        .find(|t| t.schema == edit.schema && t.name == edit.table)
        .ok_or(Error::SchemaChanged)?;
    let current = tables(&guard)?;
    if current
        .iter()
        .find(|t| t.schema == edit.schema && t.name == edit.table)
        != Some(expected)
    {
        return Err(Error::SchemaChanged);
    }
    let column = expected
        .columns
        .iter()
        .position(|c| c.name == edit.column)
        .ok_or_else(|| Error::Invalid("No such target column.".into()))?;
    let supplied: BTreeMap<_, _> = edit
        .row
        .iter()
        .map(|(name, value)| (name.as_str(), value))
        .collect();
    if edit.row.len() != expected.columns.len()
        || supplied.len() != edit.row.len()
        || expected
            .columns
            .iter()
            .any(|c| !supplied.contains_key(c.name.as_str()))
    {
        return Err(Error::Invalid(
            "An edit requires exactly one pre-edit value for every column.".into(),
        ));
    }
    if !scalar(&edit.value) {
        return Err(Error::Unsupported(
            "Nested cell edits are not supported.".into(),
        ));
    }
    let mut source = source_file(target)?;
    let metadata = source.metadata()?;
    if Identity::of(&metadata) != plan.identity {
        return Err(Error::SourceChanged);
    }
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(Error::Unsupported(
            "The source must be a regular file with one link.".into(),
        ));
    }
    let work = tempfile::Builder::new()
        .prefix("dfv-duckdb-write-")
        .tempdir_in(work_root)?;
    let candidate = work.path().join("candidate.duckdb");
    let mut copy = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&candidate)?;
    let copied = std::io::copy(
        &mut (&mut source).take(metadata.len().saturating_add(1)),
        &mut copy,
    )?;
    copy.flush()?;
    copy.sync_all()?;
    drop(copy);
    if copied != metadata.len() || SourceState::capture(target)? != plan.source {
        return Err(Error::SourceChanged);
    }
    if digest_reader(fs::File::open(&candidate)?, metadata.len())? != plan.sha256 {
        return Err(Error::SourceChanged);
    }
    let mut connection = open(&candidate, AccessMode::ReadWrite)?;
    if tables(&connection)?
        .iter()
        .find(|t| t.schema == edit.schema && t.name == edit.table)
        != Some(expected)
    {
        return Err(Error::SchemaChanged);
    }
    let relation = format!("{}.{}", quote_ident(&edit.schema), quote_ident(&edit.table));
    let values: Vec<_> = expected
        .columns
        .iter()
        .map(|c| supplied[c.name.as_str()].clone())
        .collect();
    let parameters = values
        .iter()
        .map(parameter)
        .collect::<Result<Vec<_>, _>>()?;
    let condition = expected
        .columns
        .iter()
        .zip(&parameters)
        .map(|(c, (expression, _))| {
            format!("{} is not distinct from {expression}", quote_ident(&c.name))
        })
        .collect::<Vec<_>>()
        .join(" and ");
    let bound: Vec<_> = parameters.into_iter().map(|(_, v)| v).collect();
    let transaction = connection.transaction()?;
    let sequence_state = sequences(&transaction)?;
    let before = rows(
        &transaction,
        &format!("select * from {relation} where {condition} limit 2"),
        &bound,
        expected.columns.len(),
    )?;
    if before.is_empty() {
        return Ok(Outcome::NoMatch);
    }
    if before.len() != 1 {
        return Err(Error::Ambiguous);
    }
    if before[0].iter().zip(&values).any(|(a, b)| !same(a, b)) {
        return Err(Error::InexactValue);
    }
    let (set_expression, new_value) = parameter(&edit.value)?;
    let mut update = vec![new_value];
    update.extend(bound);
    let after = rows(
        &transaction,
        &format!(
            "update {relation} set {}={set_expression} where {condition} returning *",
            quote_ident(&edit.column)
        ),
        &update,
        expected.columns.len(),
    )?;
    if after.len() != 1 {
        return Err(Error::UnexpectedChanges);
    }
    if !same(&after[0][column], &edit.value) {
        return Err(Error::InexactValue);
    }
    if before[0]
        .iter()
        .zip(&after[0])
        .enumerate()
        .any(|(i, (old, new))| i != column && !same(old, new))
    {
        return Err(Error::UnexpectedChanges);
    }
    if sequences(&transaction)? != sequence_state {
        return Err(Error::UnexpectedChanges);
    }
    let stored = after[0][column].clone();
    transaction.commit()?;
    // Verify again after commit; only the private copy has been changed.
    if sequences(&connection)? != sequence_state {
        return Err(Error::UnexpectedChanges);
    }
    connection.execute_batch("checkpoint")?;
    drop(connection);
    if SourceState::capture(target)? != plan.source {
        return Err(Error::SourceChanged);
    }
    let mut candidate = fs::File::open(candidate)?;
    let length = candidate.metadata()?.len();
    let sha = digest_reader(&mut candidate, length)?;
    candidate.rewind()?;
    let receipt =
        publisher.publish_reader(source_lock, candidate, length, &sha, Some(&plan.source))?;
    drop(guard);
    drop(source);
    Ok(Outcome::Updated { stored, receipt })
}
