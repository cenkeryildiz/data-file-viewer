//! Workbook preflight: ports `src/xlsxBudget.ts`. Judges the archive before any part is parsed.
//!
//! Unlike the TypeScript, which has a fast path and a local-header streaming fallback, this
//! walks the central directory (sizes from there are never trusted: inflation is counted) and
//! then proves the physical layout has no member the directory does not list.
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use zip::ZipArchive;

/// A typed refusal. `code` is stable; `message` mirrors the TypeScript wording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

impl Refusal {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub compressed_bytes: u64,
    pub inflated_bytes: u64,
    pub part_bytes: u64,
    pub entries: u64,
    pub cells_per_sheet: u64,
}

pub const WORKBOOK_LIMITS: Limits = Limits {
    compressed_bytes: 256 * 1024 * 1024,
    inflated_bytes: 512 * 1024 * 1024,
    part_bytes: 256 * 1024 * 1024,
    entries: 10_000,
    cells_per_sheet: 10_000_000,
};

/// Tighter limits only: a value outside `1..=default` is `invalid_budget`, as in the TypeScript.
#[derive(Debug, Default, Clone, Copy)]
pub struct Tighter {
    pub compressed_bytes: Option<u64>,
    pub inflated_bytes: Option<u64>,
    pub part_bytes: Option<u64>,
    pub entries: Option<u64>,
    pub cells_per_sheet: Option<u64>,
}

impl Limits {
    pub fn tighter(t: Tighter) -> Result<Limits, Refusal> {
        let d = WORKBOOK_LIMITS;
        let pick = |want: Option<u64>, max: u64| match want {
            None => Ok(max),
            Some(v) if (1..=max).contains(&v) => Ok(v),
            Some(_) => Err(Refusal::new("invalid_budget", "Invalid workbook budget.")),
        };
        Ok(Limits {
            compressed_bytes: pick(t.compressed_bytes, d.compressed_bytes)?,
            inflated_bytes: pick(t.inflated_bytes, d.inflated_bytes)?,
            part_bytes: pick(t.part_bytes, d.part_bytes)?,
            entries: pick(t.entries, d.entries)?,
            cells_per_sheet: pick(t.cells_per_sheet, d.cells_per_sheet)?,
        })
    }
}

fn unsafe_name(raw: &str, names: &mut std::collections::HashSet<String>) -> bool {
    let name = raw.replace('\\', "/");
    let drive = name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && name.as_bytes().get(1) == Some(&b':');
    if names.contains(&name)
        || name.starts_with('/')
        || drive
        || name.contains('\0')
        || name.split('/').any(|p| p == "..")
    {
        return true;
    }
    names.insert(name);
    false
}

/// The entity-declaration test, per chunk with a carried tail. NUL bytes are dropped first so
/// UTF-16 workbooks are judged too. Matches `<!` + optional spaces + DOCTYPE|ENTITY, any case.
pub struct EntityScanner {
    tail: Vec<u8>,
    active: bool,
}

impl EntityScanner {
    pub fn new(name: &str) -> Self {
        let lower = name.to_ascii_lowercase();
        Self {
            tail: Vec::new(),
            active: lower.ends_with(".xml") || lower.ends_with(".rels"),
        }
    }

    pub fn finds(&mut self, data: &[u8]) -> bool {
        if !self.active {
            return false;
        }
        let mut text = std::mem::take(&mut self.tail);
        text.extend(data.iter().copied().filter(|b| *b != 0));
        let hit = text.windows(2).enumerate().any(|(i, w)| {
            if w != b"<!" {
                return false;
            }
            let rest = &text[i + 2..];
            let rest = &rest[rest.iter().take_while(|b| b.is_ascii_whitespace()).count()..];
            let word = |w: &[u8]| {
                rest.len() >= w.len()
                    && rest[..w.len()].eq_ignore_ascii_case(w)
                    && rest
                        .get(w.len())
                        .is_none_or(|b| !(b.is_ascii_alphanumeric() || *b == b'_'))
            };
            word(b"DOCTYPE") || word(b"ENTITY")
        });
        // A keyword may end exactly at the chunk end; the tail carries it into the next chunk.
        let keep = text.len().saturating_sub(64);
        self.tail = text[keep..].to_vec();
        hit
    }
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Offset of the central directory, from the end-of-central-directory record.
fn central_directory_start(bytes: &[u8]) -> Option<usize> {
    let min = bytes.len().saturating_sub(0xffff + 22);
    (min..=bytes.len().checked_sub(22)?)
        .rev()
        .find(|&i| u32_at(bytes, i) == Some(0x0605_4b50))
        .and_then(|i| u32_at(bytes, i + 16))
        .map(|v| v as usize)
}

fn incomplete() -> Refusal {
    Refusal::new("archive_incomplete", "Workbook archive is incomplete.")
}

/// Judge `bytes` as a workbook package; returns its SHA-256 (hex) on success.
pub fn preflight_bytes(bytes: &[u8], limits: &Limits) -> Result<String, Refusal> {
    if bytes.len() as u64 > limits.compressed_bytes {
        return Err(Refusal::new(
            "compressed_size",
            "Workbook exceeds the compressed-size limit.",
        ));
    }
    let sha = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| match e {
        zip::result::ZipError::UnsupportedArchive(_) => Refusal::new(
            "unsupported_encoding",
            "Workbook archive uses an unsupported encoding.",
        ),
        _ => incomplete(),
    })?;
    let count = archive.len() as u64;
    if count > limits.entries {
        return Err(Refusal::new(
            "archive_limit",
            "Workbook exceeds the archive-entry or part-size limit.",
        ));
    }
    let cd_start = central_directory_start(bytes).ok_or_else(incomplete)?;
    let mut names = std::collections::HashSet::new();
    let mut total = 0u64;
    // (local header offset, end of this member's bytes, whether a data descriptor may follow)
    let mut layout: Vec<(usize, usize, bool)> = Vec::with_capacity(count as usize);

