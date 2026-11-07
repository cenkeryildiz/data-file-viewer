//! D3.17: result and refusal fixtures for the seven catalog routes, the read-metadata object every
//! open answers with, the hot/cold pair (DuckDB and SQLite halves) and cancellation of each route.
use dfv_table_engine::Tables;
use dfv_table_protocol::errors::*;
use dfv_table_protocol::{Control, ErrorBody, Lane};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "dfv-routes-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
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
fn open(t: &mut Tables, args: Value) -> Result<Value, ErrorBody> {
    call(t, "open", args)
}
fn names(v: &Value) -> Vec<&str> {
    v["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect()
}

fn duck(path: &Path, sql: &str) {
    duckdb::Connection::open(path)
        .unwrap()
        .execute_batch(sql)
        .unwrap();
}
fn sqlite(path: &Path, sql: &str) {
    rusqlite::Connection::open(path)
        .unwrap()
        .execute_batch(sql)
        .unwrap();
}

/// cold.duckdb (Datetime, v) and hot.duckdb (same table plus a table only the hot side holds).
fn duck_pair(d: &Dir) -> (PathBuf, PathBuf) {
    let (cold, hot) = (d.path("cold.duckdb"), d.path("hot.duckdb"));
    duck(
        &cold,
        "create table t(\"Datetime\" timestamp, v bigint); insert into t values ('2024-01-01 00:00:00', 1), ('2024-01-02 00:00:00', 2);
         create table only_cold(a int); create table sheet_metadata(table_name varchar, extra_json varchar, frequency varchar);
         insert into sheet_metadata values ('t', '{\"live_poll_seconds\": 30}', ' Monthly '), ('only_cold', 'not json', 'fortnightly');",
    );
    duck(
        &hot,
        "create table t(\"Datetime\" timestamp, v bigint); insert into t values ('2024-01-03 00:00:00', 3);
         create table only_hot(b int); create table sheet_metadata(table_name varchar, extra_json varchar, frequency varchar);
         insert into sheet_metadata values ('t', '{\"live_poll_seconds\": 2.5}', 'daily');",
    );
    (cold, hot)
}

#[test]
fn every_open_answers_with_read_metadata_v1() {
    let d = Dir::new();
    let csv = d.path("rows.csv");
    std::fs::write(&csv, b"id,name\n1,a\n2,b\n").unwrap();
    let mut t = Tables::default();
    let r = open(&mut t, json!({"path": csv})).unwrap();
    for key in [
        "file_kind",
        "read_only",
        "read_only_by_format",
        "has_sibling",
        "has_pending_sheets",
        "worksheets",
        "detected_tables",
        "open_warnings",
        "warnings",
        "number_locale",
        "source",
        "session",
        "source_revision",
    ] {
        assert!(r.get(key).is_some(), "{key}");
    }
    assert_eq!(
        (&r["file_kind"], &r["has_sibling"]),
        (&json!("csv"), &json!(false))
    );
    let source = r["source"].as_object().unwrap();
    assert_eq!(source["file_kind"], "csv");
    assert_eq!(source["size"], "16");
    assert_eq!(source["revision"], "1");
    assert_eq!(source["sha256"].as_str().unwrap().len(), 64);
    let mtime = source["mtime"].as_object().unwrap();
    assert_eq!(
        (&mtime["$t"], &mtime["unit"], &mtime["tz"]),
        (&json!("timestamp"), &json!("ns"), &Value::Null)
    );
    assert!(
        mtime["v"]
            .as_str()
            .unwrap()
            .bytes()
            .all(|b| b.is_ascii_digit())
    );
    assert_eq!(source.len(), 6, "no field outside source-identity.v1");
}

#[test]
fn workbook_routes_preserve_logical_rows_physical_targets_and_source_bytes() {
    let d = Dir::new();
    let path = d.path("repeated.xlsx");
    let bytes = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/xlsx-corpus/repeated.xlsx"),
    )
    .unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let mut tables = Tables::default();
    let meta = open(&mut tables, json!({"path":path})).unwrap();
    let id = meta["session"].as_str().unwrap();
    assert_eq!(meta["file_kind"], "xlsx");
    assert_eq!(meta["worksheets"], json!(["Sheet"]));
    assert_eq!(meta["detected_tables"], json!([]));
    assert_eq!(meta["sheet_preparation"][0]["state"], "pending");
    let preview = call(
        &mut tables,
        "runQuery",
        json!({"session":id,"sql":"select * from Sheet","prepare_sheet":"Sheet"}),
    )
    .unwrap();
    let prepared = &preview["workbook_metadata"];
    let name = prepared["detected_tables"][0]["name"].as_str().unwrap();
    let built = call(
        &mut tables,
        "buildDetectedTableQuery",
        json!({"session":id,"table":name}),
    )
    .unwrap();
    let page = call(
        &mut tables,
        "runDetectedTableQuery",
        json!({"session":id,"table":name}),
    )
    .unwrap();
    assert_eq!(page["sql"], built["sql"]);
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);
    assert_eq!(page["rows"][1][0], "Bob");
    let target = call(
        &mut tables,
        "locateXlsxEdit",
        json!({"session":id,"table":name,"column":"Value",
        "row_values":{"Name":"Bob","Value":page["rows"][1][1]}}),
    )
    .unwrap();
    assert_eq!(target["target"]["row_ordinal"], 5);
    assert_eq!(target["target"]["column_name"], "B");
    let status = call(
        &mut tables,
        "retrySheetPreparation",
        json!({"session":id,"sheet":"Sheet"}),
    )
    .unwrap();
    assert_eq!(status["status"]["state"], "ready");
    assert_eq!(status["detected_tables"], prepared["detected_tables"]);
    assert_eq!(status["sheet_preparation"], prepared["sheet_preparation"]);
    assert_eq!(status["has_pending_sheets"], false);
    let missing = call(
        &mut tables,
        "retrySheetPreparation",
        json!({"session":id,"sheet":"missing"}),
    )
    .unwrap();
    assert!(missing["status"].is_null());
    assert_eq!(missing["detected_tables"], status["detected_tables"]);
    assert_eq!(missing["sheet_preparation"], status["sheet_preparation"]);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let bad = d.path("malformed.xlsx");
    std::fs::write(&bad, b"not a workbook").unwrap();
    assert!(open(&mut tables, json!({"path":bad})).is_err());
}

