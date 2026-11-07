//! SAFE-X4: hostile or replaced workbook archives, through the production `open` and `updateCell` routes.
//! Every refusal is typed, the source bytes and its directory are untouched, and nothing is published or
//! backed up. Production decompression limits are used unchanged (256 MiB per part, 512 MiB in total).
//! Run with a private `DFV_TABLE_STATE_DIR`.
use dfv_table_engine::Tables;
use dfv_table_protocol::errors::*;
use dfv_table_protocol::{Control, ErrorBody, Lane};
use flate2::{Compression, write::DeflateEncoder};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// One test at a time: the state directory is shared and the assertions compare whole-tree snapshots.
static SERIAL: Mutex<()> = Mutex::new(());
const MIB: u64 = 1 << 20;

fn call(t: &mut Tables, m: &str, v: Value) -> Result<Value, ErrorBody> {
    t.call(m, v.as_object().unwrap(), &Control::unbounded())
}
fn state() -> PathBuf {
    PathBuf::from(
        std::env::var_os("DFV_TABLE_STATE_DIR").expect("run with a private DFV_TABLE_STATE_DIR"),
    )
}
/// Every file below `root` with its size, so an added, removed or resized file is visible.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, u64> {
    fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, u64>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let m = std::fs::symlink_metadata(&p).unwrap();
            if m.is_dir() {
                walk(&p, out);
            } else {
                out.insert(p, m.len());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, &mut out);
    out
}

// ---- a tiny ZIP writer that can lie ---------------------------------------------------------------------------
#[derive(Clone)]
struct E {
    name: String,
    method: u16,
    flags: u16,
    body: Vec<u8>, // stored bytes (already deflated when method 8)
    crc: u32,
    csize: u32,
    size: u32,
    local_extra: Vec<u8>,
    central_extra: Vec<u8>,
    offset: Option<u32>, // central record offset override
    hidden: bool,        // present in the file but absent from the central directory
}
fn plain(name: &str, data: &[u8]) -> E {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(data).unwrap();
    let body = enc.finish().unwrap();
    E {
        name: name.into(),
        method: 8,
        flags: 0,
        csize: body.len() as u32,
        size: data.len() as u32,
        crc: crc32fast::hash(data),
        body,
        local_extra: vec![],
        central_extra: vec![],
        offset: None,
        hidden: false,
    }
}
/// `n` zero bytes deflated in 1 MiB steps; the whole expansion never exists in memory.
fn zeros(name: &str, n: u64) -> E {
    let (mut enc, mut hasher) = (
        DeflateEncoder::new(Vec::new(), Compression::new(6)),
        crc32fast::Hasher::new(),
    );
    let chunk = vec![0u8; MIB as usize];
    let mut left = n;
    while left > 0 {
        let k = left.min(MIB) as usize;
        enc.write_all(&chunk[..k]).unwrap();
        hasher.update(&chunk[..k]);
        left -= k as u64;
    }
    let body = enc.finish().unwrap();
    E {
        name: name.into(),
        method: 8,
        flags: 0,
        csize: body.len() as u32,
        size: n as u32,
        crc: hasher.finalize(),
        body,
        local_extra: vec![],
        central_extra: vec![],
        offset: None,
        hidden: false,
    }
}
fn build(entries: &[E]) -> Vec<u8> {
    let (mut out, mut central, mut offsets) = (Vec::new(), Vec::new(), Vec::new());
    for e in entries {
        offsets.push(out.len() as u32);
        out.extend([0x50, 0x4b, 3, 4, 20, 0]);
        out.extend(e.flags.to_le_bytes());
        out.extend(e.method.to_le_bytes());
        out.extend([0, 0, 0x21, 0x58]);
        out.extend(e.crc.to_le_bytes());
        out.extend(e.csize.to_le_bytes());
        out.extend(e.size.to_le_bytes());
        out.extend((e.name.len() as u16).to_le_bytes());
        out.extend((e.local_extra.len() as u16).to_le_bytes());
        out.extend(e.name.as_bytes());
        out.extend(&e.local_extra);
        out.extend(&e.body);
    }
    let listed = entries.iter().filter(|e| !e.hidden).count();
    for (e, at) in entries.iter().zip(&offsets).filter(|(e, _)| !e.hidden) {
        central.extend([0x50, 0x4b, 1, 2, 20, 0, 20, 0]);
        central.extend(e.flags.to_le_bytes());
        central.extend(e.method.to_le_bytes());
        central.extend([0, 0, 0x21, 0x58]);
        central.extend(e.crc.to_le_bytes());
        central.extend(e.csize.to_le_bytes());
        central.extend(e.size.to_le_bytes());
        central.extend((e.name.len() as u16).to_le_bytes());
        central.extend((e.central_extra.len() as u16).to_le_bytes());
        central.extend([0u8; 10]);
        central.extend(e.offset.unwrap_or(*at).to_le_bytes());
        central.extend(e.name.as_bytes());
        central.extend(&e.central_extra);
    }
    let cd = out.len() as u32;
    out.extend(&central);
    out.extend([0x50, 0x4b, 5, 6, 0, 0, 0, 0]);
    out.extend((listed as u16).to_le_bytes());
    out.extend((listed as u16).to_le_bytes());
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(cd.to_le_bytes());
    out.extend([0, 0]);
    out
}
const WORKBOOK: &str = r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
const RELS: &str = r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>"#;
const SHEET: &str = r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Bob</t></is></c><c r="B2"><v>2</v></c></row></sheetData></worksheet>"#;
fn base() -> Vec<E> {
    vec![
        plain("xl/workbook.xml", WORKBOOK.as_bytes()),
        plain("xl/_rels/workbook.xml.rels", RELS.as_bytes()),
        plain("xl/worksheets/sheet1.xml", SHEET.as_bytes()),
    ]
}
fn zip64_extra(size: u64, csize: u64) -> Vec<u8> {
    let mut x = vec![1, 0, 16, 0];
    x.extend(size.to_le_bytes());
    x.extend(csize.to_le_bytes());
    x
}

