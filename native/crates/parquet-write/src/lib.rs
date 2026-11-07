//! Snapshot-bound Parquet cell edits. No publication occurs until every staged value is read back.
//! Physical/logical schema, field IDs, ordered/duplicate key/value metadata, row-group boundaries,
//! and per-column codec policy are preserved. `created_by` truthfully identifies this producer.
//! Unsupported reconstruction policies are refused. This crate is not yet worker wiring.
mod compact;
use arrow_array::{ArrayRef, RecordBatch};
use arrow_schema::DataType;
use base64::Engine;
use dfv_table_arrow_ipc::cell_text;
pub use dfv_table_arrow_write::CellEdit;
use dfv_table_arrow_write::{check_type, identity_text, replace_cell, scalar_for};
use dfv_table_publication::{Identity, Publisher, Receipt, SourceState, WriterLock, digest_reader};
use parquet::arrow::arrow_reader::{
    ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder,
};
use parquet::arrow::arrow_writer::{ArrowWriter, ArrowWriterOptions};
use parquet::basic::{Compression, Encoding};
use parquet::file::metadata::ParquetMetaData;
use parquet::file::properties::{EnabledStatistics, WriterProperties, WriterVersion};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use tempfile::NamedTempFile;

#[derive(Clone, Debug)]
pub struct Limits {
    pub file_bytes: u64,
    pub footer_bytes: usize,
    pub page_bytes: usize,
    pub row_group_bytes: u64,
    pub values: u64,
    pub metadata_items: usize,
    pub schema_nodes: usize,
    pub columns: usize,
    pub row_groups: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: 256 << 20,
            footer_bytes: 16 << 20,
            page_bytes: 16 << 20,
            row_group_bytes: 128 << 20,
            values: 4_000_000,
            metadata_items: 100_000,
            schema_nodes: 8192,
            columns: 2048,
            row_groups: 4096,
        }
    }
}
#[derive(Debug)]
pub enum Error {
    Invalid(String),
    TooLarge(String),
    Unsupported(String),
    Changed,
    Edit(dfv_table_arrow_write::Error),
    Publication(dfv_table_publication::PublishError),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(m) | Self::TooLarge(m) | Self::Unsupported(m) => f.write_str(m),
            Self::Changed => f.write_str("Source changed while taking the edit snapshot"),
            Self::Edit(e) => e.fmt(f),
            Self::Publication(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for Error {}
impl From<dfv_table_arrow_write::Error> for Error {
    fn from(e: dfv_table_arrow_write::Error) -> Self {
        Self::Edit(e)
    }
}
impl From<dfv_table_publication::PublishError> for Error {
    fn from(e: dfv_table_publication::PublishError) -> Self {
        Self::Publication(e)
    }
}
fn bad(e: impl std::fmt::Display) -> Error {
    Error::Invalid(e.to_string())
}
fn unsupported(m: &str) -> Error {
    Error::Unsupported(m.into())
}
fn number(n: i64, cap: u64) -> Result<u64, Error> {
    let n = u64::try_from(n).map_err(|_| bad("Negative Parquet length/count"))?;
    if n > cap {
        return Err(Error::TooLarge(
            "Parquet length/count budget exceeded".into(),
        ));
    }
    Ok(n)
}
fn bytes(file: &mut File, offset: u64, len: usize) -> Result<Vec<u8>, Error> {
    file.seek(SeekFrom::Start(offset)).map_err(bad)?;
    let mut b = vec![0; len];
    file.read_exact(&mut b).map_err(bad)?;
    Ok(b)
}
fn read_regular(path: &Path) -> Result<File, Error> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(bad)?;
    if !file.metadata().map_err(bad)?.is_file() {
        return Err(unsupported("Source is not a regular file"));
    }
    Ok(file)
}
fn footer(file: &mut File, limits: &Limits) -> Result<u64, Error> {
    let len = file.metadata().map_err(bad)?.len();
    if !(12..=limits.file_bytes).contains(&len) {
        return Err(Error::TooLarge("Parquet file length budget".into()));
    }
    if bytes(file, 0, 4)? != b"PAR1" {
        return Err(unsupported("Encrypted or non-Parquet source"));
    }
    let tail = bytes(file, len - 8, 8)?;
    if &tail[4..] != b"PAR1" {
        return Err(unsupported("Encrypted or invalid Parquet footer"));
    }
    let n = number(
        i64::from(i32::from_le_bytes(tail[..4].try_into().unwrap())),
        limits.footer_bytes as u64,
    )?;
    let start = len
        .checked_sub(n + 8)
        .filter(|v| *v >= 4)
        .ok_or_else(|| bad("Invalid footer length"))?;
    let b = bytes(file, start, n as usize)?;
    if compact::check(&b, limits, true)?.0 != b.len() {
        return Err(bad("Trailing footer bytes"));
    }
    Ok(start)
}
fn arrow_metadata(meta: &ParquetMetaData, limits: &Limits) -> Result<(), Error> {
    // Preflight flatbuffer field counts/depth BEFORE Arrow's schema conversion allocates vectors.
    fn field(
        f: arrow_ipc::Field<'_>,
        depth: usize,
        n: &mut usize,
        cap: usize,
    ) -> Result<(), Error> {
        *n += 1;
        if *n > cap || depth > 32 {
            return Err(Error::TooLarge("Embedded Arrow schema budget".into()));
        }
        if f.type_type() == arrow_ipc::Type::FixedSizeList {
            return Err(unsupported(
                "Embedded fixed-size lists require a bounded reconstruction policy",
            ));
        }
        if let Some(children) = f.children() {
            for c in children {
                field(c, depth + 1, n, cap)?;
            }
        }
        Ok(())
    }
    for kv in meta
        .file_metadata()
        .key_value_metadata()
        .into_iter()
        .flatten()
    {
        if kv.key != "ARROW:schema" {
            continue;
        }
        let Some(encoded) = &kv.value else { continue };
        let b = base64::prelude::BASE64_STANDARD
            .decode(encoded)
            .map_err(bad)?;
        let b = if b.starts_with(&[255; 4]) {
            b.get(8..).ok_or_else(|| bad("Short Arrow schema"))?
        } else {
            &b
        };
        let message = arrow_ipc::root_as_message(b).map_err(bad)?;
        let schema = message
            .header_as_schema()
            .ok_or_else(|| bad("Invalid embedded Arrow schema"))?;
        let mut n = 0;
        if let Some(fields) = schema.fields() {
            for f in fields {
                field(f, 0, &mut n, limits.schema_nodes)?;
            }
        }
    }
    Ok(())
}
fn builder(
    file: &File,
    metadata: &ArrowReaderMetadata,
) -> Result<ParquetRecordBatchReaderBuilder<File>, Error> {
    Ok(ParquetRecordBatchReaderBuilder::new_with_metadata(
        file.try_clone().map_err(bad)?,
        metadata.clone(),
    ))
}
fn codec_proof(codec: Compression, payload: &[u8], expected: usize) -> Result<(), Error> {
    match codec {
        Compression::UNCOMPRESSED => {
            if payload.len() != expected {
                return Err(bad("Uncompressed page length mismatch"));
            }
        }
        Compression::SNAPPY => {
            if snap::raw::decompress_len(payload).map_err(bad)? != expected {
                return Err(bad("Snappy expansion length mismatch"));
            }
        }
        Compression::GZIP(_) => {
            // The upstream gzip codec uses read_to_end; prove its output bound on immutable bytes first.
            let mut decoder = flate2::read::MultiGzDecoder::new(payload).take(expected as u64 + 1);
            let n = std::io::copy(&mut decoder, &mut std::io::sink()).map_err(bad)?;
            if n != expected as u64 {
                return Err(bad("Gzip expansion length mismatch"));
            }
        }
        Compression::ZSTD(_) | Compression::LZ4_RAW => {} // these codecs honor the preflighted output capacity
        _ => {
            return Err(unsupported(
                "This Parquet codec cannot be reconstructed with bounded decoding",
            ));
        }
    }
    Ok(())
}
fn preflight(
    file: &mut File,
    meta: &ParquetMetaData,
    end: u64,
    limits: &Limits,
) -> Result<WriterProperties, Error> {
    arrow_metadata(meta, limits)?;
    let mut properties = WriterProperties::builder()
        .set_created_by("Data File Viewer parquet-rs 58.4.0".into())
        .set_writer_version(match meta.file_metadata().version() {
            1 => WriterVersion::PARQUET_1_0,
            2 => WriterVersion::PARQUET_2_0,
            _ => return Err(unsupported("Unsupported Parquet version")),
        })
        .set_max_row_group_row_count(None)
        .set_max_row_group_bytes(None)
        .set_offset_index_disabled(true)
        .set_statistics_enabled(EnabledStatistics::Chunk)
        .set_key_value_metadata(meta.file_metadata().key_value_metadata().cloned());
    if meta.num_row_groups() > limits.row_groups
        || meta.file_metadata().schema_descr().num_columns() > limits.columns
    {
        return Err(Error::TooLarge("Parquet structural budget".into()));
    }
    number(meta.file_metadata().num_rows(), limits.values)?;
    let mut policy = Vec::new();
    let mut pages = 0usize;
    for (gi, g) in meta.row_groups().iter().enumerate() {
        if g.num_rows() == 0 {
            return Err(unsupported(
                "Empty row groups cannot be reconstructed without changing boundaries",
            ));
        }
        if g.sorting_columns().is_some() {
            return Err(unsupported(
                "Editing sorted Parquet row groups requires rebuilding sort metadata",
            ));
        }
        if g.ordinal()
            .is_some_and(|n| usize::try_from(n).ok() != Some(gi))
        {
            return Err(unsupported(
                "Noncanonical row group ordinals cannot be preserved",
            ));
        }
        let mut expanded = 0u64;
        let mut fixed_expansion = 0u64;
        let mut group_values = 0u64;
        for (ci, c) in g.columns().iter().enumerate() {
            if c.column_descr().physical_type() == parquet::basic::Type::INT96 {
                return Err(unsupported(
                    "Legacy INT96 timestamp encoding cannot be reconstructed by this writer",
                ));
            }
            if c.file_path().is_some()
                || c.bloom_filter_offset().is_some()
                || c.column_index_offset().is_some()
                || c.offset_index_offset().is_some()
            {
                return Err(unsupported(
                    "External chunks, bloom filters and page indexes require a preserving reconstruction policy",
                ));
            }
            let dict = c
                .encodings()
                .any(|e| matches!(e, Encoding::PLAIN_DICTIONARY | Encoding::RLE_DICTIONARY));
            if gi == 0 {
                policy.push((c.compression(), dict));
                properties = properties
                    .set_column_compression(c.column_path().clone(), c.compression())
                    .set_column_dictionary_enabled(c.column_path().clone(), dict);
            } else if policy.get(ci) != Some(&(c.compression(), dict)) {
                return Err(unsupported("Per-row-group codec/dictionary policy varies"));
            }
            let (mut at, len) = c.byte_range();
            let stop = at
                .checked_add(len)
                .filter(|v| *v <= end)
                .ok_or_else(|| bad("Chunk extends beyond data region"))?;
            if at < 4 {
                return Err(bad("Invalid chunk offset"));
            }
            number(c.num_values(), limits.values)?;
            let width = c.column_descr().type_length();
            if width > 0 {
                fixed_expansion = fixed_expansion
                    .saturating_add((c.num_values() as u64).saturating_mul(width as u64));
                if fixed_expansion > limits.row_group_bytes {
                    return Err(Error::TooLarge("Fixed-width group expansion budget".into()));
                }
            }
            group_values = group_values
                .checked_add(c.num_values() as u64)
                .ok_or_else(|| bad("Group value overflow"))?;
            if group_values > limits.values {
                return Err(Error::TooLarge("Group value budget".into()));
            }
            let mut values = 0u64;
            let mut dictionary = false;
            while at < stop {
                pages = pages
                    .checked_add(1)
                    .ok_or_else(|| bad("Page count overflow"))?;
                if pages > limits.metadata_items {
                    return Err(Error::TooLarge("Parquet page count budget".into()));
                }
                let header = bytes(
                    file,
                    at,
                    usize::try_from((stop - at).min(64 << 10)).map_err(bad)?,
                )?;
                let (used, p) = compact::check(&header, limits, false)?;
                let size = number(
                    p.compressed
                        .ok_or_else(|| bad("Page compressed size missing"))?,
                    limits.page_bytes as u64,
                )?;
                let decoded = number(
                    p.decoded.ok_or_else(|| bad("Page decoded size missing"))?,
                    limits.page_bytes as u64,
                )?;
                expanded = expanded
                    .checked_add(decoded)
                    .ok_or_else(|| bad("Page sum overflow"))?;
                if expanded > limits.row_group_bytes {
                    return Err(Error::TooLarge("Row group expansion budget".into()));
                }
                let payload_at = at
                    .checked_add(used as u64)
                    .ok_or_else(|| bad("Page offset overflow"))?;
                at = payload_at
                    .checked_add(size)
                    .filter(|v| *v <= stop)
                    .ok_or_else(|| bad("Page extends beyond chunk"))?;
                match p.kind {
                    Some(0 | 3) => {
                        values = values
                            .checked_add(number(
                                p.values.ok_or_else(|| bad("Missing data page count"))?,
                                limits.values,
                            )?)
                            .ok_or_else(|| bad("Value sum overflow"))?;
                    }
                    Some(2) => {
                        if dictionary {
                            return Err(bad("Multiple dictionary pages"));
                        }
                        dictionary = true;
                        number(
                            p.values.ok_or_else(|| bad("Missing dictionary count"))?,
                            limits.values,
                        )?;
                    }
                    _ => return Err(unsupported("Unknown/index page cannot be preserved")),
                }
                let payload = bytes(file, payload_at, size as usize)?;
                let levels = if p.kind == Some(3) { p.level_bytes } else { 0 };
                if levels > payload.len() || levels > decoded as usize {
                    return Err(bad("Invalid V2 level lengths"));
                }
                codec_proof(
                    if p.kind == Some(3) && !p.values_compressed {
                        Compression::UNCOMPRESSED
                    } else {
                        c.compression()
                    },
                    &payload[levels..],
                    decoded as usize - levels,
                )?;
            }
            if values != c.num_values() as u64 {
                return Err(bad("Column/page value count mismatch"));
            }
        }
    }
    Ok(properties.build())
}

/// Validated private stage. It never aliases the source and disappears when dropped.
pub struct PreparedEdit {
    stage: NamedTempFile,
    pub source: SourceState,
    pub length: u64,
    pub sha256: String,
}
impl PreparedEdit {
    pub fn reader(&self) -> Result<File, Error> {
        let file = read_regular(self.stage.path())?;
        if Identity::of(&file.metadata().map_err(bad)?)
            != Identity::of(&self.stage.as_file().metadata().map_err(bad)?)
        {
            return Err(Error::Changed);
        }
        Ok(file)
    }
}
/// Prepare and verify the full replacement; source bytes are never mutated, including on refusal.
pub fn prepare_edit(
    path: &Path,
    limits: &Limits,
    edit: &CellEdit<'_>,
) -> Result<PreparedEdit, Error> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| prepare(path, limits, edit)))
        .map_err(|_| bad("Parquet codec rejected this file"))?
}
fn prepare(path: &Path, limits: &Limits, edit: &CellEdit<'_>) -> Result<PreparedEdit, Error> {
    if edit.row.is_empty() {
        return Err(dfv_table_arrow_write::Error::NoRowIdentity.into());
    }
    let (mut snapshot, source) = snapshot_with_copy_hook(path, limits, |_| {})?;
    let end = footer(snapshot.as_file_mut(), limits)?;
    // skip_arrow_metadata avoids conversion allocations before our explicit embedded schema preflight.
    let raw = ParquetRecordBatchReaderBuilder::try_new_with_options(
        snapshot.reopen().map_err(bad)?,
        ArrowReaderOptions::new().with_skip_arrow_metadata(true),
    )
    .map_err(bad)?;
    let meta = raw.metadata().clone();
    let properties = preflight(snapshot.as_file_mut(), &meta, end, limits)?;
    let reader_metadata =
        ArrowReaderMetadata::try_new(meta.clone(), ArrowReaderOptions::new()).map_err(bad)?;
    let schema = reader_metadata.schema().clone();
    let col = schema
        .index_of(edit.column)
        .map_err(|_| dfv_table_arrow_write::Error::NoSuchColumn(edit.column.into()))?;
    let field = schema.field(col);
    check_type(field)?;
    if edit.value.is_none() && !field.is_nullable() {
        return Err(dfv_table_arrow_write::Error::NotNullable(edit.column.into()).into());
    }
    let dtype = match field.data_type() {
        DataType::Dictionary(_, v) => v.as_ref(),
        d => d,
    };
    let scalar = scalar_for(dtype, edit.value)?;
    let keys: Vec<_> = edit
        .row
        .iter()
        .map(|(name, want)| {
            schema
                .index_of(name)
                .map(|i| (i, identity_text(schema.field(i).data_type(), *want)))
                .map_err(|_| dfv_table_arrow_write::Error::NoSuchColumn((*name).into()))
        })
        .collect::<Result<_, _>>()?;
    let mut hit = None;
    let mut found = 0u64;
    for (gi, _) in meta.row_groups().iter().enumerate() {
        for (bi, b) in builder(snapshot.as_file(), &reader_metadata)?
            .with_row_groups(vec![gi])
            .with_batch_size(65536)
            .build()
            .map_err(bad)?
            .enumerate()
        {
            let b = b.map_err(bad)?;
            for row in 0..b.num_rows() {
                let mut matches = true;
                for (i, want) in &keys {
                    if cell_text(b.column(*i).as_ref(), row)
                        .map_err(bad)?
                        .as_deref()
                        != want.as_deref()
                    {
                        matches = false;
                        break;
                    }
                }
                if matches {
                    found += 1;
                    hit = Some((gi, bi, row));
                }
            }
        }
    }
    if found == 0 {
        return Err(dfv_table_arrow_write::Error::NoMatch.into());
    }
    if found != 1 {
        return Err(dfv_table_arrow_write::Error::Ambiguous(found).into());
    }
    let hit = hit.unwrap();
    let mut stage = NamedTempFile::new().map_err(bad)?;
    let options = ArrowWriterOptions::new()
        .with_properties(properties)
        .with_skip_arrow_metadata(true)
        .with_parquet_schema(meta.file_metadata().schema_descr().clone());
    {
        let mut writer =
            ArrowWriter::try_new_with_options(stage.as_file_mut(), schema.clone(), options)
                .map_err(bad)?;
        for gi in 0..meta.num_row_groups() {
            for (bi, b) in builder(snapshot.as_file(), &reader_metadata)?
                .with_row_groups(vec![gi])
                .with_batch_size(65536)
                .build()
                .map_err(bad)?
                .enumerate()
            {
                let b = b.map_err(bad)?;
                let b = edited(b, (gi, bi), hit, col, &scalar)?;
                writer.write(&b).map_err(bad)?;
            }
            writer.flush().map_err(bad)?;
            if writer.bytes_written() as u64 > limits.file_bytes {
                return Err(Error::TooLarge("Staged file budget".into()));
            }
        }
        writer.finish().map_err(bad)?;
    }
    let output_end = footer(stage.as_file_mut(), limits)?;
    let out = ParquetRecordBatchReaderBuilder::try_new_with_options(
        stage.reopen().map_err(bad)?,
        ArrowReaderOptions::new().with_skip_arrow_metadata(true),
    )
    .map_err(bad)?;
    let output_meta = out.metadata().clone();
    // Validate the stage through a fresh parser and decoder before publication.
    preflight(stage.as_file_mut(), &output_meta, output_end, limits)?;
    let output_reader_metadata =
        ArrowReaderMetadata::try_new(output_meta.clone(), ArrowReaderOptions::new())
            .map_err(bad)?;
    if output_meta.file_metadata().schema_descr().root_schema()
        != meta.file_metadata().schema_descr().root_schema()
        || output_meta.file_metadata().key_value_metadata()
            != meta.file_metadata().key_value_metadata()
        || output_meta.file_metadata().column_orders() != meta.file_metadata().column_orders()
        || output_meta.file_metadata().version() != meta.file_metadata().version()
        || output_meta.num_row_groups() != meta.num_row_groups()
        || builder(stage.as_file(), &output_reader_metadata)?.schema() != &schema
    {
        return Err(unsupported(
            "Staged schema or metadata did not preserve source",
        ));
    }
    for gi in 0..meta.num_row_groups() {
        if output_meta.row_group(gi).num_rows() != meta.row_group(gi).num_rows() {
            return Err(bad("Row group boundaries changed"));
        }
        for (a, b) in meta
            .row_group(gi)
            .columns()
            .iter()
            .zip(output_meta.row_group(gi).columns())
        {
            if a.compression() != b.compression() {
                return Err(bad("Staged column codec changed"));
            }
        }
        let mut original = builder(snapshot.as_file(), &reader_metadata)?
            .with_row_groups(vec![gi])
            .with_batch_size(65536)
            .build()
            .map_err(bad)?;
        let mut output = builder(stage.as_file(), &output_reader_metadata)?
            .with_row_groups(vec![gi])
            .with_batch_size(65536)
            .build()
            .map_err(bad)?;
        let mut bi = 0;
        loop {
            match (original.next(), output.next()) {
                (None, None) => break,
                (Some(a), Some(b)) => {
                    let expected = edited(a.map_err(bad)?, (gi, bi), hit, col, &scalar)?;
                    if expected != b.map_err(bad)? {
                        return Err(bad("Staged values differ beyond intended cell"));
                    }
                }
                _ => return Err(bad("Staged batch count mismatch")),
            }
            bi += 1;
        }
    }
    let length = stage.as_file().metadata().map_err(bad)?.len();
    let sha256 = digest_reader(stage.reopen().map_err(bad)?, length)?;
    Ok(PreparedEdit {
        stage,
        source,
        length,
        sha256,
    })
}
// The hook is private and exists to inject a changed read stream in a deterministic regression.
fn snapshot_with_copy_hook(
    path: &Path,
    limits: &Limits,
    before_copy: impl FnOnce(&mut File),
) -> Result<(NamedTempFile, SourceState), Error> {
    let source = SourceState::capture(path)?;
    let mut input = read_regular(path)?;
    let descriptor = input.metadata().map_err(bad)?;
    let len = descriptor.len();
    if len > limits.file_bytes {
        return Err(Error::TooLarge("Source file budget".into()));
    }
    if Identity::of(&descriptor) != Identity::of(&std::fs::symlink_metadata(path).map_err(bad)?)
        || SourceState::capture(path)? != source
    {
        return Err(Error::Changed);
    }
    let original_hash = digest_reader(&mut input, len)?;
    if SourceState::capture(path)? != source {
        return Err(Error::Changed);
    }
    input.seek(SeekFrom::Start(0)).map_err(bad)?;
    before_copy(&mut input);
    let mut snapshot = NamedTempFile::new().map_err(bad)?;
    let copied = std::io::copy(&mut input.take(len + 1), snapshot.as_file_mut()).map_err(bad)?;
    let snapshot_hash = digest_reader(snapshot.reopen().map_err(bad)?, copied)?;
    if copied != len || snapshot_hash != original_hash || SourceState::capture(path)? != source {
        return Err(Error::Changed);
    }
    Ok((snapshot, source))
}
fn edited(
    b: RecordBatch,
    position: (usize, usize),
    hit: (usize, usize, usize),
    col: usize,
    scalar: &ArrayRef,
) -> Result<RecordBatch, Error> {
    if position != (hit.0, hit.1) {
        return Ok(b);
    }
    let mut cols = b.columns().to_vec();
    cols[col] = replace_cell(&cols[col], hit.2, scalar)?;
    RecordBatch::try_new(b.schema(), cols).map_err(bad)
}
/// Apply only to the locked destination, using the shared verified atomic publication primitive.
pub fn save_cell(
    publisher: &Publisher,
    lock: &WriterLock,
    limits: &Limits,
    edit: &CellEdit<'_>,
) -> Result<Receipt, Error> {
    let prepared = prepare_edit(lock.target(), limits, edit)?;
    Ok(publisher.publish_reader(
        lock,
        prepared.reader()?,
        prepared.length,
        &prepared.sha256,
        Some(&prepared.source),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn open_rejects_symlinks_and_fifos_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("source");
        let link = d.path().join("link");
        let fifo = d.path().join("fifo");
        std::fs::write(&source, b"source").unwrap();
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(read_regular(&link).is_err());
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a valid NUL-terminated path within the private test directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(matches!(read_regular(&fifo), Err(Error::Unsupported(_))));
    }
    #[test]
    fn gzip_and_snappy_expansion_claims_are_checked() {
        let input = vec![b'x'; 1 << 20];
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&input).unwrap();
        let gzip = gzip.finish().unwrap();
        assert!(codec_proof(Compression::GZIP(Default::default()), &gzip, 1).is_err());
        codec_proof(Compression::GZIP(Default::default()), &gzip, input.len()).unwrap();
        let snappy = snap::raw::Encoder::new().compress_vec(&input).unwrap();
        assert!(codec_proof(Compression::SNAPPY, &snappy, 1).is_err());
        codec_proof(Compression::SNAPPY, &snappy, input.len()).unwrap();
    }
    #[test]
    fn snapshot_hash_rejects_changed_stream_even_when_path_state_is_unchanged() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("source");
        let different = d.path().join("different");
        std::fs::write(&source, b"original source bytes").unwrap();
        std::fs::write(&different, b"modified source bytes").unwrap();
        let before = SourceState::capture(&source).unwrap();
        let result = snapshot_with_copy_hook(&source, &Limits::default(), |input| {
            *input = File::open(&different).unwrap()
        });
        assert!(matches!(result, Err(Error::Changed)));
        assert_eq!(before, SourceState::capture(&source).unwrap());
        assert_eq!(std::fs::read(source).unwrap(), b"original source bytes");
    }
}