#[test]
fn table_lists_for_a_single_source_and_no_sibling() {
    let d = Dir::new();
    let (cold, _) = duck_pair(&d);
    let mut t = Tables::default();
    let id = open(&mut t, json!({"path": cold})).unwrap()["session"]
        .as_str()
        .unwrap()
        .to_owned();
    for method in ["listTables", "listSidebarTables"] {
        let r = call(&mut t, method, json!({"session": id})).unwrap();
        assert_eq!(names(&r), ["only_cold", "sheet_metadata", "t"], "{method}");
    }
    for method in ["listSiblingTables", "getCombinableTableNames"] {
        assert_eq!(
            names(&call(&mut t, method, json!({"session": id})).unwrap()),
            Vec::<&str>::new()
        );
    }
    // a combined query needs a pair: typed refusal, not a made-up statement
    let e = call(
        &mut t,
        "buildCombinedQuery",
        json!({"session": id, "table": "t"}),
    )
    .unwrap_err();
    assert_eq!(e.code, UNSUPPORTED);
}

#[test]
fn a_duckdb_pair_lists_both_halves_and_only_the_built_statement_reads_the_sibling() {
    let d = Dir::new();
    let (cold, hot) = duck_pair(&d);
    let mut t = Tables::default();
    let opened = open(&mut t, json!({"path": cold, "sibling_path": hot})).unwrap();
    assert_eq!(opened["has_sibling"], true);
    let id = opened["session"].as_str().unwrap();
    assert_eq!(
        names(&call(&mut t, "listSiblingTables", json!({"session": id})).unwrap()),
        ["only_hot", "sheet_metadata", "t"]
    );
    assert_eq!(
        names(&call(&mut t, "getCombinableTableNames", json!({"session": id})).unwrap()),
        ["sheet_metadata", "t"]
    );
    // the sibling is not a navigation entry of the main source
    assert_eq!(
        names(&call(&mut t, "listTables", json!({"session": id})).unwrap()),
        ["only_cold", "sheet_metadata", "t"]
    );
    // a user statement may not read the sibling catalog
    let direct = call(
        &mut t,
        "runQuery",
        json!({"session": id, "sql": "select * from sibling.main.t"}),
    )
    .unwrap_err();
    assert_eq!(direct.code, POLICY_REFUSED);

    let built = call(
        &mut t,
        "buildCombinedQuery",
        json!({"session": id, "table": "t"}),
    )
    .unwrap();
    assert_eq!(built["time_column"], "Datetime");
    let sql = built["sql"].as_str().unwrap();
    assert!(
        sql.contains("union all by name") && sql.contains("limit 500"),
        "{sql}"
    );
    let page = call(&mut t, "runQuery", json!({"session": id, "sql": sql})).unwrap();
    let rows = page["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "both halves are read, oldest first");
    let hot_flags: Vec<_> = rows.iter().map(|r| r[2].as_bool().unwrap()).collect();
    assert_eq!(hot_flags, [false, false, true]);

    let limited = call(
        &mut t,
        "buildCombinedQuery",
        json!({"session": id, "table": "t", "limit_n": "2"}),
    )
    .unwrap();
    assert!(limited["sql"].as_str().unwrap().contains("limit 2"));
    let page = call(
        &mut t,
        "runQuery",
        json!({"session": id, "sql": limited["sql"]}),
    )
    .unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);

    // a table only one side holds has no combined form
    for table in ["only_hot", "only_cold", "missing"] {
        let e = call(
            &mut t,
            "buildCombinedQuery",
            json!({"session": id, "table": table}),
        )
        .unwrap_err();
        assert_eq!(e.code, MALFORMED_VALUE, "{table}");
    }
}

