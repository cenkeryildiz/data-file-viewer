//! Which tables does one worksheet hold, and where? Ports `src/sheetTables.ts`,
//! `src/sheetRowMap.ts` and `src/sheetHighlight.ts` function for function.
//!
//! Nothing here discards anything: a region that is not a table is simply not returned; it is
//! still on the sheet, in its own rows, because the sheet is read whole.
use std::collections::{BTreeMap, BTreeSet};

/// A cell as the detector sees it. `Str` is text as stored (or as an `all_varchar` read gives
/// it); `Num` is a number that was not turned into text; `Null` is absent.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Str(String),
    Num(f64),
    Bool(bool),
}

impl From<Option<String>> for Cell {
    fn from(v: Option<String>) -> Self {
        v.map_or(Cell::Null, Cell::Str)
    }
}

/// JavaScript `String(v)` for the cell.
fn js_string(c: &Cell) -> String {
    match c {
        Cell::Null => "null".into(),
        Cell::Str(s) => s.clone(),
        Cell::Num(n) => js_number(*n),
        Cell::Bool(b) => b.to_string(),
    }
}

/// `Number.prototype.toString` for the finite values a worksheet can hold.
fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let a = n.abs();
    if (1e-6..1e21).contains(&a) {
        return format!("{n}");
    }
    // Exponent form, JS style: 1e+21, 1.5e-7.
    let s = format!("{n:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

/// JavaScript `String.prototype.trim` (WhiteSpace + LineTerminator, so BOM counts, NEL does not).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// A rectangle of the sheet grid. `top`/`left` inclusive, `bottom`/`right` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    pub top: usize,
    pub bottom: usize,
    pub left: usize,
    pub right: usize,
}

/// A run of consecutive data rows: `start` inclusive, `end` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExcludedRowReason {
    Blank,
    Header,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExcludedRow {
    pub row: usize,
    pub reason: ExcludedRowReason,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SheetTable {
    /// The rectangle the TABLE occupies, starting AT the header row when one was promoted.
    pub region: Region,
    pub header_row: Option<usize>,
    pub columns: Vec<String>,
    /// Exactly which grid rows are data rows, in order.
    pub data_rows: Vec<RowSpan>,
    pub excluded_rows: Vec<ExcludedRow>,
    pub row_count: usize,
}

/* ------------------------------------------------------------------ row map */

pub fn span_row_count(spans: &[RowSpan]) -> usize {
    spans.iter().map(|s| s.end - s.start).sum()
}

/// Grid row of the `slot`-th data row (0-based), or `None`.
pub fn grid_row_of_slot(spans: &[RowSpan], slot: usize) -> Option<usize> {
    let mut remaining = slot;
    for s in spans {
        let len = s.end - s.start;
        if remaining < len {
            return Some(s.start + remaining);
        }
        remaining -= len;
    }
    None
}

/// Index of `row` among the data rows, or `None` when the row is not a data row.
pub fn slot_of_grid_row(spans: &[RowSpan], row: usize) -> Option<usize> {
    let mut before = 0;
    for s in spans {
        if row >= s.start && row < s.end {
            return Some(before + (row - s.start));
        }
        before += s.end - s.start;
    }
    None
}

/// How many data rows sit above grid row `limit_row` (exclusive).
pub fn slots_before(spans: &[RowSpan], limit_row: usize) -> usize {
    let mut n = 0;
    for s in spans {
        if s.start >= limit_row {
            break;
        }
        n += s.end.min(limit_row) - s.start;
    }
    n
}

/// True when spans are non-empty runs, ascending and non-overlapping.
pub fn valid_spans(spans: &[RowSpan]) -> bool {
    let mut last = 0usize;
    for (i, s) in spans.iter().enumerate() {
        if s.end <= s.start || (i > 0 && s.start < last) {
            return false;
        }
        last = s.end;
    }
    true
}

/// The data rows of a table described without a map: every row below the header.
pub fn table_data_rows(top: usize, bottom: usize, header_row: Option<usize>) -> Vec<RowSpan> {
    let first = header_row.map_or(top, |h| h + 1);
    if first < bottom {
        vec![RowSpan {
            start: first,
            end: bottom,
        }]
    } else {
        vec![]
    }
}

/// Which sides of a cell lie on the outline of a table (`sheetHighlight.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellEdges {
    pub top: bool,
    pub right: bool,
    pub bottom: bool,
    pub left: bool,
}

