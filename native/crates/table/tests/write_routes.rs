//! Production dispatch: backup authorization, revision fencing, one-shot ids, and actual reader readback.
use dfv_table_engine::Tables;
use dfv_table_protocol::errors::*;
use dfv_table_protocol::{Control, ErrorBody, Lane};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn call(t: &mut Tables, m: &str, a: Value) -> Result<Value, ErrorBody> {
    t.call(m, a.as_object().unwrap(), &Control::unbounded())
}
fn id() -> String {
    format!(
        "write-route-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
fn open(t: &mut Tables, p: &Path) -> String {
    call(t, "open", json!({"path":p})).unwrap()["session"]
        .as_str()
        .unwrap()
        .into()
}
fn edit(s: &str, mid: &str, rev: &str) -> Value {
    json!({"session":s,"mutation_id":mid,"expected_revision":rev,"table":"rows","column":"name","new_value":"changed","row_values":{"id":{"$t":"int64","v":"1"},"name":"alpha"}})
}
#[test]
fn csv_backup_edit_readback_diff_and_replay_refusal() {
    assert!(
        std::env::var_os("DFV_TABLE_STATE_DIR").is_some(),
        "run with a private DFV_TABLE_STATE_DIR"
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.csv");
    let original = b"id,name\n1,alpha\n2,beta\n";
    std::fs::write(&path, original).unwrap();
    let mut t = Tables::default();
    let s = open(&mut t, &path);
    let mid = id();
    assert_eq!(
        call(&mut t, "updateCell", edit(&s, &mid, "1"))
            .unwrap_err()
            .code,
        READ_ONLY
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    let unlocked = call(
        &mut t,
        "setSafeMode",
        json!({"session":s,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    let backup = unlocked["backup_path"].as_str().unwrap();
    assert_eq!(std::fs::read(backup).unwrap(), original);
    let receipt = call(&mut t, "updateCell", edit(&s, &mid, "1")).unwrap();
    assert_eq!(receipt["rows_changed"], "1");
    assert_eq!(receipt["source_after"]["revision"], "2");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "id,name\n1,changed\n2,beta\n"
    );
    let rows = call(
        &mut t,
        "runQuery",
        json!({"session":s,"sql":"select * from rows order by id","expected_revision":"2"}),
    )
    .unwrap();
    assert_eq!(rows["rows"][0][1], "changed");
    let status = call(
        &mut t,
        "queryMutationOutcome",
        json!({"session":s,"mutation_id":mid}),
    )
    .unwrap();
    assert_eq!(status["receipt"], receipt);
    assert_eq!(
        call(&mut t, "updateCell", edit(&s, &id(), "1"))
            .unwrap_err()
            .code,
        STALE_SOURCE
    );
    assert_eq!(
        call(&mut t, "updateCell", edit(&s, &mid, "2"))
            .unwrap_err()
            .code,
        MALFORMED_VALUE
    );
    let diff=call(&mut t,"diffQueryAgainstBackup",json!({"session":s,"sql":"select * from rows order by id","live_columns":["id","name"],"live_rows":[[{"$t":"int64","v":"1"},"changed"],[{"$t":"int64","v":"2"},"beta"]]})).unwrap();
    assert_eq!(
        diff["diff"]["cell_changed"],
        json!([[false, true], [false, false]])
    );
    let summary = call(&mut t, "compareToBackup", json!({"session":s})).unwrap();
    assert_eq!(summary["tables"]["rows"], "changed");
    assert_eq!(std::fs::read(backup).unwrap(), original);
    std::fs::write(backup, b"damaged").unwrap();
    assert_eq!(
        call(&mut t, "compareToBackup", json!({"session":s}))
            .unwrap_err()
            .code,
        STALE_SOURCE
    );
}
#[test]
fn csv_no_match_and_ambiguous_rows_never_publish() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.csv");
    let original = b"id,name\n1,alpha\n1,alpha\n";
    std::fs::write(&path, original).unwrap();
    let mut t = Tables::default();
    let s = open(&mut t, &path);
    call(
        &mut t,
        "setSafeMode",
        json!({"session":s,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    let error = call(&mut t, "updateCell", edit(&s, &id(), "1")).unwrap_err();
    assert_eq!(error.code, AMBIGUOUS_ROW);
    assert_eq!(error.mutation_outcome, Some("not-published"));
    let mut missing = edit(&s, &id(), "1");
    missing["row_values"]["name"] = json!("missing");
    assert_eq!(
        call(&mut t, "updateCell", missing).unwrap()["outcome"],
        "no_match"
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
}
#[test]
fn sqlite_backup_contains_committed_wal_rows_without_changing_source() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.sqlite");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("pragma journal_mode=wal; pragma wal_autocheckpoint=0; create table rows(id integer,name text); insert into rows values(9007199254740993,'wal-only');").unwrap();
    let wal = path.with_file_name("rows.sqlite-wal");
    assert!(std::fs::metadata(&wal).unwrap().len() > 0);
    let mut tables = Tables::default();
    let session = open(&mut tables, &path);
    let main_before = std::fs::read(&path).unwrap();
    let wal_before = std::fs::read(&wal).unwrap();
    let unlocked = call(
        &mut tables,
        "setSafeMode",
        json!({"session":session,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    let backup = unlocked["backup_path"].as_str().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), main_before);
    assert_eq!(std::fs::read(&wal).unwrap(), wal_before);
    // Read the backup alone: no copied WAL or SHM file may supply the missing rows.
    let standalone = dir.path().join("standalone.sqlite");
    std::fs::copy(backup, &standalone).unwrap();
    let restored = dfv_table_sqlite::open_read_only(
        &standalone,
        dfv_table_sqlite::OpenMode::ReadOnly,
        std::time::Duration::ZERO,
    )
    .unwrap();
    let row: (i64, String) = restored
        .query_row("select * from rows", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(row, (9007199254740993, "wal-only".into()));
    let mut request = edit(&session, &id(), "1");
    request["row_values"] = json!({"id":{"$t":"int64","v":"9007199254740993"},"name":"wal-only"});
    assert_eq!(
        call(&mut tables, "updateCell", request).unwrap()["rows_changed"],
        "1"
    );
    let value: String = connection
        .query_row("select name from rows", [], |r| r.get(0))
        .unwrap();
    assert_eq!(value, "changed");
    let value: String = restored
        .query_row("select name from rows", [], |r| r.get(0))
        .unwrap();
    assert_eq!(value, "wal-only");
}

#[test]
fn sqlite_busy_backup_keeps_safe_mode_locked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.sqlite");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "create table rows(id integer,name text); insert into rows values(1,'alpha');",
        )
        .unwrap();
    let mut tables = Tables::default();
    let session = open(&mut tables, &path);
    let before = std::fs::read(&path).unwrap();
    connection.execute_batch("begin exclusive").unwrap();
    let error = call(
        &mut tables,
        "setSafeMode",
        json!({"session":session,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap_err();
    assert_eq!(error.code, RUNTIME_BUSY);
    assert_eq!(error.mutation_outcome, Some("not-published"));
    connection.execute_batch("rollback").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        call(&mut tables, "updateCell", edit(&session, &id(), "1"))
            .unwrap_err()
            .code,
        READ_ONLY
    );
    assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".backup-")
    }));
    call(
        &mut tables,
        "setSafeMode",
        json!({"session":session,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
}

#[test]
fn changed_sqlite_wal_is_refused_before_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.sqlite");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("pragma journal_mode=wal; pragma wal_autocheckpoint=0; create table rows(id integer,name text); insert into rows values(1,'alpha');").unwrap();
    let mut tables = Tables::default();
    let session = open(&mut tables, &path);
    connection
        .execute_batch("insert into rows values(2,'external')")
        .unwrap();
    let error = call(
        &mut tables,
        "setSafeMode",
        json!({"session":session,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap_err();
    assert_eq!(error.code, STALE_SOURCE);
    assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".backup-")
    }));
}

#[test]
fn sqlite_commit_refreshes_the_reader_and_retains_exact_integer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.sqlite");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch("create table rows(id integer,name text);insert into rows values(9007199254740993,'alpha');").unwrap();
    drop(c);
    let mut t = Tables::default();
    let s = open(&mut t, &path);
    call(
        &mut t,
        "setSafeMode",
        json!({"session":s,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    let mut a = edit(&s, &id(), "1");
    a["row_values"]["id"] = json!({"$t":"int64","v":"9007199254740993"});
    let receipt = call(&mut t, "updateCell", a).unwrap();
    assert_eq!(receipt["rows_changed"], "1");
    let c = rusqlite::Connection::open(&path).unwrap();
    let row: (i64, String) = c
        .query_row("select * from rows", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(row, (9007199254740993, "changed".into()));
    let rows = call(
        &mut t,
        "runQuery",
        json!({"session":s,"sql":"select * from rows"}),
    )
    .unwrap();
    assert_eq!(rows["rows"][0][1], "changed");
}
#[test]
fn missing_revision_and_changed_bytes_are_refused_before_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.csv");
    std::fs::write(&path, b"id,name\n1,alpha\n").unwrap();
    let mut t = Tables::default();
    let s = open(&mut t, &path);
    assert_eq!(
        call(
            &mut t,
            "createBackup",
            json!({"session":s,"mutation_id":id()})
        )
        .unwrap_err()
        .code,
        STALE_SOURCE
    );
    let receipt = call(
        &mut t,
        "createBackup",
        json!({"session":s,"mutation_id":id(),"expected_revision":"1"}),
    )
    .unwrap();
    assert_eq!(receipt["source_after"], Value::Null);
    assert_eq!(receipt["directory_sync"], "synced");
    std::fs::write(&path, b"id,name\n1,other\n").unwrap();
    assert_eq!(
        call(&mut t, "updateCell", edit(&s, &id(), "1"))
            .unwrap_err()
            .code,
        STALE_SOURCE
    );
}
