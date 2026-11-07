//! Ports the write cases of test/sqliteUntypedColumns.test.ts and test/editIntegrity.test.ts (INT-02) and adds the
//! D3.14 kill/lock/replace cases. Expected values come from readers that are not this crate: Python's sqlite3 module
//! (override with DFV_REF_PYTHON) and the system `sqlite3` CLI. Builds only with `--features test-mutations`.
use dfv_table_db_write::*;
use dfv_table_sqlite::*;
use rusqlite::Connection;
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

struct Dir(PathBuf);
impl Dir {
    fn new(tag: &str) -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "dfv-dbw-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
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
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const DUMP: &str = r#"
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.text_factory=bytes
print('INTEGRITY',c.execute('pragma integrity_check').fetchall()[0][0].decode())
for n,s in c.execute("select name,sql from sqlite_master order by name").fetchall(): print('SCHEMA',n.decode(),(s or b'').decode())
for (t,) in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'").fetchall():
    t=t.decode(); cols=[r[1].decode() for r in c.execute('pragma table_info("%s")'%t)]
    if not cols: continue
    q='select rowid,'+','.join('"%s",typeof("%s")'%(x,x) for x in cols)+' from "%s" order by rowid'%t
    try: rows=c.execute(q).fetchall()
    except sqlite3.Error: rows=c.execute(q.replace('rowid,','0,',1).replace(' order by rowid','')).fetchall()
    for r in rows:
        for i,x in enumerate(cols):
            v=r[1+2*i]; v=v.hex() if isinstance(v,bytes) else (float.hex(v) if isinstance(v,float) else repr(v))
            print('CELL',t,r[0],x,r[2+2*i].decode(),v)
"#;

/// Everything in the database as an independent reader sees it: integrity, schema, every cell with its storage class.
fn dump(path: &Path) -> BTreeSet<String> {
    let python = std::env::var("DFV_REF_PYTHON").unwrap_or_else(|_| {
        "/Users/macc/Desktop/Kod/.codex-work/pdf-reference-env-20261025/myproject/bin/python".into()
    });
    let out = Command::new(python)
        .args(["-I", "-B", "-c", DUMP])
        .arg(path)
        .output()
        .expect("reference python");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let lines: BTreeSet<String> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    assert!(lines.contains("INTEGRITY ok"), "integrity_check: {lines:?}");
    lines
}
fn cli(path: &Path, sql: &str) -> String {
    let out = Command::new("sqlite3")
        .arg("-readonly")
        .arg(path)
        .arg(sql)
        .output()
        .expect("sqlite3 CLI");
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
fn setup(path: &Path) -> (Plan, FileStamp) {
    let r = open_read_only(path, OpenMode::ReadOnly, Duration::ZERO).unwrap();
    (plan_tables(&r, None).unwrap(), FileStamp::of(path).unwrap())
}
/// The row as the grid shows it: every column's present() value, found by the first column cell equal to `anchor`.
fn row_of(
    path: &Path,
    table: &str,
    plan: &Plan,
    pick: impl Fn(&[Cell]) -> bool,
) -> Vec<(String, Cell)> {
    let r = open_read_only(path, OpenMode::ReadOnly, Duration::ZERO).unwrap();
    let t = &plan[table];
    let (rows, _) = read_rows(&r, table, t, 10_000).unwrap();
    let row = rows.iter().find(|row| pick(row)).expect("row");
    t.columns
        .iter()
        .map(|c| c.name.clone())
        .zip(row.iter().cloned())
        .collect()
}
fn edit(table: &str, column: &str, new_value: Cell, row: Vec<(String, Cell)>) -> CellEdit {
    CellEdit {
        table: table.into(),
        column: column.into(),
        new_value,
        row,
    }
}
const BUSY0: Duration = Duration::ZERO;
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
/// The `class repr` tail of a CELL line for non-real values (reals are compared through the CLI).
fn tail(c: &Cell) -> String {
    match c {
        Cell::Null => "null None".into(),
        Cell::Integer(i) => format!("integer {i}"),
        Cell::Text(s) => format!("text {}", hex(s.as_bytes())),
        Cell::Blob(b) => format!("blob {}", hex(b)),
        Cell::Real(_) => panic!("compare reals through the CLI"),
    }
}
/// Exactly one cell line was replaced by one line for the same cell, and nothing else in the database moved.
fn assert_one_cell(
    before: &BTreeSet<String>,
    after: &BTreeSet<String>,
    cell: &str,
    new_tail: Option<&str>,
) {
    let gone: Vec<_> = before.difference(after).collect();
    let added: Vec<_> = after.difference(before).collect();
    assert_eq!(
        (gone.len(), added.len()),
        (1, 1),
        "gone {gone:?} added {added:?}"
    );
    assert!(
        gone[0].starts_with(&format!("CELL {cell} "))
            && added[0].starts_with(&format!("CELL {cell} ")),
        "{gone:?} {added:?}"
    );
    if let Some(t) = new_tail {
        assert!(added[0].ends_with(t), "{added:?} should end with {t}");
    }
}

const FOREIGN: &[&str] = &[
    "create table places (id, name, value real, raw blob)",
    "insert into places values ('0007', 'İstanbul', 1.5, x'c4b0ff')",
    "insert into places values ('0008', 'Ankara', null, null)",
    "create table counts (label, n)",
    "insert into counts values ('a', 1)",
    "insert into counts values ('b', 22)",
    "create table mixed (v)",
    "insert into mixed values ('İzmir')",
    "insert into mixed values (5)",
];

fn places_row(path: &Path, plan: &Plan) -> Vec<(String, Cell)> {
    row_of(path, "places", plan, |r| r[0] == text("0007"))
}

#[test]
fn an_edit_to_an_untyped_text_column_is_stored_as_text_and_only_that_cell_changes() {
    let d = Dir::new("text");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let before = dump(&p);
    let out = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("places", "name", text("İzmir"), places_row(&p, &plan)),
        BUSY0,
    )
    .unwrap();
    assert!(matches!(out, Outcome::Updated { stored: Cell::Text(ref s), .. } if s == "İzmir"));
    assert_eq!(
        cli(&p, "select name, typeof(name) from places where id='0007'"),
        "İzmir|text"
    );
    assert_one_cell(
        &before,
        &dump(&p),
        "places 1 name",
        Some(&tail(&text("İzmir"))),
    );
}

#[test]
fn a_number_sent_to_an_untyped_text_column_is_stored_as_text() {
    let d = Dir::new("numtext");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("places", "name", Cell::Integer(42), places_row(&p, &plan)),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        cli(&p, "select name, typeof(name) from places where id='0007'"),
        "42|text"
    );
}

