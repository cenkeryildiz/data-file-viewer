//! Differential gate: the TypeScript `patchCell` (oracle/oracle.ts) vs this crate on the same workbooks and edits.
//! Runs only when DFV_XLSX_ORACLE points at the directory `oracle/run.py` filled; otherwise it says so and passes.
use dfv_table_xlsx_patch::zip::{ZipIndex, index_zip, inflate_capped, local_data, stored_bytes};
use dfv_table_xlsx_patch::{CellValue, PatchRequest, patch_cell};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Cases where the TS is knowingly wrong and Rust is not: JS `String.replace` expands `$&`/`$1`/`$$` in the new cell XML.
const DOLLAR: [&str; 2] = ["main-string-dollar-divergence", "op-string-dollar"];

fn value(tag: &Value) -> CellValue {
    let v = &tag["v"];
    match tag["t"].as_str().unwrap() {
        "null" => CellValue::Null,
        "bool" => CellValue::Bool(v.as_bool().unwrap()),
        "num" => CellValue::Number(match v.as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            s => s.parse().unwrap(),
        }),
        "big" => CellValue::BigInt(v.as_str().unwrap().to_owned()),
        _ => CellValue::Text(v.as_str().unwrap().to_owned()),
    }
}

fn request(r: &Value) -> PatchRequest {
    PatchRequest {
        sheet_path: r["sheetPath"].as_str().unwrap().to_owned(),
        column_name: r["columnName"].as_str().unwrap().to_owned(),
        column_names: r["columnNames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect(),
        row_ordinal: r["rowOrdinal"].as_i64().unwrap(),
        verbatim: r["verbatim"].as_bool().unwrap(),
        expected_sha256: r
            .get("expectedSha256")
            .and_then(Value::as_str)
            .map(str::to_owned),
        expected_current: value(&r["expectedCurrent"]),
        new_value: value(&r["newValue"]),
    }
}

/// A member's local header + name + extra + stored data, and its central record with the offset field blanked.
fn block(index: &ZipIndex<'_>, name: &str) -> (Vec<u8>, Vec<u8>) {
    let e = index.entries.iter().find(|e| e.name == name).unwrap();
    let l = local_data(index.bytes, e).unwrap();
    let mut central = index.bytes[e.central..e.central + e.central_length].to_vec();
    central[42..46].fill(0);
    (
        index.bytes[l.header..l.data + e.compressed_size].to_vec(),
        central,
    )
}

fn sheet(index: &ZipIndex<'_>, path: &str) -> Vec<u8> {
    let e = index.entries.iter().find(|e| e.name == path).unwrap();
    inflate_capped(stored_bytes(index, e), e.method, e.size).unwrap()
}

#[test]
fn rust_matches_the_typescript_patch_cell() {
    let Ok(root) = std::env::var("DFV_XLSX_ORACLE") else {
        eprintln!("DFV_XLSX_ORACLE not set: differential gate skipped (run oracle/run.py)");
        return;
    };
    let root = PathBuf::from(root);
    let ts_results: Value =
        serde_json::from_slice(&fs::read(root.join("ts-out/results.json")).unwrap()).unwrap();
    let mut cases: Vec<Value> = Vec::new();
    for f in ["cases-ts.json", "cases-openpyxl.json"] {
        cases.extend(
            serde_json::from_slice::<Vec<Value>>(&fs::read(root.join("corpus").join(f)).unwrap())
                .unwrap(),
        );
    }
    fs::create_dir_all(root.join("rust-out")).unwrap();
    let (mut both_ok, mut both_err, mut known, mut bad) = (0, 0, 0, Vec::<String>::new());
    let mut rust_results: HashMap<String, Value> = HashMap::new();
    for case in &cases {
        let id = case["id"].as_str().unwrap();
        let original =
            fs::read(root.join("corpus").join(case["workbook"].as_str().unwrap())).unwrap();
        let req = request(&case["request"]);
        let rust = patch_cell(&original, &req);
        if let Ok(r) = &rust {
            fs::write(root.join("rust-out").join(format!("{id}.xlsx")), &r.bytes).unwrap();
        }
        let ts = &ts_results[id];
        let ts_ok = ts["ok"].as_bool().unwrap();
        match (&rust, ts_ok) {
            (Ok(r), true) => {
                let ts_bytes = fs::read(root.join("ts-out").join(format!("{id}.xlsx"))).unwrap();
                let (a, b, o) = (
                    index_zip(&r.bytes).unwrap(),
                    index_zip(&ts_bytes).unwrap(),
                    index_zip(&original).unwrap(),
                );
                let names: Vec<_> = a.entries.iter().map(|e| e.name.clone()).collect();
                if names != b.entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>()
                    || a.comment != b.comment
                    || a.comment != o.comment
                {
                    bad.push(format!("{id}: member list or archive comment differs"));
                    continue;
                }
                for n in names.iter().filter(|n| **n != req.sheet_path) {
                    // Rust and TS rebuild headers the same way; the original's own headers differ only for data-descriptor members.
                    let (ea, eo) = (
                        a.entries.iter().find(|e| e.name == *n).unwrap(),
                        o.entries.iter().find(|e| e.name == *n).unwrap(),
                    );
                    let kept = stored_bytes(&a, ea) == stored_bytes(&o, eo)
                        && (ea.method, ea.crc, ea.size) == (eo.method, eo.crc, eo.size);
                    if block(&a, n) != block(&b, n)
                        || !kept
                        || (eo.flags & 8 == 0 && block(&a, n) != block(&o, n))
                    {
                        bad.push(format!("{id}: member {n} is not byte-identical"));
                    }
                }
                let (rs_sheet, ts_sheet) = (sheet(&a, &req.sheet_path), sheet(&b, &req.sheet_path));
                if id == "op-string-cr" {
                    // XML parsers normalize literal CR to LF; the reference loses carriage returns.
                    assert_eq!(
                        String::from_utf8(rs_sheet)
                            .unwrap()
                            .replace("&#13;", "\r")
                            .as_bytes(),
                        ts_sheet
                    );
                    known += 1;
                } else {
                    if rs_sheet != ts_sheet {
                        bad.push(format!(
                            "{id}: patched sheet XML differs from the TypeScript's"
                        ));
                    }
                    both_ok += 1;
                }
            }
            (Err(r), false) => {
                if r.0 != ts["message"].as_str().unwrap() {
                    bad.push(format!(
                        "{id}: messages differ\n   rust: {}\n   ts:   {}",
                        r.0,
                        ts["message"].as_str().unwrap()
                    ));
                }
                both_err += 1;
            }
            (Ok(r), false) if DOLLAR.contains(&id) => {
                assert!(
                    ts["message"]
                        .as_str()
                        .unwrap()
                        .contains("does not read back as the new value"),
                    "{id}: {ts}"
                );
                let idx = index_zip(&r.bytes).unwrap();
                assert!(
                    String::from_utf8(sheet(&idx, &req.sheet_path))
                        .unwrap()
                        .contains("$&")
                        || id == "op-string-dollar"
                );
                known += 1;
            }
            (Ok(_), false) => bad.push(format!(
                "{id}: Rust accepted, TS refused: {}",
                ts["message"]
            )),
            (Err(r), true) => bad.push(format!("{id}: Rust refused ({}), TS accepted", r.0)),
        }
        rust_results.insert(
            id.to_owned(),
            match &rust {
                Ok(r) => serde_json::json!({"ok": true, "cell": r.cell}),
                Err(e) => serde_json::json!({"ok": false, "message": e.0}),
            },
        );
    }
    fs::write(
        root.join("rust-out/results.json"),
        serde_json::to_vec_pretty(&rust_results).unwrap(),
    )
    .unwrap();
    println!(
        "differential: {} cases, {both_ok} both accepted (byte-checked), {both_err} both refused (same message), {known} known TS defects, {} divergences",
        cases.len(),
        bad.len()
    );
    assert!(bad.is_empty(), "divergences:\n{}", bad.join("\n"));
}
