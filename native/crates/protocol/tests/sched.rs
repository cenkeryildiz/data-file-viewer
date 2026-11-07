//! The scheduled runtime in-process, with a scripted lane: failure paths the binary tests cannot reach.
use dfv_table_protocol::sched::serve_scheduled_with;
use dfv_table_protocol::{Capabilities, Control, ErrorBody, Lane, Limits, Route};
use serde_json::{Map, Value, json};
use std::io::{BufRead, BufReader, Cursor};

struct Scripted;
impl Lane for Scripted {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            name: "t",
            version: "0",
            methods: vec!["ok", "panic", "updateCell", "createBackup"],
            formats: vec![],
            value_tags: vec![],
            time_units: vec![],
        }
    }
    fn router(&self) -> fn(&str, &Map<String, Value>) -> Route {
        |_, _| Route {
            session: Some("s1".into()),
            closes: false,
        }
    }
    fn call(
        &mut self,
        method: &str,
        _: &Map<String, Value>,
        _: &Control,
    ) -> Result<Value, ErrorBody> {
        if method == "updateCell" {
            std::thread::sleep(std::time::Duration::from_millis(20));
            panic!("write interrupted after a possible publication");
        }
        if method == "panic" {
            panic!("engine bug: secret file contents");
        }
        Ok(json!({"n": 1}))
    }
}

#[test]
fn failed_lane_distinguishes_active_and_queued_mutation_outcomes() {
    let (status, frames) = run(
        || Scripted,
        &[req(1, "updateCell"), req(2, "createBackup"), req(3, "ok")],
    );
    assert_eq!(status, 1);
    let response = |id: &str| frames.iter().find(|f| f["id"] == id).unwrap();
    assert_eq!(response("1")["error"]["mutation_outcome"], "unknown");
    assert_eq!(response("2")["error"]["mutation_outcome"], "not-published");
    assert!(response("3")["error"]["mutation_outcome"].is_null());
}

#[test]
fn typed_mutation_errors_preserve_the_frozen_error_shape() {
    use dfv_table_protocol::errors::MUTATION_UNKNOWN;
    for outcome in ["not-published", "published", "unknown"] {
        let error = ErrorBody::new(MUTATION_UNKNOWN, "Look up the save before retrying.")
            .outcome(outcome)
            .to_value();
        assert_eq!(error["mutation_outcome"], outcome);
        assert_eq!(error.as_object().unwrap().len(), 5);
    }
    assert!(
        ErrorBody::new(MUTATION_UNKNOWN, "Read failed.").to_value()["mutation_outcome"].is_null()
    );
}

fn req(id: u32, method: &str) -> String {
    format!(
        r#"{{"protocol":"dfv-table","version":1,"kind":"request","id":"{id}","method":"{method}","args":{{}}}}"#
    )
}

fn run(lane: impl FnOnce() -> Scripted + Send + 'static, lines: &[String]) -> (i32, Vec<Value>) {
    let input = Cursor::new((lines.join("\n") + "\n").into_bytes());
    run_input(lane, BufReader::new(input))
}

fn run_input<L: Lane>(
    lane: impl FnOnce() -> L + Send + 'static,
    input: impl BufRead + Send + 'static,
) -> (i32, Vec<Value>) {
    let mut out = Vec::new();
    let status = serve_scheduled_with(lane, input, &mut out, 1 << 20, Limits::default()).unwrap();
    (
        status,
        BufReader::new(&out[..])
            .lines()
            .map(|l| serde_json::from_str(&l.unwrap()).unwrap())
            .collect(),
    )
}

#[test]
fn a_panicking_engine_fails_the_active_and_queued_requests_once_each_and_exits_nonzero() {
    use std::io::{self, Read};
    use std::sync::mpsc;
    use std::time::Duration;
    struct EndSignal {
        input: Cursor<Vec<u8>>,
        sent: Option<mpsc::Sender<()>>,
    }
    impl Read for EndSignal {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            let n = self.input.read(bytes)?;
            if n == 0
                && let Some(sent) = self.sent.take()
            {
                sent.send(()).unwrap();
            }
            Ok(n)
        }
    }
    struct QueuedPanic(mpsc::Receiver<()>);
    impl Lane for QueuedPanic {
        fn capabilities(&self) -> Capabilities {
            Scripted.capabilities()
        }
        fn router(&self) -> fn(&str, &Map<String, Value>) -> Route {
            Scripted.router()
        }
        fn call(
            &mut self,
            m: &str,
            a: &Map<String, Value>,
            c: &Control,
        ) -> Result<Value, ErrorBody> {
            // EOF is read only after every frame was sent to the bounded coordinator queue.
            // Waiting here makes the queued-failure assertion independent of thread scheduling.
            self.0.recv_timeout(Duration::from_secs(3)).unwrap();
            Scripted.call(m, a, c)
        }
    }
    let (sent, received) = mpsc::channel();
    let bytes = [req(1, "panic"), req(2, "ok"), req(3, "ok")].join("\n") + "\n";
    let input = BufReader::new(EndSignal {
        input: Cursor::new(bytes.into_bytes()),
        sent: Some(sent),
    });
    let (status, frames) = run_input(move || QueuedPanic(received), input);
    assert_eq!(status, 1);
    let replies: Vec<(&str, &str)> = frames[1..]
        .iter()
        .map(|f| {
            (
                f["id"].as_str().unwrap(),
                f["error"]["code"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        replies,
        [
            ("1", "worker_failed"),
            ("2", "worker_failed"),
            ("3", "worker_failed")
        ]
    );
    assert!(
        !frames.iter().any(|f| f.to_string().contains("secret")),
        "a panic payload never reaches the host"
    );
}

#[test]
fn an_engine_that_cannot_start_exits_nonzero_without_a_handshake() {
    let (status, frames) = run(|| panic!("no engine"), &[]);
    assert_eq!((status, frames.len()), (1, 0));
}

#[test]
fn replies_follow_the_queue_and_the_input_ending_drains_it() {
    let (status, frames) = run(
        || Scripted,
        &[req(1, "ok"), req(2, "ok"), req(3, "nope"), req(4, "ok")],
    );
    assert_eq!(status, 0);
    assert_eq!(frames[0]["kind"], "capabilities");
    assert_eq!(frames[0]["limits"]["queued_requests"], "8");
    let mut ids: Vec<&str> = frames[1..]
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    ids.sort_unstable();
    assert_eq!(ids, ["1", "2", "3", "4"], "exactly one reply per request");
    let unknown = frames.iter().find(|f| f["id"] == "3").unwrap();
    assert_eq!(unknown["error"]["code"], "unknown_method");
}
