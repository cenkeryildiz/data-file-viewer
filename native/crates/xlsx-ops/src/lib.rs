//! D3.17, worksheet half: the detected tables of a workbook as typed tables on a caller-supplied DuckDB
//! connection, and the four reads over them (`buildDetectedTableQuery`, `retrySheetPreparation`,
//! `locateXlsxEdit`, plus the SQL `runDetectedTableQuery` runs). Ports `DuckDbFile.ensureSheetPrepared`,
//! `retrySheetPreparation`, `buildDetectedTableQuery` and `locateXlsxEdit` (`src/duckdbConnection.ts`).
//!
//! The narrow interface is two things the host hands over: the workbook bytes (judged once by the
//! xlsx budget) and a `&Connection` to an in-memory catalog this crate may create tables in. It never
//! touches a path; the source is read-only by construction because only the bytes exist here.
mod derive;
pub mod filter;
mod metrics;

use dfv_table_duckdb::duckdb::quote_ident;
use dfv_table_duckdb::text::{TextColumnVerdict, classify_text_column, default_null_text};
use dfv_table_xlsx::budget::{Refusal, WORKBOOK_LIMITS};
use dfv_table_xlsx::sheet_tables::{
    Cell, DetectOptions, ExcludedRowReason, ManualTable, Region, RowSpan, SheetTable,
    TableCorrections, detect_tables, grid_row_of_slot, is_blank, is_blank_text, span_row_count,
    valid_spans,
};
use dfv_table_xlsx::xlsx_read::{Package, SheetRef, column_letters};
use duckdb::Connection;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

/// Above this many used cells a sheet's tables are not looked for (SAFE-X1 `bounded`).
pub const DETECTION_MAX_CELLS: u64 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrKind {
    /// The request names something that is not there, or a value that cannot be used.
    Invalid,
    /// The workbook is no longer the one that was opened.
    Stale,
    Resource,
    Unsupported,
    /// Several rows are identical across every column, so none can be singled out.
    Ambiguous,
    /// The edit target cannot be addressed exactly.
    Refused,
    Engine,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpsError {
    pub kind: ErrKind,
    pub message: String,
}
impl OpsError {
    pub fn new(kind: ErrKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for OpsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl From<Refusal> for OpsError {
    fn from(r: Refusal) -> Self {
        let kind = match r.code {
            "archive_limit" | "cell_limit" | "compressed_size" | "decompression" | "entity" => {
                ErrKind::Resource
            }
            "unsupported_encoding" => ErrKind::Unsupported,
            _ => ErrKind::Invalid,
        };
        Self::new(kind, r.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableMode {
    /// Side-by-side tables are split on blank columns (the viewer's default).
    Grid,
    Rows,
    Off,
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Cell texts read as "no value" (`dataFileViewer.nullText`).
    pub null_text: Vec<String>,
    pub table_mode: TableMode,
    /// Explicit split/merge answers by sheet name (`sheetTableCorrections`).
    pub corrections: HashMap<String, TableCorrections>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            null_text: default_null_text(),
            table_mode: TableMode::Grid,
            corrections: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Pending,
    Ready,
    None,
    Disabled,
    Incomplete,
    Bounded,
    Cancelled,
    Failed,
}
impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::None => "none",
            Self::Disabled => "disabled",
            Self::Incomplete => "incomplete",
            Self::Bounded => "bounded",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

/// SAFE-X1 `SheetPreparationStatus`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preparation {
    pub sheet: String,
    pub state: State,
    pub generation: u32,
    pub tables: usize,
    pub skipped: usize,
    pub message: Option<String>,
    pub retryable: bool,
}
impl Preparation {
    pub fn to_json(&self) -> Value {
        let mut o = json!({"sheet":self.sheet,"state":self.state.as_str(),"generation":self.generation,
            "tables":self.tables,"skipped":self.skipped,"retryable":self.retryable});
        if let Some(m) = &self.message {
            o["message"] = json!(m);
        }
        o
    }
}

/// `DetectedSheetTable`: 0-based worksheet-grid coordinates, top/left inclusive, bottom/right exclusive.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedTable {
    pub name: String,
    pub sheet: String,
    pub table: SheetTable,
    pub columns: Vec<String>,
    pub stats_kind: Vec<&'static str>,
    pub provenance: &'static str,
    pub reason: &'static str,
}
impl DetectedTable {
    pub fn to_json(&self) -> Value {
        let t = &self.table;
        json!({"name":self.name,"sheet":self.sheet,"top":t.region.top,"bottom":t.region.bottom,
            "provenance":self.provenance,"confidence":if self.provenance == "heuristic" {0.5} else {1.0},"reason":self.reason,
            "left":t.region.left,"right":t.region.right,"header_row":t.header_row,
            "columns":self.columns,"column_stats_kind":self.stats_kind,
            "data_rows":t.data_rows.iter().map(|s| json!({"start":s.start,"end":s.end})).collect::<Vec<_>>(),
            "excluded_rows":t.excluded_rows.iter().map(|r| json!({"row":r.row,
                "reason":if r.reason == ExcludedRowReason::Blank {"blank"} else {"header"}})).collect::<Vec<_>>(),
            "row_count":t.row_count.to_string()})
    }
}

/// Where an edit of one displayed row lands in the workbook (`locateXlsxEdit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditTarget {
    pub sheet_path: String,
    pub column_names: Vec<String>,
    /// 1-based Excel row.
    pub row_ordinal: usize,
    /// The Excel column letters of the cell.
    pub column_name: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub target: Option<EditTarget>,
    pub sha256: String,
}
impl Located {
    pub fn to_json(&self) -> Value {
        json!({"target":self.target.as_ref().map(|t| json!({"sheet_path":t.sheet_path,
            "column_names":t.column_names,"row_ordinal":t.row_ordinal,"column_name":t.column_name})),
            "sha256":self.sha256})
    }
}

#[derive(Clone)]
struct Sheet {
    name: String,
    reference: SheetRef,
    /// Used cells (rows x columns) of the raw table; the detection budget reads it.
    cells: u64,
    /// The sheet's own table exists in the catalog.
    raw: bool,
    ever_loaded: bool,
    status: Preparation,
    /// Queued for first-use preparation.
    pending: bool,
    tables: Vec<String>,
}

type Staged = (
    usize,
    dfv_table_xlsx::xlsx_read::Sheet,
    Vec<Vec<Option<String>>>,
);

pub struct XlsxOps {
    package: Package,
    sha256: String,
    options: Options,
    sheets: Vec<Sheet>,
    /// Detected tables by lowercase SQL name.
    detected: HashMap<String, DetectedTable>,
    warnings: Vec<String>,
    metrics: metrics::Metrics,
    cache: HashMap<String, CacheEntry>,
    clock: u64,
    cache_max_bytes: u64,
    /// Parse of the sheet `load_raw` just read, handed to the detection that follows so a first open parses once.
    staged: Option<Staged>,
    #[cfg(feature = "test-detection-failure")]
    fail_detection_once: Option<String>,
    #[cfg(feature = "test-detection-failure")]
    detection_calls: HashMap<String, u64>,
}

#[derive(Clone)]
struct CacheEntry {
    name: String,
    cells: u64,
    bytes: u64,
    used: u64,
}

fn lower(name: &str) -> String {
    name.to_lowercase()
}

/// `name`, or the first `name_n` nothing else has claimed (DuckDB names are case-insensitive).
fn unique_name(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_owned();
    }
    (2..)
        .map(|n| format!("{name}_{n}"))
        .find(|c| !taken(c))
        .expect("unbounded")
}

/// Trailing blank rows and columns are the declared rectangle over-stating the sheet; interior blanks
/// separate tables and stay.
fn used_extent(grid: &[Vec<Cell>]) -> (usize, usize) {
    let (mut rows, mut cols) = (0, 0);
    for (r, row) in grid.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            if !is_blank(cell) {
                rows = r + 1;
                cols = cols.max(c + 1);
            }
        }
    }
    (rows, cols)
}

