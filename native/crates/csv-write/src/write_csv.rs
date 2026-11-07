//! Byte-level patch of ONE field of ONE record of a CSV file.
//!
//! Decision: the TypeScript reference re-serialises the whole table through DuckDB `COPY` (its own comment calls
//! the reformatting of untouched rows a "known side effect"). Here every byte outside the edited field is copied
//! verbatim, so delimiter, quoting, line endings (including mixed ones), BOM and number spellings of all other
//! cells cannot change. The new bytes are re-parsed before they are returned; a patch that does not read back
//! as exactly the requested edit is never handed out.
//!
//! The source is borrowed; a validated splice can stream directly into D3.12 publication.
//! shortcut: dialect (delimiter/quote) and "first record is the header" are supplied by the caller; sniffing them
//! is the DuckDB reader's job (D3.6), not this crate's.

/// Field separator and quote byte. The escape of a quote inside a quoted field is a doubled quote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dialect {
    pub delimiter: u8,
    pub quote: u8,
}
impl Default for Dialect {
    fn default() -> Self {
        Self {
            delimiter: b',',
            quote: b'"',
        }
    }
}

/// The requested cell value. The caller (engine) chooses the variant from the column type it knows.
#[derive(Clone, Copy, Debug)]
pub enum NewValue<'a> {
    /// An empty, unquoted field.
    Null,
    /// Written verbatim, quoted only when the bytes require it or the old field was quoted.
    Text(&'a str),
    /// A plain decimal such as `-12`, `3.5`, `1e-9` (no grouping). `decimal_comma` writes the point as a comma
    /// for files that spell decimals the European way.
    Number { text: &'a str, decimal_comma: bool },
}

/// Which record to edit. Data rows are counted after the header; blank lines are not rows when there are
/// several columns (the reader skips them).
#[derive(Clone, Copy, Debug)]
pub enum Target<'a> {
    /// Zero-based data row. `expect` guards against a stale view: the current cell must read as this.
    Row {
        index: usize,
        expect: Option<Option<&'a str>>,
    },
    /// The row whose named cells equal these values (`None` = empty). Mirrors the TS `rowValues` identity.
    Match(&'a [(&'a str, Option<&'a str>)]),
}

#[derive(Debug, PartialEq, Eq)]
pub enum WriteError {
    /// UTF-16 byte-order mark: the reader would need an encoding option, so the bytes are not patched.
    Utf16,
    /// Not valid UTF-8 (e.g. Latin-1); patching could not keep other cells' meaning.
    NotUtf8,
    /// NUL byte somewhere in the file.
    ContainsNul,
    Empty,
    /// A quoted field is not closed, or has bytes after its closing quote.
    MalformedQuote {
        record: usize,
    },
    UnknownColumn(String),
    DuplicateColumn(String),
    /// The edit named no row (the TS "did not say which row" refusal).
    NoRowSelector,
    RowNotFound,
    /// More than one data row matches; `rows` counts them.
    Ambiguous {
        rows: usize,
    },
    /// The target record has no field at the column's position.
    RaggedRow {
        row: usize,
        fields: usize,
        column: usize,
    },
    /// `expect` did not equal the current cell.
    StaleCell,
    BadNumber(String),
    Unrepresentable(&'static str),
    /// The patched bytes did not read back as the requested edit (never returned as output).
    Verification(&'static str),
}
impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for WriteError {}

/// One record: byte range without its terminator, and the raw (still quoted) range of each field.
struct Record {
    start: usize,
    end: usize,
    fields: Vec<(usize, usize)>,
}

struct Records<'a> {
    src: &'a [u8],
    pos: usize,
    d: Dialect,
    n: usize,
}
impl<'a> Records<'a> {
    fn new(src: &'a [u8], pos: usize, d: Dialect) -> Self {
        Self { src, pos, d, n: 0 }
    }
}
impl Iterator for Records<'_> {
    type Item = Result<Record, WriteError>;
    fn next(&mut self) -> Option<Self::Item> {
        let (s, d) = (self.src, self.d);
        if self.pos >= s.len() {
            return None;
        }
        let (start, mut i, mut field_start) = (self.pos, self.pos, self.pos);
        let mut fields = Vec::new();
        let record = self.n;
        self.n += 1;
        loop {
            if i < s.len() && s[i] == d.quote && i == field_start {
                i += 1;
                loop {
                    match s.get(i) {
                        None => return Some(Err(WriteError::MalformedQuote { record })),
                        Some(&b) if b == d.quote && s.get(i + 1) == Some(&d.quote) => i += 2,
                        Some(&b) if b == d.quote => {
                            i += 1;
                            break;
                        }
                        Some(_) => i += 1,
                    }
                }
                match s.get(i) {
                    None | Some(b'\n') | Some(b'\r') => {}
                    Some(&b) if b == d.delimiter => {}
                    Some(_) => return Some(Err(WriteError::MalformedQuote { record })),
                }
            }
            match s.get(i) {
                None => {
                    fields.push((field_start, i));
                    self.pos = i;
                    return Some(Ok(Record {
                        start,
                        end: i,
                        fields,
                    }));
                }
                Some(&b) if b == d.delimiter => {
                    fields.push((field_start, i));
                    i += 1;
                    field_start = i;
                }
                Some(b'\n') | Some(b'\r') => {
                    fields.push((field_start, i));
                    self.pos = if s[i] == b'\r' && s.get(i + 1) == Some(&b'\n') {
                        i + 2
                    } else {
                        i + 1
                    };
                    return Some(Ok(Record {
                        start,
                        end: i,
                        fields,
                    }));
                }
                Some(_) => i += 1,
            }
        }
    }
}

fn decode(src: &[u8], d: Dialect, (a, b): (usize, usize)) -> String {
    // Safe: the whole file was validated as UTF-8 and field bounds sit on ASCII delimiters/quotes.
    let raw = std::str::from_utf8(&src[a..b]).unwrap_or_default();
    match raw.as_bytes().first() {
        Some(&q) if q == d.quote => {
            let q = d.quote as char;
            raw[1..raw.len() - 1].replace(&format!("{q}{q}"), &q.to_string())
        }
        _ => raw.to_owned(),
    }
}

fn is_blank(r: &Record) -> bool {
    r.start == r.end
}

fn valid_number(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let digits = |i: &mut usize| {
        let s = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i - s
    };
    let mut n = digits(&mut i);
    if b.get(i) == Some(&b'.') {
        i += 1;
        n += digits(&mut i);
    }
    if n == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// The exact bytes of the new field, and the text a reader must decode from them.
fn encode(d: Dialect, new: NewValue, was_quoted: bool) -> Result<(Vec<u8>, String), WriteError> {
    let text = match new {
        NewValue::Null => String::new(),
        NewValue::Text(t) => t.to_owned(),
        NewValue::Number {
            text,
            decimal_comma,
        } => {
            if !valid_number(text) {
                return Err(WriteError::BadNumber(text.to_owned()));
            }
            if decimal_comma {
                text.replace('.', ",")
            } else {
                text.to_owned()
            }
        }
    };
    if text.contains('\0') {
        return Err(WriteError::Unrepresentable("NUL in value"));
    }
    let special =
        |c: char| c == d.delimiter as char || c == d.quote as char || c == '\n' || c == '\r';
    let quoted = !matches!(new, NewValue::Null)
        && (was_quoted || matches!(new, NewValue::Text("")) || text.chars().any(special));
    if !quoted {
        return Ok((text.clone().into_bytes(), text));
    }
    let q = d.quote as char;
    let body = text.replace(q, &format!("{q}{q}"));
    Ok((format!("{q}{body}{q}").into_bytes(), text))
}

/// Returns `src` with exactly one field replaced. Nothing is returned unless the result reads back as requested.
pub fn plan_cell<'a>(
    src: &'a [u8],
    d: Dialect,
    column: &str,
    target: Target,
    new: NewValue,
) -> Result<Patch<'a>, WriteError> {
    if d.delimiter == d.quote
        || [d.delimiter, d.quote]
            .iter()
            .any(|b| !b.is_ascii() || matches!(b, 0 | b'\r' | b'\n'))
    {
        return Err(WriteError::Unrepresentable(
            "delimiter and quote must be distinct non-NUL ASCII bytes other than CR/LF",
        ));
    }
    if src.starts_with(&[0xFF, 0xFE]) || src.starts_with(&[0xFE, 0xFF]) {
        return Err(WriteError::Utf16);
    }
    if src.contains(&0) {
        return Err(WriteError::ContainsNul);
    }
    std::str::from_utf8(src).map_err(|_| WriteError::NotUtf8)?;
    let bom = if src.starts_with(&[0xEF, 0xBB, 0xBF]) {
        3
    } else {
        0
    };
    let mut records = Records::new(src, bom, d);
    let header = records.next().ok_or(WriteError::Empty)??;
    let names: Vec<String> = header.fields.iter().map(|&f| decode(src, d, f)).collect();
    let find = |name: &str| -> Result<usize, WriteError> {
        let mut hits = names
            .iter()
            .enumerate()
            .filter(|(_, n)| n.as_str() == name)
            .map(|(i, _)| i);
        match (hits.next(), hits.next()) {
            (Some(i), None) => Ok(i),
            (Some(_), Some(_)) => Err(WriteError::DuplicateColumn(name.to_owned())),
            _ => Err(WriteError::UnknownColumn(name.to_owned())),
        }
    };
    let col = find(column)?;
    let wanted: Vec<(usize, Option<&str>)> = match target {
        Target::Match([]) => return Err(WriteError::NoRowSelector),
        Target::Match(m) => m
            .iter()
            .map(|&(c, v)| find(c).map(|i| (i, v)))
            .collect::<Result<_, _>>()?,
        Target::Row { .. } => Vec::new(),
    };
    let empty_is_row = names.len() == 1;
    let (mut row, mut hits, mut first) = (0usize, 0usize, None);
    for rec in records {
        let rec = rec?;
        if is_blank(&rec) && !empty_is_row {
            continue;
        }
        let hit = match target {
            Target::Row { index, .. } => row == index,
            Target::Match(_) => wanted.iter().all(|&(i, v)| {
                let cell = rec.fields.get(i).map(|&f| decode(src, d, f));
                match (cell.as_deref(), v) {
                    (None | Some(""), None) => true,
                    (Some(c), Some(v)) => c == v,
                    _ => false,
                }
            }),
        };
        if hit {
            hits += 1;
            if first.is_none() {
                first = Some((row, rec));
            }
        }
        row += 1;
    }
    let (row, rec) = match hits {
        0 => return Err(WriteError::RowNotFound),
        1 => first.unwrap_or_else(|| unreachable!()),
        rows => return Err(WriteError::Ambiguous { rows }),
    };
    let &field = rec.fields.get(col).ok_or(WriteError::RaggedRow {
        row,
        fields: rec.fields.len(),
        column: col,
    })?;
    if let Target::Row {
        expect: Some(e), ..
    } = target
    {
        let cur = decode(src, d, field);
        if e.unwrap_or("") != cur {
            return Err(WriteError::StaleCell);
        }
    }
    let was_quoted = src.get(field.0) == Some(&d.quote) && field.1 > field.0;
    let (bytes, expected) = encode(d, new, was_quoted)?;
    // Validate the replacement in isolation; borrowed surrounding bytes cannot change.
    let mut probe = bytes.clone();
    probe.extend_from_slice(&[d.delimiter, b'\n']);
    let mut parsed = Records::new(&probe, 0, d);
    let record = parsed
        .next()
        .ok_or(WriteError::Verification("missing field"))??;
    if record.fields.len() != 2
        || decode(&probe, d, record.fields[0]) != expected
        || !decode(&probe, d, record.fields[1]).is_empty()
        || parsed.next().is_some()
    {
        return Err(WriteError::Verification(
            "edited field differs from the request",
        ));
    }
    // An empty last record without a terminator would disappear from the table.
    if bytes.is_empty() && rec.fields.len() == 1 && rec.end == src.len() {
        return Err(WriteError::Verification("record count changed"));
    }
    Ok(Patch {
        prefix: &src[..field.0],
        replacement: bytes,
        suffix: &src[field.1..],
    })
}

/// Validated field splice. The source remains borrowed and only the replacement is allocated.
pub struct Patch<'a> {
    prefix: &'a [u8],
    replacement: Vec<u8>,
    suffix: &'a [u8],
}
impl Patch<'_> {
    pub fn len(&self) -> usize {
        self.prefix.len() + self.replacement.len() + self.suffix.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn reader(&self) -> impl std::io::Read + '_ {
        use std::io::Read;
        self.prefix
            .chain(self.replacement.as_slice())
            .chain(self.suffix)
    }
}

/// Compatibility helper for callers that need owned bytes; large saves can use `plan_cell`.
pub fn update_cell(
    src: &[u8],
    d: Dialect,
    column: &str,
    target: Target,
    new: NewValue,
) -> Result<Vec<u8>, WriteError> {
    let patch = plan_cell(src, d, column, target, new)?;
    let mut out = Vec::with_capacity(patch.len());
    out.extend_from_slice(patch.prefix);
    out.extend_from_slice(&patch.replacement);
    out.extend_from_slice(patch.suffix);
    Ok(out)
}
