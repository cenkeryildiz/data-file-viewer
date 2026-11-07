//! D3.6: every file in tests/fixtures/parquet (written by PyArrow; tools/make_parquet_corpus.py) read through the
//! native engine and compared with tests/fixtures/parquet_expected.json: values and types as DuckDB-python casts
//! them (every cell cross-checked there against PyArrow, and Polars for plain columns) and the footer as PyArrow
//! reports it. Damaged files must be refused with a typed error. Nothing is read from outside a scratch copy.
use dfv_table_duckdb::{Engine, Error, Kind};
use serde_json::Value as J;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "dfv-d36-pq-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}
fn expected() -> J {
    serde_json::from_slice(&std::fs::read(fixtures().join("parquet_expected.json")).unwrap())
        .unwrap()
}
fn q(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn open_copy(dir: &Scratch, file: &str) -> Result<Engine, Error> {
    let to = dir.0.join(file);
    std::fs::copy(fixtures().join("parquet").join(file), &to).unwrap();
    Engine::open(&to)
}

#[test]
fn every_parquet_file_reads_as_the_independent_readers_do() {
    let exp = expected();
    let cases = exp["cases"].as_object().unwrap();
    assert!(cases.len() >= 34, "the independent corpus shrank");
    let dir = Scratch::new();
    let mut failures = vec![];
    let mut checked = 0;
    for (name, case) in cases {
        let file = case["file"].as_str().unwrap();
        let stem = file.trim_end_matches(".parquet");
        if case.get("duckdb_lossy_columns").is_some() {
            assert!(
                matches!(open_copy(&dir, file), Err(Error::Unsupported(message)) if message.contains("wider than 38 digits"))
            );
            checked += 1;
            continue;
        }
        let engine = match (open_copy(&dir, file), case.get("refused")) {
            (Err(Error::Engine(_) | Error::Invalid(_) | Error::Unsupported(_)), Some(_)) => {
                checked += 1;
                continue;
            }
            (Err(e), None) => {
                failures.push(format!("{name}: refused a readable file: {e}"));
                continue;
            }
            (Ok(_), Some(why)) => {
                failures.push(format!("{name}: opened a file the readers refuse ({why})"));
                continue;
            }
            (Err(e), Some(_)) => {
                failures.push(format!(
                    "{name}: refusal is not a typed engine error: {e:?}"
                ));
                continue;
            }
            (Ok(e), None) => e,
        };
        assert_eq!(engine.kind, Kind::Parquet);
        // values and types
        let describe = engine
            .run_query(&format!("describe select * from {}", q(stem)), 0)
            .unwrap();
        let col = |c: &str| describe.columns.iter().position(|x| x == c).unwrap();
        let got_cols: Vec<(String, String)> = describe
            .rows
            .iter()
            .map(|r| {
                (
                    r[col("column_name")].as_str().unwrap().to_owned(),
                    r[col("column_type")].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        let mut want_cols: Vec<(String, String)> = case["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["name"].as_str().unwrap().to_owned(),
                    c["type"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        if name == "nulls" {
            // DuckDB 1.5 binds a Parquet NULL column as INTEGER; every value remains NULL, with its footer retained.
            assert_eq!(want_cols[1], ("null_type".into(), "\"NULL\"".into()));
            assert!(
                case["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|row| row[1].is_null())
            );
            want_cols[1].1 = "INTEGER".into();
        }
        if got_cols != want_cols {
            failures.push(format!("{name}: columns {got_cols:?} != {want_cols:?}"));
            continue;
        }
        let cast: Vec<String> = got_cols
            .iter()
            .map(|(n, _)| format!("cast({} as varchar)", q(n)))
            .collect();
        let rows = engine
            .run_query(&format!("select {} from {}", cast.join(", "), q(stem)), 0)
            .unwrap();
        let got_rows: Vec<Vec<J>> = rows.rows;
        let want_rows: Vec<Vec<J>> = serde_json::from_value(case["rows"].clone()).unwrap();
        if got_rows != want_rows {
            failures.push(format!("{name}: rows {got_rows:?} != {want_rows:?}"));
            continue;
        }
        // footer
        if let Some(footer) = case.get("footer") {
            let info = engine.parquet_info().unwrap();
            let f = |k: &str| footer[k].as_i64().unwrap();
            if (info.num_rows, info.row_groups) != (f("num_rows"), f("row_groups")) {
                failures.push(format!("{name}: footer counts {info:?}"));
            }
            if info.created_by.as_deref() != footer["created_by"].as_str() {
                failures.push(format!("{name}: created_by {:?}", info.created_by));
            }
            let mut keys: Vec<String> = info
                .key_value_metadata
                .iter()
                .map(|k| k.key.clone())
                .collect();
            keys.sort();
            let want_keys: Vec<String> = serde_json::from_value(footer["kv_keys"].clone()).unwrap();
            // PyArrow also records its own ARROW:schema; DuckDB reports what the footer holds.
            if keys != want_keys {
                failures.push(format!("{name}: kv keys {keys:?} != {want_keys:?}"));
            }
            let leaves: Vec<_> = info
                .schema
                .iter()
                .filter(|c| c.num_children.is_none())
                .collect();
            let want_leaves = footer["leaves"].as_array().unwrap();
            if leaves.len() != want_leaves.len() {
                failures.push(format!(
                    "{name}: {} leaves != {}",
                    leaves.len(),
                    want_leaves.len()
                ));
            }
            for (got, want) in leaves.iter().zip(want_leaves) {
                let (physical, precision, scale) = (
                    want["physical"].as_str().unwrap(),
                    want["precision"].as_i64().unwrap_or(0),
                    want["scale"].as_i64().unwrap_or(0),
                );
                let leaf_name = want["name"].as_str().unwrap();
                let want_decimal = want["converted"].as_str() == Some("DECIMAL");
                let same_decimal = if want_decimal {
                    got.converted_type.as_deref() == Some("DECIMAL")
                        && (got.precision, got.scale) == (Some(precision), Some(scale))
                } else {
                    got.converted_type.as_deref() != Some("DECIMAL")
                };
                if got.name != leaf_name
                    || got.physical_type.as_deref() != Some(physical)
                    || !same_decimal
                {
                    failures.push(format!("{name}: leaf {got:?} != {want}"));
                }
            }
        }
        checked += 1;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(checked, cases.len());
}
