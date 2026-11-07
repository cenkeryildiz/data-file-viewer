use arrow_array::{Array, ArrayRef, Int64Array, LargeStringArray, RecordBatch, UInt64Array};
use arrow_cast::cast;
use arrow_ipc::writer::{FileWriter, StreamWriter};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use dfv_table_arrow_ipc::{Codec, Container, Error, Limits, Source, cell_text, open};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

fn fx(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}
fn expected(name: &str) -> Value {
    let all: Value = serde_json::from_slice(&std::fs::read(fx("expected.json")).unwrap()).unwrap();
    all[name].clone()
}
fn src(name: &str) -> Source {
    open(&fx(name), &Limits::default()).unwrap_or_else(|e| panic!("{name}: {e}"))
}
fn err(name: &str, limits: &Limits) -> Error {
    open(&fx(name), limits).expect_err(name)
}

/// Per column: display text, or the epoch integer for timestamp columns (compared as the exact stored value).
fn columns(s: &Source) -> Vec<Vec<Option<String>>> {
    let mut cols = vec![Vec::new(); s.display_schema.fields().len()];
    for b in s.batches().unwrap() {
        let b = s.display_batch(&b.unwrap()).unwrap();
        for (i, c) in b.columns().iter().enumerate() {
            let c: ArrayRef = if matches!(c.data_type(), DataType::Timestamp(..)) {
                cast(c, &DataType::Int64).unwrap()
            } else {
                c.clone()
            };
            for r in 0..c.len() {
                cols[i].push(cell_text(c.as_ref(), r).unwrap());
            }
        }
    }
    cols
}
fn assert_matches_pyarrow(name: &str, s: &Source) {
    let e = expected(name);
    assert_eq!(s.rows, e["rows"].as_u64().unwrap(), "{name} rows");
    let got = columns(s);
    for (i, ec) in e["columns"].as_array().unwrap().iter().enumerate() {
        let f = s.original_schema.field(i);
        assert_eq!(f.name(), ec["name"].as_str().unwrap(), "{name} column name");
        assert_eq!(
            f.is_nullable(),
            ec["nullable"].as_bool().unwrap(),
            "{name}.{} nullable",
            f.name()
        );
        let md: std::collections::HashMap<String, String> = ec["metadata"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().into()))
            .collect();
        assert_eq!(f.metadata(), &md, "{name}.{} field metadata", f.name());
        let want: Vec<Option<String>> = ec["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().map(String::from))
            .collect();
        assert_eq!(got[i], want, "{name}.{}", f.name());
    }
    for (k, v) in e["schema_metadata"].as_object().unwrap() {
        assert_eq!(
            s.original_schema.metadata().get(k).map(String::as_str),
            v.as_str(),
            "{name} schema metadata {k}"
        );
    }
}

#[test]
fn wide_matches_pyarrow_in_every_container_and_codec() {
    for (name, container, codec) in [
        ("wide.arrows", Container::Stream, None),
        ("wide.feather", Container::File, None),
        ("wide-lz4.arrows", Container::Stream, Some(Codec::Lz4Frame)),
        ("wide-lz4.feather", Container::File, Some(Codec::Lz4Frame)),
        ("wide-zstd.arrows", Container::Stream, Some(Codec::Zstd)),
        ("wide-zstd.feather", Container::File, Some(Codec::Zstd)),
    ] {
        let s = src(name);
        assert_eq!(s.container, container, "{name}");
        assert_eq!(s.codecs, codec.into_iter().collect::<Vec<_>>(), "{name}");
        assert_eq!(s.record_batches, 3, "{name}");
        // PyArrow's expected file is the uncompressed one; the codec must not change a single value.
        assert_matches_pyarrow(
            if name.ends_with("arrows") {
                "wide.arrows"
            } else {
                "wide.feather"
            },
            &s,
        );
    }
}

#[test]
fn original_schema_keeps_timezone_decimal_nullability_and_dictionary_while_display_schema_flattens()
{
    let s = src("wide.feather");
    let f = |n: &str| s.original_schema.field_with_name(n).unwrap().clone();
    assert_eq!(
        f("ts_utc").data_type(),
        &DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into()))
    );
    assert_eq!(
        f("ts_off").data_type(),
        &DataType::Timestamp(TimeUnit::Millisecond, Some("+05:30".into()))
    );
    assert_eq!(f("dec").data_type(), &DataType::Decimal128(21, 4));
    assert!(!f("i64").is_nullable() && f("nul").is_nullable());
    assert_eq!(f("lstr").data_type(), &DataType::LargeUtf8);
    assert!(matches!(f("cat").data_type(), DataType::Dictionary(..)));
    let d = s.display_schema.field_with_name("cat").unwrap();
    assert_eq!(d.data_type(), &DataType::Utf8);
    assert_eq!(
        s.display_schema.field_with_name("dec").unwrap().data_type(),
        &DataType::Decimal128(21, 4)
    );
    assert_eq!(s.display_schema.metadata(), s.original_schema.metadata());
    // The all-null column stays all-null (no invented values).
    assert!(
        columns(&s)[s.original_schema.index_of("nul").unwrap()]
            .iter()
            .all(Option::is_none)
    );
}