// ---- open refusals ---------------------------------------------------------------------------------------------
/// Open `bytes` as a workbook in a private directory and demand a typed refusal that leaves everything untouched.
fn refuse_open(label: &str, bytes: &[u8], code: &str) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hostile.xlsx");
    std::fs::write(&path, bytes).unwrap();
    let (state_before, dir_before) = (snapshot(&state()), snapshot(dir.path()));
    let mut t = Tables::default();
    let e = call(&mut t, "open", json!({"path":path})).expect_err(label);
    assert_eq!(e.code, code, "{label}: {e:?}");
    assert!(!e.message.is_empty() && e.message.len() < 200, "{label}");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        bytes,
        "{label}: source bytes"
    );
    assert_eq!(
        snapshot(dir.path()),
        dir_before,
        "{label}: source directory"
    );
    assert_eq!(
        snapshot(&state()),
        state_before,
        "{label}: nothing published or backed up"
    );
    // The refusal is not sticky: the engine still opens an ordinary workbook afterwards.
    let ok = dir.path().join("ok.xlsx");
    std::fs::write(&ok, build(&base())).unwrap();
    call(&mut t, "open", json!({"path":ok})).unwrap_or_else(|e| panic!("{label}: {e:?}"));
}

#[test]
fn malformed_overlapping_encrypted_and_zip64_archives_are_refused_at_open() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // A baseline proves the builder itself produces a workbook the engine accepts.
    let dir = tempfile::tempdir().unwrap();
    let ok = dir.path().join("ok.xlsx");
    std::fs::write(&ok, build(&base())).unwrap();
    call(&mut Tables::default(), "open", json!({"path":ok})).expect("baseline workbook opens");

    let mut encrypted = base();
    encrypted[2].flags |= 1;
    refuse_open("encrypted member", &build(&encrypted), UNSUPPORTED);

    // Overlap: the sheet's central record points into the middle of the first member's data.
    let mut overlap = base();
    overlap[2].offset = Some(30 + overlap[0].name.len() as u32 + 4);
    refuse_open("overlapping member", &build(&overlap), MALFORMED_VALUE);

    // Two central records for one local header (the same bytes listed under two names).
    let mut alias = base();
    alias.push(E {
        name: "xl/worksheets/sheet2.xml".into(),
        offset: Some(0),
        ..alias[2].clone()
    });
    refuse_open("aliased local header", &build(&alias), MALFORMED_VALUE);

    // ZIP64 size markers with no ZIP64 structure behind them.
    let mut z64 = base();
    z64[2].size = u32::MAX;
    z64[2].csize = u32::MAX;
    refuse_open(
        "zip64 sizes without zip64 data",
        &build(&z64),
        RESOURCE_LIMIT,
    );

    // A well-formed member that no central record lists must not be skipped.
    let mut hidden = base();
    hidden.push(E {
        hidden: true,
        ..plain("xl/worksheets/sheet2.xml", b"<worksheet/>")
    });
    refuse_open(
        "member outside the central directory",
        &build(&hidden),
        MALFORMED_VALUE,
    );

    // Truncation (the end-of-central-directory record is lost).
    let whole = build(&base());
    refuse_open(
        "truncated archive",
        &whole[..whole.len() - 30],
        MALFORMED_VALUE,
    );
    refuse_open("empty file", b"", MALFORMED_VALUE);

    // XML entity declarations are refused even though the archive itself is sound.
    let mut entity = base();
    entity[0] = plain(
        "xl/workbook.xml",
        format!("<!DOCTYPE x [<!ENTITY a \"b\">]>{WORKBOOK}").as_bytes(),
    );
    refuse_open("entity declaration", &build(&entity), RESOURCE_LIMIT);
}

