//! Workbook reads: sheet list, declared/measured dimensions, cells, merges and number formats.
//!
//! Ports `src/xlsxSheets.ts` (names and dimensions) and does the cell reading DuckDB's excel
//! extension does in the TypeScript product, keeping what display and edit location need:
//! raw coordinates, cached values, formulas, error literals, number-format class and merges.
use crate::budget::{Limits, Refusal, WORKBOOK_LIMITS, preflight_file};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use std::collections::BTreeMap;
use std::io::{BufReader, Cursor, Read};
use zip::ZipArchive;

/* ------------------------------------------------------------------ coordinates */

/// `"AA"` -> 26 (0-based), so "AA" sorts after "Z".
pub fn column_index(letters: &str) -> u32 {
    letters
        .bytes()
        .fold(0u32, |n, b| {
            n.saturating_mul(26)
                .saturating_add(u32::from(b.to_ascii_uppercase().wrapping_sub(b'A')).min(25) + 1)
        })
        .saturating_sub(1)
}

/// 0 -> "A", 26 -> "AA".
pub fn column_letters(index: u32) -> String {
    let mut out = Vec::new();
    let mut n = index;
    loop {
        out.push(b'A' + (n % 26) as u8);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `"B12"` -> (row0, col0). Rejects anything past XFD / 1048576.
pub fn parse_cell_ref(r: &str) -> Option<(u32, u32)> {
    let split = r.bytes().take_while(u8::is_ascii_uppercase).count();
    let (l, d) = r.split_at(split);
    if l.is_empty() || l.len() > 3 || d.is_empty() || !d.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let row: u32 = d.parse().ok()?;
    let col = column_index(l);
    ((1..=1_048_576).contains(&row) && col < 16_384).then(|| (row - 1, col))
}

/// A sheet rectangle with 1-based rows and column letters, as the TypeScript reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetDimension {
    pub first_row: u32,
    pub last_row: u32,
    pub first_col: String,
    pub last_col: String,
}

/// `"B2:AH16809"` or `"B2"`; anything else is undeclared.
pub fn parse_dimension(reference: &str) -> Option<SheetDimension> {
    let t = reference.trim();
    let (a, b) = t.split_once(':').unwrap_or((t, t));
    let split = |s: &str| {
        let n = s.bytes().take_while(u8::is_ascii_uppercase).count();
        let (l, d) = s.split_at(n);
        (!l.is_empty() && !d.is_empty() && d.bytes().all(|c| c.is_ascii_digit()))
            .then(|| (l.to_owned(), d.parse::<u32>().ok()))
    };
    let (fc, fr) = split(a)?;
    let (lc, lr) = split(b)?;
    Some(SheetDimension {
        first_row: fr?,
        last_row: lr?,
        first_col: fc,
        last_col: lc,
    })
}

/// Inclusive rectangle in 0-based cell coordinates (merged ranges).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellRange {
    pub top: u32,
    pub left: u32,
    pub bottom: u32,
    pub right: u32,
}

/// An explicitly declared Excel table. Coordinates are inclusive, matching merged ranges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredTable {
    pub name: String,
    pub range: CellRange,
    pub header: bool,
    pub totals: bool,
    pub columns: Vec<String>,
}

fn parse_range(r: &str) -> Option<CellRange> {
    let (a, b) = r.split_once(':').unwrap_or((r, r));
    let (top, left) = parse_cell_ref(a)?;
    let (bottom, right) = parse_cell_ref(b)?;
    Some(CellRange {
        top,
        left,
        bottom,
        right,
    })
}

