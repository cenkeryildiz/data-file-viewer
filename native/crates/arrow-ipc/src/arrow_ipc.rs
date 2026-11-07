//! Validated Arrow IPC reads: stream and file (Feather V2) containers, with every message checked against
//! `Limits` before arrow-rs decodes (and so allocates for) it. The file's own schema stays untouched in
//! `original_schema`; `display_schema` is the adaptation a query layer can consume (string views and
//! string dictionaries become plain strings), so a writer can still round-trip the original.
use arrow_array::{Array, ArrayRef, RecordBatch, cast::AsArray};
use arrow_cast::{cast, display::ArrayFormatter};
use arrow_ipc::{
    BodyCompressionMethod, CompressionType, MessageHeader, MetadataVersion,
    convert::fb_to_schema,
    reader::{FileReader, StreamReader},
    root_as_footer, root_as_message,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

const FILE_MAGIC: &[u8; 6] = b"ARROW1";
const CONTINUATION: [u8; 4] = [0xff; 4];

#[derive(Debug, Clone)]
pub struct Limits {
    /// Largest private source snapshot. Checked before any source bytes are copied.
    pub max_file_bytes: u64,
    /// Bounds checked on FlatBuffer fields before recursive Arrow schema conversion.
    pub max_schema_depth: usize,
    pub max_schema_fields: usize,
    /// Largest encoded message body (compressed size on disk) accepted.
    pub max_body_bytes: u64,
    /// Largest decoded size of one message, from the codec's own length prefixes.
    pub max_decoded_bytes: u64,
    /// Largest flatbuffer metadata accepted.
    pub max_metadata_bytes: u32,
    pub max_messages: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: 256 << 20,
            max_schema_depth: 32,
            max_schema_fields: 8192,
            max_body_bytes: 256 << 20,
            max_decoded_bytes: 1 << 30,
            max_metadata_bytes: 16 << 20,
            max_messages: 1 << 20,
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    /// Too short, wrong magic, or not Arrow at all.
    NotArrow(String),
    /// Feather V1 (`FEA1`): a different format, never parsed as Arrow.
    FeatherV1,
    /// A stream without its end-of-stream marker, or a file without its footer.
    Truncated(String),
    /// A limit in `Limits` was exceeded; nothing was decoded.
    TooLarge(String),
    Malformed(String),
    Unsupported(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::FeatherV1 => f.write_str("This is a Feather V1 file, which is not Arrow IPC and is not supported. Re-write it as Feather V2 (pyarrow write_feather(version=2), polars write_ipc) or an Arrow IPC stream."),
            Self::NotArrow(m) | Self::Truncated(m) | Self::TooLarge(m) | Self::Malformed(m) | Self::Unsupported(m) => f.write_str(m),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
fn checked_schema(schema: arrow_ipc::Schema<'_>, limits: &Limits) -> Result<Schema, Error> {
    let oversized = || Error::TooLarge("The Arrow schema exceeds its depth or field limit.".into());
    let fields = schema.fields();
    if fields
        .as_ref()
        .is_some_and(|fields| fields.len() > limits.max_schema_fields)
    {
        return Err(oversized());
    }
    let mut pending = fields
        .into_iter()
        .flatten()
        .map(|field| (field, 0usize))
        .collect::<Vec<_>>();
    let mut seen = 0usize;
    while let Some((field, depth)) = pending.pop() {
        seen += 1;
        if depth > limits.max_schema_depth {
            return Err(oversized());
        }
        if let Some(children) = field.children() {
            if children.len()
                > limits
                    .max_schema_fields
                    .saturating_sub(seen + pending.len())
            {
                return Err(oversized());
            }
            pending.extend(children.iter().map(|child| (child, depth + 1)));
        }
    }
    Ok(fb_to_schema(schema))
}

fn malformed(e: impl std::fmt::Display) -> Error {
    Error::Malformed(e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Stream,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    Lz4Frame,
    Zstd,
}

#[derive(Debug)]
pub struct Source {
    // Decode only the private bytes scanned below; source metadata cannot prove byte identity.
    snapshot: tempfile::NamedTempFile,
    pub container: Container,
    pub original_schema: SchemaRef,
    pub display_schema: SchemaRef,
    pub record_batches: usize,
    pub rows: u64,
    pub codecs: Vec<Codec>,
    /// Message-level metadata is readable but cannot currently be rewritten without loss.
    pub has_message_metadata: bool,
}

/// arrow-rs asserts (panics) on some buffer/length disagreements a hostile file can produce; those
/// become a typed error here rather than taking the worker down.
fn guarded<T>(f: impl FnOnce() -> Result<T, Error>) -> Result<T, Error> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| {
        Err(Error::Malformed(
            "The file's buffers disagree with its schema or row counts.".into(),
        ))
    })
}

struct Guarded(Box<dyn Iterator<Item = Result<RecordBatch, Error>>>, bool);
impl Iterator for Guarded {
    type Item = Result<RecordBatch, Error>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.1 {
            return None;
        }
        let item = guarded(|| self.0.next().transpose()).transpose();
        // After an error the reader's position is meaningless; end instead of guessing.
        self.1 = !matches!(item, Some(Ok(_)));
        item
    }
}

/// Snapshots and validates the whole container (structure, end marker, limits).
/// Uses one source-sized temporary file, removed when the source is dropped; decoding stays streaming.
pub fn open(path: &Path, limits: &Limits) -> Result<Source, Error> {
    guarded(|| open_unguarded(path, limits))
}

fn open_unguarded(path: &Path, limits: &Limits) -> Result<Source, Error> {
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    let (size, stamp) = (meta.len(), (meta.len(), meta.modified().ok()));
    if size > limits.max_file_bytes {
        return Err(Error::TooLarge(
            "The source exceeds the private snapshot size limit.".into(),
        ));
    }
    if size < FILE_MAGIC.len() as u64 + 2 {
        return Err(Error::NotArrow(format!(
            "The file is too small to be an Arrow IPC file or stream ({size} bytes); it looks truncated or empty."
        )));
    }
    let mut head = [0u8; 6];
    file.read_exact(&mut head)?;
    if &head != FILE_MAGIC && head[..4] != CONTINUATION {
        return Err(if head[..4] == *b"FEA1" {
            Error::FeatherV1
        } else {
            Error::NotArrow("The file does not start with an Arrow IPC marker (ARROW1 or a stream continuation); it is a different format or is damaged.".into())
        });
    }
    file.seek(SeekFrom::Start(0))?;
    let mut snapshot = tempfile::NamedTempFile::new()?;
    let copied = std::io::copy(
        &mut (&mut file).take(size.saturating_add(1)),
        snapshot.as_file_mut(),
    )?;
    let after = file.metadata()?;
    if copied != size || (after.len(), after.modified().ok()) != stamp {
        return Err(Error::Malformed(
            "The file changed while it was being opened; open it again.".into(),
        ));
    }
    let mut file = snapshot.reopen()?;
    let mut scan = Scan::default();
    let (container, schema) = if &head == FILE_MAGIC {
        (
            Container::File,
            scan_file(&mut file, size, limits, &mut scan)?,
        )
    } else if head[..4] == CONTINUATION {
        file.seek(SeekFrom::Start(0))?;
        (
            Container::Stream,
            scan_stream(&mut BufReader::new(file), limits, &mut scan)?,
        )
    } else {
        return Err(Error::NotArrow("The file does not start with an Arrow IPC marker (ARROW1 or a stream continuation); it is a different format or is damaged.".into()));
    };
    let display_schema = Arc::new(display_schema(&schema));
    let mut codecs = Vec::new();
    for c in scan.codecs {
        if !codecs.contains(&c) {
            codecs.push(c);
        }
    }
    Ok(Source {
        snapshot,
        container,
        original_schema: Arc::new(schema),
        display_schema,
        record_batches: scan.batches,
        rows: scan.rows,
        codecs,
        has_message_metadata: scan.has_message_metadata,
    })
}

impl Source {
    /// File-footer metadata from the same validated generation as the batches.
    pub fn custom_metadata(&self) -> Result<HashMap<String, String>, Error> {
        if self.container == Container::Stream {
            return Ok(HashMap::new());
        }
        guarded(|| {
            Ok(FileReader::try_new(self.snapshot.reopen()?, None)
                .map_err(malformed)?
                .custom_metadata()
                .clone())
        })
    }

    /// Record batches exactly as stored (original types, dictionaries resolved across batches by arrow-rs).
    pub fn batches(&self) -> Result<Box<dyn Iterator<Item = Result<RecordBatch, Error>>>, Error> {
        let file = self.snapshot.reopen()?;
        let inner: Box<dyn Iterator<Item = Result<RecordBatch, Error>>> = match self.container {
            Container::File => Box::new(
                guarded(|| FileReader::try_new(file, None).map_err(malformed))?
                    .map(|b| b.map_err(malformed)),
            ),
            Container::Stream => Box::new(
                guarded(|| StreamReader::try_new(BufReader::new(file), None).map_err(malformed))?
                    .map(|b| b.map_err(malformed)),
            ),
        };
        Ok(Box::new(Guarded(inner, false)))
    }
    /// A batch adapted to `display_schema`.
    pub fn display_batch(&self, batch: &RecordBatch) -> Result<RecordBatch, Error> {
        guarded(|| self.display_batch_unguarded(batch))
    }
    fn display_batch_unguarded(&self, batch: &RecordBatch) -> Result<RecordBatch, Error> {
        let cols = batch
            .columns()
            .iter()
            .zip(self.display_schema.fields())
            .map(|(c, f)| {
                if c.data_type() == f.data_type() {
                    Ok(c.clone())
                } else {
                    cast(c, f.data_type()).map_err(malformed)
                }
            })
            .collect::<Result<Vec<ArrayRef>, Error>>()?;
        RecordBatch::try_new(self.display_schema.clone(), cols).map_err(malformed)
    }
}

/// String views and string dictionaries become plain strings; nothing else changes, so a numeric
/// dictionary keeps its meaning. Field/schema metadata, nullability and timezones are preserved.
pub fn display_schema(schema: &Schema) -> Schema {
    fn plain(t: &DataType) -> DataType {
        match t {
            DataType::Utf8View => DataType::Utf8,
            DataType::BinaryView => DataType::Binary,
            DataType::Dictionary(_, v)
                if matches!(
                    **v,
                    DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View
                ) =>
            {
                plain(v)
            }
            t => t.clone(),
        }
    }
    let fields: Vec<Arc<Field>> = schema
        .fields()
        .iter()
        .map(|f| Arc::new(f.as_ref().clone().with_data_type(plain(f.data_type()))))
        .collect();
    Schema::new_with_metadata(fields, schema.metadata().clone())
}

/// Exact text for one cell: integers and decimals print every digit (never via f64); None is null.
/// shortcut: named IANA timezones need arrow-cast's chrono-tz (not in the offline cache), so such
/// timestamps print with an explicit UTC Z and the original zone name; upgrade when chrono-tz is cached.
pub fn cell_text(array: &dyn Array, row: usize) -> Result<Option<String>, Error> {
    guarded(|| cell_text_unguarded(array, row))
}
fn cell_text_unguarded(array: &dyn Array, row: usize) -> Result<Option<String>, Error> {
    // `is_null` misses a Null-typed column and a dictionary key that points at a null value.
    let null = match array.as_any_dictionary_opt() {
        Some(d) => {
            array.is_null(row)
                || d.values().is_null(
                    d.normalized_keys()
                        .get(row)
                        .copied()
                        .ok_or_else(|| malformed("row out of range"))?,
                )
        }
        None => array.data_type() == &DataType::Null || array.is_null(row),
    };
    if null {
        return Ok(None);
    }
    // A null inside a list, struct or map reads `null`, not an empty slot that looks like "".
    let opts = arrow_cast::display::FormatOptions::default().with_null("null");
    match ArrayFormatter::try_new(array, &opts) {
        Ok(f) => Ok(Some(f.value(row).try_to_string().map_err(malformed)?)),
        Err(_) => match array.data_type() {
            DataType::Timestamp(unit, Some(tz)) => {
                let naive = cast(
                    &arrow_array::make_array(array.to_data()),
                    &DataType::Timestamp(*unit, None),
                )
                .map_err(malformed)?;
                let f = ArrayFormatter::try_new(naive.as_ref(), &opts).map_err(malformed)?;
                Ok(Some(format!(
                    "{}Z [{tz}]",
                    f.value(row).try_to_string().map_err(malformed)?
                )))
            }
            t => Err(Error::Unsupported(format!(
                "Cannot display values of type {t}."
            ))),
        },
    }
}

#[derive(Default)]
struct Scan {
    batches: usize,
    rows: u64,
    messages: usize,
    has_message_metadata: bool,
    codecs: Vec<Codec>,
    /// Decoded bytes of each dictionary as it stands (a delta adds, a replacement sets): arrow-rs keeps
    /// them all resident, so their sum is bounded too.
    dictionaries: HashMap<i64, u64>,
}

fn check_message(
    meta: &[u8],
    body: &[u8],
    limits: &Limits,
    scan: &mut Scan,
) -> Result<Option<Schema>, Error> {
    scan.messages += 1;
    if scan.messages > limits.max_messages {
        return Err(Error::TooLarge(
            "The file has more messages than the configured limit.".into(),
        ));
    }
    let msg = root_as_message(meta)
        .map_err(|e| Error::Malformed(format!("Invalid message metadata: {e}")))?;
    scan.has_message_metadata |= msg.custom_metadata().is_some_and(|m| !m.is_empty());
    if msg.version() != MetadataVersion::V5 {
        return Err(Error::Unsupported(format!(
            "Arrow metadata version {:?} is not supported (V5 only).",
            msg.version()
        )));
    }
    let mut dictionary = None;
    let data = match msg.header_type() {
        MessageHeader::Schema => {
            return Ok(Some(checked_schema(
                msg.header_as_schema()
                    .ok_or_else(|| malformed("missing schema"))?,
                limits,
            )?));
        }
        MessageHeader::RecordBatch => {
            scan.batches += 1;
            msg.header_as_record_batch()
        }
        MessageHeader::DictionaryBatch => {
            let d = msg.header_as_dictionary_batch();
            dictionary = d.map(|d| (d.id(), d.isDelta()));
            d.and_then(|d| d.data())
        }
        other => {
            return Err(Error::Unsupported(format!(
                "Unsupported Arrow message type {other:?}."
            )));
        }
    }
    .ok_or_else(|| malformed("message without a record batch"))?;
    if msg.header_type() == MessageHeader::RecordBatch {
        scan.rows += u64::try_from(data.length()).map_err(|_| malformed("negative row count"))?;
    }
    let mut decoded = 0u64;
    let codec = match data.compression() {
        None => None,
        Some(c) if c.method() != BodyCompressionMethod::BUFFER => {
            return Err(Error::Unsupported(
                "Unknown body compression method.".into(),
            ));
        }
        Some(c) if c.codec() == CompressionType::LZ4_FRAME => Some(Codec::Lz4Frame),
        Some(c) if c.codec() == CompressionType::ZSTD => Some(Codec::Zstd),
        Some(_) => return Err(Error::Unsupported("Unknown body compression codec.".into())),
    };
    if let Some(c) = codec {
        scan.codecs.push(c);
    }
    for b in data.buffers().into_iter().flatten() {
        let (off, len) = (
            u64::try_from(b.offset()).map_err(|_| malformed("negative buffer offset"))?,
            u64::try_from(b.length()).map_err(|_| malformed("negative buffer length"))?,
        );
        if off.checked_add(len).is_none_or(|e| e > body.len() as u64) {
            return Err(Error::Malformed(
                "A buffer lies outside its message body.".into(),
            ));
        }
        decoded = decoded.saturating_add(if codec.is_some() && len >= 8 {
            // Each compressed buffer starts with its decoded length; -1 means stored uncompressed.
            let p = i64::from_le_bytes(body[off as usize..off as usize + 8].try_into().unwrap());
            match p {
                -1 => len - 8,
                p if p >= 0 => {
                    if p > 0 && codec == Some(Codec::Lz4Frame) {
                        // arrow-rs inflates LZ4 with an unbounded read_to_end and checks the length only
                        // afterwards, so the prefix is proved here against the real frame, bounded by it.
                        verify_lz4(&body[off as usize + 8..(off + len) as usize], p as u64)?;
                    }
                    p as u64
                }
                _ => {
                    return Err(Error::Malformed(
                        "Negative decoded length in a compressed buffer.".into(),
                    ));
                }
            }
        } else {
            len
        });
    }
    if decoded > limits.max_decoded_bytes {
        return Err(Error::TooLarge(format!(
            "A record batch would decode to {decoded} bytes, over the {} byte limit; nothing was decoded.",
            limits.max_decoded_bytes
        )));
    }
    if let Some((id, delta)) = dictionary {
        let slot = scan.dictionaries.entry(id).or_insert(0);
        *slot = if delta {
            slot.saturating_add(decoded)
        } else {
            decoded
        };
        if scan
            .dictionaries
            .values()
            .fold(0u64, |a, b| a.saturating_add(*b))
            > limits.max_decoded_bytes
        {
            return Err(Error::TooLarge(format!(
                "The dictionaries together would decode to over the {} byte limit; nothing was decoded.",
                limits.max_decoded_bytes
            )));
        }
    }
    Ok(None)
}

/// An LZ4 frame must inflate to exactly `declared` bytes; reading stops one byte past it.
fn verify_lz4(frame: &[u8], declared: u64) -> Result<(), Error> {
    let got = std::io::copy(
        &mut lz4_flex::frame::FrameDecoder::new(frame).take(declared.saturating_add(1)),
        &mut std::io::sink(),
    )
    .map_err(|e| Error::Malformed(format!("A compressed buffer is not a valid LZ4 frame: {e}")))?;
    if got != declared {
        return Err(Error::Malformed(format!(
            "A compressed buffer declares {declared} decoded bytes but its LZ4 frame holds a different amount."
        )));
    }
    Ok(())
}

/// One message at the reader's position: continuation, length, metadata, body. None at the end marker.
fn read_message(
    r: &mut impl Read,
    limits: &Limits,
    scan: &mut Scan,
) -> Result<Option<Option<Schema>>, Error> {
    let mut prefix = [0u8; 8];
    r.read_exact(&mut prefix).map_err(|_| Error::Truncated("The stream ends before its end-of-stream marker, so the file was truncated (an interrupted writer or a partial copy).".into()))?;
    if prefix[..4] != CONTINUATION {
        return Err(Error::Unsupported(
            "A message lacks the continuation marker (pre-0.15 Arrow layout is not supported)."
                .into(),
        ));
    }
    let len = i32::from_le_bytes(prefix[4..].try_into().unwrap());
    if len == 0 {
        return Ok(None);
    }
    let len = u32::try_from(len)
        .ok()
        .filter(|l| *l <= limits.max_metadata_bytes)
        .ok_or_else(|| {
            Error::TooLarge("Message metadata length is negative or over the limit.".into())
        })?;
    let mut meta = vec![0u8; len as usize];
    r.read_exact(&mut meta)
        .map_err(|_| Error::Truncated("The stream ends inside a message's metadata.".into()))?;
    let body_len = root_as_message(&meta)
        .map_err(|e| Error::Malformed(format!("Invalid message metadata: {e}")))?
        .bodyLength();
    let body_len = u64::try_from(body_len)
        .ok()
        .filter(|b| *b <= limits.max_body_bytes)
        .ok_or_else(|| {
            Error::TooLarge(format!(
                "A message body of {body_len} bytes is negative or over the {} byte limit.",
                limits.max_body_bytes
            ))
        })?;
    let mut body = Vec::new();
    r.take(body_len).read_to_end(&mut body)?;
    if body.len() as u64 != body_len {
        return Err(Error::Truncated(
            "The stream ends inside a message body.".into(),
        ));
    }
    check_message(&meta, &body, limits, scan).map(Some)
}

fn scan_stream(r: &mut impl Read, limits: &Limits, scan: &mut Scan) -> Result<Schema, Error> {
    let mut schema = None;
    loop {
        match read_message(r, limits, scan)? {
            None => break,
            Some(Some(s)) if schema.is_none() => schema = Some(s),
            Some(Some(_)) => {
                return Err(Error::Malformed(
                    "A second schema message follows the first.".into(),
                ));
            }
            Some(None) if schema.is_none() => {
                return Err(Error::Malformed(
                    "The first message is not a schema.".into(),
                ));
            }
            Some(None) => {}
        }
    }
    schema.ok_or_else(|| Error::Malformed("The stream has no schema message.".into()))
}

fn scan_file(f: &mut File, size: u64, limits: &Limits, scan: &mut Scan) -> Result<Schema, Error> {
    if size < 6 + 2 + 4 + 6 {
        return Err(Error::Truncated(
            "The file is too short to hold an Arrow footer.".into(),
        ));
    }
    let mut tail = [0u8; 10];
    f.seek(SeekFrom::Start(size - 10))?;
    f.read_exact(&mut tail)?;
    if &tail[4..] != FILE_MAGIC {
        return Err(Error::Truncated("The closing ARROW1 marker is missing, so the file was truncated or is a stream with a file header.".into()));
    }
    let footer_len = u64::from(u32::from_le_bytes(tail[..4].try_into().unwrap()));
    if footer_len > u64::from(limits.max_metadata_bytes) || footer_len + 10 + 8 > size {
        return Err(Error::Malformed(
            "The footer length is out of range.".into(),
        ));
    }
    let footer_at = size - 10 - footer_len;
    let mut fb = vec![0u8; footer_len as usize];
    f.seek(SeekFrom::Start(footer_at))?;
    f.read_exact(&mut fb)?;
    let footer =
        root_as_footer(&fb).map_err(|e| Error::Malformed(format!("Invalid footer: {e}")))?;
    let schema = checked_schema(
        footer
            .schema()
            .ok_or_else(|| malformed("footer without schema"))?,
        limits,
    )?;
    let blocks = footer
        .dictionaries()
        .into_iter()
        .flatten()
        .chain(footer.recordBatches().into_iter().flatten());
    for b in blocks {
        let (off, meta_len, body_len) = (
            u64::try_from(b.offset()),
            u64::try_from(b.metaDataLength() as i64),
            u64::try_from(b.bodyLength()),
        );
        let (Ok(off), Ok(meta_len), Ok(body_len)) = (off, meta_len, body_len) else {
            return Err(Error::Malformed(
                "A footer block has a negative field.".into(),
            ));
        };
        if meta_len < 8
            || meta_len > u64::from(limits.max_metadata_bytes) + 8
            || body_len > limits.max_body_bytes
            || off < 8
            || off.saturating_add(meta_len).saturating_add(body_len) > footer_at
        {
            return Err(Error::Malformed(
                "A footer block lies outside the file or exceeds a limit.".into(),
            ));
        }
        f.seek(SeekFrom::Start(off))?;
        let mut r = BufReader::new(&mut *f);
        let mut prefix = [0u8; 8];
        r.read_exact(&mut prefix)?;
        let len = u64::from(u32::from_le_bytes(prefix[4..].try_into().unwrap()));
        if prefix[..4] != CONTINUATION || len + 8 != meta_len {
            return Err(Error::Malformed(
                "A block's message prefix disagrees with the footer.".into(),
            ));
        }
        let mut meta = vec![0u8; len as usize];
        r.read_exact(&mut meta)?;
        let mut body = vec![0u8; body_len as usize];
        r.read_exact(&mut body)?;
        check_message(&meta, &body, limits, scan)?;
    }
    Ok(schema)
}
