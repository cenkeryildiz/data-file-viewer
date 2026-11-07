//! D3.5/D3.6 against the REAL DuckDB parser and engine. Ported from the TypeScript suites named on each
//! test (queryPolicy, queryCatalog, chartQuery, duckdbSorting, csvNumberLocale, ext06CsvTypes), with
//! expected values from Python duckdb/pyarrow where noted. Every fixture is generated here or by
//! tools/make_parquet_fixture.py; nothing is read from outside the scratch directory.
use ::duckdb::Connection;
use dfv_table_duckdb::duckdb::{Bridge, OpenOptions};
use dfv_table_duckdb::locale::NumberLocale;
use dfv_table_duckdb::query::{Direction, StatsKind, XAxis};
use dfv_table_duckdb::{Engine, Error, Kind};
use dfv_table_policy::{
    QueryEngine, QueryRelation, ReadSqlPolicy, Refusal, engine_restrictions, reader_threads,
};
use serde_json::{Value as J, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

struct Dir(PathBuf);
impl Dir {
    fn new(tag: &str) -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "dfv-t7-{}-{tag}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn duckdb_file(dir: &Dir, name: &str, sql: &str) -> PathBuf {
    let path = dir.file(name);
    let c = Connection::open(&path).unwrap();
    c.execute_batch(sql).unwrap();
    path
}
fn text_file(dir: &Dir, name: &str, body: &str) -> PathBuf {
    let path = dir.file(name);
    std::fs::write(&path, body).unwrap();
    path
}
fn open(path: &Path) -> Engine {
    Engine::open(path).unwrap_or_else(|e| panic!("open {}: {e}", path.display()))
}
fn s(v: &J) -> String {
    v.as_str().map_or_else(|| v.to_string(), str::to_owned)
}
fn col(e: &Engine, sql: &str) -> Vec<String> {
    e.run_query(sql, 0)
        .unwrap()
        .rows
        .iter()
        .map(|r| s(&r[0]))
        .collect()
}
fn refusal(e: Error) -> Refusal {
    match e {
        Error::Policy(p) => p.kind,
        other => panic!("expected a policy refusal, got {other:?}"),
    }
}

// ---- queryPolicy.test.ts, against the real json_serialize_sql output ---------------------------------

fn relations(c: &Connection) -> (String, Vec<QueryRelation>) {
    let catalog: String = c
        .query_row("select current_database()", [], |r| r.get(0))
        .unwrap();
    let mut out = vec![QueryRelation {
        catalog: catalog.clone(),
        schema: "main".into(),
        name: "data".into(),
        ..Default::default()
    }];
    let mut stmt = c
        .prepare("select view_name, sql from duckdb_views() where not internal")
        .unwrap();
    for row in stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
    {
        let (name, sql) = row.unwrap();
        out.push(QueryRelation {
            catalog: catalog.clone(),
            schema: "main".into(),
            name,
            view_sql: Some(sql),
            ..Default::default()
        });
    }
    (catalog, out)
}
fn lock(c: &Connection, paths: &[&str]) {
    for statement in engine_restrictions(paths, reader_threads()) {
        c.execute_batch(&statement).unwrap();
    }
}

#[test]
fn native_ast_policy_accepts_ordinary_queries_and_rejects_side_effects_macros_and_metadata_through_views()
 {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "create table data(i integer, \"Date\" date); insert into data values (1, DATE '1990-01-01'); \
         create view good as select * from data; create view bad as select * from duckdb_databases(); \
         create macro secret() as current_setting('temp_directory');",
    )
    .unwrap();
    let (catalog, relations) = relations(&c);
    lock(&c, &[]);
    let mut bridge = Bridge(&c);
    let mut policy = ReadSqlPolicy::new(&mut bridge, catalog);
    for sql in [
        "select * from data",
        "select * from good",
        "select count(*) from data where i > 0",
        "select * from data where \"Date\" >= DATE '1990-01-01' limit 100",
        "with x as (select * from data) select * from x",
        "select * from data a join data b on a.i=b.i",
        "select sum(i) from range(10) t(i)",
        "explain select * from data",
        "explain analyze select * from data",
        "describe data",
        "summarize select * from data",
        "/* outer /* nested */ comment */ explain select * from data",
    ] {
        policy
            .validate(sql, &relations)
            .unwrap_or_else(|e| panic!("should be accepted: {sql}: {e}"));
    }
    for sql in [
        "select * from bad",
        "select secret()",
        "select current_setting('temp_directory')",
        "select * from duckdb_databases()",
        "select * from information_schema.tables",
        "select * from backup_cmp.data",
        "select * from read_text('/tmp/synthetic')",
        "select 1; delete from data",
        "with x as (select 1) delete from data",
        "call checkpoint()",
        "select nextval('x')",
        "explain analyze select * from bad",
        "describe duckdb_databases()",
        "with x as (with sqlite_master as (select 1) select 1) select * from sqlite_master",
    ] {
        assert!(
            policy.validate(sql, &relations).is_err(),
            "should be refused: {sql}"
        );
    }
    let n: i64 = c
        .query_row("select count(*) from data", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "validation never executes the statement");
}

#[test]
fn engine_policy_locks_capabilities_bounds_memory_and_disables_spill() {
    let c = Connection::open_in_memory().unwrap();
    lock(&c, &[]);
    assert_eq!(
        c.query_row("select 42", [], |r| r.get::<_, i32>(0))
            .unwrap(),
        42
    );
    for sql in [
        "set enable_external_access=true",
        "set lock_configuration=false",
        "set autoload_known_extensions=true",
        "set allowed_paths=['/']",
    ] {
        assert!(
            c.execute_batch(sql).is_err(),
            "{sql} must fail after the lock"
        );
    }
    let mut stmt = c
        .prepare("select name,value from duckdb_settings() where name in ('threads','max_temp_directory_size','enable_external_access') order by name")
        .unwrap();
    let settings: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        settings,
        [
            ("enable_external_access".to_owned(), "false".to_owned()),
            ("max_temp_directory_size".to_owned(), "0 bytes".to_owned()),
            ("threads".to_owned(), reader_threads().to_string()),
        ]
    );
}

#[test]
fn allowed_paths_grants_only_the_source_file() {
    let dir = Dir::new("paths");
    let (mine, other) = (
        text_file(&dir, "mine.csv", "a\n1\n"),
        text_file(&dir, "other.csv", "a\n2\n"),
    );
    let c = Connection::open_in_memory().unwrap();
    lock(&c, &[mine.to_str().unwrap()]);
    let read = |p: &Path| {
        c.query_row(
            &format!("select a from read_csv('{}')", p.display()),
            [],
            |r| r.get::<_, i64>(0),
        )
    };
    assert_eq!(read(&mine).unwrap(), 1);
    assert!(
        read(&other).is_err(),
        "a file outside allowed_paths must not be readable"
    );
}

#[test]
fn user_macros_cannot_inherit_the_grants_for_built_in_range_functions() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("create macro range() as current_setting('home_directory')")
        .unwrap();
    let catalog: String = c
        .query_row("select current_database()", [], |r| r.get(0))
        .unwrap();
    lock(&c, &[]);
    let mut bridge = Bridge(&c);
    let e = ReadSqlPolicy::new(&mut bridge, catalog)
        .validate("select range()", &[])
        .unwrap_err();
    assert!(e.message.contains("unavailable"), "{e}");
}

#[test]
fn the_one_scan_function_allowlists_equal_the_two_separate_scans_they_replaced() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("create macro unnest(x) as x; create macro lower_macro(x) as lower(x)")
        .unwrap();
    let names = |sql: &str| -> std::collections::BTreeSet<String> {
        let mut stmt = c.prepare(sql).unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap().to_lowercase())
            .collect()
    };
    let scalar = names(
        "select function_name from system.main.duckdb_functions() group by function_name having bool_and(internal) \
         and bool_and(function_type in ('scalar','aggregate','macro')) and not bool_or(coalesce(has_side_effects,false))",
    );
    let table = names(
        "select function_name from system.main.duckdb_functions() where function_name in ('range','generate_series','unnest') \
         group by function_name having bool_and(internal)",
    );
    let rows = Bridge(&c).function_catalog().unwrap();
    let pick =
        |f: fn(&dfv_table_policy::FunctionRow) -> bool| -> std::collections::BTreeSet<String> {
            rows.iter()
                .filter(|r| f(r))
                .map(|r| r.name.to_lowercase())
                .collect()
        };
    assert_eq!(pick(|r| r.scalar_safe), scalar);
    assert_eq!(pick(|r| r.table_safe), table);
    assert!(
        !table.contains("unnest") && !scalar.contains("lower_macro"),
        "user macros are not granted"
    );
    assert!(table.contains("range"));
}

// ---- Engine: open, lock-down, refusals --------------------------------------------------------------

