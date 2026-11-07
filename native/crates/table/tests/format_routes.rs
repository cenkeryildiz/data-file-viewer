//! Real worker-lane format bridges against independent PyArrow/ReadStat/Pandas fixture truth.
use dfv_table_engine::Tables;
use dfv_table_protocol::errors::{CANCELLED, QUERY_FAILED, UNSUPPORTED};
use dfv_table_protocol::{Control, ErrorBody, Lane};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "dfv-format-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn call(t: &mut Tables, method: &str, args: Value) -> Result<Value, ErrorBody> {
    t.call(method, args.as_object().unwrap(), &Control::unbounded())
}
fn fixture(crate_name: &str, name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(crate_name)
        .join("tests/fixtures")
        .join(name)
}
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn text_number(cell: &Value) -> Option<&str> {
    cell.get("v").and_then(Value::as_str)
}

#[test]
fn arrow_containers_compression_dictionaries_and_exact_values_match_pyarrow_truth() {
    let expected: Value =
        serde_json::from_slice(&std::fs::read(fixture("arrow-ipc", "expected.json")).unwrap())
            .unwrap();
    for name in [
        "wide.arrows",
        "wide.feather",
        "wide-lz4.arrows",
        "wide-lz4.feather",
        "wide-zstd.arrows",
        "wide-zstd.feather",
        "dict-delta.arrows",
        "dict-replace.arrows",
        "polars-view.arrows",
        "polars-view.feather",
        "empty.arrows",
        "empty.feather",
    ] {
        let path = fixture("arrow-ipc", name);
        let before = std::fs::read(&path).unwrap();
        let mut t = Tables::default();
        let opened =
            call(&mut t, "open", json!({"path":path})).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let want = &expected[name];
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let page=call(&mut t,"runQuery",json!({"session":opened["session"],"sql":format!("select * from {}",quote(stem)),"page_size":20})).unwrap_or_else(|e|panic!("{name}: {e:?}"));
        assert_eq!(
            page["rows"].as_array().unwrap().len(),
            want["rows"].as_u64().unwrap() as usize,
            "{name}"
        );
        for (c, column) in want["columns"].as_array().unwrap().iter().enumerate() {
            let ty = column["type"].as_str().unwrap();
            assert_eq!(page["columns"][c]["name"], column["name"], "{name}");
            for (r, want) in column["values"].as_array().unwrap().iter().enumerate() {
                let got = &page["rows"][r][c];
                if want.is_null() {
                    assert_eq!(*got, Value::Null, "{name}/{c}/{r}");
                    continue;
                }
                let s = want.as_str().unwrap();
                if ty.starts_with("timestamp[") {
                    let factor = if ty.starts_with("timestamp[ms") {
                        1000
                    } else {
                        1
                    };
                    assert_eq!(
                        text_number(got).unwrap(),
                        (s.parse::<i64>().unwrap() * factor).to_string(),
                        "{name}/{c}/{r}"
                    );
                    assert_eq!(got["$t"], "timestamp");
                } else if ty.starts_with("int")
                    || ty.starts_with("uint")
                    || ty.starts_with("decimal")
                {
                    assert_eq!(text_number(got), Some(s), "{name}/{c}/{r}");
                } else if ty == "bool" {
                    assert_eq!(got.as_bool(), Some(s == "true"));
                } else {
                    assert_eq!(got.as_str(), Some(s), "{name}/{c}/{r}");
                }
            }
        }
        call(&mut t, "close", json!({"session":opened["session"]})).unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "viewing changes {name}"
        );
    }
}

