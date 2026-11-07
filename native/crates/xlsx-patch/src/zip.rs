//! Port of `src/zipPatch.ts`: single-disk ZIP without ZIP64/encryption, stored or deflate only.
//! Anything else is `None` from `index_zip` and the caller refuses (the TS falls back to fflate; see evidence).
use flate2::{Compression, read::DeflateDecoder, write::DeflateEncoder};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{Read, Write};

const EOCD: u32 = 0x0605_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;
/// shortcut: one fixed ceiling for any inflated member, make it a request limit when D3.2 budgets exist.
pub const MAX_MEMBER_BYTES: u64 = 1 << 30;

#[derive(Debug)]
pub struct ZipError(pub String);
impl fmt::Display for ZipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ZipError {}

#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    /// Offset of this entry's central-directory record.
    pub central: usize,
    pub central_length: usize,
    pub flags: u16,
    pub method: u16,
    pub crc: u32,
    pub compressed_size: usize,
    pub size: usize,
    pub local_offset: usize,
}

pub struct ZipIndex<'a> {
    pub bytes: &'a [u8],
    pub entries: Vec<Entry>,
    /// End-of-central-directory comment, preserved on rewrite.
    pub comment: &'a [u8],
}

pub struct Local<'a> {
    pub header: usize,
    pub data: usize,
    pub extra: &'a [u8],
}

fn u16at(b: &[u8], i: usize) -> Option<u16> {
    b.get(i..i.checked_add(2)?)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32at(b: &[u8], i: usize) -> Option<u32> {
    b.get(i..i.checked_add(4)?)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// Where an entry's local header starts and its data begins, validated against the central record.
pub fn local_data<'a>(bytes: &'a [u8], entry: &Entry) -> Option<Local<'a>> {
    let header = entry.local_offset;
    if u32at(bytes, header)? != LOCAL {
        return None;
    }
    let name_length = usize::from(u16at(bytes, header + 26)?);
    let extra_length = usize::from(u16at(bytes, header + 28)?);
    let data = header + 30 + name_length + extra_length;
    if data + entry.compressed_size > bytes.len() {
        return None;
    }
    Some(Local {
        header,
        data,
        extra: &bytes[header + 30 + name_length..data],
    })
}