/// A name list DuckDB accepts: case-insensitive duplicates get the same `_n` suffix as exact ones.
fn distinct_names(names: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    names
        .iter()
        .map(|name| {
            let out = unique_name(name, &|c| seen.contains(&lower(c)));
            seen.insert(lower(&out));
            out
        })
        .collect()
}

impl XlsxOps {
    /// Judge the workbook, list its sheets and create each one's raw table (every cell as text, columns
    /// named by their Excel letters, row n = Excel row n). Detection waits for the first use of a sheet.
    pub fn attach(
        _db: &Connection,
        bytes: Vec<u8>,
        options: Options,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Self, OpsError> {
        let start = Instant::now();
        let mut package = Package::from_bytes(bytes, WORKBOOK_LIMITS)?;
        let mut metrics = metrics::Metrics::default();
        metrics.record("workbook_preflight", start);
        let sha256 = package.sha256.clone();
        let start = Instant::now();
        let refs = package.list_sheets()?;
        let mut ops = Self {
            package,
            sha256,
            options,
            sheets: vec![],
            detected: HashMap::new(),
            warnings: vec![],
            metrics,
            cache: HashMap::new(),
            clock: 0,
            cache_max_bytes: metrics::CACHE_MAX_BYTES,
            staged: None,
            #[cfg(feature = "test-detection-failure")]
            fail_detection_once: std::env::var("DFV_TEST_XLSX_FAIL_ONCE_SHEET").ok(),
            #[cfg(feature = "test-detection-failure")]
            detection_calls: HashMap::new(),
        };
        let mut names: HashSet<String> = HashSet::new();
        for reference in refs {
            if cancel() {
                return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
            }
            // Excel forbids names that differ only by case; a hostile file may not.
            if !names.insert(lower(&reference.name)) {
                continue;
            }
            let status = Preparation {
                sheet: reference.name.clone(),
                state: State::Pending,
                generation: 0,
                tables: 0,
                skipped: 0,
                message: None,
                retryable: false,
            };
            ops.sheets.push(Sheet {
                name: reference.name.clone(),
                reference,
                cells: 0,
                raw: false,
                ever_loaded: false,
                status,
                pending: true,
                tables: vec![],
            });
        }
        ops.metrics.record("sheet_catalog", start);
        Ok(ops)
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    /// The host's check that these are still the bytes of the generation being served.
    pub fn assert_current(&self, live_sha256: &str) -> Result<(), OpsError> {
        if live_sha256 == self.sha256 {
            Ok(())
        } else {
            Err(OpsError::new(
                ErrKind::Stale,
                "The workbook changed after opening. Refresh before querying or editing.",
            ))
        }
    }

    pub fn take_warnings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.warnings)
    }

