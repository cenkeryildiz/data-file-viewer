use dfv_table_engine::Tables;
use dfv_table_protocol::errors::{CANCELLED, QUERY_FAILED, STALE_SOURCE, UNSUPPORTED};
use dfv_table_protocol::{Control, ErrorBody, Lane};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

#[path = "../../kdb/tests/support/mod.rs"]
mod q;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "dfv-kdb-route-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn call(t: &mut Tables, method: &str, args: Value) -> Result<Value, ErrorBody> {
    t.call(method, args.as_object().unwrap(), &Control::unbounded())
}
fn corpus(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../kdb/tests/corpus")
        .join(name)
}

#[test]
fn q_written_single_row_and_empty_tables_route_read_only_without_changing_bytes() {
    for (name, rows) in [("single_row.kdb", 1), ("empty_table.kdb", 0)] {
        let path = corpus(name);
        let before = std::fs::read(&path).unwrap();
        let mut t = Tables::default();
        let opened = call(&mut t, "open", json!({"path":path,"force_kind":"kdb"})).unwrap();
        assert_eq!(opened["file_kind"], "kdb");
        assert_eq!(opened["read_only_by_format"], true);
        let id = &opened["session"];
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let tables = call(&mut t, "listTables", json!({"session":id})).unwrap();
        assert_eq!(tables["names"], json!([stem]));
        let page = call(
            &mut t,
            "runQuery",
            json!({"session":id,"sql":format!("select * from \"{stem}\"")}),
        )
        .unwrap();
        assert_eq!(page["rows"].as_array().unwrap().len(), rows);
        if rows == 1 {
            assert_eq!(page["rows"][0], json!([{"$t":"int64","v":"7"},"only"]));
        }
        call(&mut t, "close", json!({"session":id})).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn scalar_storage_types_exact_values_temporals_nulls_and_source_changes_survive_dispatch() {
    let d = Dir::new();
    let folder = d.0.join("test_kdb");
    std::fs::create_dir(&folder).unwrap();
    let path = folder.join("rows");
    let bytes = q::table(
        &["n", "when", "day", "clock"],
        &[
            q::i64s(7, &[9_007_199_254_740_993, i64::MIN]),
            q::i64s(12, &[0, 1_000]),
            q::i32s(14, &[0, 1]),
            q::i32s(19, &[0, 1]),
        ],
    );
    std::fs::write(&path, &bytes).unwrap();
    let mut t = Tables::default();
    let opened = call(&mut t, "open", json!({"path":path})).unwrap();
    let id = &opened["session"];
    let page = call(
        &mut t,
        "runQuery",
        json!({"session":id,"sql":"select * from rows","page_size":2}),
    )
    .unwrap();
    assert_eq!(
        page["rows"][0][0],
        json!({"$t":"int64","v":"9007199254740993"})
    );
    assert_eq!(page["rows"][1][0], Value::Null);
    assert_eq!(
        page["rows"][0][1],
        json!({"$t":"timestamp","v":"946684800000000","unit":"us","tz":null})
    );
    assert_eq!(page["rows"][0][2], json!({"$t":"date","v":"10957"}));
    assert_eq!(page["rows"][0][3], json!({"$t":"time","v":"0","unit":"us"}));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let cancelled = Control::unbounded();
    cancelled.cancel();
    assert_eq!(
        t.call(
            "runQuery",
            json!({"session":id,"sql":"select * from rows"})
                .as_object()
                .unwrap(),
            &cancelled
        )
        .unwrap_err()
        .code,
        CANCELLED
    );
    std::fs::write(&path, b"changed").unwrap();
    assert_eq!(
        call(&mut t, "listTables", json!({"session":id}))
            .unwrap_err()
            .code,
        STALE_SOURCE
    );
}

#[test]
fn malformed_compressed_and_unrepresentable_sources_refuse_without_a_session() {
    let mut t = Tables::default();
    for (name, code) in [
        ("compressed.kdb", UNSUPPORTED),
        ("plain_list.kdb", QUERY_FAILED),
        ("atoms.kdb", UNSUPPORTED),
    ] {
        let err = call(
            &mut t,
            "open",
            json!({"path":corpus(name),"force_kind":"kdb"}),
        )
        .unwrap_err();
        assert_eq!(err.code, code, "{name}");
    }
    let opened = call(
        &mut t,
        "open",
        json!({"path":corpus("single_row.kdb"),"force_kind":"kdb"}),
    )
    .unwrap();
    assert_eq!(opened["file_kind"], "kdb");
}

#[test]
fn q_written_general_lists_keep_their_structural_display() {
    let mut t = Tables::default();
    let opened = call(
        &mut t,
        "open",
        json!({"path":corpus("general_lists.kdb"),"force_kind":"kdb"}),
    )
    .unwrap();
    let page = call(
        &mut t,
        "runQuery",
        json!({"session":opened["session"],"sql":"select * from general_lists"}),
    )
    .unwrap();
    assert_eq!(
        page["rows"][0],
        json!([{"$t":"int64","v":"1"},"1","[1,2,3]","[]"])
    );
    assert_eq!(page["rows"][1][2], "[\"a\",\"b\"]");
}