#[test]
fn an_edit_to_a_typed_column_of_the_same_row_leaves_the_rest_alone() {
    let d = Dir::new("typed");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let before = dump(&p);
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("places", "value", Cell::Real(9.75), places_row(&p, &plan)),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        cli(
            &p,
            "select name, typeof(name), value, typeof(value) from places where id='0007'"
        ),
        "İstanbul|text|9.75|real"
    );
    assert_one_cell(&before, &dump(&p), "places 1 value", None);
}

#[test]
fn an_edit_that_matches_no_row_changes_nothing_and_says_so() {
    let d = Dir::new("nomatch");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let mut row = places_row(&p, &plan);
    row[2].1 = Cell::Real(99.0); // not what the row holds
    let bytes = std::fs::read(&p).unwrap();
    assert_eq!(
        update_cell(
            &p,
            &plan,
            &stamp,
            &edit("places", "name", text("Bursa"), row),
            BUSY0
        )
        .unwrap(),
        Outcome::NoMatch
    );
    assert_eq!(
        std::fs::read(&p).unwrap(),
        bytes,
        "not even a byte of the file moved"
    );
}

#[test]
fn a_row_changed_by_someone_else_after_it_was_read_is_not_overwritten() {
    let d = Dir::new("stale");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let row = places_row(&p, &plan);
    Connection::open(&p)
        .unwrap()
        .execute_batch("update places set value = 2.5 where id = '0007'")
        .unwrap();
    assert_eq!(
        update_cell(
            &p,
            &plan,
            &stamp,
            &edit("places", "name", text("Bursa"), row),
            BUSY0
        )
        .unwrap(),
        Outcome::NoMatch
    );
    assert_eq!(
        cli(&p, "select name from places where id='0007'"),
        "İstanbul"
    );
}

