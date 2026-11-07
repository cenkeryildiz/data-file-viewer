use dfv_table_backup_diff::*;
use serde_json::Value;
use std::collections::BTreeMap;

fn cell(v: &Value) -> Cell {
    match v {
        Value::Null => Cell::Null,
        Value::Bool(b) => Cell::Bool(*b),
        Value::Number(n) => n
            .as_i64()
            .map(|i| Cell::Int(i.into()))
            .unwrap_or_else(|| Cell::float(n.as_f64().unwrap())),
        Value::String(s) => Cell::Text(s.clone()),
        other => Cell::Typed("json".into(), other.to_string()),
    }
}
fn table(cols: &Value, rows: &Value) -> Table {
    Table {
        columns: cols
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_owned())
            .collect(),
        rows: rows
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_array().unwrap().iter().map(cell).collect())
            .collect(),
    }
}

/// Differential against the real compiled TS `diffQueryAgainstBackup` (cases.json, made by oracle/gen.cjs).
#[test]
fn matches_the_typescript_diff_on_3000_seeded_cases() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("cases.json")).unwrap();
    let (mut renamed, mut changed, mut new_rows, mut zero_overlap) = (0, 0, 0, 0);
    for (n, c) in cases.iter().enumerate() {
        let live = table(&c["liveColumns"], &c["liveRows"]);
        let backup = table(&c["backupColumns"], &c["backupRows"]);
        let got = diff_query(&live, &backup);
        let want = &c["expected"];
        let want_cells: Vec<Vec<bool>> =
            serde_json::from_value(want["cellChanged"].clone()).unwrap();
        let want_new: Vec<bool> = serde_json::from_value(want["rowIsNew"].clone()).unwrap();
        let want_renames: BTreeMap<String, String> =
            serde_json::from_value(want["renamedColumns"].clone()).unwrap();
        assert_eq!(got.cell_changed, want_cells, "case {n}: cellChanged");
        assert_eq!(got.row_is_new, want_new, "case {n}: rowIsNew");
        if live.rows.len().min(backup.rows.len()) == 0 {
            // Documented deviation: the TS pairs unmatched columns when there is nothing to compare.
            zero_overlap += 1;
            assert!(
                got.renamed_columns.is_empty(),
                "case {n}: no rename without shared rows"
            );
        } else {
            assert_eq!(
                got.renamed_columns, want_renames,
                "case {n}: renamedColumns"
            );
        }
        renamed += (!want_renames.is_empty()) as u32;
        changed += want_cells.iter().flatten().any(|b| *b) as u32;
        new_rows += want_new.iter().any(|b| *b) as u32;
    }
    // Pin the fixed oracle corpus coverage as well as every result comparison above.
    assert_eq!(cases.len(), 3000);
    assert_eq!(
        (renamed, changed, new_rows, zero_overlap),
        (528, 1530, 433, 557)
    );
}

fn t(cols: &[&str], rows: Vec<Vec<Cell>>) -> Table {
    Table {
        columns: cols.iter().map(|c| (*c).to_owned()).collect(),
        rows,
    }
}

#[test]
fn values_keep_exact_type_and_digits() {
    let a = t(
        &["v"],
        vec![
            vec![Cell::Int(9007199254740993)],
            vec![Cell::Null],
            vec![Cell::Int(1)],
            vec![Cell::float(f64::NAN)],
            vec![Cell::float(0.0)],
        ],
    );
    let b = t(
        &["v"],
        vec![
            vec![Cell::Int(9007199254740992)],
            vec![Cell::Text(String::new())],
            vec![Cell::float(1.0)],
            vec![Cell::float(f64::NAN)],
            vec![Cell::float(-0.0)],
        ],
    );
    let d = diff_query(&a, &b);
    assert_eq!(
        d.cell_changed,
        vec![vec![true], vec![true], vec![true], vec![false], vec![true]]
    );
    // >2^53 neighbours differ; NULL vs ''; 1 vs 1.0; NaN equals NaN; 0.0 vs -0.0 are reported (bits differ).
}

#[test]
fn rename_by_content_is_found_and_empty_columns_are_not_renamed() {
    let live = t(
        &["a", "renamed"],
        vec![
            vec![Cell::Int(1), Cell::Text("x".into())],
            vec![Cell::Int(2), Cell::Text("y".into())],
        ],
    );
    let backup = t(
        &["a", "old"],
        vec![
            vec![Cell::Int(1), Cell::Text("x".into())],
            vec![Cell::Int(2), Cell::Text("y".into())],
        ],
    );
    let d = diff_query(&live, &backup);
    assert_eq!(
        d.renamed_columns.get("renamed").map(String::as_str),
        Some("old")
    );
    assert!(d.cell_changed.iter().flatten().all(|c| !c));
    let empty = diff_query(&t(&["q"], vec![]), &t(&["z"], vec![]));
    assert!(empty.renamed_columns.is_empty() && empty.cell_changed.is_empty());
}

