//! Frozen binary corpus written by a real q (pykx, see corpus/generate_corpus.py) with expected values taken from
//! q's own read-back of the same files, never from this crate. Fails if a corpus file is edited (SHA-256 manifest).
use dfv_table_kdb::{KdbError, Limits, Value, parse_kdb_file};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

fn sha256(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend(((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [
                t1.wrapping_add(t2),
                v[0],
                v[1],
                v[2],
                v[3].wrapping_add(t1),
                v[4],
                v[5],
                v[6],
            ];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// Same escaping as Python's `json.dumps(s, ensure_ascii=True)` without the quotes.
fn ascii_json(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            '\u{8}' => o.push_str("\\b"),
            '\u{c}' => o.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e && (c as u32) != 0x7f => {
                let mut b = [0u16; 2];
                for u in c.encode_utf16(&mut b) {
                    o.push_str(&format!("\\u{u:04x}"));
                }
            }
            c => o.push(c),
        }
    }
    o + "\""
}

fn canon(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => format!("b:{}", u8::from(*b)),
        Value::Guid(s) | Value::Symbol(s) => format!("s:{}", ascii_json(s)),
        Value::Char(c) => format!("s:{}", ascii_json(&c.to_string())),
        Value::Byte(n) => format!("i:{n}"),
        Value::Short(n) => format!("i:{n}"),
        Value::Int(n) => format!("i:{n}"),
        Value::Long(n) => format!("i:{n}"),
        Value::Real(f) => format!("f4:{:08x}", f.to_bits()),
        Value::Float(f) => format!("f8:{:016x}", f.to_bits()),
        Value::TimestampMicros(n) => format!("p:{n}"),
        Value::MonthDays(n) => format!("m:{n}"),
        Value::DateDays(n) => format!("d:{n}"),
        Value::DatetimeMicros(n) => format!("z:{n}"),
        Value::TimespanNanos(n) => format!("n:{n}"),
        Value::MinuteMicros(n) => format!("u:{n}"),
        Value::SecondMicros(n) => format!("v:{n}"),
        Value::TimeMicros(n) => format!("t:{n}"),
        Value::List(items) => format!(
            "[{}]",
            items.iter().map(canon).collect::<Vec<_>>().join(",")
        ),
        Value::Dict { keys, values } => format!("{{{}=>{}}}", canon(keys), canon(values)),
    }
}

#[derive(Default)]
struct Expected {
    rows: Option<usize>,
    columns: Vec<(String, i8, Vec<String>)>,
    error: Option<String>,
}

/// Splits a nested cell list `a<TAB>b` only at tabs: cells never contain tabs (the generator escapes them).
fn expected() -> BTreeMap<String, Expected> {
    let text = std::fs::read_to_string(dir().join("expected.tsv")).unwrap();
    let mut out: BTreeMap<String, Expected> = BTreeMap::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        let e = out.entry(f[0].to_owned()).or_default();
        match f[1] {
            "ROWS" => e.rows = Some(f[2].parse().unwrap()),
            "ERR" => e.error = Some(f[2].to_owned()),
            "COL" => {
                let name: String = {
                    // the generator wrote the name with json.dumps (ASCII escapes)
                    let raw = f[3];
                    assert!(raw.starts_with('"') && raw.ends_with('"'));
                    json_unescape(&raw[1..raw.len() - 1])
                };
                assert_eq!(f[2].parse::<usize>().unwrap(), e.columns.len());
                e.columns.push((
                    name,
                    f[4].parse().unwrap(),
                    f[5..].iter().map(|s| (*s).to_owned()).collect(),
                ));
            }
            other => panic!("bad expected line kind {other}"),
        }
    }
    out
}

fn json_unescape(s: &str) -> String {
    let mut units: Vec<u16> = Vec::new();
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            let mut b = [0u16; 2];
            units.extend_from_slice(c.encode_utf16(&mut b));
            continue;
        }
        match it.next().unwrap() {
            'u' => {
                let hex: String = it.by_ref().take(4).collect();
                units.push(u16::from_str_radix(&hex, 16).unwrap());
            }
            'n' => units.push(10),
            't' => units.push(9),
            c => units.push(c as u16),
        }
    }
    String::from_utf16(&units).unwrap()
}

#[test]
fn corpus_files_are_frozen() {
    let manifest = std::fs::read_to_string(dir().join("manifest.json")).unwrap();
    let mut checked = 0;
    // The manifest is `{"files": {"name.kdb": {"bytes": n, "note": "...", "sha256": "hex"}, ...}, ...}` written with sorted keys.
    for chunk in manifest
        .split("\"files\": {")
        .nth(1)
        .unwrap()
        .split("\"bytes\": ")
        .skip(1)
    {
        let bytes: u64 = chunk.split(',').next().unwrap().trim().parse().unwrap();
        let sha = chunk
            .split("\"sha256\": \"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        // file name is the key that precedes this entry; find it by sha instead, which is unique
        let found = std::fs::read_dir(dir())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "kdb"))
            .find(|p| sha256(&std::fs::read(p).unwrap()) == sha);
        let path = found.unwrap_or_else(|| panic!("no corpus file hashes to {sha}"));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), bytes, "{path:?}");
        checked += 1;
    }
    let on_disk = std::fs::read_dir(dir())
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "kdb")
        })
        .count();
    assert_eq!(checked, on_disk, "every corpus file is in the manifest");
    assert!(checked >= 18);
}

