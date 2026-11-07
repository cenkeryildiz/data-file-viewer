//! A default build can never reach the test-only engine, even with its switch set.
#![cfg(not(feature = "test-doc"))]
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn the_test_engine_switch_is_ignored_and_only_production_reads_are_advertised() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_dfv-table"))
        .arg("--stdio")
        .env("DFV_TABLE_TEST_DOC", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let caps: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(caps["engine"]["name"], "dfv-table");
    assert!(
        caps["methods"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("runQuery"))
    );
    assert!(!line.contains("testOpen"));
    assert!(child.wait().unwrap().success());
}
