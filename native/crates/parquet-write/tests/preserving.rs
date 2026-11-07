use dfv_table_parquet_write::{CellEdit, Error, Limits, prepare_edit, save_cell};
use dfv_table_publication::{Protection, Publisher, digest};
use std::path::Path;
use std::process::Command;
fn python(args: &[&str]) {
    let executable = std::env::var("DFV_REF_PYTHON")
        .expect("DFV_REF_PYTHON is required for independent qualification");
    let output = Command::new(executable)
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/oracle.py"))
        .args(args)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn fixtures() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    python(&["generate", d.path().to_str().unwrap()]);
    d
}
fn edit<'a>(column: &'a str, value: Option<&'a str>) -> CellEdit<'a> {
    CellEdit {
        column,
        value,
        row: &[("id", Some("1"))],
    }
}
#[test]
fn independent_full_schema_metadata_values_and_safe_publication() {
    let d = fixtures();
    for codec in ["snappy", "gzip", "zstd", "lz4", "NONE"] {
        for version in ["1.0", "2.0"] {
            let source = d.path().join(format!("{codec}-{version}.parquet"));
            for (column, value) in [
                ("text", Some("edited 中文")),
                ("amount", Some("99999999999999999999999999999999.123456")),
                ("text", None),
                ("id", Some("9223372036854775807")),
            ] {
                let original = std::fs::read(&source).unwrap();
                let prepared =
                    prepare_edit(&source, &Limits::default(), &edit(column, value)).unwrap();
                assert_eq!(std::fs::read(&source).unwrap(), original);
                let stage = d.path().join("stage.parquet");
                std::io::copy(
                    &mut prepared.reader().unwrap(),
                    &mut std::fs::File::create(&stage).unwrap(),
                )
                .unwrap();
                python(&[
                    "verify",
                    source.to_str().unwrap(),
                    stage.to_str().unwrap(),
                    column,
                    value.unwrap_or("<NULL>"),
                ]);
            }
        }
    }
    let target = d.path().join("target.parquet");
    std::fs::copy(d.path().join("snappy-1.0.parquet"), &target).unwrap();
    let publisher = Publisher::new(&d.path().join("receipts"), Protection::default()).unwrap();
    let lock = publisher.lock(&target).unwrap();
    save_cell(
        &publisher,
        &lock,
        &Limits::default(),
        &edit("text", Some("published")),
    )
    .unwrap();
    python(&[
        "verify",
        d.path().join("snappy-1.0.parquet").to_str().unwrap(),
        target.to_str().unwrap(),
        "text",
        "published",
    ]);
}
#[test]
fn refusals_preserve_source() {
    let d = fixtures();
    for name in [
        "indexed.parquet",
        "sorted.parquet",
        "brotli.parquet",
        "empty.parquet",
        "int96.parquet",
    ] {
        let path = d.path().join(name);
        let old = std::fs::read(&path).unwrap();
        assert!(
            matches!(
                prepare_edit(&path, &Limits::default(), &edit("text", Some("x"))),
                Err(Error::Unsupported(_))
            ),
            "{name}"
        );
        assert_eq!(digest(&std::fs::read(path).unwrap()), digest(&old));
    }
    let source = d.path().join("snappy-1.0.parquet");
    for request in [
        edit("amount", Some("1.0000001")),
        edit("id", None),
        edit("nested", Some("[]")),
        edit("missing", Some("x")),
        CellEdit {
            column: "text",
            value: Some("x"),
            row: &[],
        },
        CellEdit {
            column: "text",
            value: Some("x"),
            row: &[("id", Some("404"))],
        },
    ] {
        let old = std::fs::read(&source).unwrap();
        assert!(prepare_edit(&source, &Limits::default(), &request).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), old);
    }
    assert!(matches!(
        prepare_edit(
            &d.path().join("ambiguous.parquet"),
            &Limits::default(),
            &edit("text", Some("x"))
        ),
        Err(Error::Edit(dfv_table_arrow_write::Error::Ambiguous(2)))
    ));
    let tiny = Limits {
        file_bytes: 12,
        ..Limits::default()
    };
    assert!(matches!(
        prepare_edit(&source, &tiny, &edit("text", Some("x"))),
        Err(Error::TooLarge(_))
    ));
    for limits in [
        Limits {
            footer_bytes: 4,
            ..Limits::default()
        },
        Limits {
            page_bytes: 1,
            ..Limits::default()
        },
        Limits {
            row_group_bytes: 1,
            ..Limits::default()
        },
        Limits {
            values: 1,
            ..Limits::default()
        },
        Limits {
            metadata_items: 2,
            ..Limits::default()
        },
        Limits {
            schema_nodes: 1,
            ..Limits::default()
        },
        Limits {
            columns: 1,
            ..Limits::default()
        },
        Limits {
            row_groups: 1,
            ..Limits::default()
        },
    ] {
        assert!(matches!(
            prepare_edit(&source, &limits, &edit("text", Some("x"))),
            Err(Error::TooLarge(_))
        ));
    }
    let mut truncated = std::fs::read(&source).unwrap();
    truncated.truncate(truncated.len() - 1);
    let path = d.path().join("truncated.parquet");
    std::fs::write(&path, truncated).unwrap();
    assert!(prepare_edit(&path, &Limits::default(), &edit("text", Some("x"))).is_err());
}