#[test]
fn integers_beyond_2_pow_53_are_exact() {
    for name in ["wide.arrows", "wide-zstd.feather", "polars-view.feather"] {
        let s = src(name);
        let cols = columns(&s);
        let col = &cols[0];
        assert!(col.contains(&Some("9007199254740993".into())), "{name}");
        if name.starts_with("wide") {
            assert!(
                col.contains(&Some("9223372036854775807".into()))
                    && col.contains(&Some("-9223372036854775808".into()))
            );
            let u = &cols[1];
            assert!(
                u.contains(&Some("18446744073709551615".into()))
                    && u.contains(&Some("9223372036854775808".into()))
            );
            // The stored arrays themselves hold the exact values too (not just the text).
            let b = s.batches().unwrap().next().unwrap().unwrap();
            assert_eq!(
                b.column(0)
                    .as_any()
                    .downcast_ref::<Int64Array>()
                    .unwrap()
                    .value(0),
                (1i64 << 53) + 1
            );
            assert_eq!(
                s.batches()
                    .unwrap()
                    .map(|b| b
                        .unwrap()
                        .column(1)
                        .as_any()
                        .downcast_ref::<UInt64Array>()
                        .unwrap()
                        .value(0))
                    .next(),
                Some(u64::MAX)
            );
        }
    }
}

#[test]
fn dictionaries_resolve_across_batches_delta_and_replacement() {
    for name in ["dict-delta.arrows", "dict-replace.arrows"] {
        let s = src(name);
        assert_eq!(s.record_batches, 3);
        assert_matches_pyarrow(name, &s);
        assert_eq!(
            columns(&s)[0],
            ["a", "b", "c", "a", "x", "y"].map(|v| Some(v.to_string())),
            "{name}"
        );
    }
}

#[test]
fn polars_view_strings_and_categoricals_open_as_plain_strings() {
    for name in [
        "polars-view.feather",
        "polars-view.arrows",
        "polars-oldest.feather",
        "polars-zstd.feather",
        "polars-lz4.feather",
    ] {
        let s = src(name);
        assert_matches_pyarrow(
            if name.ends_with("arrows") {
                "polars-view.arrows"
            } else {
                name
            },
            &s,
        );
        for col in ["s", "c"] {
            // Plain Utf8 or LargeUtf8 (polars' oldest compat level); never a view or a dictionary.
            let t = s
                .display_schema
                .field_with_name(col)
                .unwrap()
                .data_type()
                .clone();
            assert!(
                matches!(t, DataType::Utf8 | DataType::LargeUtf8),
                "{name}.{col}: {t}"
            );
        }
    }
    assert_eq!(
        src("polars-view.feather")
            .original_schema
            .field_with_name("s")
            .unwrap()
            .data_type(),
        &DataType::Utf8View
    );
}

#[test]
fn zero_row_tables_are_empty_not_damaged() {
    for name in ["empty.arrows", "empty.feather"] {
        let s = src(name);
        assert_eq!((s.rows, s.record_batches), (0, 0), "{name}");
        assert_eq!(s.original_schema.fields().len(), 10);
        assert_eq!(s.batches().unwrap().count(), 0);
    }
}

#[test]
fn damaged_and_foreign_files_are_refused_with_their_reason() {
    let l = Limits::default();
    assert!(matches!(err("v1.feather", &l), Error::FeatherV1));
    for n in [
        "truncated-90.arrows",
        "truncated-50.arrows",
        "no-eos.arrows",
        "truncated.feather",
        "no-tail.feather",
    ] {
        assert!(
            matches!(err(n, &l), Error::Truncated(_) | Error::Malformed(_)),
            "{n}: {}",
            err(n, &l)
        );
    }
    for n in [
        "truncated-90.arrows",
        "truncated-50.arrows",
        "no-eos.arrows",
    ] {
        assert!(
            matches!(err(n, &l), Error::Truncated(_)),
            "{n} must be Truncated, never an empty table"
        );
    }
    for n in ["empty.bin", "text.arrows", "parquet-in-disguise.arrows"] {
        assert!(matches!(err(n, &l), Error::NotArrow(_)), "{n}");
    }
}

#[test]
fn flipped_footer_and_message_bytes_are_malformed_not_a_panic() {
    let dir = tempfile::tempdir().unwrap();
    let good = std::fs::read(fx("wide.feather")).unwrap();
    for (i, at) in [good.len() - 20, good.len() - 40, 8 + 4 + 12, 20]
        .into_iter()
        .enumerate()
    {
        let mut bad = good.clone();
        for b in &mut bad[at..at + 6] {
            *b ^= 0xff;
        }
        let p = dir.path().join(format!("flip{i}.feather"));
        std::fs::write(&p, bad).unwrap();
        if let Ok(s) = open(&p, &Limits::default()) {
            // If validation passes, decoding must still end in a value or an error, never a panic.
            for b in s.batches().unwrap() {
                let _ = b;
            }
        }
    }
}

