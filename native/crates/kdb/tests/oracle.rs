//! Writes fixtures plus the Rust decoder's canonical dump for `oracle/compare.mjs`, which decodes the same
//! files with the TypeScript reference (`src/kdbParser.ts`) and diffs them. Runs only when KDB_ORACLE_DIR is set.
mod support;
use dfv_table_kdb::{Limits, Value, parse_kdb_buffer};
use support::*;

fn canon(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => format!("b:{}", u8::from(*b)),
        Value::Guid(s) | Value::Symbol(s) => format!("s:{s}"),
        Value::Char(c) => format!("s:{c}"),
        Value::Byte(n) => format!("i:{n}"),
        Value::Short(n) => format!("i:{n}"),
        Value::Int(n) => format!("i:{n}"),
        Value::MonthDays(n) | Value::DateDays(n) => format!("i:{n}"),
        Value::Long(n)
        | Value::TimestampMicros(n)
        | Value::DatetimeMicros(n)
        | Value::TimespanNanos(n) => format!("j:{n}"),
        Value::MinuteMicros(n) | Value::SecondMicros(n) | Value::TimeMicros(n) => format!("j:{n}"),
        Value::Real(f) => format!("f4:{:08x}", f.to_bits()),
        Value::Float(f) => format!("f8:{:016x}", f.to_bits()),
        Value::List(_) | Value::Dict { .. } => {
            unreachable!("oracle fixtures are typed columns only")
        }
    }
}

fn jstr(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' | '\\' => o.extend(['\\', c]),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o + "\""
}

fn dump(name: &str, bytes: &[u8], dir: &std::path::Path) {
    std::fs::write(dir.join(name), bytes).unwrap();
    let t = parse_kdb_buffer(bytes, Limits::default()).unwrap();
    let cols: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            let vals: Vec<String> = c.values.iter().map(|v| jstr(&canon(v))).collect();
            format!(
                "{{\"name\":{},\"qType\":{},\"values\":[{}]}}",
                jstr(&c.name),
                c.q_type,
                vals.join(",")
            )
        })
        .collect();
    std::fs::write(
        dir.join(format!("{name}.json")),
        format!(
            "{{\"rowCount\":{},\"columns\":[{}]}}",
            t.row_count,
            cols.join(",")
        ),
    )
    .unwrap();
}

#[test]
fn write_oracle_fixtures() {
    let Some(dir) = std::env::var_os("KDB_ORACLE_DIR") else {
        return;
    };
    let dir = std::path::Path::new(&dir);
    std::fs::create_dir_all(dir).unwrap();
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    // 1. Random typed columns, 1500 rows, ~10% nulls per type. Includes extremes of each width.
    let n = 1500usize;
    let pick = |rng: &mut Rng, null: bool| null && rng.next().is_multiple_of(10);
    let mut cols: Vec<(String, Vec<u8>)> = Vec::new();
    let mut add = |name: &str, bytes: Vec<u8>| cols.push((name.to_owned(), bytes));
    add(
        "bool",
        bytes(
            1,
            &(0..n).map(|_| (rng.next() % 2) as u8).collect::<Vec<_>>(),
        ),
    );
    add(
        "byte",
        bytes(4, &(0..n).map(|_| rng.next() as u8).collect::<Vec<_>>()),
    );
    add(
        "short",
        i16s(
            5,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i16::MIN
                    } else {
                        rng.next() as i16
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "int",
        i32s(
            6,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i32::MIN
                    } else {
                        rng.next() as i32
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "long",
        i64s(
            7,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i64::MIN
                    } else {
                        rng.next() as i64
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "real",
        f32s(
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        f32::NAN
                    } else {
                        f32::from_bits(rng.next() as u32)
                    }
                })
                .map(|f| if f.is_nan() && false { 0.0 } else { f })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "float",
        f64s(
            9,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        f64::NAN
                    } else {
                        (rng.next() as i64 as f64) / 1e6
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "sym",
        syms(
            &(0..n)
                .map(|i| {
                    ["", "AAPL", "ÜBER", "x y", "日本"][(rng.next() % 5) as usize].to_owned()
                        + if i % 97 == 0 { "!" } else { "" }
                })
                .collect::<Vec<_>>()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "guid",
        guids(
            &(0..n)
                .map(|_| {
                    let mut g = [0u8; 16];
                    if !rng.next().is_multiple_of(10) {
                        for b in &mut g {
                            *b = rng.next() as u8;
                        }
                    }
                    g
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "ts",
        i64s(
            12,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i64::MIN
                    } else {
                        (rng.next() as i64) >> 4
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "month",
        i32s(
            13,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i32::MIN
                    } else {
                        (rng.next() % 2_400_000) as i32 - 1_200_000
                    }
                })
                .collect::<Vec<_>>()
                .iter()
                .map(|m| {
                    if (-23_999..=-22_800).contains(m) {
                        0
                    } else {
                        *m
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "date",
        i32s(
            14,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i32::MIN
                    } else {
                        (rng.next() % 4_000_000) as i32 - 2_000_000
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "datetime",
        f64s(
            15,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        f64::NAN
                    } else {
                        ((rng.next() % 2_000_000_000) as f64 / 1e4) - 100_000.0
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "span",
        i64s(
            16,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i64::MIN
                    } else {
                        rng.next() as i64
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "minute",
        i32s(
            17,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i32::MIN
                    } else {
                        rng.next() as i32
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "second",
        i32s(
            18,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i32::MIN
                    } else {
                        rng.next() as i32
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "time",
        i32s(
            19,
            &(0..n)
                .map(|_| {
                    if pick(&mut rng, true) {
                        i32::MIN
                    } else {
                        rng.next() as i32
                    }
                })
                .collect::<Vec<_>>(),
        ),
    );
    let names: Vec<&str> = cols.iter().map(|c| c.0.as_str()).collect();
    let bodies: Vec<Vec<u8>> = cols.iter().map(|c| c.1.clone()).collect();
    dump("random", &table(&names, &bodies), dir);
    // 2. Hand-picked edge values every width must agree on.
    // Beyond the TS's Date.UTC range (months) or an i64 of microseconds (datetime) the reference yields NaN/huge
    // BigInts and the Rust reader is exact or refuses; those are unit-tested instead.
    for (name, col) in [
        (
            "edge_month",
            i32s(13, &[-1, 0, 1, 11, 12, -12, -13, 1_199_999, -1_199_999]),
        ),
        (
            "edge_ts",
            i64s(
                12,
                &[0, 1, -1, 999, -999, 1000, -1000, i64::MIN + 1, i64::MAX],
            ),
        ),
        (
            "edge_datetime",
            f64s(
                15,
                &[
                    0.0,
                    -10957.0,
                    1e-9,
                    -1e-9,
                    0.5 / 86_400_000_000.0,
                    1.5 / 86_400_000_000.0,
                    2.5 / 86_400_000_000.0,
                    40_000.0,
                    -40_000.0,
                ],
            ),
        ),
        (
            "edge_real",
            f32s(&[
                0.0,
                -0.0,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::MIN_POSITIVE,
                1.0e-45,
            ]),
        ),
        (
            "edge_float",
            f64s(
                9,
                &[
                    0.0,
                    -0.0,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::MIN_POSITIVE,
                    5e-324,
                ],
            ),
        ),
        (
            "edge_char",
            bytes(10, "plain ascii and 日本 é \u{1}".as_bytes()),
        ),
    ] {
        dump(name, &table(&["v"], &[col]), dir);
    }
}
