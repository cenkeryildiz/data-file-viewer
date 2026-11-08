use dfv_table_xlsx_ops::{ErrKind, Options, TableMode, XlsxOps, filter::Request};
use duckdb::Connection;
use serde_json::{Value, json};
use std::path::PathBuf;

#[path = "../../xlsx/tests/common/mod.rs"]
mod common;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/xlsx-corpus")
            .join(format!("{name}.xlsx")),
    )
    .unwrap()
}
fn book(name: &str) -> (Connection, XlsxOps) {
    let db = Connection::open_in_memory().unwrap();
    let mut ops = XlsxOps::attach(&db, fixture(name), Options::default(), &|| false).unwrap();
    ops.prepare_all(&db, &|| false).unwrap();
    (db, ops)
}

fn declared_book(target: &str, second_ref: &str) -> Vec<u8> {
    let sheet = format!(
        r#"{}<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>one</t></is></c><c r="B1" t="inlineStr"><is><t>two</t></is></c></row><row r="2"><c r="A2"><v>10</v></c><c r="B2"><v>20</v></c></row><row r="3"><c r="A3"><v>11</v></c><c r="B3"><v>21</v></c></row></sheetData><tableParts count="2"><tablePart r:id="t1"/><tablePart r:id="t2"/></tableParts></worksheet>"#,
        common::SHEET_OPEN
    );
    let rels = common::rels(&format!(
        r#"<Relationship Id="t1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="{target}"/><Relationship Id="t2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/t2.xml"/>"#
    ));
    let table1 = r#"<table displayName="First" ref="A1:A3"><tableColumns count="1"><tableColumn id="1" name="one"/></tableColumns></table>"#;
    let table2 = format!(
        r#"<table displayName="Second" ref="{second_ref}"><tableColumns count="1"><tableColumn id="1" name="two"/></tableColumns></table>"#
    );
    common::one_sheet(
        &sheet,
        &[
            ("xl/worksheets/_rels/sheet1.xml.rels", &rels),
            ("xl/tables/t1.xml", table1),
            ("xl/tables/t2.xml", &table2),
        ],
    )
}

