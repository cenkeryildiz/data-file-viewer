//! Port of test/xlsxSheets.test.ts plus cell, style and merge reading.
mod common;
use common::*;
use dfv_table_xlsx::budget::WORKBOOK_LIMITS;
use dfv_table_xlsx::xlsx_read::*;

fn open(bytes: Vec<u8>) -> Package {
    Package::from_bytes(bytes, WORKBOOK_LIMITS).expect("package")
}

fn sheet_ref(p: &mut Package) -> SheetRef {
    p.list_sheets().unwrap().remove(0)
}

fn two(parts: &[(&str, &str)]) -> Vec<u8> {
    let p: Vec<(&str, &[u8])> = parts.iter().map(|(n, b)| (*n, b.as_bytes())).collect();
    deflate(&p)
}

#[test]
fn sheets_come_back_in_workbook_order_not_archive_order() {
    let wb = book(
        r#"<sheet name="Zebra" sheetId="1" r:id="rId3"/><sheet name="Apple" sheetId="2" r:id="rId1"/><sheet name="Mango" sheetId="3" r:id="rId2"/>"#,
    );
    let rl = rels(
        r#"<Relationship Id="rId1" Type="x" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet3.xml"/><Relationship Id="rId3" Type="x" Target="worksheets/sheet1.xml"/>"#,
    );
    let mut p = open(two(&[
        ("xl/workbook.xml", &wb),
        ("xl/_rels/workbook.xml.rels", &rl),
        ("xl/worksheets/sheet1.xml", "<worksheet/>"),
    ]));
    let got = p.list_sheets().unwrap();
    assert_eq!(
        got.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["Zebra", "Apple", "Mango"]
    );
    assert_eq!(
        got.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(),
        [
            "xl/worksheets/sheet1.xml",
            "xl/worksheets/sheet2.xml",
            "xl/worksheets/sheet3.xml"
        ]
    );
}

