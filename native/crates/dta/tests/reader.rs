use dfv_table_dta::{Cell, Error, Limits, from_bytes, open, storage_width};
use dta::stata::dta::{byte_order::ByteOrder, variable_type::VariableType};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}
fn truth() -> Value {
    serde_json::from_slice(&std::fs::read(fixtures().join("expected.json")).unwrap()).unwrap()
}
fn cell(c: &Cell) -> Value {
    match c {
        Cell::Integer(n) => json!({"integer":n}),
        Cell::Float(n) => json!({"float":n}),
        Cell::Text(s) => json!({"text":s}),
        Cell::Missing(s) => json!({"missing":s}),
        Cell::Binary(b) => json!({"binary":b}),
    }
}
#[test]
fn metadata_values_and_paging_match_readstat_and_pandas() {
    let mut cells = 0;
    for (name, e) in truth().as_object().unwrap() {
        let path = fixtures().join(name);
        let before = std::fs::read(&path).unwrap();
        let s = open(&path, &Limits::default()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(s.read_only());
        assert_eq!(
            s.header.release() as u8 as u64,
            e["release"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(s.header.dataset_label(), e["label"].as_str().unwrap());
        if name.ends_with("-be.dta") {
            assert_eq!(s.header.byte_order(), ByteOrder::BigEndian);
        }
        for (v, want) in s
            .schema
            .variables()
            .iter()
            .zip(e["columns"].as_array().unwrap())
        {
            assert_eq!(v.name(), want["name"].as_str().unwrap(), "{name}");
            assert_eq!(
                v.label(),
                want["label"].as_str().unwrap(),
                "{name}/{} label",
                v.name()
            );
            assert_eq!(
                v.format(),
                want["format"].as_str().unwrap(),
                "{name}/{} format",
                v.name()
            );
            assert_eq!(v.value_label_name(), want["value_label"].as_str().unwrap());
            let (kind, width) = match v.variable_type() {
                VariableType::Byte => ("int8", 1),
                VariableType::Int => ("int16", 2),
                VariableType::Long => ("int32", 4),
                VariableType::Float => ("float", 4),
                VariableType::Double => ("double", 8),
                VariableType::FixedString(n) => ("string", usize::from(n) + 1),
                VariableType::LongString => ("string", 0),
            };
            // ReadStat includes a trailing C NUL in fixed-string storage metadata, and uses 0 for strL.
            assert_eq!(kind, want["kind"].as_str().unwrap());
            assert_eq!(width, want["width"].as_u64().unwrap() as usize);
            assert!(storage_width(v.variable_type()) > 0);
        }
        assert_eq!(
            s.schema.variables().len(),
            e["columns"].as_array().unwrap().len()
        );
        let labels: serde_json::Map<_, _> = s
            .value_labels
            .iter()
            .map(|set| {
                (
                    set.name().to_string(),
                    Value::Object(
                        set.entries()
                            .iter()
                            .map(|entry| (entry.value().to_string(), json!(entry.label())))
                            .collect(),
                    ),
                )
            })
            .collect();
        assert_eq!(
            Value::Object(labels),
            e["value_labels"],
            "{name} value labels"
        );
        assert_eq!(
            s.header.observation_count(),
            e["row_count"].as_u64().unwrap()
        );
        let all: Vec<_> = e["offsets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|at| s.read_rows(at.as_u64().unwrap(), 1).unwrap().remove(0))
            .collect();
        let got: Vec<_> = all
            .iter()
            .map(|r| r.iter().map(cell).collect::<Vec<_>>())
            .collect();
        assert_eq!(json!(got), e["rows"], "{name} values");
        for (row, expected) in all.iter().zip(e["rows"].as_array().unwrap()) {
            for (value, want) in row.iter().zip(expected.as_array().unwrap()) {
                if let Cell::Float(value) = value {
                    assert_eq!(
                        value.to_bits(),
                        want["float"].as_f64().unwrap().to_bits(),
                        "{name}: float bits"
                    );
                }
            }
        }
        for (at, row) in e["offsets"].as_array().unwrap().iter().zip(&all) {
            assert_eq!(
                s.read_rows(at.as_u64().unwrap(), 1).unwrap(),
                vec![row.clone()]
            );
            cells += row.len();
        }
        assert!(s.read_rows(u64::MAX, usize::MAX).unwrap().is_empty());
        assert!(s.read_rows(0, 0).unwrap().is_empty());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
    assert!(cells >= 200);
}

#[test]
fn source_generation_is_immutable_and_sendable() {
    fn check<T: Send + Sync>() {}
    check::<dfv_table_dta::Source>();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.dta");
    std::fs::copy(fixtures().join("v118-le.dta"), &path).unwrap();
    let s = open(&path, &Limits::default()).unwrap();
    let expected = s.read_rows(0, 4).unwrap();
    std::fs::write(path, b"replaced").unwrap();
    assert_eq!(s.read_rows(0, 4).unwrap(), expected);
}

#[test]
fn caller_budgets_refuse_before_returning_excess_data() {
    let bytes: Arc<[u8]> = std::fs::read(fixtures().join("v118-le.dta"))
        .unwrap()
        .into();
    for limits in [
        Limits {
            file_bytes: 1,
            ..Limits::default()
        },
        Limits {
            metadata_bytes: 1,
            ..Limits::default()
        },
        Limits {
            columns: 1,
            ..Limits::default()
        },
        Limits {
            row_bytes: 1,
            ..Limits::default()
        },
        Limits {
            cell_bytes: 1,
            ..Limits::default()
        },
        Limits {
            metadata_entries: 1,
            ..Limits::default()
        },
    ] {
        assert!(matches!(
            from_bytes(bytes.clone(), &limits),
            Err(Error::TooLarge(_))
        ));
    }
    for limits in [
        Limits {
            page_cells: 1,
            ..Limits::default()
        },
        Limits {
            page_bytes: 1,
            ..Limits::default()
        },
    ] {
        let s = from_bytes(bytes.clone(), &limits).unwrap();
        assert!(matches!(s.read_rows(0, 4), Err(Error::TooLarge(_))));
    }
}

#[test]
fn legacy_and_unknown_versions_have_explicit_refusals() {
    for bytes in [
        vec![114, 2, 1, 0],
        b"<stata_dta><header><release>121</release>".to_vec(),
        b"not Stata".to_vec(),
    ] {
        assert!(matches!(
            from_bytes(bytes.into(), &Limits::default()),
            Err(Error::Unsupported(_))
        ));
    }
}
