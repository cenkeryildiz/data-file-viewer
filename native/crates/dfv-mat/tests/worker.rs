use dfv_mat::Worker;
use dfv_table_protocol::{Control, Lane};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
};
fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mat/tests/fixtures/native_v7.mat")
}
fn call(w: &mut Worker, m: &str, a: Value) -> Value {
    w.call(m, a.as_object().unwrap(), &Control::unbounded())
        .unwrap()
}
fn setup(w: &mut Worker) -> (Value, Value) {
    let s = call(w, "open", json!({"path":fixture()}));
    let mut a = s.clone();
    a.as_object_mut()
        .unwrap()
        .retain(|k, _| ["session", "generation"].contains(&k.as_str()));
    let mut c = a.clone();
    c["offset"] = json!("0");
    c["limit"] = json!("1000");
    let cat = call(w, "catalog", c);
    (a, cat)
}
fn handle(cat: &Value, name: &str) -> Value {
    cat["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["info"]["name"] == name)
        .unwrap()["handle"]
        .clone()
}
#[test]
fn genuine_oracle_exact_dense_nd_complex_char_and_sparse() {
    let before = std::fs::read(fixture()).unwrap();
    let mut w = Worker::default();
    let (a, cat) = setup(&mut w);
    let oracle: Value =
        serde_json::from_slice(&std::fs::read(fixture().with_extension("oracle.json")).unwrap())
            .unwrap();
    for name in ["matrix", "row", "column", "unsigned", "signed", "tensor"] {
        let mut q = a.clone();
        q["handle"] = handle(&cat, name);
        let dims = oracle[name]["size"].as_array().unwrap();
        q["start"] = json!(vec!["1"; dims.len()]);
        q["count"] = json!(
            dims.iter()
                .map(|d| d.as_u64().unwrap().to_string())
                .collect::<Vec<_>>()
        );
        let v = call(&mut w, "slice", q);
        let values = v["data"]["re"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["v"].clone())
            .collect::<Vec<_>>();
        assert_eq!(json!(values), oracle[name]["dec"], "{name}");
    }
    for (name, count) in [
        ("special", json!(["1", "5"])),
        ("complex_values", json!(["1", "2"])),
        ("text", json!(["1", "6"])),
    ] {
        let mut q = a.clone();
        q["handle"] = handle(&cat, name);
        q["start"] = json!(["1", "1"]);
        q["count"] = count;
        let v = call(&mut w, "slice", q);
        match name {
            "special" => assert_eq!(v["data"]["re"][1]["v"], "-0"),
            "complex_values" => assert_eq!(v["data"]["im"][1]["v"], "-4"),
            _ => assert_eq!(v["data"]["rows"][0], " İ ş😀 ".replace("İ ş", "İş")),
        }
    }
    let mut q = a.clone();
    q["handle"] = handle(&cat, "sparse_values");
    q["start"] = json!(["1", "1"]);
    q["count"] = json!(["1000000", "1000000"]);
    q["offset"] = json!("0");
    q["limit"] = json!("10");
    let v = call(&mut w, "sparse", q.clone());
    assert_eq!(v["entries"].as_array().unwrap().len(), 2);
    assert_eq!(v["entries"][1]["row"], "1000000");
    assert_eq!(v["entries"][1]["re"]["v"], "-2");
    q.as_object_mut().unwrap().remove("offset");
    q.as_object_mut().unwrap().remove("limit");
    assert_eq!(
        w.call("slice", q.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "resource_limit"
    );
    assert_eq!(before, std::fs::read(fixture()).unwrap());
}
#[test]
fn children_release_cancel_and_argument_boundaries() {
    let mut w = Worker::default();
    let (a, cat) = setup(&mut w);
    let mut q = a.clone();
    q["handle"] = handle(&cat, "cells");
    q["offset"] = json!("0");
    q["limit"] = json!("4");
    let children = call(&mut w, "children", q);
    assert_eq!(children["items"].as_array().unwrap().len(), 4);
    let h = children["items"][0]["handle"].clone();
    let mut d = a.clone();
    d["handle"] = h.clone();
    assert_eq!(
        call(&mut w, "describe", d.clone())["info"]["class"],
        "int32"
    );
    let mut r = a.clone();
    r["handles"] = json!([h]);
    assert_eq!(call(&mut w, "release", r)["released"], "1");
    assert_eq!(
        w.call("describe", d.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "not_open"
    );
    let c = Control::unbounded();
    c.cancel();
    assert_eq!(
        w.call("open", json!({"path":fixture()}).as_object().unwrap(), &c)
            .unwrap_err()
            .code,
        "cancelled"
    );
    let mut q = a.clone();
    q["offset"] = json!("00");
    q["limit"] = json!("1");
    assert_eq!(
        w.call("catalog", q.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "malformed_value"
    );
    w.discard("catalog", cat.clone());
    let mut d = a.clone();
    d["handle"] = handle(&cat, "matrix");
    assert_eq!(
        w.call("describe", d.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "not_open"
    );
}
#[test]
fn cross_session_and_replaced_source_invalidates_handles() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.mat");
    std::fs::copy(fixture(), &p).unwrap();
    let mut w = Worker::default();
    let (a, cat) = setup(&mut w);
    let b = call(&mut w, "open", json!({"path":p}));
    let mut d =
        json!({"session":b["session"],"generation":b["generation"],"handle":handle(&cat,"matrix")});
    assert_eq!(
        w.call("describe", d.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "not_open"
    );
    std::fs::write(&p, b"changed").unwrap();
    d.as_object_mut().unwrap().remove("handle");
    assert_eq!(
        w.call("close", d.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "stale_source"
    );
    assert_eq!(
        w.call("close", d.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "not_open"
    );
    let mut wrong = a.clone();
    wrong["generation"] = json!("999");
    assert_eq!(
        w.call("close", wrong.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "stale_source"
    );
    call(&mut w, "close", a);
}
#[test]
fn actual_stdio_protocol_catalog_and_exact_oracle() {
    let mut p = Command::new(env!("CARGO_BIN_EXE_dfv-mat"))
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = p.stdin.take().unwrap();
    let mut output = BufReader::new(p.stdout.take().unwrap());
    let read = |o: &mut BufReader<std::process::ChildStdout>| {
        let mut line = String::new();
        o.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    let caps = read(&mut output);
    assert_eq!(caps["protocol"], "dfv-mat");
    assert!(caps["limits"].get("sql_bytes").is_none());
    assert_eq!(caps["methods"].as_array().unwrap().len(), 8);
    writeln!(input, "{}", json!({"protocol":"dfv-mat","version":2,"kind":"request","id":"6","method":"open","args":{"path":fixture()}})).unwrap();
    input.flush().unwrap();
    let mismatch = read(&mut output);
    assert_eq!(mismatch["protocol"], "dfv-mat");
    assert_eq!(mismatch["id"], "6");
    assert_eq!(mismatch["error"]["code"], "unsupported");
    let send = |i: &mut std::process::ChildStdin, id: &str, m: &str, a: Value| {
        writeln!(
            i,
            "{}",
            json!({"protocol":"dfv-mat","version":1,"kind":"request","id":id,"method":m,"args":a})
        )
        .unwrap();
        i.flush().unwrap();
    };
    send(&mut input, "1", "open", json!({"path":fixture()}));
    let opened = read(&mut output);
    let s = &opened["result"];
    let args =
        json!({"session":s["session"],"generation":s["generation"],"offset":"0","limit":"1000"});
    send(&mut input, "2", "catalog", args);
    let cat = read(&mut output);
    let h = handle(&cat["result"], "unsigned");
    send(
        &mut input,
        "3",
        "slice",
        json!({"session":s["session"],"generation":s["generation"],"handle":h,"start":["1","1"],"count":["1","3"]}),
    );
    let v = read(&mut output);
    assert_eq!(v["result"]["data"]["re"][2]["v"], "18446744073709551615");
    writeln!(input,"{}",json!({"protocol":"dfv-table","version":1,"kind":"request","id":"5","method":"open","args":{"path":fixture()}})).unwrap();
    input.flush().unwrap();
    let confused = read(&mut output);
    assert_eq!(confused["protocol"], "dfv-mat");
    assert_eq!(confused["error"]["code"], "malformed_request");
    send(&mut input, "4", "query", json!({}));
    assert_eq!(read(&mut output)["error"]["code"], "unknown_method");
    drop(input);
    assert!(p.wait().unwrap().success());
}

#[test]
fn empty_region_and_handle_session_quotas_are_bounded() {
    let mut w = Worker::default();
    let (a, cat) = setup(&mut w);
    let mut q = a.clone();
    q["handle"] = handle(&cat, "empty_rows");
    q["start"] = json!(["1", "1"]);
    q["count"] = json!(["0", "3"]);
    assert!(
        call(&mut w, "slice", q.clone())["data"]["re"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    q["start"] = json!(["0", "1"]);
    assert_eq!(
        w.call("slice", q.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "malformed_value"
    );
    let dir = tempfile::tempdir().unwrap();
    for i in 0..3 {
        let path = dir.path().join(format!("{i}.mat"));
        std::fs::copy(fixture(), &path).unwrap();
        call(&mut w, "open", json!({"path":path}));
    }
    assert_eq!(
        w.call(
            "open",
            json!({"path":fixture()}).as_object().unwrap(),
            &Control::unbounded()
        )
        .unwrap_err()
        .code,
        "resource_limit"
    );
    let mut w = Worker::default();
    let s = call(
        &mut w,
        "open",
        json!({"path":fixture().with_file_name("many_v7.mat")}),
    );
    let q =
        json!({"session":s["session"],"generation":s["generation"],"offset":"0","limit":"1000"});
    let mut last = Value::Null;
    for _ in 0..16 {
        last = call(&mut w, "catalog", q.clone());
    }
    assert_eq!(
        w.call("catalog", q.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "resource_limit"
    );
    let handles = last["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["handle"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        call(
            &mut w,
            "release",
            json!({"session":s["session"],"generation":s["generation"],"handles":handles})
        )["released"],
        "1000"
    );
    assert_eq!(
        call(&mut w, "catalog", q)["items"]
            .as_array()
            .unwrap()
            .len(),
        1000
    );
}

#[cfg(unix)]
#[test]
fn scheduled_cancel_and_deadline_reclaim_late_mat_sessions() {
    use dfv_table_protocol::{Capabilities, ErrorBody};
    use std::{os::unix::net::UnixStream, sync::mpsc, time::Duration};
    struct Delayed {
        worker: Worker,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        first: bool,
    }
    impl Lane for Delayed {
        fn protocol(&self) -> &'static str {
            dfv_mat::PROTOCOL
        }
        fn capabilities(&self) -> Capabilities {
            self.worker.capabilities()
        }
        fn router(&self) -> dfv_table_protocol::sched::Router {
            self.worker.router()
        }
        fn call(
            &mut self,
            m: &str,
            a: &serde_json::Map<String, Value>,
            c: &Control,
        ) -> Result<Value, ErrorBody> {
            if self.first {
                self.first = false;
                self.started.send(()).unwrap();
                self.release.recv().unwrap();
                // Simulate a bounded codec operation completing after cancellation without polling internally.
                self.worker.call(m, a, &Control::unbounded())
            } else {
                self.worker.call(m, a, c)
            }
        }
        fn discard(&mut self, m: &str, v: Value) {
            self.worker.discard(m, v)
        }
    }
    for cancelled in [true, false] {
        let (mut input, worker_input) = UnixStream::pair().unwrap();
        let (worker_output, output) = UnixStream::pair().unwrap();
        output
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut output = BufReader::new(output);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            dfv_table_protocol::sched::serve_scheduled_with(
                move || Delayed {
                    worker: Worker::default(),
                    started: started_tx,
                    release: release_rx,
                    first: true,
                },
                BufReader::new(worker_input),
                worker_output,
                dfv_mat::MAX_FRAME_BYTES,
                Default::default(),
            )
            .unwrap()
        });
        let read = |o: &mut BufReader<UnixStream>| {
            let mut line = String::new();
            o.read_line(&mut line).unwrap();
            serde_json::from_str::<Value>(&line).unwrap()
        };
        read(&mut output);
        writeln!(input,"{}",json!({"protocol":"dfv-mat","version":1,"kind":"request","id":"1","method":"open","args":{"path":fixture()},"deadline_ms":if cancelled{"30000"}else{"100"}})).unwrap();
        started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        if cancelled {
            writeln!(
                input,
                "{}",
                json!({"protocol":"dfv-mat","version":1,"kind":"cancel","id":"1"})
            )
            .unwrap();
        }
        let error = read(&mut output);
        assert_eq!(
            error["error"]["code"],
            if cancelled {
                "cancelled"
            } else {
                "deadline_exceeded"
            }
        );
        assert_eq!(error["protocol"], "dfv-mat");
        release_tx.send(()).unwrap();
        writeln!(input,"{}",json!({"protocol":"dfv-mat","version":1,"kind":"request","id":"2","method":"open","args":{"path":fixture()}})).unwrap();
        let reopened = read(&mut output);
        assert_eq!(
            reopened["result"]["read_only"], true,
            "late session must have been reclaimed: {reopened}"
        );
        drop(input);
        assert_eq!(server.join().unwrap(), 0);
    }
}

#[test]
fn unsupported_versions_and_classes_are_typed_and_read_only() {
    let mut w = Worker::default();
    let path = fixture().with_file_name("native_v73.mat");
    let before = std::fs::read(&path).unwrap();
    assert_eq!(
        w.call(
            "open",
            json!({"path":path}).as_object().unwrap(),
            &Control::unbounded()
        )
        .unwrap_err()
        .code,
        "unsupported"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let s = call(
        &mut w,
        "open",
        json!({"path":fixture().with_file_name("refusals_v7.mat")}),
    );
    let a = json!({"session":s["session"],"generation":s["generation"]});
    let mut q = a.clone();
    q["offset"] = json!("0");
    q["limit"] = json!("1000");
    let cat = call(&mut w, "catalog", q);
    let entry = cat["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["info"]["name"] == "string_obj")
        .unwrap();
    assert_eq!(entry["info"]["support"]["supported"], false);
    let dims = entry["info"]["dims"].as_array().unwrap();
    let mut q = a.clone();
    q["handle"] = entry["handle"].clone();
    q["start"] = json!(vec!["1"; dims.len()]);
    q["count"] = json!(dims);
    assert_eq!(
        w.call("slice", q.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "unsupported"
    );
    for m in ["query", "save", "updateCell", "etl"] {
        assert_eq!(
            w.call(m, json!({}).as_object().unwrap(), &Control::unbounded())
                .unwrap_err()
                .code,
            "unknown_method"
        );
    }
}

#[test]
fn empty_sparse_coordinate_page_is_a_valid_empty_result() {
    // Minimal synthetic Level-5 sparse(0,3), with zero column pointers and no stored values.
    fn element(kind: u32, data: &[u8]) -> Vec<u8> {
        let mut v = [kind.to_le_bytes(), (data.len() as u32).to_le_bytes()].concat();
        v.extend_from_slice(data);
        v.resize(v.len().next_multiple_of(8), 0);
        v
    }
    let mut body = element(6, &[5u32.to_le_bytes(), 0u32.to_le_bytes()].concat());
    body.extend(element(
        5,
        &[0u32.to_le_bytes(), 3u32.to_le_bytes()].concat(),
    ));
    body.extend(element(1, b"empty_sparse"));
    body.extend(element(5, &[]));
    body.extend(element(5, &[0; 16]));
    body.extend(element(9, &[]));
    let mut bytes = b"MATLAB 5.0 MAT-file, synthetic empty sparse regression".to_vec();
    bytes.resize(124, b' ');
    bytes.extend([0, 1, b'I', b'M']);
    bytes.extend(element(14, &body));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.mat");
    std::fs::write(&path, &bytes).unwrap();
    let mut w = Worker::default();
    let opened = call(&mut w, "open", json!({"path":path}));
    let mut a = json!({"session":opened["session"],"generation":opened["generation"],"offset":"0","limit":"1"});
    let cat = call(&mut w, "catalog", a.clone());
    a["handle"] = cat["items"][0]["handle"].clone();
    a["start"] = json!(["1", "1"]);
    a["count"] = json!(["0", "3"]);
    let v = call(&mut w, "sparse", a.clone());
    assert_eq!(v["shape"], json!(["0", "3"]));
    assert_eq!(v["entries"], json!([]));
    assert_eq!(v["nnz"], "0");
    a["count"] = json!(["1", "3"]);
    assert_eq!(
        w.call("sparse", a.as_object().unwrap(), &Control::unbounded())
            .unwrap_err()
            .code,
        "malformed_value"
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}
