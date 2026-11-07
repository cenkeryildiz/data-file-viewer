//! Cell-level behaviour of `patch_cell` on a hand-built workbook (the cases of test/xlsxWrite.test.ts that do not
//! need DuckDB; the TypeScript is compared case by case in tests/differential.rs).
use dfv_table_xlsx_patch::xlsx_patch::{column_index_of, js_number_string, sha256_hex};
use dfv_table_xlsx_patch::zip::{index_zip, read_member};
use dfv_table_xlsx_patch::{CellValue, PatchRequest, patch_cell};
use flate2::{Compression, write::DeflateEncoder};
use std::io::Write;

const SHEET: &str = r#"<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="B1" t="inlineStr"><is><t>name</t></is></c><c r="C1" t="inlineStr"><is><t>qty</t></is></c><c r="D1" t="inlineStr"><is><t>total</t></is></c></row>
<row r="2"><c r="B2" t="inlineStr"><is><t>widget</t></is></c><c r="C2" s="4"><v>2</v></c><c r="D2" s="7"><v>5.5</v></c></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>bolt</t></is></c><c r="C3" s="4"><v>10</v></c><c r="D3" s="7"><f t="shared" si="0">C3*2</f><v>20</v></c></row>
<row r="4"><c r="B4" t="inlineStr"><is><t>nut</t></is></c><c r="C4" s="4"><v>7</v></c></row>
</sheetData></worksheet>"#;
const SHEET_PATH: &str = "xl/worksheets/sheet1.xml";

fn zip(members: &[(&str, &[u8])]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data) in members {
        let mut e = DeflateEncoder::new(Vec::new(), Compression::new(6));
        e.write_all(data).unwrap();
        let body = e.finish().unwrap();
        let crc = crc32fast::hash(data);
        let off = out.len() as u32;
        out.extend([0x50, 0x4b, 3, 4, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0]);
        out.extend(crc.to_le_bytes());
        out.extend((body.len() as u32).to_le_bytes());
        out.extend((data.len() as u32).to_le_bytes());
        out.extend((name.len() as u16).to_le_bytes());
        out.extend([0, 0]);
        out.extend(name.as_bytes());
        out.extend(&body);
        central.extend([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0]);
        central.extend(crc.to_le_bytes());
        central.extend((body.len() as u32).to_le_bytes());
        central.extend((data.len() as u32).to_le_bytes());
        central.extend((name.len() as u16).to_le_bytes());
        central.extend([0u8; 12]);
        central.extend(off.to_le_bytes());
        central.extend(name.as_bytes());
    }
    let cd = out.len() as u32;
    out.extend(&central);
    out.extend([0x50, 0x4b, 5, 6, 0, 0, 0, 0]);
    out.extend((members.len() as u16).to_le_bytes());
    out.extend((members.len() as u16).to_le_bytes());
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(cd.to_le_bytes());
    out.extend([0, 0]);
    out
}

fn book() -> Vec<u8> {
    zip(&[
        ("[Content_Types].xml", b"<Types/>"),
        (SHEET_PATH, SHEET.as_bytes()),
        ("xl/worksheets/sheet2.xml", b"<keep/>"),
    ])
}