#[test]
fn arrow_malformed_containers_refuse_without_opening_a_session() {
    let mut t = Tables::default();
    for (name, code) in [
        ("no-eos.arrows", QUERY_FAILED),
        ("truncated.feather", QUERY_FAILED),
        ("v1.feather", UNSUPPORTED),
        ("types.arrows", UNSUPPORTED),
    ] {
        let e = call(&mut t, "open", json!({"path":fixture("arrow-ipc",name)})).unwrap_err();
        assert_eq!(e.code, code, "{name}");
    }
    let cancelled = Control::unbounded();
    cancelled.cancel();
    let args = json!({"path":fixture("arrow-ipc","wide.arrows")});
    assert_eq!(
        t.call("open", args.as_object().unwrap(), &cancelled)
            .unwrap_err()
            .code,
        CANCELLED
    );
    let opened = call(&mut t, "open", args).unwrap();
    assert_eq!(opened["file_kind"], "arrow");
}

#[test]
fn polars_nested_binary_nan_and_decimal_columns_remain_typed() {
    for name in [
        "polars-types.arrows",
        "polars-types.feather",
        "polars-types-zstd.feather",
    ] {
        let path = fixture("arrow-ipc", name);
        let before = std::fs::read(&path).unwrap();
        let mut t = Tables::default();
        let opened =
            call(&mut t, "open", json!({"path":path})).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let stem = quote(path.file_stem().unwrap().to_str().unwrap());
        let page=call(&mut t,"runQuery",json!({"session":opened["session"],"sql":format!("select n,f,s,b,lst,bin,cast(dt as varchar) as dt,dec from {stem}")})).unwrap();
        let rows = page["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0][0], json!({"$t":"int64","v":"9007199254740993"}));
        assert_eq!(rows[1][0], json!({"$t":"int64","v":"-9223372036854775808"}));
        assert_eq!(rows[1][1], json!({"$t":"float64","v":"NaN"}));
        assert_eq!(
            rows[0][4],
            json!({"$t":"list","v":[{"$t":"int64","v":"1"},{"$t":"int64","v":"2"}]})
        );
        assert_eq!(rows[2][4], json!({"$t":"list","v":[]}));
        assert_eq!(
            rows[0][5],
            json!({"$t":"binary","encoding":"base64","v":"AA=="})
        );
        assert_eq!(
            rows[2][5],
            json!({"$t":"binary","encoding":"base64","v":"YWI="})
        );
        assert_eq!(rows[0][6], "2026-10-31 01:02:03.456789");
        assert_eq!(rows[2][6], "1900-01-01 00:00:00");
        assert_eq!(rows[0][7]["$t"], "decimal");
        assert_eq!(rows[2][7]["v"], "-99999999999999999.99");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn dta_all_independent_storage_endian_release_missing_and_temporal_fixtures_route_exactly() {
    let truth: Value =
        serde_json::from_slice(&std::fs::read(fixture("dta", "expected.json")).unwrap()).unwrap();
    let mut checked = 0;
    for (name, want) in truth.as_object().unwrap() {
        let path = fixture("dta", name);
        let before = std::fs::read(&path).unwrap();
        let mut t = Tables::default();
        let opened =
            call(&mut t, "open", json!({"path":path})).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(opened["file_kind"], "dta");
        assert_eq!(opened["read_only_by_format"], true);
        let stem = path.file_stem().unwrap().to_str().unwrap();
        for (offset, expected_row) in want["offsets"]
            .as_array()
            .unwrap()
            .iter()
            .zip(want["rows"].as_array().unwrap())
        {
            let page=call(&mut t,"runQuery",json!({"session":opened["session"],"sql":format!("select * from {} limit 1 offset {}",quote(stem),offset.as_u64().unwrap())})).unwrap_or_else(|e|panic!("{name}: {e:?}"));
            let row = &page["rows"][0];
            for (column, (got, expected)) in want["columns"].as_array().unwrap().iter().zip(
                row.as_array()
                    .unwrap()
                    .iter()
                    .zip(expected_row.as_array().unwrap()),
            ) {
                if expected.get("missing").is_some() {
                    assert_eq!(*got, Value::Null, "{name}");
                } else if let Some(s) = expected.get("text") {
                    assert_eq!(*got, *s, "{name}");
                } else if column["format"] == "%td" {
                    let n = expected["float"].as_f64().unwrap() as i64 - 3653;
                    assert_eq!(*got, json!({"$t":"date","v":n.to_string()}), "{name}");
                } else if column["format"] == "%tc" {
                    let n =
                        (expected["float"].as_f64().unwrap() as i64) * 1000 - 315_619_200_000_000;
                    assert_eq!(
                        *got,
                        json!({"$t":"timestamp","v":n.to_string(),"unit":"us","tz":null}),
                        "{name}"
                    );
                } else if let Some(n) = expected.get("integer") {
                    assert_eq!(text_number(got).unwrap(), n.to_string(), "{name}");
                    assert_eq!(got["$t"], column["kind"]);
                } else {
                    let got = text_number(got).unwrap().parse::<f64>().unwrap();
                    let n = expected["float"].as_f64().unwrap();
                    if column["kind"] == "float" {
                        assert_eq!(got as f32, n as f32, "{name}");
                    } else {
                        assert_eq!(got, n, "{name}");
                    }
                }
                checked += 1;
            }
        }
        if want["row_count"] == 0 {
            let page = call(
                &mut t,
                "runQuery",
                json!({"session":opened["session"],"sql":format!("select * from {}",quote(stem))}),
            )
            .unwrap();
            assert!(page["rows"].as_array().unwrap().is_empty());
        }
        call(&mut t, "close", json!({"session":opened["session"]})).unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "viewing changes {name}"
        );
    }
    assert!(
        checked > 250,
        "exercise independent fixture values, not just open"
    );
}

#[test]
fn stata_period_formats_follow_calendar_boundaries_and_unresolved_calendars_refuse() {
    // Preserve the genuine ReadStat file layout and data; change only the equal-width date format.
    let original = std::fs::read(fixture("dta", "readstat-14.dta")).unwrap();
    let format = original.windows(3).position(|s| s == b"%td").unwrap();
    let d = Temp::new();
    for (word, expected) in [
        (b"%tw", ["1960-01-01", "1960-01-08", "1959-12-24"]),
        (b"%tm", ["1960-01-01", "1960-02-01", "1959-12-01"]),
        (b"%tq", ["1960-01-01", "1960-04-01", "1959-10-01"]),
        (b"%th", ["1960-01-01", "1960-07-01", "1959-07-01"]),
    ] {
        let mut bytes = original.clone();
        bytes[format..format + 3].copy_from_slice(word);
        let path = d.0.join("period.dta");
        std::fs::write(&path, &bytes).unwrap();
        let mut t = Tables::default();
        let opened = call(&mut t, "open", json!({"path":path})).unwrap();
        let page=call(&mut t,"runQuery",json!({"session":opened["session"],"sql":"select cast(day as varchar) as d from period"})).unwrap();
        for (r, want) in expected.iter().enumerate() {
            assert_eq!(page["rows"][r][0], *want, "{word:?}");
        }
        assert_eq!(page["rows"][3][0], Value::Null);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    for word in [b"%tC", b"%tb"] {
        let mut bytes = original.clone();
        bytes[format..format + 3].copy_from_slice(word);
        let path = d.0.join("refused.dta");
        std::fs::write(&path, bytes).unwrap();
        let mut t = Tables::default();
        assert_eq!(
            call(&mut t, "open", json!({"path":path})).unwrap_err().code,
            UNSUPPORTED
        );
    }
    // This ReadStat fixture stores three little-endian doubles and a three-byte string per row.
    let mut bytes = original.clone();
    bytes[format..format + 3].copy_from_slice(b"%ty");
    let data = bytes.windows(6).position(|s| s == b"<data>").unwrap() + 6;
    for (r, year) in [2000f64, 2001f64, 1999f64].into_iter().enumerate() {
        let at = data + r * 27 + 8;
        bytes[at..at + 8].copy_from_slice(&year.to_le_bytes());
    }
    let path = d.0.join("year.dta");
    std::fs::write(&path, &bytes).unwrap();
    let mut t = Tables::default();
    let opened = call(&mut t, "open", json!({"path":path})).unwrap();
    let page = call(
        &mut t,
        "runQuery",
        json!({"session":opened["session"],"sql":"select cast(day as varchar) as d from year"}),
    )
    .unwrap();
    for (r, year) in ["2000-01-01", "2001-01-01", "1999-01-01"]
        .iter()
        .enumerate()
    {
        assert_eq!(page["rows"][r][0], *year);
    }
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

// Generated using the project's Apache Arrow 21.2 writer: 33 nested Struct fields, no rows.
const DEEP_ARROW_SCHEMA: &str = concat!(
    "ffffffffb80600001000000000000a0010000e00070008000a0000000000000110000000000004000800080000000400",
    "0800000004000000010000000400000054faffff1400000000000001180000000000000d6806000004000000726f6f74",
    "00000000010000000400000080faffff1400000000000001180000000000000d34060000060000006e65737465640000",
    "0100000004000000acfaffff1400000000000001180000000000000d04060000060000006e6573746564000001000000",
    "04000000d8faffff1400000000000001180000000000000dd4050000060000006e657374656400000100000004000000",
    "04fbffff1400000000000001180000000000000da4050000060000006e65737465640000010000000400000030fbffff",
    "1400000000000001180000000000000d74050000060000006e6573746564000001000000040000005cfbffff14000000",
    "00000001180000000000000d44050000060000006e65737465640000010000000400000088fbffff1400000000000001",
    "180000000000000d14050000060000006e657374656400000100000004000000b4fbffff140000000000000118000000",
    "0000000de4040000060000006e657374656400000100000004000000e0fbffff1400000000000001180000000000000d",
    "b4040000060000006e6573746564000001000000040000000cfcffff1400000000000001180000000000000d84040000",
    "060000006e65737465640000010000000400000038fcffff1400000000000001180000000000000d5404000006000000",
    "6e65737465640000010000000400000064fcffff1400000000000001180000000000000d24040000060000006e657374",
    "65640000010000000400000090fcffff1400000000000001180000000000000df4030000060000006e65737465640000",
    "0100000004000000bcfcffff1400000000000001180000000000000dc4030000060000006e6573746564000001000000",
    "04000000e8fcffff1400000000000001180000000000000d94030000060000006e657374656400000100000004000000",
    "14fdffff1400000000000001180000000000000d64030000060000006e65737465640000010000000400000040fdffff",
    "1400000000000001180000000000000d34030000060000006e6573746564000001000000040000006cfdffff14000000",
    "00000001180000000000000d04030000060000006e65737465640000010000000400000098fdffff1400000000000001",
    "180000000000000dd4020000060000006e657374656400000100000004000000c4fdffff140000000000000118000000",
    "0000000da4020000060000006e657374656400000100000004000000f0fdffff1400000000000001180000000000000d",
    "74020000060000006e6573746564000001000000040000001cfeffff1400000000000001180000000000000d44020000",
    "060000006e65737465640000010000000400000048feffff1400000000000001180000000000000d1402000006000000",
    "6e65737465640000010000000400000074feffff1400000000000001180000000000000de4010000060000006e657374",
    "656400000100000004000000a0feffff1400000000000001180000000000000db4010000060000006e65737465640000",
    "0100000004000000ccfeffff1400000000000001180000000000000d84010000060000006e6573746564000001000000",
    "04000000f8feffff1400000000000001180000000000000d54010000060000006e657374656400000100000004000000",
    "24ffffff1400000000000001180000000000000d24010000060000006e65737465640000010000000400000050ffffff",
    "1400000000000001180000000000000df4000000060000006e6573746564000001000000040000007cffffff14000000",
    "00000001180000000000000dc4000000060000006e657374656400000100000004000000a8ffffff1400000000000001",
    "180000000000000d94000000060000006e657374656400000100000004000000d4ffffff140000000000000118000000",
    "0000000d64000000060000006e6573746564000001000000140000001000180004000b001300140000000c0010000000",
    "140000000000000118000000000000021c000000060000006e657374656400000000000008000c000800070008000000",
    "000000012000000080ffffff84ffffff88ffffff8cffffff90ffffff94ffffff98ffffff9cffffffa0ffffffa4ffffff",
    "a8ffffffacffffffb0ffffffb4ffffffb8ffffffbcffffffc0ffffffc4ffffffc8ffffffccffffffd0ffffffd4ffffff",
    "d8ffffffdcffffffe0ffffffe4ffffffe8ffffffecfffffff0fffffff4fffffff8fffffffcffffff0400040004000000",
    "ffffffff00000000",
);
// Writer-generated Null batch: 67,108,865 rows, zero value buffers (240 encoded bytes).
const HUGE_NULL_ARROW: &str = concat!(
    "ffffffff780000001000000000000a0010000e00070008000a0000000000000110000000000004000800080000000400",
    "080000000400000001000000140000001000180004000b001300140000000c0010000000140000000000000114000000",
    "0000000114000000010000006e00000000000000040004000400000000000000ffffffff600000001400000000000000",
    "00000a000e000c00070008000a000000000000031000000004000a0018000c00080004000a0000001400000018000000",
    "01000004000000000000000000000000000000000100000001000004000000000100000400000000ffffffff00000000",
);
fn ipc_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn arrow_schema_depth_refuses_before_recursive_query_adaptation() {
    let dir = Temp::new();
    let path = dir.0.join("deep.arrows");
    let bytes = ipc_hex(DEEP_ARROW_SCHEMA);
    std::fs::write(&path, &bytes).unwrap();
    // Refuse in codec preflight, before recursive Arrow schema/query adaptation.
    assert!(matches!(
        dfv_table_arrow_ipc::open(&path, &dfv_table_arrow_ipc::Limits::default()),
        Err(dfv_table_arrow_ipc::Error::TooLarge(_))
    ));
    let mut t = Tables::default();
    assert_eq!(
        call(&mut t, "open", json!({"path":path})).unwrap_err().code,
        dfv_table_protocol::errors::RESOURCE_LIMIT
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    call(
        &mut t,
        "open",
        json!({"path":fixture("arrow-ipc","wide.arrows")}),
    )
    .unwrap();
}

#[test]
fn arrow_zero_buffer_rows_refuse_before_large_null_cast_allocation() {
    let dir = Temp::new();
    let path = dir.0.join("huge.arrows");
    let mut bytes = ipc_hex(HUGE_NULL_ARROW);
    let rows = (dfv_table_engine::resource::Limits::default().max_bytes as u64) / 4 + 1;
    let old = 67_108_865u64.to_le_bytes();
    let mut changed = 0;
    for at in 0..=bytes.len() - 8 {
        if bytes[at..at + 8] == old {
            bytes[at..at + 8].copy_from_slice(&rows.to_le_bytes());
            changed += 1;
        }
    }
    assert_eq!(changed, 3, "record length, field length and null count");
    std::fs::write(&path, &bytes).unwrap();
    let decoded =
        dfv_table_arrow_ipc::open(&path, &dfv_table_arrow_ipc::Limits::default()).unwrap();
    assert_eq!(decoded.rows, rows);
    let mut t = Tables::default();
    assert_eq!(
        call(&mut t, "open", json!({"path":path})).unwrap_err().code,
        dfv_table_protocol::errors::RESOURCE_LIMIT
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    call(
        &mut t,
        "open",
        json!({"path":fixture("arrow-ipc","wide.arrows")}),
    )
    .unwrap();
}
