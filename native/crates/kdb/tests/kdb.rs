mod support;
use dfv_table_kdb::{KdbError, Limits, Value, parse_kdb_buffer, parse_kdb_file};
use support::*;

fn parse(b: &[u8]) -> Result<dfv_table_kdb::KdbTable, KdbError> {
    parse_kdb_buffer(b, Limits::default())
}
fn col(t: &dfv_table_kdb::KdbTable, i: usize) -> &[Value] {
    &t.columns[i].values
}

/// Every supported atom type, a normal value then the type's null sentinel.
/// Expected values were computed independently with Python's datetime/struct (see comments).
#[test]
fn every_atom_type_and_null_sentinel() {
    let g = [
        0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd,
        0xef,
    ];
    let ns_2024: i64 = 757_382_400_123_456_789; // 2024-01-01T00:00:00.123456789 since 2000-01-01
    let cols = vec![
        bytes(1, &[1, 0]),
        guids(&[g, [0; 16]]),
        bytes(4, &[0, 255]),
        i16s(5, &[-5, i16::MIN]),
        i32s(6, &[-7, i32::MIN]),
        i64s(7, &[1 << 53 | 1, i64::MIN]),
        f32s(&[1.5, f32::NAN]),
        f64s(9, &[-2.25, f64::NAN]),
        bytes(10, b"a "), // a char *vector* keeps its spaces; only a char atom ' ' is null
        syms(&["EURUSD", ""]),
        i64s(12, &[ns_2024, i64::MIN]),
        i32s(13, &[14, i32::MIN]),
        i32s(14, &[8825 - 10957, i32::MIN]), // 2024-02-29
        f64s(15, &[0.5, f64::NAN]),
        i64s(16, &[-90_000_000_000, i64::MIN]),
        i32s(17, &[754, i32::MIN]),    // 12:34
        i32s(18, &[45_296, i32::MIN]), // 12:34:56
        i32s(19, &[45_296_789, i32::MIN]),
    ];
    let names: Vec<String> = (0..cols.len()).map(|i| format!("c{i}")).collect();
    let t = parse(&table(
        &names.iter().map(String::as_str).collect::<Vec<_>>(),
        &cols,
    ))
    .unwrap();
    assert_eq!(t.row_count, 2);
    let types: Vec<i8> = t.columns.iter().map(|c| c.q_type).collect();
    assert_eq!(
        types,
        [
            1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19
        ]
    );
    let first: Vec<Value> = t.columns.iter().map(|c| c.values[0].clone()).collect();
    assert_eq!(
        first,
        [
            Value::Bool(true),
            Value::Guid("12345678-9abc-def0-0123-456789abcdef".into()),
            Value::Byte(0),
            Value::Short(-5),
            Value::Int(-7),
            Value::Long(1 << 53 | 1), // exact above 2^53
            Value::Real(1.5),
            Value::Float(-2.25),
            Value::Char('a'),
            Value::Symbol("EURUSD".into()),
            Value::TimestampMicros(1_704_067_200_123_456),
            Value::MonthDays(11_382),
            Value::DateDays(8_825),
            Value::DatetimeMicros(946_728_000_000_000),
            Value::TimespanNanos(-90_000_000_000),
            Value::MinuteMicros(754 * 60_000_000),
            Value::SecondMicros(45_296_000_000),
            Value::TimeMicros(45_296_789_000),
        ]
    );
    // Bool has no null; byte 255 is a value; every other type nulls.
    assert_eq!(t.columns[0].values[1], Value::Bool(false));
    assert_eq!(t.columns[2].values[1], Value::Byte(255));
    assert_eq!(t.columns[8].values[1], Value::Char(' '));
    for (i, c) in t.columns.iter().enumerate() {
        if ![0, 2, 8].contains(&i) {
            assert_eq!(c.values[1], Value::Null, "column {i}");
        }
    }
}

