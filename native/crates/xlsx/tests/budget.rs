//! Port of test/xlsxBudget.test.ts: the preflight judges the archive before anything is parsed.
mod common;
use common::*;
use dfv_table_xlsx::budget::*;
use sha2::{Digest, Sha256};
use zip::CompressionMethod;

fn pf(bytes: &[u8]) -> Result<String, Refusal> {
    preflight_bytes(bytes, &WORKBOOK_LIMITS)
}
fn pf_with(bytes: &[u8], t: Tighter) -> Result<String, Refusal> {
    preflight_bytes(bytes, &Limits::tighter(t).expect("valid budget"))
}
fn code(r: Result<String, Refusal>) -> &'static str {
    r.expect_err("expected a refusal").code
}
fn find(b: &[u8], needle: &[u8]) -> usize {
    b.windows(needle.len())
        .position(|w| w == needle)
        .expect("needle")
}
const CENTRAL: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];
const LOCAL: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];
fn put32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_le_bytes());
}
fn put16(b: &mut [u8], at: usize, v: u16) {
    b[at..at + 2].copy_from_slice(&v.to_le_bytes());
}

#[test]
fn clean_archives_pass_and_return_the_sha256_of_exactly_their_bytes() {
    let clean = deflate(&[("xl/workbook.xml", b"<workbook/>")]);
    let want: String = Sha256::digest(&clean)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(pf(&clean).unwrap(), want);
    // Stored members and a member with a data descriptor (streamed writer) are ordinary.
    assert!(
        pf(&zip_of(
            &[("xl/a.xml", b"<a/>"), ("xl/b.xml", b"<b/>")],
            CompressionMethod::Stored
        ))
        .is_ok()
    );
    // Written by Python zipfile to a non-seekable stream, so every member carries a descriptor.
    let streamed = include_bytes!("fixtures/data-descriptors.zip");
    assert!(
        streamed.windows(4).any(|w| w == [0x50, 0x4b, 0x07, 0x08]),
        "fixture has no data descriptor"
    );
    assert!(pf(streamed).is_ok());
}

#[test]
fn unsafe_paths_are_refused() {
    for name in [
        "../outside.xml",
        "/absolute.xml",
        "C:\\outside.xml",
        "xl/../../outside.xml",
    ] {
        assert_eq!(
            code(pf(&deflate(&[(name, b"<x/>")]))),
            "archive_path",
            "{name}"
        );
    }
}

#[test]
fn entity_declarations_are_refused_in_any_encoding() {
    for xml in [
        &b"<!DOCTYPE x SYSTEM \"file:///synthetic\"><x/>"[..],
        b"<!ENTITY x \"synthetic\">",
        b"<!  doctype x>",
    ] {
        assert_eq!(code(pf(&deflate(&[("xl/workbook.xml", xml)]))), "entity");
    }
    let utf16: Vec<u8> = "\u{feff}<!DOCTYPE x SYSTEM \"file:///synthetic\"><x/>"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(code(pf(&deflate(&[("xl/workbook.xml", &utf16)]))), "entity");
    // Not an XML part, and not a declaration: both pass.
    assert!(pf(&deflate(&[("xl/media/image1.bin", b"<!DOCTYPE x>")])).is_ok());
}

#[test]
fn an_entity_declaration_split_across_inflation_chunks_is_still_found() {
    let mut xml = vec![b' '; 65536 - 4];
    xml.extend_from_slice(b"<!DOCTYPE x>");
    assert_eq!(code(pf(&deflate(&[("xl/big.xml", &xml)]))), "entity");
}

#[test]
fn actual_inflation_limits_are_enforced() {
    let two = deflate(&[("xl/a.xml", &[b'x'; 8192]), ("xl/b.xml", &[b'y'; 8192])]);
    assert!(pf(&two).is_ok());
    assert_eq!(
        code(pf_with(
            &two,
            Tighter {
                inflated_bytes: Some(12000),
                ..Default::default()
            }
        )),
        "decompression"
    );
    let e = code(pf_with(
        &two,
        Tighter {
            part_bytes: Some(4000),
            ..Default::default()
        },
    ));
    assert!(e == "archive_limit" || e == "decompression", "{e}");
    assert_eq!(
        code(pf_with(
            &two,
            Tighter {
                entries: Some(1),
                ..Default::default()
            }
        )),
        "archive_limit"
    );
    assert_eq!(
        code(pf_with(
            &two,
            Tighter {
                compressed_bytes: Some(1),
                ..Default::default()
            }
        )),
        "compressed_size"
    );
    assert_eq!(
        Limits::tighter(Tighter {
            entries: Some(10_001),
            ..Default::default()
        })
        .unwrap_err()
        .code,
        "invalid_budget"
    );
    assert_eq!(
        Limits::tighter(Tighter {
            entries: Some(0),
            ..Default::default()
        })
        .unwrap_err()
        .code,
        "invalid_budget"
    );
}

