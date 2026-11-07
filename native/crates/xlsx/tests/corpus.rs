//! EX-01 corpus: ground-truth cells, merges and declared dimension; table detection compared with
//! the TypeScript detector's recorded output (detector-observed.json) and with ground truth.
use dfv_table_xlsx::budget::WORKBOOK_LIMITS;
use dfv_table_xlsx::detect_sheet_tables;
use dfv_table_xlsx::sheet_tables::{DetectOptions, Region};
use dfv_table_xlsx::xlsx_read::*;
use serde_json::Value as J;
use std::path::PathBuf;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/xlsx-corpus")
}
fn json(name: &str) -> J {
    serde_json::from_slice(&std::fs::read(corpus().join(name)).unwrap()).unwrap()
}
fn region_ref(r: &Region) -> String {
    format!(
        "{}{}:{}{}",
        column_letters(r.left as u32),
        r.top + 1,
        column_letters(r.right as u32 - 1),
        r.bottom
    )
}

/// Ground truth marks these as defects of the TypeScript heuristics (EX-06); the port must agree
/// with the TypeScript here, not with the truth, until declared tables are read.
const KNOWN_TS_DEFECTS: [&str; 4] = [
    "explicit-single",
    "explicit-adjacent",
    "explicit-stacked",
    "multilevel-header",
];

#[test]
fn every_fixture_matches_its_ground_truth_cells_merges_and_sheet_names() {
    let truth = json("ground-truth.json");
    let manifest = json("manifest.json");
    let mut cells_checked = 0;
    for (name, fx) in truth["fixtures"].as_object().unwrap() {
        let file = fx["file"].as_str().unwrap();
        let mut p = Package::open(&corpus().join(file)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            p.sha256,
            manifest["sha256"][file].as_str().unwrap(),
            "{name}: manifest hash"
        );
        let sheets = p.list_sheets().unwrap();
        let want_names: Vec<&str> = fx["sheets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            want_names,
            "{name}: sheet names"
        );
        for (sref, want) in sheets.iter().zip(fx["sheets"].as_array().unwrap()) {
            let sheet = p.read_sheet(sref).unwrap();
            let raw = want["raw"].as_object().unwrap();
            assert_eq!(
                sheet.cells.len(),
                raw.len(),
                "{name}/{}: stored cell count",
                sref.name
            );
            for (r, cell) in raw {
                let at = parse_cell_ref(r).unwrap();
                let got = sheet
                    .cells
                    .get(&at)
                    .unwrap_or_else(|| panic!("{name} {r}: missing"));
                assert_eq!(
                    got.text(),
                    cell["text"].as_str().unwrap(),
                    "{name} {r}: text"
                );
                match cell["type"].as_str().unwrap() {
                    "string" => assert!(matches!(got.value, Value::Text(_)), "{name} {r}"),
                    "number" => assert!(matches!(got.value, Value::Number(_)), "{name} {r}"),
                    "error" => assert!(matches!(got.value, Value::Error(_)), "{name} {r}"),
                    "formula" => {
                        assert_eq!(
                            got.formula.as_ref().map(|f| f.text.as_str()),
                            cell["formula"].as_str(),
                            "{name} {r}: formula"
                        );
                        let kind = cell["cachedType"].as_str().unwrap();
                        let ok = match kind {
                            "number" => matches!(got.value, Value::Number(_)),
                            "string" => matches!(got.value, Value::Text(_)),
                            "error" => matches!(got.value, Value::Error(_)),
                            _ => false,
                        };
                        assert!(ok, "{name} {r}: cached {kind} read as {:?}", got.value);
                    }
                    other => panic!("unknown type {other}"),
                }
                cells_checked += 1;
            }
            let mut merges: Vec<String> = sheet
                .merges
                .iter()
                .map(|m| {
                    format!(
                        "{}{}:{}{}",
                        column_letters(m.left),
                        m.top + 1,
                        column_letters(m.right),
                        m.bottom + 1
                    )
                })
                .collect();
            let mut want_merges: Vec<String> = want["merges"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_str().unwrap().to_owned())
                .collect();
            merges.sort();
            want_merges.sort();
            assert_eq!(merges, want_merges, "{name}: merges");
            // Declared (or measured) dimension is an upper bound that must cover every cell.
            let d = p.dimension(&sref.path).unwrap();
            if sheet.cells.is_empty() {
                assert!(d.is_none() || sheet.declared.is_some());
            } else {
                let d = d.expect("dimension");
                let (rows, cols) = sheet.extent();
                assert!(
                    d.last_row >= rows && column_index(&d.last_col) + 1 >= cols,
                    "{name}: dimension {d:?} < extent"
                );
            }
        }
    }
    assert!(cells_checked >= 130, "{cells_checked}");
}

