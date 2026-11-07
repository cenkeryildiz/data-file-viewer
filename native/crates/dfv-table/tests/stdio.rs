//! The real binary over real pipes: handshake, exit codes, stdout carries only protocol frames.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_dfv-table");
const PING: &str =
    r#"{"protocol":"dfv-table","version":1,"kind":"request","id":"1","method":"ping","args":{}}"#;

fn spawn() -> std::process::Child {
    Command::new(BIN)
        .arg("--stdio")
        .env_remove("DFV_TABLE_TEST_DOC")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
fn handshake_then_ping_then_clean_exit_on_eof() {
    let mut child = spawn();
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let caps: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(caps["kind"], "capabilities");
    let formats = caps["formats"].as_array().unwrap();
    let expected = [
        ("csv", "table_rewrite"),
        ("parquet", "table_rewrite"),
        ("duckdb", "transactional"),
        ("sqlite", "transactional"),
        ("xlsx", "cell_patch"),
        ("arrow", "table_rewrite"),
        ("feather", "table_rewrite"),
        ("dta", "none"),
        ("kdb", "none"),
    ];
    assert_eq!(formats.len(), expected.len());
    for (format, (kind, write)) in formats.iter().zip(expected) {
        assert_eq!(
            format,
            &json!({"file_kind":kind,"read":true,
            "write":write,"backup":write != "none","compression":[]})
        );
    }
    assert!(
        caps["methods"]
            .as_array()
            .unwrap()
            .contains(&json!("runQuery"))
    );
    writeln!(stdin, "{PING}").unwrap();
    line.clear();
    out.read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["ok"], true);
    drop(stdin);
    let mut rest = String::new();
    out.read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "");
    let status = child.wait().unwrap();
    assert!(status.success());
    let mut err = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut err)
        .unwrap();
    assert!(err.lines().all(|l| l.starts_with("table_worker:")), "{err}");
}

#[test]
fn eof_before_any_request_exits_zero_after_the_handshake() {
    let out = Command::new(BIN)
        .arg("--stdio")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap().lines().count(), 1);
}

#[test]
fn version_mismatch_is_refused_and_the_worker_keeps_serving() {
    let mut child = spawn();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, r#"{{"protocol":"dfv-table","version":2,"kind":"request","id":"1","method":"ping","args":{{}}}}"#).unwrap();
    writeln!(stdin, "{PING}").unwrap();
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    let frames: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(
        (
            frames[1]["error"]["code"].as_str(),
            frames[2]["ok"].as_bool()
        ),
        (Some("unsupported"), Some(true))
    );
}

#[test]
fn closing_the_reader_mid_session_fails_the_worker_not_hangs_it() {
    let mut child = spawn();
    let mut stdin = child.stdin.take().unwrap();
    drop(child.stdout.take());
    // Replies hit a closed pipe: an I/O error, but never a hang or exit 0. Keep asking until the worker
    // is gone: a single request can race a concurrently forked sibling still holding our read end.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while writeln!(stdin, "{PING}")
        .and_then(|()| stdin.flush())
        .is_ok()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the worker kept serving a closed reader"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    drop(stdin);
    assert!(!child.wait().unwrap().success());
}

#[test]
fn bad_arguments_exit_two_and_print_nothing_on_stdout() {
    for args in [vec![], vec!["--bogus"], vec!["--stdio", "x"]] {
        let out = Command::new(BIN)
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2));
        assert!(out.stdout.is_empty());
    }
    let v = Command::new(BIN).arg("--version").output().unwrap();
    assert!(String::from_utf8(v.stdout).unwrap().contains("protocol 1"));
}

#[cfg(unix)]
#[test]
fn killing_a_production_query_preserves_csv_and_duckdb_sources_without_sidecars() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    let scratch = std::env::temp_dir().join(format!(
        "dfv-production-kill-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&scratch).unwrap();
    for kind in ["csv", "duckdb"] {
        let dir = scratch.join(kind);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(format!("rows.{kind}"));
        if kind == "csv" {
            std::fs::write(&path, b"id,name\n1,alpha\n2,beta\n").unwrap();
        } else {
            let writer = duckdb::Connection::open(&path).unwrap();
            writer.execute_batch("create table rows(id integer, name varchar); insert into rows values (1, 'alpha'), (2, 'beta')").unwrap();
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let before = (
            std::fs::read(&path).unwrap(),
            std::fs::metadata(&path).unwrap().modified().unwrap(),
        );
        let mut child = spawn();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["engine"]["name"],
            "dfv-table"
        );
        writeln!(input, "{}", json!({"protocol":"dfv-table","version":1,"kind":"request","id":"1","method":"open","args":{"path":path,"force_read_only":true}})).unwrap();
        line.clear();
        output.read_line(&mut line).unwrap();
        let opened: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(opened["ok"], true, "{opened}");
        assert_eq!(opened["result"]["file_kind"], kind);
        writeln!(input, "{}", json!({"protocol":"dfv-table","version":1,"kind":"request","id":"2","method":"runQuery","args":{"session":opened["result"]["session"],"sql":"select sum(a.range*b.range) from range(1000000) a, range(1000000) b"}})).unwrap();
        let (finished, pending) = std::sync::mpsc::channel();
        let read = std::thread::spawn(move || {
            let mut line = String::new();
            let _ = output.read_line(&mut line);
            let _ = finished.send(line);
        });
        assert!(
            matches!(
                pending.recv_timeout(Duration::from_millis(80)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ),
            "the submitted production query must still be pending"
        );
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        read.join().unwrap();
        assert_eq!(
            (
                std::fs::read(&path).unwrap(),
                std::fs::metadata(&path).unwrap().modified().unwrap()
            ),
            before
        );
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            [path.file_name().unwrap()],
            "no journals, locks or stages: {names:?}"
        );
        let mut reopened = Command::new(BIN)
            .arg("--stdio")
            .env_remove("DFV_TABLE_TEST_DOC")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = reopened.stdin.take().unwrap();
        let mut output = BufReader::new(reopened.stdout.take().unwrap());
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["kind"],
            "capabilities"
        );
        writeln!(input, "{}", json!({"protocol":"dfv-table","version":1,"kind":"request","id":"1","method":"open","args":{"path":path,"force_read_only":true}})).unwrap();
        line.clear();
        output.read_line(&mut line).unwrap();
        let opened: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(opened["ok"], true, "{opened}");
        assert_eq!(opened["result"]["source_revision"], "1");
        assert_eq!(opened["result"]["read_only"], true);
        drop(input);
        let mut rest = String::new();
        output.read_to_string(&mut rest).unwrap();
        assert!(rest.is_empty());
        assert!(reopened.wait().unwrap().success());
        assert_eq!(std::fs::read(&path).unwrap(), before.0);
    }
    std::fs::remove_dir_all(scratch).unwrap();
}
