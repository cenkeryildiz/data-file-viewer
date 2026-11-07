//! D3.9 hostile inputs: every byte flipped, every prefix truncated and crafted codec lies must end in a
//! typed `Error` (or a clean read), never a panic, and never one allocation beyond what `Limits` allow.
use arrow_array::{Array, Int64Array, RecordBatch};
use arrow_ipc::CompressionType;
use arrow_ipc::writer::{FileWriter, IpcWriteOptions, StreamWriter};
use arrow_schema::{DataType, Field, Schema};
use dfv_table_arrow_ipc::{Error, Limits, cell_text, open};
use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Peak;
static BIGGEST: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        BIGGEST.fetch_max(l.size(), Ordering::Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        BIGGEST.fetch_max(l.size(), Ordering::Relaxed);
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        BIGGEST.fetch_max(n, Ordering::Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static A: Peak = Peak;

fn fx(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}
/// Small enough that every allocation past this was requested by a lying header, not by real data.
fn tight() -> Limits {
    Limits {
        max_body_bytes: 1 << 20,
        max_decoded_bytes: 8 << 20,
        max_metadata_bytes: 1 << 20,
        max_messages: 1000,
        ..Limits::default()
    }
}

#[test]
fn snapshot_size_refuses_before_copying_and_accepts_exact_boundary() {
    for name in ["wide.arrows", "wide.feather"] {
        let path = fx(name);
        let before = std::fs::read(&path).unwrap();
        let length = before.len() as u64;
        let limits = Limits {
            max_file_bytes: length - 1,
            ..Limits::default()
        };
        assert!(matches!(open(&path, &limits), Err(Error::TooLarge(_))));
        let limits = Limits {
            max_file_bytes: length,
            ..Limits::default()
        };
        assert!(open(&path, &limits).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("oversized.arrows");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(Limits::default().max_file_bytes + 1).unwrap();
    // Its invalid header must never be read, nor its sparse contents copied into temporary storage.
    assert!(matches!(
        open(&path, &Limits::default()),
        Err(Error::TooLarge(_))
    ));
}

#[test]
fn schemas_are_bounded_before_conversion_in_stream_and_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut kind = DataType::Int64;
    for _ in 0..3 {
        kind = DataType::List(Arc::new(Field::new("item", kind, true)));
    }
    let schema = Schema::new(vec![Field::new("nested", kind, true)]);
    for container in ["stream", "file"] {
        let path = dir.path().join(container);
        let mut file = std::fs::File::create(&path).unwrap();
        if container == "stream" {
            StreamWriter::try_new(&mut file, &schema)
                .unwrap()
                .finish()
                .unwrap();
        } else {
            FileWriter::try_new(&mut file, &schema)
                .unwrap()
                .finish()
                .unwrap();
        }
        let before = std::fs::read(&path).unwrap();
        let limits = Limits {
            max_schema_depth: 2,
            ..Limits::default()
        };
        assert!(matches!(open(&path, &limits), Err(Error::TooLarge(_))));
        let limits = Limits {
            max_schema_fields: 3,
            ..Limits::default()
        };
        assert!(matches!(open(&path, &limits), Err(Error::TooLarge(_))));
        let limits = Limits {
            max_schema_depth: 3,
            max_schema_fields: 4,
            ..Limits::default()
        };
        assert!(open(&path, &limits).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
/// Open then read everything; true when the whole file decoded.
fn read_all(p: &std::path::Path, l: &Limits) -> Result<u64, Error> {
    let s = open(p, l)?;
    let mut rows = 0;
    for b in s.batches()? {
        let b = s.display_batch(&b?)?;
        rows += b.num_rows() as u64;
        for c in b.columns() {
            for r in 0..c.len() {
                cell_text(c.as_ref(), r)?;
            }
        }
    }
    Ok(rows)
}

#[test]
fn every_flipped_byte_ends_typed_and_within_limits() {
    let dir = tempfile::tempdir().unwrap();
    let mut flips = 0;
    for name in [
        "wide.feather",
        "wide-lz4.feather",
        "wide-zstd.arrows",
        "dict-delta.arrows",
        "polars-view.feather",
        "empty.arrows",
    ] {
        let good = std::fs::read(fx(name)).unwrap();
        let p = dir.path().join(name);
        for at in 0..good.len() {
            let mut bad = good.clone();
            bad[at] ^= 0xff;
            std::fs::write(&p, &bad).unwrap();
            let r = std::panic::catch_unwind(|| read_all(&p, &tight()));
            assert!(r.is_ok(), "{name}: flipping byte {at} panicked"); // a value or an Error, never a panic
            flips += 1;
        }
    }
    assert!(flips > 15_000, "swept {flips} flips");
    let biggest = BIGGEST.load(Ordering::Relaxed);
    assert!(
        biggest <= 24 << 20,
        "largest single allocation {biggest} bytes exceeds what tight limits allow"
    );
}

#[test]
fn every_strict_prefix_is_an_error_never_a_shorter_table() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "wide.feather",
        "wide-lz4.arrows",
        "wide-zstd.feather",
        "dict-replace.arrows",
        "polars-lz4.feather",
    ] {
        let good = std::fs::read(fx(name)).unwrap();
        let p = dir.path().join(name);
        for cut in 0..good.len() {
            std::fs::write(&p, &good[..cut]).unwrap();
            assert!(
                read_all(&p, &Limits::default()).is_err(),
                "{name} cut at {cut} of {} read as a table",
                good.len()
            );
        }
        std::fs::write(&p, &good).unwrap();
        read_all(&p, &Limits::default()).unwrap_or_else(|e| panic!("{name} whole: {e}"));
    }
}

fn zeros_stream(codec: CompressionType, rows: usize) -> Vec<u8> {
    let schema = Arc::new(Schema::new(vec![Field::new("a", DataType::Int64, false)]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![Arc::new(Int64Array::from(vec![0i64; rows]))],
    )
    .unwrap();
    let opts = IpcWriteOptions::default()
        .try_with_compression(Some(codec))
        .unwrap();
    let mut w = StreamWriter::try_new_with_options(Vec::new(), &schema, opts).unwrap();
    w.write(&batch).unwrap();
    w.into_inner().unwrap()
}
/// Overwrite the one decoded-length prefix equal to `from` (as the writer produced it) with `to`.
fn lie(mut bytes: Vec<u8>, from: i64, to: i64) -> Vec<u8> {
    let needle = from.to_le_bytes();
    // The body follows its metadata, so the last match is the buffer prefix, not flatbuffer bytes.
    let at = bytes
        .windows(8)
        .rposition(|w| w == needle)
        .expect("prefix present");
    bytes[at..at + 8].copy_from_slice(&to.to_le_bytes());
    bytes
}

#[test]
fn lz4_frame_larger_than_its_declared_length_is_refused_at_open() {
    // 16 MiB of zeros is ~64 KiB of LZ4. Declared as 1 KiB, arrow-rs would grow its output to the real
    // size (a 256 MiB body of zeros would be ~64 GiB); the claim must be proved before any decode.
    let dir = tempfile::tempdir().unwrap();
    let rows = 2 << 20;
    let honest = zeros_stream(CompressionType::LZ4_FRAME, rows);
    let p = dir.path().join("bomb.arrows");
    std::fs::write(&p, &honest).unwrap();
    let l = Limits {
        max_decoded_bytes: 64 << 20,
        ..Limits::default()
    };
    assert_eq!(read_all(&p, &l).unwrap(), rows as u64, "honest file reads");
    std::fs::write(&p, lie(honest.clone(), (rows * 8) as i64, 1024)).unwrap();
    let e = open(&p, &l).expect_err("lying LZ4 prefix");
    assert!(matches!(e, Error::Malformed(_)), "{e}");
    // The other direction: a prefix larger than the frame is refused too.
    std::fs::write(&p, lie(honest, (rows * 8) as i64, (rows * 8 + 1) as i64)).unwrap();
    assert!(matches!(open(&p, &l), Err(Error::Malformed(_))));
}

#[test]
fn zstd_prefix_lies_end_typed() {
    let dir = tempfile::tempdir().unwrap();
    let rows = 1 << 20;
    let honest = zeros_stream(CompressionType::ZSTD, rows);
    let p = dir.path().join("z.arrows");
    for to in [1024i64, (rows * 8 + 1) as i64] {
        std::fs::write(&p, lie(honest.clone(), (rows * 8) as i64, to)).unwrap();
        let l = Limits {
            max_decoded_bytes: 64 << 20,
            ..Limits::default()
        };
        assert!(read_all(&p, &l).is_err(), "zstd prefix {to}");
    }
}

#[test]
fn reads_use_the_validated_generation_after_source_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("t.arrows");
    std::fs::copy(fx("wide.arrows"), &p).unwrap();
    let s = open(&p, &Limits::default()).unwrap();
    let expected: Vec<_> = s.batches().unwrap().map(Result::unwrap).collect();
    std::fs::copy(fx("wide-zstd.arrows"), &p).unwrap();
    let got: Vec<_> = s.batches().unwrap().map(Result::unwrap).collect();
    assert_eq!(got, expected);
}

#[test]
fn same_size_same_mtime_rewrite_cannot_change_validated_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("t.arrows");
    std::fs::copy(fx("wide.arrows"), &p).unwrap();
    let time = std::fs::metadata(&p).unwrap().modified().unwrap();
    let s = open(&p, &Limits::default()).unwrap();
    let expected: Vec<_> = s.batches().unwrap().map(Result::unwrap).collect();
    let mut first = s.batches().unwrap();
    let mut second = s.batches().unwrap();
    let size = std::fs::metadata(&p).unwrap().len() as usize;
    std::fs::write(&p, vec![0; size]).unwrap();
    std::fs::File::open(&p)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(time))
        .unwrap();
    let late: Vec<_> = s.batches().unwrap().map(Result::unwrap).collect();
    assert_eq!(late, expected);
    drop(s);
    for want in expected {
        assert_eq!(first.next().unwrap().unwrap(), want);
        assert_eq!(second.next().unwrap().unwrap(), want);
    }
    assert!(first.next().is_none());
    assert!(second.next().is_none());
}

#[test]
fn dictionaries_together_are_bounded() {
    use arrow_array::{DictionaryArray, StringArray, types::Int32Type};
    let schema = Arc::new(Schema::new(vec![Field::new(
        "d",
        DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8)),
        false,
    )]));
    let mut w = StreamWriter::try_new_with_options(Vec::new(), &schema, IpcWriteOptions::default())
        .unwrap();
    // Distinct, growing dictionaries sent as replacements are not cumulative; deltas are.
    for i in 0..4 {
        let vals = StringArray::from(vec![format!("{}{i}", "x".repeat(4096))]);
        let keys = arrow_array::Int32Array::from(vec![0]);
        let d = DictionaryArray::<Int32Type>::try_new(keys, Arc::new(vals)).unwrap();
        w.write(&RecordBatch::try_new(schema.clone(), vec![Arc::new(d)]).unwrap())
            .unwrap();
    }
    let bytes = w.into_inner().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("d.arrows");
    std::fs::write(&p, bytes).unwrap();
    assert_eq!(
        read_all(&p, &Limits::default()).unwrap(),
        4,
        "replacements each fit"
    );
    let l = Limits {
        max_decoded_bytes: 6 << 10,
        ..Limits::default()
    };
    assert!(
        read_all(&p, &l).is_ok(),
        "replacement dictionaries replace, they do not add"
    );
}

#[test]
fn footer_metadata_uses_the_validated_generation_after_path_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("metadata.feather");
    let batch = RecordBatch::try_from_iter(vec![(
        "i",
        Arc::new(Int64Array::from(vec![1])) as arrow_array::ArrayRef,
    )])
    .unwrap();
    let mut writer =
        arrow_ipc::writer::FileWriter::try_new(std::fs::File::create(&p).unwrap(), &batch.schema())
            .unwrap();
    writer.write_metadata("owner", "σ😀");
    writer.write(&batch).unwrap();
    writer.finish().unwrap();
    drop(writer);
    let source = open(&p, &Limits::default()).unwrap();
    std::fs::write(&p, b"replaced").unwrap();
    assert_eq!(
        source
            .custom_metadata()
            .unwrap()
            .get("owner")
            .map(String::as_str),
        Some("σ😀")
    );
    assert_eq!(source.batches().unwrap().next().unwrap().unwrap(), batch);
}