fn req(col: &str, row: i64, cur: CellValue, new: CellValue) -> PatchRequest {
    PatchRequest {
        sheet_path: SHEET_PATH.into(),
        column_name: col.into(),
        column_names: vec!["name".into(), "qty".into(), "total".into()],
        row_ordinal: row,
        verbatim: false,
        expected_sha256: None,
        expected_current: cur,
        new_value: new,
    }
}
fn text(s: &str) -> CellValue {
    CellValue::Text(s.into())
}
fn sheet_of(bytes: &[u8]) -> String {
    String::from_utf8(
        read_member(&index_zip(bytes).unwrap(), SHEET_PATH)
            .unwrap()
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn column_letters_and_numbers_format_like_javascript() {
    for (l, i) in [
        ("A", 0),
        ("Z", 25),
        ("AA", 26),
        ("AZ", 51),
        ("BA", 52),
        ("ZZ", 701),
        ("AAA", 702),
    ] {
        assert_eq!(column_index_of(l), i, "{l}");
    }
    for (n, s) in [
        (0.0, "0"),
        (-0.0, "0"),
        (12.0, "12"),
        (0.1 + 0.2, "0.30000000000000004"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (1e-7, "1e-7"),
        (1.5e-10, "1.5e-10"),
        (0.000001, "0.000001"),
        (-123.456, "-123.456"),
        (f64::MAX, "1.7976931348623157e+308"),
        (5e-324, "5e-324"),
    ] {
        assert_eq!(js_number_string(n), s);
    }
}

#[test]
fn number_lands_by_header_name_with_style_kept_and_everything_else_untouched() {
    let original = book();
    let out = patch_cell(
        &original,
        &req("qty", 1, CellValue::Number(2.0), CellValue::Number(99.0)),
    )
    .unwrap();
    assert_eq!(out.cell, "C2");
    let xml = sheet_of(&out.bytes);
    assert!(xml.contains(r#"<c r="C2" s="4"><v>99</v></c>"#), "{xml}");
    assert_eq!(
        xml.replace(
            r#"<c r="C2" s="4"><v>99</v></c>"#,
            r#"<c r="C2" s="4"><v>2</v></c>"#
        ),
        SHEET
    );
    let (a, b) = (
        index_zip(&original).unwrap(),
        index_zip(&out.bytes).unwrap(),
    );
    for n in ["[Content_Types].xml", "xl/worksheets/sheet2.xml"] {
        assert_eq!(read_member(&a, n).unwrap(), read_member(&b, n).unwrap());
    }
}

#[test]
fn strings_are_escaped_and_numeric_text_in_a_text_cell_stays_text() {
    let out = patch_cell(&book(), &req("name", 1, text("widget"), text("a<b & c"))).unwrap();
    assert!(sheet_of(&out.bytes).contains(
        r#"<c r="B2" t="inlineStr"><is><t xml:space="preserve">a&lt;b &amp; c</t></is></c>"#
    ));
    let out = patch_cell(&book(), &req("name", 1, text("widget"), text("0009"))).unwrap();
    assert!(sheet_of(&out.bytes).contains(r#"t="inlineStr"><is><t xml:space="preserve">0009</t>"#));
    let out = patch_cell(
        &book(),
        &req("qty", 1, CellValue::Number(2.0), text("12.50")),
    )
    .unwrap();
    assert!(sheet_of(&out.bytes).contains(r#"<c r="C2" s="4"><v>12.50</v></c>"#));
}

#[test]
fn dollar_sequences_in_the_new_text_are_written_literally() {
    let out = patch_cell(
        &book(),
        &req("name", 1, text("widget"), text("a $& b $1 $$")),
    )
    .unwrap();
    assert!(sheet_of(&out.bytes).contains("a $&amp; b $1 $$"));
}

#[test]
fn a_missing_cell_is_inserted_in_column_order() {
    let out = patch_cell(
        &book(),
        &req("total", 3, CellValue::Null, CellValue::Number(3.0)),
    )
    .unwrap();
    let xml = sheet_of(&out.bytes);
    assert!(
        xml.contains(r#"<c r="C4" s="4"><v>7</v></c><c r="D4"><v>3</v></c></row>"#),
        "{xml}"
    );
}

#[test]
fn refusals_leave_nothing_to_publish() {
    let b = book();
    let e = |r: PatchRequest| patch_cell(&b, &r).err().unwrap().0;
    assert!(
        e(req(
            "qty",
            1,
            CellValue::Number(3.0),
            CellValue::Number(1.0)
        ))
        .contains("Refusing to overwrite")
    );
    assert!(
        e(req("qty", 1, CellValue::Null, CellValue::Number(1.0)))
            .contains("but the grid was showing (empty)")
    );
    assert!(
        e(req(
            "total",
            2,
            CellValue::Number(20.0),
            CellValue::Number(1.0)
        ))
        .contains("holds a formula (=C3*2)")
    );
    assert!(
        e(req("qty", 9, CellValue::Null, CellValue::Number(1.0)))
            .contains("past the end of this sheet")
    );
    assert!(
        e(req(
            "qty",
            0,
            CellValue::Number(2.0),
            CellValue::Number(1.0)
        ))
        .contains("past the end")
    );
    let mut r = req("qty", 1, CellValue::Number(2.0), CellValue::Number(1.0));
    r.column_names = vec!["name".into(), "nope".into()];
    assert!(e(r).contains("Could not find the header row"));
    let mut r = req("qty", 1, CellValue::Number(2.0), CellValue::Number(1.0));
    r.sheet_path = "xl/worksheets/sheet9.xml".into();
    assert!(e(r).contains("has no worksheet part"));
    let mut r = req("qty", 1, CellValue::Number(2.0), CellValue::Number(1.0));
    r.expected_sha256 = Some(sha256_hex(b"other"));
    assert!(e(r).contains("changed after it was read"));
    let mut r = req("qty", 1, CellValue::Number(2.0), CellValue::Number(5.0));
    r.expected_sha256 = Some(sha256_hex(&b));
    assert!(patch_cell(&b, &r).is_ok(), "matching hash is accepted");
}

#[test]
fn hostile_inputs_are_errors() {
    for bytes in [
        b"".to_vec(),
        b"PK\x03\x04junk".to_vec(),
        book()[..60].to_vec(),
    ] {
        assert!(
            patch_cell(
                &bytes,
                &req("qty", 1, CellValue::Number(2.0), CellValue::Number(1.0))
            )
            .is_err()
        );
    }
    // A sheet that is not UTF-8 is refused rather than re-encoded with replacement characters.
    let bad = zip(&[(SHEET_PATH, &[b'<', 0xff, 0xfe, b'>'][..])]);
    let e = patch_cell(
        &bad,
        &req("qty", 1, CellValue::Number(2.0), CellValue::Number(1.0)),
    )
    .err()
    .unwrap()
    .0;
    assert!(e.contains("not valid UTF-8"), "{e}");
}

#[test]
fn invalid_xml_text_and_untyped_bigints_refuse() {
    let original = book();
    for value in [
        text("bad\0text"),
        text("bad\u{b}text"),
        text("bad\u{fffe}text"),
        CellValue::BigInt("1</v><bad/>".into()),
        CellValue::BigInt("-".into()),
    ] {
        assert!(patch_cell(&original, &req("name", 1, text("widget"), value)).is_err());
    }
}

#[test]
fn extreme_coordinates_refuse_without_panicking() {
    assert_eq!(column_index_of(&"Z".repeat(100)), -1);
    let original = book();
    assert!(
        patch_cell(
            &original,
            &req(
                "qty",
                i64::MAX,
                CellValue::Number(2.0),
                CellValue::Number(3.0)
            )
        )
        .is_err()
    );
    let mut request = req(&"Z".repeat(100), 2, CellValue::Null, text("new"));
    request.verbatim = true;
    assert!(patch_cell(&original, &request).is_err());
}
