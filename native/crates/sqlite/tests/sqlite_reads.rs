//! Ports every case of test/sqliteUntypedColumns.test.ts. Expected values come from a reader that is not this
//! crate: the system `sqlite3` CLI and Python's sqlite3 module (override with DFV_REF_PYTHON).
use dfv_table_sqlite::*;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

struct Dir(PathBuf);
impl Dir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("dfv-sqlite-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn db(&self, name: &str, statements: &[&str]) -> PathBuf {
        let path = self.0.join(name);
        let c = Connection::open(&path).unwrap();
        for s in statements {
            c.execute_batch(s).unwrap();
        }
        path
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ =
            std::fs::set_permissions(&self.0, std::os::unix::fs::PermissionsExt::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn open(path: &Path) -> Connection {
    open_read_only(path, OpenMode::ReadOnly, Duration::ZERO).unwrap()
}
fn cli(path: &Path, sql: &str) -> String {
    let out = Command::new("sqlite3")
        .arg("-readonly")
        .arg(path)
        .arg(sql)
        .output()
        .expect("system sqlite3 CLI");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim_end().to_owned()
}
fn text(s: &str) -> Cell {
    Cell::Text(s.to_owned())
}

const FOREIGN: &[&str] = &[
    "create table places (id, name, value real, raw blob)",
    "insert into places values ('0007', 'İstanbul', 1.5, x'c4b0ff')",
    "insert into places values ('0008', 'Ankara', null, null)",
    "create table counts (label, n)",
    "insert into counts values ('a', 1)",
    "insert into counts values ('b', 22)",
    "create table money (amount)",
    "insert into money values (1)",
    "insert into money values (2.5)",
    "create table mixed (v)",
    "insert into mixed values ('İzmir')",
    "insert into mixed values (5)",
];

fn foreign(tag: &str) -> (Dir, PathBuf) {
    let d = Dir::new(tag);
    let p = d.db("f.sqlite", FOREIGN);
    (d, p)
}

#[test]
fn text_in_an_untyped_column_reads_as_that_text_not_bytes() {
    let (_d, path) = foreign("text");
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(plan["places"].retyped["id"], Retype::Varchar);
    assert_eq!(plan["places"].retyped["name"], Retype::Varchar);
    let (rows, truncated) = read_rows(&c, "places", &plan["places"], 10).unwrap();
    assert!(!truncated);
    assert_eq!(rows[0][..2], [text("0007"), text("İstanbul")]); // leading zeros kept: text, not number
    assert_eq!(rows[1][0], text("0008"));
    // independent reader agrees on class and bytes
    assert_eq!(
        cli(
            &path,
            "select typeof(name), hex(name) from places where id = '0007'"
        ),
        "text|C4B0737461 6E62756C".replace(' ', "")
    );
}

#[test]
fn such_a_column_can_be_matched_by_a_non_ascii_value() {
    let (_d, path) = foreign("filter");
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    // The query that failed outright under DuckDB ("Invalid byte encountered in STRING -> BLOB conversion").
    let got = find_row(
        &c,
        "places",
        &plan["places"],
        &[("name".into(), text("İstanbul"))],
    )
    .unwrap();
    assert_eq!(got, Lookup::One(1));
    let (rows, _) = read_rows(&c, "places", &plan["places"], 10).unwrap();
    assert_eq!(rows[0][2], Cell::Real(1.5));
}

#[test]
fn whole_numbers_in_an_untyped_column_are_numbers() {
    let (_d, path) = foreign("int");
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(plan["counts"].retyped["n"], Retype::BigInt);
    let (rows, _) = read_rows(&c, "counts", &plan["counts"], 10).unwrap();
    let sum: i64 = rows
        .iter()
        .map(|r| {
            if let Cell::Integer(i) = r[1] {
                i
            } else {
                panic!()
            }
        })
        .sum();
    assert_eq!(sum, 23);
    assert_eq!(cli(&path, "select sum(n) from counts"), "23");
}

#[test]
fn whole_numbers_and_decimals_read_as_numbers() {
    let (_d, path) = foreign("double");
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(plan["money"].retyped["amount"], Retype::Double);
    let (rows, _) = read_rows(&c, "money", &plan["money"], 10).unwrap();
    assert_eq!(rows, vec![vec![Cell::Real(1.0)], vec![Cell::Real(2.5)]]);
}

#[test]
fn control_a_column_mixing_text_and_numbers_is_not_guessed_and_keeps_each_cell_exact() {
    let (_d, path) = foreign("mixed");
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert!(plan["mixed"].retyped.is_empty());
    // Unlike the DuckDB path (which showed \xC4... bytes), each cell keeps its own storage class.
    let (rows, _) = read_rows(&c, "mixed", &plan["mixed"], 10).unwrap();
    assert_eq!(rows, vec![vec![text("İzmir")], vec![Cell::Integer(5)]]);
    assert!(!retype_notices(&plan).iter().any(|n| n.contains("\"v\"")));
}

#[test]
fn control_a_declared_blob_stays_a_blob() {
    let (_d, path) = foreign("blob");
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert!(!plan["places"].retyped.contains_key("raw"));
    let (rows, _) = read_rows(&c, "places", &plan["places"], 10).unwrap();
    assert_eq!(rows[0][3], Cell::Blob(vec![0xc4, 0xb0, 0xff]));
    assert_eq!(rows[1][3], Cell::Null);
}

#[test]
fn the_file_is_told_about() {
    let (_d, path) = foreign("notice");
    let notices = retype_notices(&plan_tables(&open(&path), None).unwrap()).join("\n");
    assert!(
        notices.contains("places") && notices.contains("declares no type"),
        "{notices}"
    );
}

#[test]
fn lookups_find_one_row_across_untyped_and_typed_neighbours_and_report_no_match() {
    let (_d, path) = foreign("lookup");
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    let key = |value: f64| {
        vec![
            ("id".into(), text("0007")),
            ("name".into(), text("İstanbul")),
            ("value".into(), Cell::Real(value)),
        ]
    };
    assert_eq!(
        find_row(&c, "places", &plan["places"], &key(1.5)).unwrap(),
        Lookup::One(1)
    );
    assert_eq!(
        find_row(&c, "places", &plan["places"], &key(99.0)).unwrap(),
        Lookup::NoMatch
    );
    // null-safe
    let nul = [("id".into(), text("0008")), ("value".into(), Cell::Null)];
    assert_eq!(
        find_row(&c, "places", &plan["places"], &nul).unwrap(),
        Lookup::One(2)
    );
}

#[test]
fn an_edit_to_an_untyped_numeric_column_is_refused_text_columns_are_not() {
    let (_d, path) = foreign("editable");
    let plan = plan_tables(&open(&path), None).unwrap();
    assert!(
        matches!(check_editable(&plan["counts"], "n"), Err(SqliteError::UntypedNumbers(c)) if c == "n")
    );
    assert!(matches!(
        check_editable(&plan["money"], "amount"),
        Err(SqliteError::UntypedNumbers(_))
    ));
    assert!(check_editable(&plan["places"], "name").is_ok());
    assert!(check_editable(&plan["places"], "value").is_ok());
}

#[test]
fn two_identical_rows_are_ambiguous() {
    let d = Dir::new("twins");
    let path = d.db(
        "t.sqlite",
        &[
            "create table twins (name)",
            "insert into twins values ('İstanbul')",
            "insert into twins values ('İstanbul')",
        ],
    );
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(
        find_row(
            &c,
            "twins",
            &plan["twins"],
            &[("name".into(), text("İstanbul"))]
        )
        .unwrap(),
        Lookup::Ambiguous
    );
}

#[test]
fn refresh_picks_up_new_rows_and_new_tables() {
    let (_d, path) = foreign("refresh");
    let c = open(&path);
    let first = plan_tables(&c, None).unwrap();
    assert_eq!(
        read_rows(&c, "places", &first["places"], 10)
            .unwrap()
            .0
            .len(),
        2
    );
    let w = Connection::open(&path).unwrap();
    w.execute_batch("insert into places values ('0009', 'Şanlıurfa', 3.5, null); create table later (city); insert into later values ('Trabzon')").unwrap();
    let second = plan_tables(&c, Some(&first)).unwrap();
    assert!(second.contains_key("later"));
    let (rows, _) = read_rows(&c, "places", &second["places"], 10).unwrap();
    assert_eq!(rows[2][1], text("Şanlıurfa"));
    assert_eq!(
        read_rows(&c, "later", &second["later"], 10).unwrap().0,
        vec![vec![text("Trabzon")]]
    );
}

#[test]
fn refresh_rechecks_storage_class_changes_with_unchanged_column_names() {
    type Case<'a> = (&'a str, &'a str, &'a str, Retype, Option<Retype>);
    let cases: [Case; 4] = [
        (
            "integer-to-text",
            "create table t(v); insert into t values(1)",
            "insert into t values('text')",
            Retype::BigInt,
            None,
        ),
        (
            "text-to-integer",
            "create table t(v); insert into t values('a')",
            "delete from t; insert into t values(42)",
            Retype::Varchar,
            Some(Retype::BigInt),
        ),
        (
            "null-to-real",
            "create table t(v); insert into t values(null)",
            "insert into t values(1.2345678901234567)",
            Retype::Varchar,
            Some(Retype::Double),
        ),
        (
            "declared-type",
            "create table t(v); insert into t values('old')",
            "drop table t; create table t(v text); insert into t values('new')",
            Retype::Varchar,
            None,
        ),
    ];
    for (label, initial, change, _before, after) in cases {
        let d = Dir::new(label);
        let path = d.db("r.sqlite", &[initial]);
        let c = open(&path);
        let first = plan_tables(&c, None).unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch(change)
            .unwrap();
        for _ in 0..2 {
            // second pass proves a reused plan is still right
            let plan = plan_tables(&c, Some(&first)).unwrap();
            assert_eq!(plan["t"].retyped.get("v").copied(), after, "{label}");
        }
    }
}

#[test]
fn control_a_fully_declared_file_is_unaffected() {
    let d = Dir::new("typed");
    let path = d.db(
        "t.sqlite",
        &[
            "create table bars (symbol text, close real, n integer)",
            "insert into bars values ('İSTANBUL', 1.5, 3)",
            "insert into bars values ('AKBNK', 2.5, 4)",
        ],
    );
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert!(plan["bars"].retyped.is_empty() && retype_notices(&plan).is_empty());
    assert_eq!(plan["bars"].identity, RowIdentity::Alias("rowid"));
    let (rows, _) = read_rows(&c, "bars", &plan["bars"], 10).unwrap();
    assert_eq!(
        rows[0],
        vec![text("İSTANBUL"), Cell::Real(1.5), Cell::Integer(3)]
    );
    // a declared table skips the value scan on refresh: the plan is reused unchanged
    assert_eq!(plan_tables(&c, Some(&plan)).unwrap(), plan);
}

#[test]
fn a_user_defined_rowid_cannot_redirect_a_lookup_to_multiple_rows() {
    for shadow in ["rowid", "RoWiD"] {
        let d = Dir::new("shadow");
        let path = d.db(
            "s.sqlite",
            &[
                &format!("create table t ({shadow} integer, name text, value text)"),
                "insert into t values (7, 'a', 'old'), (7, 'b', 'old')",
            ],
        );
        let c = open(&path);
        let plan = plan_tables(&c, None).unwrap();
        // Fallback: the `oid` alias is not shadowed, so identity still resolves, to the real rowid.
        assert_eq!(plan["t"].identity, RowIdentity::Alias("oid"), "{shadow}");
        let by_name = find_row(&c, "t", &plan["t"], &[("name".into(), text("a"))]).unwrap();
        assert_eq!(by_name, Lookup::One(1));
        // The user column 7 matches two rows by value, never by identity: still ambiguous, not "row 7".
        assert_eq!(
            find_row(&c, "t", &plan["t"], &[(shadow.into(), Cell::Integer(7))]).unwrap(),
            Lookup::Ambiguous
        );
    }
}

#[test]
fn all_three_aliases_shadowed_refuses_and_special_tables_have_no_identity() {
    let d = Dir::new("noid");
    let path = d.db(
        "n.sqlite",
        &[
            "create table all3 (rowid, oid, _rowid_, x)",
            "insert into all3 values (1, 2, 3, 4)",
            "create table wr (k text primary key, v) without rowid",
            "create table pkalias (rowid integer primary key, v)",
            "create view vw as select v from pkalias",
        ],
    );
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(
        plan["all3"].identity,
        RowIdentity::Unavailable(NoIdentity::Shadowed)
    );
    assert_eq!(
        plan["wr"].identity,
        RowIdentity::Unavailable(NoIdentity::WithoutRowid)
    );
    assert_eq!(
        plan["vw"].identity,
        RowIdentity::Unavailable(NoIdentity::View)
    );
    // an INTEGER PRIMARY KEY named rowid IS the rowid, so it is not shadowing
    assert_eq!(plan["pkalias"].identity, RowIdentity::Alias("rowid"));
    assert!(matches!(
        find_row(&c, "all3", &plan["all3"], &[("x".into(), Cell::Integer(4))]),
        Err(SqliteError::NoIdentity(NoIdentity::Shadowed))
    ));
    assert!(matches!(
        find_row(&c, "wr", &plan["wr"], &[]),
        Err(SqliteError::NoIdentity(NoIdentity::WithoutRowid))
    ));
}

fn python() -> String {
    std::env::var("DFV_REF_PYTHON").unwrap_or_else(|_| {
        "/Users/macc/Desktop/Kod/.codex-work/pdf-reference-env-20261025/myproject/bin/python".into()
    })
}
/// IEEE-754 bit patterns of `select v from t order by id`, read by Python's sqlite3 (a different SQLite build).
fn python_bits(path: &Path) -> Vec<Option<u64>> {
    let code = "import sqlite3,struct,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nfor (v,) in c.execute('select v from t order by id'):\n print('N' if v is None else struct.unpack('<Q',struct.pack('<d',v))[0])";
    let out = Command::new(python())
        .args(["-B", "-I", "-c", code])
        .arg(path)
        .output()
        .expect("reference python");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| (l != "N").then(|| l.parse().unwrap()))
        .collect()
}