#[test]
fn cadence_and_frequency_read_the_hot_half_first_and_unusable_hints_are_null() {
    let d = Dir::new();
    let (cold, hot) = duck_pair(&d);
    let mut t = Tables::default();
    let paired = open(&mut t, json!({"path": cold, "sibling_path": hot})).unwrap()["session"]
        .as_str()
        .unwrap()
        .to_owned();
    // both are DuckDB files: the primary is asked first
    assert_eq!(
        call(
            &mut t,
            "getPollCadenceSeconds",
            json!({"session": paired, "table": "t"})
        )
        .unwrap(),
        json!({"seconds": 30.0})
    );
    assert_eq!(
        call(
            &mut t,
            "getSeriesFrequency",
            json!({"session": paired, "table": "t"})
        )
        .unwrap(),
        json!({"frequency": "monthly"})
    );
    for (method, key) in [
        ("getPollCadenceSeconds", "seconds"),
        ("getSeriesFrequency", "frequency"),
    ] {
        for table in ["only_cold", "missing"] {
            assert_eq!(
                call(&mut t, method, json!({"session": paired, "table": table})).unwrap()[key],
                Value::Null,
                "{method} {table}"
            );
        }
    }
    // a source with no metadata table has no hint either
    let csv = d.path("flat.csv");
    std::fs::write(&csv, b"a\n1\n").unwrap();
    let flat = open(&mut t, json!({"path": csv})).unwrap()["session"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        call(
            &mut t,
            "getSeriesFrequency",
            json!({"session": flat, "table": "flat"})
        )
        .unwrap()["frequency"],
        Value::Null
    );
}