/* ---------------------------------------------------------------------- values */

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// Shared, inline or formula-string text.
    Text(String),
    /// The `<v>` text exactly as stored (shortest round-trip form written by the producer).
    Number(String),
    Bool(bool),
    /// An error literal such as `#DIV/0!`, kept verbatim.
    Error(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Formula {
    pub text: String,
    /// `si` of a shared formula; children of a shared formula carry an empty `text`.
    pub shared_index: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct XlCell {
    pub value: Value,
    pub formula: Option<Formula>,
    /// Index into `Workbook::styles` (`cellXfs`).
    pub style: u32,
}

impl XlCell {
    /// The cell as an `all_varchar` read shows it. Booleans render as DuckDB's `true`/`false`.
    pub fn text(&self) -> String {
        match &self.value {
            Value::Text(s) | Value::Number(s) | Value::Error(s) => s.clone(),
            Value::Bool(b) => b.to_string(),
        }
    }
}

/// The number-format class a style implies; display formatting itself is the caller's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Style {
    pub num_fmt_id: u32,
    pub format_code: Option<String>,
    pub is_date: bool,
}

/* ------------------------------------------------------------------- xml plumbing */

fn bad(detail: &str) -> Refusal {
    Refusal::new(
        "not_a_workbook",
        format!("Not a readable .xlsx package: {detail}"),
    )
}

fn attr(e: &BytesStart<'_>, name: &str) -> Option<String> {
    // Matched by local name, so `r:id` and `id` agree and attribute ORDER never matters.
    e.attributes().with_checks(false).flatten().find_map(|a| {
        (a.key.local_name().as_ref() == name.as_bytes())
            .then(|| a.unescape_value().ok().map(|v| v.into_owned()))
            .flatten()
    })
}

fn text_of(t: &quick_xml::events::BytesText<'_>) -> String {
    // Entity references arrive as separate `GeneralRef` events, so text is never unescaped here.
    t.decode().map(|c| c.into_owned()).unwrap_or_default()
}

/// The character(s) an entity or character reference stands for.
fn ref_text(r: &quick_xml::events::BytesRef<'_>) -> String {
    if let Ok(Some(ch)) = r.resolve_char_ref() {
        return ch.to_string();
    }
    let name = r.decode().map(|c| c.into_owned()).unwrap_or_default();
    match name.as_str() {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        other => format!("&{other};"),
    }
}

fn local(e: &BytesStart<'_>) -> Vec<u8> {
    e.local_name().as_ref().to_vec()
}

/* ----------------------------------------------------------------------- package */

pub struct Package {
    archive: ZipArchive<Cursor<Vec<u8>>>,
    /// SHA-256 of the exact bytes that were judged and are now parsed.
    pub sha256: String,
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetRef {
    pub name: String,
    /// Part path inside the archive, e.g. `xl/worksheets/sheet1.xml`; empty when unresolved.
    pub path: String,
}

impl Package {
    pub fn open(path: &std::path::Path) -> Result<Package, Refusal> {
        Self::open_with(path, WORKBOOK_LIMITS)
    }

    pub fn open_with(path: &std::path::Path, limits: Limits) -> Result<Package, Refusal> {
        let (bytes, sha256) = preflight_file(path, &limits)?;
        Self::from_judged(bytes, sha256, limits)
    }

    pub fn from_bytes(bytes: Vec<u8>, limits: Limits) -> Result<Package, Refusal> {
        let sha256 = crate::budget::preflight_bytes(&bytes, &limits)?;
        Self::from_judged(bytes, sha256, limits)
    }

    fn from_judged(bytes: Vec<u8>, sha256: String, limits: Limits) -> Result<Package, Refusal> {
        let archive = ZipArchive::new(Cursor::new(bytes))
            .map_err(|_| bad("it has no central directory, so the file is incomplete."))?;
        Ok(Package {
            archive,
            sha256,
            limits,
        })
    }

    fn part(&mut self, name: &str) -> Result<Option<Vec<u8>>, Refusal> {
        let limit = self.limits.part_bytes;
        let Ok(file) = self.archive.by_name(name) else {
            return Ok(None);
        };
        let mut out = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut out)
            .map_err(|_| Refusal::new("undecodable", "Workbook archive could not be decoded."))?;
        if out.len() as u64 > limit {
            return Err(Refusal::new(
                "decompression",
                "Workbook exceeds its decompression budget.",
            ));
        }
        Ok(Some(out))
    }

    /// Read only this worksheet's table relationships; archive preflight already bounds every part.
    pub fn declared_tables(&mut self, sheet: &SheetRef) -> Result<Vec<DeclaredTable>, Refusal> {
        let xml = self
            .part(&sheet.path)?
            .ok_or_else(|| bad("worksheet part is missing"))?;
        let mut ids = Vec::new();
        let mut reader = Reader::from_reader(xml.as_slice());
        loop {
            match reader.read_event() {
                Ok(Event::Start(e) | Event::Empty(e)) if local(&e) == b"tablePart" => {
                    let id = attr(&e, "id")
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| bad("table relationship id is missing"))?;
                    if ids.contains(&id) {
                        return Err(bad("duplicate table relationship"));
                    }
                    ids.push(id);
                    if ids.len() > 10_000 {
                        return Err(bad("too many declared tables"));
                    }
                }
                Ok(Event::Eof) => break,
                Err(_) => return Err(bad("malformed worksheet table relationships")),
                _ => {}
            }
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let (dir, file) = sheet
            .path
            .rsplit_once('/')
            .ok_or_else(|| bad("invalid worksheet path"))?;
        let rels = self
            .part(&format!("{dir}/_rels/{file}.rels"))?
            .ok_or_else(|| bad("table relationships part is missing"))?;
        let mut targets = BTreeMap::new();
        let mut reader = Reader::from_reader(rels.as_slice());
        loop {
            match reader.read_event() {
                Ok(Event::Start(e) | Event::Empty(e)) if local(&e) == b"Relationship" => {
                    let Some(id) = attr(&e, "Id").filter(|id| ids.contains(id)) else {
                        continue;
                    };
                    if attr(&e, "TargetMode").is_some_and(|s| s != "Internal")
                        || !attr(&e, "Type").is_some_and(|s| s.ends_with("/table"))
                    {
                        return Err(bad("declared table relationship is not an internal table"));
                    }
                    let target = attr(&e, "Target")
                        .ok_or_else(|| bad("table relationship target is missing"))?;
                    if target.starts_with("//") || target.contains(['\\', ':', '?', '#', '%']) {
                        return Err(bad("unsafe table target"));
                    }
                    let combined = if target.starts_with('/') {
                        target.trim_start_matches('/').to_owned()
                    } else {
                        format!("{dir}/{target}")
                    };
                    let mut segments = Vec::new();
                    for segment in combined.split('/') {
                        match segment {
                            "." => {}
                            ".." => {
                                if segments.pop().is_none() {
                                    return Err(bad("unsafe table target"));
                                }
                            }
                            "" => return Err(bad("unsafe table target")),
                            other => segments.push(other),
                        }
                    }
                    let path = segments.join("/");
                    if !path.starts_with("xl/tables/")
                        || !path.ends_with(".xml")
                        || targets.insert(id, path).is_some()
                    {
                        return Err(bad("unsafe or duplicate table relationship"));
                    }
                }
                Ok(Event::Eof) => break,
                Err(_) => return Err(bad("malformed table relationships")),
                _ => {}
            }
        }
        let mut out: Vec<DeclaredTable> = Vec::new();
        for id in ids {
            let path = targets
                .get(&id)
                .ok_or_else(|| bad("declared table relationship is missing"))?;
            let xml = self
                .part(path)?
                .ok_or_else(|| bad("declared table part is missing"))?;
            let mut reader = Reader::from_reader(xml.as_slice());
            let mut table = None;
            let mut count = None;
            loop {
                match reader.read_event() {
                    Ok(Event::Start(e) | Event::Empty(e)) if local(&e) == b"table" => {
                        if table.is_some() {
                            return Err(bad("duplicate table definition"));
                        }
                        let name = attr(&e, "displayName")
                            .or_else(|| attr(&e, "name"))
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| bad("table name is missing"))?;
                        let range = attr(&e, "ref")
                            .and_then(|s| parse_range(&s))
                            .filter(|r| r.top <= r.bottom && r.left <= r.right)
                            .ok_or_else(|| bad("invalid table bounds"))?;
                        let flag = |key: &str, default: bool| -> Result<bool, Refusal> {
                            match attr(&e, key).as_deref() {
                                None => Ok(default),
                                Some("0") => Ok(false),
                                Some("1") => Ok(true),
                                _ => Err(bad("unsupported table header or totals count")),
                            }
                        };
                        table = Some(DeclaredTable {
                            name,
                            range,
                            header: flag("headerRowCount", true)?,
                            totals: flag("totalsRowCount", false)?,
                            columns: vec![],
                        });
                    }
                    Ok(Event::Start(e) | Event::Empty(e)) if local(&e) == b"tableColumns" => {
                        count = attr(&e, "count").and_then(|s| s.parse::<usize>().ok());
                    }
                    Ok(Event::Start(e) | Event::Empty(e)) if local(&e) == b"tableColumn" => {
                        let name = attr(&e, "name")
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| bad("table column name is missing"))?;
                        table
                            .as_mut()
                            .ok_or_else(|| bad("table columns precede table"))?
                            .columns
                            .push(name);
                    }
                    Ok(Event::Eof) => break,
                    Err(_) => return Err(bad("malformed declared table")),
                    _ => {}
                }
            }
            let table = table.ok_or_else(|| bad("table definition is missing"))?;
            let r = table.range;
            let n = table.columns.len();
            if count != Some(n)
                || n != (r.right - r.left + 1) as usize
                || table
                    .columns
                    .iter()
                    .enumerate()
                    .any(|(i, s)| table.columns[..i].iter().any(|p| p.eq_ignore_ascii_case(s)))
                || (u32::from(table.header) + u32::from(table.totals)) > r.bottom - r.top + 1
                || out.iter().any(|t| {
                    t.name.eq_ignore_ascii_case(&table.name)
                        || (r.top <= t.range.bottom
                            && r.bottom >= t.range.top
                            && r.left <= t.range.right
                            && r.right >= t.range.left)
                })
            {
                return Err(bad(
                    "declared tables have inconsistent columns or overlapping bounds",
                ));
            }
            out.push(table);
        }
        Ok(out)
    }

    /// The workbook's sheets in the order it declares them (the order Excel displays).
    ///
    /// Err when the file is not a workbook; an empty list is a valid workbook declaring none.
    pub fn list_sheets(&mut self) -> Result<Vec<SheetRef>, Refusal> {
        let book = self
            .part("xl/workbook.xml")?
            .ok_or_else(|| bad("no xl/workbook.xml inside."))?;
        let rels = self.part("xl/_rels/workbook.xml.rels")?.unwrap_or_default();

        // Targets are relative to xl/ unless absolute within the package.
        let mut target_by_id = BTreeMap::new();
        let mut reader = Reader::from_reader(rels.as_slice());
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e) | Event::Empty(e)) if local(&e) == b"Relationship" => {
                    if let (Some(id), Some(t)) = (attr(&e, "Id"), attr(&e, "Target")) {
                        let path = match t.strip_prefix('/') {
                            Some(abs) => abs.trim_start_matches('/').to_owned(),
                            None => format!("xl/{}", t.strip_prefix("./").unwrap_or(&t)),
                        };
                        target_by_id.insert(id, path);
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => return Err(bad(&format!("workbook relationships: {e}"))),
                _ => {}
            }
            buf.clear();
        }

        let mut out: Vec<SheetRef> = Vec::new();
        let mut reader = Reader::from_reader(book.as_slice());
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e) | Event::Empty(e)) if local(&e) == b"sheet" => {
                    let Some(name) = attr(&e, "name").filter(|n| !n.is_empty()) else {
                        buf.clear();
                        continue;
                    };
                    // A corrupt file may repeat a name; the first keeps display order.
                    if out.iter().any(|s| s.name == name) {
                        buf.clear();
                        continue;
                    }
                    let path = attr(&e, "id")
                        .and_then(|id| target_by_id.get(&id).cloned())
                        .unwrap_or_default();
                    out.push(SheetRef { name, path });
                }
                Ok(Event::Eof) => break,
                Err(e) => return Err(bad(&format!("workbook.xml: {e}"))),
                _ => {}
            }
            buf.clear();
        }
        Ok(out)
    }

    /// The rectangle a sheet declares, else the one its own cells measure. `None` for an empty
    /// sheet. A declaration is an upper bound (workbooks over-declare); use `read_sheet` for the
    /// cells that are really there.
    pub fn dimension(&mut self, sheet_path: &str) -> Result<Option<SheetDimension>, Refusal> {
        let file = self
            .archive
            .by_name(sheet_path)
            .map_err(|_| bad(&format!("no {sheet_path} inside.")))?;
        let mut reader = Reader::from_reader(BufReader::new(file.take(self.limits.part_bytes)));
        let mut buf = Vec::new();
        let (mut fr, mut lr, mut fc, mut lc) = (u32::MAX, 0u32, u32::MAX, 0u32);
        let mut seen = false;
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e) | Event::Empty(e)) => match local(&e).as_slice() {
                    // The declaration sits in the head of the part; the TypeScript only looks in
                    // the first 256 KiB, after which it measures instead.
                    b"dimension" if reader.buffer_position() <= 256 * 1024 + 512 => {
                        if let Some(d) = attr(&e, "ref").and_then(|r| parse_dimension(&r)) {
                            return Ok(Some(d));
                        }
                    }
                    b"c" => {
                        if let Some((r, c)) = attr(&e, "r").and_then(|r| parse_cell_ref(&r)) {
                            seen = true;
                            fr = fr.min(r + 1);
                            lr = lr.max(r + 1);
                            fc = fc.min(c);
                            lc = lc.max(c);
                        }
                    }
                    _ => {}
                },
                Ok(Event::Eof) => break,
                Err(e) => return Err(bad(&format!("{sheet_path}: {e}"))),
                _ => {}
            }
            buf.clear();
        }
        Ok(seen.then(|| SheetDimension {
            first_row: fr,
            last_row: lr,
            first_col: column_letters(fc),
            last_col: column_letters(lc),
        }))
    }

    fn shared_strings(&mut self) -> Result<Vec<String>, Refusal> {
        let Some(xml) = self.part("xl/sharedStrings.xml")? else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        let cap = self.limits.cells_per_sheet as usize;
        let too_many = || {
            Refusal::new(
                "cell_limit",
                "The shared-string table is longer than a worksheet may hold cells.",
            )
        };
        let mut reader = Reader::from_reader(xml.as_slice());
        let mut buf = Vec::new();
        // Only `<t>` text inside `<si>` counts; phonetic runs (`<rPh>`) are not part of the value.
        let (mut in_si, mut in_t, mut in_ph) = (false, false, false);
        let mut cur = String::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => match local(&e).as_slice() {
                    b"si" => {
                        in_si = true;
                        cur.clear();
                    }
                    b"rPh" => in_ph = true,
                    b"t" if in_si && !in_ph => in_t = true,
                    _ => {}
                },
                Ok(Event::Empty(e)) if local(&e) == b"si" => {
                    if out.len() >= cap {
                        return Err(too_many());
                    }
                    out.push(String::new());
                }
                Ok(Event::End(e)) => match e.local_name().as_ref() {
                    b"si" => {
                        in_si = false;
                        if out.len() >= cap {
                            return Err(too_many());
                        }
                        out.push(std::mem::take(&mut cur));
                    }
                    b"rPh" => in_ph = false,
                    b"t" => in_t = false,
                    _ => {}
                },
                Ok(Event::Text(t)) if in_t => cur.push_str(&text_of(&t)),
                Ok(Event::GeneralRef(r)) if in_t => cur.push_str(&ref_text(&r)),
                Ok(Event::CData(t)) if in_t => cur.push_str(&String::from_utf8_lossy(&t)),
                Ok(Event::Eof) => break,
                Err(e) => return Err(bad(&format!("sharedStrings.xml: {e}"))),
                _ => {}
            }
            buf.clear();
        }
        Ok(out)
    }

    /// True when the workbook counts dates from 1904 (`workbookPr date1904`); serials shift by 1462 days.
    pub fn date1904(&mut self) -> Result<bool, Refusal> {
        let book = self
            .part("xl/workbook.xml")?
            .ok_or_else(|| bad("no xl/workbook.xml inside."))?;
        let mut reader = Reader::from_reader(book.as_slice());
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e) | Event::Empty(e)) if local(&e) == b"workbookPr" => {
                    return Ok(matches!(
                        attr(&e, "date1904").as_deref(),
                        Some("1" | "true")
                    ));
                }
                Ok(Event::Eof) => return Ok(false),
                Err(e) => return Err(bad(&format!("workbook.xml: {e}"))),
                _ => {}
            }
            buf.clear();
        }
    }

    /// `cellXfs` in order, each with its number format and whether that format shows a date.
    pub fn styles(&mut self) -> Result<Vec<Style>, Refusal> {
        let Some(xml) = self.part("xl/styles.xml")? else {
            return Ok(Vec::new());
        };
        let mut custom: BTreeMap<u32, String> = BTreeMap::new();
        let mut xfs: Vec<u32> = Vec::new();
        let mut in_cell_xfs = false;
        let mut reader = Reader::from_reader(xml.as_slice());
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) if local(&e) == b"cellXfs" => in_cell_xfs = true,
                Ok(Event::End(e)) if e.local_name().as_ref() == b"cellXfs" => in_cell_xfs = false,
                Ok(Event::Start(e) | Event::Empty(e)) => match local(&e).as_slice() {
                    b"numFmt" => {
                        if let (Some(id), Some(code)) = (
                            attr(&e, "numFmtId").and_then(|v| v.parse().ok()),
                            attr(&e, "formatCode"),
                        ) {
                            custom.insert(id, code);
                        }
                    }
                    b"xf" if in_cell_xfs => {
                        xfs.push(
                            attr(&e, "numFmtId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                        );
                    }
                    _ => {}
                },
                Ok(Event::Eof) => break,
                Err(e) => return Err(bad(&format!("styles.xml: {e}"))),
                _ => {}
            }
            buf.clear();
        }
        Ok(xfs
            .into_iter()
            .map(|id| {
                let code = custom.get(&id).cloned();
                let is_date = match &code {
                    Some(c) => format_is_date(c),
                    None => builtin_is_date(id),
                };
                Style {
                    num_fmt_id: id,
                    format_code: code,
                    is_date,
                }
            })
            .collect())
    }

    /// Every stored cell of one sheet, with merges. Cells with a style but no value are skipped,
    /// as an `all_varchar` read treats them as empty.
    pub fn read_sheet(&mut self, sheet: &SheetRef) -> Result<Sheet, Refusal> {
        if sheet.path.is_empty() {
            return Err(bad(&format!(
                "sheet \"{}\" has no worksheet part.",
                sheet.name
            )));
        }
        let shared = self.shared_strings()?;
        let max_cells = self.limits.cells_per_sheet;
        let part_limit = self.limits.part_bytes;
        let file = self
            .archive
            .by_name(&sheet.path)
            .map_err(|_| bad(&format!("no {} inside.", sheet.path)))?;
        let mut reader = Reader::from_reader(BufReader::new(file.take(part_limit)));
        let mut buf = Vec::new();

        let mut out = Sheet {
            name: sheet.name.clone(),
            path: sheet.path.clone(),
            cells: BTreeMap::new(),
            merges: Vec::new(),
            declared: None,
        };
        // Current cell state.
        struct Pending {
            at: (u32, u32),
            kind: String,
            style: u32,
            v: Option<String>,
            f: Option<Formula>,
            inline: Option<String>,
        }
        let mut cur: Option<Pending> = None;
        let (mut row0, mut seen_row, mut next_col) = (0u32, false, 0u32);
        #[derive(PartialEq)]
        enum In {
            None,
            V,
            F,
            T,
        }
        let mut into = In::None;
        let mut in_ph = false;
        let mut in_is = false;
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(ev @ (Event::Start(_) | Event::Empty(_))) => {
                    let empty = matches!(ev, Event::Empty(_));
                    let (Event::Start(e) | Event::Empty(e)) = ev else {
                        unreachable!()
                    };
                    match local(&e).as_slice() {
                        b"dimension" => {
                            out.declared = attr(&e, "ref").and_then(|r| parse_dimension(&r));
                        }
                        b"row" => {
                            // A missing `r` continues from the previous row.
                            row0 = match attr(&e, "r").and_then(|r| r.parse::<u32>().ok()) {
                                Some(r) if r >= 1 => r - 1,
                                _ if seen_row => row0.saturating_add(1),
                                _ => 0,
                            };
                            seen_row = true;
                            next_col = 0;
                        }
                        b"c" => {
                            let at = attr(&e, "r")
                                .and_then(|r| parse_cell_ref(&r))
                                .unwrap_or((row0, next_col));
                            next_col = at.1 + 1;
                            if out.cells.len() as u64 >= max_cells {
                                return Err(Refusal::new(
                                    "cell_limit",
                                    "Worksheet exceeds the cell limit.",
                                ));
                            }
                            // `<c .../>` carries no value, so it never opens a pending cell.
                            cur = (!empty).then(|| Pending {
                                at,
                                kind: attr(&e, "t").unwrap_or_default(),
                                style: attr(&e, "s").and_then(|s| s.parse().ok()).unwrap_or(0),
                                v: None,
                                f: None,
                                inline: None,
                            });
                        }
                        b"f" => {
                            if let Some(c) = cur.as_mut() {
                                c.f = Some(Formula {
                                    text: String::new(),
                                    shared_index: attr(&e, "si").and_then(|s| s.parse().ok()),
                                });
                                if !empty {
                                    into = In::F;
                                }
                            }
                        }
                        b"v" if cur.is_some() && !empty => into = In::V,
                        b"is" if cur.is_some() && !empty => in_is = true,
                        b"rPh" if !empty => in_ph = true,
                        b"t" if in_is && !in_ph && !empty => into = In::T,
                        b"mergeCell" => {
                            if let Some(r) = attr(&e, "ref").and_then(|r| parse_range(&r)) {
                                out.merges.push(r);
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::Text(t)) => {
                    if let Some(c) = cur.as_mut() {
                        let s = text_of(&t);
                        match into {
                            In::V => c.v.get_or_insert_with(String::new).push_str(&s),
                            In::F => {
                                if let Some(f) = c.f.as_mut() {
                                    f.text.push_str(&s);
                                }
                            }
                            In::T => c.inline.get_or_insert_with(String::new).push_str(&s),
                            In::None => {}
                        }
                    }
                }
                Ok(Event::CData(t)) => {
                    if let (Some(c), In::T) = (cur.as_mut(), &into) {
                        c.inline
                            .get_or_insert_with(String::new)
                            .push_str(&String::from_utf8_lossy(&t));
                    }
                }
                Ok(Event::GeneralRef(r)) => {
                    if let Some(c) = cur.as_mut() {
                        let s = ref_text(&r);
                        match into {
                            In::V => c.v.get_or_insert_with(String::new).push_str(&s),
                            In::F => {
                                if let Some(f) = c.f.as_mut() {
                                    f.text.push_str(&s);
                                }
                            }
                            In::T => c.inline.get_or_insert_with(String::new).push_str(&s),
                            In::None => {}
                        }
                    }
                }
                Ok(Event::End(e)) => match e.local_name().as_ref() {
                    b"v" | b"f" | b"t" => into = In::None,
                    b"is" => in_is = false,
                    b"rPh" => in_ph = false,
                    b"c" => {
                        if let Some(c) = cur.take()
                            && let Some(cell) =
                                finish_cell(c.kind.as_str(), c.v, c.inline, c.f, c.style, &shared)?
                        {
                            out.cells.insert(c.at, cell);
                        }
                        into = In::None;
                    }
                    _ => {}
                },
                Ok(Event::Eof) => break,
                Err(e) => return Err(bad(&format!("{}: {e}", sheet.path))),
                _ => {}
            }
            buf.clear();
        }
        Ok(out)
    }
}