#[test]
fn an_edit_to_an_untyped_column_of_numbers_is_refused_rather_than_storing_text() {
    let d = Dir::new("untypednum");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let row = row_of(&p, "counts", &plan, |r| r[0] == text("a"));
    let before = dump(&p);
    let err = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("counts", "n", Cell::Integer(42), row),
        BUSY0,
    )
    .unwrap_err();
    assert!(
        matches!(err, WriteError::Sqlite(SqliteError::UntypedNumbers(ref c)) if c == "n"),
        "{err:?}"
    );
    assert!(err.to_string().contains("declared with no type"));
    assert_eq!(dump(&p), before);
    assert_eq!(
        cli(&p, "select n, typeof(n) from counts where label='a'"),
        "1|integer"
    );
}

#[test]
fn two_identical_rows_are_refused_rather_than_edited_together() {
    let d = Dir::new("twins");
    let p = d.db(
        "t.sqlite",
        &[
            "create table twins (name)",
            "insert into twins values ('İstanbul')",
            "insert into twins values ('İstanbul')",
        ],
    );
    let (plan, stamp) = setup(&p);
    let before = dump(&p);
    let row = vec![("name".to_owned(), text("İstanbul"))];
    let err = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("twins", "name", text("Ankara"), row),
        BUSY0,
    )
    .unwrap_err();
    assert_eq!(err, WriteError::Ambiguous);
    assert!(err.to_string().contains("identical across every column"));
    assert_eq!(dump(&p), before);
}

#[test]
fn control_a_fully_declared_table_edits_as_before() {
    let d = Dir::new("declared");
    let p = d.db(
        "t.sqlite",
        &[
            "create table bars (symbol text, close real, n integer)",
            "insert into bars values ('İSTANBUL', 1.5, 3), ('AKBNK', 2.5, 4)",
            "create table t (label text, n integer)",
            "insert into t values ('0007', 1)",
        ],
    );
    let (plan, stamp) = setup(&p);
    let row = vec![
        ("symbol".to_owned(), text("İSTANBUL")),
        ("close".to_owned(), Cell::Real(1.5)),
        ("n".to_owned(), Cell::Integer(3)),
    ];
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("bars", "close", Cell::Real(7.25), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        cli(
            &p,
            "select close, typeof(close) from bars where symbol='İSTANBUL'"
        ),
        "7.25|real"
    );
    let row = vec![
        ("label".to_owned(), text("0007")),
        ("n".to_owned(), Cell::Integer(1)),
    ];
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "label", text("0009"), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(cli(&p, "select label, typeof(label) from t"), "0009|text");
}

#[test]
fn declared_integer_affinity_converts_text_and_the_outcome_reports_what_is_stored() {
    let d = Dir::new("affinity");
    let p = d.db(
        "t.sqlite",
        &[
            "create table t (id integer, n integer)",
            "insert into t values (1, 5)",
        ],
    );
    let (plan, stamp) = setup(&p);
    let row = vec![
        ("id".to_owned(), Cell::Integer(1)),
        ("n".to_owned(), Cell::Integer(5)),
    ];
    let out = update_cell(&p, &plan, &stamp, &edit("t", "n", text("0009"), row), BUSY0).unwrap();
    assert!(
        matches!(
            out,
            Outcome::Updated {
                stored: Cell::Integer(9),
                ..
            }
        ),
        "{out:?}"
    );
    assert_eq!(cli(&p, "select n, typeof(n) from t"), "9|integer");
}