#[test]
fn a_wide_renamed_result_preserves_exact_column_identity() {
    let columns = 512usize;
    let rows = 257usize;
    let backup = Table {
        columns: (0..columns).map(|i| format!("old_{i}")).collect(),
        rows: (0..rows)
            .map(|r| {
                (0..columns)
                    .map(|c| Cell::Int(((r * columns + c) as i128) << 60))
                    .collect()
            })
            .collect(),
    };
    let live = Table {
        columns: (0..columns).map(|i| format!("new_{i}")).collect(),
        rows: backup
            .rows
            .iter()
            .map(|r| r.iter().rev().cloned().collect())
            .collect(),
    };
    let start = std::time::Instant::now();
    let d = diff_query(&live, &backup);
    eprintln!("wide rename diff: {} us", start.elapsed().as_micros());
    assert_eq!(d.renamed_columns.len(), columns);
    for c in 0..columns {
        assert_eq!(
            d.renamed_columns[&format!("new_{c}")],
            format!("old_{}", columns - c - 1)
        );
    }
    assert!(d.cell_changed.iter().flatten().all(|changed| !*changed));
    assert!(d.row_is_new.iter().all(|new| !*new));
}

#[test]
fn rows_past_the_backup_are_new_and_new_columns_are_not_flagged() {
    let live = t(
        &["a", "extra"],
        vec![
            vec![Cell::Int(1), Cell::Int(9)],
            vec![Cell::Int(2), Cell::Int(8)],
        ],
    );
    let backup = t(&["a"], vec![vec![Cell::Int(1)]]);
    let d = diff_query(&live, &backup);
    assert_eq!(d.row_is_new, vec![false, true]);
    assert_eq!(d.cell_changed, vec![vec![false, false], vec![false, false]]);
}

fn snap(cols: &[(&str, &str)], rows: Vec<Vec<Cell>>) -> TableSnapshot {
    TableSnapshot {
        columns: cols
            .iter()
            .map(|(a, b)| ((*a).into(), (*b).into()))
            .collect(),
        rows,
    }
}

#[test]
fn table_summary_new_changed_unchanged_and_duplicate_rows_count() {
    let row = |i: i128| vec![Cell::Int(i)];
    let cols = [("id", "BIGINT")];
    let backup = BTreeMap::from([
        ("same".to_owned(), snap(&cols, vec![row(1), row(2)])),
        ("edited".to_owned(), snap(&cols, vec![row(1), row(2)])),
        ("dup".to_owned(), snap(&cols, vec![row(1)])),
        ("retyped".to_owned(), snap(&cols, vec![row(1)])),
        ("gone".to_owned(), snap(&cols, vec![row(1)])),
    ]);
    let live = BTreeMap::from([
        ("same".to_owned(), snap(&cols, vec![row(2), row(1)])), // order is ignored
        ("edited".to_owned(), snap(&cols, vec![row(1), row(3)])),
        ("dup".to_owned(), snap(&cols, vec![row(1), row(1)])), // the TS EXCEPT missed this
        (
            "retyped".to_owned(),
            snap(&[("id", "VARCHAR")], vec![row(1)]),
        ),
        ("fresh".to_owned(), snap(&cols, vec![])),
    ]);
    let r = compare_to_backup(&live, &backup);
    assert_eq!(r["same"], Change::Unchanged);
    assert_eq!(r["edited"], Change::Changed);
    assert_eq!(r["dup"], Change::Changed);
    assert_eq!(r["retyped"], Change::Changed);
    assert_eq!(r["fresh"], Change::New);
    assert!(!r.contains_key("gone"));
}

#[test]
fn threshold_setting_and_auto_diff_gate() {
    assert_eq!(diff_row_threshold(None), 50_000);
    assert_eq!(diff_row_threshold(Some(0.0)), 50_000);
    assert_eq!(diff_row_threshold(Some(-3.0)), 50_000);
    assert_eq!(diff_row_threshold(Some(f64::NAN)), 50_000);
    assert_eq!(diff_row_threshold(Some(10.0)), 10);
    let m = SafeMode::default();
    assert!(!m.should_auto_diff(1, 10)); // no backup yet
    assert!(!m.edits_allowed() && m.enabled());
}
