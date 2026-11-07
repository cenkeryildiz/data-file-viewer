//! Locale-aware writes must use displayed row identity and preserve unrelated source bytes.
use dfv_table_engine::Tables;
use dfv_table_protocol::{Control, ErrorBody, Lane};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn call(t: &mut Tables, m: &str, v: Value) -> Result<Value, ErrorBody> {
    t.call(m, v.as_object().unwrap(), &Control::unbounded())
}
#[test]
fn eu_displayed_row_identity_preserves_raw_records_and_decimal_convention() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.csv");
    let bytes = b"id;amount;note\r\n1;1.234,50;\"alpha; first\"\r\n2;2.345,75;beta\r\n";
    std::fs::write(&path, bytes).unwrap();
    let mut t = Tables::default();
    let o = call(&mut t, "open", json!({"path":path,"number_locale":"eu"})).unwrap();
    let s = o["session"].as_str().unwrap();
    let r = call(
        &mut t,
        "runQuery",
        json!({"session":s,"sql":"select * from rows order by id"}),
    )
    .unwrap();
    assert_eq!(r["rows"][0][1], json!({"$t":"float64","v":"1234.5"}));
    call(
        &mut t,
        "setSafeMode",
        json!({"session":s,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    let mid = format!(
        "locale-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let receipt=call(&mut t,"updateCell",json!({"session":s,"expected_revision":"1","mutation_id":mid,"table":"rows","column":"amount","new_value":{"$t":"float64","v":"3456.25"},"row_values":{"id":{"$t":"int64","v":"1"},"amount":{"$t":"float64","v":"1234.5"},"note":"alpha; first"}})).unwrap();
    assert_eq!(receipt["rows_changed"], "1");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "id;amount;note\r\n1;3456,25;\"alpha; first\"\r\n2;2.345,75;beta\r\n"
    );
    let r = call(
        &mut t,
        "runQuery",
        json!({"session":s,"sql":"select * from rows order by id"}),
    )
    .unwrap();
    assert_eq!(r["rows"][0][1], json!({"$t":"float64","v":"3456.25"}));
    assert_eq!(r["rows"][1][1], json!({"$t":"float64","v":"2345.75"}));
}