/// Resolve one `<c>` into a stored cell, or `None` when it holds no value.
fn finish_cell(
    kind: &str,
    v: Option<String>,
    inline: Option<String>,
    formula: Option<Formula>,
    style: u32,
    shared: &[String],
) -> Result<Option<XlCell>, Refusal> {
    let value = match kind {
        "s" => {
            let Some(raw) = v else { return Ok(None) };
            let idx: usize = raw
                .trim()
                .parse()
                .map_err(|_| bad("a shared-string index is not a number."))?;
            let s = shared
                .get(idx)
                .ok_or_else(|| bad("a cell refers to a shared string that does not exist."))?;
            Value::Text(s.clone())
        }
        "inlineStr" => Value::Text(inline.or(v).unwrap_or_default()),
        "str" => Value::Text(v.unwrap_or_default()),
        "e" => Value::Error(v.unwrap_or_default()),
        "b" => Value::Bool(v.as_deref().map(str::trim) == Some("1")),
        // "n", "d" (ISO text, kept as stored) and absent type.
        _ => match v {
            Some(s) if !s.is_empty() => {
                if kind == "d" {
                    Value::Text(s)
                } else {
                    Value::Number(s)
                }
            }
            // A formula with no cached result is still a stored cell (edit location needs its place);
            // it reads as empty text, and `text_grid` leaves it out as an `all_varchar` read does.
            _ if formula.is_some() => Value::Text(String::new()),
            _ => return Ok(None),
        },
    };
    Ok(Some(XlCell {
        value,
        formula,
        style,
    }))
}