#[test]
fn a_sqlite_source_loads_exactly_and_pairs_with_a_duckdb_half_in_either_role() {
    let d = Dir::new();
    let hot = d.path("hot.db");
    sqlite(
        &hot,
        "create table t(\"Datetime\" text, v integer, label, blobby blob);
         insert into t values ('2024-01-03 00:00:00', 9007199254740993, 'x', X'00ff'), ('2024-01-04 00:00:00', 4, 'y', NULL);
         create table sheet_metadata(table_name text, extra_json text, frequency text);
         insert into sheet_metadata values ('t', '{\"live_poll_seconds\": 5}', 'weekly');",
    );
    let (cold, _) = duck_pair(&d);
    let mut t = Tables::default();
    // SQLite as the main source
    let main = open(&mut t, json!({"path": hot})).unwrap();
    assert_eq!(main["file_kind"], "sqlite");
    let id = main["session"].as_str().unwrap();
    assert_eq!(
        names(&call(&mut t, "listTables", json!({"session": id})).unwrap()),
        ["sheet_metadata", "t"]
    );
    let page = call(
        &mut t,
        "runQuery",
        json!({"session": id, "sql": "select v, label from t order by v desc"}),
    )
    .unwrap();
    assert_eq!(
        page["rows"][0][0],
        json!({"$t": "int64", "v": "9007199254740993"})
    );
    assert_eq!(
        page["rows"][0][1], "x",
        "an untyped text column is text, not bytes"
    );
    assert_eq!(
        call(
            &mut t,
            "getPollCadenceSeconds",
            json!({"session": id, "table": "t"})
        )
        .unwrap()["seconds"],
        5.0
    );
    call(&mut t, "close", json!({"session": id})).unwrap();

    // SQLite as the hot sibling of a DuckDB main: its metadata is asked first
    let paired = open(&mut t, json!({"path": cold, "sibling_path": hot})).unwrap();
    assert_eq!(paired["has_sibling"], true);
    let id = paired["session"].as_str().unwrap();
    assert_eq!(
        names(&call(&mut t, "getCombinableTableNames", json!({"session": id})).unwrap()),
        ["sheet_metadata", "t"]
    );
    assert_eq!(
        call(
            &mut t,
            "getPollCadenceSeconds",
            json!({"session": id, "table": "t"})
        )
        .unwrap()["seconds"],
        5.0
    );
    assert_eq!(
        call(
            &mut t,
            "getSeriesFrequency",
            json!({"session": id, "table": "t"})
        )
        .unwrap()["frequency"],
        "weekly"
    );
    call(&mut t, "close", json!({"session": id})).unwrap();

    // an unreadable sibling is simply no pair; the main source still opens
    let junk = d.path("junk.duckdb");
    std::fs::write(&junk, b"not a database").unwrap();
    let alone = open(&mut t, json!({"path": cold, "sibling_path": junk})).unwrap();
    assert_eq!(alone["has_sibling"], false);
    let id = alone["session"].as_str().unwrap();
    assert_eq!(
        names(&call(&mut t, "listSiblingTables", json!({"session": id})).unwrap()),
        Vec::<&str>::new()
    );
}

#[test]
fn open_and_route_refusals_are_typed() {
    let d = Dir::new();
    let mut t = Tables::default();
    let unknown = d.path("a.xyz");
    std::fs::write(&unknown, b"x").unwrap();
    assert_eq!(
        open(&mut t, json!({"path": unknown})).unwrap_err().code,
        UNSUPPORTED
    );
    // A routed format with corrupt input fails decoding instead of opening a fallback source.
    for (name, code) in [
        ("a.arrow", QUERY_FAILED),
        ("a.feather", QUERY_FAILED),
        ("a.dta", UNSUPPORTED),
    ] {
        let p = d.path(name);
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(
            open(&mut t, json!({"path": p})).unwrap_err().code,
            code,
            "{name}"
        );
    }
    assert_eq!(
        open(&mut t, json!({"path": unknown, "force_kind": "nope"}))
            .unwrap_err()
            .code,
        MALFORMED_VALUE
    );
    assert_eq!(
        open(&mut t, json!({"path": unknown, "sibling_path": 3}))
            .unwrap_err()
            .code,
        MALFORMED_VALUE
    );
    let bad = d.path("bad.db");
    std::fs::write(&bad, b"this is not a sqlite database at all").unwrap();
    assert_eq!(
        open(&mut t, json!({"path": bad})).unwrap_err().code,
        QUERY_FAILED
    );
    // a sparse file past the SQLite load cap is a resource refusal, found before any decoding
    let big = d.path("big.db");
    std::fs::File::create(&big)
        .unwrap()
        .set_len((256 << 20) + 1)
        .unwrap();
    assert_eq!(
        open(&mut t, json!({"path": big})).unwrap_err().code,
        RESOURCE_LIMIT
    );
    // refused opens leave no session behind
    let csv = d.path("ok.csv");
    std::fs::write(&csv, b"a\n1\n").unwrap();
    let id = open(&mut t, json!({"path": csv})).unwrap()["session"]
        .as_str()
        .unwrap()
        .to_owned();

    for method in [
        "listTables",
        "listSidebarTables",
        "listSiblingTables",
        "getCombinableTableNames",
        "buildCombinedQuery",
        "getPollCadenceSeconds",
        "getSeriesFrequency",
    ] {
        let args = |session: &str| json!({"session": session, "table": "ok"});
        assert_eq!(
            call(&mut t, method, args("s999")).unwrap_err().code,
            NOT_OPEN,
            "{method}"
        );
        assert_eq!(
            call(&mut t, method, json!({"table": "ok"}))
                .unwrap_err()
                .code,
            MALFORMED_VALUE,
            "{method}"
        );
        assert_eq!(
            call(
                &mut t,
                method,
                json!({"session": id, "table": "ok", "expected_revision": "2"})
            )
            .unwrap_err()
            .code,
            STALE_SOURCE,
            "{method}"
        );
    }
    for method in [
        "buildCombinedQuery",
        "getPollCadenceSeconds",
        "getSeriesFrequency",
    ] {
        assert_eq!(
            call(&mut t, method, json!({"session": id}))
                .unwrap_err()
                .code,
            MALFORMED_VALUE,
            "{method} needs a table"
        );
        assert_eq!(
            call(&mut t, method, json!({"session": id, "table": 7}))
                .unwrap_err()
                .code,
            MALFORMED_VALUE
        );
    }
    for bad in [json!("01"), json!(5), json!("-1"), json!("")] {
        let e = call(
            &mut t,
            "buildCombinedQuery",
            json!({"session": id, "table": "ok", "limit_n": bad}),
        )
        .unwrap_err();
        assert_eq!(e.code, MALFORMED_VALUE);
    }
}