#[test]
fn months_use_an_exact_calendar_including_years_0_to_99() {
    // Unix day numbers from Python date arithmetic. Year 1 and 50 are where JS Date.UTC differs.
    let months = [0, 14, -1, -13, -23_988, -23_400];
    let want = [10_957, 11_382, 10_926, 10_561, -719_162, -701_265];
    let t = parse(&table(&["m"], &[i32s(13, &months)])).unwrap();
    assert_eq!(col(&t, 0), want.map(Value::MonthDays));
}

#[test]
fn extreme_months_stay_exact_where_js_date_gives_nan() {
    // Python proleptic-Gregorian day counts (independent implementation); the TS returns NaN here.
    let t = parse(&table(&["m"], &[i32s(13, &[i32::MAX, i32::MIN + 1])])).unwrap();
    assert_eq!(
        col(&t, 0),
        [65_362_702_285, -65_362_680_372].map(Value::MonthDays)
    );
}

#[test]
fn timestamp_division_truncates_toward_zero() {
    let t = parse(&table(&["t"], &[i64s(12, &[-1500, 1500, -999])])).unwrap();
    assert_eq!(
        col(&t, 0),
        [
            946_684_799_999_999,
            946_684_800_000_001,
            946_684_800_000_000
        ]
        .map(Value::TimestampMicros)
    );
}

#[test]
fn datetime_rounds_half_up_and_refuses_unrepresentable() {
    // (x + 10957) days in us: .5 us ties round toward +infinity like Math.round.
    let tie = 0.5 / 86_400_000_000.0;
    let t = parse(&table(
        &["d"],
        &[f64s(15, &[-10957.0, -10957.0 + tie, 0.0])],
    ))
    .unwrap();
    assert!(matches!(col(&t, 0)[0], Value::DatetimeMicros(0)));
    assert!(matches!(
        col(&t, 0)[2],
        Value::DatetimeMicros(946_684_800_000_000)
    ));
    // Exact, not double-rounded: day numbers whose f64 arithmetic used to land a microsecond off (see corpus `atoms.z`).
    let exact = |v: f64| match col(&parse(&table(&["d"], &[f64s(15, &[v])])).unwrap(), 0)[0] {
        Value::DatetimeMicros(n) => n,
        _ => unreachable!(),
    };
    assert_eq!(exact(36_690.043_090_324_08), 4_116_704_523_004_000);
    // subnormal, negative-tiny and the largest representable instants stay exact and in range
    assert_eq!(exact(5e-324), 946_684_800_000_000);
    assert_eq!(exact(-5e-324), 946_684_800_000_000);
    assert_eq!(exact(-10957.0), 0);
    assert_eq!(exact(-10957.0 - 1.0 / 86_400.0), -1_000_000);
    for bad in [1e300, f64::INFINITY, f64::NEG_INFINITY, 1e12, -1e12, 2e14] {
        assert_eq!(
            parse(&table(&["d"], &[f64s(15, &[bad])])),
            Err(KdbError::DatetimeOutOfRange)
        );
    }
}

#[test]
fn char_vector_splits_into_code_points_and_ragged_columns_are_refused() {
    let t = parse(&table(&["s"], &[bytes(10, "aé ".as_bytes())])).unwrap();
    assert_eq!(
        col(&t, 0),
        [Value::Char('a'), Value::Char('é'), Value::Char(' ')]
    );
    // 4 bytes but 3 code points: the other column's 4 rows no longer line up.
    let err = parse(&table(
        &["s", "n"],
        &[bytes(10, "aé ".as_bytes()), i32s(6, &[1, 2, 3, 4])],
    ))
    .unwrap_err();
    assert_eq!(err.code(), "kdb_ragged_columns");
}

#[test]
fn null_and_duplicate_column_names() {
    let t = parse(&table(
        &["", "a", "a"],
        &[i32s(6, &[1]), i32s(6, &[2]), i32s(6, &[3])],
    ))
    .unwrap();
    let names: Vec<_> = t.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["column_0", "a", "a"]);
}