/// Built-in number formats that display a date or time (ECMA-376 18.8.30).
fn builtin_is_date(id: u32) -> bool {
    matches!(id, 14..=22 | 27..=36 | 45..=47 | 50..=58)
}

/// A custom code is a date when, outside quotes, escapes and `[..]` sections, it holds a
/// date/time token. `[h]`/`[mm]`/`[ss]` elapsed-time brackets count; colours and locales do not.
fn format_is_date(code: &str) -> bool {
    let mut chars = code.chars().peekable();
    let (mut in_quote, mut in_bracket) = (false, false);
    let mut bracket = String::new();
    while let Some(c) = chars.next() {
        if in_quote {
            in_quote = c != '"';
            continue;
        }
        if in_bracket {
            if c == ']' {
                in_bracket = false;
                let b = bracket.to_ascii_lowercase();
                if !b.is_empty() && b.chars().all(|x| matches!(x, 'h' | 'm' | 's')) {
                    return true;
                }
                bracket.clear();
            } else {
                bracket.push(c);
            }
            continue;
        }
        match c {
            '"' => in_quote = true,
            '[' => in_bracket = true,
            '\\' | '_' | '*' => {
                chars.next();
            }
            'y' | 'Y' | 'd' | 'D' | 'h' | 'H' | 's' | 'S' | 'm' | 'M' => return true,
            _ => {}
        }
    }
    false
}

