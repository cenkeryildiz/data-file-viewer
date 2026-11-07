//! Writes edited copies of the D3.9 PyArrow/Polars fixtures into the evidence folder, with a manifest
//! that tools/verify.py reads back independently (PyArrow + Polars). Refusal cases assert that no byte
//! reaches the sink.
use dfv_table_arrow_ipc::Limits;
use dfv_table_arrow_write::{CellEdit, Error, edit_cell, edit_cell_to};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn fx(name: &str) -> PathBuf {
    let own = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    if own.exists() {
        own
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../arrow-ipc/tests/fixtures")
            .join(name)
    }
}
fn out_dir() -> PathBuf {
    std::env::var_os("D315C_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/test-output/arrow-write")
        })
}
fn run(
    fixture: &str,
    column: &str,
    value: Option<&str>,
    row: &[(&str, Option<&str>)],
) -> Result<Vec<u8>, Error> {
    edit_cell(
        &fx(fixture),
        &Limits::default(),
        &CellEdit { column, value, row },
    )
}

// (case, fixture, column, new text, row identity, expected Python value for the changed cell)
type Case = (
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    Vec<(&'static str, Option<&'static str>)>,
    &'static str,
);
fn cases() -> Vec<Case> {
    let i = |v| vec![("i64", Some(v))];
    vec![
        (
            "footer-metadata",
            "footer-metadata.feather",
            "str",
            Some("new"),
            i("7"),
            "'new'",
        ),
        (
            "utf8-stream",
            "wide.arrows",
            "str",
            Some("Ünï😀"),
            i("9007199254740993"),
            "'Ünï😀'",
        ),
        (
            "int64-exact-feather",
            "wide.feather",
            "i64",
            Some("9007199254740995"),
            vec![("u64", Some("9007199254740993"))],
            "9007199254740995",
        ),
        (
            "uint64-max-minus-one",
            "wide.arrows",
            "u64",
            Some("18446744073709551614"),
            i("7"),
            "18446744073709551614",
        ),
        (
            "decimal-uncompressed-feather",
            "wide.feather",
            "dec",
            Some("12345678901234567.8901"),
            i("0"),
            "Decimal('12345678901234567.8901')",
        ),
        (
            "timestamp-utc-zstd-stream",
            "nodec-zstd.arrows",
            "ts_utc",
            Some("2021-06-01 12:00:00.123456"),
            i("7"),
            "datetime(2021,6,1,12,0,0,123456,tzinfo=timezone.utc)",
        ),
        (
            "timestamp-offset",
            "wide.arrows",
            "ts_off",
            Some("2001-02-03 04:05:06.007"),
            i("-9223372036854775808"),
            "datetime(2001,2,3,4,5,6,7000,tzinfo=timezone(timedelta(hours=5,minutes=30)))",
        ),
        (
            "bool-to-null-lz4-stream",
            "nodec-lz4.arrows",
            "flag",
            None,
            i("7"),
            "None",
        ),
        (
            "float-lz4-feather",
            "nodec-lz4.feather",
            "f64",
            Some("-1.5e-7"),
            i("-9007199254740993"),
            "-1.5e-07",
        ),
        (
            "dictionary-zstd-stream",
            "nodec-zstd.arrows",
            "cat",
            Some("green"),
            i("7"),
            "'green'",
        ),
        (
            "all-null-int32-gets-max",
            "wide.feather",
            "nul",
            Some("2147483647"),
            i("7"),
            "2147483647",
        ),
        (
            "large-utf8-zstd-feather",
            "nodec-zstd.feather",
            "lstr",
            Some("łong"),
            i("7"),
            "'łong'",
        ),
        (
            "dictionary-existing-value",
            "wide.arrows",
            "cat",
            Some("blue"),
            i("0"),
            "'blue'",
        ),
        (
            "dictionary-to-null",
            "wide.feather",
            "cat",
            None,
            i("0"),
            "None",
        ),
        (
            "dictionary-delta",
            "dict-delta.arrows",
            "d",
            Some("a"),
            vec![("d", Some("b"))],
            "'a'",
        ),
        (
            "dictionary-replace",
            "dict-replace.arrows",
            "d",
            Some("y"),
            vec![("d", Some("x"))],
            "'y'",
        ),
        (
            "string-view",
            "polars-view.arrows",
            "s",
            Some("view"),
            vec![("n", Some("1"))],
            "'view'",
        ),
        (
            "view-dictionary",
            "polars-view.arrows",
            "c",
            Some("u"),
            vec![("n", Some("9007199254740993"))],
            "'u'",
        ),
        (
            "null-row-identity",
            "polars-view.arrows",
            "n",
            Some("5"),
            vec![("s", None)],
            "5",
        ),
    ]
}

