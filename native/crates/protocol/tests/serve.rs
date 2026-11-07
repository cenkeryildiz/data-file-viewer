//! D3.2 framing/validation: every malformed input fails deterministically and the loop survives.
use dfv_table_protocol::{
    Capabilities, Engine, ErrorBody, MAX_FRAME_BYTES, errors::CODES, serve, serve_with,
};
use serde_json::{Map, Value, json};
use std::io::BufReader;

struct Echo;
impl Engine for Echo {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            name: "test",
            version: "0",
            methods: vec!["ping", "big"],
            formats: vec![],
            value_tags: vec![],
            time_units: vec![],
        }
    }
    fn call(&mut self, method: &str, _: &Map<String, Value>) -> Result<Value, ErrorBody> {
        Ok(if method == "big" {
            json!({"s": "x".repeat(1000)})
        } else {
            json!({})
        })
    }
}

/// Runs `input` through the loop with a reader that buffers at most `cap` bytes at a time.
fn run_with(input: &[u8], cap: usize, max: usize) -> (i32, Vec<Value>) {
    let mut out = Vec::new();
    let status = serve_with(Echo, BufReader::with_capacity(cap, input), &mut out, max).unwrap();
    let frames = out
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap())
        .collect();
    (status, frames)
}
fn run(input: &[u8]) -> Vec<Value> {
    run_with(input, 1 << 16, MAX_FRAME_BYTES).1
}
fn req(id: &str, method: &str) -> String {
    format!(
        r#"{{"protocol":"dfv-table","version":1,"kind":"request","id":"{id}","method":"{method}","args":{{}}}}"#
    ) + "\n"
}
fn code(f: &Value) -> &str {
    assert_eq!(f["ok"], false, "{f}");
    f["error"]["code"].as_str().unwrap()
}

#[test]
fn capabilities_come_first_and_claim_no_formats() {
    let f = run(b"");
    assert_eq!(f.len(), 1);
    let c = &f[0];
    assert_eq!(
        (
            c["kind"].as_str(),
            c["protocol"].as_str(),
            c["version"].as_u64()
        ),
        (Some("capabilities"), Some("dfv-table"), Some(1))
    );
    assert_eq!(c["methods"], json!(["ping", "big"]));
    assert_eq!(c["formats"], json!([]));
    assert_eq!(c["limits"]["max_frame_bytes"], "33554432");
}

#[test]
fn empty_method_list_is_refused_at_start() {
    struct NoMethods;
    impl Engine for NoMethods {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                name: "t",
                version: "0",
                methods: vec![],
                formats: vec![],
                value_tags: vec![],
                time_units: vec![],
            }
        }
        fn call(&mut self, _: &str, _: &Map<String, Value>) -> Result<Value, ErrorBody> {
            unreachable!()
        }
    }
    assert!(serve(NoMethods, &b""[..], Vec::new()).is_err());
}

#[test]
fn replies_are_in_order_for_concatenated_and_crlf_frames() {
    let input = format!(
        "{}{}\r\n\n  \n{}",
        req("1", "ping"),
        req("2", "nope").trim_end(),
        req("3", "ping")
    );
    let f = run(input.as_bytes());
    assert_eq!(
        f.iter()
            .skip(1)
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["1", "2", "3"]
    );
    assert_eq!(f[1]["ok"], true);
    assert_eq!(code(&f[2]), "unknown_method");
}

#[test]
fn output_is_identical_for_every_byte_split() {
    let input = format!("{}{}{}", req("1", "ping"), "not json\n", req("2", "big")).into_bytes();
    let whole = run_with(&input, 1 << 16, MAX_FRAME_BYTES);
    for cap in [1, 2, 3, 7, 64] {
        assert_eq!(run_with(&input, cap, MAX_FRAME_BYTES), whole, "cap {cap}");
    }
}