/* ------------------------------------------------------------------------- sheet */

#[derive(Debug, Clone)]
pub struct Sheet {
    pub name: String,
    pub path: String,
    /// Stored cells by (row0, col0).
    pub cells: BTreeMap<(u32, u32), XlCell>,
    pub merges: Vec<CellRange>,
    /// The `<dimension>` as declared (an upper bound), if any.
    pub declared: Option<SheetDimension>,
}

impl Sheet {
    /// Rows and columns that hold at least one stored cell: (rows, cols), both counted from A1.
    pub fn extent(&self) -> (u32, u32) {
        self.cells
            .keys()
            .fold((0, 0), |(r, c), &(cr, cc)| (r.max(cr + 1), c.max(cc + 1)))
    }

    /// The sheet as the text grid an `all_varchar` read hands the table detector, A1-origin.
    pub fn text_grid(&self, max_cells: u64) -> Result<Vec<Vec<Option<String>>>, Refusal> {
        let (rows, cols) = self.extent();
        if u64::from(rows) * u64::from(cols) > max_cells {
            return Err(Refusal::new(
                "cell_limit",
                "Worksheet exceeds the cell limit.",
            ));
        }
        let mut grid = vec![vec![None; cols as usize]; rows as usize];
        for (&(r, c), cell) in &self.cells {
            if cell.formula.is_some() && cell.value == Value::Text(String::new()) {
                continue;
            }
            grid[r as usize][c as usize] = Some(cell.text());
        }
        Ok(grid)
    }
}
