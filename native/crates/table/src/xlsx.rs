//! D3.17 XLSX: the workbook source (`attach`) and its four routes (`buildDetectedTableQuery`,
//! `runDetectedTableQuery`, `locateXlsxEdit`, `retrySheetPreparation`). The detection, typing and SQL
//! live in `dfv-table-xlsx-ops`; this file only joins them to a locked engine and to the wire.
//! The workbook is read once into memory; nothing here ever opens it for writing.
use crate::formats::OpenRequest;
use crate::source::{Info, Source};
use crate::{Tables, controlled, text};
use dfv_table_duckdb::duckdb::quote_ident;
use dfv_table_duckdb::query::CatalogRelation;
use dfv_table_duckdb::{Engine, Error, Kind};
use dfv_table_protocol::errors::*;
use dfv_table_protocol::{Control, ErrorBody};
use dfv_table_xlsx::budget::WORKBOOK_LIMITS;
use dfv_table_xlsx::sheet_tables::{ManualTable, Region, TableCorrections};
use dfv_table_xlsx_ops::filter::Request;
use dfv_table_xlsx_ops::{ErrKind, OpsError, Options, TableMode, XlsxOps};
use serde_json::{Map, Value, json};
use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Instant;

/// What a host may say about how a workbook's sheets become tables (`sheet_tables`, `sheet_table_corrections`).
#[derive(Debug, Clone, Default)]
pub struct SheetOpen {
    pub mode: Option<TableMode>,
    pub corrections: HashMap<String, TableCorrections>,
}

fn malformed(message: &str) -> ErrorBody {
    ErrorBody::new(MALFORMED_VALUE, message)
}