    for i in 0..archive.len() {
        let (name, header, data_start, compressed, declared) = {
            let raw = archive.by_index_raw(i).map_err(|_| {
                Refusal::new("undecodable", "Workbook archive could not be decoded.")
            })?;
            if raw.encrypted() {
                return Err(Refusal::new(
                    "unsupported_encoding",
                    "Workbook archive uses an unsupported encoding.",
                ));
            }
            (
                raw.name().to_owned(),
                raw.header_start() as usize,
                raw.data_start() as usize,
                raw.compressed_size() as usize,
                raw.size(),
            )
        };
        if unsafe_name(&name, &mut names) {
            return Err(Refusal::new(
                "archive_path",
                "Workbook contains an unsafe or duplicate archive path.",
            ));
        }
        if declared > limits.part_bytes {
            return Err(Refusal::new(
                "archive_limit",
                "Workbook exceeds the archive-entry or part-size limit.",
            ));
        }
        // The local header is what a streaming reader sees; it must agree with the directory.
        if u32_at(bytes, header) != Some(0x0403_4b50) {
            return Err(incomplete());
        }
        let local_flags = u16_at(bytes, header + 6).ok_or_else(incomplete)?;
        let local_method = u16_at(bytes, header + 8).ok_or_else(incomplete)?;
        let name_len = u16_at(bytes, header + 26).ok_or_else(incomplete)? as usize;
        let local_name = bytes
            .get(header + 30..header + 30 + name_len)
            .ok_or_else(incomplete)?;
        let local_name = String::from_utf8_lossy(local_name).into_owned();
        if local_name != name {
            let mut scratch = std::collections::HashSet::new();
            if unsafe_name(&local_name, &mut scratch) {
                return Err(Refusal::new(
                    "archive_path",
                    "Workbook contains an unsafe or duplicate archive path.",
                ));
            }
            return Err(Refusal::new(
                "archive_header",
                "Workbook archive local header disagrees with its central record.",
            ));
        }
        let central_method = {
            let raw = archive.by_index_raw(i).map_err(|_| incomplete())?;
            match raw.compression() {
                zip::CompressionMethod::Stored => 0u16,
                zip::CompressionMethod::Deflated => 8u16,
                _ => {
                    return Err(Refusal::new(
                        "unsupported_encoding",
                        "Workbook archive uses an unsupported encoding.",
                    ));
                }
            }
        };
        if local_method != central_method {
            return Err(Refusal::new(
                "archive_header",
                "Workbook archive local header disagrees with its central record.",
            ));
        }
        layout.push((header, data_start + compressed, local_flags & 0x8 != 0));

        // Count real inflation; the sizes the directory declares are not trusted.
        let mut file = archive
            .by_index(i)
            .map_err(|_| Refusal::new("undecodable", "Workbook archive could not be decoded."))?;
        let mut scan = EntityScanner::new(&name);
        let mut part = 0u64;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|_| {
                Refusal::new("undecodable", "Workbook archive could not be decoded.")
            })?;
            if n == 0 {
                break;
            }
            total += n as u64;
            part += n as u64;
            if total > limits.inflated_bytes || part > limits.part_bytes {
                return Err(Refusal::new(
                    "decompression",
                    "Workbook exceeds its decompression budget.",
                ));
            }
            if scan.finds(&buf[..n]) {
                return Err(Refusal::new(
                    "entity",
                    "Workbook XML entity declarations are unsupported.",
                ));
            }
        }
    }

    // Physical layout: members must tile the file up to the central directory, so no local
    // member can hide outside the directory (the TypeScript streaming path catches that case).
    layout.sort_by_key(|l| l.0);
    let mut expected = 0usize;
    let mut slack = 0usize;
    let outside = || {
        Refusal::new(
            "archive_layout",
            "Workbook archive has data outside its central directory.",
        )
    };
    for (header, end, descriptor) in &layout {
        // A data descriptor (optional signature, crc, two sizes, 4 or 8 bytes each) may follow.
        if *header < expected || *header - expected > slack {
            return Err(outside());
        }
        expected = *end;
        slack = if *descriptor { 24 } else { 0 };
    }
    if cd_start < expected || cd_start - expected > slack {
        return Err(outside());
    }
    Ok(sha)
}

/// Read `path` and judge it; returns the bytes judged (so the caller parses the same bytes) and
/// their SHA-256.
pub fn preflight_file(
    path: &std::path::Path,
    limits: &Limits,
) -> Result<(Vec<u8>, String), Refusal> {
    let size = std::fs::metadata(path)
        .map_err(|e| Refusal::new("unreadable", format!("Workbook could not be read: {e}")))?
        .len();
    if size > limits.compressed_bytes {
        return Err(Refusal::new(
            "compressed_size",
            "Workbook exceeds the compressed-size limit.",
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|e| Refusal::new("unreadable", format!("Workbook could not be read: {e}")))?;
    let sha = preflight_bytes(&bytes, limits)?;
    Ok((bytes, sha))
}