#[test]
fn sixty_four_bit_integers_are_written_exactly() {
    let d = Dir::new("i64");
    let p = d.db(
        "t.sqlite",
        &[
            "create table t (id integer, n integer)",
            "insert into t values (1, 9007199254740993), (2, 0)",
        ],
    );
    let (plan, stamp) = setup(&p);
    let row = vec![
        ("id".to_owned(), Cell::Integer(1)),
        ("n".to_owned(), Cell::Integer(9_007_199_254_740_993)),
    ];
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "n", Cell::Integer(i64::MIN), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        cli(&p, "select n from t where id=1"),
        "-9223372036854775808"
    );
    assert_eq!(cli(&p, "select n from t where id=2"), "0");
}

#[test]
fn untyped_real_values_round_trip_exactly_including_the_first_null_and_extremes() {
    let d = Dir::new("reals");
    let values = [
        1.2345678901234567f64,
        f64::from_bits(1),
        f64::MAX,
        -1.7976931348623157e308,
        2.2250738585072014e-308,
        0.10000000000000002,
    ];
    let mut sql = vec![
        "create table t (id integer, value)".to_owned(),
        "insert into t values (0, null)".to_owned(),
    ];
    for (i, v) in values.iter().enumerate() {
        sql.push(format!("insert into t values ({}, {v:e})", i + 1));
    }
    let refs: Vec<&str> = sql.iter().map(String::as_str).collect();
    let p = d.db("t.sqlite", &refs);
    let (plan, stamp) = setup(&p);
    let r = open_read_only(&p, OpenMode::ReadOnly, BUSY0).unwrap();
    for (i, v) in values.iter().enumerate() {
        let row = vec![
            ("id".to_owned(), Cell::Integer(i as i64 + 1)),
            ("value".to_owned(), Cell::Real(*v)),
        ];
        assert!(
            matches!(find_row(&r, "t", &plan["t"], &row).unwrap(), Lookup::One(_)),
            "value {v:e} must be found exactly"
        );
    }
    let row = vec![
        ("id".to_owned(), Cell::Integer(1)),
        ("value".to_owned(), Cell::Real(values[0])),
    ];
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "id", Cell::Integer(99), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        cli(&p, "select value = 1.2345678901234567 from t where id = 99"),
        "1"
    );
}

#[test]
fn mixed_numeric_values_with_wide_integers_refuse_numeric_edits_and_neighbours_still_edit() {
    let d = Dir::new("wide");
    let p = d.db("t.sqlite", &[
        "create table t (id integer, v, label text)",
        "insert into t values (1, 9007199254740993, 'a'), (2, 2.5, 'b'), (3, -9223372036854775808, 'c'), (4, null, 'd')",
    ]);
    let (plan, stamp) = setup(&p);
    let row = row_of(&p, "t", &plan, |r| r[0] == Cell::Integer(1));
    assert_eq!(
        row[1].1,
        text("9007199254740993"),
        "the grid carries exact text"
    );
    let before = dump(&p);
    let err = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "v", text("10"), row.clone()),
        BUSY0,
    )
    .unwrap_err();
    assert!(
        matches!(err, WriteError::Sqlite(SqliteError::UntypedNumbers(_))),
        "{err:?}"
    );
    assert_eq!(dump(&p), before);
    // The neighbouring declared column still edits; the exact-text cell is matched numerically.
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "label", text("z"), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        cli(&p, "select cast(v as text), label from t where id=1"),
        "9007199254740993|z"
    );
}

#[test]
fn exact_numeric_transport_preserves_neighbouring_values_and_blob_bytes() {
    let d = Dir::new("neighbours");
    let p = d.db("t.sqlite", &[
        "create table t (n, label text, raw blob, count integer, amount real)",
        "insert into t values (null,null,null,null,null), (1.2345678901234567,'İstanbul',x'00ff',42,1.2345678901234567)",
    ]);
    let (plan, stamp) = setup(&p);
    let row = vec![
        ("n".to_owned(), Cell::Real(1.2345678901234567)),
        ("label".to_owned(), text("İstanbul")),
        ("count".to_owned(), Cell::Integer(42)),
    ];
    let before = dump(&p);
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "label", text("İzmir"), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        cli(&p, "select label, hex(raw) from t where n is not null"),
        "İzmir|00FF"
    );
    assert_one_cell(&before, &dump(&p), "t 2 label", Some(&tail(&text("İzmir"))));
}

