//! Shared helpers: build small xlsx packages in memory.
#![allow(dead_code)]
use std::io::Write;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub fn zip_of(parts: &[(&str, &[u8])], method: CompressionMethod) -> Vec<u8> {
    let mut w = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o = SimpleFileOptions::default().compression_method(method);
    for (name, body) in parts {
        w.start_file(*name, o).unwrap();
        w.write_all(body).unwrap();
    }
    w.finish().unwrap().into_inner()
}

pub fn deflate(parts: &[(&str, &[u8])]) -> Vec<u8> {
    zip_of(parts, CompressionMethod::Deflated)
}

pub const RELS_OPEN: &str = r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#;

pub fn rels(entries: &str) -> String {
    format!("{RELS_OPEN}{entries}</Relationships>")
}

pub fn book(sheets: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{sheets}</sheets></workbook>"#
    )
}

pub const SHEET_OPEN: &str = r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#;

/// One sheet named "S" at xl/worksheets/sheet1.xml with the given worksheet XML and extra parts.
pub fn one_sheet(sheet_xml: &str, extra: &[(&str, &str)]) -> Vec<u8> {
    let wb = book(r#"<sheet name="S" sheetId="1" r:id="rId1"/>"#);
    let rl = rels(r#"<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>"#);
    let mut parts: Vec<(&str, &[u8])> = vec![
        ("xl/workbook.xml", wb.as_bytes()),
        ("xl/_rels/workbook.xml.rels", rl.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet_xml.as_bytes()),
    ];
    for (n, b) in extra {
        parts.push((n, b.as_bytes()));
    }
    deflate(&parts)
}