#[test]
fn truncated_final_frame_is_reported_and_ends_the_stream() {
    let input = format!("{}{}", req("1", "ping"), &req("2", "ping")[..30]);
    let (status, f) = run_with(input.as_bytes(), 1 << 16, MAX_FRAME_BYTES);
    assert_eq!(status, 0);
    assert_eq!(f.len(), 3);
    assert_eq!(
        (code(&f[2]), f[2]["id"].as_str()),
        ("malformed_request", Some("0"))
    );
}

#[test]
fn invalid_utf8_json_and_non_objects_are_refused_and_serving_continues() {
    let mut input = b"{\"id\":\"\xff\"}\n".to_vec();
    for bad in ["{", "[]", "null", "42", "\"s\"", "{}"] {
        input.extend(format!("{bad}\n").bytes());
    }
    input.extend(req("5", "ping").bytes());
    let f = run(&input);
    assert_eq!(f.len(), 1 + 7 + 1);
    for r in &f[1..8] {
        assert_eq!(
            (code(r), r["id"].as_str()),
            ("malformed_request", Some("0"))
        );
    }
    assert_eq!(f[8]["ok"], true);
}

#[test]
fn oversized_lines_are_skipped_without_being_held() {
    let long = "a".repeat(700);
    let input = format!("{long}\n{}{long}", req("1", "ping"));
    let (_, f) = run_with(input.as_bytes(), 8, 600);
    assert_eq!(
        f.iter().map(|r| r["ok"].as_bool()).collect::<Vec<_>>(),
        [None, Some(false), Some(true), Some(false)]
    );
    assert_eq!(code(&f[1]), "malformed_request");
    assert_eq!(code(&f[3]), "malformed_request");
}

#[test]
fn a_line_over_the_real_limit_is_refused() {
    let mut input = vec![b'a'; MAX_FRAME_BYTES + 1];
    input.push(b'\n');
    input.extend(req("9", "ping").bytes());
    let f = run(&input);
    assert_eq!(
        (code(&f[1]), f[1]["id"].as_str()),
        ("malformed_request", Some("0"))
    );
    assert_eq!(f[2]["id"], "9");
}

#[test]
fn a_frame_of_exactly_the_limit_is_accepted() {
    let line = req("4", "ping");
    let (_, f) = run_with(line.as_bytes(), 1 << 16, line.trim_end().len());
    assert_eq!(f[1]["ok"], true);
}

#[test]
fn oversized_replies_become_resource_limit_for_the_same_id() {
    let (_, f) = run_with(req("7", "big").as_bytes(), 1 << 16, 800);
    assert_eq!(
        (code(&f[1]), f[1]["id"].as_str()),
        ("resource_limit", Some("7"))
    );
}

