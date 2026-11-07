//! D3.9 type zoo against PyArrow (and Polars-written files): every column's original type, field
//! metadata and displayed text must match what an independent reader sees, in every container and codec.
use arrow_array::{Array, ArrayRef};
use arrow_cast::cast;
use arrow_schema::DataType;
use dfv_table_arrow_ipc::{Codec, Container, Limits, Source, cell_text, open};
use serde_json::Value;
use std::path::PathBuf;

fn fx(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}
fn json(name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(fx(name)).unwrap()).unwrap()
}
fn column_text(s: &Source, i: usize, raw_instants: bool) -> Vec<Option<String>> {
    let mut out = Vec::new();
    for b in s.batches().unwrap() {
        let b = s.display_batch(&b.unwrap()).unwrap();
        let c: ArrayRef = match b.column(i).data_type() {
            DataType::Timestamp(..) | DataType::Duration(_) if raw_instants => {
                cast(b.column(i), &DataType::Int64).unwrap()
            }
            _ => b.column(i).clone(),
        };
        out.extend((0..c.len()).map(|r| cell_text(c.as_ref(), r).unwrap()));
    }
    out
}

#[test]
fn type_zoo_matches_pyarrow_in_every_container_and_codec() {
    let e = json("expected-types.json");
    for (name, container, codec) in [
        ("types.arrows", Container::Stream, None),
        ("types.feather", Container::File, None),
        ("types-zstd.arrows", Container::Stream, Some(Codec::Zstd)),
        ("types-zstd.feather", Container::File, Some(Codec::Zstd)),
        ("types-lz4.arrows", Container::Stream, Some(Codec::Lz4Frame)),
        ("types-lz4.feather", Container::File, Some(Codec::Lz4Frame)),
    ] {
        let s = open(&fx(name), &Limits::default()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            (s.container, s.codecs.clone(), s.rows, s.record_batches),
            (container, codec.into_iter().collect(), 4, 2),
            "{name}"
        );
        for (k, v) in e["schema_metadata"].as_object().unwrap() {
            assert_eq!(
                s.original_schema.metadata().get(k).map(String::as_str),
                v.as_str(),
                "{name} schema metadata"
            );
        }
        let mut bad = Vec::new();
        for (i, ec) in e["columns"].as_array().unwrap().iter().enumerate() {
            let col = ec["name"].as_str().unwrap();
            let f = s.original_schema.field(i);
            assert_eq!(f.name(), col);
            for (k, v) in ec["metadata"].as_object().unwrap() {
                assert_eq!(
                    f.metadata().get(k).map(String::as_str),
                    v.as_str(),
                    "{name}.{col} metadata"
                );
            }
            let want: Vec<Option<String>> = ec["values"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().map(String::from))
                .collect();
            let got = column_text(&s, i, true);
            if got != want {
                bad.push(format!("{col}: got {got:?} want {want:?}"));
            }
        }
        assert!(bad.is_empty(), "{name}:\n{}", bad.join("\n"));
    }
}

#[test]
fn polars_written_files_match_polars_in_every_container_and_codec() {
    let e = json("expected-polars-types.json");
    for (name, container, codec) in [
        ("polars-types.feather", Container::File, None),
        ("polars-types.arrows", Container::Stream, None),
        (
            "polars-types-zstd.feather",
            Container::File,
            Some(Codec::Zstd),
        ),
    ] {
        let s = open(&fx(name), &Limits::default()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            (s.container, s.codecs.clone(), s.rows),
            (
                container,
                codec.into_iter().collect(),
                e["rows"].as_u64().unwrap()
            ),
            "{name}"
        );
        // Polars writes Utf8View (and large lists/binary): the original keeps that, the display flattens it.
        assert_eq!(
            s.original_schema.field_with_name("s").unwrap().data_type(),
            &DataType::Utf8View,
            "{name}"
        );
        assert_eq!(
            s.display_schema.field_with_name("s").unwrap().data_type(),
            &DataType::Utf8,
            "{name}"
        );
        for (col, want) in e["columns"].as_object().unwrap() {
            let i = s.original_schema.index_of(col).unwrap();
            let got = column_text(&s, i, true);
            let want: Vec<Option<String>> = want
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().map(String::from))
                .collect();
            match col.as_str() {
                // Formatting conventions differ between libraries; presence must not.
                "f" | "dt" | "lst" => assert_eq!(
                    got.iter().map(Option::is_some).collect::<Vec<_>>(),
                    want.iter().map(Option::is_some).collect::<Vec<_>>(),
                    "{name}.{col}"
                ),
                "b" => assert_eq!(
                    got,
                    want.iter()
                        .map(|v| v.as_ref().map(|t| t.to_lowercase()))
                        .collect::<Vec<_>>(),
                    "{name}.{col}"
                ),
                _ => assert_eq!(got, want, "{name}.{col}"),
            }
        }
    }
}
