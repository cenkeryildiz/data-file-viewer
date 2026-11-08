use dfv_table_duckdb::query::{ChartAxis, XAxis};
use dfv_table_duckdb::{Engine, Error};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new(query: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "dfv-chart-{}-{}.parquet",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let conn = duckdb::Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "copy ({query}) to '{}' (format parquet)",
            p.display()
        ))
        .unwrap();
        Self(p)
    }
    fn engine(&self) -> Engine {
        Engine::open(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[test]
fn row_axis_keeps_query_order_limit_and_null_rows_and_avoids_real_names() {
    let f = Fixture::new(
        "select * from (values (1, 10), (2, null), (3, 30), (4, 40)) as t(id, \"Row\")",
    );
    let before = std::fs::read(&f.0).unwrap();
    let e = f.engine();
    let table = e.list_tables().unwrap().remove(0);
    let query = format!("select * from \"{table}\" where id < 4 order by id desc limit 2");
    let (r, axis, note) = e
        .run_chart_query_axis_wire(&query, "Row", &["Row"], 10, ChartAxis::Rows)
        .unwrap();
    assert_eq!(axis, XAxis::Category);
    assert_eq!(note, None);
    assert_eq!(r.columns[0]["name"], "Row (2)");
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][0]["v"], "1");
    assert_eq!(r.rows[1][0]["v"], "2");
    assert_eq!(r.rows[0][1]["v"], "30");
    assert!(r.rows[1][1].is_null());
    assert!(!r.truncated);
    let empty = format!("select * from \"{table}\" where false");
    assert!(
        e.run_chart_query_axis_wire(&empty, "Row", &["Row"], 10, ChartAxis::Rows)
            .unwrap()
            .0
            .rows
            .is_empty()
    );
    assert_eq!(std::fs::read(&f.0).unwrap(), before);
}

#[test]
fn explicit_dates_check_every_non_null_value_and_report_missing_rows() {
    let f = Fixture::new(
        "select * from (values ('2024-01-03', 3), (null, 9), ('2024-01-01', 1)) as t(when_seen, y)",
    );
    let e = f.engine();
    let table = e.list_tables().unwrap().remove(0);
    let query = format!("select * from \"{table}\"");
    let (r, axis, note) = e
        .run_chart_query_axis_wire(&query, "when_seen", &["y"], 10, ChartAxis::Dates)
        .unwrap();
    assert_eq!(axis, XAxis::Time);
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][1]["v"], "1");
    assert_eq!(r.rows[1][1]["v"], "3");
    assert_eq!(note.as_deref(), Some("1 row with no date left out"));
    assert!(
        e.run_chart_query_axis_wire(&query, "when_seen", &["when_seen"], 10, ChartAxis::Dates)
            .is_err()
    );
}

#[test]
fn explicit_dates_accept_whole_years_and_declared_dates_and_refuse_ambiguous_values() {
    for x in [
        "2024::bigint",
        "'2024'",
        "date '2024-01-01'",
        "timestamp '2024-01-01 12:00:00'",
    ] {
        let f = Fixture::new(&format!("select {x} as x, 1 as y"));
        let e = f.engine();
        let table = e.list_tables().unwrap().remove(0);
        let (r, axis, _) = e
            .run_chart_query_axis_wire(
                &format!("select * from \"{table}\""),
                "x",
                &["y"],
                10,
                ChartAxis::Dates,
            )
            .unwrap();
        assert_eq!(axis, XAxis::Time);
        assert_eq!(r.rows.len(), 1);
    }
    for x in [
        "2024.5::double",
        "1704067200::bigint",
        "'03/04/2024'",
        "'garbage'",
        "true",
        "null::varchar",
    ] {
        let f = Fixture::new(&format!("select {x} as x, 1 as y"));
        let e = f.engine();
        let table = e.list_tables().unwrap().remove(0);
        assert!(
            matches!(
                e.run_chart_query_axis_wire(
                    &format!("select * from \"{table}\""),
                    "x",
                    &["y"],
                    10,
                    ChartAxis::Dates
                ),
                Err(Error::Invalid(_))
            ),
            "{x}"
        );
    }
}