#[test]
fn envelope_violations_are_typed_and_addressed_when_the_id_is_usable() {
    let ok = r#""protocol":"dfv-table","version":1,"kind":"request""#;
    let cases: &[(String, &str, &str)] = &[
        (r#"{"protocol":"other","version":1,"kind":"request","id":"3","method":"ping","args":{}}"#.into(), "malformed_request", "3"),
        (r#"{"protocol":"dfv-table","version":2,"kind":"request","id":"3","method":"ping","args":{}}"#.into(), "unsupported", "3"),
        (r#"{"protocol":"dfv-table","version":2,"kind":"request","id":3,"extra":1}"#.into(), "unsupported", "0"),
        (r#"{"protocol":"dfv-table","version":"1","kind":"request","id":"3","method":"ping","args":{}}"#.into(), "malformed_request", "3"),
        (r#"{"protocol":"dfv-table","version":1.0,"kind":"request","id":"3","method":"ping","args":{}}"#.into(), "malformed_request", "3"),
        (format!(r#"{{{ok},"id":"3","method":"ping","args":{{}},"extra":1}}"#), "malformed_request", "3"),
        (format!(r#"{{{ok},"id":"3","method":"ping"}}"#), "malformed_request", "3"),
        (format!(r#"{{{ok},"id":"3","method":"ping","args":[]}}"#), "malformed_request", "3"),
        (format!(r#"{{{ok},"id":"3","method":"Ping","args":{{}}}}"#), "malformed_request", "3"),
        (format!(r#"{{{ok},"id":"3","method":"pi-ng","args":{{}}}}"#), "malformed_request", "3"),
        (format!(r#"{{{ok},"id":"3","method":"","args":{{}}}}"#), "malformed_request", "3"),
        (format!(r#"{{{ok},"id":"3","method":"ping","args":{{}},"deadline_ms":30}}"#), "malformed_request", "3"),
        (format!(r#"{{{ok},"id":"3","method":"ping","args":{{}},"deadline_ms":"030"}}"#), "malformed_request", "3"),
        (r#"{"protocol":"dfv-table","version":1,"kind":"response","id":"3","ok":true,"result":{}}"#.into(), "malformed_request", "3"),
        (r#"{"protocol":"dfv-table","version":1,"id":"3"}"#.into(), "malformed_request", "3"),
        (r#"{"protocol":"dfv-table","version":1,"kind":"cancel","id":"3","method":"ping"}"#.into(), "malformed_request", "3"),
    ];
    for (frame, want, id) in cases {
        let f = run(format!("{frame}\n").as_bytes());
        assert_eq!(
            (code(&f[1]), f[1]["id"].as_str().unwrap()),
            (*want, *id),
            "{frame}"
        );
    }
}

#[test]
fn ids_must_be_canonical_uint64_text() {
    for id in [
        r#""01""#,
        r#""abc""#,
        r#""""#,
        r#""-1""#,
        r#""18446744073709551616""#,
        r#""000000000000000000001""#,
        "7",
        "null",
    ] {
        let f = run(format!(r#"{{"protocol":"dfv-table","version":1,"kind":"request","id":{id},"method":"ping","args":{{}}}}"#).as_bytes().iter().chain(b"\n").copied().collect::<Vec<_>>().as_slice());
        assert_eq!(
            (code(&f[1]), f[1]["id"].as_str()),
            ("malformed_request", Some("0")),
            "{id}"
        );
    }
    let f = run(req("18446744073709551615", "ping").as_bytes());
    assert_eq!(f[1]["ok"], true);
}

#[test]
fn unknown_methods_are_refused_and_listed_ones_answered() {
    let f = run(format!(
        "{}{}{}",
        req("1", "listTables"),
        req("2", "runQuery"),
        req("3", "big")
    )
    .as_bytes());
    assert_eq!(code(&f[1]), "unknown_method");
    assert_eq!(code(&f[2]), "unknown_method");
    assert_eq!(f[3]["ok"], true);
}

#[test]
fn cancel_gets_no_reply() {
    let cancel = r#"{"protocol":"dfv-table","version":1,"kind":"cancel","id":"1"}"#;
    let f = run(format!("{cancel}\n{}", req("2", "ping")).as_bytes());
    assert_eq!(f.len(), 2);
    assert_eq!(f[1]["id"], "2");
}

#[test]
fn error_codes_match_the_draft_schema_enum() {
    let schema = [
        "malformed_request",
        "malformed_value",
        "unknown_method",
        "not_open",
        "already_open",
        "policy_refused",
        "read_only",
        "stale_source",
        "queue_full",
        "runtime_busy",
        "cancelled",
        "deadline_exceeded",
        "worker_failed",
        "query_failed",
        "resource_limit",
        "ambiguous_row",
        "no_matching_row",
        "table_changed",
        "mutation_not_published",
        "mutation_unknown",
        "unsupported",
    ];
    let categories = [
        "blocked",
        "cancelled",
        "column",
        "conversion",
        "resource",
        "syntax",
        "type",
        "unknown",
    ];
    assert_eq!(CODES.iter().map(|c| c.0).collect::<Vec<_>>(), schema);
    assert!(CODES.iter().all(|c| categories.contains(&c.1)));
}