#[test]
fn a_changed_sibling_or_source_stales_every_route() {
    let d = Dir::new();
    let (cold, hot) = duck_pair(&d);
    let mut t = Tables::default();
    let id = open(&mut t, json!({"path": cold, "sibling_path": hot})).unwrap()["session"]
        .as_str()
        .unwrap()
        .to_owned();
    std::fs::write(&hot, b"replaced").unwrap();
    let e = call(&mut t, "listSiblingTables", json!({"session": id})).unwrap_err();
    assert_eq!(e.code, STALE_SOURCE);
    // the stale engine is gone, never re-attached to the old connection
    assert_eq!(
        call(&mut t, "listTables", json!({"session": id}))
            .unwrap_err()
            .code,
        NOT_OPEN
    );
}

#[test]
fn cancellation_and_deadline_stop_every_route_and_leave_the_session_usable() {
    let d = Dir::new();
    let (cold, hot) = duck_pair(&d);
    let mut t = Tables::default();
    let id = open(&mut t, json!({"path": cold, "sibling_path": hot})).unwrap()["session"]
        .as_str()
        .unwrap()
        .to_owned();
    for method in [
        "listTables",
        "listSidebarTables",
        "listSiblingTables",
        "getCombinableTableNames",
        "buildCombinedQuery",
        "getPollCadenceSeconds",
        "getSeriesFrequency",
    ] {
        let args = json!({"session": id, "table": "t"});
        let cancelled = Control::unbounded();
        cancelled.cancel();
        assert_eq!(
            t.call(method, args.as_object().unwrap(), &cancelled)
                .unwrap_err()
                .code,
            CANCELLED,
            "{method}"
        );
        let expired = Control::new(Instant::now() - Duration::from_millis(1));
        assert_eq!(
            t.call(method, args.as_object().unwrap(), &expired)
                .unwrap_err()
                .code,
            DEADLINE_EXCEEDED,
            "{method}"
        );
        call(&mut t, method, args).unwrap();
    }
    // reading a source never alters it
    assert!(std::fs::read(&hot).unwrap().len() > 8);
}

#[test]
fn a_sqlite_sibling_wal_change_invalidates_the_loaded_pair() {
    let d = Dir::new();
    let (cold, _) = duck_pair(&d);
    let hot = d.path("hot.db");
    sqlite(&hot, "create table t(a integer); insert into t values (1)");
    let mut t = Tables::default();
    let opened = open(&mut t, json!({"path": cold, "sibling_path": hot})).unwrap();
    assert_eq!(opened["has_sibling"], true);
    let mut wal = hot.into_os_string();
    wal.push("-wal");
    std::fs::write(PathBuf::from(wal), b"new journal").unwrap();
    assert_eq!(
        call(
            &mut t,
            "listSiblingTables",
            json!({"session":opened["session"]})
        )
        .unwrap_err()
        .code,
        STALE_SOURCE
    );
}

#[test]
fn a_mixed_sqlite_minimum_integer_and_decimal_is_refused_without_overflow() {
    let d = Dir::new();
    let path = d.path("mixed.db");
    sqlite(
        &path,
        "create table t(n numeric); insert into t values (-9223372036854775808), (0.5)",
    );
    let mut t = Tables::default();
    assert_eq!(
        open(&mut t, json!({"path":path})).unwrap_err().code,
        UNSUPPORTED
    );
}