#[test]
fn empty_table_and_zero_row_columns() {
    assert_eq!(parse(&table(&[], &[])).unwrap().row_count, 0);
    let t = parse(&table(&["x"], &[f64s(9, &[])])).unwrap();
    assert_eq!((t.row_count, t.columns[0].q_type), (0, 9));
}

#[test]
fn general_list_columns_keep_nested_structure() {
    let nested_dict = [
        vec![99u8],
        syms(&["k"]),
        general(&[atom(-7, &5i64.to_le_bytes())]),
    ]
    .concat();
    let nested_table = [
        vec![98u8, 0, 99],
        syms(&["a"]),
        general(&[i32s(6, &[1, 2])]),
    ]
    .concat();
    let c = general(&[
        atom(-9, &1.5f64.to_le_bytes()),
        atom(-11, b"abc\0"),
        f64s(9, &[1.0, f64::NAN]),
        nested_dict,
        nested_table,
        atom(-6, &i32::MIN.to_le_bytes()),
        atom(-10, b" "),
    ]);
    let t = parse(&table(&["g"], &[c])).unwrap();
    assert_eq!(t.columns[0].q_type, 0);
    let v = col(&t, 0);
    assert_eq!(v[0], Value::Float(1.5));
    assert_eq!(v[1], Value::Symbol("abc".into()));
    assert_eq!(v[2], Value::List(vec![Value::Float(1.0), Value::Null]));
    assert_eq!(
        v[3],
        Value::Dict {
            keys: Box::new(Value::List(vec![Value::Symbol("k".into())])),
            values: Box::new(Value::List(vec![Value::Long(5)])),
        }
    );
    assert!(
        matches!(&v[4], Value::Dict { keys, .. } if **keys == Value::List(vec![Value::Symbol("a".into())]))
    );
    assert_eq!(v[5], Value::Null);
    assert_eq!(v[6], Value::Null); // the space char atom is q's null char
}

#[test]
fn header_variants_are_refused() {
    let mut zipped = b"kxzipped".to_vec();
    zipped.extend([0; 16]);
    assert_eq!(parse(&zipped), Err(KdbError::Compressed));
    for bad in [
        &b""[..],
        &[0xff][..],
        &[0xff, 0x01][..],
        &[0xfe, 0x01, 98][..],
        &[0xff, 0x02, 98][..],
    ] {
        assert_eq!(parse(bad), Err(KdbError::BadHeader), "{bad:?}");
    }
}

#[test]
fn non_table_roots_and_unsupported_objects_are_typed_errors() {
    assert_eq!(
        parse(&[0xff, 1, 99]),
        Err(KdbError::NotATable { found: 99 })
    );
    assert_eq!(
        parse(&[0xff, 1, 9, 0, 0, 0, 0, 0]),
        Err(KdbError::NotATable { found: 9 })
    );
    let in_list = |obj: Vec<u8>| parse(&table(&["g"], &[general(&[obj])]));
    assert_eq!(
        in_list(atom(-128, b"type\0")),
        Err(KdbError::ErrorObject("type".into()))
    );
    assert_eq!(in_list(vec![100, 0]), Err(KdbError::UnsupportedObject(100)));
    assert_eq!(
        in_list(atom(-20, &[0; 8])),
        Err(KdbError::UnsupportedObject(-20))
    );
    assert_eq!(in_list(atom(-3, &[0])), Err(KdbError::UnsupportedAtom(3)));
    // Enumerated symbol column: refused when it has rows, as the TS does; an empty one passes.
    assert_eq!(
        parse(&table(&["e"], &[i32s(20, &[0])])),
        Err(KdbError::UnsupportedAtom(20))
    );
    assert_eq!(
        parse(&table(&["e"], &[i32s(20, &[])])).unwrap().row_count,
        0
    );
    // Enumerated or non-symbol column names.
    let bad_keys = table_with(i32s(6, &[1]), 1, &[i32s(6, &[1])]);
    assert_eq!(parse(&bad_keys).unwrap_err().code(), "kdb_malformed_table");
    let mut wrong_dict = table(&["a"], &[i32s(6, &[1])]);
    wrong_dict[4] = 98;
    assert_eq!(
        parse(&wrong_dict).unwrap_err().code(),
        "kdb_malformed_table"
    );
    let count = table_with(sym_vec(&["a"]), 2, &[i32s(6, &[1])]);
    assert_eq!(parse(&count).unwrap_err().code(), "kdb_malformed_table");
}