/// Parse the central directory, or `None` if the archive is outside this module's scope.
pub fn index_zip(bytes: &[u8]) -> Option<ZipIndex<'_>> {
    let len = bytes.len();
    if len < 22 {
        return None;
    }
    let min = len.saturating_sub(0xffff + 22);
    let mut eocd = None;
    let mut i = len - 22;
    loop {
        if u32at(bytes, i) == Some(EOCD) {
            eocd = Some(i);
            break;
        }
        if i == min {
            break;
        }
        i -= 1;
    }
    let eocd = eocd?;
    let disk = u16at(bytes, eocd + 4)?;
    let cd_disk = u16at(bytes, eocd + 6)?;
    let count_here = u16at(bytes, eocd + 8)?;
    let count = u16at(bytes, eocd + 10)?;
    let cd_size = u32at(bytes, eocd + 12)? as usize;
    let cd_offset = u32at(bytes, eocd + 16)? as usize;
    let comment_length = usize::from(u16at(bytes, eocd + 20)?);
    if disk != 0
        || cd_disk != 0
        || count_here != count
        || count == 0xffff
        || cd_offset == 0xffff_ffff
        || cd_size == 0xffff_ffff
        || cd_offset + cd_size > eocd
        || eocd + 22 + comment_length > len
    {
        return None;
    }
    let mut entries: Vec<Entry> = Vec::with_capacity(usize::from(count));
    let mut names = HashSet::new();
    let mut at = cd_offset;
    for _ in 0..count {
        if at + 46 > eocd || u32at(bytes, at)? != CENTRAL {
            return None;
        }
        let flags = u16at(bytes, at + 8)?;
        let method = u16at(bytes, at + 10)?;
        let compressed_size = u32at(bytes, at + 20)?;
        let size = u32at(bytes, at + 24)?;
        let name_length = usize::from(u16at(bytes, at + 28)?);
        let extra_length = usize::from(u16at(bytes, at + 30)?);
        let entry_comment = usize::from(u16at(bytes, at + 32)?);
        let local_offset = u32at(bytes, at + 42)?;
        let central_length = 46 + name_length + extra_length + entry_comment;
        if flags & 0x2041 != 0
            || u16at(bytes, at + 34)? != 0
            || (method != 0 && method != 8)
            || compressed_size == 0xffff_ffff
            || size == 0xffff_ffff
            || local_offset == 0xffff_ffff
            || at + central_length > eocd
        {
            return None;
        }
        let raw = &bytes[at + 46..at + 46 + name_length];
        let name = if flags & 0x0800 != 0 {
            String::from_utf8_lossy(raw).into_owned()
        } else {
            raw.iter().map(|&b| b as char).collect()
        };
        if !names.insert(name.clone()) {
            return None;
        }
        entries.push(Entry {
            name,
            central: at,
            central_length,
            flags,
            method,
            crc: u32at(bytes, at + 16)?,
            compressed_size: compressed_size as usize,
            size: size as usize,
            local_offset: local_offset as usize,
        });
        at += central_length;
    }
    if at != cd_offset + cd_size || at != eocd {
        return None;
    }
    let mut order: Vec<&Entry> = entries.iter().collect();
    order.sort_by_key(|e| e.local_offset);
    let mut end = 0usize;
    for entry in order {
        let local = local_data(bytes, entry)?;
        if local.header != end {
            return None;
        }
        let local_compressed = u32at(bytes, local.header + 18)?;
        let local_size = u32at(bytes, local.header + 22)?;
        let local_name_length = usize::from(u16at(bytes, local.header + 26)?);
        let central_name_length = usize::from(u16at(bytes, entry.central + 28)?);
        if local_compressed == 0xffff_ffff
            || local_size == 0xffff_ffff
            || u16at(bytes, local.header + 6)? != entry.flags
            || u16at(bytes, local.header + 8)? != entry.method
            || local_name_length != central_name_length
            || bytes.get(local.header + 30..local.header + 30 + local_name_length)?
                != bytes.get(entry.central + 46..entry.central + 46 + central_name_length)?
        {
            return None;
        }
        // ZIP64 extras can be present even when the central sizes fit in 32 bits; this rewriter does not update them.
        let central_extra_at = entry.central + 46 + central_name_length;
        let central_extra = bytes.get(
            central_extra_at..central_extra_at + usize::from(u16at(bytes, entry.central + 30)?),
        )?;
        for extra in [local.extra, central_extra] {
            let mut pos = 0usize;
            while pos < extra.len() {
                if pos + 4 > extra.len() {
                    return None;
                }
                let id = u16at(extra, pos)?;
                let length = usize::from(u16at(extra, pos + 2)?);
                if id == 1 || pos + 4 + length > extra.len() {
                    return None;
                }
                pos += 4 + length;
            }
        }
        end = local.data + entry.compressed_size;
        if entry.flags & 8 != 0 {
            let signed = end + 4 <= cd_offset && u32at(bytes, end) == Some(0x0807_4b50);
            let descriptor = end + if signed { 4 } else { 0 };
            if descriptor + 12 > cd_offset
                || u32at(bytes, descriptor)? != entry.crc
                || u32at(bytes, descriptor + 4)? as usize != entry.compressed_size
                || u32at(bytes, descriptor + 8)? as usize != entry.size
            {
                return None;
            }
            end = descriptor + 12;
        } else if local_compressed as usize != entry.compressed_size
            || local_size as usize != entry.size
            || u32at(bytes, local.header + 14)? != entry.crc
        {
            return None;
        }
    }
    if end != cd_offset {
        return None;
    }
    Some(ZipIndex {
        bytes,
        entries,
        comment: &bytes[eocd + 22..eocd + 22 + comment_length],
    })
}

/// Inflate `raw` to exactly `size` bytes or fail; never produces more than `size + 1` bytes.
fn inflate_exact(raw: &[u8], method: u16, size: usize, name: &str) -> Result<Vec<u8>, ZipError> {
    let mismatch = || {
        ZipError(format!(
            "Workbook member {name} does not match its declared size."
        ))
    };
    if size as u64 > MAX_MEMBER_BYTES {
        return Err(ZipError(format!(
            "Workbook member {name} is larger than the {MAX_MEMBER_BYTES}-byte limit."
        )));
    }
    let mut out = Vec::with_capacity(size.min(16 << 20));
    if method == 0 {
        out.extend_from_slice(raw);
    } else {
        DeflateDecoder::new(raw)
            .take(size as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|e| ZipError(format!("Workbook member {name} could not be decoded: {e}.")))?;
    }
    if out.len() != size {
        return Err(mismatch());
    }
    Ok(out)
}

/// Inflate one member; `Ok(None)` when absent. Fails if it does not decode to its declared size.
pub fn read_member(index: &ZipIndex<'_>, name: &str) -> Result<Option<Vec<u8>>, ZipError> {
    let Some(entry) = index.entries.iter().find(|e| e.name == name) else {
        return Ok(None);
    };
    let local = local_data(index.bytes, entry)
        .ok_or_else(|| ZipError(format!("Workbook member {name} has a damaged header.")))?;
    inflate_exact(
        &index.bytes[local.data..local.data + entry.compressed_size],
        entry.method,
        entry.size,
        name,
    )
    .map(Some)
}