#[test]
fn explicit_dates_refuse_mixed_offsets_and_never_hide_invalid_values_behind_the_point_cap() {
    let f = Fixture::new(
        "select * from (values ('2024-01-01T12:00:00+02:00', 1), ('2024-01-02T12:00:00+03:00', 2)) as t(x,y)",
    );
    let e = f.engine();
    let table = e.list_tables().unwrap().remove(0);
    assert!(matches!(
        e.run_chart_query_axis_wire(
            &format!("select * from \"{table}\""),
            "x",
            &["y"],
            1,
            ChartAxis::Dates
        ),
        Err(Error::Invalid(_))
    ));
    let f = Fixture::new(
        "select * from (values ('2024-01-01T12:00:00+02:00', 1), ('2024-01-02T12:00:00+02:00', 2)) as t(x,y)",
    );
    let e = f.engine();
    let table = e.list_tables().unwrap().remove(0);
    let (r, _, note) = e
        .run_chart_query_axis_wire(
            &format!("select * from \"{table}\""),
            "x",
            &["y"],
            1,
            ChartAxis::Dates,
        )
        .unwrap();
    assert!(r.truncated);
    assert_eq!(r.rows.len(), 1);
    assert!(note.unwrap().contains("UTC offset +02:00 not applied"));
}

#[test]
fn value_axis_orders_by_x_drops_rows_missing_either_value_and_counts_them() {
    let f = Fixture::new(
        "select * from (values (3.0, 30.0), (1.0, 10.0), (2.0, null), (null, 5.0), \
         (4.0, 40.0), (1.0, 9.0), ('NaN'::double, 7.0)) as t(sven, beta)",
    );
    let e = f.engine();
    let table = e.list_tables().unwrap().remove(0);
    let query = format!("select * from \"{table}\"");
    let (r, axis, note) = e
        .run_chart_query_axis_wire(&query, "sven", &["beta"], 10, ChartAxis::Values)
        .unwrap();
    assert_eq!(axis, XAxis::Value);
    assert_eq!(
        note.as_deref(),
        Some("3 rows with no x value or no number left out")
    );
    let xs: Vec<&str> = r
        .rows
        .iter()
        .map(|row| row[0]["v"].as_str().unwrap())
        .collect();
    let ys: Vec<&str> = r
        .rows
        .iter()
        .map(|row| row[1]["v"].as_str().unwrap())
        .collect();
    assert_eq!(xs, ["1", "1", "3", "4"]);
    // The tie at x = 1 is ordered by y, so the result is reproducible.
    assert_eq!(ys, ["9.0", "10.0", "30.0", "40.0"]);
}

#[test]
fn value_axis_refuses_text_x_the_series_itself_and_an_empty_result() {
    let f = Fixture::new("select * from (values ('a', 1.0), ('b', null)) as t(name, beta)");
    let e = f.engine();
    let table = e.list_tables().unwrap().remove(0);
    let query = format!("select * from \"{table}\"");
    let err = |x: &str, ys: &[&str]| {
        e.run_chart_query_axis_wire(&query, x, ys, 10, ChartAxis::Values)
            .unwrap_err()
            .to_string()
    };
    assert!(err("name", &["beta"]).contains("not numeric"));
    assert!(err("beta", &["beta"]).contains("cannot also be a plotted series"));
    let g = Fixture::new("select * from (values (1.0, null::double)) as t(sven, beta)");
    let e2 = g.engine();
    let table = e2.list_tables().unwrap().remove(0);
    let query = format!("select * from \"{table}\"");
    assert!(
        e2.run_chart_query_axis_wire(&query, "sven", &["beta"], 10, ChartAxis::Values)
            .unwrap_err()
            .to_string()
            .contains("No row has both")
    );
}
