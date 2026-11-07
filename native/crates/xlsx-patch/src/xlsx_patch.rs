//! Port of `src/xlsxWrite.ts` planPatch / verifyCandidate / buildCell / spliceCell (no file I/O, locking or publishing).
//! The ONE `<c>` the edit targets is rewritten inside the worksheet XML; every other member is copied byte for byte.
//!
//! Deliberate differences from the TypeScript (each covered by a test):
//! * replacement text is spliced by slicing, so a value such as `$&` is written literally (JS `String.replace` expanded it);
//! * a worksheet that is not valid UTF-8 is refused (the TS decoded it lossily and re-encoded the damage);
//! * an XML character reference that is not a Unicode scalar is kept as written (the TS threw a RangeError);
//! * a date before 1899 in a date-styled cell is refused rather than mapped through `Date.UTC`'s 0-99 => 1900s rule;
//! * archives outside `zip::index_zip`'s scope are refused (the TS fell back to fflate).
use crate::zip::{self, Entry};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}
re!(ROW_RE, r"<row\b[^>]*?(?:/>|>[\s\S]*?</row>)");
re!(ROW_R, r#"<row\b[^>]*?\br="([0-9]+)""#);
re!(NON_EMPTY, r"<c\b");
re!(CELL_ALL, r"<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)");
re!(CELL_REF, r#"\br="([A-Z]+)[0-9]+""#);
re!(TYPE_ATTR, r#"\bt="([a-zA-Z]+)""#);
re!(V_TAG, r"<v>([\s\S]*?)</v>");
re!(IS_TAG, r"<is>[\s\S]*?<t[^>]*>([\s\S]*?)</t>");
re!(STYLE_ATTR, r#"\bs="([0-9]+)""#);
re!(FORMULA, r"<f\b[^>]*?(?:/>|>([\s\S]*?)</f>)");
re!(
    NUMFMT,
    r#"<numFmt\b[^>]*?\bnumFmtId="([0-9]+)"[^>]*?\bformatCode="([^"]*)""#
);
re!(CELLXFS, r"<cellXfs\b[^>]*>([\s\S]*?)</cellXfs>");
re!(XF, r"<xf\b[^>]*?(?:/>|>[\s\S]*?</xf>)");
re!(NUMFMT_ID, r#"\bnumFmtId="([0-9]+)""#);
re!(DATE1904, r#"<workbookPr\b[^>]*\bdate1904="(1|true)""#);
re!(SI, r"<si\b[^>]*>([\s\S]*?)</si>");
re!(T_PIECE, r"<t\b[^>]*>([\s\S]*?)</t>");
re!(T_STRIP, r"<t\b[^>]*>|</t>");
re!(
    NUMBER_TEXT,
    r"^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$"
);
re!(INTEGER_TEXT, r"^-?[0-9]+$");
re!(SELF_CLOSING_ROW, r"<row\b[^>]*/>");
re!(ROW_TAIL, r"</row>\s*$");
re!(
    ISO_TIME,
    r"^([0-9]{2}):([0-9]{2})(?::([0-9]{2}(?:\.[0-9]+)?))?$"
);
re!(
    ISO_DATE,
    r"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2}(?:\.[0-9]+)?))?)?$"
);
re!(ISO_DATE_ONLY, r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
re!(QUOTED, r#""[^"]*""#);
re!(ESCAPED, r"\\.");
re!(SKIPPED, r"[_*].");
re!(DATE_TOKEN, r"[dmyhsDMYHS]");
re!(ENT_DEC, r"&#([0-9]+);");
re!(ENT_HEX, r"&#x([0-9a-fA-F]+);");

/// What a caller passes for `expectedCurrent` / `newValue` (the JS `unknown`).
#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Null,
    Bool(bool),
    Number(f64),
    /// A JS bigint, as its decimal digits.
    BigInt(String),
    Text(String),
}

#[derive(Debug, Clone)]
pub struct PatchRequest {
    /// Worksheet part inside the package.
    pub sheet_path: String,
    pub column_name: String,
    pub column_names: Vec<String>,
    /// With `verbatim`, a worksheet row number; otherwise the 1-based data-row position below the header.
    pub row_ordinal: i64,
    pub verbatim: bool,
    /// Lower-case hex SHA-256 of the bytes the row was located in.
    pub expected_sha256: Option<String>,
    pub expected_current: CellValue,
    pub new_value: CellValue,
}

#[derive(Debug)]
pub struct PatchError(pub String);
impl fmt::Display for PatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PatchError {}
impl From<zip::ZipError> for PatchError {
    fn from(e: zip::ZipError) -> Self {
        Self(e.0)
    }
}
type Res<T> = Result<T, PatchError>;
fn err<T>(msg: impl Into<String>) -> Res<T> {
    Err(PatchError(msg.into()))
}

/// Zero-based column index, or -1 when the letters are invalid or overflow.
pub fn column_index_of(letters: &str) -> i64 {
    if letters.is_empty() || !letters.bytes().all(|b| b.is_ascii_alphabetic()) {
        return -1;
    }
    letters
        .bytes()
        .try_fold(0i64, |n, b| {
            n.checked_mul(26)?
                .checked_add(i64::from(b.to_ascii_uppercase() - b'A') + 1)
        })
        .and_then(|n| n.checked_sub(1))
        .unwrap_or(-1)
}

/// JS `String(number)`: shortest round-trip digits laid out by the ECMAScript Number::toString rules.
pub fn js_number_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if x == 0.0 {
        return "0".into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let tail = if k == 1 {
            String::new()
        } else {
            format!(".{}", &digits[1..])
        };
        format!(
            "{}{tail}e{}{}",
            &digits[..1],
            if e < 0 { '-' } else { '+' },
            e.abs()
        )
    };
    format!("{sign}{body}")
}

impl CellValue {
    /// JS `String(value)` for the non-null kinds.
    fn js_string(&self) -> String {
        match self {
            CellValue::Null => "null".into(),
            CellValue::Bool(b) => b.to_string(),
            CellValue::Number(n) => js_number_string(*n),
            CellValue::BigInt(s) | CellValue::Text(s) => s.clone(),
        }
    }
    fn is_nullish(&self) -> bool {
        matches!(self, CellValue::Null)
    }
}

fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\r', "&#13;")
}

fn unescape_xml_text(text: &str) -> String {
    let t = text
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");
    let t = ENT_DEC.replace_all(&t, |c: &regex::Captures| {
        c[1].parse::<u32>()
            .ok()
            .and_then(char::from_u32)
            .map_or_else(|| c[0].to_owned(), String::from)
    });
    let t = ENT_HEX.replace_all(&t, |c: &regex::Captures| {
        u32::from_str_radix(&c[1], 16)
            .ok()
            .and_then(char::from_u32)
            .map_or_else(|| c[0].to_owned(), String::from)
    });
    t.replace("&amp;", "&") // last, so "&amp;lt;" does not become "<"
}

struct RowBlock {
    number: i64,
    start: usize,
    end: usize,
    xml: String,
}

fn read_rows(sheet: &str) -> Vec<RowBlock> {
    let mut rows: Vec<RowBlock> = Vec::new();
    for m in ROW_RE.find_iter(sheet) {
        let number = ROW_R
            .captures(m.as_str())
            .and_then(|c| c[1].parse().ok())
            .unwrap_or(rows.len() as i64 + 1);
        rows.push(RowBlock {
            number,
            start: m.start(),
            end: m.end(),
            xml: m.as_str().to_owned(),
        });
    }
    rows
}

struct StoredCell {
    text: String,
    ty: Option<String>,
    style: Option<u32>,
    formula: Option<String>,
}

fn stored_cell_of(row: &str, letters: &str, shared: &[String]) -> StoredCell {
    let re = Regex::new(&format!(
        r#"<c\b([^>]*?\br="{}[0-9]+"[^>]*?)(?:/>|>([\s\S]*?)</c>)"#,
        regex::escape(letters)
    ))
    .unwrap();
    let Some(m) = re.captures(row) else {
        return StoredCell {
            text: String::new(),
            ty: None,
            style: None,
            formula: None,
        };
    };
    let attrs = &m[1];
    let body = m.get(2).map_or("", |b| b.as_str());
    let text = cell_texts_of(m.get(0).unwrap().as_str(), shared)
        .into_iter()
        .find(|(k, _)| k == letters)
        .map(|(_, v)| v);
    StoredCell {
        text: text.unwrap_or_default(),
        ty: TYPE_ATTR.captures(attrs).map(|c| c[1].to_owned()),
        style: STYLE_ATTR.captures(attrs).and_then(|c| c[1].parse().ok()),
        formula: FORMULA
            .captures(body)
            .map(|c| unescape_xml_text(c.get(1).map_or("", |g| g.as_str()))),
    }
}

const BUILTIN_DATE_FORMATS: [u32; 31] = [
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
    52, 53, 54, 55, 56, 57, 58,
];

/// Whether a custom format code shows a date or time: a d/m/y/h/s token outside quotes, escapes and [colour] blocks.
fn is_date_format_code(code: &str) -> bool {
    let bare = QUOTED.replace_all(code, "");
    let bare = ESCAPED.replace_all(&bare, "");
    let bare = SKIPPED.replace_all(&bare, "");
    // JS: /\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi -- the regex crate has no lookahead, so scan for it.
    let chars: Vec<char> = bare.chars().collect();
    let mut kept = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '['
            && let Some(close) = chars[i + 1..].iter().position(|c| *c == ']')
        {
            let inner: String = chars[i + 1..i + 1 + close]
                .iter()
                .collect::<String>()
                .to_lowercase();
            let elapsed = !inner.is_empty()
                && ["h", "m", "s"]
                    .iter()
                    .any(|l| inner.chars().all(|c| c.to_string() == *l));
            if !elapsed {
                i += close + 2;
                continue;
            }
        }
        kept.push(chars[i]);
        i += 1;
    }
    DATE_TOKEN.is_match(&kept)
}

fn part_text(files: &HashMap<String, Vec<u8>>, name: &str) -> Option<String> {
    files
        .get(name)
        .map(|b| String::from_utf8_lossy(b).into_owned())
}

fn read_date_styles(files: &HashMap<String, Vec<u8>>) -> HashSet<usize> {
    let mut out = HashSet::new();
    let Some(xml) = part_text(files, "xl/styles.xml") else {
        return out;
    };
    let custom: HashMap<u32, String> = NUMFMT
        .captures_iter(&xml)
        .filter_map(|m| Some((m[1].parse().ok()?, unescape_xml_text(&m[2]))))
        .collect();
    let xfs = CELLXFS
        .captures(&xml)
        .map(|c| c[1].to_owned())
        .unwrap_or_default();
    for (index, xf) in XF.find_iter(&xfs).enumerate() {
        let id: u32 = NUMFMT_ID
            .captures(xf.as_str())
            .and_then(|c| c[1].parse().ok())
            .unwrap_or(0);
        let date = match custom.get(&id) {
            Some(code) => is_date_format_code(code),
            None => BUILTIN_DATE_FORMATS.contains(&id),
        };
        if date {
            out.insert(index);
        }
    }
    out
}

fn uses_date1904(files: &HashMap<String, Vec<u8>>) -> bool {
    part_text(files, "xl/workbook.xml").is_some_and(|x| DATE1904.is_match(&x))
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// An ISO date, date-time or time of day as an Excel serial, or `None` when the text is not one.
fn iso_to_serial(text: &str, date1904: bool) -> Option<f64> {
    if let Some(t) = ISO_TIME.captures(text) {
        let (h, m): (f64, f64) = (t[1].parse().unwrap(), t[2].parse().unwrap());
        let s: f64 = t.get(3).map_or(0.0, |s| s.as_str().parse().unwrap());
        return (h < 24.0 && m < 60.0 && s < 60.0).then(|| (h * 3600.0 + m * 60.0 + s) / 86_400.0);
    }
    let d = ISO_DATE.captures(text)?;
    let (y, mo, day): (i64, i64, i64) = (
        d[1].parse().unwrap(),
        d[2].parse().unwrap(),
        d[3].parse().unwrap(),
    );
    let h: f64 = d.get(4).map_or(0.0, |s| s.as_str().parse().unwrap());
    let mi: f64 = d.get(5).map_or(0.0, |s| s.as_str().parse().unwrap());
    let s: f64 = d.get(6).map_or(0.0, |s| s.as_str().parse().unwrap());
    // A date that does not exist (2026-02-30) is not one.
    if !(1..=12).contains(&mo)
        || day < 1
        || day > days_in_month(y, mo)
        || h >= 24.0
        || mi >= 60.0
        || s >= 60.0
    {
        return None;
    }
    let (ey, em, ed) = if date1904 {
        (1904, 1, 1)
    } else {
        (1899, 12, 30)
    };
    let days = days_from_civil(y, mo, day) - days_from_civil(ey, em, ed);
    let mut serial = days as f64 + (h * 3600.0 + mi * 60.0 + s) / 86_400.0;
    // The 1900 system counts a 29 February 1900 that never happened.
    if !date1904 && serial < 61.0 {
        serial -= 1.0;
    }
    (serial >= 0.0).then_some(serial)
}

/// The display text of every cell in a row, keyed by column letters, in first-seen order (a repeat updates in place).
fn cell_texts_of(row: &str, shared: &[String]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for m in CELL_ALL.captures_iter(row) {
        let attrs = m.get(1).map_or("", |a| a.as_str());
        let body = m.get(2).map_or("", |a| a.as_str());
        let Some(r) = CELL_REF.captures(attrs) else {
            continue;
        };
        // Anchored in the attribute list, never in the body (a shared formula's own t= must not count).
        let ty = TYPE_ATTR.captures(attrs).map(|c| c[1].to_owned());
        let text = match ty.as_deref() {
            Some("s") => {
                let index: i64 = V_TAG
                    .captures(body)
                    .and_then(|c| c[1].parse().ok())
                    .unwrap_or(-1);
                usize::try_from(index)
                    .ok()
                    .and_then(|i| shared.get(i))
                    .cloned()
                    .unwrap_or_default()
            }
            Some("inlineStr") => unescape_xml_text(
                IS_TAG
                    .captures(body)
                    .map_or("", |c| c.get(1).unwrap().as_str()),
            ),
            _ => unescape_xml_text(
                V_TAG
                    .captures(body)
                    .map_or("", |c| c.get(1).unwrap().as_str()),
            ),
        };
        let key = r[1].to_owned();
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = text,
            None => out.push((key, text)),
        }
    }
    out
}

fn read_shared_strings(files: &HashMap<String, Vec<u8>>) -> Vec<String> {
    let Some(xml) = part_text(files, "xl/sharedStrings.xml") else {
        return Vec::new();
    };
    SI.captures_iter(&xml)
        .map(|si| {
            T_PIECE
                .find_iter(&si[1])
                .map(|p| unescape_xml_text(&T_STRIP.replace_all(p.as_str(), "")))
                .collect::<String>()
        })
        .collect()
}

/// The `<c>` element for a new value, keeping the old cell's style. Strings go in as `inlineStr`; any `<f>` is dropped.
fn build_cell(r: &str, style: &str, value: &CellValue, keep_text: bool) -> String {
    let text = match value {
        CellValue::Null => return format!(r#"<c r="{r}"{style}/>"#),
        CellValue::Bool(b) => {
            return format!(r#"<c r="{r}"{style} t="b"><v>{}</v></c>"#, u8::from(*b));
        }
        CellValue::Number(n) if n.is_finite() => {
            return format!(r#"<c r="{r}"{style}><v>{}</v></c>"#, js_number_string(*n));
        }
        CellValue::BigInt(s) => return format!(r#"<c r="{r}"{style}><v>{s}</v></c>"#),
        other => other.js_string(),
    };
    if text.is_empty() {
        return format!(r#"<c r="{r}"{style}/>"#);
    }
    // A number typed into a numeric column arrives as text; written as a number so the column stays numeric.
    // Not when the cell was stored as text: "0009" must stay text.
    if !keep_text && NUMBER_TEXT.is_match(text.trim()) {
        return format!(r#"<c r="{r}"{style}><v>{}</v></c>"#, text.trim());
    }
    format!(
        r#"<c r="{r}"{style} t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
        escape_xml_text(&text)
    )
}

/// Put the new cell into `row` at `r`, replacing or inserting in column order.
fn splice_cell(row: &str, r: &str, letters: &str, value: &CellValue, keep_text: bool) -> String {
    let re = Regex::new(&format!(
        r#"<c\b[^>]*?\br="{}[0-9]+"[^>]*?(?:/>|>[\s\S]*?</c>)"#,
        regex::escape(letters)
    ))
    .unwrap();
    if let Some(m) = re.find(row) {
        // The style index links the cell to its number format, font and borders; dropping it un-dates a date.
        let style = STYLE_ATTR
            .captures(m.as_str())
            .map_or(String::new(), |c| format!(r#" s="{}""#, &c[1]));
        return format!(
            "{}{}{}",
            &row[..m.start()],
            build_cell(r, &style, value, keep_text),
            &row[m.end()..]
        );
    }
    // The cell is absent. Cells must sit in ascending column order, so insert before the first one that follows it.
    let target = column_index_of(letters);
    for m in CELL_ALL.captures_iter(row) {
        let whole = m.get(0).unwrap();
        if let Some(c) = CELL_REF.captures(m.get(1).map_or("", |a| a.as_str()))
            && column_index_of(&c[1]) > target
        {
            return format!(
                "{}{}{}",
                &row[..whole.start()],
                build_cell(r, "", value, false),
                &row[whole.start()..]
            );
        }
    }
    // Past every cell in the row, or the row is self-closing (<row r="7"/>).
    if SELF_CLOSING_ROW.is_match(row) {
        return match row.strip_suffix("/>") {
            Some(head) => format!("{head}>{}</row>", build_cell(r, "", value, false)),
            None => row.to_owned(),
        };
    }
    match ROW_TAIL.find(row) {
        Some(m) => format!(
            "{}{}</row>",
            &row[..m.start()],
            build_cell(r, "", value, false)
        ),
        None => row.to_owned(),
    }
}

fn big_int_eq(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let (neg, d) = s.strip_prefix('-').map_or((false, s), |d| (true, d));
        let d = d.trim_start_matches('0');
        (neg && !d.is_empty(), d.to_owned())
    };
    norm(a) == norm(b)
}

/// Whether the cell holds the value the grid was showing, judged by what the cell declares itself to be.
fn holds_expected_value(
    cell: &StoredCell,
    expected: &CellValue,
    date_styled: bool,
    date1904: bool,
) -> bool {
    if cell.ty.as_deref().is_some_and(|t| t != "n" && t != "b") {
        return if expected.is_nullish() {
            cell.text.is_empty()
        } else {
            cell.text == expected.js_string()
        };
    }
    let stored = cell.text.trim();
    if expected.is_nullish() {
        return stored.is_empty();
    }
    let wanted_owned = expected.js_string();
    let wanted = wanted_owned.trim();
    if stored == wanted {
        return true;
    }
    if cell.ty.as_deref() == Some("b") {
        return (if stored == "1" { "true" } else { "false" }) == wanted.to_lowercase();
    }
    if !NUMBER_TEXT.is_match(stored) {
        return false;
    }
    if NUMBER_TEXT.is_match(wanted) {
        if INTEGER_TEXT.is_match(stored) && INTEGER_TEXT.is_match(wanted) {
            return big_int_eq(stored, wanted);
        }
        return stored.parse::<f64>().ok() == wanted.parse::<f64>().ok();
    }
    if !date_styled {
        return false;
    }
    let Some(serial) = iso_to_serial(wanted, date1904) else {
        return false;
    };
    let Ok(value) = stored.parse::<f64>() else {
        return false;
    };
    // A date-only value is the day the cell falls on, whatever time it carries; otherwise to the millisecond.
    if ISO_DATE_ONLY.is_match(wanted) {
        return value.floor() == serial;
    }
    (value - serial).abs() * 86_400_000.0 < 1.0
}

fn stored_text_of(value: &CellValue, keep_text: bool) -> String {
    let text = match value {
        CellValue::Null => return String::new(),
        CellValue::Bool(b) => return u8::from(*b).to_string(),
        CellValue::Number(n) if n.is_finite() => return js_number_string(*n),
        CellValue::BigInt(s) => return s.clone(),
        other => other.js_string(),
    };
    if text.is_empty() {
        return text;
    }
    if !keep_text && NUMBER_TEXT.is_match(text.trim()) {
        text.trim().to_owned()
    } else {
        text
    }
}

/// The edit worked out in memory: the candidate package and what it must contain.
pub struct PatchPlan<'a> {
    pub bytes: Vec<u8>,
    source: &'a [u8],
    pub sheet_path: String,
    sheet_xml: String,
    intended_sheet: Vec<u8>,
    target_start: usize,
    target_end: usize,
    target_number: i64,
    target_xml: String,
    pub cell_ref: String,
    letters: String,
    shared: Vec<String>,
    expected_text: String,
    expected_style: Option<u32>,
}

/// Work out the edit against `original`. Errors rather than guessing when the sheet's shape does not support the mapping.
pub fn plan_patch<'a>(original: &'a [u8], request: &PatchRequest) -> Res<PatchPlan<'a>> {
    match &request.new_value {
        CellValue::Text(t) if t.chars().any(|c| !matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')) => {
            return err("The new value contains characters XML cannot store. The workbook was not changed.");
        }
        CellValue::BigInt(t) if !INTEGER_TEXT.is_match(t) => {
            return err("The integer value must contain decimal digits with an optional minus sign. The workbook was not changed.");
        }
        _ => {}
    }
    let sheet_path = &request.sheet_path;
    let Some(index) = zip::index_zip(original) else {
        return err(
            "The workbook archive layout is not one this writer can patch in place. The workbook was not changed.",
        );
    };
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    for name in [
        sheet_path.as_str(),
        "xl/sharedStrings.xml",
        "xl/styles.xml",
        "xl/workbook.xml",
    ] {
        if let Some(member) = zip::read_member(&index, name)? {
            files.insert(name.to_owned(), member);
        }
    }
    let Some(part) = files.get(sheet_path) else {
        return err(format!(
            "The workbook has no worksheet part at {sheet_path}."
        ));
    };
    let Ok(sheet_xml) = String::from_utf8(part.clone()) else {
        return err(format!(
            "The worksheet {sheet_path} is not valid UTF-8. The workbook was not changed."
        ));
    };
    if CELL_REF
        .captures_iter(&sheet_xml)
        .any(|c| column_index_of(&c[1]) < 0)
    {
        return err(
            "The worksheet contains an invalid column reference. The workbook was not changed.",
        );
    }
    let rows: Vec<RowBlock> = read_rows(&sheet_xml)
        .into_iter()
        .filter(|r| NON_EMPTY.is_match(&r.xml))
        .collect();
    let shared = read_shared_strings(&files);

    let (letters, target): (String, &RowBlock);
    if request.verbatim {
        if column_index_of(&request.column_name) < 0
            || !request.column_name.bytes().all(|b| b.is_ascii_uppercase())
        {
            return err(format!(
                "\"{}\" is not a column of the sheet. The cell was not changed.",
                request.column_name
            ));
        }
        letters = request.column_name.clone();
        match rows.iter().find(|r| r.number == request.row_ordinal) {
            Some(found) if request.row_ordinal >= 1 => target = found,
            _ => {
                return err(format!(
                    "Row {} holds nothing in this sheet, so there is no cell to change.",
                    request.row_ordinal
                ));
            }
        }
    } else {
        let wanted: HashSet<&String> = request.column_names.iter().collect();
        let mut header: Option<(usize, Vec<(String, String)>)> = None;
        for (i, row) in rows.iter().enumerate() {
            let cells = cell_texts_of(&row.xml, &shared);
            let texts: HashSet<&String> = cells.iter().map(|(_, v)| v).collect();
            if wanted.iter().all(|w| texts.contains(w)) {
                header = Some((i, cells));
                break;
            }
        }
        let Some((header_index, header_cells)) = header else {
            return err(
                "Could not find the header row in this sheet, so there is no way to tell which row and column the edit belongs to. The cell was not changed.",
            );
        };
        let Some((by_header, _)) = header_cells.iter().find(|(_, t)| *t == request.column_name)
        else {
            return err(format!(
                "Could not find a column headed \"{}\" in the sheet, so the edit cannot be placed. The cell was not changed.",
                request.column_name
            ));
        };
        letters = by_header.clone();
        let target_index = (header_index as i64)
            .checked_add(request.row_ordinal)
            .unwrap_or(i64::MAX);
        if request.row_ordinal < 1 || target_index >= rows.len() as i64 {
            return err(format!(
                "Row {} is past the end of this sheet ({} row(s) below the header). The cell was not changed.",
                request.row_ordinal,
                rows.len()
            ));
        }
        target = &rows[target_index as usize];
    }
    let cell_ref = format!("{letters}{}", target.number);

    // The second reading: the cell must currently hold what the grid was showing, or nothing is written.
    let cell = stored_cell_of(&target.xml, &letters, &shared);
    let date_styled = cell
        .style
        .is_some_and(|s| read_date_styles(&files).contains(&(s as usize)));
    let date1904 = uses_date1904(&files);
    if !holds_expected_value(&cell, &request.expected_current, date_styled, date1904) {
        let current = if cell.text.is_empty() {
            "(empty)".to_owned()
        } else {
            format!("\"{}\"", cell.text)
        };
        let shown = if request.expected_current.is_nullish() {
            "(empty)".to_owned()
        } else {
            format!("\"{}\"", request.expected_current.js_string())
        };
        return err(format!(
            "Cell {cell_ref} holds {current}, but the grid was showing {shown}. Refusing to overwrite a cell that is not the one you edited — reopen the file and try again. The workbook was not changed."
        ));
    }
    // Writing a value over a formula deletes the formula, and the grid shows only its last result.
    if let Some(f) = &cell.formula {
        let shown = if f.is_empty() {
            String::new()
        } else {
            format!(" (={f})")
        };
        return err(format!(
            "Cell {cell_ref} holds a formula{shown}, and editing it would replace the formula with a fixed value. The workbook was not changed."
        ));
    }
    // A date typed into a date-formatted cell is written as the serial number Excel stores dates as.
    let mut value = request.new_value.clone();
    if let (true, CellValue::Text(new)) = (date_styled, &request.new_value) {
        let typed = new.trim();
        if !typed.is_empty() {
            if let Some(serial) = iso_to_serial(typed, date1904) {
                value = CellValue::Number(serial);
            } else if !NUMBER_TEXT.is_match(typed) {
                return err(format!(
                    "Cell {cell_ref} is formatted as a date, and \"{typed}\" is not one it can store. Type it as YYYY-MM-DD, YYYY-MM-DD HH:MM:SS or HH:MM:SS. The workbook was not changed."
                ));
            }
        }
    }
    // A shared string, an inline string or a formula's text result: the cell says it holds text, and an edit keeps that.
    let stored_as_text = matches!(cell.ty.as_deref(), Some("s" | "inlineStr" | "str"));
    let patched = splice_cell(&target.xml, &cell_ref, &letters, &value, stored_as_text);
    let updated = format!(
        "{}{}{}",
        &sheet_xml[..target.start],
        patched,
        &sheet_xml[target.end..]
    );
    let intended_sheet = updated.into_bytes();
    let bytes = zip::rewrite_zip(
        &index,
        &HashMap::from([(sheet_path.clone(), intended_sheet.clone())]),
    )?;
    Ok(PatchPlan {
        bytes,
        source: original,
        sheet_path: sheet_path.clone(),
        target_start: target.start,
        target_end: target.end,
        target_number: target.number,
        target_xml: target.xml.clone(),
        sheet_xml,
        intended_sheet,
        cell_ref,
        letters,
        shared,
        expected_text: stored_text_of(&value, stored_as_text),
        expected_style: cell.style,
    })
}

fn fail<T>(why: &str) -> Res<T> {
    err(format!(
        "The edited workbook failed verification before it was saved ({why}). The workbook was not changed."
    ))
}

/// Check the staged package (as read back from disk, by the publisher) on its own terms: it parses, every member
/// other than the edited sheet is unchanged, the edited sheet decodes (CRC-checked) to the intended XML, everything
/// outside the edited row is the original XML, and the edited cell reads back as the value with its style, no
/// formula, and every other cell of the row unchanged.
pub fn verify_candidate(staged: &[u8], plan: &PatchPlan<'_>) -> Res<()> {
    if staged != plan.bytes.as_slice() {
        return fail("the staged copy on disk differs from what was written");
    }
    let Some(source_index) = zip::index_zip(plan.source) else {
        return fail("the source archive no longer parses");
    };
    let Some(index) = zip::index_zip(staged) else {
        return fail("the staged archive does not parse");
    };
    if source_index.entries.len() != index.entries.len() {
        return fail("the number of parts changed");
    }
    for (a, b) in source_index.entries.iter().zip(&index.entries) {
        if a.name != b.name {
            return fail(&format!("part {} is missing or moved", a.name));
        }
        if a.name == plan.sheet_path {
            continue;
        }
        if a.method != b.method
            || a.crc != b.crc
            || a.size != b.size
            || a.compressed_size != b.compressed_size
            || zip::stored_bytes(&source_index, a) != zip::stored_bytes(&index, b)
        {
            return fail(&format!("part {} changed", a.name));
        }
    }
    let entry: &Entry = match index.entries.iter().find(|e| e.name == plan.sheet_path) {
        Some(e) => e,
        None => return fail("the edited sheet is missing"),
    };
    let stored = zip::stored_bytes(&index, entry);
    let Some(sheet) = zip::inflate_capped(stored, entry.method, plan.intended_sheet.len().max(1))
    else {
        return fail("the edited sheet does not decode");
    };
    if sheet.len() != entry.size {
        return fail("the edited sheet does not match its declared size");
    }
    if zip::crc32(&sheet) != entry.crc {
        return fail("the edited sheet fails its CRC");
    }
    if sheet != plan.intended_sheet {
        return fail("the edited sheet is not the intended XML");
    }
    let Ok(xml) = String::from_utf8(sheet) else {
        return fail("the edited sheet is not UTF-8");
    };
    let tail = plan.sheet_xml.len() - plan.target_end;
    if xml.len() < plan.target_start + tail
        || xml[..plan.target_start] != plan.sheet_xml[..plan.target_start]
        || xml[xml.len() - tail..] != plan.sheet_xml[plan.target_end..]
    {
        return fail("content outside the edited row changed");
    }
    let row_xml = &xml[plan.target_start..xml.len() - tail];
    let rows = read_rows(row_xml);
    if rows.len() != 1 || rows[0].number != plan.target_number || rows[0].xml != row_xml {
        return fail("the edited row is malformed");
    }
    let cell = stored_cell_of(row_xml, &plan.letters, &plan.shared);
    let r = &plan.cell_ref;
    if cell.formula.is_some() {
        return fail(&format!("cell {r} still holds a formula"));
    }
    if cell.text != plan.expected_text {
        return fail(&format!("cell {r} does not read back as the new value"));
    }
    if cell.style != plan.expected_style {
        return fail(&format!("cell {r} lost its style"));
    }
    let before = cell_texts_of(&plan.target_xml, &plan.shared);
    let after = cell_texts_of(row_xml, &plan.shared);
    let find =
        |v: &[(String, String)], k: &str| v.iter().find(|(l, _)| l == k).map(|(_, t)| t.clone());
    for (letters, text) in &before {
        if *letters != plan.letters && find(&after, letters).as_ref() != Some(text) {
            return fail(&format!("cell {letters}{} changed", plan.target_number));
        }
    }
    for (letters, _) in &after {
        if *letters != plan.letters && find(&before, letters).is_none() {
            return fail(&format!("cell {letters}{} appeared", plan.target_number));
        }
    }
    Ok(())
}

pub struct Patched {
    pub bytes: Vec<u8>,
    pub cell: String,
    pub source_sha256: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Plan, then verify the plan's own bytes. The caller writes `bytes` to a sibling, reads them back and calls
/// `verify_candidate` again on what is on disk before publishing (D3.12).
pub fn patch_cell(original: &[u8], request: &PatchRequest) -> Res<Patched> {
    let source_sha256 = sha256_hex(original);
    if let Some(expected) = &request.expected_sha256
        && *expected != source_sha256
    {
        return err(
            "The workbook changed after it was read, so the cell was not changed. Refresh before editing.",
        );
    }
    let plan = plan_patch(original, request)?;
    verify_candidate(&plan.bytes, &plan)?;
    Ok(Patched {
        cell: plan.cell_ref.clone(),
        bytes: plan.bytes,
        source_sha256,
    })
}