pub fn table_edges(table: &Region, row: usize, col: usize) -> Option<CellEdges> {
    if row < table.top || row >= table.bottom || col < table.left || col >= table.right {
        return None;
    }
    Some(CellEdges {
        top: row == table.top,
        right: col + 1 == table.right,
        bottom: row + 1 == table.bottom,
        left: col == table.left,
    })
}

/// Where a table row/column lives on the sheet: (grid row0, grid column0). `None` when the row
/// is not a data row, or the column is not one of the table's own. (`locateXlsxEdit`'s mapping;
/// the full-row equality match belongs to the query engine, D3.5/D3.17.)
pub fn locate_edit_cell(table: &SheetTable, slot: usize, column: &str) -> Option<(usize, usize)> {
    let row = grid_row_of_slot(&table.data_rows, slot)?;
    let offset = table.columns.iter().position(|c| c == column)?;
    Some((row, table.region.left + offset))
}

/* ------------------------------------------------------------------- blanks */

/// Blank as STRUCTURE: is this cell absent? The text "NULL"/"NONE" is NOT blank here, and an
/// Excel error marker occupies its cell.
pub fn is_blank(v: &Cell) -> bool {
    match v {
        Cell::Null => true,
        _ => js_trim(&js_string(v)).is_empty(),
    }
}

/// The same structural blank rule for borrowed raw text, without copying it.
pub fn is_blank_text(v: &str) -> bool {
    js_trim(v).is_empty()
}

/// Blank as a VALUE: ETL's `sentinels=True`, used only by the size gate.
fn is_blank_value(v: &Cell) -> bool {
    is_blank(v) || {
        let t = js_trim(&js_string(v)).to_uppercase();
        t == "NULL" || t == "NONE"
    }
}

fn cell_at(grid: &[Vec<Cell>], row: usize, col: usize) -> &Cell {
    grid.get(row)
        .and_then(|r| r.get(col))
        .unwrap_or(&Cell::Null)
}

/* ------------------------------------------------------------- region split */

fn row_is_blank(grid: &[Vec<Cell>], row: usize, left: usize, right: usize) -> bool {
    (left..right).all(|c| is_blank(cell_at(grid, row, c)))
}

fn col_is_blank(grid: &[Vec<Cell>], col: usize, top: usize, bottom: usize) -> bool {
    (top..bottom).all(|r| is_blank(cell_at(grid, r, col)))
}

/// Trim blank rows and columns from a region's edges. Empty regions come back `None`.
fn shrink(grid: &[Vec<Cell>], region: Region) -> Option<Region> {
    let Region {
        mut top,
        mut bottom,
        mut left,
        mut right,
    } = region;
    while top < bottom && row_is_blank(grid, top, left, right) {
        top += 1;
    }
    while bottom > top && row_is_blank(grid, bottom - 1, left, right) {
        bottom -= 1;
    }
    while left < right && col_is_blank(grid, left, top, bottom) {
        left += 1;
    }
    while right > left && col_is_blank(grid, right - 1, top, bottom) {
        right -= 1;
    }
    (top < bottom && left < right).then_some(Region {
        top,
        bottom,
        left,
        right,
    })
}

fn split_on_rows(grid: &[Vec<Cell>], region: Region) -> Vec<Region> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for r in region.top..region.bottom {
        if row_is_blank(grid, r, region.left, region.right) {
            if let Some(s) = start.take() {
                out.push(Region {
                    top: s,
                    bottom: r,
                    ..region
                });
            }
        } else if start.is_none() {
            start = Some(r);
        }
    }
    if let Some(s) = start {
        out.push(Region {
            top: s,
            bottom: region.bottom,
            ..region
        });
    }
    out
}