#[test]
fn a_user_column_named_rowid_cannot_redirect_an_edit_to_other_rows() {
    for name in ["rowid", "RoWiD", "oid"] {
        let d = Dir::new("shadow");
        let p = d.db(
            "t.sqlite",
            &[
                &format!("create table t ({name} integer, name text, value text)"),
                "insert into t values (7, 'a', 'old'), (7, 'b', 'old')",
            ],
        );
        let (plan, stamp) = setup(&p);
        let before = dump(&p);
        let row = vec![
            (name.to_owned(), Cell::Integer(7)),
            ("name".to_owned(), text("a")),
            ("value".to_owned(), text("old")),
        ];
        let res = update_cell(
            &p,
            &plan,
            &stamp,
            &edit("t", "value", text("new"), row),
            BUSY0,
        );
        if matches!(plan["t"].identity, RowIdentity::Alias(_)) {
            // Any unshadowed internal alias must identify exactly the matched row.
            assert!(res.is_ok(), "{res:?}");
            assert_eq!(
                cli(&p, "select name, value from t order by name"),
                "a|new\nb|old"
            );
        } else {
            let err = res.unwrap_err();
            assert!(
                matches!(
                    err,
                    WriteError::Sqlite(SqliteError::NoIdentity(NoIdentity::Shadowed))
                ),
                "{err:?}"
            );
            assert_eq!(dump(&p), before);
        }
    }
}

#[test]
fn int02_a_shadowed_rowid_with_an_unshadowed_alias_edits_exactly_the_matched_row() {
    let d = Dir::new("int02");
    let p = d.db(
        "t.sqlite",
        &[
            "create table items (rowid integer, name varchar, qty integer)",
            "insert into items values (3, 'a', 1), (1, 'b', 2), (2, 'c', 3)",
        ],
    );
    let (plan, stamp) = setup(&p);
    // `rowid integer` is a plain column here (no primary key), so the identity must be oid/_rowid_.
    assert!(
        matches!(plan["items"].identity, RowIdentity::Alias(a) if a != "rowid"),
        "{:?}",
        plan["items"].identity
    );
    let row = vec![
        ("rowid".to_owned(), Cell::Integer(1)),
        ("name".to_owned(), text("b")),
        ("qty".to_owned(), Cell::Integer(2)),
    ];
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("items", "qty", Cell::Integer(99), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        cli(&p, "select name, qty from items order by name"),
        "a|1\nb|99\nc|3"
    );
}

#[test]
fn when_every_alias_is_shadowed_or_the_table_has_no_rowid_the_edit_is_refused_and_nothing_changes()
{
    let d = Dir::new("noid");
    let p = d.db(
        "t.sqlite",
        &[
            "create table shadowed (rowid integer, oid integer, _rowid_ integer, v text)",
            "insert into shadowed values (1,1,1,'x')",
            "create table norowid (k text primary key, v text) without rowid",
            "insert into norowid values ('a','x')",
            "create view vw as select v from shadowed",
        ],
    );
    let (plan, stamp) = setup(&p);
    let before = dump(&p);
    let sh = vec![
        ("rowid".to_owned(), Cell::Integer(1)),
        ("oid".to_owned(), Cell::Integer(1)),
        ("_rowid_".to_owned(), Cell::Integer(1)),
        ("v".to_owned(), text("x")),
    ];
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("shadowed", "v", text("y"), sh),
        BUSY0,
    )
    .unwrap_err();
    assert!(
        matches!(
            e,
            WriteError::Sqlite(SqliteError::NoIdentity(NoIdentity::Shadowed))
        ),
        "{e:?}"
    );
    let nr = vec![("k".to_owned(), text("a")), ("v".to_owned(), text("x"))];
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("norowid", "v", text("y"), nr),
        BUSY0,
    )
    .unwrap_err();
    assert!(
        matches!(
            e,
            WriteError::Sqlite(SqliteError::NoIdentity(NoIdentity::WithoutRowid))
        ),
        "{e:?}"
    );
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("vw", "v", text("y"), vec![("v".to_owned(), text("x"))]),
        BUSY0,
    )
    .unwrap_err();
    assert!(
        matches!(
            e,
            WriteError::Sqlite(SqliteError::NoIdentity(NoIdentity::View))
        ),
        "{e:?}"
    );
    assert_eq!(dump(&p), before);
}

