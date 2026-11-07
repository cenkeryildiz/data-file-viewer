//! D3.6: every case in tests/fixtures/csv_differential.json (written by tools/make_csv_differential.cjs from the
//! REFERENCE TypeScript reader running on @duckdb/node-api) replayed through the native engine. Types, values,
//! warnings and the locale report must be identical; a case may differ only where `DIVERGENCES` documents why.
//! Set DFV_D36_REPORT=<path> to also write the comparison as JSON (evidence).
use dfv_table_duckdb::duckdb::OpenOptions;
use dfv_table_duckdb::locale::NumberLocale;
use dfv_table_duckdb::{Engine, Error};
use serde_json::{Value as J, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

/// (case, why the native engine is allowed to differ). Empty means "identical to the reference".
const DIVERGENCES: &[(&str, &str)] = &[
    (
        "ambiguous_column",
        "The reference warns \"left as text\" but reads the column as DOUBLE (English reading, 1.234); the native engine does what the warning says and keeps the text, so a factor-of-1000 guess is never shown.",
    ),
    (
        "strong_column_resolves_weak",
        "The reference still warns \"left as text\" for a column the file's decided convention has already converted; native suppresses that stale warning and retains the locale diagnostics.",
    ),
    (
        "wide_300_columns",
        "The native marker projection handles 300 columns within the reader memory budget, so the all-marker columns become NULL with a notice; the reference leaves this fixture literal without a notice.",
    ),
    (
        "columns_disagree",
        "Native honors the file-level refusal to choose conflicting decimal conventions and keeps both columns literal. The reference converts them despite its notice saying none were converted.",
    ),
];

fn expected_native(name: &str, reference: &J) -> J {
    let mut expected = reference.clone();
    match name {
        "ambiguous_column" => expected["columns"][0]["type"] = json!("VARCHAR"),
        "strong_column_resolves_weak" => {
            expected["warnings"] = json!([]);
        }
        "wide_300_columns" => {
            for row in expected["rows"].as_array_mut().unwrap() {
                for (i, value) in row.as_array_mut().unwrap().iter_mut().enumerate() {
                    if i % 3 == 1 {
                        assert_eq!(*value, json!("NA"));
                        *value = J::Null;
                    }
                }
            }
            expected["warnings"] = json!([
                "wide_300_columns: 100 columns hold nothing but error markers (c1, c4, c7, …) and are shown as empty. They keep their original type — a column that never held a value cannot say what type it is."
            ]);
        }
        "columns_disagree" => {
            expected["columns"] =
                json!([{"name":"a","type":"VARCHAR"},{"name":"b","type":"VARCHAR"}]);
            expected["rows"] = json!([["1.794.446,52", "1,234.56"], ["2.000,00", "2,000.00"]]);
            expected["warnings"] = json!([reference["warnings"][0]]);
        }
        _ => {}
    }
    expected
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "dfv-d36-csv-{}-{}",
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

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}
fn bytes_of(case: &J) -> Vec<u8> {
    match case.get("gen") {
        Some(g) => {
            let s = |k: &str| g[k].as_str().unwrap().to_owned();
            let n = g["count"].as_u64().unwrap() as usize;
            format!("{}{}{}", s("prefix"), s("fill").repeat(n), s("suffix")).into_bytes()
        }
        None => unhex(case["hex"].as_str().unwrap()),
    }
}
fn q(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn locale_name(l: Option<NumberLocale>) -> J {
    match l {
        Some(NumberLocale::En) => json!("en"),
        Some(NumberLocale::Eu) => json!("eu"),
        None => J::Null,
    }
}

/// What the native engine makes of one case, in the reference's own shape.
fn native(name: &str, bytes: &[u8], options: &J, dir: &Scratch) -> J {
    let path = dir.0.join(format!("{name}.csv"));
    std::fs::write(&path, bytes).unwrap();
    let opts = OpenOptions {
        number_locale: options.get("numberLocale").and_then(J::as_str).map(|l| {
            if l == "eu" {
                NumberLocale::Eu
            } else {
                NumberLocale::En
            }
        }),
        null_text: options.get("nullText").map(|t| {
            t.as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect()
        }),
    };
    let engine = match Engine::open_with(&path, &opts) {
        Ok(e) => e,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    let report = engine.number_locale.as_ref().unwrap();
    let mut out = json!({
        "warnings": engine.open_warnings,
        "locale": {
            "locale": locale_name(report.locale),
            "forced": report.forced,
            "conflicting": report.conflicting,
            "undecidable": report.undecidable.iter().map(|u| json!({"column": u.column, "samples": u.samples})).collect::<Vec<_>>(),
        },
    });
    if let Err(e) = read_all(&engine, name, &mut out) {
        out["readError"] = json!(e.to_string());
    }
    out
}

/// Types, count and values, added to `out`; the first failure is returned.
fn read_all(engine: &Engine, name: &str, out: &mut J) -> Result<(), Error> {
    let run = |sql: String| {
        engine.run_query(&sql, 0).map_err(|e| {
            Error::Engine(format!(
                "[{}] {e}",
                sql.chars().take(40).collect::<String>()
            ))
        })
    };
    let describe = run(format!("describe select * from {}", q(name)))?;
    let at = |c: &str| describe.columns.iter().position(|x| x == c).unwrap();
    let names: Vec<String> = describe
        .rows
        .iter()
        .map(|r| r[at("column_name")].as_str().unwrap().to_owned())
        .collect();
    out["columns"] = J::Array(
        describe
            .rows
            .iter()
            .map(|r| json!({ "name": r[at("column_name")], "type": r[at("column_type")] }))
            .collect(),
    );
    let count = run(format!("select count(*) from {}", q(name)))?.rows[0][0]
        .as_i64()
        .unwrap();
    out["count"] = json!(count);
    if names.is_empty() {
        out["rows"] = json!([]);
    } else if count <= 1000 {
        let cast: Vec<String> = names
            .iter()
            .map(|n| format!("cast({} as varchar) as {}", q(n), q(n)))
            .collect();
        let rows = run(format!("select {} from {}", cast.join(", "), q(name)))?;
        out["rows"] = J::Array(rows.rows.into_iter().map(J::Array).collect());
    } else {
        let digests: Vec<String> = names
            .iter()
            .map(|n| {
                format!(
                    "md5(string_agg(coalesce(cast({} as varchar), '<null>'), '|')) as {}",
                    q(n),
                    q(n)
                )
            })
            .collect();
        let rows = run(format!("select {} from {}", digests.join(", "), q(name)))?;
        out["digests"] = J::Array(rows.rows[0].clone());
    }
    Ok(())
}

fn status(j: &J) -> &'static str {
    if j.get("error").is_some() {
        "refused at open"
    } else if j.get("readError").is_some() {
        "opened, unreadable"
    } else {
        "read"
    }
}

fn compare(reference: &J, got: &J) -> Vec<String> {
    let failure = |j: &J| {
        j.get("error").or_else(|| j.get("readError")).map(|_| {
            if j.get("error").is_some() {
                "refused at open"
            } else {
                "unreadable"
            }
        })
    };
    if failure(reference).is_some() || failure(got).is_some() {
        return if failure(reference) == failure(got) {
            vec![]
        } else {
            vec![format!(
                "reference {} / native {}",
                failure(reference).unwrap_or("read fine"),
                failure(got).unwrap_or("read fine")
            )]
        };
    }
    ["locale", "columns", "count", "rows", "digests", "warnings"]
        .iter()
        .filter(|k| reference.get(**k) != got.get(**k))
        .map(|k| format!("{k}: reference {} / native {}", reference[*k], got[*k]))
        .collect()
}

#[test]
fn every_csv_case_matches_the_reference_reader() {
    let file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/csv_differential.json");
    let corpus: J = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let dir = Scratch::new();
    let (mut report, mut unexpected) = (vec![], vec![]);
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 100, "the corpus shrank to {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if std::env::var("DFV_D36_ONLY").is_ok_and(|only| only != name) {
            continue;
        }
        let started = std::time::Instant::now();
        let got = native(name, &bytes_of(case), &case["options"], &dir);
        eprintln!("{name}: {:?}", started.elapsed());
        let diffs = compare(&case["ref"], &got);
        let allowed = DIVERGENCES.iter().find(|(n, _)| *n == name);
        let unexpected_diffs = compare(&expected_native(name, &case["ref"]), &got);
        report.push(json!({
            "case": name,
            "reference": status(&case["ref"]),
            "native": status(&got),
            "identical": diffs.is_empty(),
            "differences": diffs,
            "documented": allowed.map(|(_, why)| *why),
            "nativeError": got.get("error").or_else(|| got.get("readError")),
        }));
        if !unexpected_diffs.is_empty() {
            unexpected.push(format!("{name}: {}", unexpected_diffs.join(" | ")));
        } else if diffs.is_empty() && allowed.is_some() {
            unexpected.push(format!("{name}: documented divergence no longer exists"));
        }
    }
    if let Ok(path) = std::env::var("DFV_D36_REPORT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }
    assert!(
        unexpected.is_empty(),
        "{} of {} cases differ from the reference:\n{}",
        unexpected.len(),
        cases.len(),
        unexpected.join("\n")
    );
}

#[test]
fn a_refused_open_is_a_typed_error_not_a_panic() {
    let dir = Scratch::new();
    let path = dir.0.join("bad.csv");
    std::fs::write(&path, [0x61, 0x0a, 0xff, 0xfe, 0x0a]).unwrap();
    assert!(matches!(Engine::open(&path), Err(Error::Engine(_))));
}
