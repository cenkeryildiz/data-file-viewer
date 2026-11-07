use dfv_table_duckdb::duckdb::quote_ident;
use dfv_table_duckdb::operations::{build_combined_query, poll_cadence, series_frequency};
use dfv_table_duckdb::{Engine, Error};
use duckdb::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Source(PathBuf);
impl Source {
    fn new(sql: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "dfv-operations-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("metadata.duckdb");
        Connection::open(&path).unwrap().execute_batch(sql).unwrap();
        Self(path)
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
    }
}

#[test]
fn optional_hint_parsers_accept_only_safe_values() {
    for (raw, expected) in [
        (" annual ", Some("annual")),
        ("\u{feff}MONTHLY\u{2029}", Some("monthly")),
        ("<b>daily</b>", None),
        ("\u{85}daily", None),
        ("fortnightly", None),
    ] {
        assert_eq!(series_frequency(raw), expected);
    }
    for raw in [
        "null",
        "[]",
        "{}",
        "{broken",
        r#"{"live_poll_seconds":"4"}"#,
        r#"{"live_poll_seconds":true}"#,
        r#"{"live_poll_seconds":0}"#,
        r#"{"live_poll_seconds":-1}"#,
        r#"{"live_poll_seconds":1e400}"#,
    ] {
        assert_eq!(poll_cadence(raw), None, "{raw}");
    }
    assert_eq!(poll_cadence(r#"{"live_poll_seconds":0.25}"#), Some(0.25));
    assert_eq!(poll_cadence(&" ".repeat(1_048_577)), None);
    assert_eq!(series_frequency(&" ".repeat(1_048_577)), None);
}

#[test]
fn combined_window_is_the_newest_tail_in_chronological_order() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("attach ':memory:' as cold; attach ':memory:' as hot; create table cold.main.prices(Date integer, value integer); insert into cold.main.prices values(1,10),(2,20); create table hot.main.prices(Date integer, value integer, extra varchar); insert into hot.main.prices values(3,30,'keep'),(4,40,'latest')").unwrap();
    let plan = build_combined_query(
        "prices",
        "cold",
        "hot",
        &["Date", "value"],
        &["Date", "value", "extra"],
        Some(2),
    )
    .unwrap();
    assert_eq!(plan.time_column, Some("Date"));
    let rows = c
        .prepare(&plan.sql)
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, bool>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows, [(3, true, "keep".into()), (4, true, "latest".into())]);
}

#[test]
fn combined_uses_shared_time_priority_and_exact_identifier_quoting() {
    let plan = build_combined_query(
        "p\";drop table x;--",
        "cold\"db",
        "hot\ndb",
        &["Date", "Datetime", "scraped_at"],
        &["Datetime", "Date", "scraped_at"],
        None,
    )
    .unwrap();
    assert_eq!(plan.time_column, Some("Datetime"));
    assert!(
        plan.sql
            .contains("\"cold\"\"db\".main.\"p\"\";drop table x;--\"")
    );
    assert!(plan.sql.contains("limit 500"));
    assert!(build_combined_query("p", "cold", "cold", &[], &[], None).is_err());
    assert!(build_combined_query("p", "cold", "hot", &[], &[], Some(u64::MAX)).is_err());
    let no_time = build_combined_query("p", "cold", "hot", &["Date"], &["date"], Some(2)).unwrap();
    assert_eq!(no_time.time_column, None);
    assert!(!no_time.sql.contains("limit"));
    assert!(build_combined_query("p\0", "cold", "hot", &[], &[], None).is_err());
}

#[test]
fn metadata_reads_are_bounded_typed_and_parameterized() {
    let source = Source::new(
        "create table data(i integer); create table sheet_metadata(table_name varchar, frequency varchar, extra_json varchar); create macro bit_length(x) as 0;",
    );
    {
        let c = Connection::open(&source.0).unwrap();
        c.execute(
            "insert into sheet_metadata values(?,?,?)",
            duckdb::params!["a'\"", " Monthly ", r#"{"live_poll_seconds":0.5}"#],
        )
        .unwrap();
        c.execute(
            "insert into sheet_metadata values(?,?,?)",
            duckdb::params![
                "huge",
                "x".repeat(1_048_577),
                format!(
                    "{{\"live_poll_seconds\":1,\"pad\":\"{}\"}}",
                    "x".repeat(1_048_577)
                )
            ],
        )
        .unwrap();
        c.execute(
            "insert into sheet_metadata values('bad','<b>daily</b>','{broken')",
            [],
        )
        .unwrap();
    }
    let before = std::fs::read(&source.0).unwrap();
    let engine = Engine::open(&source.0).unwrap();
    assert_eq!(engine.series_frequency("a'\"").unwrap(), Some("monthly"));
    assert_eq!(engine.poll_cadence_seconds("a'\"").unwrap(), Some(0.5));
    for name in ["huge", "bad", "missing", "' or 1=1 --"] {
        assert_eq!(engine.series_frequency(name).unwrap(), None);
        assert_eq!(engine.poll_cadence_seconds(name).unwrap(), None);
    }
    assert_eq!(std::fs::read(&source.0).unwrap(), before);
}

#[test]
fn missing_or_wrong_metadata_types_are_no_hint_but_stale_source_is_an_error() {
    for sql in [
        "create table data(i integer)",
        "create table sheet_metadata(table_name varchar, frequency integer, extra_json integer); insert into sheet_metadata values('data',1,1)",
    ] {
        let source = Source::new(sql);
        let engine = Engine::open(&source.0).unwrap();
        assert_eq!(engine.series_frequency("data").unwrap(), None);
        assert_eq!(engine.poll_cadence_seconds("data").unwrap(), None);
        std::fs::write(&source.0, b"changed").unwrap();
        assert!(matches!(
            engine.series_frequency("data"),
            Err(Error::SourceChanged)
        ));
    }
}

#[test]
fn combined_without_time_keeps_both_sides_and_union_by_name() {
    let c = Connection::open_in_memory().unwrap();
    let table = "price\" table";
    let name = quote_ident(table);
    c.execute_batch(&format!("attach ':memory:' as cold; attach ':memory:' as hot; create table cold.main.{name}(v integer); insert into cold.main.{name} values(1),(1); create table hot.main.{name}(other varchar, v integer); insert into hot.main.{name} values('x',2)")).unwrap();
    let plan =
        build_combined_query(table, "cold", "hot", &["v"], &["other", "v"], Some(1)).unwrap();
    let rows = c
        .prepare(&plan.sql)
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter()
            .filter(|r| r.0 == 1 && !r.1 && r.2.is_none())
            .count(),
        2
    );
    assert!(rows.contains(&(2, true, Some("x".into()))));
}