#[test]
fn edits_keep_container_codec_schema_and_only_change_one_cell() {
    let dir = out_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let mut manifest = Vec::new();
    for (name, fixture, column, value, row, expect) in cases() {
        let bytes = run(fixture, column, value, &row).unwrap_or_else(|e| panic!("{name}: {e}"));
        let ext = Path::new(fixture).extension().unwrap().to_str().unwrap();
        let file = dir.join(format!("{name}.{ext}"));
        std::fs::write(&file, &bytes).unwrap();
        // Same container magic as the source: a stream never becomes a file or the reverse.
        let src = std::fs::read(fx(fixture)).unwrap();
        assert_eq!(
            &src[..6] == b"ARROW1",
            &bytes[..6] == b"ARROW1",
            "{name}: container kind"
        );
        // Re-validated by the reader crate: same container and the same compression codec.
        let (a, b) = (
            dfv_table_arrow_ipc::open(&fx(fixture), &Limits::default()).unwrap(),
            dfv_table_arrow_ipc::open(&file, &Limits::default()).unwrap(),
        );
        assert_eq!(
            (a.container, a.rows, a.record_batches),
            (b.container, b.rows, b.record_batches),
            "{name}"
        );
        let uniq = |s: &dfv_table_arrow_ipc::Source| {
            let mut c: Vec<_> = s.codecs.iter().map(|c| format!("{c:?}")).collect();
            c.sort();
            c.dedup();
            c
        };
        assert_eq!(uniq(&a), uniq(&b), "{name}: codec");
        manifest.push(json!({"case":name,"input":fx(fixture).canonicalize().unwrap(),"output":file,"column":column,"row":row,"expect":expect}));
    }
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec_pretty(&Value::Array(manifest)).unwrap(),
    )
    .unwrap();
}

struct Counting(usize);
impl std::io::Write for Counting {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0 += b.len();
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn refused(
    fixture: &str,
    column: &str,
    value: Option<&str>,
    row: &[(&str, Option<&str>)],
) -> Error {
    let mut sink = Counting(0);
    let e = edit_cell_to(
        &fx(fixture),
        &Limits::default(),
        &CellEdit { column, value, row },
        &mut sink,
    )
    .expect_err("must refuse");
    assert_eq!(
        sink.0, 0,
        "{column}={value:?}: a refusal wrote {} bytes",
        sink.0
    );
    e
}

#[test]
fn refusals_write_nothing() {
    for f in ["batch-metadata.arrows", "batch-metadata.feather"] {
        assert!(
            matches!(refused(f, "str", Some("new"), &[("i64", Some("7"))]), Error::Unsupported(m) if m.contains("message metadata"))
        );
    }
    let i = [("i64", Some("7"))];
    assert!(
        matches!(refused("wide.arrows", "cat", Some("purple"), &i), Error::Unsupported(m) if m.contains("dictionary"))
    );
    assert!(matches!(
        refused("wide.arrows", "i64", None, &i),
        Error::NotNullable(_)
    ));
    assert!(matches!(
        refused("wide.arrows", "str", Some("x"), &[("nul", None)]),
        Error::Ambiguous(6)
    ));
    assert!(matches!(
        refused("wide.arrows", "str", Some("x"), &[("i64", Some("123"))]),
        Error::NoMatch
    ));
    assert!(matches!(
        refused("empty.arrows", "str", Some("x"), &i),
        Error::NoMatch
    ));
    assert!(matches!(
        refused("wide.arrows", "str", Some("x"), &[]),
        Error::NoRowIdentity
    ));
    assert!(matches!(
        refused("wide.arrows", "nope", Some("x"), &i),
        Error::NoSuchColumn(_)
    ));
    assert!(matches!(
        refused("wide.arrows", "str", Some("x"), &[("nope", None)]),
        Error::NoSuchColumn(_)
    ));
    // Compressed + Decimal128 would give a file Polars cannot open (arrow-rs layout): refused up front.
    for f in ["wide-lz4.feather", "wide-zstd.arrows"] {
        assert!(
            matches!(refused(f, "str", Some("x"), &i), Error::Unsupported(m) if m.contains("decimal")),
            "{f}"
        );
    }
    // Values the column cannot hold exactly.
    for (column, value) in [
        ("dec", "1.00001"),
        ("dec", "1e3"),
        ("dec", "999999999999999999999.0"),
        ("i64", "abc"),
        ("i64", "1.5"),
        ("i64", "9223372036854775808"),
        ("u64", "-1"),
        ("nul", "2147483648"),
        ("flag", "maybe"),
        ("ts_off", "2001-02-03 04:05:06.0071"),
        ("ts_utc", "2021-06-01 12:00:00.1234567"),
        ("ts_utc", "not a time"),
    ] {
        assert!(
            matches!(
                refused("wide.arrows", column, Some(value), &i),
                Error::InvalidValue(_)
            ),
            "{column}={value}"
        );
    }
}

#[test]
fn unusable_sources_are_refused_by_the_reader() {
    for f in [
        "v1.feather",
        "truncated.feather",
        "no-eos.arrows",
        "text.arrows",
        "parquet-in-disguise.arrows",
    ] {
        assert!(
            matches!(refused(f, "x", Some("1"), &[("y", None)]), Error::Source(_)),
            "{f}"
        );
    }
}