#[test]
fn attribute_order_does_not_matter() {
    let excel = two(&[
        (
            "xl/workbook.xml",
            &book(r#"<sheet name="S" sheetId="1" r:id="rId1"/>"#),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            &rels(r#"<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>"#),
        ),
    ]);
    let openpyxl = two(&[
        (
            "xl/workbook.xml",
            &book(r#"<sheet r:id="rId1" sheetId="1" name="S"/>"#),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            &rels(r#"<Relationship Type="t" Target="worksheets/sheet1.xml" Id="rId1"/>"#),
        ),
    ]);
    assert_eq!(
        open(excel).list_sheets().unwrap(),
        open(openpyxl).list_sheets().unwrap()
    );
}

#[test]
fn absolute_and_dot_relative_targets_both_resolve() {
    let mut p = open(two(&[
        (
            "xl/workbook.xml",
            &book(
                r#"<sheet name="Abs" sheetId="1" r:id="rId1"/><sheet name="Dot" sheetId="2" r:id="rId2"/>"#,
            ),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            &rels(
                r#"<Relationship Id="rId1" Type="t" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="./worksheets/sheet2.xml"/>"#,
            ),
        ),
    ]));
    let got = p.list_sheets().unwrap();
    assert_eq!(got[0].path, "xl/worksheets/sheet1.xml");
    assert_eq!(got[1].path, "xl/worksheets/sheet2.xml");
}

#[test]
fn names_with_entities_and_quotes_are_decoded() {
    let mut p = open(two(&[
        (
            "xl/workbook.xml",
            &book(
                r#"<sheet name="P&amp;L &lt;2026&gt;" sheetId="1" r:id="rId1"/><sheet name="O&apos;Brien" sheetId="2" r:id="rId2"/><sheet name="Ünï &#233; &#x41;" sheetId="3" r:id="rId3"/>"#,
            ),
        ),
        ("xl/_rels/workbook.xml.rels", &rels("")),
    ]));
    let names: Vec<String> = p
        .list_sheets()
        .unwrap()
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(names, ["P&L <2026>", "O'Brien", "Ünï é A"]);
}

#[test]
fn a_zip_that_is_not_a_workbook_is_refused_not_silently_empty() {
    let mut p = open(two(&[("not/a/workbook.txt", "hello")]));
    let e = p.list_sheets().unwrap_err();
    assert!(e.message.contains("no xl/workbook.xml"), "{e}");
}

#[test]
fn a_file_that_is_not_a_zip_at_all_is_refused() {
    let e = Package::from_bytes(
        b"this is plainly not a zip archive".to_vec(),
        WORKBOOK_LIMITS,
    )
    .err()
    .unwrap();
    assert_eq!(e.code, "archive_incomplete");
}

#[test]
fn a_sheet_whose_rid_resolves_to_nothing_still_lists_with_an_empty_path() {
    let mut p = open(two(&[
        (
            "xl/workbook.xml",
            &book(r#"<sheet name="Orphan" sheetId="1" r:id="rIdMissing"/>"#),
        ),
        ("xl/_rels/workbook.xml.rels", &rels("")),
    ]));
    assert_eq!(
        p.list_sheets().unwrap(),
        vec![SheetRef {
            name: "Orphan".into(),
            path: String::new()
        }]
    );
}

#[test]
fn duplicate_names_keep_the_first_and_nameless_sheets_are_skipped() {
    let mut p = open(two(&[
        (
            "xl/workbook.xml",
            &book(
                r#"<sheet name="A" r:id="r1"/><sheet name="A" r:id="r2"/><sheet r:id="r3"/><sheet name="B" r:id="r4"/>"#,
            ),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            &rels(
                r#"<Relationship Id="r1" Target="worksheets/1.xml"/><Relationship Id="r2" Target="worksheets/2.xml"/><Relationship Id="r4" Target="worksheets/4.xml"/>"#,
            ),
        ),
    ]));
    let got = p.list_sheets().unwrap();
    assert_eq!(
        got.iter()
            .map(|s| (s.name.as_str(), s.path.as_str()))
            .collect::<Vec<_>>(),
        [("A", "xl/worksheets/1.xml"), ("B", "xl/worksheets/4.xml")]
    );
}

/* -------------------------------------------------------------- dimensions */

fn rows(n: usize, cols: &str) -> String {
    (0..n)
        .map(|r| {
            let cells: String = cols
                .chars()
                .map(|c| format!(r#"<c r="{c}{}"><v>{r}</v></c>"#, r + 2))
                .collect();
            format!(r#"<row r="{}">{cells}</row>"#, r + 2)
        })
        .collect()
}
fn sheet(dim: &str, body: &str, pad: &str) -> String {
    format!("{SHEET_OPEN}{pad}{dim}<sheetData>{body}</sheetData></worksheet>")
}
fn dims_of(xml: &str) -> Option<SheetDimension> {
    let mut p = open(one_sheet(xml, &[]));
    p.dimension("xl/worksheets/sheet1.xml").unwrap()
}
fn dim(fr: u32, lr: u32, fc: &str, lc: &str) -> Option<SheetDimension> {
    Some(SheetDimension {
        first_row: fr,
        last_row: lr,
        first_col: fc.into(),
        last_col: lc.into(),
    })
}

#[test]
fn a_declared_dimension_is_returned_as_declared_even_with_a_prefix() {
    assert_eq!(
        dims_of(&sheet(
            r#"<dimension ref="A2:C40001"/>"#,
            &rows(3, "ABC"),
            ""
        )),
        dim(2, 40001, "A", "C")
    );
    assert_eq!(
        dims_of(&sheet(r#"<x:dimension ref="B3:D9"/>"#, &rows(3, "ABC"), "")),
        dim(3, 9, "B", "D")
    );
    assert_eq!(
        dims_of(&sheet(r#"<dimension ref="A1"/>"#, "", "")),
        dim(1, 1, "A", "A")
    );
}

#[test]
fn undeclared_unparseable_and_late_declarations_are_measured_from_the_cells() {
    assert_eq!(dims_of(&sheet("", &rows(5, "BD"), "")), dim(2, 6, "B", "D"));
    assert_eq!(
        dims_of(&sheet(
            r#"<dimension ref="nonsense"/>"#,
            &rows(5, "ABC"),
            ""
        )),
        dim(2, 6, "A", "C")
    );
    let pad = format!(r#"<sheetPr codeName="{}"/>"#, "p".repeat(300 * 1024));
    assert_eq!(
        dims_of(&sheet(r#"<dimension ref="A1:Z9"/>"#, &rows(5, "ABC"), &pad)),
        dim(2, 6, "A", "C")
    );
}

#[test]
fn an_empty_sheet_has_no_dimension_and_a_missing_part_is_refused() {
    assert_eq!(dims_of(&sheet("", "", "")), None);
    let mut p = open(one_sheet(&sheet("", "", ""), &[]));
    assert!(p.dimension("xl/worksheets/nope.xml").is_err());
}

#[test]
fn a_truncated_package_is_refused_at_open_not_read_as_a_smaller_workbook() {
    let full = one_sheet(
        &sheet(r#"<dimension ref="A2:C9"/>"#, &rows(2000, "ABC"), ""),
        &[],
    );
    for cut in [0.1, 0.5, 0.9, 0.999] {
        let part = full[..(full.len() as f64 * cut) as usize].to_vec();
        assert!(
            Package::from_bytes(part, WORKBOOK_LIMITS).is_err(),
            "cut {cut}"
        );
    }
}

#[test]
fn ordinary_flipped_bytes_never_panic() {
    let full = one_sheet(
        &sheet(r#"<dimension ref="A2:C9"/>"#, &rows(200, "ABC"), ""),
        &[],
    );
    for at in [0usize, 40, 200, 500, full.len() / 2, full.len() - 30] {
        let mut b = full.clone();
        b[at] ^= 0xff;
        let _ = Package::from_bytes(b, WORKBOOK_LIMITS).and_then(|mut p| {
            let s = p.list_sheets()?;
            p.read_sheet(&s[0])
        });
    }
}

/* ---------------------------------------------------------------- cell reading */

const SST: &str = r#"<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>Name</t></si><si><r><t xml:space="preserve">Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si><si><t xml:space="preserve">  padded  </t></si><si><t>a&amp;b &lt;c&gt;</t></si></sst>"#;

#[test]
fn every_cell_kind_is_read_with_its_formula_style_and_coordinates() {
    let xml = sheet(
        r#"<dimension ref="A1:F3"/>"#,
        r##"<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" s="2"><v>22446</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>inline</t></is></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="e"><v>#REF!</v></c><c r="D2"><f>1+1</f><v>2</v></c><c r="E2" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="F2" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>
<row><c t="n"><v>1.5e-7</v></c><c s="1"/><c r="C3" s="1"/><c><f t="shared" si="3"/><v>9</v></c></row>"##,
        "",
    ) + "";
    let xml = xml.replace(
        "</sheetData>",
        "</sheetData><mergeCells count=\"1\"><mergeCell ref=\"A1:B1\"/></mergeCells>",
    );
    let styles = r##"<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red]\-#,##0.00"/></numFmts><cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="165"/><xf numFmtId="164"/></cellXfs></styleSheet>"##;
    let mut p = open(one_sheet(
        &xml,
        &[("xl/sharedStrings.xml", SST), ("xl/styles.xml", styles)],
    ));
    let sref = sheet_ref(&mut p);
    let s = p.read_sheet(&sref).unwrap();
    let text = |r: u32, c: u32| s.cells.get(&(r, c)).map(XlCell::text);
    assert_eq!(text(0, 0).as_deref(), Some("Name"));
    assert_eq!(
        text(0, 1).as_deref(),
        Some("Rich text"),
        "phonetic runs are not part of the value"
    );
    assert_eq!(
        text(0, 2).as_deref(),
        Some("  padded  "),
        "whitespace is kept exactly"
    );
    assert_eq!(text(0, 3).as_deref(), Some("a&b <c>"));
    assert_eq!(s.cells[&(0, 4)].value, Value::Number("22446".into()));
    assert_eq!(s.cells[&(0, 4)].style, 2);
    assert_eq!(s.cells[&(1, 0)].value, Value::Text("inline".into()));
    assert_eq!(s.cells[&(1, 1)].value, Value::Bool(true));
    assert_eq!(s.cells[&(1, 2)].value, Value::Error("#REF!".into()));
    assert_eq!(s.cells[&(1, 3)].formula.as_ref().unwrap().text, "1+1");
    assert_eq!(s.cells[&(1, 3)].value, Value::Number("2".into()));
    assert_eq!(s.cells[&(1, 4)].value, Value::Text("ab".into()));
    assert_eq!(
        s.cells[&(1, 4)].formula.as_ref().unwrap().text,
        "\"a\"&\"b\""
    );
    assert_eq!(s.cells[&(1, 5)].value, Value::Error("#DIV/0!".into()));
    assert_eq!(s.cells[&(1, 5)].formula.as_ref().unwrap().text, "1/0");
    // A row without `r` continues from the previous row; a cell without `r` takes the next column.
    assert_eq!(s.cells[&(2, 0)].value, Value::Number("1.5e-7".into()));
    // Styled-but-empty cells hold nothing; a shared-formula child keeps its index and no text.
    assert!(!s.cells.contains_key(&(2, 1)) && !s.cells.contains_key(&(2, 2)));
    let child = &s.cells[&(2, 3)];
    assert_eq!(
        child.formula,
        Some(Formula {
            text: String::new(),
            shared_index: Some(3)
        })
    );
    assert_eq!(
        s.merges,
        vec![CellRange {
            top: 0,
            left: 0,
            bottom: 0,
            right: 1
        }]
    );
    assert_eq!(s.declared, dim(1, 3, "A", "F"));
    assert_eq!(s.extent(), (3, 6));

    let styles = p.styles().unwrap();
    assert_eq!(styles.len(), 3, "only cellXfs count, not cellStyleXfs");
    assert!(!styles[0].is_date && !styles[1].is_date && styles[2].is_date);
    assert_eq!(styles[2].format_code.as_deref(), Some("yyyy\\-mm\\-dd"));
}

#[test]
fn builtin_and_custom_date_formats_are_classified() {
    let styles = r#"<styleSheet xmlns="x"><numFmts count="4"><numFmt numFmtId="170" formatCode="&quot;Date: &quot;0.0"/><numFmt numFmtId="171" formatCode="[h]:mm:ss"/><numFmt numFmtId="172" formatCode="[Red]0.00"/><numFmt numFmtId="173" formatCode="dd/mm/yyyy hh:mm"/></numFmts><cellXfs count="7"><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="9"/><xf numFmtId="170"/><xf numFmtId="171"/><xf numFmtId="172"/><xf numFmtId="173"/></cellXfs></styleSheet>"#;
    let mut p = open(one_sheet(&sheet("", "", ""), &[("xl/styles.xml", styles)]));
    let got: Vec<bool> = p.styles().unwrap().iter().map(|s| s.is_date).collect();
    assert_eq!(got, [true, true, false, false, true, false, true]);
}

#[test]
fn cell_references_past_the_sheet_bounds_never_allocate_a_grid() {
    // A far corner must not turn into a dense grid: the sparse map holds one cell, and the dense
    // text grid refuses to materialise past the cell limit.
    let xml = sheet(
        "",
        r#"<row r="1048576"><c r="XFD1048576"><v>1</v></c><c r="A1048576"><v>2</v></c></row>"#,
        "",
    );
    let mut p = open(one_sheet(&xml, &[]));
    let r = sheet_ref(&mut p);
    let s = p.read_sheet(&r).unwrap();
    assert_eq!(s.cells.len(), 2);
    assert_eq!(
        s.text_grid(WORKBOOK_LIMITS.cells_per_sheet)
            .unwrap_err()
            .code,
        "cell_limit"
    );
    assert_eq!(parse_cell_ref("XFE1"), None);
    assert_eq!(parse_cell_ref("A1048577"), None);
    assert_eq!(parse_cell_ref("A0"), None);
    assert_eq!(parse_cell_ref("XFD1048576"), Some((1_048_575, 16_383)));
}

#[test]
fn the_cell_limit_stops_a_sheet_before_it_is_materialised() {
    let body = rows(50, "ABCD");
    let mut p = Package::from_bytes(
        one_sheet(&sheet("", &body, ""), &[]),
        dfv_table_xlsx::budget::Limits::tighter(dfv_table_xlsx::budget::Tighter {
            cells_per_sheet: Some(100),
            ..Default::default()
        })
        .unwrap(),
    )
    .unwrap();
    let r = sheet_ref(&mut p);
    assert_eq!(p.read_sheet(&r).unwrap_err().code, "cell_limit");
}

#[test]
fn a_bad_shared_string_reference_is_refused_not_guessed() {
    let xml = sheet("", r#"<row r="1"><c r="A1" t="s"><v>99</v></c></row>"#, "");
    let mut p = open(one_sheet(&xml, &[("xl/sharedStrings.xml", SST)]));
    let r = sheet_ref(&mut p);
    assert!(p.read_sheet(&r).is_err());
}

#[test]
fn column_helpers_round_trip() {
    for i in [0u32, 1, 25, 26, 27, 51, 52, 701, 702, 16_383] {
        assert_eq!(column_index(&column_letters(i)), i);
    }
    assert_eq!(column_letters(16_383), "XFD");
}