    /// Every table this crate has made beyond the raw sheets, for the host to hide from navigation.
    pub fn derived_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.detected.values().map(|d| d.name.clone()).collect();
        names.sort();
        names
    }

    pub fn worksheets(&self) -> Vec<String> {
        self.sheets.iter().map(|s| s.name.clone()).collect()
    }

    pub fn options(&self) -> Options {
        self.options.clone()
    }
    pub fn metrics(&self) -> Value {
        self.metrics.snapshot(
            self.cache.values().map(|c| c.cells).sum(),
            self.cache.len(),
            self.cache.values().map(|c| c.bytes).sum(),
            self.cache_max_bytes,
        )
    }
    pub fn record_catalog(&mut self, started: Instant) {
        self.metrics.record("catalog", started);
    }

    fn cached(&mut self, name: &str, cells: u64, bytes: u64) {
        self.clock += 1;
        self.cache.insert(
            lower(name),
            CacheEntry {
                name: name.to_owned(),
                cells,
                bytes: bytes + size_of::<CacheEntry>() as u64 + name.len() as u64,
                used: self.clock,
            },
        );
    }

    /// Arbitrary SQL restores named raw/known derived objects without discovering any tables.
    pub fn prepare_raw_references(
        &mut self,
        db: &Connection,
        names: &HashSet<String>,
        cancel: &dyn Fn() -> bool,
    ) -> Result<(), OpsError> {
        for name in names {
            if cancel() {
                return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
            }
            if let Some(at) = self
                .sheets
                .iter()
                .position(|s| s.name.eq_ignore_ascii_case(name))
            {
                if !self.sheets[at].raw {
                    self.load_raw(db, at, false)?;
                }
            } else if let Some(table) = self.detected.get(&lower(name)).cloned()
                && !self.cache.contains_key(&lower(&table.name))
            {
                let at = self
                    .sheets
                    .iter()
                    .position(|s| s.name == table.sheet)
                    .expect("detected table owns sheet");
                let started = Instant::now();
                let sheet = self.package.read_sheet(&self.sheets[at].reference)?;
                let styles = self.package.styles()?;
                let date1904 = self.package.date1904()?;
                let typer = derive::Typer {
                    sheet: &sheet,
                    styles: &styles,
                    date1904,
                    null_text: &self.options.null_text,
                };
                typer.create_table(db, &table.name, &table.table, &table.columns)?;
                let cells = (table.table.row_count * table.columns.len()) as u64;
                let bytes = table_payload_bytes(&sheet, &table.table);
                self.cached(&table.name, cells, bytes);
                self.metrics.cache_restores += 1;
                self.metrics.record("cache_restore", started);
            }
            self.clock += 1;
            if let Some(c) = self.cache.get_mut(&lower(name)) {
                c.used = self.clock;
            }
        }
        Ok(())
    }

    /// Trim at every read boundary; active SQL may transiently use the engine's bounded workspace.
    pub fn trim_cache(&mut self, db: &Connection) -> Result<(), OpsError> {
        while self.cache.values().map(|c| c.bytes).sum::<u64>() > self.cache_max_bytes {
            let key = self
                .cache
                .iter()
                .min_by_key(|(_, c)| c.used)
                .map(|(key, _)| key.clone())
                .expect("nonempty over budget");
            let entry = &self.cache[&key];
            db.execute_batch(&format!("drop table {}", quote_ident(&entry.name)))?;
            if let Some(sheet) = self.sheets.iter_mut().find(|s| s.name == entry.name) {
                sheet.raw = false;
            }
            self.cache.remove(&key);
            self.metrics.cache_evictions += 1;
        }
        Ok(())
    }

    /// Test-only actual detector invocation counts; no production failure switch or telemetry.
    #[cfg(feature = "test-detection-failure")]
    pub fn detection_calls(&self) -> &HashMap<String, u64> {
        &self.detection_calls
    }

    /// Explicit UI selection is the only raw-sheet operation that requests discovery.
    pub fn prepare_selected(
        &mut self,
        db: &Connection,
        sheet: &str,
        cancel: &dyn Fn() -> bool,
    ) -> Result<(), OpsError> {
        let at = self
            .sheets
            .iter()
            .position(|s| s.name == sheet)
            .ok_or_else(|| OpsError::new(ErrKind::Invalid, "This is not a worksheet."))?;
        if cancel() {
            return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
        }
        if !self.sheets[at].raw {
            self.load_raw(db, at, true)?;
        }
        self.prepare_sheet_checked(db, at, cancel);
        self.staged = None;
        if cancel() {
            return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
        }
        Ok(())
    }

    pub fn has_pending_sheets(&self) -> bool {
        self.sheets.iter().any(|s| s.pending)
    }

    pub fn detected_tables(&self, sheet: &str) -> Vec<&DetectedTable> {
        self.sheets
            .iter()
            .find(|s| s.name == sheet)
            .map(|s| {
                s.tables
                    .iter()
                    .filter_map(|t| self.detected.get(&lower(t)))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn status(&self, sheet: &str) -> Option<&Preparation> {
        self.sheets
            .iter()
            .find(|s| s.name == sheet)
            .map(|s| &s.status)
    }

    fn fail(&mut self, at: usize, error: OpsError) {
        let sheet = &mut self.sheets[at];
        sheet.pending = false;
        sheet.status = Preparation {
            state: if error.kind == ErrKind::Interrupted {
                State::Cancelled
            } else {
                State::Failed
            },
            message: Some(format!(
                "{}. The whole sheet is still readable; the workbook was not changed.",
                error.message.trim_end_matches('.')
            )),
            retryable: true,
            tables: sheet.tables.len(),
            ..sheet.status.clone()
        };
    }

    fn load_raw(&mut self, db: &Connection, at: usize, keep: bool) -> Result<(), OpsError> {
        let started = Instant::now();
        let reference = self.sheets[at].reference.clone();
        if reference.path.is_empty() {
            return Err(OpsError::new(
                ErrKind::Invalid,
                "The sheet has no readable object.",
            ));
        }
        let sheet = self.package.read_sheet(&reference)?;
        self.metrics.record("sheet_parse", started);
        let grid_started = Instant::now();
        let grid = sheet.text_grid(WORKBOOK_LIMITS.cells_per_sheet)?;
        self.metrics.record("read_grid", grid_started);
        let (mut rows, mut cols) = (0, 0);
        for (r, row) in grid.iter().enumerate() {
            for (c, value) in row.iter().enumerate() {
                if value.as_deref().is_some_and(|s| !is_blank_text(s)) {
                    rows = r + 1;
                    cols = cols.max(c + 1);
                }
            }
        }
        let bytes = metrics::grid_bytes(&grid);
        let materialize_started = Instant::now();
        derive::create_raw(db, &reference.name, &grid, rows, cols)?;
        let s = &mut self.sheets[at];
        let restored = s.ever_loaded;
        s.raw = true;
        s.ever_loaded = true;
        s.cells = (rows * cols) as u64;
        self.cached(&reference.name, (rows * cols) as u64, bytes);
        if restored {
            self.metrics.cache_restores += 1;
            self.metrics.record("cache_restore", materialize_started);
        } else {
            self.metrics.record("sheet_parse", materialize_started);
        }
        if !self.options.null_text.is_empty()
            && grid
                .iter()
                .flatten()
                .flatten()
                .any(|v| dfv_table_duckdb::text::is_excel_error(v, &self.options.null_text))
        {
            self.warnings.push(format!(
                "Sheet \"{}\" holds cell values Excel could not compute (#DIV/0!, #N/A, #REF! and the like). They are \
                 shown as empty cells in the tables read from it; the sheet itself shows them exactly as the file has them.",
                reference.name
            ));
        }
        if keep {
            self.staged = Some((at, sheet, grid));
        }
        Ok(())
    }

    /// First-use preparation of every pending sheet.
    pub fn prepare_all(
        &mut self,
        db: &Connection,
        cancel: &dyn Fn() -> bool,
    ) -> Result<(), OpsError> {
        for at in 0..self.sheets.len() {
            if cancel() {
                return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
            }
            self.prepare_sheet(db, at);
        }
        Ok(())
    }

    /// What `prepareDerivedTablesFor` does for a query naming `table`: prepare the sheet it is, or sits on.
    pub fn prepare_for(&mut self, db: &Connection, table: &str) -> Result<(), OpsError> {
        for at in 0..self.sheets.len() {
            let name = &self.sheets[at].name;
            let hit = table == name || table.starts_with(&format!("{name} \u{b7} Table "));
            if hit && self.sheets[at].pending {
                self.prepare_sheet(db, at);
            }
            // A sheet that never became readable explains why its tables do not exist; one
            // evicted from the cache is reread below, as the query path does.
            let s = &self.sheets[at];
            if hit && !s.raw && !s.ever_loaded && table != s.name {
                return Err(OpsError::new(
                    ErrKind::Invalid,
                    s.status.message.clone().unwrap_or_else(|| {
                        "The sheet could not be read, so it has no tables.".into()
                    }),
                ));
            }
        }
        self.prepare_raw_references(db, &HashSet::from([table.to_owned()]), &|| false)
    }

    fn prepare_sheet(&mut self, db: &Connection, at: usize) {
        self.prepare_sheet_checked(db, at, &|| false);
    }

    fn prepare_sheet_checked(&mut self, db: &Connection, at: usize, cancel: &dyn Fn() -> bool) {
        if !self.sheets[at].pending {
            return;
        }
        self.sheets[at].pending = false;
        if !self.sheets[at].raw
            && let Err(e) = self.load_raw(db, at, true)
        {
            return self.fail(at, e);
        }
        let generation = self.sheets[at].status.generation;
        let settle = |this: &mut Self, state: State, skipped: usize, message: Option<String>| {
            let s = &mut this.sheets[at];
            let retryable = matches!(state, State::Failed | State::Cancelled | State::Incomplete);
            s.status = Preparation {
                sheet: s.name.clone(),
                state,
                generation,
                tables: s.tables.len(),
                skipped,
                message,
                retryable,
            };
        };
        if self.sheets[at].cells > DETECTION_MAX_CELLS || self.options.table_mode == TableMode::Off
        {
            self.staged = None;
        }
        if self.sheets[at].cells > DETECTION_MAX_CELLS {
            let message = format!(
                "The sheet declares {} cells, above the {} cell detection limit, so its tables were not looked for. \
                 The whole sheet is still readable with SQL.",
                self.sheets[at].cells, DETECTION_MAX_CELLS
            );
            return settle(self, State::Bounded, 0, Some(message));
        }
        if self.options.table_mode == TableMode::Off {
            return settle(self, State::Disabled, 0, None);
        }
        let started = Instant::now();
        let result = self.detect_and_bind(db, at, cancel);
        self.metrics.record("detection", started);
        match result {
            Ok(0) => {
                let state = if self.sheets[at].tables.is_empty() {
                    State::None
                } else {
                    State::Ready
                };
                settle(self, state, 0, None);
            }
            Ok(skipped) => {
                let message = format!(
                    "{skipped} detected table{} on this sheet could not be offered. The whole sheet is still readable; \
                     retry detection or use the raw worksheet.",
                    if skipped == 1 { "" } else { "s" }
                );
                settle(self, State::Incomplete, skipped, Some(message));
            }
            Err(e) => {
                let state = if e.kind == ErrKind::Interrupted {
                    State::Cancelled
                } else {
                    State::Failed
                };
                let message = if state == State::Cancelled {
                    "The whole sheet is still readable; retry detection to look for its tables."
                        .to_owned()
                } else {
                    format!(
                        "{}. The whole sheet is still readable; the workbook was not changed.",
                        e.message
                    )
                };
                settle(self, state, 0, Some(message));
            }
        }
    }

    /// Detect the sheet's tables and create each as a typed table. Returns how many could not be offered.
    fn detect_and_bind(
        &mut self,
        db: &Connection,
        at: usize,
        cancel: &dyn Fn() -> bool,
    ) -> Result<usize, OpsError> {
        self.metrics.detector_calls += 1;
        #[cfg(feature = "test-detection-failure")]
        {
            *self
                .detection_calls
                .entry(self.sheets[at].name.clone())
                .or_default() += 1;
        }
        #[cfg(feature = "test-detection-failure")]
        if self.fail_detection_once.as_deref() == Some(self.sheets[at].name.as_str()) {
            self.fail_detection_once = None;
            return Err(OpsError::new(
                ErrKind::Invalid,
                "injected native detector fault",
            ));
        }
        let reference = self.sheets[at].reference.clone();
        let (sheet, raw_grid) = match self.staged.take() {
            Some((staged_at, sheet, grid)) if staged_at == at => (sheet, grid),
            _ => {
                let started = Instant::now();
                let sheet = self.package.read_sheet(&reference)?;
                self.metrics.record("sheet_parse", started);
                let started = Instant::now();
                let grid = sheet.text_grid(WORKBOOK_LIMITS.cells_per_sheet)?;
                self.metrics.record("read_grid", started);
                (sheet, grid)
            }
        };
        let styles = self.package.styles()?;
        let date1904 = self.package.date1904()?;
        self.metrics.grid_cells += raw_grid.iter().map(|r| r.len() as u64).sum::<u64>();
        self.metrics.grid_decoded_bytes += metrics::grid_bytes(&raw_grid);
        let grid: Vec<Vec<Cell>> = raw_grid
            .into_iter()
            .map(|r| r.into_iter().map(Cell::from).collect())
            .collect();
        let (used_rows, _) = used_extent(&grid);
        let opts = DetectOptions {
            split_columns: self.options.table_mode == TableMode::Grid,
            corrections: self
                .options
                .corrections
                .get(&reference.name)
                .cloned()
                .unwrap_or_default(),
            ..DetectOptions::default()
        };
        if cancel() {
            return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
        }
        let manual = &opts.corrections.manual_tables;
        let (row_count, col_count) = sheet.extent();
        validate_manual(manual, row_count as usize, col_count as usize)?;
        let declared = self.package.declared_tables(&reference)?;
        let mut candidates: Vec<(SheetTable, Option<String>, &'static str, &'static str)> = manual
            .iter()
            .map(|m| {
                let columns = (m.region.left..m.region.right)
                    .map(|col| {
                        m.header_row
                            .and_then(|row| grid.get(row).and_then(|r| r.get(col)))
                            .map(|cell| match cell {
                                Cell::Str(s) => s.clone(),
                                _ => String::new(),
                            })
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or_else(|| format!("Column {}", col - m.region.left + 1))
                    })
                    .collect();
                (
                    rectangle_table(m.region, m.header_row, columns),
                    None,
                    "manual",
                    "User-selected rectangle and header",
                )
            })
            .collect();
        for t in declared {
            let region = Region {
                top: t.range.top as usize,
                bottom: t.range.bottom as usize + 1,
                left: t.range.left as usize,
                right: t.range.right as usize + 1,
            };
            if manual.iter().any(|m| overlaps(m.region, region)) {
                continue;
            }
            let mut table = rectangle_table(region, t.header.then_some(region.top), t.columns);
            if t.totals {
                if let Some(span) = table.data_rows.first_mut() {
                    span.end -= 1;
                    if span.end == span.start {
                        table.data_rows.clear();
                    }
                }
                table.row_count = span_row_count(&table.data_rows);
            }
            candidates.push((
                table,
                Some(t.name),
                "explicit",
                "Declared Excel table relationship and bounds",
            ));
        }
        let candidate_cells: u64 = candidates
            .iter()
            .map(|(t, _, _, _)| {
                ((t.region.bottom - t.region.top) as u64)
                    * ((t.region.right - t.region.left) as u64)
            })
            .sum();
        if candidate_cells > DETECTION_MAX_CELLS {
            return Err(OpsError::new(
                ErrKind::Resource,
                "Declared and manual tables exceed the selected-sheet cell budget.",
            ));
        }
        let mut uncovered = grid[..used_rows].to_vec();
        for (table, _, _, _) in &candidates {
            for row in uncovered
                .iter_mut()
                .take(table.region.bottom)
                .skip(table.region.top)
            {
                for cell in row
                    .iter_mut()
                    .take(table.region.right)
                    .skip(table.region.left)
                {
                    *cell = Cell::Null;
                }
            }
        }
        let heuristic = detect_tables(&uncovered, &opts)
            .into_iter()
            .filter(|t| {
                !candidates
                    .iter()
                    .any(|(known, _, _, _)| overlaps(known.region, t.region))
            })
            .map(|t| {
                (
                    t,
                    None,
                    "heuristic",
                    "Detected from populated cells and header evidence",
                )
            })
            .collect::<Vec<_>>();
        candidates.extend(heuristic);
        let null_text = self.options.null_text.clone();
        let typer = derive::Typer {
            sheet: &sheet,
            styles: &styles,
            date1904,
            null_text: &null_text,
        };
        let sheet_name = reference.name.clone();
        let mut skipped = 0;
        let mut converted = 0;
        for (i, (table, declared_name, provenance, reason)) in candidates.into_iter().enumerate() {
            if cancel() {
                return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
            }
            if !plan_is_consistent(&table) {
                skipped += 1;
                continue;
            }
            let taken = |c: &str| {
                self.sheets.iter().any(|s| lower(&s.name) == lower(c))
                    || self.detected.contains_key(&lower(c))
            };
            let name = if let Some(name) = declared_name {
                if taken(&name) {
                    return Err(OpsError::new(
                        ErrKind::Invalid,
                        "Declared table name conflicts with a worksheet or another table.",
                    ));
                }
                name
            } else {
                unique_name(&format!("{sheet_name} \u{b7} Table {}", i + 1), &taken)
            };
            let columns = distinct_names(&table.columns);
            let started = Instant::now();
            let created = typer.create_table(db, &name, &table, &columns);
            self.metrics.record("derived_preparation", started);
            if let Ok(n) = created {
                converted += n;
            } else {
                if provenance != "heuristic" {
                    return Err(OpsError::new(
                        ErrKind::Engine,
                        "The declared or manual table could not be prepared.",
                    ));
                }
                skipped += 1;
                continue;
            }
            let stats_kind = stats_kinds(&grid, &table, &self.options.null_text);
            self.cached(
                &name,
                (table.row_count * columns.len()) as u64,
                table_payload_bytes(&sheet, &table),
            );
            self.sheets[at].tables.push(name.clone());
            self.detected.insert(
                lower(&name),
                DetectedTable {
                    name,
                    sheet: sheet_name.clone(),
                    table,
                    columns,
                    stats_kind,
                    provenance,
                    reason,
                },
            );
        }
        if converted > 0 {
            self.warnings.push(format!(
                "Sheet \"{sheet_name}\": {converted} number{} stored as text in numeric columns {} read as numbers in its tables; \
                 the sheet itself shows them exactly as the file has them.",
                if converted == 1 { "" } else { "s" },
                if converted == 1 { "was" } else { "were" }
            ));
        }
        Ok(skipped)
    }

    /// SAFE-X1: retry a failed, cancelled or incomplete sheet in a fresh generation. Anything else is
    /// returned unchanged; `None` is a name that is no worksheet.
    pub fn retry_sheet_preparation(
        &mut self,
        db: &Connection,
        sheet: &str,
    ) -> Result<Option<Preparation>, OpsError> {
        let Some(at) = self.sheets.iter().position(|s| s.name == sheet) else {
            return Ok(None);
        };
        let s = &self.sheets[at];
        if !s.status.retryable || s.pending {
            return Ok(Some(s.status.clone()));
        }
        for name in std::mem::take(&mut self.sheets[at].tables) {
            // A leftover only keeps its name taken; unique_name steps around it.
            let _ = db.execute_batch(&format!("drop table if exists {}", quote_ident(&name)));
            self.detected.remove(&lower(&name));
            self.cache.remove(&lower(&name));
        }
        let s = &mut self.sheets[at];
        s.status.generation += 1;
        s.pending = true;
        self.prepare_sheet(db, at);
        Ok(Some(self.sheets[at].status.clone()))
    }

    /// Rebuild one sheet transactionally; a bad correction leaves both metadata and SQL tables intact.
    pub fn correct_tables(
        &mut self,
        db: &Connection,
        sheet: &str,
        manual: Vec<ManualTable>,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Preparation, OpsError> {
        let at = self
            .sheets
            .iter()
            .position(|s| s.name == sheet)
            .ok_or_else(|| OpsError::new(ErrKind::Invalid, "This is not a worksheet."))?;
        let old = self.sheets[at].clone();
        let old_detected = self.detected.clone();
        let old_cache = self.cache.clone();
        let old_corrections = self.options.corrections.clone();
        let source = self.package.read_sheet(&old.reference)?;
        let (rows, cols) = source.extent();
        validate_manual(&manual, rows as usize, cols as usize)?;
        if cancel() {
            return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
        }
        db.execute_batch("begin transaction")?;
        let result = (|| {
            for name in &old.tables {
                db.execute_batch(&format!("drop table if exists {}", quote_ident(name)))?;
                self.detected.remove(&lower(name));
                self.cache.remove(&lower(name));
            }
            self.options
                .corrections
                .entry(sheet.to_owned())
                .or_default()
                .manual_tables = manual;
            self.sheets[at].tables.clear();
            self.sheets[at].pending = false;
            if self.detect_and_bind(db, at, cancel)? != 0 {
                return Err(OpsError::new(
                    ErrKind::Engine,
                    "Some corrected tables could not be prepared; the previous tables were retained.",
                ));
            }
            if cancel() {
                return Err(OpsError::new(ErrKind::Interrupted, "Cancelled."));
            }
            let state = if self.sheets[at].tables.is_empty() {
                State::None
            } else {
                State::Ready
            };
            self.sheets[at].status = Preparation {
                sheet: sheet.to_owned(),
                state,
                generation: old.status.generation + 1,
                tables: self.sheets[at].tables.len(),
                skipped: 0,
                message: None,
                retryable: false,
            };
            db.execute_batch("commit")?;
            Ok(self.sheets[at].status.clone())
        })();
        if result.is_err() {
            let _ = db.execute_batch("rollback");
            self.sheets[at] = old;
            self.detected = old_detected;
            self.cache = old_cache;
            self.options.corrections = old_corrections;
        }
        result
    }

    /// `describe`: column name -> DuckDB type, in column order.
    fn describe(db: &Connection, table: &str) -> Result<Vec<(String, String)>, OpsError> {
        let mut stmt = db
            .prepare(&format!(
                "select column_name, column_type from (describe {})",
                quote_ident(table)
            ))
            .map_err(OpsError::from)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// `buildDetectedTableQuery`: the read-only statement one detected table, filter set, sort and limit stand for.
    pub fn build_detected_table_query(
        &mut self,
        db: &Connection,
        table: &str,
        request: &filter::Request,
    ) -> Result<String, OpsError> {
        self.prepare_for(db, table)?;
        if !self.detected.contains_key(&lower(table)) {
            return Err(OpsError::new(
                ErrKind::Invalid,
                format!("\"{table}\" is not a table detected inside a worksheet."),
            ));
        }
        let name = self.detected[&lower(table)].name.clone();
        let types = Self::describe(db, &name)?.into_iter().collect();
        filter::build_sql(&name, &types, request)
    }

    /// `locateXlsxEdit`: the cell an edit of one displayed row lands on, without writing. `target: None` is
    /// no matching row; several identical rows are refused.
    pub fn locate_xlsx_edit(
        &mut self,
        db: &Connection,
        table: &str,
        column: &str,
        row_values: &Map<String, Value>,
    ) -> Result<Located, OpsError> {
        self.prepare_for(db, table)?;
        let detected = self.detected.get(&lower(table));
        let sheet_name = detected.map_or(table, |d| d.sheet.as_str());
        let Some(sheet) = self.sheets.iter().find(|s| s.name == sheet_name && s.raw) else {
            return Err(OpsError::new(
                ErrKind::Invalid,
                format!("\"{table}\" is not a sheet of this workbook, so it cannot be edited."),
            ));
        };
        let sheet_path = sheet.reference.path.clone();
        let physical = detected.map_or(table, |d| d.name.as_str());
        let described = Self::describe(db, physical)?;
        if !described.iter().any(|(name, _)| name == column) {
            return Err(OpsError::new(
                ErrKind::Invalid,
                "The edited column does not exist.",
            ));
        }
        let type_of = |c: &str| {
            described
                .iter()
                .find(|(n, _)| n == c)
                .map(|(_, t)| t.as_str())
        };
        let mut clauses = vec![];
        let mut params: Vec<duckdb::types::Value> = vec![];
        let mut keys = vec![];
        for (key, value) in row_values {
            let ty = type_of(key).ok_or_else(|| {
                OpsError::new(
                    ErrKind::Invalid,
                    format!("Column \"{key}\" does not exist in \"{table}\"."),
                )
            })?;
            keys.push(key.clone());
            clauses.push(row_clause(&quote_ident(key), ty, value, &mut params)?);
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!(" where {}", clauses.join(" and "))
        };
        let mut stmt = db
            .prepare(&format!(
                "select rn from (select row_number() over () as rn, * from {}) as _rows{filter}",
                quote_ident(physical)
            ))
            .map_err(OpsError::from)?;
        let matches: Vec<i64> = stmt
            .query_map(duckdb::params_from_iter(params), |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let sha256 = self.sha256.clone();
        let none = |sha256: String| Located {
            target: None,
            sha256,
        };
        let rn = match matches.as_slice() {
            [] => return Ok(none(sha256)),
            [one] => usize::try_from(*one).unwrap_or(0),
            many => {
                return Err(OpsError::new(
                    ErrKind::Ambiguous,
                    format!(
                        "{} rows in \"{table}\" are identical across every column, so there is no way to tell which one you edited. The workbook was not changed.",
                        many.len()
                    ),
                ));
            }
        };
        let Some(d) = detected else {
            let target = EditTarget {
                sheet_path,
                column_names: keys,
                row_ordinal: rn,
                column_name: column.to_owned(),
            };
            return Ok(Located {
                target: Some(target),
                sha256,
            });
        };
        // A detected table's row k is the k-th row of its source-row map, never "k rows below the header".
        let width = d.table.region.right - d.table.region.left;
        let offset = described.iter().position(|(n, _)| n == column);
        match (
            grid_row_of_slot(&d.table.data_rows, rn.saturating_sub(1)),
            offset,
        ) {
            (Some(row), Some(offset)) if offset < width && described.len() == width => {
                Ok(Located {
                    target: Some(EditTarget {
                        sheet_path,
                        column_names: keys,
                        row_ordinal: row + 1,
                        column_name: column_letters((d.table.region.left + offset) as u32),
                    }),
                    sha256,
                })
            }
            _ => Err(OpsError::new(
                ErrKind::Refused,
                format!(
                    "That row of \"{table}\" has no exact cell on sheet \"{sheet_name}\" to write to, so the edit was refused. \
                     The workbook was not changed."
                ),
            )),
        }
    }
}

/// `planDetectedTable`'s consistency test: the source-row map must describe rows inside the rectangle and
/// agree with the count; a table whose description does not add up is not offered.
fn plan_is_consistent(table: &SheetTable) -> bool {
    let floor = table
        .header_row
        .map_or(table.region.top as isize - 1, |h| h as isize);
    valid_spans(&table.data_rows)
        && span_row_count(&table.data_rows) == table.row_count
        && !table
            .data_rows
            .iter()
            .any(|RowSpan { start, end }| (*start as isize) <= floor || *end > table.region.bottom)
}

fn overlaps(a: Region, b: Region) -> bool {
    a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right
}

fn table_payload_bytes(sheet: &dfv_table_xlsx::xlsx_read::Sheet, table: &SheetTable) -> u64 {
    use dfv_table_xlsx::xlsx_read::Value;
    let cells = (table.row_count * table.columns.len()) as u64;
    let text_bytes = table
        .data_rows
        .iter()
        .flat_map(|span| span.start..span.end)
        .flat_map(|row| (table.region.left..table.region.right).map(move |col| (row, col)))
        .filter_map(|(row, col)| sheet.cells.get(&(row as u32, col as u32)))
        .map(|cell| match &cell.value {
            Value::Text(s) | Value::Number(s) | Value::Error(s) => s.capacity() as u64,
            Value::Bool(_) => 0,
        })
        .sum::<u64>();
    cells * size_of::<Option<String>>() as u64
        + text_bytes
        + (table.row_count * size_of::<Vec<Option<String>>>()) as u64
        + table
            .columns
            .iter()
            .map(|s| s.capacity() as u64)
            .sum::<u64>()
        + (table.columns.capacity() * size_of::<String>()
            + table.data_rows.capacity() * size_of::<RowSpan>()
            + table.excluded_rows.capacity()
                * size_of::<dfv_table_xlsx::sheet_tables::ExcludedRow>()) as u64
}
fn validate_manual(tables: &[ManualTable], rows: usize, cols: usize) -> Result<(), OpsError> {
    if tables.len() > 64
        || tables.iter().enumerate().any(|(i, t)| {
            let r = t.region;
            r.top >= r.bottom
                || r.left >= r.right
                || r.bottom > rows
                || r.right > cols
                || t.header_row.is_some_and(|h| h < r.top || h >= r.bottom)
                || tables[..i].iter().any(|p| overlaps(p.region, r))
        })
    {
        return Err(OpsError::new(
            ErrKind::Invalid,
            "Manual tables must have valid nonoverlapping worksheet bounds and headers.",
        ));
    }
    Ok(())
}
fn rectangle_table(region: Region, header_row: Option<usize>, columns: Vec<String>) -> SheetTable {
    let data_rows =
        dfv_table_xlsx::sheet_tables::table_data_rows(region.top, region.bottom, header_row);
    SheetTable {
        region,
        header_row,
        columns,
        row_count: span_row_count(&data_rows),
        data_rows,
        excluded_rows: vec![],
    }
}

fn stats_kinds(grid: &[Vec<Cell>], table: &SheetTable, null_text: &[String]) -> Vec<&'static str> {
    (0..table.region.right - table.region.left)
        .map(|offset| {
            let col = table.region.left + offset;
            let values: Vec<Option<String>> = table
                .data_rows
                .iter()
                .flat_map(|s| s.start..s.end)
                .map(|row| match grid.get(row).and_then(|r| r.get(col)) {
                    Some(Cell::Str(s)) if !is_blank(&Cell::Str(s.clone())) => Some(s.clone()),
                    _ => None,
                })
                .collect();
            match classify_text_column(&values, null_text) {
                TextColumnVerdict::Numeric { .. } => "numeric",
                _ => "other",
            }
        })
        .collect()
}

/// Match in the column's own type so wire tags do not lose precision or timestamp units.
fn row_clause(
    col: &str,
    ty: &str,
    value: &Value,
    params: &mut Vec<duckdb::types::Value>,
) -> Result<String, OpsError> {
    use duckdb::types::Value as P;
    let text = |s: String, params: &mut Vec<P>| {
        params.push(P::Text(s));
        format!("cast({col} as varchar) is not distinct from ?")
    };
    Ok(match value {
        Value::Null => format!("{col} is null"),
        Value::Bool(b) if ty == "BOOLEAN" => {
            params.push(P::Boolean(*b));
            format!("{col} is not distinct from ?")
        }
        Value::Bool(b) => text(b.to_string(), params),
        Value::Number(n)
            if matches!(ty, "DOUBLE" | "FLOAT" | "BIGINT" | "INTEGER")
                || ty.starts_with("DECIMAL") =>
        {
            params.push(P::Text(n.to_string()));
            format!("{col} is not distinct from cast(? as {ty})")
        }
        Value::Number(n) => text(n.to_string(), params),
        Value::String(s) => text(s.clone(), params),
        Value::Object(o) if o.get("$t").is_some() => {
            let v = o
                .get("v")
                .and_then(Value::as_str)
                .ok_or_else(|| OpsError::new(ErrKind::Invalid, "Invalid row value."))?;
            match o.get("$t").and_then(Value::as_str) {
                Some("timestamp") if ty.starts_with("TIMESTAMP") => {
                    use duckdb::types::TimeUnit;
                    let unit = match o.get("unit").and_then(Value::as_str) {
                        Some("s") => TimeUnit::Second,
                        Some("ms") => TimeUnit::Millisecond,
                        Some("us") => TimeUnit::Microsecond,
                        Some("ns") => TimeUnit::Nanosecond,
                        _ => {
                            return Err(OpsError::new(ErrKind::Invalid, "Invalid timestamp unit."));
                        }
                    };
                    params.push(P::Timestamp(
                        unit,
                        v.parse().map_err(|_| {
                            OpsError::new(ErrKind::Invalid, "Invalid timestamp value.")
                        })?,
                    ));
                    format!("{col} is not distinct from ?")
                }
                Some(
                    "float32" | "float64" | "int8" | "int16" | "int32" | "int64" | "int128"
                    | "uint8" | "uint16" | "uint32" | "uint64" | "uint128" | "decimal",
                ) if matches!(ty, "DOUBLE" | "FLOAT" | "BIGINT" | "INTEGER")
                    || ty.starts_with("DECIMAL") =>
                {
                    params.push(P::Text(v.to_owned()));
                    format!("{col} is not distinct from cast(? as {ty})")
                }
                _ => {
                    return Err(OpsError::new(
                        ErrKind::Invalid,
                        "Unsupported row value tag.",
                    ));
                }
            }
        }
        _ => return Err(OpsError::new(ErrKind::Invalid, "Invalid row value.")),
    })
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    fn book() -> (Connection, XlsxOps) {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test/fixtures/xlsx-corpus/repeated.xlsx"),
        )
        .unwrap();
        let db = Connection::open_in_memory().unwrap();
        let ops = XlsxOps::attach(&db, bytes, Options::default(), &|| false).unwrap();
        (db, ops)
    }
    #[test]
    fn raw_and_derived_payload_evict_restore_without_detection_or_metadata_loss() {
        let (db, mut ops) = book();
        assert_eq!(ops.metrics()["cached_objects"], 0);
        assert_eq!(ops.metrics()["detector_calls"], 0);
        assert!(ops.metrics()["phases"]["sheet_parse"].is_null());
        ops.prepare_selected(&db, "Sheet", &|| false).unwrap();
        let table = ops.detected_tables("Sheet")[0].clone();
        let original: Vec<Value> = db
            .prepare(&format!(
                "select to_json(t) from {} t",
                quote_ident(&table.name)
            ))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| serde_json::from_str(&r.unwrap()).unwrap())
            .collect();
        assert!(
            ops.cache
                .values()
                .all(|c| c.bytes > c.cells * size_of::<Option<String>>() as u64)
        );
        ops.cache_max_bytes = 1;
        ops.trim_cache(&db).unwrap();
        assert_eq!(ops.metrics()["cache_estimated_bytes"], "0");
        assert_eq!(ops.detected_tables("Sheet")[0], &table);
        let refs = HashSet::from(["Sheet".to_owned(), table.name.clone()]);
        ops.prepare_raw_references(&db, &refs, &|| false).unwrap();
        let restored: Vec<Value> = db
            .prepare(&format!(
                "select to_json(t) from {} t",
                quote_ident(&table.name)
            ))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| serde_json::from_str(&r.unwrap()).unwrap())
            .collect();
        assert_eq!(original, restored);
        assert_eq!(ops.metrics()["detector_calls"], 1);
        assert_eq!(ops.metrics()["cache_restores"], 2);
        assert!(db.execute_batch("select missing from Sheet").is_err());
        ops.trim_cache(&db).unwrap();
        let before = ops.detected_tables("Sheet")[0].clone();
        let correction = ManualTable {
            region: before.table.region,
            header_row: before.table.header_row,
        };
        ops.correct_tables(&db, "Sheet", vec![correction], &|| false)
            .unwrap();
        assert!(
            ops.detected_tables("Sheet")
                .iter()
                .any(|t| t.provenance == "manual")
        );
        ops.trim_cache(&db).unwrap();
        assert_eq!(ops.metrics()["cache_estimated_bytes"], "0");
    }
    #[test]
    fn detected_table_requests_reread_an_evicted_sheet_every_time() {
        let (db, mut ops) = book();
        ops.prepare_selected(&db, "Sheet", &|| false).unwrap();
        let name = ops.detected_tables("Sheet")[0].name.clone();
        ops.cache_max_bytes = 1;
        for _ in 0..5 {
            ops.trim_cache(&db).unwrap();
            ops.prepare_for(&db, &name).unwrap();
            let rows: i64 = db
                .query_row(
                    &format!("select count(*) from {}", quote_ident(&name)),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(rows > 0);
        }
    }
    #[test]
    fn cancelled_cold_preparation_does_not_publish_a_cache_object() {
        let (db, mut ops) = book();
        assert_eq!(
            ops.prepare_raw_references(&db, &HashSet::from(["Sheet".to_owned()]), &|| true)
                .unwrap_err()
                .kind,
            ErrKind::Interrupted
        );
        assert!(ops.cache.is_empty());
        assert_eq!(ops.status("Sheet").unwrap().state, State::Pending);
        ops.prepare_raw_references(&db, &HashSet::from(["Sheet".to_owned()]), &|| false)
            .unwrap();
        assert_eq!(ops.metrics()["detector_calls"], 0);
        assert!(
            ops.metrics()["phases"]["sheet_parse"]["count"]
                .as_u64()
                .unwrap()
                > 0
        );
    }
}

#[cfg(all(test, feature = "test-detection-failure"))]
mod detector_failure_tests {
    use super::*;

    #[test]
    fn failed_detection_keeps_raw_rows_until_explicit_fresh_generation_retry() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test/fixtures/xlsx-corpus/repeated.xlsx"),
        )
        .unwrap();
        let db = Connection::open_in_memory().unwrap();
        let mut ops = XlsxOps::attach(&db, bytes, Options::default(), &|| false).unwrap();
        ops.fail_detection_once = Some("Sheet".into());
        ops.prepare_for(&db, "Sheet").unwrap();
        let status = ops.status("Sheet").unwrap();
        assert_eq!(
            (status.state, status.generation, status.retryable),
            (State::Failed, 0, true)
        );
        let count: i64 = db
            .query_row("select count(*) from Sheet", [], |r| r.get(0))
            .unwrap();
        assert!(count > 0);
        ops.prepare_for(&db, "Sheet").unwrap();
        assert_eq!(ops.status("Sheet").unwrap().state, State::Failed);
        assert!(ops.detected_tables("Sheet").is_empty());
        let status = ops.retry_sheet_preparation(&db, "Sheet").unwrap().unwrap();
        assert_eq!((status.state, status.generation), (State::Ready, 1));
        assert_eq!(ops.detected_tables("Sheet").len(), 1);
    }
}