#[test]
fn untyped_reals_round_trip_exactly_including_first_null_and_exponent_extremes() {
    let values = [
        1.2345678901234567,
        f64::from_bits(1),
        f64::MAX,
        -1.7976931348623157e308,
        2.2250738585072014e-308,
        0.10000000000000002,
    ];
    let d = Dir::new("real");
    let path = d.db(
        "r.sqlite",
        &[
            "create table t (id integer, v)",
            "insert into t values (0, null)",
        ],
    );
    let w = Connection::open(&path).unwrap();
    for (i, v) in values.iter().enumerate() {
        w.execute(
            "insert into t values (?1, ?2)",
            rusqlite::params![i as i64 + 1, v],
        )
        .unwrap();
    }
    drop(w);
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(plan["t"].retyped["v"], Retype::Double);
    let (rows, _) = read_rows(&c, "t", &plan["t"], 100).unwrap();
    let ours: Vec<Option<u64>> = rows
        .iter()
        .map(|r| {
            if let Cell::Real(x) = r[1] {
                Some(x.to_bits())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(ours, python_bits(&path));
    assert_eq!(ours[1], Some(values[0].to_bits()));
    // capped reads report truncation and release the SQLite snapshot: a writer can then take an exclusive lock
    for _ in 0..3 {
        let (rows, truncated) = read_rows(&c, "t", &plan["t"], 2).unwrap();
        assert!(truncated && rows.len() == 2);
    }
    let w = Connection::open(&path).unwrap();
    w.execute_batch("begin exclusive; commit").unwrap();
}

#[test]
fn mixed_numeric_values_with_wide_integers_are_exact_text_and_not_editable() {
    let d = Dir::new("wide");
    let path = d.db("w.sqlite", &["create table t (id integer, v)", "insert into t values (1, 9007199254740993), (2, 2.5), (3, -9223372036854775808), (4, null)"]);
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert!(plan["t"].numeric_text.contains("v"));
    let (rows, _) = read_rows(&c, "t", &plan["t"], 10).unwrap();
    let v: Vec<Cell> = rows.into_iter().map(|r| r[1].clone()).collect();
    assert_eq!(
        v,
        vec![
            text("9007199254740993"),
            text("2.5"),
            text("-9223372036854775808"),
            Cell::Null
        ]
    );
    assert!(
        retype_notices(&plan)
            .iter()
            .any(|n| n.contains("exact numeric text"))
    );
    assert!(matches!(
        check_editable(&plan["t"], "v"),
        Err(SqliteError::UntypedNumbers(_))
    ));
    // the exact text finds its row again
    assert_eq!(
        find_row(
            &c,
            "t",
            &plan["t"],
            &[("v".into(), text("9007199254740993"))]
        )
        .unwrap(),
        Lookup::One(1)
    );
    assert_eq!(
        find_row(&c, "t", &plan["t"], &[("v".into(), text("2.5"))]).unwrap(),
        Lookup::One(2)
    );
    assert_eq!(
        cli(&path, "select cast(v as text) from t where id = 1"),
        "9007199254740993"
    );
}

#[test]
fn exact_numeric_reading_preserves_declared_neighbours_and_blob_bytes() {
    let d = Dir::new("neighbours");
    let path = d.db(
        "n.sqlite",
        &[
            "create table t (n, label text, raw blob, count integer, amount real)",
            "insert into t values (null,null,null,null,null), (1.2345678901234567,'İstanbul',x'00ff',42,1.2345678901234567)",
        ],
    );
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    let (rows, _) = read_rows(&c, "t", &plan["t"], 10).unwrap();
    assert_eq!(rows[0], vec![Cell::Null; 5]);
    assert_eq!(
        rows[1],
        vec![
            Cell::Real(1.2345678901234567),
            text("İstanbul"),
            Cell::Blob(vec![0, 0xff]),
            Cell::Integer(42),
            Cell::Real(1.2345678901234567)
        ]
    );
    let key = [
        ("n".into(), Cell::Real(1.2345678901234567)),
        ("label".into(), text("İstanbul")),
        ("count".into(), Cell::Integer(42)),
    ];
    assert_eq!(find_row(&c, "t", &plan["t"], &key).unwrap(), Lookup::One(2));
}

#[test]
fn eight_thousand_binary64_patterns_match_the_independent_reader_bit_for_bit() {
    let d = Dir::new("corpus");
    let path = d.db("b.sqlite", &["create table t (id integer, v)"]);
    let w = Connection::open(&path).unwrap();
    w.execute_batch("begin").unwrap();
    for i in 0u64..8192 {
        let fraction = (i + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15) & ((1 << 52) - 1);
        let bits = ((i % 2) << 63) | ((i % 2047) << 52) | fraction;
        w.execute(
            "insert into t values (?1, ?2)",
            rusqlite::params![i as i64, f64::from_bits(bits)],
        )
        .unwrap();
    }
    w.execute_batch("commit").unwrap();
    drop(w);
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    let (rows, truncated) = read_rows(&c, "t", &plan["t"], usize::MAX - 1).unwrap();
    assert!(!truncated);
    // Subnormals and every exponent: bitwise, so -0.0 and NaN payloads cannot hide behind ==.
    let ours: Vec<Option<u64>> = rows
        .iter()
        .map(|r| match r[1] {
            Cell::Real(x) => Some(x.to_bits()),
            _ => None,
        })
        .collect();
    assert_eq!(ours, python_bits(&path));
    assert_eq!(ours.len(), 8192);
}

#[test]
fn text_that_is_not_utf8_is_kept_as_bytes_and_never_retypes_the_column() {
    let d = Dir::new("badutf8");
    let path = d.db(
        "u.sqlite",
        &[
            "create table t (v)",
            "insert into t values (cast(x'c4b0ff' as text)), ('ok')",
        ],
    );
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert!(plan["t"].retyped.is_empty());
    let (rows, _) = read_rows(&c, "t", &plan["t"], 10).unwrap();
    assert_eq!(
        rows,
        vec![vec![Cell::Blob(vec![0xc4, 0xb0, 0xff])], vec![text("ok")]]
    );
    assert_eq!(
        cli(&path, "select typeof(v), hex(v) from t limit 1"),
        "text|C4B0FF"
    );
}

#[test]
fn generated_columns_are_read_in_order() {
    let d = Dir::new("generated");
    let path = d.db(
        "g.sqlite",
        &[
            "create table t (a integer, b integer generated always as (a * 2) virtual)",
            "insert into t(a) values (21)",
        ],
    );
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(
        plan["t"]
            .columns
            .iter()
            .map(|x| x.name.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(
        read_rows(&c, "t", &plan["t"], 10).unwrap().0,
        vec![vec![Cell::Integer(21), Cell::Integer(42)]]
    );
}

#[test]
fn identifiers_with_quotes_and_keywords_are_quoted_safely() {
    let d = Dir::new("quote");
    let path = d.db(
        "q.sqlite",
        &[
            "create table \"we\"\"ird; drop\" (\"select\", \"a\"\"b\" text)",
            "insert into \"we\"\"ird; drop\" values ('x', 'y')",
        ],
    );
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    let table = "we\"ird; drop";
    let (rows, _) = read_rows(&c, table, &plan[table], 10).unwrap();
    assert_eq!(rows, vec![vec![text("x"), text("y")]]);
    assert_eq!(
        find_row(&c, table, &plan[table], &[("a\"b".into(), text("y"))]).unwrap(),
        Lookup::One(1)
    );
    assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
}

#[test]
fn opening_reports_typed_outcomes() {
    let d = Dir::new("open");
    assert!(matches!(
        open_read_only(
            &d.0.join("missing.sqlite"),
            OpenMode::ReadOnly,
            Duration::ZERO
        ),
        Err(SqliteError::NotFound(_))
    ));
    let garbage = d.0.join("garbage.sqlite");
    std::fs::write(&garbage, vec![b'x'; 4096]).unwrap();
    assert_eq!(
        open_read_only(&garbage, OpenMode::ReadOnly, Duration::ZERO).unwrap_err(),
        SqliteError::NotADatabase
    );
    // a writer holding an exclusive lock on a rollback-journal database
    let path = d.db(
        "l.sqlite",
        &["create table t (a)", "insert into t values (1)"],
    );
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("begin exclusive").unwrap();
    assert_eq!(
        open_read_only(&path, OpenMode::ReadOnly, Duration::ZERO).unwrap_err(),
        SqliteError::Locked
    );
    writer.execute_batch("rollback").unwrap();
    assert!(open_read_only(&path, OpenMode::ReadOnly, Duration::ZERO).is_ok());
}

#[test]
fn wal_files_read_committed_content_unless_opened_immutable_and_unreadable_without_shm_is_typed() {
    let d = Dir::new("wal");
    let path = d.db(
        "w.sqlite",
        &["create table t (a text)", "insert into t values ('base')"],
    );
    let writer = Connection::open(&path).unwrap();
    writer
        .execute_batch("pragma journal_mode=wal; insert into t values ('in-wal')")
        .unwrap();
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(read_rows(&c, "t", &plan["t"], 10).unwrap().0.len(), 2);
    // immutable ignores the WAL by design: it only sees the checkpointed base. Document, do not rely on it.
    let imm = open_read_only(&path, OpenMode::Immutable, Duration::ZERO).unwrap();
    let iplan = plan_tables(&imm, None).unwrap();
    assert_eq!(read_rows(&imm, "t", &iplan["t"], 10).unwrap().0.len(), 1);
    drop((c, imm, writer));
    // fully closed WAL database in a read-only directory: -shm cannot be created
    let quiet = Dir::new("walro");
    let p2 = quiet.db(
        "w.sqlite",
        &[
            "pragma journal_mode=wal",
            "create table t (a)",
            "insert into t values (1)",
        ],
    );
    assert!(!quiet.0.join("w.sqlite-wal").exists());
    std::fs::set_permissions(
        &quiet.0,
        std::os::unix::fs::PermissionsExt::from_mode(0o555),
    )
    .unwrap();
    let outcome = open_read_only(&p2, OpenMode::ReadOnly, Duration::ZERO);
    assert!(
        matches!(outcome, Err(SqliteError::NeedsWrite(_))),
        "{outcome:?}"
    );
    assert!(open_read_only(&p2, OpenMode::Immutable, Duration::ZERO).is_ok());
}

#[test]
fn a_table_changed_after_planning_is_reported_not_misread() {
    let d = Dir::new("changing");
    let path = d.db(
        "c.sqlite",
        &[
            "create table t (a text, b text)",
            "insert into t values ('x','y')",
        ],
    );
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch("drop table t; create table t (a text); insert into t values ('x')")
        .unwrap();
    assert_eq!(
        read_rows(&c, "t", &plan["t"], 10).unwrap_err(),
        SqliteError::SchemaChanged
    );
    assert_eq!(
        find_row(&c, "t", &plan["t"], &[("b".into(), text("y"))]).unwrap_err(),
        SqliteError::SchemaChanged
    );
    Connection::open(&path)
        .unwrap()
        .execute_batch("drop table t")
        .unwrap();
    assert_eq!(
        read_rows(&c, "t", &plan["t"], 10).unwrap_err(),
        SqliteError::SchemaChanged
    );
}

#[test]
fn the_source_file_is_never_modified() {
    let (_d, path) = foreign("hash");
    let before = std::fs::read(&path).unwrap();
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    for (table, t) in &plan {
        read_rows(&c, table, t, 100).unwrap();
        let _ = find_row(&c, table, t, &[]);
    }
    drop(c);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!path.with_extension("sqlite-journal").exists());
}

#[test]
fn stale_rowid_aliases_are_refused_without_disturbing_the_callers_transaction() {
    let d = Dir::new("stale-alias");
    let path = d.db(
        "r.sqlite",
        &["create table t(a text)", "insert into t values ('x')"],
    );
    let c = open(&path);
    let old = plan_tables(&c, None).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch("alter table t add column rowid integer; update t set rowid=999")
        .unwrap();
    assert_eq!(
        find_row(&c, "t", &old["t"], &[("a".into(), text("x"))]).unwrap_err(),
        SqliteError::SchemaChanged
    );
    assert_eq!(
        read_rows(&c, "t", &old["t"], 10).unwrap_err(),
        SqliteError::SchemaChanged
    );
    let current = plan_tables(&c, None).unwrap();
    let transaction = c.unchecked_transaction().unwrap();
    assert_eq!(
        find_row(&transaction, "t", &current["t"], &[("a".into(), text("x"))]).unwrap(),
        Lookup::One(1)
    );
    assert_eq!(
        read_rows(&transaction, "t", &current["t"], 10)
            .unwrap()
            .0
            .len(),
        1
    );
    assert!(!transaction.is_autocommit());
    transaction.rollback().unwrap();
    assert_eq!(
        c.query_row("select rowid from t", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        999
    );
}

#[test]
fn refresh_rechecks_row_identity_when_declared_columns_stay_the_same() {
    let d = Dir::new("identity-refresh");
    let path = d.db(
        "r.sqlite",
        &[
            "create table t(a integer primary key)",
            "insert into t values (1)",
        ],
    );
    let c = open(&path);
    let old = plan_tables(&c, None).unwrap();
    Connection::open(&path).unwrap().execute_batch("drop table t; create table t(a integer primary key) without rowid; insert into t values (1)").unwrap();
    let current = plan_tables(&c, Some(&old)).unwrap();
    assert_eq!(current["t"].columns, old["t"].columns);
    assert_eq!(
        current["t"].identity,
        RowIdentity::Unavailable(NoIdentity::WithoutRowid)
    );
    assert_eq!(
        find_row(&c, "t", &current["t"], &[("a".into(), Cell::Integer(1))]).unwrap_err(),
        SqliteError::NoIdentity(NoIdentity::WithoutRowid)
    );
}

#[test]
fn type_for_classes_matches_the_reference_table() {
    use Retype::*;
    let cases: &[(&[&str], Option<Retype>)] = &[
        (&[], None),
        (&["null"], None),
        (&["text"], Some(Varchar)),
        (&["text", "null"], Some(Varchar)),
        (&["integer"], Some(BigInt)),
        (&["integer", "real"], Some(Double)),
        (&["real"], Some(Double)),
        (&["text", "integer"], None),
        (&["blob"], None),
        (&["integer", "blob"], None),
    ];
    for (classes, want) in cases {
        assert_eq!(type_for_classes(classes), *want, "{classes:?}");
    }
}
