//! Source-identity checked mutations. Writers stage/read back their own formats; publication owns replacement.
use crate::safe_mode::error;
use crate::write_support::{self as support, Fail, Ledger, Published, ReceiptJson, Scalar};
use crate::{Tables, counter, text};
use dfv_table_duckdb::Kind;
use dfv_table_protocol::errors::*;
use dfv_table_protocol::{Control, ErrorBody};
use dfv_table_publication::{Protection, Publisher, SourceState};
use serde_json::{Map, Value, json};
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_EDIT_BYTES: u64 = 256 << 20;

pub(crate) fn writable(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::Duckdb
            | Kind::Sqlite
            | Kind::Csv
            | Kind::Parquet
            | Kind::Arrow
            | Kind::Feather
            | Kind::Xlsx
    )
}
fn storage() -> Result<(Publisher, Ledger), ErrorBody> {
    let root = std::env::var_os("DFV_TABLE_STATE_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| error(READ_ONLY, "Persistent save storage is unavailable."))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)
        .map_err(|_| {
            error(
                QUERY_FAILED,
                "Persistent save storage could not be created.",
            )
        })?;
    let meta = fs::symlink_metadata(&root)
        .map_err(|_| error(QUERY_FAILED, "Save storage is unavailable."))?;
    if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
        return Err(error(
            POLICY_REFUSED,
            "Save storage must be a private directory.",
        ));
    }
    let root =
        fs::canonicalize(root).map_err(|_| error(QUERY_FAILED, "Save storage is unavailable."))?;
    let publisher = Publisher::new(
        &root.join("publication"),
        Protection {
            paths: vec![root.clone()],
            ..Protection::default()
        },
    )
    .map_err(|_| error(QUERY_FAILED, "Publication storage is unavailable."))?;
    Ok((publisher, Ledger(root.join("mutations"))))
}