#[test]
fn explicit_single_column_adjacent_tables_preserve_declared_names_bounds_and_raw_cells() {
    let db = Connection::open_in_memory().unwrap();
    let mut ops = XlsxOps::attach(
        &db,
        declared_book("../tables/t1.xml", "B1:B3"),
        Options::default(),
        &|| false,
    )
    .unwrap();
    ops.prepare_selected(&db, "S", &|| false).unwrap();
    let tables = ops.detected_tables("S");
    assert_eq!(
        tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["First", "Second"]
    );
    assert!(
        tables
            .iter()
            .all(|t| t.provenance == "explicit" && t.table.row_count == 2)
    );
    assert_eq!(
        (tables[0].table.region.left, tables[0].table.region.right),
        (0, 1)
    );
    let exact: String = db
        .query_row("select A from S where rowid=1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(exact, "10");
}

#[test]
fn malformed_or_overlapping_declared_relationships_fail_detection_but_leave_raw_readable() {
    for (target, range) in [
        ("https://example.invalid/t1.xml", "B1:B3"),
        ("//xl/tables/t1.xml", "B1:B3"),
        ("../../../escape.xml", "B1:B3"),
        ("../tables/t1.xml", "A1:A3"),
        ("../tables/t1.xml", "B1:C3"),
        ("../tables/t1.xml", "B1:B1048577"),
    ] {
        let db = Connection::open_in_memory().unwrap();
        let mut ops = XlsxOps::attach(
            &db,
            declared_book(target, range),
            Options::default(),
            &|| false,
        )
        .unwrap();
        ops.prepare_selected(&db, "S", &|| false).unwrap();
        assert_eq!(
            ops.status("S").unwrap().state,
            dfv_table_xlsx_ops::State::Failed
        );
        assert!(ops.detected_tables("S").is_empty());
        let rows: i64 = db
            .query_row("select count(*) from S", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 3);
    }
}

#[test]
fn manual_header_rectangle_overrides_overlap_and_invalid_corrections_are_atomic() {
    use dfv_table_xlsx::sheet_tables::{ManualTable, Region};
    let db = Connection::open_in_memory().unwrap();
    let mut ops = XlsxOps::attach(
        &db,
        declared_book("../tables/t1.xml", "B1:B3"),
        Options::default(),
        &|| false,
    )
    .unwrap();
    ops.prepare_selected(&db, "S", &|| false).unwrap();
    let manual = ManualTable {
        region: Region {
            top: 0,
            bottom: 3,
            left: 0,
            right: 1,
        },
        header_row: None,
    };
    let status = ops
        .correct_tables(&db, "S", vec![manual.clone()], &|| false)
        .unwrap();
    assert_eq!(status.generation, 1);
    let tables = ops.detected_tables("S");
    assert!(tables.iter().any(|t| t.provenance == "manual"
        && t.table.row_count == 3
        && t.table.header_row.is_none()));
    assert!(
        tables
            .iter()
            .any(|t| t.name == "Second" && t.provenance == "explicit")
    );
    let before = tables.iter().map(|t| t.to_json()).collect::<Vec<_>>();
    let mut invalid = manual.clone();
    invalid.region.bottom = 999;
    assert!(
        ops.correct_tables(&db, "S", vec![invalid], &|| false)
            .is_err()
    );
    assert!(
        ops.correct_tables(&db, "S", vec![manual.clone(), manual.clone()], &|| false)
            .is_err()
    );
    assert_eq!(
        ops.detected_tables("S")
            .iter()
            .map(|t| t.to_json())
            .collect::<Vec<_>>(),
        before
    );
    assert!(
        ops.correct_tables(&db, "S", vec![manual.clone()], &|| true)
            .is_err()
    );
    assert_eq!(
        ops.detected_tables("S")
            .iter()
            .map(|t| t.to_json())
            .collect::<Vec<_>>(),
        before
    );
    let checks = std::cell::Cell::new(0);
    assert!(
        ops.correct_tables(&db, "S", vec![manual.clone()], &|| {
            checks.set(checks.get() + 1);
            checks.get() >= 3
        })
        .is_err()
    );
    assert_eq!(
        ops.detected_tables("S")
            .iter()
            .map(|t| t.to_json())
            .collect::<Vec<_>>(),
        before
    );
    let restored: i64 = db
        .query_row("select count(*) from Second", [], |r| r.get(0))
        .unwrap();
    assert_eq!(restored, 2);
    let mut header = manual;
    header.header_row = Some(1);
    ops.correct_tables(&db, "S", vec![header], &|| false)
        .unwrap();
    assert!(
        ops.detected_tables("S")
            .iter()
            .any(|t| t.provenance == "manual"
                && t.table.columns == ["10"]
                && t.table.row_count == 1)
    );
}

#[test]
#[cfg(feature = "test-detection-failure")]
fn discovery_is_explicit_selected_cached_and_not_triggered_by_raw_join() {
    let wb = common::book(
        r#"<sheet name="A" sheetId="1" r:id="r1"/><sheet name="B" sheetId="2" r:id="r2"/>"#,
    );
    let rels = common::rels(
        r#"<Relationship Id="r1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="t" Target="worksheets/sheet2.xml"/>"#,
    );
    let sheet = format!(
        r#"{}<dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c></row></sheetData></worksheet>"#,
        common::SHEET_OPEN
    );
    let bytes = common::deflate(&[
        ("xl/workbook.xml", wb.as_bytes()),
        ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
        ("xl/worksheets/sheet2.xml", sheet.as_bytes()),
    ]);
    let db = Connection::open_in_memory().unwrap();
    let mut ops = XlsxOps::attach(&db, bytes, Options::default(), &|| false).unwrap();
    assert!(ops.detection_calls().is_empty());
    ops.prepare_raw_references(
        &db,
        &std::collections::HashSet::from(["A".to_owned(), "B".to_owned()]),
        &|| false,
    )
    .unwrap();
    let _: i64 = db
        .query_row("select count(*) from A cross join B", [], |r| r.get(0))
        .unwrap();
    assert!(ops.detection_calls().is_empty());
    ops.prepare_selected(&db, "A", &|| false).unwrap();
    assert_eq!(ops.detection_calls().get("A"), Some(&1));
    assert!(!ops.detection_calls().contains_key("B"));
    assert_eq!(
        ops.status("B").unwrap().state,
        dfv_table_xlsx_ops::State::Pending
    );
    ops.prepare_selected(&db, "B", &|| false).unwrap();
    ops.prepare_selected(&db, "A", &|| false).unwrap();
    assert_eq!(ops.detection_calls().get("A"), Some(&1));
    assert_eq!(ops.detection_calls().get("B"), Some(&1));
    assert!(ops.prepare_selected(&db, "missing", &|| false).is_err());
}

#[test]
fn first_open_of_the_selected_sheet_decodes_its_grid_once() {
    let wb = common::book(r#"<sheet name="A" sheetId="1" r:id="r1"/>"#);
    let rels = common::rels(r#"<Relationship Id="r1" Type="t" Target="worksheets/sheet1.xml"/>"#);
    let sheet = format!(
        r#"{}<dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c></row></sheetData></worksheet>"#,
        common::SHEET_OPEN
    );
    let bytes = common::deflate(&[
        ("xl/workbook.xml", wb.as_bytes()),
        ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
    ]);
    let db = Connection::open_in_memory().unwrap();
    let mut ops = XlsxOps::attach(&db, bytes, Options::default(), &|| false).unwrap();
    ops.prepare_selected(&db, "A", &|| false).unwrap();
    assert_eq!(ops.detected_tables("A").len(), 1, "detection still ran");
    assert_eq!(ops.metrics()["phases"]["read_grid"]["count"], 1);
}

#[test]
fn repeated_headers_keep_logical_rows_and_physical_edit_coordinates() {
    let (db, mut ops) = book("repeated");
    assert_eq!(ops.worksheets(), ["Sheet"]);
    let table = ops.detected_tables("Sheet")[0].name.clone();
    let sql = ops
        .build_detected_table_query(&db, &table, &Request::default())
        .unwrap();
    let rows: Vec<(String, f64)> = db
        .prepare(&sql)
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows, [("Alice".into(), 1.0), ("Bob".into(), 2.0)]);
    let row = json!({"Name":"Bob", "Value":{"$t":"float64","v":"2"}});
    let located = ops
        .locate_xlsx_edit(&db, &table, "Value", row.as_object().unwrap())
        .unwrap();
    let target = located.target.unwrap();
    assert_eq!((target.row_ordinal, target.column_name.as_str()), (5, "B"));
    assert_eq!(target.sheet_path, "xl/worksheets/sheet1.xml");
    assert_eq!(ops.sha256().len(), 64);
    assert!(ops.assert_current(ops.sha256()).is_ok());
    assert_eq!(
        ops.assert_current("changed").unwrap_err().kind,
        ErrKind::Stale
    );
    let status = ops.retry_sheet_preparation(&db, "Sheet").unwrap();
    assert!(!status.unwrap().retryable);
}

#[test]
fn raw_sheet_target_is_verbatim_and_unknown_columns_are_refused() {
    let (db, mut ops) = book("repeated");
    let row = json!({"A":"Bob","B":"2"});
    let target = ops
        .locate_xlsx_edit(&db, "Sheet", "B", row.as_object().unwrap())
        .unwrap()
        .target
        .unwrap();
    assert_eq!((target.row_ordinal, target.column_name.as_str()), (5, "B"));
    assert_eq!(
        ops.locate_xlsx_edit(&db, "Sheet", "missing", row.as_object().unwrap())
            .unwrap_err()
            .kind,
        ErrKind::Invalid
    );
    let missing = json!({"A":"nobody","B":"2"});
    assert!(
        ops.locate_xlsx_edit(&db, "Sheet", "B", missing.as_object().unwrap())
            .unwrap()
            .target
            .is_none()
    );
}

#[test]
fn null_and_mixed_columns_preserve_their_values() {
    let (db, mut ops) = book("mixed-value");
    let table = ops.detected_tables("Sheet")[0].name.clone();
    let sql = ops
        .build_detected_table_query(&db, &table, &Request::default())
        .unwrap();
    let rows: Vec<String> = db
        .prepare(&sql)
        .unwrap()
        .query_map([], |r| r.get(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows, ["1", "not numeric", "3"]);
}

#[test]
fn filters_sort_limit_and_injection_are_bound_to_known_columns() {
    let (db, mut ops) = book("footer");
    let table = ops.detected_tables("Sheet")[0].name.clone();
    let args = json!({"filters":[{"column":"Value","operator":"gte","value":"1"}],
        "sort":{"column":"Value","direction":"desc"},"limit":"1"});
    let req = Request::from_args(args.as_object().unwrap()).unwrap();
    let sql = ops.build_detected_table_query(&db, &table, &req).unwrap();
    let name: String = db.query_row(&sql, [], |r| r.get(0)).unwrap();
    assert_eq!(name, "Bob");
    for args in [
        json!({"filters":[{"column":"missing","operator":"equals","value":"x"}]}),
        json!({"filters":[{"column":"Value","operator":"equals","value":"1; drop table Sheet"}]}),
    ] {
        let req = Request::from_args(args.as_object().unwrap()).unwrap();
        assert!(ops.build_detected_table_query(&db, &table, &req).is_err());
    }
    assert!(
        Request::from_args(
            json!({"sort":{"column":"Value","direction":"desc; drop"}})
                .as_object()
                .unwrap()
        )
        .is_err()
    );
    let n: i64 = db
        .query_row("select count(*) from Sheet", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 5);
}

#[test]
fn table_mode_off_keeps_the_raw_sheet_and_cancellation_stops_open() {
    let db = Connection::open_in_memory().unwrap();
    let options = Options {
        table_mode: TableMode::Off,
        ..Options::default()
    };
    let mut ops = XlsxOps::attach(&db, fixture("footer"), options, &|| false).unwrap();
    ops.prepare_all(&db, &|| false).unwrap();
    assert!(ops.detected_tables("Sheet").is_empty());
    assert!(
        ops.build_detected_table_query(&db, "Sheet", &Request::default())
            .is_err()
    );
    let db = Connection::open_in_memory().unwrap();
    assert!(
        matches!(XlsxOps::attach(&db, fixture("footer"), Options::default(), &||true), Err(e) if e.kind == ErrKind::Interrupted)
    );
}

#[test]
fn tagged_numeric_matching_does_not_round_wide_integer_identity() {
    let (db, mut ops) = book("repeated");
    let table = ops.detected_tables("Sheet")[0].name.clone();
    // Exercise identities beyond f64's exact range in the same detected-table matcher.
    db.execute_batch(&format!("alter table \"{table}\" alter Value type bigint; update \"{table}\" set Value=9007199254740992 + cast(Value as bigint)" )).unwrap();
    let row = json!({"Name":"Bob","Value":{"$t":"int64","v":"9007199254740994"}});
    assert_eq!(
        ops.locate_xlsx_edit(&db, &table, "Value", row.as_object().unwrap())
            .unwrap()
            .target
            .unwrap()
            .row_ordinal,
        5
    );
    let row = json!({"Name":"Bob","Value":{"$t":"int64","v":"9007199254740993"}});
    assert!(
        ops.locate_xlsx_edit(&db, &table, "Value", row.as_object().unwrap())
            .unwrap()
            .target
            .is_none()
    );
}

#[test]
fn tagged_timestamps_keep_their_units_when_matching_rows() {
    let (db, mut ops) = book("repeated");
    let table = ops.detected_tables("Sheet")[0].name.clone();
    db.execute_batch(&format!("alter table \"{table}\" alter Value type timestamp using timestamp '2024-01-01 00:00:00.123456' + Value * interval '1 day'")).unwrap();
    let ticks: i64 = db
        .query_row(
            &format!("select epoch_us(Value) from \"{table}\" where Name='Bob'"),
            [],
            |r| r.get(0),
        )
        .unwrap();
    let row = json!({"Name":"Bob","Value":{"$t":"timestamp","v":ticks.to_string(),"unit":"us","tz":null}});
    assert_eq!(
        ops.locate_xlsx_edit(&db, &table, "Value", row.as_object().unwrap())
            .unwrap()
            .target
            .unwrap()
            .row_ordinal,
        5
    );
    let bad = json!({"Name":"Bob","Value":{"$t":"timestamp","v":ticks.to_string(),"unit":"garbage","tz":null}});
    assert_eq!(
        ops.locate_xlsx_edit(&db, &table, "Value", bad.as_object().unwrap())
            .unwrap_err()
            .kind,
        ErrKind::Invalid
    );
    let unknown: Value = json!({"Name":"Bob","Value":{"$t":"garbage","v":"2"}});
    assert!(
        ops.locate_xlsx_edit(&db, &table, "Value", unknown.as_object().unwrap())
            .is_err()
    );
}

#[test]
fn excel_early_dates_and_1904_epoch_preserve_calendar_days() {
    use common::*;
    let styles = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>"#;
    for (serials, date1904, expected) in [
        (
            [1, 59, 60, 61],
            false,
            ["1900-01-01", "1900-02-28", "1900-02-28", "1900-03-01"],
        ),
        (
            [0, 1, 59, 60],
            true,
            ["1904-01-01", "1904-01-02", "1904-02-29", "1904-03-01"],
        ),
    ] {
        let mut rows = String::from(
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Date</t></is></c></row>"#,
        );
        for (i, serial) in serials.iter().enumerate() {
            let r = i + 2;
            rows.push_str(&format!(r#"<row r="{r}"><c r="A{r}" t="inlineStr"><is><t>row{i}</t></is></c><c r="B{r}" s="1"><v>{serial}</v></c></row>"#));
        }
        let sheet = format!(
            r#"{SHEET_OPEN}<dimension ref="A1:B5"/><sheetData>{rows}</sheetData></worksheet>"#
        );
        let workbook = book(r#"<sheet name="S" sheetId="1" r:id="rId1"/>"#).replace(
            "<sheets>",
            &format!(
                r#"<workbookPr date1904="{}"/><sheets>"#,
                if date1904 { 1 } else { 0 }
            ),
        );
        let rel = rels(r#"<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>"#);
        let bytes = deflate(&[
            ("xl/workbook.xml", workbook.as_bytes()),
            ("xl/_rels/workbook.xml.rels", rel.as_bytes()),
            ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
            ("xl/styles.xml", styles.as_bytes()),
        ]);
        let db = Connection::open_in_memory().unwrap();
        let mut ops = XlsxOps::attach(&db, bytes, Options::default(), &|| false).unwrap();
        ops.prepare_all(&db, &|| false).unwrap();
        let table = &ops.detected_tables("S")[0].name;
        let sql = format!("select cast(cast(Date as date) as varchar) from \"{table}\"");
        let dates: Vec<String> = db
            .prepare(&sql)
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(dates, expected);
    }
}

fn truth() -> Value {
    serde_json::from_slice(
        &std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test/fixtures/xlsx-corpus/ground-truth.json"),
        )
        .unwrap(),
    )
    .unwrap()
}
fn range(t: &dfv_table_xlsx::sheet_tables::Region) -> String {
    use dfv_table_xlsx::xlsx_read::column_letters;
    format!(
        "{}{}:{}{}",
        column_letters(t.left as u32),
        t.top + 1,
        column_letters(t.right as u32 - 1),
        t.bottom
    )
}
fn cell_text(v: duckdb::types::Value) -> String {
    use duckdb::types::Value as V;
    match v {
        V::Null => "null".into(),
        V::Text(s) => s,
        V::Double(d) if d.fract() == 0.0 => format!("{}", d as i64),
        V::Double(d) => d.to_string(),
        V::BigInt(i) => i.to_string(),
        V::Int(i) => i.to_string(),
        other => format!("{other:?}"),
    }
}

/// EX-06 against the committed corpus ground truth (the TypeScript reference still misses these).
#[test]
fn declared_corpus_tables_match_ground_truth_names_ranges_columns_and_logical_rows() {
    let truth = truth();
    for name in ["explicit-single", "explicit-adjacent", "explicit-stacked"] {
        let (db, ops) = book(name);
        let want = truth["fixtures"][name]["tables"].as_array().unwrap();
        let got = ops.detected_tables("Sheet");
        assert_eq!(got.len(), want.len(), "{name}: table count");
        for (g, w) in got.iter().zip(want) {
            assert_eq!(g.name, w["declaredName"].as_str().unwrap(), "{name}: name");
            assert_eq!(g.provenance, "explicit", "{name}: provenance");
            assert_eq!(
                range(&g.table.region),
                w["range"].as_str().unwrap(),
                "{name}: range"
            );
            assert_eq!(
                g.table.columns,
                w["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>(),
                "{name}: columns"
            );
            let mut stmt = db
                .prepare(&format!("select * from \"{}\"", g.name))
                .unwrap();
            let rows: Vec<Vec<String>> = stmt
                .query_map([], |r| {
                    (0..g.table.columns.len())
                        .map(|i| r.get::<_, duckdb::types::Value>(i).map(cell_text))
                        .collect()
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            let expected: Vec<Vec<String>> = w["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    r.as_array()
                        .unwrap()
                        .iter()
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect()
                })
                .collect();
            assert_eq!(rows, expected, "{name}/{}: logical rows", g.name);
        }
    }
}

/// EX-01-OBS-1 natively: detector column metadata and the derived query name every column alike.
#[test]
fn detector_column_metadata_equals_the_derived_query_columns_for_every_corpus_fixture() {
    let truth = truth();
    let mut checked = 0;
    for (name, fx) in truth["fixtures"].as_object().unwrap() {
        let (db, ops) = book(name.trim_end_matches(".xlsx"));
        for sheet in fx["sheets"].as_array().unwrap() {
            for t in ops.detected_tables(sheet["name"].as_str().unwrap()) {
                let mut s = db
                    .prepare(&format!("select * from \"{}\" limit 0", t.name))
                    .unwrap();
                let _ = s.query([]).unwrap();
                assert_eq!(s.column_names(), t.columns, "{name}/{}", t.name);
                checked += 1;
            }
        }
    }
    assert!(checked >= 10, "{checked}");
}

fn inline(r: &str, t: &str) -> String {
    format!(r#"<c r="{r}" t="inlineStr"><is><t>{t}</t></is></c>"#)
}

#[test]
fn numbers_stored_as_text_are_read_as_numbers_only_beside_real_numbers() {
    let mut rows = format!(
        r#"<row r="1">{}{}{}</row>"#,
        inline("A1", "beta"),
        inline("B1", "code"),
        inline("C1", "mixed")
    );
    // (beta, code, mixed): numbers, text numbers, markers, identifiers, words.
    let data = [
        ("<v>1.5</v>", "007", "<v>1</v>"),
        ("TEXT:3.5e-09", "008", "TEXT:abc"),
        ("TEXT:NA", "009", "<v>2</v>"),
        ("<v>4</v>", "010", "<v>3</v>"),
        ("TEXT:-2.25", "011", "<v>4</v>"),
        ("<v>5</v>", "012", "<v>5</v>"),
    ];
    for (i, (a, b, c)) in data.iter().enumerate() {
        let n = i + 2;
        let cell = |col: &str, v: &str| match v.strip_prefix("TEXT:") {
            Some(t) => inline(&format!("{col}{n}"), t),
            None if v.starts_with('<') => format!(r#"<c r="{col}{n}">{v}</c>"#),
            None => inline(&format!("{col}{n}"), v),
        };
        rows += &format!(
            r#"<row r="{n}">{}{}{}</row>"#,
            cell("A", a),
            cell("B", b),
            cell("C", c)
        );
    }
    let sheet = format!(
        "{}<sheetData>{rows}</sheetData></worksheet>",
        common::SHEET_OPEN
    );
    let db = Connection::open_in_memory().unwrap();
    let mut ops = XlsxOps::attach(
        &db,
        common::one_sheet(&sheet, &[]),
        Options::default(),
        &|| false,
    )
    .unwrap();
    ops.prepare_all(&db, &|| false).unwrap();
    let table = ops.detected_tables("S")[0].name.clone();
    let types: Vec<String> = db
        .prepare(&format!(
            r#"select typeof(beta), typeof(code), typeof(mixed) from "{table}" limit 1"#
        ))
        .unwrap()
        .query_row([], |r| {
            Ok((0..3).map(|i| r.get::<_, String>(i).unwrap()).collect())
        })
        .unwrap();
    assert_eq!(types, ["DOUBLE", "VARCHAR", "VARCHAR"]);
    let sum: f64 = db
        .query_row(&format!(r#"select sum(beta) from "{table}""#), [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!((sum - (1.5 + 3.5e-9 + 4.0 - 2.25 + 5.0)).abs() < 1e-12);
    let nulls: i64 = db
        .query_row(
            &format!(r#"select count(*) from "{table}" where beta is null"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(nulls, 1);
    let codes: String = db
        .query_row(&format!(r#"select code from "{table}" limit 1"#), [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(codes, "007");
    assert!(
        ops.take_warnings()
            .iter()
            .any(|w| w.contains("2 numbers stored as text"))
    );
}
