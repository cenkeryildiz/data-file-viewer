//! Per-session Safe Mode and backup comparisons; the backup reader keeps the original table names.
use crate::{Tables, controlled, failure, flag, text};
use dfv_table_backup_diff::{Backup, Cell, Change, SafeMode, Table, TableSnapshot};
use dfv_table_protocol::errors::*;
use dfv_table_protocol::{Control, ErrorBody};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct State {
    pub mode: SafeMode,
    pub backup: Option<Backup>,
    pub backup_reader: Option<Box<dyn crate::source::Source>>,
    pub backup_directory: Option<tempfile::TempDir>,
}

pub(crate) fn error(code: &'static str, message: &str) -> ErrorBody {
    ErrorBody::new(code, message).outcome("not-published")
}

pub(crate) fn cell(v: &Value) -> Result<Cell, ErrorBody> {
    Ok(match v {
        Value::Null => Cell::Null,
        Value::Bool(v) => Cell::Bool(*v),
        Value::String(v) => Cell::Text(v.clone()),
        Value::Number(v) => v
            .as_i64()
            .map(|v| Cell::Int(v.into()))
            .or_else(|| v.as_u64().map(|v| Cell::Int(v.into())))
            .unwrap_or_else(|| Cell::float(v.as_f64().expect("JSON number"))),
        Value::Object(v) => {
            let tag = v
                .get("$t")
                .and_then(Value::as_str)
                .ok_or_else(|| error(MALFORMED_VALUE, "Expected a typed cell value."))?;
            match tag {
                "int8" | "int16" | "int32" | "int64" | "int128" | "uint8" | "uint16" | "uint32"
                | "uint64" => Cell::Int(
                    v.get("v")
                        .and_then(Value::as_str)
                        .and_then(|v| v.parse().ok())
                        .ok_or_else(|| error(MALFORMED_VALUE, "Invalid integer cell."))?,
                ),
                "float32" | "float64" => Cell::float(
                    v.get("v")
                        .and_then(Value::as_str)
                        .and_then(|v| v.parse().ok())
                        .ok_or_else(|| error(MALFORMED_VALUE, "Invalid number cell."))?,
                ),
                _ => Cell::Typed(tag.into(), Value::Object(v.clone()).to_string()),
            }
        }
        Value::Array(_) => return Err(error(MALFORMED_VALUE, "Expected a typed cell value.")),
    })
}
fn query(
    source: &dyn crate::source::Source,
    sql: &str,
    control: &Control,
) -> Result<(Table, Vec<(String, String)>), ErrorBody> {
    crate::xlsx::prepare_source(source, sql, control)?;
    let engine = source.engine();
    let result = controlled(engine, control, || {
        engine.run_query_wire(sql, crate::MAX_ROWS)
    });
    crate::xlsx::finish_source(source)?;
    let result = result?;
    if result.truncated {
        return Err(error(
            RESOURCE_LIMIT,
            "This backup comparison exceeds the permitted row count.",
        ));
    }
    let columns: Vec<String> = result
        .columns
        .iter()
        .map(|c| c["name"].as_str().unwrap_or_default().to_owned())
        .collect();
    let types = result
        .columns
        .iter()
        .zip(&columns)
        .map(|(c, n)| (n.clone(), c["type"].to_string()))
        .collect();
    let rows = result
        .rows
        .iter()
        .map(|r| r.iter().map(cell).collect())
        .collect::<Result<_, _>>()?;
    Ok((Table { columns, rows }, types))
}

pub(crate) fn prepare_backup_reader(
    tables: &mut Tables,
    id: &str,
    control: &Control,
) -> Result<(), ErrorBody> {
    let state = tables
        .writes
        .get(id)
        .ok_or_else(|| error(NOT_OPEN, "No such document."))?;
    let backup = state
        .backup
        .as_ref()
        .ok_or_else(|| error(QUERY_FAILED, "No backup has been created."))?;
    if !backup.intact() {
        return Err(error(
            STALE_SOURCE,
            "The backup changed or is missing; comparison is unavailable.",
        ));
    }
    if state.backup_reader.is_some() {
        return Ok(());
    }
    let mut request = tables
        .requests
        .get(id)
        .cloned()
        .ok_or_else(|| error(NOT_OPEN, "No such document."))?;
    let directory = tempfile::tempdir()
        .map_err(|_| error(QUERY_FAILED, "Could not create the backup reader."))?;
    let copy = directory.path().join(
        request
            .path
            .file_name()
            .ok_or_else(|| error(MALFORMED_VALUE, "Invalid source filename."))?,
    );
    std::fs::copy(&backup.path, &copy)
        .map_err(|_| error(QUERY_FAILED, "Could not read the backup."))?;
    dfv_table_publication::verify_file(&copy, backup.length, &backup.sha256)
        .map_err(|_| error(STALE_SOURCE, "The backup changed while opening it."))?;
    request.path = copy;
    request.sibling_path = None;
    crate::xlsx::copy_options(
        &**tables.sources.get(id).expect("open source checked"),
        &mut request.sheets,
    )?;
    let cancel = || {
        control
            .check()
            .map_err(|_| dfv_table_duckdb::Error::Interrupted)
    };
    let source = crate::formats::open(&request, &cancel)
        .map_err(failure)?
        .source;
    let state = tables.writes.get_mut(id).expect("session checked");
    state.backup_reader = Some(source);
    state.backup_directory = Some(directory);
    Ok(())
}