fn split_on_cols(grid: &[Vec<Cell>], region: Region) -> Vec<Region> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for c in region.left..region.right {
        if col_is_blank(grid, c, region.top, region.bottom) {
            if let Some(s) = start.take() {
                out.push(Region {
                    left: s,
                    right: c,
                    ..region
                });
            }
        } else if start.is_none() {
            start = Some(c);
        }
    }
    if let Some(s) = start {
        out.push(Region {
            left: s,
            right: region.right,
            ..region
        });
    }
    out
}

/// Every maximal rectangle separated from its neighbours by a wholly blank row or column,
/// alternating row and column splits to a fixed point.
pub fn split_regions(grid: &[Vec<Cell>], region: Region) -> Vec<Region> {
    let Some(base) = shrink(grid, region) else {
        return vec![];
    };
    let by_row = split_on_rows(grid, base);
    if by_row.len() > 1 {
        return by_row
            .into_iter()
            .flat_map(|r| split_regions(grid, r))
            .collect();
    }
    let by_col = split_on_cols(grid, base);
    if by_col.len() > 1 {
        return by_col
            .into_iter()
            .flat_map(|r| split_regions(grid, r))
            .collect();
    }
    vec![base]
}

pub fn whole_grid(grid: &[Vec<Cell>]) -> Region {
    Region {
        top: 0,
        bottom: grid.len(),
        left: 0,
        right: grid.iter().map(Vec::len).max().unwrap_or(0),
    }
}

/* ------------------------------------------------------------ header naming */

/// 0 -> A, 26 -> AA.
pub fn column_letters(index: usize) -> String {
    crate::xlsx_read::column_letters(index as u32)
}

/// Suffix repeats rather than dropping them, so the column count still matches the data.
pub fn dedupe(names: &[String]) -> Vec<String> {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    names
        .iter()
        .map(|raw| {
            let name = if raw.is_empty() { "_col" } else { raw.as_str() };
            let n = seen.entry(name.to_owned()).or_insert(0);
            let out = if *n == 0 {
                name.to_owned()
            } else {
                format!("{name}_{n}")
            };
            *n += 1;
            out
        })
        .collect()
}

fn header_names(grid: &[Vec<Cell>], row: usize, left: usize, right: usize) -> Vec<String> {
    let names: Vec<String> = (left..right)
        .map(|c| {
            let v = cell_at(grid, row, c);
            if is_blank(v) {
                format!("_col{}", c - left)
            } else {
                js_trim(&js_string(v)).to_owned()
            }
        })
        .collect();
    dedupe(&names)
}

fn letter_names(left: usize, right: usize) -> Vec<String> {
    (left..right).map(column_letters).collect()
}

/* -------------------------------------------------------- header detection */

fn populated(grid: &[Vec<Cell>], row: usize, left: usize, right: usize) -> Vec<&Cell> {
    (left..right)
        .map(|c| cell_at(grid, row, c))
        .filter(|v| !is_blank(v))
        .collect()
}

fn is_text(v: &Cell) -> bool {
    matches!(v, Cell::Str(_))
}

