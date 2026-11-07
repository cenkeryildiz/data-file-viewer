//! D3.5: the REAL `dfv-table --stdio` worker against the frozen TypeScript reference results
//! (`duckdb-query/tests/reference/d35-reference.json`, produced by `gen_reference.cjs` from
//! `src/duckdbConnection.ts`). Logical results, metadata and refusal classes are compared; cancellation,
//! deadline and close are then exercised over the same pipes.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_dfv-table");
const GOLDEN: &str = include_str!("../../duckdb-query/tests/reference/d35-reference.json");

struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    next: u64,
}
impl Worker {
    fn start() -> Self {
        let mut child = Command::new(BIN)
            .arg("--stdio")
            .env_remove("DFV_TABLE_TEST_DOC")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["kind"],
            "capabilities"
        );
        Self {
            child,
            input: Some(input),
            output,
            next: 0,
        }
    }
    fn send(&mut self, method: &str, args: Value, deadline_ms: Option<u64>) -> String {
        self.next += 1;
        let id = self.next.to_string();
        let mut frame = json!({"protocol":"dfv-table","version":1,"kind":"request","id":id,"method":method,"args":args});
        if let Some(ms) = deadline_ms {
            frame["deadline_ms"] = json!(ms.to_string());
        }
        self.write(&frame.to_string());
        id
    }
    fn write(&mut self, line: &str) {
        let input = self.input.as_mut().unwrap();
        writeln!(input, "{line}").unwrap();
        input.flush().unwrap();
    }
    fn reply(&mut self) -> Value {
        let mut line = String::new();
        assert!(
            self.output.read_line(&mut line).unwrap() > 0,
            "worker exited"
        );
        serde_json::from_str(&line).unwrap()
    }
    /// `Ok(result)` or `Err(error code)`.
    fn call(&mut self, method: &str, args: Value) -> Result<Value, String> {
        self.send(method, args, Some(60_000));
        let r = self.reply();
        if r["ok"] == true {
            Ok(r["result"].clone())
        } else {
            Err(r["error"]["code"].as_str().unwrap().to_owned())
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
fn timestamp_text(v: i64, unit: &str, tz: bool) -> String {
    let per_sec: i64 = match unit {
        "s" => 1,
        "ms" => 1_000,
        "us" => 1_000_000,
        _ => 1_000_000_000,
    };
    let (secs, frac) = (v.div_euclid(per_sec), v.rem_euclid(per_sec));
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    let mut text = format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        t / 3600,
        t % 3600 / 60,
        t % 60
    );
    if frac != 0 {
        let width = per_sec.ilog10() as usize;
        text += format!(".{frac:0width$}").trim_end_matches('0');
    }
    if tz {
        text += "+00";
    }
    text
}
/// A native wire cell in the reference's canonical text form. Floats keep their tag so they can be compared
/// numerically (JS prints 3.29406144173385e+29 where Rust prints every digit).
fn canon(v: &Value) -> (Value, bool) {
    match v {
        Value::Null | Value::Bool(_) | Value::String(_) => (v.clone(), false),
        Value::Object(o) => {
            let tag = o["$t"].as_str().unwrap();
            let text = o["v"].as_str().unwrap();
            match tag {
                "float32" | "float64" => (json!(text), true),
                "date" => {
                    let (y, m, d) = civil(text.parse().unwrap());
                    (json!(format!("{y:04}-{m:02}-{d:02}")), false)
                }
                "timestamp" => (
                    json!(timestamp_text(
                        text.parse().unwrap(),
                        o["unit"].as_str().unwrap(),
                        !o["tz"].is_null()
                    )),
                    false,
                ),
                "decimal" | "int8" | "int16" | "int32" | "int64" | "int128" | "uint8"
                | "uint16" | "uint32" | "uint64" | "uint128" => (json!(text), false),
                other => panic!("fixture produced an unexpected wire tag {other}"),
            }
        }
        other => panic!("not a wire cell: {other}"),
    }
}
fn same(native: &Value, reference: &Value) -> bool {
    let (n, float) = canon(native);
    if n == *reference {
        return true;
    }
    float
        && matches!((n.as_str().and_then(|s| s.parse::<f64>().ok()), reference.as_str().and_then(|s| s.parse::<f64>().ok())),
            (Some(a), Some(b)) if a == b)
}
fn assert_cells(name: &str, native: &[Value], reference: &[Value]) {
    assert_eq!(native.len(), reference.len(), "{name}: width");
    for (n, r) in native.iter().zip(reference) {
        assert!(same(n, r), "{name}: native {n} != reference {r}");
    }
}
/// Every page of a resource, concatenated.
fn all_rows(w: &mut Worker, first: &Value) -> (Vec<Value>, bool) {
    let mut rows = first["rows"].as_array().unwrap().clone();
    let (mut next, truncated) = (
        first["page"]["next_offset"].clone(),
        first["page"]["truncated"] == true,
    );
    while let Some(offset) = next.as_str().map(str::to_owned) {
        let page = w
            .call(
                "readResource",
                json!({"resource":first["resource"]["id"],"offset":offset,"page_size":1000}),
            )
            .unwrap();
        rows.extend(page["rows"].as_array().unwrap().iter().cloned());
        next = page["page"]["next_offset"].clone();
    }
    (rows, truncated)
}

fn arg_u(args: &Value, key: &str, cap: u64) -> u64 {
    match args[key].as_u64() {
        Some(n) if n > 0 => n.min(cap),
        _ => cap,
    }
}
/// Reference arguments -> native wire arguments.
fn native_args(session: &str, catalog: &str, method: &str, a: &Value) -> Value {
    let mut out = match method {
        "runQuery" => {
            json!({"sql":a["sql"],"max_rows":arg_u(a,"maxRows",100_000),"page_size":1000})
        }
        "runSortedQuery" => {
            json!({"sql":a["baseSql"],"column":a["column"],"direction":a["direction"],"max_rows":100_000,"page_size":1000})
        }
        "runChartQuery" => {
            json!({"sql":a["baseSql"],"x_column":a["xColumn"],"y_columns":a["yColumns"],"x_is_text":a["xIsText"],"x_is_category":a["xIsCategory"],"max_points":arg_u(a,"maxPoints",100_000),"page_size":1000})
        }
        "countMatchingRows" => json!({"sql":a["sql"]}),
        "getColumnTopValues" => json!({"sql":a["baseSql"],"column":a["column"],"limit":a["limit"]}),
        "getColumnDescriptiveStats" => {
            json!({"sql":a["baseSql"],"column":a["column"],"stats_kind":a["statsKind"]})
        }
        "getQueryCatalog" => json!({"offset":a["offset"].as_u64().unwrap().to_string()}),
        "getQueryColumns" => {
            json!({"catalog":if a["catalog"] == "CATALOG" { json!(catalog) } else { a["catalog"].clone() },"schema":a["schema"],"name":a["name"]})
        }
        other => panic!("{other}"),
    };
    out["session"] = json!(session);
    out
}
fn error_code(class: &str) -> &'static str {
    match class {
        "policy" => "policy_refused",
        "resource" => "resource_limit",
        "invalid" => "malformed_value",
        _ => "query_failed",
    }
}
/// Reference behaviours the native worker intentionally answers more strictly: it returns the typed
/// refusal where the reference's `countMatchingRows` swallows every failure into `undefined`.
fn documented_divergence(case: &Value) -> bool {
    case["method"] == "countMatchingRows" && case["expect"]["result"]["count"].is_null()
}