pub(crate) fn read(
    tables: &mut Tables,
    method: &str,
    args: &Map<String, Value>,
    control: &Control,
) -> Result<Value, ErrorBody> {
    let (id, revision) = tables.read_session(args)?;
    if method == "checkEditableSelect" {
        if tables.requests.get(&id).is_some_and(|r| r.force_read_only) {
            return Ok(json!({"editable":false}));
        }
        let engine = tables.engine(&id)?;
        let edit = controlled(engine, control, || {
            engine.check_editable_select(
                text(args, "sql").map_err(|_| dfv_table_duckdb::Error::Invalid("sql".into()))?,
            )
        })?;
        let _ = flag(args, "describe_only")?;
        if !edit.editable || !crate::write_dispatch::writable(engine.kind) {
            return Ok(json!({"editable":false}));
        }
        return Ok(json!({"editable":true,"table":edit.table,"columns":edit.columns}));
    }
    let state = tables.writes.get(&id).expect("open creates write state");
    if state.backup.is_none() {
        return Ok(if method == "diffQueryAgainstBackup" {
            json!({"diff":null})
        } else {
            json!({"tables":{}})
        });
    }
    prepare_backup_reader(tables, &id, control)?;
    let live_source = &**tables.sources.get(&id).expect("open source checked");
    let backup = tables.writes[&id]
        .backup_reader
        .as_ref()
        .expect("prepared backup")
        .as_ref();
    let result = if method == "diffQueryAgainstBackup" {
        let columns = args
            .get("live_columns")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= 2048)
            .and_then(|v| {
                v.iter()
                    .map(|v| v.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .ok_or_else(|| error(MALFORMED_VALUE, "Invalid live columns."))?;
        let rows = args
            .get("live_rows")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= crate::MAX_ROWS)
            .ok_or_else(|| error(RESOURCE_LIMIT, "Invalid live rows."))?;
        let rows = rows
            .iter()
            .map(|row| {
                let r = row
                    .as_array()
                    .filter(|r| r.len() == columns.len())
                    .ok_or_else(|| error(MALFORMED_VALUE, "Row width differs from the columns."))?;
                r.iter().map(cell).collect()
            })
            .collect::<Result<Vec<_>, _>>()?;
        crate::xlsx::prepare_like(backup, live_source, text(args, "sql")?, control)?;
        let (before, _) = query(backup, text(args, "sql")?, control)?;
        let diff = dfv_table_backup_diff::diff_query(&Table { columns, rows }, &before);
        json!({"diff":{"cell_changed":diff.cell_changed,"row_is_new":diff.row_is_new,"renamed_columns":diff.renamed_columns}})
    } else {
        crate::xlsx::mirror_selected(backup, live_source, control)?;
        let snapshot = |source:&dyn crate::source::Source| -> Result<BTreeMap<String,TableSnapshot>,ErrorBody> {
            let engine=source.engine();
            let names=match crate::xlsx::names(source,true)? {Some(names)=>names,None=>controlled(engine,control,||engine.list_tables())?};
            names.into_iter().map(|name| {
                let sql = format!("select * from {}", dfv_table_duckdb::duckdb::quote_ident(&name));
                let (table,columns) = query(source,&sql,control)?;
                Ok((name,TableSnapshot { columns, rows:table.rows }))
            }).collect()
        };
        let changes =
            dfv_table_backup_diff::compare_to_backup(&snapshot(live_source)?, &snapshot(backup)?);
        let changes: BTreeMap<_, _> = changes
            .into_iter()
            .map(|(n, c)| {
                (
                    n,
                    match c {
                        Change::New => "new",
                        Change::Changed => "changed",
                        Change::Unchanged => "unchanged",
                    },
                )
            })
            .collect();
        json!({"tables":changes})
    };
    tables.revision(&id, Some(revision))?;
    Ok(result)
}