#[test]
fn a_trigger_that_touches_another_row_makes_the_write_roll_back() {
    let d = Dir::new("trigger");
    let p = d.db("t.sqlite", &[
        "create table t (name text)",
        "insert into t values ('old'), ('other')",
        "create trigger tr after update on t begin update t set name = name || '!' where rowid = new.rowid + 1; end",
    ]);
    let (plan, stamp) = setup(&p);
    let before = dump(&p);
    let row = vec![("name".to_owned(), text("old"))];
    let err = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "name", text("new"), row.clone()),
        BUSY0,
    )
    .unwrap_err();
    assert!(
        matches!(err, WriteError::UnexpectedChanges(n) if n > 1),
        "{err:?}"
    );
    assert_eq!(dump(&p), before, "rolled back completely");
    Connection::open(&p)
        .unwrap()
        .execute_batch("drop trigger tr")
        .unwrap();
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "name", text("retry"), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(cli(&p, "select name from t order by rowid"), "retry\nother");
}

#[test]
fn constraint_nan_blob_and_unknown_column_refusals_change_nothing() {
    let d = Dir::new("refuse");
    let p = d.db("t.sqlite", &[
        "create table t (id integer primary key, u text unique, r real, g text generated always as (u || '!') virtual)",
        "insert into t(id,u,r) values (1,'a',1.0), (2,'b',2.0)",
        "create table untyped (s)",
        "insert into untyped values ('x')",
    ]);
    let (plan, stamp) = setup(&p);
    let before = dump(&p);
    let row1 = || row_of(&p, "t", &plan, |r| r[0] == Cell::Integer(1));
    let e = update_cell(&p, &plan, &stamp, &edit("t", "u", text("b"), row1()), BUSY0).unwrap_err();
    assert!(matches!(e, WriteError::Constraint(_)), "{e:?}");
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "r", Cell::Real(f64::NAN), row1()),
        BUSY0,
    )
    .unwrap_err();
    assert!(matches!(e, WriteError::InvalidValue(_)), "{e:?}");
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit(
            "untyped",
            "s",
            Cell::Blob(vec![1]),
            vec![("s".to_owned(), text("x"))],
        ),
        BUSY0,
    )
    .unwrap_err();
    assert!(matches!(e, WriteError::InvalidValue(_)), "{e:?}");
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "nope", text("x"), row1()),
        BUSY0,
    )
    .unwrap_err();
    assert!(matches!(e, WriteError::UnknownColumn(_)), "{e:?}");
    let e = update_cell(&p, &plan, &stamp, &edit("t", "g", text("x"), row1()), BUSY0).unwrap_err();
    assert!(
        matches!(e, WriteError::Sqlite(_)),
        "generated column: {e:?}"
    );
    let e = update_cell(&p, &plan, &stamp, &edit("t", "u", text("x"), vec![]), BUSY0).unwrap_err();
    assert!(matches!(e, WriteError::InvalidValue(_)), "{e:?}");
    assert_eq!(dump(&p), before);
}