#[test]
fn q_written_tables_decode_to_the_values_q_reads_back() {
    let all = expected();
    let mut tables = 0;
    let mut cells = 0usize;
    for (name, e) in &all {
        if e.error.is_some() {
            continue;
        }
        let table = parse_kdb_file(&dir().join(format!("{name}.kdb")), Limits::default())
            .unwrap_or_else(|err| panic!("{name}: {err}"));
        assert_eq!(Some(table.row_count), e.rows, "{name} rows");
        assert_eq!(table.columns.len(), e.columns.len(), "{name} columns");
        for (col, (cname, qtype, want)) in table.columns.iter().zip(&e.columns) {
            assert_eq!(&col.name, cname, "{name} column name");
            assert_eq!(col.q_type, *qtype, "{name}.{cname} type");
            let got: Vec<String> = col.values.iter().map(canon).collect();
            assert_eq!(got.len(), want.len(), "{name}.{cname} length");
            for (i, (g, w)) in got.iter().zip(want).enumerate() {
                assert_eq!(g, w, "{name}.{cname}[{i}]");
            }
            cells += got.len();
        }
        tables += 1;
    }
    assert!(
        tables == 6 && cells > 25_000,
        "{tables} tables, {cells} cells"
    );
}

#[test]
fn every_atom_type_is_in_the_corpus() {
    let all = expected();
    let types: std::collections::BTreeSet<i8> = all["atoms"].columns.iter().map(|c| c.1).collect();
    let want: std::collections::BTreeSet<i8> = [
        1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]
    .into_iter()
    .collect();
    assert_eq!(types, want);
}

#[test]
fn files_q_wrote_that_are_not_plain_tables_get_typed_refusals() {
    let all = expected();
    let mut refused = 0;
    for (name, e) in &all {
        let Some(code) = &e.error else { continue };
        let err = parse_kdb_file(&dir().join(format!("{name}.kdb")), Limits::default())
            .err()
            .unwrap_or_else(|| panic!("{name} was accepted"));
        assert_eq!(err.code(), code, "{name}: {err}");
        refused += 1;
    }
    assert!(refused >= 10);
}

#[test]
fn oversized_and_truncated_corpus_files_are_typed_never_panics() {
    let small = Limits {
        max_file_bytes: 1000,
        ..Limits::default()
    };
    assert!(matches!(
        parse_kdb_file(&dir().join("random1500.kdb"), small),
        Err(KdbError::FileTooLarge { max: 1000, .. })
    ));
    let tight = Limits {
        max_values: 100,
        ..Limits::default()
    };
    assert!(matches!(
        parse_kdb_file(&dir().join("random1500.kdb"), tight),
        Err(KdbError::TooManyValues { max: 100 })
    ));
    // Every prefix of the q-written files (the large one sampled) fails with a typed error, none panics.
    for name in [
        "atoms",
        "general_lists",
        "wide_names",
        "single_row",
        "empty_table",
    ] {
        let bytes = std::fs::read(dir().join(format!("{name}.kdb"))).unwrap();
        for n in 0..bytes.len() {
            let r = dfv_table_kdb::parse_kdb_buffer(&bytes[..n], Limits::default());
            assert!(r.is_err(), "{name} prefix {n}");
        }
    }
    let big = std::fs::read(dir().join("random1500.kdb")).unwrap();
    for n in (0..big.len()).step_by(997).chain([big.len() - 1]) {
        assert!(dfv_table_kdb::parse_kdb_buffer(&big[..n], Limits::default()).is_err());
    }
}

/// Byte-level corruption of real q output: every outcome is Ok or a typed error, and the decoder never panics
/// or allocates more than the (capped) value budget allows.
#[test]
fn mutated_q_files_never_panic() {
    let limits = Limits {
        max_values: 20_000,
        ..Limits::default()
    };
    let mut state = 0x2545_F491_4F6C_DD1D_u64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let (mut ok, mut err) = (0u32, 0u32);
    for name in ["atoms", "general_lists", "wide_names", "single_row"] {
        let base = std::fs::read(dir().join(format!("{name}.kdb"))).unwrap();
        for _ in 0..15_000 {
            let mut b = base.clone();
            for _ in 0..1 + next() % 4 {
                let i = (next() as usize) % b.len();
                // favour length-like corruption: 0xff / 0x7f / 0x80 bytes turn counts negative or enormous
                b[i] = [0xff, 0x7f, 0x80, 0x00, next() as u8][(next() % 5) as usize];
            }
            if next() % 4 == 0 {
                b.truncate((next() as usize) % b.len());
            }
            match dfv_table_kdb::parse_kdb_buffer(&b, limits) {
                Ok(_) => ok += 1,
                Err(_) => err += 1,
            }
        }
    }
    assert!(err > 10_000 && ok > 0, "{ok} ok, {err} errors");
}