fn manual_tables(value: Option<&Value>) -> Result<Option<Vec<ManualTable>>, ErrorBody> {
    let Some(value) = value else {
        return Ok(None);
    };
    let rows = value
        .as_array()
        .filter(|a| a.len() <= 64)
        .ok_or_else(|| malformed("Manual tables must be a list of at most 64 rectangles."))?;
    rows.iter()
        .map(|value| {
            let o = value
                .as_object()
                .ok_or_else(|| malformed("Manual table must be a rectangle."))?;
            let n = |key| {
                o.get(key)
                    .and_then(Value::as_u64)
                    .and_then(|v| usize::try_from(v).ok())
                    .ok_or_else(|| {
                        malformed("Manual table coordinates must be nonnegative integers.")
                    })
            };
            let region = Region {
                top: n("top")?,
                bottom: n("bottom")?,
                left: n("left")?,
                right: n("right")?,
            };
            let header_row = match o.get("header_row") {
                Some(Value::Null) => None,
                Some(_) => Some(n("header_row")?),
                None => return Err(malformed("Manual table header must be a row or null.")),
            };
            Ok(ManualTable { region, header_row })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// The `open` arguments that only a workbook reads.
pub fn sheet_open(args: &Map<String, Value>) -> Result<SheetOpen, ErrorBody> {
    let mode = match args.get("sheet_tables") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s == "grid" => Some(TableMode::Grid),
        Some(Value::String(s)) if s == "rows" => Some(TableMode::Rows),
        Some(Value::String(s)) if s == "off" => Some(TableMode::Off),
        _ => return Err(malformed("`sheet_tables` must be grid, rows or off.")),
    };
    let rows = |o: &Map<String, Value>, key: &str| -> Result<Vec<usize>, ErrorBody> {
        match o.get(key) {
            None => Ok(vec![]),
            Some(Value::Array(a)) if a.len() <= 10_000 => a
                .iter()
                .map(|v| v.as_u64().and_then(|n| usize::try_from(n).ok()))
                .collect::<Option<_>>()
                .ok_or_else(|| malformed("Table corrections must be row numbers.")),
            _ => Err(malformed("Table corrections must be lists of row numbers.")),
        }
    };
    let mut corrections = HashMap::new();
    match args.get("sheet_table_corrections") {
        None | Some(Value::Null) => {}
        Some(Value::Object(sheets)) if sheets.len() <= 10_000 => {
            for (sheet, value) in sheets {
                let o = value
                    .as_object()
                    .ok_or_else(|| malformed("Table corrections must be objects."))?;
                corrections.insert(
                    sheet.clone(),
                    TableCorrections {
                        split: rows(o, "split")?,
                        merge: rows(o, "merge")?,
                        manual_tables: manual_tables(o.get("manual_tables"))?.unwrap_or_default(),
                    },
                );
            }
        }
        _ => return Err(malformed("`sheet_table_corrections` must be an object.")),
    }
    Ok(SheetOpen { mode, corrections })
}

/// An open workbook: the locked engine, the facts the open answered with, and the detected-table state.
pub struct Xlsx {
    engine: Engine,
    info: Info,
    ops: Mutex<XlsxOps>,
}
impl Source for Xlsx {
    fn engine(&self) -> &Engine {
        &self.engine
    }
    fn info(&self) -> &Info {
        &self.info
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// An ops failure while opening is an engine-level [`Error`]; a cancel keeps the caller's own wording.
fn open_error(e: OpsError, cancel: &dyn Fn() -> Result<(), Error>) -> Error {
    match e.kind {
        ErrKind::Interrupted => cancel().err().unwrap_or(Error::Interrupted),
        ErrKind::Resource => Error::TooLarge(e.message),
        ErrKind::Unsupported | ErrKind::Refused | ErrKind::Ambiguous => {
            Error::Unsupported(e.message)
        }
        ErrKind::Stale => Error::SourceChanged,
        ErrKind::Invalid => Error::Invalid(e.message),
        ErrKind::Engine => Error::Engine(e.message),
    }
}

/// Open the workbook at `request.path`: every sheet becomes a raw table, every detected table a typed one.
/// Raw tables remain materialized at open; selected-sheet discovery is explicit and cached.
/// shortcut: eager raw decoding still contributes workbook-wide open cost; qualify under PERF-X1.
pub fn attach(
    request: &OpenRequest,
    cancel: &dyn Fn() -> Result<(), Error>,
) -> Result<Box<dyn Source>, Error> {
    let path = std::fs::canonicalize(&request.path).map_err(|e| {
        Error::Invalid(format!(
            "Could not open \"{}\": {e}",
            request.path.display()
        ))
    })?;
    let size = std::fs::metadata(&path)
        .map_err(|e| Error::Invalid(format!("Could not read \"{}\": {e}", path.display())))?
        .len();
    if size > WORKBOOK_LIMITS.compressed_bytes {
        return Err(Error::TooLarge(
            "This workbook is larger than this worker may read.".into(),
        ));
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| Error::Invalid(format!("Could not read \"{}\": {e}", path.display())))?;
    let defaults = Options::default();
    let options = Options {
        null_text: request
            .options
            .null_text
            .clone()
            .unwrap_or(defaults.null_text),
        table_mode: request.sheets.mode.unwrap_or(defaults.table_mode),
        corrections: request.sheets.corrections.clone(),
    };
    let cancelled = || cancel().is_err();
    let mut built = None;
    let engine = Engine::open_loaded(&path, Kind::Xlsx, &[], cancel, |loader| {
        let mut ops = XlsxOps::attach(loader.conn(), bytes, options, &cancelled)
            .map_err(|e| open_error(e, cancel))?;
        for name in ops.derived_names() {
            loader.derive(&name);
        }
        loader.warnings.extend(ops.take_warnings());
        built = Some(ops);
        Ok(())
    })?;
    let ops = built.ok_or_else(|| Error::Engine("The workbook was not read.".into()))?;
    let worksheets = ops.worksheets();
    let info = Info {
        detected_tables: worksheets
            .iter()
            .flat_map(|sheet| ops.detected_tables(sheet).into_iter().map(|t| t.to_json()))
            .collect(),
        sheet_preparation: Some(Value::Array(
            worksheets
                .iter()
                .filter_map(|sheet| ops.status(sheet).map(|s| s.to_json()))
                .collect(),
        )),
        has_pending_sheets: ops.has_pending_sheets(),
        preparation_metrics: Some(ops.metrics()),
        worksheets,
        ..Info::default()
    };
    Ok(Box::new(Xlsx {
        engine,
        info,
        ops: Mutex::new(ops),
    }))
}

/// The user-safe wording and protocol code of an ops refusal (no names, values or SQL).
fn refusal(error: &OpsError) -> ErrorBody {
    match error.kind {
        ErrKind::Invalid => {
            malformed("The table, column, filter or row value is not valid for this workbook.")
        }
        ErrKind::Stale => {
            ErrorBody::new(STALE_SOURCE, "The workbook changed; close and reopen it.")
        }
        ErrKind::Resource => ErrorBody::new(
            RESOURCE_LIMIT,
            "This workbook is larger than this worker may read.",
        ),
        ErrKind::Unsupported => {
            ErrorBody::new(UNSUPPORTED, "This workbook feature is unsupported.")
        }
        ErrKind::Ambiguous => ErrorBody::new(
            AMBIGUOUS_ROW,
            "Several rows are identical across every column, so none can be singled out. The workbook was not changed.",
        ),
        ErrKind::Refused => ErrorBody::new(
            UNSUPPORTED,
            "That row has no exact cell on its sheet to write to. The workbook was not changed.",
        ),
        ErrKind::Engine => ErrorBody::new(
            QUERY_FAILED,
            "The table engine could not complete this read.",
        ),
        ErrKind::Interrupted => ErrorBody::new(CANCELLED, "The read was cancelled."),
    }
}

fn workbook<'a>(tables: &'a Tables, id: &str) -> Result<&'a Xlsx, ErrorBody> {
    tables
        .sources
        .get(id)
        .ok_or_else(|| ErrorBody::new(NOT_OPEN, "No such open table."))?
        .as_any()
        .downcast_ref::<Xlsx>()
        .ok_or_else(|| ErrorBody::new(UNSUPPORTED, "This source is not a workbook."))
}

/// Run `work` under the ops lock; an ops error comes back typed, an engine one through `controlled`.
fn with_ops<T>(
    book: &Xlsx,
    control: &Control,
    work: impl FnOnce(&mut XlsxOps, &Engine) -> Result<T, OpsError>,
) -> Result<T, ErrorBody> {
    let outcome = controlled(&book.engine, control, || {
        let mut ops = book
            .ops
            .lock()
            .map_err(|_| Error::Engine("The workbook state is unavailable.".into()))?;
        Ok(work(&mut ops, &book.engine))
    })?;
    outcome.map_err(|e| refusal(&e))
}

fn detected_sql(
    book: &Xlsx,
    control: &Control,
    args: &Map<String, Value>,
) -> Result<String, ErrorBody> {
    let table = text(args, "table")?;
    let request = Request::from_args(args).map_err(|e| refusal(&e))?;
    with_ops(book, control, |ops, engine| {
        ops.build_detected_table_query(engine.conn(), table, &request)
    })
}

/// `buildDetectedTableQuery`, `locateXlsxEdit` and `retrySheetPreparation`.
pub(crate) fn read(
    tables: &mut Tables,
    method: &str,
    args: &Map<String, Value>,
    control: &Control,
) -> Result<Value, ErrorBody> {
    let (id, revision) = tables.read_session(args)?;
    let book = workbook(tables, &id)?;
    let value = match method {
        "buildDetectedTableQuery" => json!({"sql": detected_sql(book, control, args)?}),
        "locateXlsxEdit" => {
            let (table, column) = (text(args, "table")?, text(args, "column")?);
            let row = args
                .get("row_values")
                .and_then(Value::as_object)
                .ok_or_else(|| malformed("`row_values` must be an object."))?;
            with_ops(book, control, |ops, engine| {
                ops.locate_xlsx_edit(engine.conn(), table, column, row)
            })?
            .to_json()
        }
        "retrySheetPreparation" => {
            let sheet = text(args, "sheet")?;
            let manual = manual_tables(args.get("manual_tables"))?;
            with_ops(book, control, |ops, engine| {
                let status = if let Some(manual) = manual {
                    Some(ops.correct_tables(engine.conn(), sheet, manual, &|| {
                        control.check().is_err()
                    })?)
                } else {
                    ops.retry_sheet_preparation(engine.conn(), sheet)?
                };
                engine.derive_tables(ops.derived_names());
                let mut snapshot = snapshot(ops);
                snapshot["status"] = status.map(|s| s.to_json()).unwrap_or(Value::Null);
                Ok(snapshot)
            })?
        }
        _ => return Err(malformed("This is not a workbook read.")),
    };
    tables.revision(&id, Some(revision))?;
    Ok(value)
}

/// `runDetectedTableQuery`: the same statement `buildDetectedTableQuery` answers, run and held as a resource.
pub(crate) fn run(
    tables: &mut Tables,
    args: &Map<String, Value>,
    control: &Control,
) -> Result<Value, ErrorBody> {
    let (id, revision) = tables.read_session(args)?;
    let max_rows = crate::size(args, "max_rows", 10_000, crate::MAX_ROWS)?;
    let page_size = crate::size(args, "page_size", 100, crate::MAX_PAGE)?;
    let book = workbook(tables, &id)?;
    let sql = detected_sql(book, control, args)?;
    let result = controlled(&book.engine, control, || {
        book.engine.run_query_wire(&sql, max_rows)
    })?;
    tables.store(&id, revision, control, result, &sql, page_size)
}

fn snapshot(ops: &XlsxOps) -> Value {
    let worksheets = ops.worksheets();
    let detected_tables: Vec<_> = worksheets
        .iter()
        .flat_map(|sheet| ops.detected_tables(sheet).into_iter().map(|t| t.to_json()))
        .collect();
    let sheet_preparation: Vec<_> = worksheets
        .iter()
        .filter_map(|sheet| ops.status(sheet).map(|s| s.to_json()))
        .collect();
    let out = json!({"detected_tables":detected_tables,"sheet_preparation":sheet_preparation,"has_pending_sheets":ops.has_pending_sheets(),"preparation_metrics":ops.metrics()});
    #[cfg(feature = "test-detection-failure")]
    let out = {
        let mut out = out;
        out["detector_calls"] = json!(ops.detection_calls());
        out
    };
    out
}

/// Current metadata without discovery; Source.info is the immutable open snapshot.
pub(crate) fn metadata(
    tables: &Tables,
    id: &str,
    control: &Control,
) -> Result<Option<Value>, ErrorBody> {
    let source = tables
        .sources
        .get(id)
        .ok_or_else(|| ErrorBody::new(NOT_OPEN, "No such open table."))?;
    let Some(book) = source.as_any().downcast_ref::<Xlsx>() else {
        return Ok(None);
    };
    with_ops(book, control, |ops, _| Ok(snapshot(ops))).map(Some)
}

pub(crate) fn names(source: &dyn Source, derived: bool) -> Result<Option<Vec<String>>, ErrorBody> {
    let Some(book) = source.as_any().downcast_ref::<Xlsx>() else {
        return Ok(None);
    };
    with_ops(book, &Control::unbounded(), |ops, _| {
        let mut names = ops.worksheets();
        if derived {
            names.extend(ops.derived_names());
        }
        names.sort();
        Ok(names)
    })
    .map(Some)
}

pub(crate) fn catalog(
    source: &dyn Source,
    offset: usize,
    control: &Control,
) -> Result<Option<Vec<CatalogRelation>>, ErrorBody> {
    let Some(book) = source.as_any().downcast_ref::<Xlsx>() else {
        return Ok(None);
    };
    with_ops(book,control,|ops,engine| {
        let started=Instant::now();
        let mut names=ops.worksheets();names.extend(ops.derived_names());names.sort();
        let page:Vec<_>=names.into_iter().skip(offset).take(100).map(|name|CatalogRelation {catalog:engine.catalog.clone(),schema:"main".to_owned(),sql_name:format!("{}.{}.{}",quote_ident(&engine.catalog),quote_ident("main"),quote_ident(&name)),name}).collect();
        let bytes=serde_json::to_vec(&page.iter().map(|r|json!({"catalog":r.catalog,"schema":r.schema,"name":r.name,"sql_name":r.sql_name})).collect::<Vec<_>>()).map_err(|_|OpsError::new(ErrKind::Engine,"Catalog could not be encoded."))?;
        if bytes.len()>1<<20 {return Err(OpsError::new(ErrKind::Resource,"The catalog page exceeds its size limit."));}
        ops.record_catalog(started);Ok(page)
    }).map(Some)
}

pub(crate) fn prepare_source(
    source: &dyn Source,
    sql: &str,
    control: &Control,
) -> Result<(), ErrorBody> {
    let Some(book) = source.as_any().downcast_ref::<Xlsx>() else {
        return Ok(());
    };
    let references = controlled(&book.engine, control, || {
        book.engine.referenced_query_tables(sql)
    })?;
    with_ops(book, control, |ops, engine| {
        ops.prepare_raw_references(engine.conn(), &references, &|| control.check().is_err())
    })
}

pub(crate) fn prepare_read(
    tables: &mut Tables,
    method: &str,
    args: &Map<String, Value>,
    control: &Control,
) -> Result<(), ErrorBody> {
    if matches!(
        method,
        "runQuery"
            | "runSortedQuery"
            | "runChartQuery"
            | "countMatchingRows"
            | "getColumnTopValues"
            | "getColumnDescriptiveStats"
            | "checkEditableSelect"
            | "diffQueryAgainstBackup"
    ) {
        let (id, _) = tables.read_session(args)?;
        prepare_source(
            &**tables
                .sources
                .get(&id)
                .ok_or_else(|| ErrorBody::new(NOT_OPEN, "No such open table."))?,
            text(args, "sql")?,
            control,
        )?;
    } else if method == "getQueryColumns" {
        let (id, _) = tables.read_session(args)?;
        if let Some(book) = tables
            .sources
            .get(&id)
            .and_then(|s| s.as_any().downcast_ref::<Xlsx>())
            && text(args, "catalog")? == book.engine.catalog
            && text(args, "schema")? == "main"
        {
            let name = text(args, "name")?;
            with_ops(book, control, |ops, engine| {
                ops.prepare_raw_references(
                    engine.conn(),
                    &HashSet::from([name.to_owned()]),
                    &|| control.check().is_err(),
                )
            })?;
        }
    }
    Ok(())
}

pub(crate) fn finish_source(source: &dyn Source) -> Result<(), ErrorBody> {
    let Some(book) = source.as_any().downcast_ref::<Xlsx>() else {
        return Ok(());
    };
    with_ops(book, &Control::unbounded(), |ops, engine| {
        ops.trim_cache(engine.conn())
    })
}

pub(crate) fn copy_options(source: &dyn Source, sheets: &mut SheetOpen) -> Result<(), ErrorBody> {
    if let Some(book) = source.as_any().downcast_ref::<Xlsx>() {
        let options = with_ops(book, &Control::unbounded(), |ops, _| Ok(ops.options()))?;
        sheets.mode = Some(options.table_mode);
        sheets.corrections = options.corrections;
    }
    Ok(())
}

/// A backup interprets only the sheet origins already selected in the live document.
pub(crate) fn prepare_like(
    source: &dyn Source,
    live: &dyn Source,
    sql: &str,
    control: &Control,
) -> Result<(), ErrorBody> {
    if let (Some(book), Some(live)) = (
        source.as_any().downcast_ref::<Xlsx>(),
        live.as_any().downcast_ref::<Xlsx>(),
    ) {
        let refs = controlled(&book.engine, control, || {
            book.engine.referenced_query_tables(sql)
        })?;
        let sheets = with_ops(live, control, |ops, _| {
            Ok(ops
                .worksheets()
                .into_iter()
                .filter(|sheet| {
                    ops.detected_tables(sheet)
                        .iter()
                        .any(|t| refs.iter().any(|name| name.eq_ignore_ascii_case(&t.name)))
                })
                .collect::<Vec<_>>())
        })?;
        with_ops(book, control, |ops, engine| {
            for sheet in sheets {
                ops.prepare_selected(engine.conn(), &sheet, &|| control.check().is_err())?;
            }
            engine.derive_tables(ops.derived_names());
            Ok(())
        })?;
    }
    prepare_source(source, sql, control)
}

pub(crate) fn mirror_selected(
    source: &dyn Source,
    live: &dyn Source,
    control: &Control,
) -> Result<(), ErrorBody> {
    if let (Some(book), Some(live)) = (
        source.as_any().downcast_ref::<Xlsx>(),
        live.as_any().downcast_ref::<Xlsx>(),
    ) {
        let sheets = with_ops(live, control, |ops, _| {
            Ok(ops
                .worksheets()
                .into_iter()
                .filter(|sheet| !ops.detected_tables(sheet).is_empty())
                .collect::<Vec<_>>())
        })?;
        with_ops(book, control, |ops, engine| {
            for sheet in sheets {
                ops.prepare_selected(engine.conn(), &sheet, &|| control.check().is_err())?;
                ops.trim_cache(engine.conn())?;
            }
            engine.derive_tables(ops.derived_names());
            Ok(())
        })?;
    }
    Ok(())
}

/// Optional runQuery context comes from a selected worksheet, never inferred from arbitrary SQL.
pub(crate) fn prepare_selected(
    tables: &Tables,
    id: &str,
    args: &Map<String, Value>,
    control: &Control,
) -> Result<(), ErrorBody> {
    let Some(value) = args.get("prepare_sheet") else {
        return Ok(());
    };
    let sheet = value
        .as_str()
        .ok_or_else(|| malformed("`prepare_sheet` must name a worksheet."))?;
    let book = workbook(tables, id)?;
    with_ops(book, control, |ops, engine| {
        ops.prepare_selected(engine.conn(), sheet, &|| control.check().is_err())?;
        engine.derive_tables(ops.derived_names());
        Ok(())
    })
}