#[test]
fn table_detection_equals_the_typescript_detector_and_ground_truth() {
    let truth = json("ground-truth.json");
    let observed = json("detector-observed.json");
    let mut compared = 0;
    for (name, fx) in truth["fixtures"].as_object().unwrap() {
        let mut p = Package::open(&corpus().join(fx["file"].as_str().unwrap())).unwrap();
        for sref in p.list_sheets().unwrap() {
            let sheet = p.read_sheet(&sref).unwrap();
            let tables = detect_sheet_tables(
                &sheet,
                WORKBOOK_LIMITS.cells_per_sheet,
                &DetectOptions::default(),
            )
            .unwrap();
            let want = observed["fixtures"][name]["sheets"][sref.name.as_str()]["detectedTables"]
                .as_array()
                .unwrap();
            assert_eq!(
                tables.len(),
                want.len(),
                "{name}/{}: table count vs TypeScript",
                sref.name
            );
            for (t, w) in tables.iter().zip(want) {
                let g = |k: &str| w[k].as_u64().unwrap() as usize;
                assert_eq!(
                    (t.region.top, t.region.bottom, t.region.left, t.region.right),
                    (g("top"), g("bottom"), g("left"), g("right")),
                    "{name}: region"
                );
                assert_eq!(
                    t.header_row.map(|h| h as u64),
                    w["headerRow"].as_u64(),
                    "{name}: header row"
                );
                let cols: Vec<&str> = w["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c.as_str().unwrap())
                    .collect();
                assert_eq!(t.columns, cols, "{name}: columns");
                assert_eq!(t.row_count, g("rowCount"), "{name}: rowCount");
                compared += 1;
            }
            // Against independent ground truth, except where the TypeScript is known wrong.
            if !KNOWN_TS_DEFECTS.contains(&name.as_str()) {
                let truth_tables: Vec<&J> = fx["tables"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|t| t["sheet"] == sref.name.as_str())
                    .collect();
                assert_eq!(
                    tables
                        .iter()
                        .map(|t| region_ref(&t.region))
                        .collect::<Vec<_>>(),
                    truth_tables
                        .iter()
                        .map(|t| t["range"].as_str().unwrap().to_owned())
                        .collect::<Vec<_>>(),
                    "{name}: ground-truth ranges"
                );
                for (t, w) in tables.iter().zip(&truth_tables) {
                    assert_eq!(
                        t.row_count,
                        w["rows"].as_array().unwrap().len(),
                        "{name}: ground-truth row count"
                    );
                    if let Some(c) = w["columns"].as_array() {
                        assert_eq!(
                            t.columns,
                            c.iter().map(|c| c.as_str().unwrap()).collect::<Vec<_>>(),
                            "{name}: ground-truth columns"
                        );
                    }
                    if let Some(ex) = w["excludedRows"].as_array() {
                        let got: Vec<u64> =
                            t.excluded_rows.iter().map(|e| e.row as u64 + 1).collect();
                        assert_eq!(
                            got,
                            ex.iter().map(|e| e.as_u64().unwrap()).collect::<Vec<_>>(),
                            "{name}: excluded rows"
                        );
                    }
                }
            }
        }
    }
    assert!(compared >= 10, "{compared}");
}

#[test]
fn the_sparse_fixture_keeps_a_distant_note_on_the_sheet_but_not_in_a_table() {
    let mut p = Package::open(&corpus().join("sparse.xlsx")).unwrap();
    let s = p.list_sheets().unwrap().remove(0);
    let sheet = p.read_sheet(&s).unwrap();
    let grid = sheet.text_grid(WORKBOOK_LIMITS.cells_per_sheet).unwrap();
    assert_eq!(grid.len(), 1000);
    assert_eq!(grid[999][51].as_deref(), Some("far note"));
    let t = detect_sheet_tables(
        &sheet,
        WORKBOOK_LIMITS.cells_per_sheet,
        &DetectOptions::default(),
    )
    .unwrap();
    assert_eq!(
        t.iter().map(|t| region_ref(&t.region)).collect::<Vec<_>>(),
        ["A1:B3"]
    );
}

#[test]
fn formula_errors_keep_their_markers_verbatim() {
    let mut p = Package::open(&corpus().join("formula-errors.xlsx")).unwrap();
    let s = p.list_sheets().unwrap().remove(0);
    let sheet = p.read_sheet(&s).unwrap();
    let truth = json("ground-truth.json");
    for (r, marker) in truth["fixtures"]["formula-errors"]["tables"][0]["errorCells"]
        .as_object()
        .unwrap()
    {
        assert_eq!(
            sheet.cells[&parse_cell_ref(r).unwrap()].text(),
            marker.as_str().unwrap(),
            "{r}"
        );
    }
}

#[test]
fn reading_never_changes_the_source() {
    for f in std::fs::read_dir(corpus())
        .unwrap()
        .flatten()
        .filter(|f| f.path().extension().is_some_and(|e| e == "xlsx"))
    {
        let before = std::fs::read(f.path()).unwrap();
        let mut p = Package::open(&f.path()).unwrap();
        for s in p.list_sheets().unwrap() {
            let _ = p.read_sheet(&s).unwrap();
            let _ = p.dimension(&s.path).unwrap();
        }
        let _ = p.styles().unwrap();
        assert_eq!(std::fs::read(f.path()).unwrap(), before);
    }
}