#[test]
fn limits_refuse_before_decoding() {
    let tight = |f: fn(&mut Limits)| {
        let mut l = Limits::default();
        f(&mut l);
        l
    };
    assert!(
        matches!(
            err("lying-prefix.arrows", &Limits::default()),
            Error::TooLarge(_)
        ),
        "a codec prefix claiming 2 GiB"
    );
    assert!(
        open(&fx("big-zero.arrows"), &Limits::default()).is_ok(),
        "8 MB decoded is fine by default"
    );
    assert!(
        matches!(
            err("big-zero.arrows", &tight(|l| l.max_decoded_bytes = 1 << 20)),
            Error::TooLarge(_)
        ),
        "zstd bomb: ~4 KB on disk, 8 MB decoded"
    );
    assert!(matches!(
        err("wide.arrows", &tight(|l| l.max_body_bytes = 16)),
        Error::TooLarge(_)
    ));
    assert!(matches!(
        err("wide.feather", &tight(|l| l.max_body_bytes = 16)),
        Error::Malformed(_) | Error::TooLarge(_)
    ));
    assert!(matches!(
        err("wide.arrows", &tight(|l| l.max_messages = 2)),
        Error::TooLarge(_)
    ));
    assert!(matches!(
        err("wide.arrows", &tight(|l| l.max_metadata_bytes = 8)),
        Error::TooLarge(_)
    ));
}

#[test]
fn sliced_arrays_with_nonzero_offsets_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let schema = Arc::new(Schema::new(vec![
        Field::new("i", DataType::Int64, true),
        Field::new("s", DataType::LargeUtf8, true),
    ]));
    let full = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int64Array::from(vec![
                Some(1),
                None,
                Some((1i64 << 53) + 1),
                Some(i64::MIN),
                Some(5),
            ])),
            Arc::new(LargeStringArray::from(vec![
                Some("a"),
                Some("bb"),
                None,
                Some("σ"),
                Some("e"),
            ])),
        ],
    )
    .unwrap();
    let sliced = full.slice(2, 3);
    let want = [
        vec![
            Some("9007199254740993".to_string()),
            Some("-9223372036854775808".into()),
            Some("5".into()),
        ],
        vec![None, Some("σ".into()), Some("e".into())],
    ];
    let (pf, ps) = (
        dir.path().join("slice.feather"),
        dir.path().join("slice.arrows"),
    );
    let mut w = FileWriter::try_new(std::fs::File::create(&pf).unwrap(), &schema).unwrap();
    w.write(&sliced).unwrap();
    w.finish().unwrap();
    let mut w = StreamWriter::try_new(std::fs::File::create(&ps).unwrap(), &schema).unwrap();
    w.write(&sliced).unwrap();
    w.finish().unwrap();
    for p in [pf, ps] {
        let s = open(&p, &Limits::default()).unwrap();
        assert_eq!(s.rows, 3);
        assert_eq!(columns(&s), want);
    }
}

#[test]
fn timestamps_display_with_utc_offset_and_named_zone_fallback() {
    use arrow_array::TimestampSecondArray;
    let dir = tempfile::tempdir().unwrap();
    let tz = |z: &str| DataType::Timestamp(TimeUnit::Second, Some(z.into()));
    let schema = Arc::new(Schema::new(vec![
        Field::new("utc", tz("UTC"), true),
        Field::new("off", tz("+05:30"), true),
        Field::new("named", tz("Europe/Istanbul"), true),
    ]));
    let col = |z: &str| -> ArrayRef {
        Arc::new(TimestampSecondArray::from(vec![Some(86_400), None]).with_timezone(z))
    };
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![col("UTC"), col("+05:30"), col("Europe/Istanbul")],
    )
    .unwrap();
    let p = dir.path().join("tz.feather");
    let mut w = FileWriter::try_new(std::fs::File::create(&p).unwrap(), &schema).unwrap();
    w.write(&batch).unwrap();
    w.finish().unwrap();
    let s = open(&p, &Limits::default()).unwrap();
    let b = s.batches().unwrap().next().unwrap().unwrap();
    let text = |i: usize, r: usize| cell_text(b.column(i).as_ref(), r).unwrap();
    assert_eq!(text(0, 0).unwrap(), "1970-01-02T00:00:00Z [UTC]"); // "UTC" is a named zone to arrow-cast without chrono-tz
    assert_eq!(text(1, 0).unwrap(), "1970-01-02T05:30:00+05:30");
    assert_eq!(
        text(2, 0).unwrap(),
        "1970-01-02T00:00:00Z [Europe/Istanbul]"
    ); // UTC instant + zone name: no chrono-tz offline
    assert_eq!(text(2, 1), None);
    assert_eq!(
        s.original_schema.field(2).data_type(),
        &tz("Europe/Istanbul")
    );
}
