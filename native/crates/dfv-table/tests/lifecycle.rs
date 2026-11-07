//! D3.3 over the real binary and real pipes, with the test-only document engine
//! (`--features test-doc`, `DFV_TABLE_TEST_DOC=1`): sessions, owned handles, queues, deadlines,
//! cancellation, close and worker death. The engine reads files byte-for-byte; no table format.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_dfv-table");
const WAIT: Duration = Duration::from_secs(10);

struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: Receiver<Value>,
    n: u64,
}

impl Worker {
    fn start() -> Self {
        let mut child = Command::new(BIN)
            .arg("--stdio")
            .env("DFV_TABLE_TEST_DOC", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                    return;
                }
            }
        });
        let stdin = child.stdin.take();
        let mut w = Self {
            child,
            stdin,
            replies,
            n: 0,
        };
        let caps = w.next();
        assert_eq!(caps["kind"], "capabilities");
        assert_eq!(
            caps["formats"],
            json!([]),
            "the test engine claims no format"
        );
        w
    }

    fn raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    /// Sends a request and returns its id.
    fn send(&mut self, method: &str, args: Value) -> String {
        self.send_with(method, args, None)
    }
    fn send_with(&mut self, method: &str, args: Value, deadline_ms: Option<&str>) -> String {
        self.n += 1;
        let id = self.n.to_string();
        let mut m = json!({"protocol":"dfv-table","version":1,"kind":"request","id":id,"method":method,"args":args});
        if let Some(d) = deadline_ms {
            m["deadline_ms"] = json!(d);
        }
        self.raw(&m.to_string());
        id
    }
    fn cancel(&mut self, id: &str) {
        self.raw(&json!({"protocol":"dfv-table","version":1,"kind":"cancel","id":id}).to_string());
    }
    fn next(&mut self) -> Value {
        self.replies.recv_timeout(WAIT).expect("a reply")
    }
    fn silent_for(&mut self, d: Duration) {
        match self.replies.recv_timeout(d) {
            Err(RecvTimeoutError::Timeout) => {}
            other => panic!("unexpected frame {other:?}"),
        }
    }
    fn call(&mut self, method: &str, args: Value) -> Value {
        let id = self.send(method, args);
        let r = self.next();
        assert_eq!(r["id"], id, "{r}");
        r
    }
    fn ok(&mut self, method: &str, args: Value) -> Value {
        let r = self.call(method, args);
        assert_eq!(r["ok"], true, "{r}");
        r["result"].clone()
    }
    fn code(&mut self, method: &str, args: Value) -> String {
        let r = self.call(method, args);
        assert_eq!(r["ok"], false, "{r}");
        r["error"]["code"].as_str().unwrap().to_owned()
    }
    fn finish(mut self) -> (std::process::ExitStatus, String) {
        drop(self.stdin.take());
        let status = self.child.wait().unwrap();
        let mut err = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut err)
            .unwrap();
        (status, err)
    }
}

fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("dfv-table-lifecycle-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn source(d: &Path, name: &str, body: &[u8]) -> String {
    let p = d.join(name);
    std::fs::write(&p, body).unwrap();
    p.to_str().unwrap().to_owned()
}
fn open(w: &mut Worker, path: &str) -> String {
    w.ok("testOpen", json!({"path": path}))["session"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn handles_are_owned_released_once_and_stale_after_the_source_changes() {
    let d = dir("handles");
    let path = source(&d, "a.bin", b"0123456789");
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    assert_eq!(w.code("testOpen", json!({"path": path})), "already_open");
    let read = w.ok("testRead", json!({"session": s}));
    let h = read["resource"].as_str().unwrap().to_owned();
    assert_eq!(
        w.ok("testPage", json!({"resource": h, "offset": 2, "len": 3}))["hex"],
        "323334"
    );
    // the source changes: the handle read from revision 1 is refused, never mixed with revision 2
    std::fs::write(&path, b"abcdefghijk").unwrap();
    assert_eq!(
        w.ok("testRefresh", json!({"session": s})),
        json!({"revision": 2, "changed": true})
    );
    assert_eq!(w.code("testPage", json!({"resource": h})), "stale_source");
    assert_eq!(
        w.code("testRead", json!({"session": s, "expected_revision": 1})),
        "stale_source"
    );
    let fresh = w.ok("testRead", json!({"session": s, "expected_revision": 2}))["resource"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.ok("testPage", json!({"resource": fresh, "len": 2}))["hex"],
        "6162"
    );
    // releasing is defined twice over, and a released handle fails as unknown, not as stale
    assert_eq!(
        w.ok("testRelease", json!({"resource": h}))["released"],
        true
    );
    assert_eq!(
        w.ok("testRelease", json!({"resource": h}))["released"],
        false
    );
    assert_eq!(w.code("testPage", json!({"resource": h})), "not_open");
    assert_eq!(w.code("testPage", json!({"resource": "r9_9"})), "not_open");
    // closing releases the session's handles; closing again and using the dead session are defined
    assert_eq!(
        w.ok("testClose", json!({"session": s})),
        json!({"closed": true, "released": 1})
    );
    assert_eq!(
        w.ok("testClose", json!({"session": s})),
        json!({"closed": false, "released": 0})
    );
    assert_eq!(w.code("testRead", json!({"session": s})), "not_open");
    assert_eq!(w.code("testPage", json!({"resource": fresh})), "not_open");
    assert_eq!(
        w.ok("testStatus", json!({})),
        json!({"sessions": 0, "resources": 0, "held_bytes": 0})
    );
    let (status, err) = w.finish();
    assert!(
        status.success() && err.lines().all(|l| l.starts_with("table_worker:")),
        "{err}"
    );
}

#[test]
fn queued_requests_are_served_in_order_and_a_full_queue_is_refused_retryably() {
    let d = dir("queue");
    let path = source(&d, "a.bin", b"x");
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    let first = w.send("testRead", json!({"session": s, "hold_ms": 400}));
    let queued: Vec<String> = (0..8)
        .map(|_| w.send("testRead", json!({"session": s})))
        .collect();
    let refused = w.send("testRead", json!({"session": s}));
    let r = w.next();
    assert_eq!(
        (
            r["id"].as_str(),
            r["error"]["code"].as_str(),
            r["error"]["retryable"].as_bool()
        ),
        (Some(refused.as_str()), Some("queue_full"), Some(true))
    );
    let order: Vec<String> = (0..9)
        .map(|_| w.next())
        .map(|r| {
            assert_eq!(r["ok"], true, "{r}");
            r["id"].as_str().unwrap().to_owned()
        })
        .collect();
    assert_eq!(
        order,
        std::iter::once(first).chain(queued).collect::<Vec<_>>()
    );
}

#[test]
fn sessions_are_served_round_robin_so_one_busy_session_cannot_starve_another() {
    let d = dir("fair");
    let (pa, pb) = (source(&d, "a.bin", b"a"), source(&d, "b.bin", b"b"));
    let mut w = Worker::start();
    let (a, b) = (open(&mut w, &pa), open(&mut w, &pb));
    let a1 = w.send("testRead", json!({"session": a, "hold_ms": 150}));
    let a2 = w.send("testRead", json!({"session": a}));
    let a3 = w.send("testRead", json!({"session": a}));
    let b1 = w.send("testRead", json!({"session": b}));
    let order: Vec<String> = (0..4)
        .map(|_| w.next()["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(order, [a1, a2, b1, a3]);
}

#[test]
fn a_queued_request_cancels_at_once_and_the_active_one_is_untouched() {
    let d = dir("qcancel");
    let path = source(&d, "a.bin", b"x");
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    let active = w.send("testRead", json!({"session": s, "hold_ms": 300}));
    let queued = w.send("testRead", json!({"session": s}));
    w.cancel(&queued);
    let r = w.next();
    assert_eq!(
        (r["id"].as_str(), r["error"]["code"].as_str()),
        (Some(queued.as_str()), Some("cancelled"))
    );
    let r = w.next();
    assert_eq!(
        (r["id"].as_str(), r["ok"].as_bool()),
        (Some(active.as_str()), Some(true))
    );
    w.silent_for(Duration::from_millis(100));
    assert_eq!(
        w.ok("testStatus", json!({}))["resources"],
        1,
        "the cancelled read created nothing"
    );
}

#[test]
fn an_active_cancel_answers_at_once_frees_the_lane_and_leaves_no_handle() {
    let d = dir("acancel");
    let path = source(&d, "a.bin", b"x");
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    let long = w.send("testRead", json!({"session": s, "hold_ms": 20000}));
    std::thread::sleep(Duration::from_millis(80));
    let t = Instant::now();
    w.cancel(&long);
    let r = w.next();
    assert_eq!(
        (r["id"].as_str(), r["error"]["code"].as_str()),
        (Some(long.as_str()), Some("cancelled"))
    );
    assert!(t.elapsed() < Duration::from_secs(2));
    // the engine saw the flag and returned; its late result is dropped, and the next request runs
    let status = w.ok("testStatus", json!({}));
    assert_eq!(status["resources"], 0, "{status}");
    assert!(
        t.elapsed() < Duration::from_secs(5),
        "the lane was freed, not left for 20 s"
    );
    w.silent_for(Duration::from_millis(100));
}

#[test]
fn cancel_races_are_harmless_late_unknown_and_repeated_cancels_get_no_reply() {
    let d = dir("race");
    let path = source(&d, "a.bin", b"x");
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    let done = w.send("testRead", json!({"session": s}));
    assert_eq!(w.next()["id"], done);
    w.cancel(&done);
    w.cancel("999999");
    let slow = w.send("testRead", json!({"session": s, "hold_ms": 5000}));
    std::thread::sleep(Duration::from_millis(50));
    w.cancel(&slow);
    w.cancel(&slow);
    let r = w.next();
    assert_eq!(
        (r["id"].as_str(), r["error"]["code"].as_str()),
        (Some(slow.as_str()), Some("cancelled"))
    );
    // exactly one reply per request: the next frame is the next request's
    let ping = w.send("ping", json!({}));
    let r = w.next();
    assert_eq!(
        (r["id"].as_str(), r["ok"].as_bool()),
        (Some(ping.as_str()), Some(true))
    );
    w.silent_for(Duration::from_millis(100));
}

#[test]
fn deadlines_stop_active_reads_and_expire_queued_ones_without_running_them() {
    let d = dir("deadline");
    let path = source(&d, "a.bin", b"x");
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    let slow = w.send_with(
        "testRead",
        json!({"session": s, "hold_ms": 20000}),
        Some("300"),
    );
    let waiting = w.send_with("testRead", json!({"session": s}), Some("100"));
    let (mut got, t) = (Vec::new(), Instant::now());
    for _ in 0..2 {
        let r = w.next();
        assert_eq!(r["ok"], false, "{r}");
        got.push((
            r["id"].as_str().unwrap().to_owned(),
            r["error"]["code"].as_str().unwrap().to_owned(),
            r["error"]["retryable"].as_bool().unwrap(),
        ));
    }
    assert!(t.elapsed() < Duration::from_secs(2));
    // the queued request expires first (100 ms) while the active one still runs (300 ms)
    assert_eq!(
        got,
        [
            (waiting, "deadline_exceeded".into(), true),
            (slow, "deadline_exceeded".into(), true)
        ]
    );
    // deadline 0 never reaches the engine
    assert_eq!(w.call("testRead", json!({"session": s}))["ok"], true);
    let zero = w.send_with("testRead", json!({"session": s}), Some("0"));
    let r = w.next();
    assert_eq!(
        (r["id"].as_str(), r["error"]["code"].as_str()),
        (Some(zero.as_str()), Some("deadline_exceeded"))
    );
    assert_eq!(
        w.ok("testStatus", json!({}))["resources"],
        1,
        "only the one successful read created a handle"
    );
}

#[test]
fn close_settles_the_active_and_queued_requests_then_releases_everything() {
    let d = dir("close");
    let (pa, pb) = (source(&d, "a.bin", b"aaaa"), source(&d, "b.bin", b"bb"));
    let mut w = Worker::start();
    let (a, b) = (open(&mut w, &pa), open(&mut w, &pb));
    let kept = w.ok("testRead", json!({"session": a}))["resource"]
        .as_str()
        .unwrap()
        .to_owned();
    let other = w.ok("testRead", json!({"session": b}))["resource"]
        .as_str()
        .unwrap()
        .to_owned();
    let active = w.send("testRead", json!({"session": a, "hold_ms": 20000}));
    let q1 = w.send("testRead", json!({"session": a}));
    let q2 = w.send("testPage", json!({"resource": kept}));
    let unrelated = w.send("testRead", json!({"session": b}));
    std::thread::sleep(Duration::from_millis(80));
    let close = w.send("testClose", json!({"session": a}));
    let mut by_id = std::collections::HashMap::new();
    for _ in 0..5 {
        let r = w.next();
        by_id.insert(r["id"].as_str().unwrap().to_owned(), r);
    }
    for id in [&active, &q1, &q2] {
        assert_eq!(by_id[id]["error"]["code"], "cancelled", "{}", by_id[id]);
    }
    assert_eq!(
        by_id[&unrelated]["ok"], true,
        "another session is not affected"
    );
    assert_eq!(
        by_id[&close]["result"],
        json!({"closed": true, "released": 1})
    );
    // the closed session is gone for good; the other one still works
    assert_eq!(w.code("testRead", json!({"session": a})), "not_open");
    assert_eq!(w.code("testPage", json!({"resource": kept})), "not_open");
    assert_eq!(
        w.ok("testPage", json!({"resource": other, "len": 2}))["hex"],
        "6262"
    );
    let status = w.ok("testStatus", json!({}));
    assert_eq!(
        (status["sessions"].clone(), status["resources"].clone()),
        (json!(1), json!(2)),
        "{status}"
    );
}

#[test]
fn ending_input_settles_accepted_requests_before_a_clean_exit() {
    let d = dir("eof");
    let path = source(&d, "a.bin", b"x");
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    let ids: Vec<String> = (0..3)
        .map(|i| {
            w.send(
                "testRead",
                json!({"session": s, "hold_ms": if i == 0 { 150 } else { 0 }}),
            )
        })
        .collect();
    drop(w.stdin.take());
    let got: Vec<String> = ids
        .iter()
        .map(|_| w.next()["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(got, ids);
    let status = w.child.wait().unwrap();
    assert!(status.success());
}

#[test]
fn a_duplicate_in_flight_id_and_bad_arguments_are_typed() {
    let d = dir("typed");
    let path = source(&d, "a.bin", b"x");
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    let busy = w.send("testRead", json!({"session": s, "hold_ms": 200}));
    w.raw(&json!({"protocol":"dfv-table","version":1,"kind":"request","id":busy,"method":"testStatus","args":{}}).to_string());
    let r = w.next();
    assert_eq!(
        (r["id"].as_str(), r["error"]["code"].as_str()),
        (Some(busy.as_str()), Some("malformed_request"))
    );
    assert_eq!(w.next()["id"], busy);
    assert_eq!(w.code("testRead", json!({"session": 7})), "malformed_value");
    assert_eq!(w.code("testRead", json!({})), "malformed_value");
    assert_eq!(w.code("notAMethod", json!({})), "unknown_method");
}

#[test]
fn killing_the_worker_mid_read_leaves_a_read_only_source_byte_and_time_identical() {
    use std::os::unix::fs::PermissionsExt;
    let d = dir("kill");
    let path = source(&d, "a.bin", b"precious bytes");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
    let before = (
        std::fs::read(&path).unwrap(),
        std::fs::metadata(&path).unwrap().modified().unwrap(),
    );
    let mut w = Worker::start();
    let s = open(&mut w, &path);
    w.send("testRead", json!({"session": s, "hold_ms": 20000}));
    std::thread::sleep(Duration::from_millis(80));
    w.child.kill().unwrap(); // SIGKILL
    assert!(!w.child.wait().unwrap().success());
    assert_eq!(
        (
            std::fs::read(&path).unwrap(),
            std::fs::metadata(&path).unwrap().modified().unwrap()
        ),
        before
    );
    let leftovers: Vec<_> = std::fs::read_dir(&d)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        leftovers.len(),
        1,
        "no staging or temp file beside the source: {leftovers:?}"
    );
    // a new worker opens the same source at revision 1: no state survived, none was needed
    let mut again = Worker::start();
    let r = again.ok("testOpen", json!({"path": path}));
    assert_eq!(
        (r["session"].as_str(), r["revision"].as_u64()),
        (Some("s1"), Some(1))
    );
}