/// JavaScript `/i` case folding for the letters the date pattern names: ASCII folds, the Turkish
/// capitals fold to their lower case, everything else (dotless i, Kelvin sign, ...) stays itself.
fn fold_ci(c: char) -> char {
    match c {
        'Ö' => 'ö',
        'Ü' => 'ü',
        'Ç' => 'ç',
        'Ğ' => 'ğ',
        'Ş' => 'ş',
        c if c.is_ascii() => c.to_ascii_lowercase(),
        c => c,
    }
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// ETL's `_DATE_COL_PATTERN`, verbatim. A bare year is deliberately NOT in here.
pub fn is_date_column_name(name: &str) -> bool {
    let s: String = js_trim(name).chars().map(fold_ci).collect();
    const WORDS: &[&str] = &[
        "date",
        "datetime",
        "time",
        "timestamp",
        "period",
        "year",
        "month",
        "week",
        "day",
        "quarter",
        "tarih",
        "tarihi",
        "zaman",
        "yil",
        "yıl",
        "yillar",
        "yıllar",
        "donem",
        "dönem",
        "donemi",
        "dönemi",
        "ay",
        "aylar",
        "hafta",
        "ceyrek",
        "çeyrek",
        "gun",
        "gün",
    ];
    if WORDS.contains(&s.as_str()) || s == "dt" || s == "ts" {
        return true;
    }
    // (?:date|dt|ts|time)_.+
    for p in ["date_", "dt_", "ts_", "time_"] {
        if let Some(rest) = s.strip_prefix(p)
            && !rest.is_empty()
            && !rest.chars().any(is_line_terminator)
        {
            return true;
        }
    }
    // .+_(?:date|datetime|dt|ts|time|timestamp|period)
    for p in [
        "_date",
        "_datetime",
        "_dt",
        "_ts",
        "_time",
        "_timestamp",
        "_period",
    ] {
        if let Some(head) = s.strip_suffix(p)
            && !head.is_empty()
            && !head.chars().any(is_line_terminator)
        {
            return true;
        }
    }
    // [DWMQYHdwmqyh]\d*date
    let mut it = s.chars();
    if matches!(it.next(), Some('d' | 'w' | 'm' | 'q' | 'y' | 'h')) {
        let rest: String = it.collect();
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        return &rest[digits..] == "date";
    }
    false
}

/// ETL's `_year_headed_header`: "2019 | ppi | wage" is a header whose period column is a bare year.
fn year_headed_header(grid: &[Vec<Cell>], row: usize, region: Region, pop: &[&Cell]) -> bool {
    if region.bottom - row < 2 || pop.len() < 2 {
        return false;
    }
    let Cell::Num(first) = pop[0] else {
        return false;
    };
    if first.fract() != 0.0 || *first < 1900.0 || *first > 2100.0 {
        return false;
    }
    if !pop[1..].iter().all(|v| is_text(v)) {
        return false;
    }
    let below = populated(grid, row + 1, region.left, region.right);
    !(below.len() > 1 && below[1..].iter().all(|v| is_text(v)))
}

/// The width a region settles into: the MODE of its populated row widths; ties go to the
/// NARROWER width.
fn modal_width(grid: &[Vec<Cell>], region: Region) -> usize {
    let mut counts: BTreeMap<usize, usize> = BTreeMap::new();
    for r in region.top..region.bottom {
        let w = populated(grid, r, region.left, region.right).len();
        if w > 0 {
            *counts.entry(w).or_insert(0) += 1;
        }
    }
    let (mut width, mut best) = (0usize, 0usize);
    for (w, count) in counts {
        if count > best || (count == best && w < width) {
            best = count;
            width = w;
        }
    }
    width
}

const MIN_HEADER_RATIO: f64 = 0.75;

/// Which row of this region is its header, or `None`. Type gate AND width gate; rows below the
/// width bar are captions and are skipped.
fn find_header_row(grid: &[Vec<Cell>], region: Region, min_cols: usize) -> Option<usize> {
    let span = region.right - region.left;
    let modal = modal_width(grid, region);
    let need = min_cols.min(span).max(
        modal
            .saturating_sub(1)
            .max(1)
            .min((modal as f64 * MIN_HEADER_RATIO).ceil() as usize),
    );
    for r in region.top..region.bottom {
        let pop = populated(grid, r, region.left, region.right);
        if pop.is_empty() || pop.len() < need {
            continue; // blank, or a caption; keep looking
        }
        let breadth_ok = pop.len() >= min_cols.min(span);
        let looks = pop
            .iter()
            .any(|v| is_text(v) && is_date_column_name(&js_string(v)))
            || (breadth_ok && pop.iter().all(|v| is_text(v)))
            || (breadth_ok && year_headed_header(grid, r, region, &pop));
        return looks.then_some(r);
    }
    None
}

/* ------------------------------------------------- footnote / footer tests */

/// ETL's `_fold_label`: deaccent, lowercase, drop a trailing colon.
pub fn fold_label(v: &str) -> String {
    let s: String = js_trim(v)
        .chars()
        .map(|ch| match ch {
            'ş' | 'Ş' => 's',
            'ğ' | 'Ğ' => 'g',
            'ı' | 'İ' => 'i',
            'ö' | 'Ö' => 'o',
            'ü' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            'â' | 'Â' => 'a',
            c => c,
        })
        .collect::<String>()
        .to_lowercase();
    match s.strip_suffix(':') {
        Some(t) => js_trim(t).to_owned(),
        None => s,
    }
}

const KNOWN_LABELS: &[&str] = &[
    "unit",
    "unit multiplier",
    "source",
    "sources",
    "note",
    "notes",
    "footnote",
    "footnotes",
    "definition",
    "definitions",
    "remark",
    "remarks",
    "last updated",
    "frequency",
    "period",
    "coverage",
    "methodology",
    "kaynak",
    "kaynaklar",
    "not",
    "notlar",
    "dipnot",
    "dipnotlar",
    "aciklama",
    "aciklamalar",
    "tanim",
    "tanimlar",
    "birim",
    "siklik",
    "seri",
    "seriler",
    "kod",
    "guncelleme",
    "son guncelleme",
    "donem",
    "seri aciklamasi",
    "seri aciklamalari",
    "veri kaynagi",
    "etiketler",
];

const SECTION_HEADINGS: &[&str] = &[
    "note",
    "notes",
    "footnote",
    "footnotes",
    "source",
    "sources",
    "definition",
    "definitions",
    "remark",
    "remarks",
    "methodology",
    "not",
    "notlar",
    "dipnot",
    "dipnotlar",
    "kaynak",
    "kaynaklar",
    "aciklama",
    "aciklamalar",
    "tanim",
    "tanimlar",
    "seri aciklamasi",
    "seri aciklamalari",
];

/// `/^[A-Z][A-Z0-9_]{2,}:.+/`: the BIS/SDMX form `FREQ: M`. Case-sensitive on purpose.
fn footer_code(s: &str) -> bool {
    let mut it = s.chars();
    if !it.next().is_some_and(|c| c.is_ascii_uppercase()) {
        return false;
    }
    let mut n = 0;
    while let Some(c) = it.next() {
        match c {
            'A'..='Z' | '0'..='9' | '_' => n += 1,
            ':' => return n >= 2 && it.next().is_some_and(|c| !is_line_terminator(c)),
            _ => return false,
        }
    }
    false
}

#[derive(Debug, Clone, Default)]
pub struct FooterOptions {
    /// ETL's METADATA_FOOTER_MIN_RATIO (default 0.6).
    pub min_ratio: Option<f64>,
    /// ETL's FOOTNOTE_LABELS: extends BOTH the heading set and the label set.
    pub extra_labels: Vec<String>,
    /// The column names of the table this region sits under, when there is one.
    pub describes_columns: Vec<String>,
}

/// ETL's `_looks_like_metadata_footer_block`: the four tests in their original order.
pub fn looks_like_footer(
    grid: &[Vec<Cell>],
    region: Region,
    header_promoted: bool,
    opts: &FooterOptions,
) -> bool {
    let min_ratio = opts.min_ratio.unwrap_or(0.6);
    let extra: Vec<String> = opts.extra_labels.iter().map(|l| fold_label(l)).collect();

    // The first POPULATED column, not literally the leftmost.
    let mut first_col: Option<usize> = None;
    let mut first_vals: Vec<String> = Vec::new();
    for c in region.left..region.right {
        let vals: Vec<String> = (region.top..region.bottom)
            .map(|r| cell_at(grid, r, c))
            .filter(|v| !is_blank(v))
            .map(js_string)
            .collect();
        if !vals.is_empty() {
            first_col = Some(c);
            first_vals = vals;
            break;
        }
    }
    if first_vals.is_empty() {
        return false;
    }

    let labels: BTreeSet<String> = KNOWN_LABELS
        .iter()
        .map(|s| (*s).to_owned())
        .chain(extra.iter().cloned())
        .collect();
    let is_label = |raw: &str| -> bool {
        let s = js_trim(raw);
        if footer_code(s) || labels.contains(&fold_label(s)) {
            return true;
        }
        // "Not: veriler gecicidir": the label and its value in one cell.
        let head = s
            .split(':')
            .next()
            .filter(|_| s.contains(':'))
            .unwrap_or("");
        !head.is_empty() && labels.contains(&fold_label(head))
    };

    // 1. A table that DESCRIBES the table above it.
    if !opts.describes_columns.is_empty() && first_vals.len() >= 2 {
        let known: BTreeSet<String> = opts
            .describes_columns
            .iter()
            .filter(|c| !js_trim(c).is_empty())
            .map(|c| fold_label(c))
            .collect();
        if !known.is_empty() {
            let named = first_vals
                .iter()
                .filter(|v| known.contains(&fold_label(v)))
                .count();
            if named as f64 / first_vals.len() as f64 >= min_ratio {
                return true;
            }
        }
    }

    // 2. A section heading: a row whose ONLY populated cell is a footer label.
    let headings: BTreeSet<String> = SECTION_HEADINGS
        .iter()
        .map(|s| (*s).to_owned())
        .chain(extra.iter().cloned())
        .collect();
    for r in region.top..region.bottom {
        let pop = populated(grid, r, region.left, region.right);
        if pop.len() == 1 && headings.contains(&fold_label(&js_string(pop[0]))) {
            return true;
        }
    }

    // 3. Label ratio down the first populated column.
    let mut candidates = first_vals;
    if let (true, Some(c)) = (header_promoted, first_col) {
        // ETL prepends the promoted column NAME: that column's own header cell.
        let own = cell_at(grid, region.top, c);
        candidates.insert(
            0,
            if *own == Cell::Null {
                String::new()
            } else {
                js_string(own)
            },
        );
    }
    let hits = candidates.iter().filter(|c| is_label(c)).count();
    hits as f64 / candidates.len() as f64 >= min_ratio
}

/* ------------------------------------------------------------- the detector */

#[derive(Debug, Clone)]
pub struct DetectOptions {
    pub min_rows: usize,
    pub min_cols: usize,
    pub min_ratio: Option<f64>,
    pub extra_labels: Vec<String>,
    /// Split side-by-side tables on blank columns. ETL cannot; here it is the default.
    pub split_columns: bool,
    pub corrections: TableCorrections,
}

impl Default for DetectOptions {
    fn default() -> Self {
        Self {
            min_rows: 2,
            min_cols: 2,
            min_ratio: None,
            extra_labels: vec![],
            split_columns: true,
            corrections: TableCorrections::default(),
        }
    }
}

/// A user's explicit answer to "is this block the same table as the one above?". Each entry is
/// the 0-based grid row where a block STARTS.
#[derive(Debug, Clone, Default)]
pub struct TableCorrections {
    pub split: Vec<usize>,
    pub merge: Vec<usize>,
    pub manual_tables: Vec<ManualTable>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualTable {
    pub region: Region,
    pub header_row: Option<usize>,
}

fn populated_columns(grid: &[Vec<Cell>], region: Region) -> BTreeSet<usize> {
    (region.left..region.right)
        .filter(|&c| !col_is_blank(grid, c, region.top, region.bottom))
        .collect()
}

/// How many columns hold a real VALUE: ETL's size gate, with sentinels ON.
fn value_column_count(grid: &[Vec<Cell>], region: Region) -> usize {
    (region.left..region.right)
        .filter(|&c| (region.top..region.bottom).any(|r| !is_blank_value(cell_at(grid, r, c))))
        .count()
}

fn gap_is_blank(grid: &[Vec<Cell>], from: usize, to: usize, left: usize, right: usize) -> bool {
    (from..to).all(|r| row_is_blank(grid, r, left, right))
}

/// Every table on the sheet, in reading order.
pub fn detect_tables(grid: &[Vec<Cell>], opts: &DetectOptions) -> Vec<SheetTable> {
    let root = whole_grid(grid);
    if root.bottom == 0 || root.right == 0 {
        return vec![];
    }
    let mut regions: Vec<Region> = if opts.split_columns {
        split_regions(grid, root)
    } else {
        split_on_rows(grid, shrink(grid, root).unwrap_or(root))
            .into_iter()
            .filter_map(|r| shrink(grid, r))
            .collect()
    };
    // Reading order: down the page, then across it.
    regions.sort_by_key(|r| (r.top, r.left));

    let footer_opts = |previous: Option<&SheetTable>| FooterOptions {
        min_ratio: opts.min_ratio,
        extra_labels: opts.extra_labels.clone(),
        describes_columns: previous.map(|p| p.columns.clone()).unwrap_or_default(),
    };

    let mut out: Vec<SheetTable> = Vec::new();
    for region in regions {
        let header_row = find_header_row(grid, region, opts.min_cols);
        let header_promoted = header_row.is_some();
        let columns = match header_row {
            Some(h) => header_names(grid, h, region.left, region.right),
            None => letter_names(region.left, region.right),
        };
        let is_footer = looks_like_footer(grid, region, header_promoted, &footer_opts(out.last()));

        // 1. Continuation of the table above (same table, stray blank row).
        if let Some(prev) = out.last_mut()
            && region.top >= prev.region.bottom
            && !opts.corrections.split.contains(&region.top)
        {
            let adjoins = region.left == prev.region.left
                && region.right == prev.region.right
                && gap_is_blank(
                    grid,
                    prev.region.bottom,
                    region.top,
                    region.left,
                    region.right,
                );
            let header_at_top = header_row.is_none_or(|h| h == region.top);
            let mut continues = false;
            if adjoins && header_at_top && opts.corrections.merge.contains(&region.top) {
                continues = true;
            } else if adjoins && header_at_top && !is_footer {
                continues = if header_promoted {
                    columns == prev.columns
                } else {
                    let a = populated_columns(grid, prev.region);
                    let b = populated_columns(grid, region);
                    a == b && b.len() >= opts.min_cols.min(region.right - region.left)
                };
            }
            if continues {
                for r in prev.region.bottom..region.top {
                    prev.excluded_rows.push(ExcludedRow {
                        row: r,
                        reason: ExcludedRowReason::Blank,
                    });
                }
                let first_data = if header_promoted {
                    region.top + 1
                } else {
                    region.top
                };
                if header_promoted {
                    prev.excluded_rows.push(ExcludedRow {
                        row: region.top,
                        reason: ExcludedRowReason::Header,
                    });
                }
                if first_data < region.bottom {
                    prev.data_rows.push(RowSpan {
                        start: first_data,
                        end: region.bottom,
                    });
                }
                prev.region.bottom = region.bottom;
                prev.row_count = span_row_count(&prev.data_rows);
                continue;
            }
        }

        // 2. A metadata footer is not a table, however big it is.
        if is_footer {
            continue;
        }

        // 3. The size gate, measured BEFORE header promotion.
        let height = region.bottom - region.top;
        if height < opts.min_rows || value_column_count(grid, region) < opts.min_cols {
            continue;
        }

        // The table starts at its header; anything above it in the region is a caption.
        let extent = header_row.map_or(region, |h| Region { top: h, ..region });
        let first_data = header_row.map_or(extent.top, |h| h + 1);
        let data_rows = if first_data < extent.bottom {
            vec![RowSpan {
                start: first_data,
                end: extent.bottom,
            }]
        } else {
            vec![]
        };
        let row_count = span_row_count(&data_rows);
        out.push(SheetTable {
            region: extent,
            header_row,
            columns,
            data_rows,
            excluded_rows: vec![],
            row_count,
        });
    }
    out
}
