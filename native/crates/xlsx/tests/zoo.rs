//! D3.8 against independent readers: workbooks written by xlsxwriter, read back by openpyxl (cells, cached
//! values, formulas, merges, sheet state, date system) with fastexcel/calamine agreeing on plain text.
//! Titles, footnotes, merged cells, adjacent/stacked tables, formulas and error literals keep their
//! worksheet coordinates and classification.
use dfv_table_xlsx::budget::WORKBOOK_LIMITS;
use dfv_table_xlsx::detect_sheet_tables;
use dfv_table_xlsx::sheet_tables::{DetectOptions, Region};
use dfv_table_xlsx::xlsx_read::*;
use serde_json::Value as J;
use std::path::PathBuf;

fn zoo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/zoo")
}
fn expected() -> J {
    serde_json::from_slice(&std::fs::read(zoo().join("expected-zoo.json")).unwrap()).unwrap()
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
/// openpyxl numbers are Python floats; compare numerically, never as text.
fn same_number(stored: &str, want: &str) -> bool {
    stored.trim().parse::<f64>().ok() == want.parse::<f64>().ok()
}

#[test]
fn every_zoo_cell_matches_openpyxl_in_value_class_formula_and_coordinate() {
    let e = expected();
    let mut checked = 0;
    for (file, wb) in e["workbooks"].as_object().unwrap() {
        let mut p = Package::open(&zoo().join(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
        assert_eq!(
            p.date1904().unwrap(),
            wb["date1904"].as_bool().unwrap(),
            "{file} date system"
        );
        let sheets = p.list_sheets().unwrap();
        // serde_json sorts object keys, so the set is compared here; order is proved by the corpus test.
        let mut names: Vec<&String> = sheets.iter().map(|s| &s.name).collect();
        names.sort();
        let mut want_names: Vec<&String> = wb["sheets"].as_object().unwrap().keys().collect();
        want_names.sort(); // workspace feature unification may enable serde_json preserve_order
        assert_eq!(names, want_names, "{file} sheet names");
        for sref in &sheets {
            let want = &wb["sheets"][sref.name.as_str()];
            let sheet = p.read_sheet(sref).unwrap();
            let cells = want["cells"].as_object().unwrap();
            // Style-only cells (xlsxwriter's formatted blank) are not stored values.
            let want_values: Vec<_> = cells.iter().collect();
            assert_eq!(
                sheet.cells.len(),
                want_values.len(),
                "{file}/{}: stored value count",
                sref.name
            );
            for (coord, c) in want_values {
                let got = sheet
                    .cells
                    .get(&parse_cell_ref(coord).unwrap())
                    .unwrap_or_else(|| panic!("{file} {coord} missing"));
                let (t, v) = (
                    c["cached"]["t"].as_str().unwrap(),
                    c["cached"]["v"].as_str(),
                );
                match (&got.value, t) {
                    (Value::Error(m), "s") if c["is_error"].as_bool().unwrap() => {
                        assert_eq!(m, v.unwrap(), "{file} {coord}")
                    }
                    (Value::Text(m), "s") if !c["is_error"].as_bool().unwrap() => {
                        assert_eq!(m, v.unwrap_or(""), "{file} {coord}")
                    } // openpyxl: None for an empty cached result
                    (Value::Number(m), "n") => {
                        assert!(same_number(m, v.unwrap()), "{file} {coord}: {m} vs {v:?}")
                    }
                    (Value::Number(m), "d") => {
                        assert!(m.parse::<f64>().is_ok(), "{file} {coord}: date serial {m}")
                    }
                    (Value::Bool(b), "b") => {
                        assert_eq!(*b, c["cached"]["v"].as_bool().unwrap(), "{file} {coord}")
                    }
                    (g, t) => panic!("{file} {coord}: read {g:?}, openpyxl says {t} {v:?}"),
                }
                assert_eq!(
                    got.formula.as_ref().map(|f| f.text.as_str()),
                    c["formula"].as_str(),
                    "{file} {coord} formula"
                );
                checked += 1;
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
            merges.sort();
            let mut want_merges: Vec<&str> = want["merges"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_str().unwrap())
                .collect();
            want_merges.sort();
            assert_eq!(merges, want_merges, "{file}/{}: merges", sref.name);
        }
    }
    assert!(checked >= 110, "{checked}");
}

#[test]
fn titles_footnotes_merges_adjacent_and_stacked_tables_keep_their_geometry() {
    let e = expected();
    for (file, wb) in e["workbooks"].as_object().unwrap() {
        let mut p = Package::open(&zoo().join(file)).unwrap();
        for sref in p.list_sheets().unwrap() {
            let sheet = p.read_sheet(&sref).unwrap();
            let tables = detect_sheet_tables(
                &sheet,
                WORKBOOK_LIMITS.cells_per_sheet,
                &DetectOptions::default(),
            )
            .unwrap();
            let want: Vec<&str> = wb["sheets"][sref.name.as_str()]["tables"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t.as_str().unwrap())
                .collect();
            let mut got: Vec<String> = tables.iter().map(|t| region_ref(&t.region)).collect();
            got.sort();
            let mut want_sorted = want.clone();
            want_sorted.sort();
            assert_eq!(got, want_sorted, "{file}/{}: table ranges", sref.name);
        }
    }
}

#[test]
fn display_classification_survives_for_dates_and_the_1904_system() {
    let mut p = Package::open(&zoo().join("report.xlsx")).unwrap();
    let r = p.list_sheets().unwrap().remove(0);
    let sheet = p.read_sheet(&r).unwrap();
    let styles = p.styles().unwrap();
    let date_cell = &sheet.cells[&parse_cell_ref("E5").unwrap()];
    assert!(
        styles[date_cell.style as usize].is_date,
        "a date-formatted number is classed as a date"
    );
    assert!(!styles[sheet.cells[&parse_cell_ref("B5").unwrap()].style as usize].is_date);
    assert!(!p.date1904().unwrap());
    assert!(
        Package::open(&zoo().join("kinds.xlsx"))
            .unwrap()
            .date1904()
            .unwrap()
    );
}

#[test]
fn exact_text_survives_padding_unicode_entities_and_long_values() {
    let mut p = Package::open(&zoo().join("kinds.xlsx")).unwrap();
    let r = p.list_sheets().unwrap().remove(0);
    let s = p.read_sheet(&r).unwrap();
    let t = |c: &str| s.cells[&parse_cell_ref(c).unwrap()].text();
    assert_eq!(t("A1"), "Rich text");
    assert_eq!(t("A2"), "  padded  ");
    assert_eq!(t("A3"), "İstanbul σ😀");
    assert_eq!(t("A4"), "a&b <c> \"q\" 's'");
    assert_eq!(t("A5").len(), 5000);
    assert_eq!(t("A12"), "line1\nline2");
    assert_eq!(t("A11"), "true");
}

/// The TypeScript detector's recorded output on these workbooks (out-test build of src/sheetTables.ts via
/// DuckDbFile.getDetectedSheetTables), compared in order: region, header row, columns, row count.
#[test]
fn detection_equals_the_typescript_detector_on_the_zoo() {
    let observed: J =
        serde_json::from_slice(&std::fs::read(zoo().join("detector-observed-zoo.json")).unwrap())
            .unwrap();
    let mut compared = 0;
    for (file, sheets) in observed.as_object().unwrap() {
        let mut p = Package::open(&zoo().join(file)).unwrap();
        for sref in p.list_sheets().unwrap() {
            let Some(want) = sheets.get(sref.name.as_str()) else {
                continue;
            };
            let sheet = p.read_sheet(&sref).unwrap();
            let tables = detect_sheet_tables(
                &sheet,
                WORKBOOK_LIMITS.cells_per_sheet,
                &DetectOptions::default(),
            )
            .unwrap();
            let want = want.as_array().unwrap();
            assert_eq!(
                tables.len(),
                want.len(),
                "{file}/{}: table count",
                sref.name
            );
            for (t, w) in tables.iter().zip(want) {
                let g = |k: &str| w[k].as_u64().unwrap() as usize;
                assert_eq!(
                    (t.region.top, t.region.bottom, t.region.left, t.region.right),
                    (g("top"), g("bottom"), g("left"), g("right")),
                    "{file}: region"
                );
                assert_eq!(
                    t.header_row.map(|h| h as u64),
                    w["headerRow"].as_u64(),
                    "{file}: header row"
                );
                assert_eq!(
                    t.columns,
                    w["columns"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|c| c.as_str().unwrap())
                        .collect::<Vec<_>>(),
                    "{file}: columns"
                );
                assert_eq!(t.row_count, g("rowCount"), "{file}: rowCount");
                compared += 1;
            }
        }
    }
    assert_eq!(compared, 5);
}