#[test]
fn a_second_writer_gets_locked_and_a_late_reader_makes_commit_report_locked_never_a_partial_write()
{
    let d = Dir::new("locks");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let before = dump(&p);
    let e = || edit("places", "name", text("İzmir"), places_row(&p, &plan));
    let holder = Connection::open(&p).unwrap();
    holder.execute_batch("begin immediate").unwrap();
    assert_eq!(
        update_cell(&p, &plan, &stamp, &e(), BUSY0).unwrap_err(),
        WriteError::Locked
    );
    holder.execute_batch("rollback").unwrap();
    // A reader mid-transaction in rollback-journal mode blocks the exclusive lock COMMIT needs.
    holder
        .execute_batch("begin; select count(*) from places")
        .unwrap();
    assert_eq!(
        update_cell(&p, &plan, &stamp, &e(), BUSY0).unwrap_err(),
        WriteError::Locked
    );
    holder.execute_batch("rollback").unwrap();
    drop(holder);
    assert_eq!(dump(&p), before);
    update_cell(&p, &plan, &stamp, &e(), BUSY0).unwrap();
    assert_eq!(cli(&p, "select name from places where id='0007'"), "İzmir");
}

#[test]
fn a_read_only_file_is_refused_and_untouched() {
    let d = Dir::new("ro");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let row = places_row(&p, &plan);
    let bytes = std::fs::read(&p).unwrap();
    std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o444)).unwrap();
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("places", "name", text("x"), row),
        BUSY0,
    )
    .unwrap_err();
    std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
    assert_eq!(e, WriteError::ReadOnly);
    assert_eq!(std::fs::read(&p).unwrap(), bytes);
}

#[test]
fn a_file_replaced_after_the_plan_is_refused_and_the_replacement_is_preserved() {
    let d = Dir::new("replaced");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let row = places_row(&p, &plan);
    let other = d.db("other.sqlite", FOREIGN);
    std::fs::rename(&other, &p).unwrap(); // same content, new inode: another program saved over it
    let bytes = std::fs::read(&p).unwrap();
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("places", "name", text("x"), row),
        BUSY0,
    )
    .unwrap_err();
    assert_eq!(e, WriteError::SourceReplaced { committed: false });
    assert_eq!(std::fs::read(&p).unwrap(), bytes);
    assert!(FileStamp::of(&p).unwrap() != stamp);
}

#[test]
fn a_missing_file_is_not_recreated_empty() {
    let d = Dir::new("missing");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let row = places_row(&p, &plan);
    std::fs::remove_file(&p).unwrap();
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("places", "name", text("x"), row),
        BUSY0,
    )
    .unwrap_err();
    assert!(
        matches!(e, WriteError::Sqlite(SqliteError::NotFound(_))),
        "{e:?}"
    );
    assert!(!p.exists());
}

#[test]
fn a_schema_or_storage_class_change_after_the_plan_is_refused() {
    let d = Dir::new("schema");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let row = places_row(&p, &plan);
    Connection::open(&p)
        .unwrap()
        .execute_batch("alter table places add column extra text")
        .unwrap();
    let before = dump(&p);
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("places", "name", text("x"), row.clone()),
        BUSY0,
    )
    .unwrap_err();
    assert_eq!(e, WriteError::SchemaChanged);
    assert_eq!(dump(&p), before);
    // Same columns, but an untyped column that was all text now holds a number: the plan's reading is stale.
    let d = Dir::new("classes");
    let p = d.db("f.sqlite", FOREIGN);
    let (plan, stamp) = setup(&p);
    let row = places_row(&p, &plan);
    Connection::open(&p)
        .unwrap()
        .execute_batch("insert into places values ('0009', 5, 1.0, null)")
        .unwrap();
    let before = dump(&p);
    let e = update_cell(
        &p,
        &plan,
        &stamp,
        &edit("places", "id", text("0010"), row),
        BUSY0,
    )
    .unwrap_err();
    assert_eq!(e, WriteError::SchemaChanged);
    assert_eq!(dump(&p), before);
}