#[test]
fn ordered_duplicate_metadata_survives() {
    use arrow_array::{Int64Array, RecordBatch, StringArray};
    use parquet::arrow::ArrowWriter;
    use parquet::file::metadata::KeyValue;
    use parquet::file::properties::{EnabledStatistics, WriterProperties};
    use std::sync::Arc;
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("duplicate.parquet");
    let b = RecordBatch::try_from_iter(vec![
        (
            "id",
            Arc::new(Int64Array::from(vec![1, 2])) as arrow_array::ArrayRef,
        ),
        ("text", Arc::new(StringArray::from(vec!["before", "other"]))),
    ])
    .unwrap();
    let kv = vec![
        KeyValue::new("same".into(), Some("first".into())),
        KeyValue::new("middle".into(), None),
        KeyValue::new("same".into(), Some("last".into())),
    ];
    let props = WriterProperties::builder()
        .set_offset_index_disabled(true)
        .set_statistics_enabled(EnabledStatistics::Chunk)
        .set_key_value_metadata(Some(kv))
        .build();
    let mut writer = ArrowWriter::try_new(
        std::fs::File::create(&path).unwrap(),
        b.schema(),
        Some(props),
    )
    .unwrap();
    writer.write(&b).unwrap();
    writer.close().unwrap();
    let prepared = prepare_edit(&path, &Limits::default(), &edit("text", Some("after"))).unwrap();
    use std::io::Write;
    assert!(
        prepared
            .reader()
            .unwrap()
            .write_all(b"cannot mutate stage")
            .is_err()
    );
    let before = parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(
        std::fs::File::open(&path).unwrap(),
    )
    .unwrap();
    let after = parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(
        prepared.reader().unwrap(),
    )
    .unwrap();
    assert_eq!(
        before.metadata().file_metadata().key_value_metadata(),
        after.metadata().file_metadata().key_value_metadata()
    );
}

#[test]
fn source_change_refuses_atomic_publication() {
    let d = fixtures();
    let target = d.path().join("snappy-1.0.parquet");
    let publisher = Publisher::new(&d.path().join("receipts"), Protection::default()).unwrap();
    let lock = publisher.lock(&target).unwrap();
    let prepared = prepare_edit(&target, &Limits::default(), &edit("text", Some("new"))).unwrap();
    // A separate writer changes the destination after our immutable snapshot was validated.
    let other = std::fs::read(d.path().join("gzip-1.0.parquet")).unwrap();
    std::fs::write(&target, &other).unwrap();
    assert!(
        publisher
            .publish_reader(
                &lock,
                prepared.reader().unwrap(),
                prepared.length,
                &prepared.sha256,
                Some(&prepared.source)
            )
            .is_err()
    );
    assert_eq!(std::fs::read(target).unwrap(), other);
}