/// Restore a comparison grant only from the original private ledger and verified publication.
pub(crate) fn restore_backup(
    source: &Path,
    kind: Kind,
    path: &str,
    control: &Control,
) -> Result<dfv_table_backup_diff::Backup, ErrorBody> {
    let invalid = || {
        error(
            STALE_SOURCE,
            "The remembered backup is missing, changed or unverified.",
        )
    };
    let path = Path::new(path);
    let meta = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if !meta.is_file() || meta.len() > MAX_EDIT_BYTES {
        return Err(invalid());
    }
    let path = fs::canonicalize(path).map_err(|_| invalid())?;
    if !support::is_backup_target(source, &path) {
        return Err(error(
            POLICY_REFUSED,
            "The backup does not belong to this source.",
        ));
    }
    let (publisher, ledger) = storage()?;
    let records = fs::read_dir(&ledger.0).map_err(|_| invalid())?;
    let mut restored = None;
    for (index, entry) in records.enumerate() {
        control.check()?;
        if index >= 10_000 {
            return Err(error(
                RESOURCE_LIMIT,
                "The backup history exceeds the restore limit.",
            ));
        }
        let entry = entry.map_err(|_| invalid())?;
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix("mutation-"))
            .and_then(|name| name.strip_suffix(".json"))
            .filter(|id| support::valid_id(id))
        else {
            continue;
        };
        let Some(record) = ledger.read(id) else {
            continue;
        };
        let receipt = &record["receipt"];
        if record["format"] != "dfv-table-mutation"
            || record["version"] != 1
            || record["state"] != "published"
            || receipt["operation"] != "createBackup"
            || receipt["outcome"] != "published"
            || receipt["source_before"]["path"].as_str() != source.to_str()
            || receipt["source_before"]["file_kind"] != kind.as_str()
            || receipt["backup_path"].as_str() != path.to_str()
        {
            continue;
        }
        if restored.is_some() {
            return Err(invalid());
        }
        let publication_id = record["receipt_id"].as_str().ok_or_else(invalid)?;
        let published = publisher
            .inspect_matching(publication_id, |target, original| {
                target == path && original.is_none()
            })
            .map_err(|_| invalid())?;
        control.check()?;
        if !published.finalized || !published.receipt.durable {
            return Err(invalid());
        }
        restored = Some(dfv_table_backup_diff::Backup {
            path: path.clone(),
            length: published.length,
            sha256: published.sha256,
            source: SourceState::capture(source).map_err(|_| invalid())?,
            receipt: published.receipt,
        });
    }
    restored.ok_or_else(invalid)
}
fn row(args: &Map<String, Value>) -> Result<Vec<(String, Scalar)>, ErrorBody> {
    let r = args
        .get("row_values")
        .and_then(Value::as_object)
        .filter(|r| !r.is_empty() && r.len() <= 2048)
        .ok_or_else(|| {
            error(
                MALFORMED_VALUE,
                "An edit needs the pre-edit values of its row.",
            )
        })?;
    r.iter()
        .map(|(k, v)| Ok((k.clone(), support::scalar(v)?)))
        .collect()
}
fn backup_error(e: dfv_table_backup_diff::BackupError) -> ErrorBody {
    use dfv_table_backup_diff::BackupError::*;
    let code = match e {
        NotApplicable => READ_ONLY,
        SourceChanged | Unverified => STALE_SOURCE,
        TooLarge { .. } => RESOURCE_LIMIT,
        _ => QUERY_FAILED,
    };
    error(
        code,
        "A verified backup could not be created; editing stays locked.",
    )
}
fn make_backup(
    tables: &mut Tables,
    id: &str,
    publisher: &Publisher,
    lock: &dfv_table_publication::WriterLock,
) -> Result<(), ErrorBody> {
    let engine = tables.engine(id)?;
    engine
        .check_source()
        .map_err(|_| error(STALE_SOURCE, "The source changed before its backup."))?;
    let sqlite = engine.kind == Kind::Sqlite;
    let snapshot_directory = if sqlite {
        Some(
            tempfile::tempdir()
                .map_err(|_| error(QUERY_FAILED, "Private backup storage is unavailable."))?,
        )
    } else {
        None
    };
    let backup = if let Some(directory) = &snapshot_directory {
        let snapshot = directory.path().join("snapshot.sqlite");
        dfv_table_sqlite::backup_snapshot(lock.target(), &snapshot).map_err(|_| {
            error(
                RUNTIME_BUSY,
                "A consistent SQLite backup could not be created; editing stays locked.",
            )
        })?;
        engine
            .check_source()
            .map_err(|_| error(STALE_SOURCE, "The source changed during its backup."))?;
        dfv_table_backup_diff::create_backup_from(
            publisher,
            lock,
            &snapshot,
            || Ok(()),
            &Default::default(),
        )
    } else {
        dfv_table_backup_diff::create_backup(publisher, lock, || Ok(()), &Default::default())
    }
    .map_err(backup_error)?;
    engine
        .check_source()
        .map_err(|_| error(STALE_SOURCE, "The source changed during its backup."))?;
    let expected = &tables.sessions.get(id)?.current.identity;
    dfv_table_publication::verify_file(&expected.path, expected.size, &expected.fingerprint)
        .map_err(|_| error(STALE_SOURCE, "The source changed during its backup."))?;
    if !sqlite && (backup.length != expected.size || backup.sha256 != expected.fingerprint) {
        return Err(error(
            STALE_SOURCE,
            "The source changed before its backup completed; reopen it.",
        ));
    }
    let state = tables.writes.get_mut(id).expect("open creates state");
    state.backup = Some(backup);
    state.backup_reader = None;
    state.backup_directory = None;
    Ok(())
}
fn sqlite_value(value: &Scalar) -> Result<dfv_table_sqlite::Cell, Fail> {
    use dfv_table_sqlite::Cell as S;
    Ok(match value {
        Scalar::Null => S::Null,
        Scalar::Bool(v) => S::Integer(i64::from(*v)),
        Scalar::Int(v) => S::Integer(i64::try_from(*v).map_err(|_| {
            support::refuse(
                MALFORMED_VALUE,
                "This integer exceeds SQLite's exact range.",
            )
        })?),
        Scalar::Float(v) => S::Real(*v),
        Scalar::Text(v) => S::Text(v.clone()),
    })
}
fn duck_value(value: &Scalar) -> Result<duckdb::types::Value, Fail> {
    use duckdb::types::Value as D;
    Ok(match value {
        Scalar::Null => D::Null,
        Scalar::Bool(v) => D::Boolean(*v),
        Scalar::Int(v) => D::HugeInt(*v),
        Scalar::Float(v) => D::Double(*v),
        Scalar::Text(v) => D::Text(v.clone()),
    })
}
fn arrow_error(e: dfv_table_arrow_write::Error) -> Result<Published, Fail> {
    use dfv_table_arrow_write::Error::*;
    let code = match e {
        NoMatch => return Ok(Published::NoMatch),
        Ambiguous(_) => AMBIGUOUS_ROW,
        UnsupportedType(_) | Unsupported(_) => UNSUPPORTED,
        Source(_) | Write(_) => QUERY_FAILED,
        _ => MALFORMED_VALUE,
    };
    Err(support::refuse(
        code,
        "The edit could not be represented exactly in this file.",
    ))
}
fn sqlite_write(
    path: &Path,
    table: &str,
    column: &str,
    value: &Scalar,
    row: &[(String, Scalar)],
) -> Result<Published, Fail> {
    use dfv_table_db_write::{Outcome, WriteError};
    let stamp = dfv_table_db_write::FileStamp::of(path)
        .map_err(|_| support::refuse(STALE_SOURCE, "The source changed."))?;
    let reader = dfv_table_sqlite::open_read_only(
        path,
        dfv_table_sqlite::OpenMode::ReadOnly,
        Duration::ZERO,
    )
    .map_err(|_| support::refuse(QUERY_FAILED, "The SQLite source could not be read."))?;
    let plan = dfv_table_sqlite::plan_tables(&reader, None)
        .map_err(|_| support::refuse(QUERY_FAILED, "The SQLite source could not be planned."))?;
    drop(reader);
    let edit = dfv_table_db_write::CellEdit {
        table: table.into(),
        column: column.into(),
        new_value: sqlite_value(value)?,
        row: row
            .iter()
            .map(|(k, v)| Ok((k.clone(), sqlite_value(v)?)))
            .collect::<Result<_, Fail>>()?,
    };
    match dfv_table_db_write::update_cell(path, &plan, &stamp, &edit, Duration::ZERO) {
        Ok(Outcome::NoMatch) => Ok(Published::NoMatch),
        Ok(Outcome::Updated { .. }) => Ok(Published::Yes {
            receipt: None,
            reconciled: false,
        }),
        Err(e) => {
            let code = match e {
                WriteError::Ambiguous => AMBIGUOUS_ROW,
                WriteError::Locked => RUNTIME_BUSY,
                WriteError::ReadOnly => READ_ONLY,
                WriteError::SourceReplaced { committed: true } | WriteError::CommitFailed(_) => {
                    MUTATION_UNKNOWN
                }
                WriteError::SourceReplaced { committed: false } => STALE_SOURCE,
                WriteError::SchemaChanged => TABLE_CHANGED,
                _ => MALFORMED_VALUE,
            };
            Err(ErrorBody::new(code, "The SQLite edit did not complete.")
                .outcome(if code == MUTATION_UNKNOWN {
                    "unknown"
                } else {
                    "not-published"
                })
                .into())
        }
    }
}