#[test]
fn a_wal_database_edits_while_another_connection_reads_and_sees_the_commit() {
    let d = Dir::new("wal");
    let p = d.db(
        "f.sqlite",
        &[
            "pragma journal_mode = wal",
            "create table t (id integer, name text)",
            "insert into t values (1,'old'),(2,'keep')",
        ],
    );
    let (plan, stamp) = setup(&p);
    let reader = Connection::open(&p).unwrap();
    reader
        .execute_batch("begin; select count(*) from t")
        .unwrap(); // a reader holding a snapshot does not block a WAL writer
    let before = dump(&p);
    let row = vec![
        ("id".to_owned(), Cell::Integer(1)),
        ("name".to_owned(), text("old")),
    ];
    update_cell(
        &p,
        &plan,
        &stamp,
        &edit("t", "name", text("new"), row),
        BUSY0,
    )
    .unwrap();
    assert_eq!(
        reader
            .query_row("select name from t where id=1", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "old",
        "snapshot isolation"
    );
    reader.execute_batch("rollback").unwrap();
    assert_eq!(
        reader
            .query_row("select name from t where id=1", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "new"
    );
    assert_eq!(cli(&p, "select name from t where id=1"), "new");
    assert_one_cell(&before, &dump(&p), "t 1 name", Some(&tail(&text("new"))));
    assert_eq!(cli(&p, "pragma journal_mode"), "wal");
}

fn probe(db: &Path, fault: &str, row: usize) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_dbw_probe"))
        .args([
            db.to_str().unwrap(),
            "places",
            "name",
            "İzmir",
            &row.to_string(),
        ])
        .env("DFV_TEST_DBWRITE_FAULT", fault)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
fn sigkill_during_the_write_leaves_the_old_database_before_commit_and_the_new_one_after() {
    for wal in [false, true] {
        for stage in ["after_begin", "after_update", "after_commit"] {
            let d = Dir::new("kill");
            let mut sql: Vec<&str> = Vec::new();
            if wal {
                sql.push("pragma journal_mode = wal");
            }
            sql.extend_from_slice(FOREIGN);
            let p = d.db("f.sqlite", &sql);
            let before = dump(&p);
            let mut child = probe(&p, &format!("pause:{stage}"), 0);
            let mut lines = BufReader::new(child.stderr.take().unwrap());
            let mut line = String::new();
            loop {
                line.clear();
                assert!(
                    lines.read_line(&mut line).unwrap() > 0,
                    "probe exited before {stage}"
                );
                if line.contains(&format!("checkpoint {stage}")) {
                    break;
                }
            }
            child.kill().unwrap(); // SIGKILL
            child.wait().unwrap();
            // A hot journal (rollback mode) or an unmerged WAL is recovered by the next opener, as it is for any program.
            let after = dump(&p);
            if stage == "after_commit" {
                assert_one_cell(
                    &before,
                    &after,
                    "places 1 name",
                    Some(&tail(&text("İzmir"))),
                );
            } else {
                assert_eq!(
                    after, before,
                    "wal={wal} stage={stage}: nothing committed, nothing visible"
                );
            }
            // And a later edit works: no lock is left behind by the dead writer.
            let (plan, stamp) = setup(&p);
            let row = places_row(&p, &plan);
            let target = if stage == "after_commit" {
                "Bursa"
            } else {
                "İzmir"
            };
            update_cell(
                &p,
                &plan,
                &stamp,
                &edit("places", "name", text(target), row),
                BUSY0,
            )
            .unwrap();
            // Apple's read-only sqlite3 cannot open sidecar-free WAL files; compare every cell independently.
            assert_one_cell(
                &after,
                &dump(&p),
                "places 1 name",
                Some(&tail(&text(target))),
            );
        }
    }
}

#[test]
fn the_probe_process_commits_and_reports_a_refusal_with_exit_two() {
    let d = Dir::new("probe");
    let p = d.db("f.sqlite", FOREIGN);
    let ok = probe(&p, "", 0).wait_with_output().unwrap();
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stdout)
    );
    let d2 = Dir::new("probe2");
    let q = d2.db(
        "g.sqlite",
        &[
            "create table places (id, name, value, raw)",
            "insert into places values (1,'a',1,null),(1,'a',1,null)",
        ],
    );
    let bad = probe(&q, "", 0).wait_with_output().unwrap();
    assert_eq!(bad.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&bad.stdout).contains("identical across every column"));
}