#[test]
fn a_lying_directory_size_does_not_hide_a_bomb() {
    let mut bomb = deflate(&[(
        "xl/a.xml",
        format!("<a>{}</a>", " ".repeat(64 * 1024)).as_bytes(),
    )]);
    let central = find(&bomb, &CENTRAL);
    put32(&mut bomb, central + 24, 10);
    let local = find(&bomb, &LOCAL);
    put32(&mut bomb, local + 22, 10);
    let e = code(pf_with(
        &bomb,
        Tighter {
            part_bytes: Some(16 * 1024),
            ..Default::default()
        },
    ));
    assert!(e == "decompression" || e == "undecodable", "{e}");
}

#[test]
fn normalised_duplicate_names_are_refused() {
    assert_eq!(
        code(pf(&deflate(&[
            ("xl\\a.xml", b"<a/>"),
            ("xl/a.xml", b"<b/>")
        ]))),
        "archive_path"
    );
}

#[test]
fn a_local_header_naming_a_different_path_is_judged_by_the_local_name() {
    let mut m = deflate(&[("xl/ok.xml", b"<x/>")]);
    let at = find(&m, b"xl/ok.xml");
    m[at..at + 9].copy_from_slice(b"../o.xml!");
    assert_eq!(code(pf(&m)), "archive_path");
    // A harmless disagreement is still a disagreement.
    let mut m = deflate(&[("xl/ok.xml", b"<x/>")]);
    m[at..at + 9].copy_from_slice(b"xl/ok.XML");
    assert_eq!(code(pf(&m)), "archive_header");
}

#[test]
fn disagreeing_about_the_compression_method_cannot_bypass_limits() {
    let mut b = deflate(&[(
        "xl/a.xml",
        format!("<a>{}</a>", "x".repeat(65536)).as_bytes(),
    )]);
    let central = find(&b, &CENTRAL);
    put16(&mut b, central + 10, 0); // central says stored; local header still says deflate
    put32(&mut b, central + 24, 10);
    let e = code(pf_with(
        &b,
        Tighter {
            inflated_bytes: Some(1024),
            ..Default::default()
        },
    ));
    assert!(
        ["decompression", "archive_header", "undecodable"].contains(&e),
        "{e}"
    );
}

#[test]
fn a_member_omitted_from_the_central_directory_is_not_skipped() {
    let bytes = deflate(&[
        ("xl/hidden.xml", b"<!DOCTYPE x><x/>"),
        ("xl/visible.xml", b"<x/>"),
    ]);
    let first = find(&bytes, &CENTRAL);
    let len = 46
        + u16::from_le_bytes([bytes[first + 28], bytes[first + 29]]) as usize
        + u16::from_le_bytes([bytes[first + 30], bytes[first + 31]]) as usize
        + u16::from_le_bytes([bytes[first + 32], bytes[first + 33]]) as usize;
    let mut altered = [&bytes[..first], &bytes[first + len..]].concat();
    let end = altered.len() - 22;
    put16(&mut altered, end + 8, 1);
    put16(&mut altered, end + 10, 1);
    let cd_size = u32::from_le_bytes(altered[end + 12..end + 16].try_into().unwrap()) - len as u32;
    put32(&mut altered, end + 12, cd_size);
    let c = code(pf(&altered));
    assert!(c == "archive_layout" || c == "entity", "{c}");
}

#[test]
fn bytes_before_the_first_member_are_refused_and_trailing_bytes_tolerated() {
    let ok = deflate(&[("xl/workbook.xml", b"<workbook/>")]);
    assert_eq!(
        code(pf(&[b"PREFIX".as_slice(), &ok].concat())),
        "archive_layout"
    );
    // Bytes after the end record are tolerated, exactly as the TypeScript does: they hide no member,
    // because every member must be reachable from the central directory.
    let mut t = ok.clone();
    t.extend_from_slice(b"garbage");
    assert!(pf(&t).is_ok());
}

#[test]
fn truncated_and_empty_inputs_are_incomplete() {
    let ok = deflate(&[("xl/workbook.xml", b"<workbook/>")]);
    for cut in [0, 10, ok.len() / 2, ok.len() - 1] {
        assert_eq!(code(pf(&ok[..cut])), "archive_incomplete", "cut {cut}");
    }
}

#[test]
fn the_entity_scanner_matches_only_declarations() {
    let mut s = EntityScanner::new("xl/a.xml");
    assert!(!s.finds(b"<a b=\"<!x\">text &amp; <![CDATA[<!d]]></a>"));
    assert!(s.finds(b"<!DOCTYPE"));
    let mut s = EntityScanner::new("xl/a.XML");
    assert!(s.finds(b"<!Entity foo>"));
    let mut s = EntityScanner::new("xl/a.png");
    assert!(!s.finds(b"<!DOCTYPE"));
}