struct CsvTarget {
    dialect: dfv_table_csv_write::Dialect,
    row: Vec<(String, Option<String>)>,
    value: Option<String>,
    numeric: bool,
    decimal_comma: bool,
    skip_lines: usize,
    sha256: String,
}

/// Recover the original text of a uniquely matched displayed row; the byte writer still locates the record itself.
fn csv_target(
    engine: &dfv_table_duckdb::Engine,
    table: &str,
    column: &str,
    value: &Scalar,
    row: &[(String, Scalar)],
    sha256: &str,
    control: &Control,
) -> Result<Option<CsvTarget>, ErrorBody> {
    use dfv_table_duckdb::duckdb::{quote_ident as qi, quote_literal as ql};
    let decimal_comma = engine
        .number_locale
        .as_ref()
        .is_some_and(|r| r.locale == Some(dfv_table_duckdb::locale::NumberLocale::Eu));
    let locale = if decimal_comma {
        ", decimal_separator=',', thousands='.'"
    } else {
        ""
    };
    let result = crate::controlled(engine, control, || {
        let c = engine.conn();
        let (delimiter,quote,escape,header,skip,date_format,timestamp_format):(String,String,String,bool,i64,Option<String>,Option<String>)=
            c.query_row(&format!("select Delimiter,Quote,Escape,HasHeader,SkipRows,DateFormat,TimestampFormat from sniff_csv({}{locale})",ql(&engine.path.to_string_lossy())),[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))?;
        let quote = if quote == "(empty)" {
            String::new()
        } else {
            quote
        };
        let escape = if escape == "(empty)" {
            String::new()
        } else {
            escape
        };
        if delimiter.len() != 1 || quote.len() > 1 || skip < 0 {
            return Err(dfv_table_duckdb::Error::Unsupported("CSV dialect".into()));
        }
        let columns = engine.query_columns(&engine.catalog, "main", table)?;
        let source_type = columns
            .iter()
            .find(|c| c.name == column)
            .ok_or_else(|| dfv_table_duckdb::Error::Invalid("Column".into()))?
            .data_type
            .as_str();
        let mut ordinal = "__dfv_csv_record".to_owned();
        while columns.iter().any(|c| c.name == ordinal) {
            ordinal.push('_');
        }
        let ordinal = qi(&ordinal);
        let names = columns
            .iter()
            .map(|c| format!("_raw.{}", qi(&c.name)))
            .collect::<Vec<_>>()
            .join(",");
        let predicates = row
            .iter()
            .map(|(name, _)| format!("{} is not distinct from ?", qi(name)))
            .collect::<Vec<_>>()
            .join(" and ");
        let parameters = row
            .iter()
            .map(|(_, v)| {
                duck_value(v).map_err(|_| dfv_table_duckdb::Error::Invalid("Row value".into()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let raw = format!(
            "read_csv({},all_varchar=true,header={header},skip={skip},delim={},quote={},escape={}{locale})",
            ql(&engine.path.to_string_lossy()),
            ql(&delimiter),
            ql(&quote),
            ql(&escape)
        );
        let sql = format!(
            "with _typed as (select row_number() over () as {ordinal},* from {}), _raw as (select row_number() over () as {ordinal},* from {raw}) select {names},(select count(*) from _typed),(select count(*) from _raw) from _raw join (select {ordinal} from _typed where {predicates} limit 2) as _match using({ordinal})",
            qi(table)
        );
        let mut statement = c.prepare(&sql)?;
        let rows = statement
            .query_map(duckdb::params_from_iter(parameters), |r| {
                let values = (0..columns.len())
                    .map(|i| r.get::<_, Option<String>>(i))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((
                    values,
                    r.get::<_, i64>(columns.len())?,
                    r.get::<_, i64>(columns.len() + 1)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let numeric = matches!(
            source_type,
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
        ) || source_type.starts_with("DECIMAL(");
        let value = match value {
            Scalar::Null => None,
            _ if numeric || source_type == "BOOLEAN" => c.query_row(
                &format!("select cast(cast(? as {source_type}) as varchar)"),
                [duck_value(value)
                    .map_err(|_| dfv_table_duckdb::Error::Invalid("Value".into()))?],
                |r| r.get(0),
            )?,
            _ if source_type == "DATE" && date_format.is_some() => c.query_row(
                "select strftime(cast(? as date),?)",
                [value.text(), date_format],
                |r| r.get(0),
            )?,
            _ if source_type == "TIMESTAMP" && timestamp_format.is_some() => c.query_row(
                "select strftime(cast(? as timestamp),?)",
                [value.text(), timestamp_format],
                |r| r.get(0),
            )?,
            _ => value.text(),
        };
        Ok((rows, columns, delimiter, quote, skip, value, numeric))
    })?;
    let (mut rows, columns, delimiter, quote, skip, value, numeric) = result;
    if rows.len() > 1 {
        return Err(error(
            AMBIGUOUS_ROW,
            "More than one source row matches the edit.",
        ));
    }
    let Some((values, typed_count, raw_count)) = rows.pop() else {
        return Ok(None);
    };
    if typed_count != raw_count {
        return Err(error(
            UNSUPPORTED,
            "The CSV read and raw record counts differ; editing is unavailable.",
        ));
    }
    Ok(Some(CsvTarget {
        dialect: dfv_table_csv_write::Dialect {
            delimiter: delimiter.as_bytes()[0],
            quote: quote.as_bytes().first().copied().unwrap_or(b'"'),
        },
        row: columns
            .into_iter()
            .zip(values)
            .map(|(c, v)| (c.name, v))
            .collect(),
        value,
        numeric,
        decimal_comma,
        skip_lines: skip as usize,
        sha256: sha256.into(),
    }))
}

struct CellEdit<'a> {
    table: &'a str,
    column: &'a str,
    value: &'a Scalar,
    row: &'a [(String, Scalar)],
}

fn save(
    publisher: &Publisher,
    lock: &dfv_table_publication::WriterLock,
    kind: Kind,
    edit: CellEdit<'_>,
    xlsx_target: Option<&Value>,
    csv_target: Option<&CsvTarget>,
) -> Result<Published, Fail> {
    let CellEdit {
        table,
        column,
        value,
        row,
    } = edit;
    let path = lock.target();
    if kind == Kind::Sqlite {
        return sqlite_write(path, table, column, value, row);
    }
    if kind == Kind::Duckdb {
        use dfv_table_db_write::duckdb_write as d;
        let plan = d::plan(path)
            .map_err(|_| support::refuse(QUERY_FAILED, "The database could not be planned."))?;
        let edit = d::CellEdit {
            schema: "main".into(),
            table: table.into(),
            column: column.into(),
            value: duck_value(value)?,
            row: row
                .iter()
                .map(|(k, v)| Ok((k.clone(), duck_value(v)?)))
                .collect::<Result<_, Fail>>()?,
        };
        let work = tempfile::tempdir().map_err(|_| {
            support::refuse(QUERY_FAILED, "The save workspace could not be created.")
        })?;
        return match d::update_cell(publisher, lock, &plan, &edit, work.path()) {
            Ok(d::Outcome::NoMatch) => Ok(Published::NoMatch),
            Ok(d::Outcome::Updated { receipt, .. }) => Ok(Published::Yes {
                receipt: Some(receipt),
                reconciled: false,
            }),
            Err(d::Error::Publish(e)) => support::reconcile(publisher, e),
            Err(e) => Err(support::refuse(
                match e {
                    d::Error::Locked(_) => RUNTIME_BUSY,
                    d::Error::Unsupported(_) => UNSUPPORTED,
                    d::Error::SourceChanged => STALE_SOURCE,
                    d::Error::SchemaChanged => TABLE_CHANGED,
                    d::Error::Ambiguous => AMBIGUOUS_ROW,
                    _ => MALFORMED_VALUE,
                },
                "The database edit could not be saved exactly.",
            )),
        };
    }
    let expected = SourceState::capture(path).map_err(|e| {
        support::reconcile(publisher, e)
            .err()
            .unwrap_or_else(|| support::refuse(STALE_SOURCE, "The source changed."))
    })?;
    let new_text = value.text();
    let row_text: Vec<_> = row.iter().map(|(k, v)| (k.clone(), v.text())).collect();
    let refs: Vec<_> = row_text
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_deref()))
        .collect();
    let edit = dfv_table_arrow_write::CellEdit {
        column,
        value: new_text.as_deref(),
        row: &refs,
    };
    if kind == Kind::Parquet {
        return match dfv_table_parquet_write::save_cell(publisher, lock, &Default::default(), &edit)
        {
            Ok(receipt) => Ok(Published::Yes {
                receipt: Some(receipt),
                reconciled: false,
            }),
            Err(dfv_table_parquet_write::Error::Edit(e)) => arrow_error(e),
            Err(dfv_table_parquet_write::Error::Publication(e)) => support::reconcile(publisher, e),
            Err(e) => Err(support::refuse(
                match e {
                    dfv_table_parquet_write::Error::TooLarge(_) => RESOURCE_LIMIT,
                    dfv_table_parquet_write::Error::Changed => STALE_SOURCE,
                    dfv_table_parquet_write::Error::Unsupported(_) => UNSUPPORTED,
                    _ => QUERY_FAILED,
                },
                "The Parquet edit could not be saved exactly.",
            )),
        };
    }
    let bytes = match kind {
        Kind::Arrow | Kind::Feather => {
            match dfv_table_arrow_write::edit_cell(path, &Default::default(), &edit) {
                Ok(v) => v,
                Err(e) => return arrow_error(e),
            }
        }
        Kind::Csv => {
            let src = fs::read(path)
                .map_err(|_| support::refuse(QUERY_FAILED, "The CSV source could not be read."))?;
            let target = csv_target
                .ok_or_else(|| support::refuse(NO_MATCHING_ROW, "No source row matched."))?;
            if dfv_table_publication::digest(&src) != target.sha256 {
                return Err(support::refuse(
                    STALE_SOURCE,
                    "The CSV source changed before saving.",
                ));
            }
            let refs = target
                .row
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_deref()))
                .collect::<Vec<_>>();
            let new = target
                .value
                .as_deref()
                .map_or(dfv_table_csv_write::NewValue::Null, |text| {
                    if target.numeric {
                        dfv_table_csv_write::NewValue::Number {
                            text,
                            decimal_comma: target.decimal_comma,
                        }
                    } else {
                        dfv_table_csv_write::NewValue::Text(text)
                    }
                });
            let split = if src.contains(&b'\n') { b'\n' } else { b'\r' };
            let prefix = src
                .split_inclusive(|b| *b == split)
                .take(target.skip_lines)
                .map(|line| line.len())
                .sum::<usize>();
            match dfv_table_csv_write::update_cell(
                &src[prefix..],
                target.dialect,
                column,
                dfv_table_csv_write::Target::Match(&refs),
                new,
            ) {
                Ok(v) => {
                    let mut out = src[..prefix].to_vec();
                    out.extend(v);
                    out
                }
                Err(dfv_table_csv_write::WriteError::RowNotFound) => return Ok(Published::NoMatch),
                Err(dfv_table_csv_write::WriteError::Ambiguous { .. }) => {
                    return Err(support::refuse(
                        AMBIGUOUS_ROW,
                        "More than one CSV row matches.",
                    ));
                }
                Err(_) => {
                    return Err(support::refuse(
                        MALFORMED_VALUE,
                        "The CSV edit cannot be saved exactly.",
                    ));
                }
            }
        }
        Kind::Xlsx => {
            let target = xlsx_target.ok_or_else(|| {
                support::refuse(UNSUPPORTED, "This workbook cell could not be located.")
            })?;
            let names = target["column_names"]
                .as_array()
                .and_then(|v| {
                    v.iter()
                        .map(|v| v.as_str().map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| support::refuse(MALFORMED_VALUE, "Invalid worksheet target."))?;
            let cv = |s: &Scalar| match s {
                Scalar::Null => dfv_table_xlsx_patch::CellValue::Null,
                Scalar::Bool(v) => dfv_table_xlsx_patch::CellValue::Bool(*v),
                Scalar::Int(v) => dfv_table_xlsx_patch::CellValue::BigInt(v.to_string()),
                Scalar::Float(v) => dfv_table_xlsx_patch::CellValue::Number(*v),
                Scalar::Text(v) => dfv_table_xlsx_patch::CellValue::Text(v.clone()),
            };
            let previous = row
                .iter()
                .find(|(k, _)| k == column)
                .ok_or_else(|| support::refuse(MALFORMED_VALUE, "The pre-edit cell is missing."))?;
            let src = fs::read(path)
                .map_err(|_| support::refuse(QUERY_FAILED, "The workbook could not be read."))?;
            let request = dfv_table_xlsx_patch::PatchRequest {
                sheet_path: target["sheet_path"].as_str().unwrap_or_default().into(),
                column_name: target["column_name"].as_str().unwrap_or_default().into(),
                column_names: names,
                row_ordinal: target["row_ordinal"]
                    .as_i64()
                    .ok_or_else(|| support::refuse(MALFORMED_VALUE, "Invalid worksheet row."))?,
                verbatim: true,
                expected_sha256: Some(dfv_table_publication::digest(&src)),
                expected_current: cv(&previous.1),
                new_value: cv(value),
            };
            dfv_table_xlsx_patch::patch_cell(&src, &request)
                .map_err(|_| {
                    support::refuse(
                        MALFORMED_VALUE,
                        "The workbook edit cannot be saved exactly.",
                    )
                })?
                .bytes
        }
        _ => return Err(support::refuse(READ_ONLY, "This format is read-only.")),
    };
    match publisher.publish(lock, &bytes, Some(&expected)) {
        Ok(receipt) => Ok(Published::Yes {
            receipt: Some(receipt),
            reconciled: false,
        }),
        Err(e) => support::reconcile(publisher, e),
    }
}

pub(crate) fn call(
    tables: &mut Tables,
    method: &str,
    args: &Map<String, Value>,
    control: &Control,
) -> Result<Value, ErrorBody> {
    call_inner(tables, method, args, control).map_err(|e| {
        if method != "queryMutationOutcome" && e.mutation_outcome.is_none() {
            e.outcome("not-published")
        } else {
            e
        }
    })
}

fn call_inner(
    tables: &mut Tables,
    method: &str,
    args: &Map<String, Value>,
    control: &Control,
) -> Result<Value, ErrorBody> {
    let (publisher, ledger) = storage()?;
    let mutation_id = args.get("mutation_id").and_then(Value::as_str);
    if method == "queryMutationOutcome" {
        let id = mutation_id
            .filter(|v| support::valid_id(v))
            .ok_or_else(|| error(MALFORMED_VALUE, "Invalid mutation id."))?;
        return Ok(ledger.resolve(id, &publisher));
    }
    let (id, revision) = tables.read_session(args)?;
    if counter(args, "expected_revision")? != Some(revision) {
        return Err(error(
            STALE_SOURCE,
            "Saving requires the current source revision.",
        ));
    }
    let engine = tables.engine(&id)?;
    let kind = engine.kind;
    if !writable(kind)
        || !engine.edit_blockers.is_empty()
        || tables.requests.get(&id).is_some_and(|r| r.force_read_only)
    {
        return Err(error(READ_ONLY, "This source is not editable."));
    }
    let identity = tables.sessions.get(&id)?.current.identity.clone();
    if identity.size > MAX_EDIT_BYTES {
        return Err(error(
            RESOURCE_LIMIT,
            "This source exceeds the edit size limit.",
        ));
    }
    let lock = publisher
        .lock(&identity.path)
        .map_err(|_| error(RUNTIME_BUSY, "The source is locked by another writer."))?;
    dfv_table_publication::verify_file(&identity.path, identity.size, &identity.fingerprint)
        .map_err(|_| error(STALE_SOURCE, "The source changed; reopen it before saving."))?;
    control.check().map_err(|e| e.outcome("not-published"))?;
    if method == "setSafeMode" {
        let enabled = args
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| error(MALFORMED_VALUE, "Safe Mode needs an enabled boolean."))?;
        if enabled {
            tables
                .writes
                .get_mut(&id)
                .expect("session state")
                .mode
                .turn_on();
        } else {
            if tables.writes[&id]
                .backup
                .as_ref()
                .is_none_or(|b| !b.intact())
            {
                make_backup(tables, &id, &publisher, &lock)?;
            }
            let backup = tables.writes[&id].backup.clone().expect("created backup");
            tables
                .writes
                .get_mut(&id)
                .expect("session state")
                .mode
                .turn_off(|| Ok(backup))
                .map_err(backup_error)?;
        }
        return Ok(
            json!({"enabled":tables.writes[&id].mode.enabled(),"backup_path":tables.writes[&id].backup.as_ref().map(|b|&b.path)}),
        );
    }
    let mid = mutation_id
        .filter(|v| support::valid_id(v))
        .ok_or_else(|| error(MALFORMED_VALUE, "A save needs a unique mutation id."))?;
    if method == "updateCell" && tables.writes[&id].mode.enabled() {
        return Err(error(
            READ_ONLY,
            "Safe Mode is on; authorize editing first.",
        ));
    }
    let request = if method == "updateCell" {
        Some((
            text(args, "table")?.to_owned(),
            text(args, "column")?.to_owned(),
            support::scalar(
                args.get("new_value")
                    .ok_or_else(|| error(MALFORMED_VALUE, "The edit needs a new value."))?,
            )?,
            row(args)?,
        ))
    } else {
        None
    };
    if let Some((table, _, _, row)) = &request
        && kind != Kind::Xlsx
    {
        let editability = crate::controlled(tables.engine(&id)?, control, || {
            tables
                .engine(&id)
                .map_err(|_| dfv_table_duckdb::Error::SourceChanged)?
                .check_editable_select(&format!(
                    "select * from {}",
                    dfv_table_duckdb::duckdb::quote_ident(table)
                ))
        })?;
        if !editability.editable
            || row.len() != editability.columns.len()
            || editability
                .columns
                .iter()
                .any(|column| !row.iter().any(|(name, _)| name == column))
        {
            return Err(error(
                MALFORMED_VALUE,
                "An edit needs exactly one pre-edit value for every source column.",
            ));
        }
    }
    let xlsx_location = if kind == Kind::Xlsx && method == "updateCell" {
        let location = crate::xlsx::read(tables, "locateXlsxEdit", args, control)?;
        if location.get("target").is_none() {
            return Err(error(QUERY_FAILED, "The worksheet target was unavailable."));
        }
        if !location["target"].is_null()
            && location["sha256"].as_str() != Some(identity.fingerprint.as_str())
        {
            return Err(error(
                STALE_SOURCE,
                "The workbook changed while locating the edited cell.",
            ));
        }
        Some(location)
    } else {
        None
    };
    let csv_location = if kind == Kind::Csv && method == "updateCell" {
        let (table, column, value, row) = request.as_ref().expect("update request");
        csv_target(
            tables.engine(&id)?,
            table,
            column,
            value,
            row,
            &identity.fingerprint,
            control,
        )?
    } else {
        None
    };
    let (publisher, publication_id) = if method == "createBackup" || kind != Kind::Sqlite {
        let (publisher, id) = publisher
            .reserve()
            .map_err(|_| error(QUERY_FAILED, "A publication id could not be reserved."))?;
        (publisher, Some(id))
    } else {
        (publisher, None)
    };
    let template = ReceiptJson {
        operation: if method == "createBackup" {
            "createBackup"
        } else {
            "updateCell"
        },
        rows_changed: if method == "updateCell" { 1 } else { 0 },
        kind: kind.as_str(),
        path: &identity.path,
        before: (
            identity.size,
            identity.mtime_ns,
            &identity.fingerprint,
            revision,
        ),
        after: None,
        backup_path: tables.writes[&id].backup.as_ref().map(|b| b.path.as_path()),
        receipt: None,
    }
    .value();
    ledger.begin(mid, &template, publication_id.as_deref())?;
    let outcome = if method == "createBackup" {
        make_backup(tables, &id, &publisher, &lock)
            .map(|()| Published::Yes {
                receipt: tables.writes[&id]
                    .backup
                    .as_ref()
                    .map(|b| b.receipt.clone()),
                reconciled: false,
            })
            .map_err(Fail::from)
    } else if (kind == Kind::Csv && csv_location.is_none())
        || xlsx_location
            .as_ref()
            .is_some_and(|v| v["target"].is_null())
    {
        Ok(Published::NoMatch)
    } else {
        let (table, column, value, row) = request.expect("update request");
        save(
            &publisher,
            &lock,
            kind,
            CellEdit {
                table: &table,
                column: &column,
                value: &value,
                row: &row,
            },
            xlsx_location.as_ref().map(|v| &v["target"]),
            csv_location.as_ref(),
        )
    };
    let published = match outcome {
        Ok(p) => p,
        Err(f) => {
            ledger.finish(
                mid,
                if f.body.mutation_outcome == Some("not-published") {
                    "not-published"
                } else {
                    "unknown"
                },
                f.receipt_id.as_deref(),
            );
            return Err(f.body);
        }
    };
    let (receipt, reconciled, rows) = match published {
        Published::NoMatch => (None, false, 0),
        Published::Yes {
            receipt,
            reconciled,
        } => (
            receipt,
            reconciled,
            if method == "updateCell" { 1 } else { 0 },
        ),
    };
    let after = if rows == 1 {
        support::file_identity(&identity.path).ok()
    } else {
        None
    };
    let mut result = ReceiptJson {
        operation: if method == "createBackup" {
            "createBackup"
        } else {
            "updateCell"
        },
        rows_changed: rows,
        kind: kind.as_str(),
        path: &identity.path,
        before: (
            identity.size,
            identity.mtime_ns,
            &identity.fingerprint,
            revision,
        ),
        after,
        backup_path: tables.writes[&id].backup.as_ref().map(|b| b.path.as_path()),
        receipt: receipt.as_ref().map(|r| (r, reconciled)),
    }
    .value();
    if rows == 0 && method == "updateCell" {
        result["outcome"] = json!("no_match");
    }
    if rows == 1 {
        // Publication is settled before reopening; a reopen failure never disguises a successful save.
        let previous = tables.sources.remove(&id);
        tables.resources.release_session(&id);
        if let Ok(generation) = tables.sessions.publish(&id) {
            result["source_after"]["revision"] = json!(generation.revision.to_string());
        }
        if let Some(mut request) = tables.requests.get(&id).cloned() {
            // A fresh workbook knows no detected tables: carry the table settings and re-detect the
            // sheets the document had selected from the saved bytes, so their names keep answering
            // (EX-05: never stale rows, never a silent refusal).
            if let Some(previous) = &previous {
                let _ = crate::xlsx::copy_options(&**previous, &mut request.sheets);
            }
            if let Ok(opened) = crate::formats::open(&request, &|| Ok(())) {
                if let Some(previous) = &previous
                    && crate::xlsx::mirror_selected(&*opened.source, &**previous, control).is_err()
                {
                    result["notices"] =
                        json!(["Saved successfully; select the sheet again to list its tables."]);
                }
                tables.sources.insert(id.clone(), opened.source);
            } else {
                result["notices"] =
                    json!(["Saved successfully; reopen the document to continue reading."]);
            }
        }
    }
    ledger.finish_result(mid, &result, receipt.as_ref().map(|r| r.id.as_str()))?;
    Ok(result)
}
