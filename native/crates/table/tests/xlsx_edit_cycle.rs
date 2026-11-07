//! SAFE-X3: 100 alternating grow/shrink text edits to one workbook cell through the production `updateCell`
//! route (safe mode off, one mutation id per edit). After every edit the ZIP is checked member by member;
//! every 10 edits the session is closed and reopened and openpyxl reads the file independently.
//! Run with a private `DFV_TABLE_STATE_DIR` and `DFV_REF_PYTHON` (the myproject interpreter).
use dfv_table_engine::Tables;
use dfv_table_protocol::{Control, ErrorBody, Lane};
use dfv_table_xlsx_patch::zip::{index_zip, read_member};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

const SHEET: &str = "xl/worksheets/sheet1.xml";
const EDITS: usize = 100;
const CHECK_EVERY: usize = 10;
const LONG_CHARS: usize = 10_016;

fn call(t: &mut Tables, m: &str, v: Value) -> Result<Value, ErrorBody> {
    t.call(m, v.as_object().unwrap(), &Control::unbounded())
}
fn tree_bytes(root: &Path) -> (u64, usize) {
    let (mut bytes, mut files) = (0, 0);
    for e in std::fs::read_dir(root).unwrap() {
        let e = e.unwrap();
        let m = std::fs::symlink_metadata(e.path()).unwrap();
        if m.is_dir() {
            let (b, f) = tree_bytes(&e.path());
            bytes += b;
            files += f;
        } else {
            bytes += m.len();
            files += 1;
        }
    }
    (bytes, files)
}
/// Sorted file names in `dir`: backups sit beside the source, so this is where backup growth would show.
fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}
/// Deterministic, hard-to-compress text so the "long" state really is long on disk.
fn long_text(seed: usize) -> String {
    let mut x = 0x9e37_79b9_7f4a_7c15u64 ^ (seed as u64);
    (0..LONG_CHARS)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            char::from(b'a' + (x % 26) as u8)
        })
        .collect()
}
fn members(bytes: &[u8]) -> Vec<(String, u32, usize, Vec<u8>)> {
    let idx = index_zip(bytes).expect("a patched workbook stays inside the rewriter's scope");
    idx.entries
        .iter()
        .map(|e| {
            let data = read_member(&idx, &e.name).unwrap().unwrap();
            (e.name.clone(), e.crc, e.size, data)
        })
        .collect()
}
fn oracle(original: &Path, current: &Path, expected: &str) {
    let python = std::env::var("DFV_REF_PYTHON").expect("use the myproject interpreter");
    let out = Command::new(python)
        .args(["-B", "-I", "-c", ORACLE])
        .arg(original)
        .arg(current)
        .arg(expected)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn peak_rss_mib() -> u64 {
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    (u.ru_maxrss as u64) / (1024 * 1024) // macOS reports bytes
}
fn open(t: &mut Tables, path: &Path) -> (String, String) {
    let o = call(t, "open", json!({"path":path})).unwrap();
    let s = o["session"].as_str().unwrap().to_owned();
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
    (s, table)
}
fn name_cell(t: &mut Tables, s: &str, table: &str) -> String {
    let q = call(
        t,
        "runQuery",
        json!({"session":s,"sql":format!("select \"Name\" from \"{table}\" order by 1")}),
    )
    .unwrap();
    q["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[0].as_str().unwrap().to_owned())
        .filter(|v| v != "Alice")
        .collect::<Vec<_>>()
        .join("|")
}

/// A save reopens the workbook; the detected-table names the document was already using must keep answering,
/// with the edited value (never the pre-edit one), and again after a second save.
#[test]
fn a_detected_table_stays_queryable_by_name_after_a_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.xlsx");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures/xlsx-corpus/repeated.xlsx");
    std::fs::copy(&fixture, &path).unwrap();
    let mut t = Tables::default();
    let (s, table) = open(&mut t, &path);
    call(
        &mut t,
        "setSafeMode",
        json!({"session":s,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    let (mut revision, mut current) = ("1".to_owned(), "Bob".to_owned());
    for (i, next) in ["Zed", "Yan"].into_iter().enumerate() {
        let receipt = call(
            &mut t,
            "updateCell",
            json!({"session":s,"expected_revision":revision,"mutation_id":format!("dt-{}-{i}", std::process::id()),
                   "table":table,"column":"Name","new_value":next,
                   "row_values":{"Name":current,"Value":{"$t":"float64","v":"2"}}}),
        )
        .unwrap();
        revision = receipt["source_after"]["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        current = next.to_owned();
        assert_eq!(
            name_cell(&mut t, &s, &table),
            current,
            "save {i}: detected table by name"
        );
    }
}

#[test]
fn one_hundred_grow_shrink_edits_keep_the_workbook_bounded_and_exact() {
    let state = PathBuf::from(
        std::env::var_os("DFV_TABLE_STATE_DIR").expect("run with a private DFV_TABLE_STATE_DIR"),
    );
    let dir = tempfile::tempdir().unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures/xlsx-corpus/repeated.xlsx");
    let original = dir.path().join("original.xlsx");
    let path = dir.path().join("rows.xlsx");
    std::fs::copy(&fixture, &original).unwrap();
    std::fs::copy(&fixture, &path).unwrap();
    let original_bytes = std::fs::read(&original).unwrap();
    let original_members = members(&original_bytes);

    let mut t = Tables::default();
    let (mut s, table) = open(&mut t, &path);
    // Unlocking makes one backup beside the source; backups = (path, bytes at creation), all re-checked every edit.
    let mut backups: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let unlock = |t: &mut Tables, s: &str, backups: &mut Vec<(PathBuf, Vec<u8>)>| {
        let u = call(
            t,
            "setSafeMode",
            json!({"session":s,"enabled":false,"expected_revision":"1"}),
        )
        .unwrap();
        let p = PathBuf::from(u["backup_path"].as_str().unwrap());
        let bytes = std::fs::read(&p).unwrap();
        backups.push((p, bytes));
    };
    unlock(&mut t, &s, &mut backups);
    assert_eq!(backups[0].1, original_bytes);
    let backup_count = |dir: &Path| {
        names(dir)
            .iter()
            .filter(|n| n.starts_with("rows.backup-"))
            .count()
    };
    assert_eq!(backup_count(dir.path()), 1);

    let (mut revision, mut current) = ("1".to_owned(), "Bob".to_owned());
    let (mut first_long, mut first_short) = (0usize, 0usize);
    let mut ids = std::collections::HashSet::new();
    let mut state_at_10 = (0u64, 0usize);
    let mut seen_receipts = 0usize;
    let mut lock_sidecars: Option<usize> = None;
    for i in 1..=EDITS {
        let grow = i % 2 == 1;
        let next = if grow {
            long_text(0)
        } else {
            "short".to_owned()
        };
        let mid = format!("x3-{}-{i}", std::process::id());
        assert!(ids.insert(mid.clone()));
        let receipt = call(
            &mut t,
            "updateCell",
            json!({"session":s,"expected_revision":revision,"mutation_id":mid,"table":table,"column":"Name",
                   "new_value":next,"row_values":{"Name":current,"Value":{"$t":"float64","v":"2"}}}),
        )
        .unwrap_or_else(|e| panic!("edit {i}: {e:?}"));
        assert_eq!(receipt["rows_changed"], "1", "edit {i}");
        seen_receipts += 1;
        revision = receipt["source_after"]["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        current = next;

        // Every edit: the status lookup returns the same receipt; ZIP structure and unrelated members are exact.
        let status = call(&mut t, "queryMutationOutcome", json!({"mutation_id":mid})).unwrap();
        assert_eq!(status["receipt"], receipt, "edit {i}");
        let bytes = std::fs::read(&path).unwrap();
        let got = members(&bytes);
        assert_eq!(
            got.iter().map(|m| &m.0).collect::<Vec<_>>(),
            original_members.iter().map(|m| &m.0).collect::<Vec<_>>(),
            "edit {i}: member names/order"
        );
        for (g, o) in got.iter().zip(&original_members) {
            if g.0 == SHEET {
                let xml = std::str::from_utf8(&g.3).unwrap();
                assert!(xml.contains(&current), "edit {i}: new text in the sheet");
                assert_eq!(xml.matches(&current).count(), 1, "edit {i}");
            } else {
                assert_eq!(
                    (&g.1, g.2, &g.3),
                    (&o.1, o.2, &o.3),
                    "edit {i}: {} changed",
                    g.0
                );
            }
        }
        // The long fixed text appears nowhere but the sheet; no leftover long text survives a shrink.
        if !grow {
            let sheet = got.iter().find(|m| m.0 == SHEET).unwrap();
            assert!(
                !std::str::from_utf8(&sheet.3)
                    .unwrap()
                    .contains(&long_text(0)[..64])
            );
        }
        // Size bound, fixed by the first grow and the first shrink: later cycles reproduce them exactly.
        let size = bytes.len();
        if grow {
            if first_long == 0 {
                first_long = size;
            }
            assert_eq!(size, first_long, "edit {i}: grown workbook size");
        } else {
            if first_short == 0 {
                first_short = size;
            }
            assert_eq!(size, first_short, "edit {i}: shrunk workbook size");
        }
        assert!(
            size < original_bytes.len() + 2 * LONG_CHARS,
            "edit {i}: {size}"
        );
        // Edits never rewrite or multiply backups: only an explicit unlock makes one.
        for (p, bytes) in &backups {
            assert_eq!(
                &std::fs::read(p).unwrap(),
                bytes,
                "edit {i}: backup rewritten"
            );
        }
        assert_eq!(
            backup_count(dir.path()),
            backups.len(),
            "edit {i}: backup count"
        );
        // Everything beside the source is a known kind, and lock sidecars do not grow with edits.
        let beside = names(dir.path());
        assert!(
            beside.iter().all(|n| n == "original.xlsx"
                || n == "rows.xlsx"
                || n.starts_with("rows.backup-")
                || n.starts_with(".dfv-table-lock-")),
            "edit {i}: stray files {beside:?}"
        );
        let locks = beside
            .iter()
            .filter(|n| n.starts_with(".dfv-table-lock-"))
            .count();
        assert_eq!(
            locks,
            *lock_sidecars.get_or_insert(locks),
            "edit {i}: lock sidecars grew within a session"
        );

        if i % CHECK_EVERY == 0 {
            // Export, close, reopen from disk (a new session), read natively, then read independently.
            call(&mut t, "close", json!({"session":s})).unwrap();
            let (reopened, table2) = open(&mut t, &path);
            assert_eq!(table2, table);
            assert_eq!(
                name_cell(&mut t, &reopened, &table2),
                current,
                "edit {i}: native reopen"
            );
            oracle(&original, &path, &current);
            if i < EDITS {
                unlock(&mut t, &reopened, &mut backups); // backs up the exported file as it now is
                revision = "1".into();
                lock_sidecars = None;
            }
            s = reopened;
            let fp = tree_bytes(&state);
            if i == CHECK_EVERY {
                state_at_10 = fp;
            }
            eprintln!(
                "edit {i}: {} lock sidecars, workbook {size} B, {} backups, state dir {} B in {} files",
                locks,
                backups.len(),
                fp.0,
                fp.1
            );
        }
    }
    assert_eq!(seen_receipts, EDITS);
    // Final state equals a freshly built equivalent: the original with one edit to the final text.
    let fresh = dir.path().join("fresh.xlsx");
    std::fs::copy(&fixture, &fresh).unwrap();
    let mut t2 = Tables::default();
    let (s3, table3) = open(&mut t2, &fresh);
    call(
        &mut t2,
        "setSafeMode",
        json!({"session":s3,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    call(
        &mut t2,
        "updateCell",
        json!({"session":s3,"expected_revision":"1","mutation_id":format!("x3-fresh-{}", std::process::id()),"table":table3,"column":"Name",
               "new_value":current,"row_values":{"Name":"Bob","Value":{"$t":"float64","v":"2"}}}),
    )
    .unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap().len(),
        std::fs::read(&fresh).unwrap().len(),
        "100 edits end the same size as one edit to the same text"
    );
    assert_eq!(
        members(&std::fs::read(&path).unwrap()),
        members(&std::fs::read(&fresh).unwrap()),
        "member bytes equal a freshly edited fixture"
    );
    let end = tree_bytes(&state);
    // Receipts are tiny and the backup is not copied per edit: 90 further edits add far less than one workbook per edit.
    assert!(
        end.0 - state_at_10.0 <= 90 * 4096,
        "state dir grew {} -> {} bytes",
        state_at_10.0,
        end.0
    );
    eprintln!(
        "peak RSS {} MiB; state dir {} B / {} files",
        peak_rss_mib(),
        end.0,
        end.1
    );
}

// Independent openpyxl/zipfile readback of the current file against the untouched original.
const ORACLE: &str = r###"
import sys, zipfile, openpyxl
original, current, expected = sys.argv[1], sys.argv[2], sys.argv[3]
assert openpyxl.load_workbook(current).active['A5'].value == expected
assert openpyxl.load_workbook(current).active['B5'].value == 2
with zipfile.ZipFile(original) as old, zipfile.ZipFile(current) as new:
    assert new.testzip() is None
    names = new.namelist()
    assert names == old.namelist() and len(set(names)) == len(names)
    for n in names:
        if n != 'xl/worksheets/sheet1.xml':
            assert old.read(n) == new.read(n), n
            assert old.getinfo(n).CRC == new.getinfo(n).CRC
"###;