// ---- write-path refusals ---------------------------------------------------------------------------------------
fn edit(session: &str, table: &str, mid: &str, from: &str, to: &str) -> Value {
    json!({"session":session,"expected_revision":"1","mutation_id":mid,"table":table,"column":"Name",
           "new_value":to,"row_values":{"Name":from,"Value":{"$t":"float64","v":"2"}}})
}
fn open_unlocked(t: &mut Tables, path: &Path) -> (String, String, PathBuf) {
    let s = call(t, "open", json!({"path":path})).unwrap()["session"]
        .as_str()
        .unwrap()
        .to_owned();
    let q = call(
        t,
        "runQuery",
        json!({"session":s,"sql":"select * from Sheet","prepare_sheet":"Sheet"}),
    )
    .unwrap();
    let table = q["workbook_metadata"]["detected_tables"][0]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    let unlocked = call(
        t,
        "setSafeMode",
        json!({"session":s,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    (
        s,
        table,
        PathBuf::from(unlocked["backup_path"].as_str().unwrap()),
    )
}
/// An `updateCell` that must be refused: typed, `not-published`, source and backup bytes and every published file unchanged.
/// `ledgered`: whether the refusal happened after the one-shot id was recorded (then its status is `not-published`;
/// a refusal before that has no record, which the status lookup conservatively reports as `unknown`).
fn refuse_edit(
    t: &mut Tables,
    label: &str,
    path: &Path,
    request: Value,
    backup: &Path,
    code: &str,
    ledgered: bool,
) {
    let (source, backup_bytes) = (std::fs::read(path).unwrap(), std::fs::read(backup).unwrap());
    let (dir_before, state_before) = (snapshot(path.parent().unwrap()), snapshot(&state()));
    let mid = request["mutation_id"].as_str().unwrap().to_owned();
    let e = call(t, "updateCell", request).expect_err(label);
    assert_eq!(e.code, code, "{label}: {e:?}");
    assert_eq!(e.mutation_outcome, Some("not-published"), "{label}");
    assert_eq!(
        std::fs::read(path).unwrap(),
        source,
        "{label}: source bytes"
    );
    assert_eq!(
        std::fs::read(backup).unwrap(),
        backup_bytes,
        "{label}: backup bytes"
    );
    assert_eq!(
        snapshot(path.parent().unwrap()),
        dir_before,
        "{label}: source directory"
    );
    // Only the one-shot-id record may be added; no publication or backup file appears or changes.
    let after = snapshot(&state());
    for (p, n) in &state_before {
        assert_eq!(after.get(p), Some(n), "{label}: {p:?} changed");
    }
    for p in after.keys().filter(|p| !state_before.contains_key(*p)) {
        assert!(
            ledgered
                && p.to_string_lossy()
                    .contains(&format!("mutations/mutation-{mid}")),
            "{label}: new file {p:?}"
        );
    }
    let status = call(t, "queryMutationOutcome", json!({"mutation_id":mid})).unwrap();
    assert_eq!(
        status["outcome"],
        if ledgered { "not-published" } else { "unknown" },
        "{label}: {status}"
    );
}

#[test]
fn archives_the_rewriter_cannot_preserve_exactly_refuse_the_edit_and_publish_nothing() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    // Control: the same members, ordinary headers, edit successfully and change only the sheet.
    let good = dir.path().join("good.xlsx");
    std::fs::write(&good, build(&base())).unwrap();
    let mut t = Tables::default();
    let (s, table, _) = open_unlocked(&mut t, &good);
    let r = call(
        &mut t,
        "updateCell",
        edit(&s, &table, "x4-control", "Bob", "Rob"),
    )
    .unwrap();
    assert_eq!(r["rows_changed"], "1");

    // ZIP64 extra field on the sheet's local header: readable, but a rewrite would leave stale 64-bit sizes.
    let mut z64 = base();
    z64[2].local_extra = zip64_extra(z64[2].size.into(), z64[2].csize.into());
    let path = dir.path().join("zip64-local.xlsx");
    std::fs::write(&path, build(&z64)).unwrap();
    let mut t = Tables::default();
    let (s, table, backup) = open_unlocked(&mut t, &path);
    refuse_edit(
        &mut t,
        "zip64 local extra",
        &path,
        edit(&s, &table, "x4-zip64", "Bob", "Rob"),
        &backup,
        MALFORMED_VALUE,
        true,
    );
}

#[test]
fn an_externally_replaced_or_hostile_source_is_stale_and_left_exactly_as_found() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.xlsx");
    std::fs::write(&path, build(&base())).unwrap();
    let mut t = Tables::default();
    let (s, table, backup) = open_unlocked(&mut t, &path);

    // Replaced by another valid workbook of different content.
    let mut other = base();
    other[2] = plain(
        "xl/worksheets/sheet1.xml",
        SHEET.replace("Bob", "Eve").as_bytes(),
    );
    std::fs::write(&path, build(&other)).unwrap();
    refuse_edit(
        &mut t,
        "replaced workbook",
        &path,
        edit(&s, &table, "x4-replaced", "Bob", "Rob"),
        &backup,
        STALE_SOURCE,
        false,
    );

    // Replaced by an archive whose sheet claims 10 bytes but inflates to megabytes: judged stale, never inflated.
    let mut lying = zeros("xl/worksheets/sheet1.xml", 8 * MIB);
    lying.size = 10;
    std::fs::write(&path, build(&[base()[0].clone(), base()[1].clone(), lying])).unwrap();
    refuse_edit(
        &mut t,
        "lying replacement",
        &path,
        edit(&s, &table, "x4-lying", "Bob", "Rob"),
        &backup,
        STALE_SOURCE,
        false,
    );

    // Replaced by a truncated file.
    let whole = build(&base());
    std::fs::write(&path, &whole[..whole.len() / 2]).unwrap();
    refuse_edit(
        &mut t,
        "truncated replacement",
        &path,
        edit(&s, &table, "x4-trunc", "Bob", "Rob"),
        &backup,
        STALE_SOURCE,
        false,
    );

    // Deleted.
    std::fs::remove_file(&path).unwrap();
    let e = call(
        &mut t,
        "updateCell",
        edit(&s, &table, "x4-deleted", "Bob", "Rob"),
    )
    .unwrap_err();
    assert_eq!(e.mutation_outcome, Some("not-published"), "{e:?}");
    assert!(
        !path.exists(),
        "a refused edit must not recreate the source"
    );
}

// ---- production decompression budgets ---------------------------------------------------------------------------
#[test]
fn production_decompression_budgets_refuse_bombs_without_touching_anything() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // Honest oversized part: 257 MiB of zeros in one member (limit 256 MiB), a few hundred KiB on disk.
    let big = zeros("xl/worksheets/sheet1.xml", 257 * MIB);
    let mut parts = base();
    parts[2] = big;
    let bomb = build(&parts);
    assert!(
        bomb.len() < 2 * MIB as usize,
        "the bomb really is small: {}",
        bomb.len()
    );
    refuse_open("oversized part", &bomb, RESOURCE_LIMIT);

    // Declared small, inflates huge: the directory's claim is not trusted.
    parts[2].size = 10;
    refuse_open("lying declared size", &build(&parts), RESOURCE_LIMIT);

    // Expansion ratio across parts: three 200 MiB parts (each within the part limit) exceed 512 MiB in total.
    let part = zeros("xl/worksheets/sheet1.xml", 200 * MIB);
    let mut parts = base();
    parts.pop();
    for n in 1..=3 {
        let mut p = part.clone();
        p.name = format!("xl/worksheets/sheet{n}.xml");
        parts.push(p);
    }
    let bomb = build(&parts);
    assert!(bomb.len() < 3 * MIB as usize, "{}", bomb.len());
    refuse_open("total expansion", &bomb, RESOURCE_LIMIT);

    // Declared oversized member with a tiny honest body is refused from the directory, before inflation.
    let mut parts = base();
    parts[2].size = 300 * MIB as u32;
    refuse_open("declared oversized", &build(&parts), RESOURCE_LIMIT);
}