fn fixture(dir: &std::path::Path, golden: &Value) -> std::path::PathBuf {
    let path = dir.join("fixture.duckdb");
    let c = duckdb::Connection::open(&path).unwrap();
    for sql in golden["fixture_sql"].as_array().unwrap() {
        c.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    path
}
fn scratch(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dfv-d35-{tag}-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn production_worker_matches_the_frozen_reference_results_metadata_and_refusals() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let dir = scratch("ref");
    let path = fixture(&dir, &golden);
    let before = std::fs::read(&path).unwrap();
    let mut w = Worker::start();
    let opened = w.call("open", json!({"path":path})).unwrap();
    assert_eq!(opened["file_kind"], "duckdb");
    let session = opened["session"].as_str().unwrap().to_owned();
    let (mut compared, mut refused, mut diverged) = (0, 0, 0);
    for case in golden["cases"].as_array().unwrap() {
        let (name, method) = (
            case["name"].as_str().unwrap(),
            case["method"].as_str().unwrap(),
        );
        let answer = w.call(
            method,
            native_args(
                &session,
                golden["meta"]["catalog"].as_str().unwrap(),
                method,
                &case["args"],
            ),
        );
        let expect = &case["expect"];
        if documented_divergence(case) {
            // Never a wrong number: either null or a typed refusal.
            match &answer {
                Ok(r) => assert!(r["count"].is_null(), "{name}: {r}"),
                Err(code) => assert!(
                    matches!(
                        code.as_str(),
                        "policy_refused" | "query_failed" | "resource_limit"
                    ),
                    "{name}: {code}"
                ),
            }
            diverged += 1;
            continue;
        }
        if expect["kind"] == "error" {
            assert_eq!(
                answer.as_ref().err().map(String::as_str),
                Some(error_code(expect["error_class"].as_str().unwrap())),
                "{name}: expected a {} refusal, got {answer:?}",
                expect["error_class"]
            );
            refused += 1;
            continue;
        }
        let got = answer.unwrap_or_else(|code| panic!("{name}: native refused with {code}"));
        let want = &expect["result"];
        match method {
            "runQuery" | "runSortedQuery" | "runChartQuery" => {
                let page = if method == "runChartQuery" {
                    assert_eq!(got["x_axis_mode"], want["x_axis_mode"], "{name}");
                    &got["result"]
                } else {
                    &got
                };
                let cols = page["columns"].as_array().unwrap();
                assert_eq!(
                    cols.iter().map(|c| c["name"].clone()).collect::<Vec<_>>(),
                    *want["columns"].as_array().unwrap(),
                    "{name}: columns"
                );
                assert_eq!(
                    cols.iter()
                        .map(|c| c["stats_kind"].clone())
                        .collect::<Vec<_>>(),
                    *want["column_stats_kind"].as_array().unwrap(),
                    "{name}: stats kinds"
                );
                let (rows, truncated) = all_rows(&mut w, page);
                assert_eq!(truncated, want["truncated"], "{name}: truncated");
                let reference = want["rows"].as_array().unwrap();
                assert_eq!(rows.len(), reference.len(), "{name}: row count");
                for (n, r) in rows.iter().zip(reference) {
                    assert_cells(name, n.as_array().unwrap(), r.as_array().unwrap());
                }
                if method == "runSortedQuery" {
                    assert_eq!(page["sql"], want["sorted_sql"], "{name}: the sorted SQL");
                }
                assert_eq!(
                    w.call(
                        "releaseResource",
                        json!({"resource":page["resource"]["id"]})
                    )
                    .unwrap()["released"],
                    true
                );
            }
            "countMatchingRows" => assert_eq!(got["count"], want["count"], "{name}"),
            "getColumnTopValues" => {
                for k in [
                    "total_rows",
                    "non_null_rows",
                    "null_count",
                    "distinct_count",
                ] {
                    assert_eq!(got[k], want[k], "{name}: {k}");
                }
                let (n, r) = (
                    got["top_values"].as_array().unwrap(),
                    want["top_values"].as_array().unwrap(),
                );
                assert_eq!(n.len(), r.len(), "{name}");
                for (n, r) in n.iter().zip(r) {
                    assert!(
                        same(&n["value"], &r["value"]),
                        "{name}: {} != {}",
                        n["value"],
                        r["value"]
                    );
                    assert_eq!(n["frequency"], r["frequency"], "{name}");
                }
            }
            "getColumnDescriptiveStats" => {
                for k in ["total_rows", "non_null_rows", "null_count"] {
                    assert_eq!(got[k], want[k], "{name}: {k}");
                }
                for k in ["min", "max", "mean", "p5", "p95"] {
                    assert!(
                        same(&got[k], &want[k]),
                        "{name}: {k} native {} != reference {}",
                        got[k],
                        want[k]
                    );
                }
            }
            "getQueryCatalog" => {
                let n: Vec<Value> = got["relations"].as_array().unwrap().to_vec();
                assert_eq!(Value::Array(n), want.clone(), "{name}");
            }
            "getQueryColumns" => assert_eq!(got["columns"], *want, "{name}"),
            other => panic!("{other}"),
        }
        compared += 1;
    }
    assert!(
        compared >= 50 && refused >= 20,
        "compared {compared}, refused {refused}, diverged {diverged}"
    );
    println!(
        "D3.5 reference: {compared} results, {refused} refusals, {diverged} documented count divergences"
    );
    assert_eq!(
        w.call("close", json!({"session":session})).unwrap()["closed"],
        true
    );
    assert_eq!(std::fs::read(&path).unwrap(), before, "source bytes");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn production_worker_cancel_deadline_and_close_release_every_read_method() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let dir = scratch("life");
    let path = fixture(&dir, &golden);
    let before = std::fs::read(&path).unwrap();
    let mut w = Worker::start();
    let session = w.call("open", json!({"path":path})).unwrap()["session"]
        .as_str()
        .unwrap()
        .to_owned();
    let heavy = "select sum(a.range * b.range) as n from range(1000000) a, range(1000000) b";
    let methods = [
        ("runQuery", json!({"sql":heavy})),
        (
            "runSortedQuery",
            json!({"sql":heavy,"column":"n","direction":"asc"}),
        ),
        (
            "runChartQuery",
            json!({"sql":heavy,"x_column":"n","y_columns":["n"]}),
        ),
        ("countMatchingRows", json!({"sql":heavy})),
        ("getColumnTopValues", json!({"sql":heavy,"column":"n"})),
        (
            "getColumnDescriptiveStats",
            json!({"sql":heavy,"column":"n","stats_kind":"numeric"}),
        ),
    ];
    for (method, mut args) in methods {
        args["session"] = json!(session);
        // Deadline.
        let started = Instant::now();
        w.send(method, args.clone(), Some(300));
        let r = w.reply();
        assert_eq!(r["error"]["code"], "deadline_exceeded", "{method}: {r}");
        // Cancel frame while the query runs.
        let id = w.send(method, args, Some(60_000));
        std::thread::sleep(Duration::from_millis(300));
        w.write(&json!({"protocol":"dfv-table","version":1,"kind":"cancel","id":id}).to_string());
        let r = w.reply();
        assert_eq!(r["error"]["code"], "cancelled", "{method}: {r}");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{method}: {:?}",
            started.elapsed()
        );
        // The connection is still usable, and its answer is the only resource this round holds.
        let ok = w
            .call("runQuery", json!({"session":session,"sql":"select 1"}))
            .unwrap();
        assert_eq!(ok["rows"][0][0], json!({"$t":"int32","v":"1"}));
        assert_eq!(
            w.call("releaseResource", json!({"resource":ok["resource"]["id"]}))
                .unwrap()["released"],
            true,
            "{method}: a cancelled or expired read left a resource that shifted handle ownership"
        );
    }
    // A completed result is released by close, and a released handle never answers.
    let kept = w
        .call(
            "runSortedQuery",
            json!({"session":session,"sql":"select * from t","column":"id","direction":"asc"}),
        )
        .unwrap();
    let handle = kept["resource"]["id"].clone();
    let closed = w.call("close", json!({"session":session})).unwrap();
    assert_eq!(
        (closed["closed"].clone(), closed["released"].clone()),
        (json!(true), json!(1))
    );
    assert_eq!(
        w.call("readResource", json!({"resource":handle}))
            .unwrap_err(),
        "not_open"
    );
    assert_eq!(
        w.call(
            "countMatchingRows",
            json!({"session":session,"sql":"select 1"})
        )
        .unwrap_err(),
        "not_open"
    );
    drop(w.input.take());
    assert!(w.child.wait().unwrap().success());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        names,
        ["fixture.duckdb"],
        "no journals or stages: {names:?}"
    );
    std::fs::remove_dir_all(dir).unwrap();
}