#[test]
fn every_truncation_is_an_error_not_a_panic() {
    let full = table(
        &["a", "b", "c", "d"],
        &[
            i32s(6, &[1, 2, 3]),
            syms(&["x", "yy", ""]),
            general(&[
                atom(-9, &1f64.to_le_bytes()),
                f64s(9, &[1.0]),
                atom(-11, b"s\0"),
            ]),
            bytes(10, b"abc"),
        ],
    );
    assert!(parse(&full).is_ok());
    for n in 0..full.len() {
        assert!(parse(&full[..n]).is_err(), "prefix {n}");
    }
}

#[test]
fn corrupt_lengths_cannot_force_allocation() {
    let huge = |t: u8, n: i32| {
        let mut col = vec![t, 0];
        col.extend(n.to_le_bytes());
        col.extend([0u8; 8]);
        parse(&table(&["x"], &[col]))
    };
    for t in [1u8, 9, 11, 0, 10] {
        assert!(
            matches!(huge(t, i32::MAX), Err(KdbError::Truncated { .. })),
            "type {t}"
        );
    }
    assert!(matches!(
        huge(9, -1),
        Err(KdbError::BadLength { len: -1, .. })
    ));
    assert!(matches!(huge(20, -5), Err(KdbError::BadLength { .. })));
    // A column count that disagrees with the names.
    let t = table_with(sym_vec(&["a"]), -1, &[]);
    assert!(matches!(parse(&t), Err(KdbError::BadLength { .. })));
}

#[test]
fn limits_cap_values_depth_and_size() {
    let t = table(&["a"], &[i32s(6, &[1, 2, 3, 4])]);
    let small = Limits {
        max_values: 3,
        ..Limits::default()
    };
    assert_eq!(
        parse_kdb_buffer(&t, small),
        Err(KdbError::TooManyValues { max: 3 })
    );
    let tiny = Limits {
        max_file_bytes: 10,
        ..Limits::default()
    };
    assert!(matches!(
        parse_kdb_buffer(&t, tiny),
        Err(KdbError::FileTooLarge { max: 10, .. })
    ));
    // 100 nested one-element general lists overflow the depth cap rather than the stack.
    let mut deep = atom(-6, &0i32.to_le_bytes());
    for _ in 0..100 {
        deep = general(&[deep]);
    }
    assert_eq!(
        parse(&table(&["d"], &[general(&[deep])])),
        Err(KdbError::TooDeep { max: 64 })
    );
}