/// A member's stored (compressed) bytes, from its local header.
pub fn stored_bytes<'a>(index: &ZipIndex<'a>, entry: &Entry) -> &'a [u8] {
    let b = index.bytes;
    let header = entry.local_offset;
    let data = header
        + 30
        + usize::from(u16at(b, header + 26).unwrap_or(0))
        + usize::from(u16at(b, header + 28).unwrap_or(0));
    &b[data..data + entry.compressed_size]
}

/// Inflate stored member bytes with an output cap; `None` when it does not decode within the cap.
pub fn inflate_capped(raw: &[u8], method: u16, cap: usize) -> Option<Vec<u8>> {
    if method == 0 {
        return Some(raw.to_vec());
    }
    let mut out = Vec::new();
    DeflateDecoder::new(raw)
        .take(cap as u64 + 1)
        .read_to_end(&mut out)
        .ok()?;
    (out.len() <= cap).then_some(out)
}

pub fn crc32(data: &[u8]) -> u32 {
    crc32fast::hash(data)
}

/// A new archive: same members in central-directory order, `replacements` deflated afresh, everything else
/// copied compressed. Local headers are rebuilt from the central records (sizes in the header, no data descriptor),
/// keeping each member's own name bytes, extra fields, timestamps and comment.
pub fn rewrite_zip(
    index: &ZipIndex<'_>,
    replacements: &HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>, ZipError> {
    let bytes = index.bytes;
    let too_large = || ZipError("Workbook is too large to rewrite without ZIP64.".into());
    let broken = || ZipError("The workbook archive changed while it was being rewritten.".into());
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut centrals: Vec<Vec<u8>> = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let local = local_data(bytes, entry).ok_or_else(broken)?;
        let (data, method, crc, size): (std::borrow::Cow<[u8]>, u16, u32, usize) =
            match replacements.get(&entry.name) {
                Some(replacement) => {
                    let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(6));
                    enc.write_all(replacement).map_err(|_| broken())?;
                    (
                        enc.finish().map_err(|_| broken())?.into(),
                        8,
                        crc32(replacement),
                        replacement.len(),
                    )
                }
                None => (
                    bytes[local.data..local.data + entry.compressed_size].into(),
                    entry.method,
                    entry.crc,
                    entry.size,
                ),
            };
        let name_length = usize::from(u16at(bytes, entry.central + 28).ok_or_else(broken)?);
        let name_bytes = &bytes[entry.central + 46..entry.central + 46 + name_length];
        let flags = entry.flags & !0x0008;
        let offset = out.len();
        if offset > 0xffff_fffe || data.len() > 0xffff_fffe || size > 0xffff_fffe {
            return Err(too_large());
        }
        let mut header = [0u8; 30];
        header[0..4].copy_from_slice(&LOCAL.to_le_bytes());
        header[4..6].copy_from_slice(&bytes[local.header + 4..local.header + 6]); // version needed, as the file had it
        header[6..8].copy_from_slice(&flags.to_le_bytes());
        header[8..10].copy_from_slice(&method.to_le_bytes());
        header[10..12].copy_from_slice(&bytes[entry.central + 12..entry.central + 14]); // time
        header[12..14].copy_from_slice(&bytes[entry.central + 14..entry.central + 16]); // date
        header[14..18].copy_from_slice(&crc.to_le_bytes());
        header[18..22].copy_from_slice(&(data.len() as u32).to_le_bytes());
        header[22..26].copy_from_slice(&(size as u32).to_le_bytes());
        header[26..28].copy_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        header[28..30].copy_from_slice(&(local.extra.len() as u16).to_le_bytes());
        let mut central = bytes[entry.central..entry.central + entry.central_length].to_vec();
        central[8..10].copy_from_slice(&flags.to_le_bytes());
        central[10..12].copy_from_slice(&method.to_le_bytes());
        central[16..20].copy_from_slice(&crc.to_le_bytes());
        central[20..24].copy_from_slice(&(data.len() as u32).to_le_bytes());
        central[24..28].copy_from_slice(&(size as u32).to_le_bytes());
        central[42..46].copy_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(local.extra);
        out.extend_from_slice(&data);
        centrals.push(central);
    }
    let cd_offset = out.len();
    let cd_size: usize = centrals.iter().map(Vec::len).sum();
    for c in &centrals {
        out.extend_from_slice(c);
    }
    let mut eocd = [0u8; 22];
    eocd[0..4].copy_from_slice(&EOCD.to_le_bytes());
    eocd[8..10].copy_from_slice(&(index.entries.len() as u16).to_le_bytes());
    eocd[10..12].copy_from_slice(&(index.entries.len() as u16).to_le_bytes());
    eocd[12..16].copy_from_slice(&(cd_size as u32).to_le_bytes());
    eocd[16..20].copy_from_slice(&(cd_offset as u32).to_le_bytes());
    eocd[20..22].copy_from_slice(&(index.comment.len() as u16).to_le_bytes());
    out.extend_from_slice(&eocd);
    out.extend_from_slice(index.comment);
    Ok(out)
}