const SALES: &str = "create table t (id integer, big bigint, huge hugeint, dec decimal(30, 4), ts timestamp, name varchar); \
    insert into t values (0, 9, 9000000000000, -4.0000, timestamp '2024-01-15 00:30:00', 'Zebra'), \
    (1, 10, 10000000000000, -0.7500, timestamp '2024-02-15 01:30:00', 'apple'), \
    (2, 100, 100000000000000, 2.5000, timestamp '2024-03-15 02:30:00', 'çilek'), \
    (3, 1000, 1000000000000000, 5.7500, timestamp '2024-04-15 03:30:00', 'Şeker'), \
    (4, -5, -5000000000000, 9.0000, timestamp '2024-05-15 04:30:00', 'ıspanak'), \
    (5, 1152921504606846976, 1152921504606846976000000000000, 12.2500, timestamp '2024-06-15 05:30:00', 'item10'), \
    (6, 1152921504606846975, 1152921504606846975000000000000, 15.5000, timestamp '2024-07-15 06:30:00', 'item9'), \
    (99, null, null, null, null, null);";

#[test]
fn open_proves_the_lock_down_and_reads_back_the_pinned_settings() {
    let dir = Dir::new("open");
    let e = open(&duckdb_file(&dir, "sales.duckdb", SALES));
    assert_eq!(e.kind, Kind::Duckdb);
    assert_eq!(e.catalog, "sales");
    let settings = e.locked_settings().unwrap();
    let get = |n: &str| {
        settings
            .iter()
            .find(|(k, _)| k == n)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    assert_eq!(get("enable_external_access"), "false");
    assert_eq!(get("max_temp_directory_size"), "0 bytes");
    assert_eq!(get("threads"), reader_threads().to_string());
    assert_eq!(get("lock_configuration"), "true");
    // And through the public path, the settings cannot be reopened.
    assert!(matches!(
        e.run_query("set enable_external_access=true", 0),
        Err(Error::Policy(_))
    ));
}

#[test]
fn stored_macros_cannot_replace_internal_startup_or_catalog_functions() {
    let dir = Dir::new("shadowed-builtins");
    let sentinel = text_file(&dir, "sentinel.txt", "synthetic-private-value");
    let quoted = dfv_table_duckdb::duckdb::quote_literal(&sentinel.to_string_lossy());
    let path = duckdb_file(
        &dir,
        "shadowed.duckdb",
        &format!(
            "create table data(i integer); insert into data values (7); \
         create macro current_database() as (select content from read_text({quoted})); \
         create macro duckdb_settings() as table select 'enable_external_access' as name, content as value from read_text({quoted}); \
         create macro bool_and(x) as true; create macro bool_or(x) as false; \
         create macro secret() as current_setting('home_directory');"
        ),
    );
    let before = std::fs::read(&path).unwrap();
    for present in [true, false] {
        if !present {
            std::fs::rename(&sentinel, dir.file("sentinel.saved")).unwrap();
        }
        let engine = open(&path);
        assert_eq!(engine.catalog, "shadowed");
        assert_eq!(engine.list_tables().unwrap(), ["data"]);
        assert_eq!(engine.query_catalog(0).unwrap()[0].name, "data");
        assert_eq!(col(&engine, "select * from data"), ["7"]);
        assert!(
            engine
                .locked_settings()
                .unwrap()
                .iter()
                .any(|(name, value)| name == "enable_external_access" && value == "false")
        );
        assert!(
            matches!(
                engine.run_query("select current_database()", 1),
                Err(Error::Policy(_))
            ),
            "the user-defined macro is not granted as a builtin"
        );
        assert!(
            matches!(engine.run_query("select secret()", 1), Err(Error::Policy(error)) if error.kind == Refusal::FunctionUnavailable),
            "stored aggregate macros cannot grant user functions"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    assert_eq!(
        std::fs::read(dir.file("sentinel.saved")).unwrap(),
        b"synthetic-private-value"
    );
}

#[test]
fn typed_refusals_for_unsupported_missing_and_non_regular_files() {
    let dir = Dir::new("refuse");
    assert!(matches!(
        Engine::open(&text_file(&dir, "a.xyz", "x")),
        Err(Error::Unsupported(_))
    ));
    assert!(matches!(
        Engine::open(&dir.file("missing.csv")),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        Engine::open(&dir.0),
        Err(Error::Unsupported(_) | Error::Invalid(_))
    ));
    let fifo = dir.file("pipe.csv");
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let started = Instant::now();
    assert!(
        matches!(Engine::open(&fifo), Err(Error::Invalid(_))),
        "a FIFO is refused before it can block"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn the_policy_refuses_user_sql_that_leaves_the_file_or_changes_state() {
    let dir = Dir::new("policy");
    let e = open(&duckdb_file(&dir, "sales.duckdb", SALES));
    for sql in [
        "select * from read_csv('/etc/hosts')",
        "select * from read_parquet('/tmp/x.parquet')",
        "select * from read_csv('https://example.invalid/private.csv')",
        "select * from read_parquet('http://127.0.0.1:1/private.parquet')",
        "select * from read_json('https://example.invalid/private.json')",
        "select * from http_get('https://example.invalid/private')",
        "select * from glob('/*')",
        "copy t to '/tmp/dfv-t7-out.csv'",
        "attach '/tmp/other.duckdb' as o",
        "install httpfs",
        "load httpfs",
        "pragma database_list",
        "set threads = 8",
        "create table x(i int)",
        "insert into t values (1,1,1,1,null,'x')",
        "delete from t",
        "drop table t",
        "select * from t; select * from t",
        "select * from duckdb_settings()",
        "select current_setting('home_directory')",
        "select * from",
        "select 1; install httpfs",
    ] {
        assert!(
            matches!(e.run_query(sql, 0), Err(Error::Policy(_))),
            "should be refused: {sql}"
        );
    }
    assert_eq!(col(&e, "select count(*) from t"), ["8"], "nothing changed");
    assert!(!Path::new("/tmp/dfv-t7-out.csv").exists());
}

// ---- Catalog (queryCatalog.test.ts) -----------------------------------------------------------------

#[test]
fn catalog_keeps_same_named_relations_in_different_schemas_distinct() {
    let dir = Dir::new("catalog");
    let e = open(&duckdb_file(
        &dir,
        "cat.duckdb",
        "create schema other; create table same(a int, b varchar); create table other.same(x double); create table z(i int);",
    ));
    let catalog = e.query_catalog(0).unwrap();
    let names: Vec<_> = catalog
        .iter()
        .map(|r| (r.schema.as_str(), r.name.as_str()))
        .collect();
    assert_eq!(names, [("main", "same"), ("main", "z"), ("other", "same")]);
    let other = catalog.iter().find(|r| r.schema == "other").unwrap();
    assert_eq!(other.sql_name, "\"cat\".\"other\".\"same\"");
    let main_cols = e.query_columns("cat", "main", "same").unwrap();
    assert_eq!(
        main_cols
            .iter()
            .map(|c| (c.name.as_str(), c.data_type.as_str()))
            .collect::<Vec<_>>(),
        [("a", "INTEGER"), ("b", "VARCHAR")]
    );
    assert_eq!(
        e.query_columns("cat", "other", "same").unwrap()[0].data_type,
        "DOUBLE"
    );
    assert_eq!(e.list_tables().unwrap(), ["same", "same", "z"]);
    assert!(matches!(
        e.query_columns("elsewhere", "main", "same"),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(e.query_catalog(1_000_001), Err(Error::Invalid(_))));
    // The qualified name round-trips through the policy.
    assert_eq!(
        col(&e, &format!("select count(*) from {}", other.sql_name)),
        ["0"]
    );
}

// ---- run_query: types, caps, budgets ----------------------------------------------------------------

#[test]
fn rows_keep_exact_values_and_classify_columns_for_statistics() {
    let dir = Dir::new("types");
    let e = open(&duckdb_file(&dir, "sales.duckdb", SALES));
    let r = e
        .run_query("select id, big, huge, dec, ts, name from t order by id", 0)
        .unwrap();
    assert_eq!(r.columns, ["id", "big", "huge", "dec", "ts", "name"]);
    assert_eq!(
        r.column_stats_kind,
        [
            StatsKind::Numeric,
            StatsKind::Numeric,
            StatsKind::Numeric,
            StatsKind::Numeric,
            StatsKind::Datetime,
            StatsKind::Other
        ]
    );
    assert!(!r.truncated);
    assert_eq!(
        r.rows[0],
        [
            json!(0),
            json!(9),
            json!(9_000_000_000_000_i64),
            json!("-4.0000"),
            json!("2024-01-15 00:30:00"),
            json!("Zebra")
        ]
    );
    // Past 2^53 an integer is text, never a rounded number; a decimal is always text.
    assert_eq!(r.rows[5][1], json!("1152921504606846976"));
    assert_eq!(r.rows[6][2], json!("1152921504606846975000000000000"));
    assert_eq!(
        r.rows[7],
        [json!(99), J::Null, J::Null, J::Null, J::Null, J::Null]
    );
}

#[test]
fn every_scalar_type_prints_exactly_as_duckdb_does() {
    let dir = Dir::new("matrix");
    let e = open(&duckdb_file(
        &dir,
        "m.duckdb",
        "create table one(i int); insert into one values (1);",
    ));
    let exprs = [
        "date '2024-01-31'",
        "date '1969-12-31'",
        "date '0044-03-15 (BC)'",
        "date 'infinity'",
        "date '-infinity'",
        "time '12:34:56'",
        "time '12:34:56.789012'",
        "time '00:00:00.5'",
        "timestamp '1999-12-31 23:59:59.5'",
        "timestamp '1969-12-31 23:59:59.000001'",
        "timestamp 'infinity'",
        "cast(timestamp '2024-01-31 12:34:56.789' as timestamp_ms)",
        "cast(timestamp '2024-01-31 12:34:56' as timestamp_s)",
        "cast(timestamp '2024-01-31 12:34:56.123456789' as timestamp_ns)",
        "interval '1 year 2 months 3 days 04:05:06.7'",
        "interval '-1 month'",
        "interval '0'",
        "interval '1 day'",
        "interval '-2147483648 days'",
        "interval '-00:00:01.5'",
        "'\\x00AB'::blob",
        "'plain text'::blob",
        "from_hex('61226227635c64')",
        "cast(1.5 as decimal(4,1))",
        "cast(-0.05 as decimal(18,3))",
        "cast(12345678901234567890123456.1234567890 as decimal(38,10))",
        "170141183460469231731687303715884105727::hugeint",
        "(-170141183460469231731687303715884105727)::hugeint",
        "340282366920938463463374607431768211455::uhugeint",
        "18446744073709551615::ubigint",
        "(-128)::tinyint",
        "255::utinyint",
        "uuid '12345678-1234-5678-1234-567812345678'",
        "true",
        "false",
        "'İstanbul σ 😀'",
        "''",
    ];
    let natural = e
        .run_query(&format!("select {} from one", exprs.join(", ")), 0)
        .unwrap();
    // Text form straight from DuckDB's own cast, through the same engine: the independent reference.
    let casts: Vec<String> = exprs
        .iter()
        .map(|x| format!("cast({x} as varchar)"))
        .collect();
    let reference = e
        .run_query(&format!("select {} from one", casts.join(", ")), 0)
        .unwrap();
    let mut mismatches = vec![];
    for (i, x) in exprs.iter().enumerate() {
        let (got, want) = (&natural.rows[0][i], s(&reference.rows[0][i]));
        let ok = match got {
            J::String(t) => *t == want,
            J::Bool(b) => b.to_string() == want,
            J::Number(n) => n.to_string() == want,
            _ => false,
        };
        if !ok {
            mismatches.push(format!("{x}: got {got}, DuckDB prints {want}"));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn containers_become_json_and_floats_stay_numbers() {
    let dir = Dir::new("containers");
    let e = open(&duckdb_file(
        &dir,
        "m.duckdb",
        "create table one(i int); insert into one values (1);",
    ));
    let r = e
        .run_query(
            "select [1,2,3] l, {'a': 1, 'b': 'x'} st, map {'k': 1} m, [1,2]::int[2] arr, 0.1::double f, 1e300 big, cast('NaN' as double) nan, 1.0::float fl, [] e",
            0,
        )
        .unwrap();
    assert_eq!(r.rows[0][0], json!([1, 2, 3]));
    assert_eq!(r.rows[0][1], json!({"a": 1, "b": "x"}));
    assert_eq!(r.rows[0][2], json!([{"key": "k", "value": 1}]));
    assert_eq!(r.rows[0][3], json!([1, 2]));
    assert_eq!(r.rows[0][4], json!(0.1));
    assert_eq!(r.rows[0][5], json!(1e300));
    assert_eq!(
        r.rows[0][6],
        json!("NaN"),
        "JSON has no NaN; the text keeps it"
    );
    assert_eq!(r.rows[0][7], json!(1.0));
    assert_eq!(r.rows[0][8], json!([]));
}

#[test]
fn a_cap_reports_truncation_only_when_rows_were_actually_cut() {
    let dir = Dir::new("cap");
    let e = open(&duckdb_file(&dir, "m.duckdb", "create table one(i int);"));
    for (cap, rows, truncated) in [
        (3, 3, true),
        (9, 9, true),
        (10, 10, false),
        (11, 10, false),
        (0, 10, false),
    ] {
        let r = e.run_query("select * from range(10)", cap).unwrap();
        assert_eq!((r.rows.len(), r.truncated), (rows, truncated), "cap {cap}");
    }
    // A trailing semicolon and an ORDER BY survive the cap wrapper.
    let r = e
        .run_query("select range as r from range(10) order by r desc;", 3)
        .unwrap();
    assert_eq!(r.rows, [[json!(9)], [json!(8)], [json!(7)]]);
    assert!(r.truncated);
    // describe/explain cannot be a subquery and are run as they are.
    assert_eq!(
        e.run_query("describe select 1 as a", 1).unwrap().columns[0],
        "column_name"
    );
}

#[test]
fn an_oversized_result_is_refused_not_truncated() {
    let dir = Dir::new("budget");
    let e = open(&duckdb_file(&dir, "m.duckdb", "create table one(i int);"));
    let cell = e
        .run_query("select rpad('x', 5 * 1024 * 1024, 'x')", 0)
        .unwrap_err();
    assert_eq!(refusal(cell), Refusal::CellSize);
    let total = e
        .run_query("select rpad('x', 3000000, 'x') from range(12)", 0)
        .unwrap_err();
    assert_eq!(refusal(total), Refusal::ResultSize);
    assert_eq!(
        e.run_query("", 0).map_err(refusal).unwrap_err(),
        Refusal::SqlSize
    );
    assert_eq!(
        e.run_query(&"x".repeat(300 * 1024), 0)
            .map_err(refusal)
            .unwrap_err(),
        Refusal::SqlSize
    );
}

// ---- Sorting, counts, statistics (duckdbSorting.test.ts) --------------------------------------------

#[test]
fn sorting_agrees_with_duckdb_order_for_every_type_and_direction() {
    let dir = Dir::new("sort");
    let e = open(&duckdb_file(&dir, "sales.duckdb", SALES));
    // Expected id orders from Python duckdb 2.0.0 over the same rows (nulls last, binary collation).
    let by_name = ([0, 1, 5, 6, 2, 4, 3, 99], [3, 4, 2, 6, 5, 1, 0, 99]);
    let by_big = ([4, 0, 1, 2, 3, 6, 5, 99], [5, 6, 3, 2, 1, 0, 4, 99]);
    for (column, (asc, desc)) in [("name", by_name), ("big", by_big)] {
        for (direction, want) in [(Direction::Asc, asc), (Direction::Desc, desc)] {
            let (r, sorted_sql) = e
                .run_sorted_query("select * from t", column, direction, 0)
                .unwrap();
            let ids: Vec<i64> = r.rows.iter().map(|row| row[0].as_i64().unwrap()).collect();
            assert_eq!(ids, want, "{column} {direction:?}");
            assert!(
                sorted_sql.contains("order by"),
                "the SQL it ran is handed back for the backup diff"
            );
        }
    }
    // huge, dec and ts follow `big`'s row order in this fixture only through id, so compare to DuckDB itself.
    for column in ["huge", "dec", "ts"] {
        let (r, _) = e
            .run_sorted_query("select * from t", column, Direction::Desc, 0)
            .unwrap();
        let want = col(
            &e,
            &format!("select id from t order by \"{column}\" desc nulls last"),
        );
        assert_eq!(
            r.rows.iter().map(|row| s(&row[0])).collect::<Vec<_>>(),
            want,
            "{column}"
        );
    }
}

#[test]
fn sorting_covers_the_whole_data_set_not_just_the_limit_window() {
    let dir = Dir::new("sortlimit");
    let e = open(&duckdb_file(&dir, "sales.duckdb", SALES));
    let (r, _) = e
        .run_sorted_query("select * from t limit 2", "big", Direction::Desc, 0)
        .unwrap();
    assert_eq!(r.rows.len(), 2);
    assert_eq!(
        r.rows.iter().map(|row| s(&row[1])).collect::<Vec<_>>(),
        ["1152921504606846976", "1152921504606846975"]
    );
}

#[test]
fn a_hostile_column_name_cannot_break_out_of_the_sort_or_stats_sql() {
    let dir = Dir::new("hostile");
    let e = open(&duckdb_file(&dir, "sales.duckdb", SALES));
    let evil = "big\" desc; drop table t; --";
    assert!(
        e.run_sorted_query("select * from t", evil, Direction::Asc, 0)
            .is_err()
    );
    assert!(e.column_top_values("select * from t", evil, 5).is_err());
    assert!(
        e.column_descriptive_stats("select * from t", evil, StatsKind::Numeric)
            .is_err()
    );
    assert_eq!(col(&e, "select count(*) from t"), ["8"]);
}

#[test]
fn counts_ignore_the_trailing_limit_and_never_fail_the_query() {
    let dir = Dir::new("count");
    let e = open(&duckdb_file(&dir, "sales.duckdb", SALES));
    assert_eq!(e.count_matching_rows("select * from t limit 3"), Some(8));
    assert_eq!(
        e.count_matching_rows("select * from t where id < 3 limit 1 offset 1;"),
        Some(3)
    );
    assert_eq!(
        e.count_matching_rows("select * from t where big > 0"),
        Some(6)
    );
    assert_eq!(
        e.count_matching_rows("select * from t -- trailing comment"),
        Some(8)
    );
    assert_eq!(e.count_matching_rows("select * from nope"), None);
    assert_eq!(e.count_matching_rows("delete from t"), None);
}

#[test]
fn top_values_and_descriptive_stats_are_computed_over_the_whole_query() {
    let dir = Dir::new("stats");
    let e = open(&duckdb_file(
        &dir,
        "s.duckdb",
        "create table v(g varchar, n double, d date); insert into v values ('a',1,date '2024-01-01'),('a',2,date '2024-01-03'),('b',3,date '2024-01-05'),('c',null,null),(null,10,date '2024-01-07');",
    ));
    let top = e.column_top_values("select * from v", "g", 2).unwrap();
    assert_eq!(
        (
            top.total_rows,
            top.non_null_rows,
            top.null_count,
            top.distinct_count
        ),
        (5, 4, 1, 3)
    );
    assert_eq!(top.top_values, [(json!("a"), 2), (json!("b"), 1)]);
    // limit is clamped, never interpolated raw
    assert_eq!(
        e.column_top_values("select * from v", "g", 9999)
            .unwrap()
            .top_values
            .len(),
        3
    );
    let n = e
        .column_descriptive_stats("select * from v", "n", StatsKind::Numeric)
        .unwrap();
    assert_eq!((n.total_rows, n.non_null_rows, n.null_count), (5, 4, 1));
    assert_eq!(
        (n.min, n.max, n.mean),
        (json!(1.0), json!(10.0), json!(4.0))
    );
    let d = e
        .column_descriptive_stats("select * from v", "d", StatsKind::Datetime)
        .unwrap();
    assert_eq!((d.min, d.max), (json!("2024-01-01"), json!("2024-01-07")));
    assert_eq!(
        d.mean,
        json!("2024-01-04 00:00:00+00"),
        "the mean of dates is a timestamp, like the TypeScript"
    );
    assert!(matches!(
        e.column_descriptive_stats("select * from v", "g", StatsKind::Other),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn stored_macros_cannot_change_native_counts_or_statistics() {
    let dir = Dir::new("shadowed-stats");
    let e = open(&duckdb_file(
        &dir,
        "s.duckdb",
        "create table v(g varchar, n double, d date); insert into v values ('a',1,date '2024-01-01'),('b',3,date '2024-01-05'),('c',null,null); \
         create macro count(x) as 999; create macro avg(x) as 999; create macro min(x) as 999; create macro max(x) as 999; \
         create macro approx_quantile(x, q) as 999; create macro epoch(x) as 0; create macro to_timestamp(x) as null;",
    ));
    assert_eq!(e.count_matching_rows("select * from v"), Some(3));
    let top = e.column_top_values("select * from v", "g", 5).unwrap();
    assert_eq!(
        (top.total_rows, top.non_null_rows, top.distinct_count),
        (3, 3, 3)
    );
    let n = e
        .column_descriptive_stats("select * from v", "n", StatsKind::Numeric)
        .unwrap();
    assert_eq!((n.total_rows, n.non_null_rows, n.null_count), (3, 2, 1));
    assert_eq!((n.min, n.max, n.mean), (json!(1.0), json!(3.0), json!(2.0)));
    let d = e
        .column_descriptive_stats("select * from v", "d", StatsKind::Datetime)
        .unwrap();
    assert_eq!(d.mean, json!("2024-01-03 00:00:00+00"));
}

#[test]
fn stored_macros_cannot_change_the_chart_year_axis_or_probe_counts() {
    let dir = Dir::new("shadowed-chart");
    let e = open(&duckdb_file(
        &dir,
        "c.duckdb",
        "create table y(\"Year\" integer, r double); insert into y values (2023, 3.0), (2021, 1.0), (2022, 2.0); \
         create table t(d varchar, r double); insert into t values ('2024-01-01', 1.0), ('2024-01-02', 2.0); \
         create macro make_date(a, b, c) as null; create macro count(x) as 0; create macro try_cast(x) as null;",
    ));
    let (r, axis) = e
        .run_chart_query("select * from y", "Year", &["r"], false, 0, true)
        .unwrap();
    assert_eq!(axis, XAxis::Time);
    assert_eq!(
        r.rows
            .iter()
            .map(|row| s(&row[0])[..10].to_owned())
            .collect::<Vec<_>>(),
        ["2021-01-01", "2022-01-01", "2023-01-01"]
    );
    let (r, axis) = e
        .run_chart_query("select * from t", "d", &["r"], true, 0, false)
        .unwrap();
    assert_eq!((axis, r.rows.len()), (XAxis::Time, 2));
}

#[test]
fn a_stored_information_schema_cannot_replace_the_catalog_views() {
    let dir = Dir::new("shadowed-infoschema");
    let path = dir.file("i.duckdb");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("create table data(i integer); insert into data values (1)")
        .unwrap();
    // Either DuckDB refuses the lookalike schema, or the engine must still read the real catalog.
    let created = c
        .execute_batch(
            "create schema information_schema; create table information_schema.tables(table_catalog varchar, table_schema varchar, table_name varchar); \
             insert into information_schema.tables values ('i', 'main', 'forged')",
        )
        .is_ok();
    drop(c);
    let e = open(&path);
    let names: Vec<_> = e
        .query_catalog(0)
        .unwrap()
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert!(
        !names.contains(&"forged".to_owned()),
        "created={created}: {names:?}"
    );
    assert!(!e.list_tables().unwrap().contains(&"forged".to_owned()));
    assert!(names.contains(&"data".to_owned()));
}

#[test]
fn a_database_named_like_the_system_catalog_cannot_capture_internal_calls() {
    for stem in ["system", "temp", "memory"] {
        let dir = Dir::new("catalog-name");
        let path = duckdb_file(
            &dir,
            &format!("{stem}.duckdb"),
            "create table v(n double); insert into v values (1), (3); \
             create macro count(x) as 999; create macro avg(x) as 999; create macro current_database() as 'x';",
        );
        match Engine::open(&path) {
            Err(e @ (Error::Engine(_) | Error::Invalid(_) | Error::Unsupported(_))) => {
                eprintln!("{stem}: refused at open: {e}");
            }
            Ok(e) => {
                eprintln!("{stem}: opened as catalog {}", e.catalog);
                assert_eq!(e.count_matching_rows("select * from v"), Some(2), "{stem}");
                let n = e
                    .column_descriptive_stats("select * from v", "n", StatsKind::Numeric)
                    .unwrap();
                assert_eq!((n.total_rows, n.mean), (2, json!(2.0)), "{stem}");
            }
            Err(other) => panic!("{stem}: {other:?}"),
        }
    }
}

#[test]
fn derived_reads_are_size_bounded_and_keep_typed_outcomes() {
    let dir = Dir::new("derived-bounds");
    let mut e = open(&duckdb_file(
        &dir,
        "b.duckdb",
        "create table big(s varchar); insert into big select rpad('x', 5 * 1024 * 1024, chr(65 + (i % 20)::int)) from range(3) t(i); \
         create table small(n integer); insert into small values (1), (2);",
    ));
    // Distinct values are cells too: the 4 MiB cell budget applies to top values.
    let big = e
        .column_top_values("select * from big", "s", 5)
        .unwrap_err();
    assert_eq!(refusal(big), Refusal::CellSize);
    let wire = e
        .column_top_values_wire("select * from big", "s", 5)
        .unwrap_err();
    assert_eq!(refusal(wire), Refusal::CellSize);
    // A count keeps refusals, deadlines and cancellation typed; only the plain wrapper hides them.
    assert!(matches!(
        e.count_matching_rows_checked("drop table small"),
        Err(Error::Policy(_))
    ));
    assert_eq!(e.count_matching_rows("drop table small"), None);
    assert_eq!(
        e.count_matching_rows_checked("select * from small limit 1"),
        Ok(Some(2))
    );
    e.deadline = Duration::from_millis(300);
    assert_eq!(e.count_matching_rows_checked(HEAVY), Err(Error::TimedOut));
    e.deadline = Duration::from_secs(30);
    assert_eq!(e.count_matching_rows("select * from small"), Some(2));
}

#[test]
fn a_catalog_page_over_one_mebibyte_is_refused() {
    let dir = Dir::new("catalog-bytes");
    // Ordinary long names pass; 100 relations with 8 KB names pass 1 MiB once name and quoted SQL name count.
    let ddl: String = (0..100)
        .map(|i| format!("create table \"{i:03}{}\"(a int); ", "n".repeat(250)))
        .collect();
    let probe = Engine::open(&duckdb_file(&dir, "ok.duckdb", &ddl)).unwrap();
    assert_eq!(
        probe.query_catalog(0).unwrap().len(),
        100,
        "ordinary long names are fine"
    );
    let ddl: String = (0..100)
        .map(|i| format!("create table \"{i:03}{}\"(a int); ", "n".repeat(8000)))
        .collect();
    let path = duckdb_file(&dir, "huge.duckdb", &ddl);
    match Engine::open(&path) {
        Ok(e) => assert_eq!(
            refusal(e.query_catalog(0).unwrap_err()),
            Refusal::ResultSize
        ),
        Err(e) => panic!("open failed: {e}"),
    }
}

#[test]
fn catalog_and_column_budgets_include_the_wire_field_names() {
    let dir = Dir::new("metadata-boundary");
    // The old tuple accounting is below 1 MiB for each fixture; the transmitted objects exceed it.
    let ddl: String = (0..100)
        .map(|i| format!("create table \"{i:03}{}\"(a int); ", "n".repeat(5200)))
        .collect();
    let e = open(&duckdb_file(&dir, "edge.duckdb", &ddl));
    assert_eq!(
        refusal(e.query_catalog(0).unwrap_err()),
        Refusal::ResultSize
    );
    let columns = (0..100)
        .map(|i| format!("\"{i:03}{}\" integer", "n".repeat(10447)))
        .collect::<Vec<_>>()
        .join(",");
    let e = open(&duckdb_file(
        &dir,
        "columns.duckdb",
        &format!("create table v({columns})"),
    ));
    assert_eq!(
        refusal(e.query_columns(&e.catalog, "main", "v").unwrap_err()),
        Refusal::ResultSize
    );
}

// ---- Chart reads (chartQuery.test.ts) ---------------------------------------------------------------

const CHART: &str = "create table native (Date date, Rate double); \
    insert into native select date '2000-01-01' + interval (i) month, i * 1.5 from range(0, 200) as t(i); \
    create table etl (Date varchar, SVENF01 double); insert into etl select strftime(Date, '%Y-%m-%d'), Rate from native; \
    create table labels (Date varchar, ff double); insert into labels values ('1996-3Q', 5.3), ('1996-1Q', 5.1), ('1996-2Q', 5.2); \
    create table years (Year integer, Rate double); insert into years values (2023, 3.0), (2021, 1.0), (2022, 2.0); \
    create table months (Month integer, Rate double); insert into months values (3, 3.0), (1, 1.0), (2, 2.0); \
    create table mostly (Date varchar, v double); insert into mostly select strftime(Date, '%Y-%m-%d'), Rate from native limit 100; \
    insert into mostly values ('n/a', 1.0), ('', 2.0);";

#[test]
fn charts_pick_the_axis_the_data_supports() {
    let dir = Dir::new("chart");
    let e = open(&duckdb_file(&dir, "chart.duckdb", CHART));
    let chart = |sql: &str, x: &str, ys: &[&str], text: bool, cap: usize, cat: bool| {
        e.run_chart_query(sql, x, ys, text, cap, cat).unwrap()
    };

    let (r, axis) = chart("select * from native", "Date", &["Rate"], false, 0, false);
    assert_eq!((axis, r.rows.len()), (XAxis::Time, 200));

    // The trailing LIMIT is honoured: the chart is the query on screen.
    assert_eq!(
        chart(
            "SELECT * FROM \"native\" LIMIT 100;",
            "Date",
            &["Rate"],
            false,
            0,
            false
        )
        .0
        .rows
        .len(),
        100
    );

    // ...and the limited rows are the ones the grid shows, not the earliest by x.
    let limited = chart(
        "select * from \"native\" order by \"Date\" desc limit 10",
        "Date",
        &["Rate"],
        false,
        0,
        false,
    )
    .0;
    let all = chart(
        "select * from \"native\"",
        "Date",
        &["Rate"],
        false,
        0,
        false,
    )
    .0;
    assert_eq!(limited.rows.len(), 10);
    assert_eq!(limited.rows.last(), all.rows.last());
    assert_ne!(limited.rows.first(), all.rows.first());

    // A VARCHAR column of ISO text charts on a time axis, cast (a timestamp, not the stored string).
    let (r, axis) = chart("select * from etl", "Date", &["SVENF01"], true, 0, false);
    assert_eq!((axis, r.rows.len()), (XAxis::Time, 200));
    assert_ne!(s(&r.rows[0][0]), "2000-01-01");
    assert_eq!(s(&r.rows[0][0]), "2000-01-01 00:00:00");
    // ordered by the cast date, not the string
    let xs: Vec<String> = r.rows.iter().map(|row| s(&row[0])).collect();
    assert!(xs.windows(2).all(|w| w[0] <= w[1]));

    // A few junk rows do not downgrade a real date column.
    let (r, axis) = chart("select * from mostly", "Date", &["v"], true, 0, false);
    assert_eq!((axis, r.rows.len()), (XAxis::Time, 100));

    // Unparseable period labels fall back to a category axis, verbatim and in the table's own order.
    let (r, axis) = chart("select * from labels", "Date", &["ff"], true, 0, false);
    assert_eq!(axis, XAxis::Category);
    assert_eq!(
        r.rows.iter().map(|row| s(&row[0])).collect::<Vec<_>>(),
        ["1996-3Q", "1996-1Q", "1996-2Q"]
    );

    // A numeric Year charts on an ordered time axis at each 1 January.
    let (r, axis) = chart("select * from years", "Year", &["Rate"], false, 0, true);
    assert_eq!(axis, XAxis::Time);
    assert_eq!(
        r.rows
            .iter()
            .map(|row| s(&row[0])[..10].to_owned())
            .collect::<Vec<_>>(),
        ["2021-01-01", "2022-01-01", "2023-01-01"]
    );
    assert_eq!(
        r.rows
            .iter()
            .map(|row| row[1].as_f64().unwrap())
            .collect::<Vec<_>>(),
        [1.0, 2.0, 3.0]
    );

    // A numeric period that is not a year stays a category in stored order.
    let (r, axis) = chart("select * from months", "Month", &["Rate"], false, 0, true);
    assert_eq!(axis, XAxis::Category);
    assert_eq!(
        r.rows
            .iter()
            .map(|row| row[0].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [3, 1, 2]
    );

    // The point cap is reported, not a quiet prefix.
    let (r, _) = chart("select * from native", "Date", &["Rate"], false, 50, false);
    assert_eq!((r.truncated, r.rows.len()), (true, 50));
}

#[test]
fn a_chart_column_name_cannot_break_out_of_the_query() {
    let dir = Dir::new("chartquote");
    let e = open(&duckdb_file(&dir, "chart.duckdb", CHART));
    assert!(
        e.run_chart_query(
            "select * from native",
            "Date\" from native; drop table native; --",
            &["Rate"],
            false,
            0,
            false
        )
        .is_err()
    );
    assert_eq!(col(&e, "select count(*) from native"), ["200"]);
}

// ---- Cancellation, deadlines, lifetime --------------------------------------------------------------

const HEAVY: &str = "select sum(a.range * b.range) from range(100000) a, range(100000) b";

#[test]
fn a_deadline_interrupts_the_query_and_the_engine_stays_usable() {
    let dir = Dir::new("deadline");
    let mut e = open(&duckdb_file(&dir, "m.duckdb", "create table one(i int);"));
    e.deadline = Duration::from_millis(300);
    let started = Instant::now();
    assert_eq!(e.run_query(HEAVY, 0).unwrap_err(), Error::TimedOut);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the interrupt must be prompt, took {:?}",
        started.elapsed()
    );
    e.deadline = Duration::from_secs(30);
    assert_eq!(
        col(&e, "select 7"),
        ["7"],
        "an expired deadline must not poison the next query"
    );
}

#[test]
fn a_cancel_from_another_thread_is_reported_as_interrupted_and_leaves_the_engine_usable() {
    let dir = Dir::new("cancel");
    let e = open(&duckdb_file(&dir, "m.duckdb", "create table one(i int);"));
    let handle = e.interrupt_handle();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        handle.interrupt();
    });
    assert_eq!(e.run_query(HEAVY, 0).unwrap_err(), Error::Interrupted);
    canceller.join().unwrap();
    assert_eq!(col(&e, "select 8"), ["8"]);
}

#[test]
fn closing_releases_the_file_so_a_writer_can_open_it() {
    let dir = Dir::new("close");
    let path = duckdb_file(&dir, "w.duckdb", "create table one(i int);");
    let e = open(&path);
    assert_eq!(col(&e, "select count(*) from one"), ["0"]);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        e.run_query("insert into one values (99)", 0),
        Err(Error::Policy(_))
    ));
    assert!(matches!(
        e.run_query("update one set i=99", 0),
        Err(Error::Policy(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(col(&e, "select count(*) from one"), ["0"]);
    drop(e);
    let c = Connection::open(&path).expect("the file is released after drop");
    c.execute_batch("insert into one values (1)").unwrap();
}

#[test]
fn a_changed_source_is_refused_not_read() {
    let dir = Dir::new("stamp");
    let path = text_file(&dir, "d.csv", "a,b\n1,2\n");
    let e = open(&path);
    assert_eq!(col(&e, "select a from d"), ["1"]);
    std::fs::write(&path, "a,b\n1,2\n3,4\n").unwrap();
    assert_eq!(
        e.run_query("select a from d", 0).unwrap_err(),
        Error::SourceChanged
    );
    assert_eq!(e.count_matching_rows("select a from d"), None);
}

#[test]
fn duckdb_journals_refuse_open_without_touching_source_or_sidecars() {
    let dir = Dir::new("journal-open");
    for (index, suffix) in [".wal", ".wal.checkpoint", ".wal.recovery"]
        .iter()
        .enumerate()
    {
        let path = duckdb_file(&dir, &format!("d{index}.duckdb"), "create table d(i int)");
        let before = std::fs::read(&path).unwrap();
        let sidecar = path.with_extension(format!("duckdb{suffix}"));
        std::fs::write(&sidecar, b"uncheckpointed source journal").unwrap();
        assert!(matches!(Engine::open(&path), Err(Error::Unsupported(_))));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            std::fs::read(sidecar).unwrap(),
            b"uncheckpointed source journal"
        );
    }
}

#[test]
fn committed_duckdb_wal_refuses_open_without_replay() {
    let dir = Dir::new("real-wal");
    let path = duckdb_file(&dir, "d.duckdb", "create table d(i int)");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("insert into d values (42)").unwrap();
    let sidecar = path.with_extension("duckdb.wal");
    let source_before = std::fs::read(&path).unwrap();
    let wal_before = std::fs::read(&sidecar).unwrap();
    assert!(!wal_before.is_empty());
    assert!(matches!(Engine::open(&path), Err(Error::Unsupported(_))));
    assert_eq!(std::fs::read(&path).unwrap(), source_before);
    assert_eq!(std::fs::read(&sidecar).unwrap(), wal_before);
    drop(writer);
}

#[test]
fn appearing_duckdb_journals_invalidate_queries_with_unchanged_main_bytes() {
    let dir = Dir::new("journal-late");
    for (index, suffix) in [".wal", ".wal.checkpoint", ".wal.recovery"]
        .iter()
        .enumerate()
    {
        let path = duckdb_file(
            &dir,
            &format!("d{index}.duckdb"),
            "create table d(i int); insert into d values (7)",
        );
        let engine = open(&path);
        assert_eq!(col(&engine, "select i from d"), ["7"]);
        engine.check_source().unwrap();
        let before = std::fs::read(&path).unwrap();
        let sidecar = path.with_extension(format!("duckdb{suffix}"));
        std::fs::write(&sidecar, b"late journal").unwrap();
        assert_eq!(engine.check_source(), Err(Error::SourceChanged));
        assert_eq!(
            engine.run_query("select i from d", 0).unwrap_err(),
            Error::SourceChanged
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read(sidecar).unwrap(), b"late journal");
    }
}

#[cfg(unix)]
#[test]
fn dangling_duckdb_journal_links_are_refused_but_csv_sidecars_are_irrelevant() {
    let dir = Dir::new("journal-link");
    let path = duckdb_file(&dir, "d.duckdb", "create table d(i int)");
    let sidecar = path.with_extension("duckdb.wal");
    std::os::unix::fs::symlink(dir.file("missing"), &sidecar).unwrap();
    assert!(matches!(Engine::open(&path), Err(Error::Unsupported(_))));
    assert!(
        std::fs::symlink_metadata(sidecar)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let path = text_file(&dir, "d.csv", "i\n7\n");
    std::fs::write(path.with_extension("csv.wal"), b"unrelated").unwrap();
    assert_eq!(col(&open(&path), "select i from d"), ["7"]);
}

// ---- CSV (csvNumberLocale.test.ts, ext06CsvTypes.test.ts) -------------------------------------------

fn csv(dir: &Dir, name: &str, body: &str) -> Engine {
    open(&text_file(dir, &format!("{name}.csv"), body))
}
fn types(e: &Engine, table: &str) -> std::collections::BTreeMap<String, String> {
    let r = e
        .run_query(&format!("describe select * from \"{table}\""), 0)
        .unwrap();
    let (n, t) = (
        r.columns.iter().position(|c| c == "column_name").unwrap(),
        r.columns.iter().position(|c| c == "column_type").unwrap(),
    );
    r.rows.iter().map(|row| (s(&row[n]), s(&row[t]))).collect()
}
fn kv(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[test]
fn a_turkish_csv_comes_back_as_exact_numbers() {
    let dir = Dir::new("tr");
    let e = csv(
        &dir,
        "tr",
        "Tarih;Deger;Oran\n2024-01-31;1.794.446,52;12,5\n2024-02-29;2.145.900,00;13,7\n",
    );
    let r = e.run_query("select * from tr", 0).unwrap();
    assert_eq!(s(&r.rows[0][1]), "1794446.52");
    assert_eq!(s(&r.rows[0][2]), "12.5");
    assert_eq!(
        e.number_locale.as_ref().unwrap().locale,
        Some(NumberLocale::Eu)
    );
}

#[test]
fn an_english_csv_is_never_mangled_by_the_european_path() {
    let dir = Dir::new("en");
    let e = csv(
        &dir,
        "en",
        "Date,Value,Rate\n2024-01-31,\"1,234.56\",12.5\n",
    );
    let r = e.run_query("select * from en", 0).unwrap();
    assert_eq!(s(&r.rows[0][2]), "12.5", "must not become 125");
    assert_ne!(
        e.number_locale.as_ref().unwrap().locale,
        Some(NumberLocale::Eu)
    );
}

#[test]
fn an_undecidable_column_is_left_as_text_and_said_out_loud() {
    let dir = Dir::new("amb");
    let e = csv(&dir, "ambiguous", "a\n1.234\n2.345\n3.456\n");
    let notice = e.open_warnings.join("\n");
    for needle in [
        "left as text",
        "1.234",
        "Turkish",
        "English",
        "numberLocale",
    ] {
        assert!(notice.contains(needle), "{needle:?} missing from: {notice}");
    }
    assert_eq!(types(&e, "ambiguous"), kv(&[("a", "VARCHAR")]));
}

#[test]
fn forcing_the_locale_resolves_what_the_sniff_refused() {
    let dir = Dir::new("force");
    let path = text_file(&dir, "ambiguous2.csv", "a\n1.234\n2.345\n");
    let value = |locale| {
        let e = Engine::open_with(
            &path,
            &OpenOptions {
                number_locale: Some(locale),
                ..OpenOptions::default()
            },
        )
        .unwrap();
        let r = e.run_query("select a from ambiguous2", 0).unwrap();
        assert!(e.open_warnings.is_empty());
        assert!(e.number_locale.as_ref().unwrap().forced);
        r.rows[0][0].as_f64().unwrap()
    };
    assert_eq!(value(NumberLocale::Eu), 1234.0);
    assert_eq!(value(NumberLocale::En), 1.234);
}

#[test]
fn a_file_whose_columns_disagree_is_not_converted_either_way() {
    let dir = Dir::new("mixed");
    // b is a plain integer column, so it carries no convention and cannot conflict; a decides the file.
    let e = csv(&dir, "mixed", "a;b\n1.794.446,52;1\n2.000,00;2\n");
    assert_eq!(
        e.number_locale.as_ref().unwrap().locale,
        Some(NumberLocale::Eu)
    );
    let resolved = csv(
        &dir,
        "resolved",
        "strong;maybe\n1.794.446,52;1.234\n2.000,00;2.345\n",
    );
    assert_eq!(
        resolved.number_locale.as_ref().unwrap().locale,
        Some(NumberLocale::Eu)
    );
    assert_eq!(
        col(&resolved, "select maybe from resolved"),
        ["1234", "2345"]
    );
    assert_ne!(types(&resolved, "resolved")["maybe"], "VARCHAR");
    assert!(
        !resolved
            .open_warnings
            .join("\n")
            .contains("was left as text")
    );
    let e = csv(
        &dir,
        "conflict",
        "a;b\n1.794.446,52;\"1,234.56\"\n2.000,00;\"2,000.00\"\n",
    );
    let report = e.number_locale.as_ref().unwrap();
    assert!(report.conflicting && report.locale.is_none());
    assert_eq!(
        types(&e, "conflict"),
        kv(&[("a", "VARCHAR"), ("b", "VARCHAR")])
    );
    assert!(
        e.open_warnings
            .join("\n")
            .contains("disagree about the decimal convention")
    );
}

#[test]
fn an_ordinary_numeric_csv_is_untouched_and_the_file_on_disk_is_never_modified() {
    let dir = Dir::new("plain");
    let body = "a,b\n1,2\n3,4000\n";
    let path = text_file(&dir, "plain.csv", body);
    let before = std::fs::metadata(&path).unwrap().modified().unwrap();
    let e = open(&path);
    assert_eq!(
        e.run_query("select b from plain", 0).unwrap().rows[1][0],
        json!(4000)
    );
    assert_eq!(e.number_locale.as_ref().unwrap().locale, None);
    assert!(e.open_warnings.is_empty());
    drop(e);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        before
    );
}

#[test]
fn ext06_ids_stay_exact_and_dates_stay_dates() {
    let dir = Dir::new("ext06a");
    let e = csv(
        &dir,
        "side",
        "id,trade_date,stamp,price,mixed,code\n12345678901234567890123,2026-01-02,2026-01-02 09:30:00,1.5,1.5,007\n\
         12345678901234567890124,2026-01-05,2026-01-05 16:00:00,2.25,9007199254740993,010\n",
    );
    assert_eq!(
        types(&e, "side"),
        kv(&[
            ("id", "HUGEINT"),
            ("trade_date", "DATE"),
            ("stamp", "TIMESTAMP"),
            ("price", "DOUBLE"),
            ("mixed", "VARCHAR"),
            ("code", "VARCHAR")
        ])
    );
    assert_eq!(
        col(&e, "select id from side"),
        ["12345678901234567890123", "12345678901234567890124"]
    );
    assert_eq!(
        col(&e, "select mixed from side"),
        ["1.5", "9007199254740993"]
    );
    assert!(
        e.open_warnings.join("\n").contains("\"id\", \"mixed\""),
        "{:?}",
        e.open_warnings
    );
}

#[test]
fn ext06_controls_what_the_sniffer_gets_right_is_unchanged() {
    let dir = Dir::new("ext06b");
    let e = csv(
        &dir,
        "sniffed",
        "d1,d3,b,t,n,ts\n2026-01-02,20260102,true,09:30,42,2026-01-02T09:30:00\n2026-01-15,20260115,false,16:00,-7,2026-01-15T16:00:00\n",
    );
    assert_eq!(
        types(&e, "sniffed"),
        kv(&[
            ("d1", "DATE"),
            ("d3", "BIGINT"),
            ("b", "BOOLEAN"),
            ("t", "TIME"),
            ("n", "BIGINT"),
            ("ts", "TIMESTAMP")
        ])
    );
    assert!(e.open_warnings.is_empty(), "{:?}", e.open_warnings);

    let e = csv(
        &dir,
        "doubles",
        "price,avogadro,long\n1.50,6.022e23,0.1234567890123456789\n1e3,1.5E-10,-123456.78901234567\n-0.5,3.0e8,1.25\n12.25,2e0,0.30000000000000004\n",
    );
    assert_eq!(
        types(&e, "doubles"),
        kv(&[
            ("price", "DOUBLE"),
            ("avogadro", "DOUBLE"),
            ("long", "DOUBLE")
        ])
    );
    assert!(e.open_warnings.is_empty(), "{:?}", e.open_warnings);

    let e = csv(
        &dir,
        "precision",
        "a,b,id\n966.41641389214044,-218.89959204133902,12345678901234567890123\n278.74005196960428,0.000123456789012345678,12345678901234567890124\n",
    );
    assert_eq!(
        types(&e, "precision"),
        kv(&[("a", "DOUBLE"), ("b", "DOUBLE"), ("id", "HUGEINT")])
    );
    let notice = e.open_warnings.join("\n");
    assert!(
        !notice.contains("\"a\"") && !notice.contains("\"b\""),
        "{notice}"
    );

    // 16 digits, below 2^53: checked, and it survives.
    let e = csv(&dir, "exact16", "v\n1234567890123456\n0.5\n");
    assert_eq!(types(&e, "exact16")["v"], "DOUBLE");
}

#[test]
fn ext06_a_turkish_decimal_file_is_checked_in_its_own_convention() {
    let dir = Dir::new("ext06c");
    let e = csv(
        &dir,
        "turkish",
        "tutar;kimlik\n1.234,56;12345678901234567890123\n2.345,67;12345678901234567890124\n98,10;12345678901234567890125\n",
    );
    let t = types(&e, "turkish");
    assert_eq!(
        (t["tutar"].as_str(), t["kimlik"].as_str()),
        ("DOUBLE", "HUGEINT")
    );
    assert_eq!(
        col(&e, "select tutar from turkish"),
        ["1234.56", "2345.67", "98.1"]
    );
    assert_eq!(
        col(&e, "select kimlik from turkish"),
        [
            "12345678901234567890123",
            "12345678901234567890124",
            "12345678901234567890125"
        ]
    );
}

#[test]
fn ext06_a_wide_value_deep_in_the_file_is_found_not_only_in_the_head() {
    let dir = Dir::new("ext06d");
    let mut body = String::from("v\n");
    for i in 0..5000 {
        body.push_str(&format!("{i}.25\n"));
    }
    body.push_str("9007199254740993\n");
    let e = csv(&dir, "deep", &body);
    assert_eq!(types(&e, "deep")["v"], "VARCHAR");
    assert_eq!(
        e.run_query("select v from deep where v = '9007199254740993'", 0)
            .unwrap()
            .rows
            .len(),
        1
    );
}

// ---- Parquet (expected values from pyarrow 26.0.0; see tools/make_parquet_fixture.py) ----------------

fn parquet() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/types.parquet")
}
fn copy_parquet(dir: &Dir) -> PathBuf {
    let to = dir.file("types.parquet");
    std::fs::copy(parquet(), &to).unwrap();
    to
}

#[test]
fn parquet_values_match_pyarrow_exactly() {
    let dir = Dir::new("pq");
    let e = open(&copy_parquet(&dir));
    assert_eq!(e.kind, Kind::Parquet);
    assert_eq!(e.list_tables().unwrap(), ["types"]);
    let r = e.run_query("select * from types", 0).unwrap();
    assert_eq!(r.rows.len(), 3);
    let cell =
        |c: &str, i: usize| r.rows[i][r.columns.iter().position(|x| x == c).unwrap()].clone();
    // pyarrow: big = [9007199254740993, -9007199254740993, None]
    assert_eq!(
        (cell("big", 0), cell("big", 1), cell("big", 2)),
        (
            json!("9007199254740993"),
            json!("-9007199254740993"),
            J::Null
        )
    );
    // decimals: pyarrow prints Decimal('12345.67'), '-0.05', and for 0 at scale 10 '0E-10' (numerically 0)
    assert_eq!(
        (cell("dec", 0), cell("dec", 1)),
        (json!("12345.67"), json!("-0.05"))
    );
    assert_eq!(
        (cell("wide", 0), cell("wide", 1)),
        (
            json!("1234567890123456789012345678.1234567890"),
            json!("0.0000000000")
        )
    );
    assert_eq!(
        (cell("d", 0), cell("d", 1), cell("d", 2)),
        (json!("2024-01-31"), json!("1969-12-31"), J::Null)
    );
    assert_eq!(
        (cell("ts", 0), cell("ts", 1)),
        (
            json!("2024-01-31 12:34:56.789012"),
            json!("1999-12-31 23:59:59")
        )
    );
    assert_eq!(cell("tstz", 0), json!("2024-01-31 12:34:56.789012+00"));
    assert_eq!(
        (cell("s", 0), cell("s", 1)),
        (json!("İstanbul σ 😀"), json!("it's \"quoted\""))
    );
    assert_eq!((cell("b", 0), cell("b", 1)), (json!(true), json!(false)));
    assert_eq!((cell("f", 0), cell("f", 1)), (json!(0.1), json!(1e300)));
    assert_eq!(
        (cell("lst", 0), cell("lst", 1), cell("lst", 2)),
        (json!([1, 2, 3]), json!([]), J::Null)
    );
    assert_eq!(
        (cell("st", 0), cell("st", 1)),
        (json!({"a": 1, "b": "x"}), json!({"a": null, "b": null}))
    );
    assert_eq!(
        (cell("mp", 0), cell("mp", 1)),
        (json!([{"key": "k", "value": 1}]), json!([]))
    );
    assert_eq!(
        r.column_stats_kind[r.columns.iter().position(|x| x == "dec").unwrap()],
        StatsKind::Numeric
    );
    assert_eq!(
        r.column_stats_kind[r.columns.iter().position(|x| x == "ts").unwrap()],
        StatsKind::Datetime
    );
}

#[test]
fn parquet_metadata_reports_decimals_and_nested_shape_from_the_file() {
    let dir = Dir::new("pqmeta");
    let e = open(&copy_parquet(&dir));
    let info = e.parquet_info().unwrap();
    // pyarrow: num_rows 3, row groups 2 (row_group_size=2)
    assert_eq!((info.num_rows, info.row_groups), (3, 2));
    let find = |n: &str| {
        info.schema
            .iter()
            .find(|c| c.name == n)
            .unwrap_or_else(|| panic!("{n} not in schema"))
    };
    let dec = find("dec");
    assert_eq!((dec.precision, dec.scale), (Some(10), Some(2)));
    assert_eq!(dec.converted_type.as_deref(), Some("DECIMAL"));
    let wide = find("wide");
    assert_eq!((wide.precision, wide.scale), (Some(38), Some(10)));
    assert_eq!(find("big").physical_type.as_deref(), Some("INT64"));
    // nested nodes are groups with children; their leaves follow in file order
    assert!(
        find("lst").num_children.is_some()
            && find("st").num_children == Some(2)
            && find("mp").num_children.is_some()
    );
    assert!(
        info.schema.iter().any(|c| c.name == "element"),
        "list element leaf"
    );
    assert_eq!(
        info.schema[0].num_children,
        Some(12),
        "the root holds the 12 top-level columns"
    );
    assert!(matches!(
        open(&text_file(&dir, "x.csv", "a\n1\n")).parquet_info(),
        Err(Error::Unsupported(_))
    ));
}

#[test]
fn parquet_is_read_only_and_cannot_be_used_to_reach_other_files() {
    let dir = Dir::new("pqsafe");
    let path = copy_parquet(&dir);
    let before = std::fs::read(&path).unwrap();
    let e = open(&path);
    assert!(matches!(
        e.run_query("select * from read_parquet('/etc/hosts')", 0),
        Err(Error::Policy(_))
    ));
    assert!(matches!(
        e.run_query("copy types to '/tmp/dfv-t7-copy.csv'", 0),
        Err(Error::Policy(_))
    ));
    drop(e);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!Path::new("/tmp/dfv-t7-copy.csv").exists());
}

#[test]
fn wire_values_preserve_scalar_types() {
    let dir = Dir::new("wire");
    let file = duckdb_file(
        &dir,
        "wire.duckdb",
        "create table anchor(i integer); insert into anchor values(1);",
    );
    let e = open(&file);
    let q=e.run_query_wire("select 9007199254740993::bigint b, '-170141183460469231731687303715884105728'::hugeint h, '340282366920938463463374607431768211455'::uhugeint u, 1.2300::decimal(18,4) d, date '1970-01-02' as \"day\", timestamp '1969-12-31 23:59:59.999999' ts, cast('NaN' as double) f, null::varchar n, ''::varchar empty, from_hex('00ff27') bin",10).unwrap();
    assert_eq!(q.columns[0]["type"], json!({"id":"int64"}));
    assert_eq!(q.columns[1]["type"], json!({"id":"int128"}));
    assert_eq!(q.columns[2]["type"], json!({"id":"uint128"}));
    assert_eq!(
        q.columns[3]["type"],
        json!({"id":"decimal","precision":18,"scale":4})
    );
    assert_eq!(
        q.rows[0],
        vec![
            json!({"$t":"int64","v":"9007199254740993"}),
            json!({"$t":"int128","v":"-170141183460469231731687303715884105728"}),
            json!({"$t":"uint128","v":"340282366920938463463374607431768211455"}),
            json!({"$t":"decimal","v":"1.2300","precision":18,"scale":4}),
            json!({"$t":"date","v":"1"}),
            json!({"$t":"timestamp","v":"-1","unit":"us","tz":null}),
            json!({"$t":"float64","v":"NaN"}),
            J::Null,
            json!(""),
            json!({"$t":"binary","encoding":"base64","v":"AP8n"}),
        ]
    );
    assert!(!q.truncated);
    let q=e.run_query_wire("select 0::decimal(38,10) z, 1.0::decimal(38,10) one, null::decimal(38,10) n, '550e8400-e29b-41d4-a716-446655440000'::uuid id, time '01:02:03.000004' tm, cast('Infinity' as double) pos, cast('-Infinity' as double) neg, cast('-0' as double) nz, interval '1 month 2 days 00:00:00.000003' iv, timestamptz '1970-01-01 00:00:00+00' tz",10).unwrap();
    assert_eq!(
        q.columns[0]["type"],
        json!({"id":"decimal","precision":38,"scale":10})
    );
    assert_eq!(q.columns[2]["type"], q.columns[0]["type"]);
    assert_eq!(
        q.rows[0][0],
        json!({"$t":"decimal","v":"0.0000000000","precision":38,"scale":10})
    );
    assert_eq!(
        q.rows[0][1],
        json!({"$t":"decimal","v":"1.0000000000","precision":38,"scale":10})
    );
    assert_eq!(q.rows[0][2], J::Null);
    assert_eq!(
        q.rows[0][3],
        json!({"$t":"uuid","v":"550e8400-e29b-41d4-a716-446655440000"})
    );
    assert_eq!(
        q.rows[0][4],
        json!({"$t":"time","v":"3723000004","unit":"us"})
    );
    assert_eq!(q.rows[0][5], json!({"$t":"float64","v":"Infinity"}));
    assert_eq!(q.rows[0][6], json!({"$t":"float64","v":"-Infinity"}));
    assert_eq!(q.rows[0][7], json!({"$t":"float64","v":"-0"}));
    assert_eq!(
        q.rows[0][8],
        json!({"$t":"interval","months":"1","days":"2","nanos":"3000"})
    );
    assert_eq!(
        q.rows[0][9],
        json!({"$t":"timestamp","v":"0","unit":"us","tz":"UTC"})
    );
    let q = e.run_query_wire("select i from range(3) t(i)", 2).unwrap();
    assert_eq!(q.rows.len(), 2);
    assert!(q.truncated);
    let empty = e
        .run_query_wire("select i from anchor where false", 10)
        .unwrap();
    assert!(empty.rows.is_empty());
    assert_eq!(empty.columns[0]["type"], json!({"id":"int32"}));
}

#[test]
fn nested_wire_values_keep_child_types_nulls_and_order_with_bounded_depth() {
    let dir = Dir::new("wire-nested");
    let e = open(&duckdb_file(
        &dir,
        "nested.duckdb",
        "create table anchor(i integer)",
    ));
    let result = e.run_query_wire("select [9007199254740993::bigint, null] as lst, {'z': 1.2300::decimal(18,4), 'a': timestamptz '1970-01-01 00:00:00+00'} as st, map {'one': [9007199254740993::bigint, null]} as mp, [1,2]::integer[2] as fixed", 10).unwrap();
    assert_eq!(
        result.columns[0]["type"],
        json!({"id":"list","child":{"id":"int64"}})
    );
    assert_eq!(
        result.rows[0][0],
        json!({"$t":"list","v":[{"$t":"int64","v":"9007199254740993"},null]})
    );
    assert_eq!(
        result.columns[1]["type"]["fields"],
        json!([
            {"name":"z","type":{"id":"decimal","precision":18,"scale":4}},
            {"name":"a","type":{"id":"timestamp","unit":"us","tz":"UTC"}}
        ])
    );
    assert_eq!(
        result.rows[0][1],
        json!({"$t":"struct","v":[
            ["z",{"$t":"decimal","v":"1.2300","precision":18,"scale":4}],
            ["a",{"$t":"timestamp","v":"0","unit":"us","tz":"UTC"}]
        ]})
    );
    assert_eq!(
        result.rows[0][2],
        json!({"$t":"map","v":[["one",{"$t":"list","v":[{"$t":"int64","v":"9007199254740993"},null]}]]})
    );
    assert_eq!(
        result.rows[0][3],
        json!({"$t":"list","v":[{"$t":"int32","v":"1"},{"$t":"int32","v":"2"}]})
    );
    let mut nested = "1".to_owned();
    for _ in 0..32 {
        nested = format!("[{nested}]");
    }
    assert!(e.run_query_wire(&format!("select {nested}"), 1).is_ok());
    assert!(
        matches!(e.run_query_wire(&format!("select [{nested}]"), 1), Err(Error::Unsupported(message)) if message.contains("depth"))
    );
    assert_eq!(
        refusal(
            e.run_query_wire("select [rpad('x', 5 * 1024 * 1024, 'x')]", 1)
                .unwrap_err()
        ),
        Refusal::CellSize
    );
    assert!(e.run_query_wire("select [1]", 1).is_ok());
}

#[test]
fn edit_eligibility_never_combines_same_named_tables_from_different_schemas() {
    let dir = Dir::new("edit-identity");
    let path = duckdb_file(
        &dir,
        "identity.duckdb",
        "create table rows(i integer); insert into rows values (1); create table unique_rows(i integer); create schema other; create table other.rows(s varchar)",
    );
    let before = std::fs::read(&path).unwrap();
    let e = open(&path);
    assert_eq!(col(&e, "select i from rows"), ["1"]);
    assert!(
        !e.check_editable_select("select * from rows")
            .unwrap()
            .editable
    );
    let eligible = e
        .check_editable_select("select * from unique_rows limit 1")
        .unwrap();
    assert!(eligible.editable);
    assert_eq!(eligible.columns, ["i"]);
    assert!(
        !e.check_editable_select("select count(*) from unique_rows")
            .unwrap()
            .editable
    );
    assert!(matches!(
        e.check_editable_select("delete from unique_rows"),
        Err(Error::Policy(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