#[test]
fn file_api_reads_regular_files_only() {
    let dir = std::env::temp_dir().join(format!("dfv-kdb-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("trades"); // kdb+ files are extensionless
    std::fs::write(&file, table(&["a"], &[i32s(6, &[7])])).unwrap();
    assert_eq!(
        parse_kdb_file(&file, Limits::default()).unwrap().columns[0].values,
        [Value::Int(7)]
    );
    assert_eq!(
        parse_kdb_file(&dir, Limits::default()),
        Err(KdbError::NotRegularFile)
    );
    assert!(matches!(
        parse_kdb_file(&dir.join("missing"), Limits::default()),
        Err(KdbError::Io(_))
    ));
    let tiny = Limits {
        max_file_bytes: 4,
        ..Limits::default()
    };
    assert!(matches!(
        parse_kdb_file(&file, tiny),
        Err(KdbError::FileTooLarge { .. })
    ));
    let fifo = dir.join("pipe");
    if std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .is_ok_and(|s| s.success())
    {
        assert_eq!(
            parse_kdb_file(&fifo, Limits::default()),
            Err(KdbError::NotRegularFile)
        );
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn nothing_in_the_crate_writes() {
    let writable = std::hint::black_box(dfv_table_kdb::WRITABLE);
    assert!(!writable);
}

/// Deterministic mutation fuzz: any byte soup returns Ok or Err, never panics or runs away.
#[test]
fn mutated_files_never_panic() {
    let base = table(
        &["a", "b", "c"],
        &[
            f64s(15, &[0.25, -3.5]),
            syms(&["x", "yy"]),
            general(&[
                atom(-9, &1f64.to_le_bytes()),
                [
                    vec![98u8, 0, 99],
                    syms(&["k"]),
                    general(&[i32s(6, &[1, 2])]),
                ]
                .concat(),
            ]),
        ],
    );
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let limits = Limits {
        max_values: 10_000,
        ..Limits::default()
    };
    for _ in 0..50_000 {
        let mut b = base.clone();
        for _ in 0..1 + rng.next() % 4 {
            let i = (rng.next() as usize) % b.len();
            b[i] = rng.next() as u8;
        }
        if rng.next().is_multiple_of(5) {
            b.truncate((rng.next() as usize) % b.len());
        }
        let _ = parse_kdb_buffer(&b, limits);
    }
}

#[test]
fn kdb_paths_are_routed_by_folder_and_named_by_file_stem() {
    use dfv_table_kdb::{is_kdb_path, table_name};
    use std::path::Path;
    assert!(is_kdb_path(Path::new("/data/db_kdb/trade")));
    assert!(is_kdb_path(Path::new("/data/2024_kdb/deep/er/trade")));
    assert!(
        !is_kdb_path(Path::new("/data/db_kdb/trade.csv")),
        "extension means another kind"
    );
    assert!(!is_kdb_path(Path::new("/data/db/trade")));
    assert!(
        !is_kdb_path(Path::new("/data/kdb/trade")),
        "the folder name must end in _kdb"
    );
    assert!(!is_kdb_path(Path::new("/")));
    assert_eq!(
        table_name(Path::new("/d/x_kdb/trade")).as_deref(),
        Some("trade")
    );
    assert_eq!(
        table_name(Path::new("/d/x_kdb/trade.2024")).as_deref(),
        Some("trade")
    );
    assert_eq!(
        table_name(Path::new("/d/x_kdb/.hidden")).as_deref(),
        Some(".hidden")
    );
    assert_eq!(dfv_table_kdb::WRITE_MODE, "none");
}

/// No write capability exists anywhere in the crate: no file-creating or mutating API is referenced in the sources,
/// and reading the corpus leaves every byte and every directory entry untouched.
#[test]
fn the_crate_has_no_write_path_and_reading_changes_nothing() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/kdb.rs")).unwrap();
    for banned in [
        "File::create",
        "OpenOptions",
        "fs::write",
        "remove_file",
        "fs::rename",
        "create_dir",
        "set_permissions",
        "write_all",
    ] {
        assert!(!src.contains(banned), "{banned}");
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus");
    let snapshot = || -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
        let mut v: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap())
            .map(|e| {
                (
                    e.file_name().to_string_lossy().into_owned(),
                    std::fs::read(e.path()).unwrap(),
                    e.metadata().unwrap().modified().unwrap(),
                )
            })
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    };
    let before = snapshot();
    for (name, ..) in before.iter().filter(|(n, ..)| n.ends_with(".kdb")) {
        let _ = parse_kdb_file(&dir.join(name), Limits::default());
    }
    assert!(before == snapshot());
}
