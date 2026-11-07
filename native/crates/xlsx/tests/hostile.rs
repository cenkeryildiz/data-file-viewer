//! D3.8 hostile packages: flipped bytes and truncations of the container, and mutated XML inside a package
//! whose ZIP is rebuilt with valid CRCs (so the parsers, not just the inflater, are reached). Every outcome
//! is a value or a typed `Refusal`: never a panic, and never one allocation beyond what the limits allow.
mod common;
use common::*;
use dfv_table_xlsx::budget::{Limits, Tighter, WORKBOOK_LIMITS};
use dfv_table_xlsx::detect_sheet_tables;
use dfv_table_xlsx::sheet_tables::DetectOptions;
use dfv_table_xlsx::xlsx_read::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Peak;
static BIGGEST: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        BIGGEST.fetch_max(l.size(), Ordering::Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        BIGGEST.fetch_max(l.size(), Ordering::Relaxed);
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        BIGGEST.fetch_max(n, Ordering::Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static A: Peak = Peak;

fn tight() -> Limits {
    Limits::tighter(Tighter {
        compressed_bytes: Some(1 << 20),
        inflated_bytes: Some(4 << 20),
        part_bytes: Some(2 << 20),
        entries: Some(100),
        cells_per_sheet: Some(50_000),
    })
    .unwrap()
}
/// Everything a viewer reads from a workbook.
fn read_everything(bytes: Vec<u8>, l: Limits) {
    let Ok(mut p) = Package::from_bytes(bytes, l) else {
        return;
    };
    let _ = p.date1904();
    let _ = p.styles();
    let Ok(sheets) = p.list_sheets() else { return };
    for s in sheets {
        let _ = p.dimension(&s.path);
        if let Ok(sh) = p.read_sheet(&s) {
            let _ = detect_sheet_tables(&sh, l.cells_per_sheet, &DetectOptions::default());
        }
    }
}

const SST: &str = r#"<?xml version="1.0"?><sst xmlns="x" count="2" uniqueCount="2"><si><t>Name</t></si><si><r><t xml:space="preserve">Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>P</t></rPh></si></sst>"#;
const STYLES: &str = r#"<styleSheet xmlns="x"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>"#;
const SHEET: &str = r##"<?xml version="1.0"?><worksheet xmlns="x"><dimension ref="A1:D4"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>in</t></is></c></row><row r="2"><c r="A2" s="1"><v>45000</v></c><c r="B2" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="C2" t="b"><v>1</v></c><c r="D2"><f t="shared" si="0" ref="D2:D4">A2+1</f><v>2</v></c></row><row r="3"><c r="D3"><f t="shared" si="0"/><v>3</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>"##;

fn good(parts: &[(&str, &[u8])]) -> Vec<u8> {
    deflate(parts)
}

#[test]
fn flipped_and_truncated_containers_end_typed_within_limits() {
    let wb = book(r#"<sheet name="S" sheetId="1" r:id="rId1"/>"#);
    let rl = rels(r#"<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>"#);
    let full = good(&[
        ("xl/workbook.xml", wb.as_bytes()),
        ("xl/_rels/workbook.xml.rels", rl.as_bytes()),
        ("xl/worksheets/sheet1.xml", SHEET.as_bytes()),
        ("xl/sharedStrings.xml", SST.as_bytes()),
        ("xl/styles.xml", STYLES.as_bytes()),
    ]);
    for at in 0..full.len() {
        for mask in [0xffu8, 0x01] {
            let mut b = full.clone();
            b[at] ^= mask;
            read_everything(b, tight());
        }
    }
    for cut in 0..full.len() {
        assert!(
            Package::from_bytes(full[..cut].to_vec(), tight()).is_err(),
            "cut {cut}"
        );
    }
    let biggest = BIGGEST.load(Ordering::Relaxed);
    assert!(
        biggest <= 12 << 20,
        "largest single allocation {biggest} bytes under tight limits"
    );
}

/// Deterministic xorshift, so a failure reproduces.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}
fn mutate(src: &str, rng: &mut Rng) -> Vec<u8> {
    let mut b = src.as_bytes().to_vec();
    for _ in 0..1 + rng.below(4) {
        if b.is_empty() {
            break;
        }
        let at = rng.below(b.len());
        match rng.below(5) {
            0 => b[at] = rng.next() as u8,
            1 => b.truncate(at.max(1)),
            2 => {
                let end = (at + 1 + rng.below(40)).min(b.len());
                let chunk = b[at..end].to_vec();
                drop(b.splice(at..at, chunk));
            }
            3 => {
                b.remove(at);
            }
            _ => drop(b.splice(at..at, *b"<c r=\"ZZZ9\" t=\"s\"><v>99999999999</v></c>")),
        }
    }
    b
}

#[test]
fn mutated_xml_parts_end_typed_within_limits() {
    let wb = book(r#"<sheet name="S" sheetId="1" r:id="rId1"/>"#);
    let rl = rels(r#"<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>"#);
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let parts = [
        ("xl/workbook.xml", wb.as_str()),
        ("xl/_rels/workbook.xml.rels", rl.as_str()),
        ("xl/worksheets/sheet1.xml", SHEET),
        ("xl/sharedStrings.xml", SST),
        ("xl/styles.xml", STYLES),
    ];
    let mut runs = 0;
    for victim in 0..parts.len() {
        for _ in 0..1500 {
            let bodies: Vec<Vec<u8>> = parts
                .iter()
                .enumerate()
                .map(|(i, (_, s))| {
                    if i == victim {
                        mutate(s, &mut rng)
                    } else {
                        s.as_bytes().to_vec()
                    }
                })
                .collect();
            let named: Vec<(&str, &[u8])> = parts
                .iter()
                .zip(&bodies)
                .map(|((n, _), b)| (*n, b.as_slice()))
                .collect();
            read_everything(zip_of(&named, zip::CompressionMethod::Stored), tight());
            runs += 1;
        }
    }
    assert_eq!(runs, 7500);
    let biggest = BIGGEST.load(Ordering::Relaxed);
    assert!(
        biggest <= 12 << 20,
        "largest single allocation {biggest} bytes under tight limits"
    );
}

#[test]
fn a_shared_string_table_of_empty_entries_is_capped_not_amplified() {
    // 5 bytes of `<si/>` become a 24-byte String each: 10 MB of XML would be ~50 MB resident.
    let sst = format!(r#"<sst xmlns="x">{}</sst>"#, "<si/>".repeat(40_000));
    let xml = format!(
        r#"{SHEET_OPEN}<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>"#
    );
    let l = Limits::tighter(Tighter {
        cells_per_sheet: Some(1000),
        ..Default::default()
    })
    .unwrap();
    let mut p = Package::from_bytes(one_sheet(&xml, &[("xl/sharedStrings.xml", &sst)]), l).unwrap();
    let r = p.list_sheets().unwrap().remove(0);
    assert_eq!(p.read_sheet(&r).unwrap_err().code, "cell_limit");
    let mut p = Package::from_bytes(
        one_sheet(&xml, &[("xl/sharedStrings.xml", &sst)]),
        WORKBOOK_LIMITS,
    )
    .unwrap();
    assert!(
        p.read_sheet(&r).is_ok(),
        "the default limit admits an ordinary string table"
    );
}

#[test]
fn column_helpers_never_panic_on_hostile_letters() {
    for s in ["", "a", "1", "A1", "ÄÖ", "ZZZZZZZZZZZZZZZZZZZZ"] {
        let _ = column_index(s);
    }
    assert_eq!(column_index("A"), 0);
    assert_eq!(column_index("XFD"), 16_383);
}

#[test]
fn a_formula_without_a_cached_result_keeps_its_place_but_not_a_grid_value() {
    let xml = format!(
        r#"{SHEET_OPEN}<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1+1</f></c><c r="C1"><f>""</f><v></v></c></row></sheetData></worksheet>"#
    );
    let mut p = Package::from_bytes(one_sheet(&xml, &[]), WORKBOOK_LIMITS).unwrap();
    let r = p.list_sheets().unwrap().remove(0);
    let s = p.read_sheet(&r).unwrap();
    assert_eq!(s.cells.len(), 3, "both formula cells are stored cells");
    assert_eq!(s.cells[&(0, 1)].formula.as_ref().unwrap().text, "A1+1");
    let g = s.text_grid(WORKBOOK_LIMITS.cells_per_sheet).unwrap();
    assert_eq!(g, vec![vec![Some("1".to_string()), None, None]]);
}
