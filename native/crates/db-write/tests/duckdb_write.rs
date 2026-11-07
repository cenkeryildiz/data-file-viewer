//! Native edits with independent Python DuckDB readback and real-process lock/race checks.
use dfv_table_db_write::duckdb_write::{self as writer, CellEdit, Error, Outcome};
use dfv_table_publication::{Protection, Publisher, Status};
use duckdb::{
    Connection,
    types::{Decimal, TimeUnit, Value},
};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

struct Fixture {
    dir: tempfile::TempDir,
    path: PathBuf,
}
impl Fixture {
    fn new(sql: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.duckdb");
        Connection::open(&path).unwrap().execute_batch(sql).unwrap();
        Self { dir, path }
    }
    fn edit(&self, edit: &CellEdit) -> Result<Outcome, Error> {
        let publisher =
            Publisher::new(&self.dir.path().join("receipts"), Protection::default()).unwrap();
        let lock = publisher.lock(&self.path).unwrap();
        let plan = writer::plan(lock.target())?;
        writer::update_cell(&publisher, &lock, &plan, edit, self.dir.path())
    }
}
fn edit(column: &str, value: Value, row: Vec<(&str, Value)>) -> CellEdit {
    CellEdit {
        schema: "main".into(),
        table: "t".into(),
        column: column.into(),
        value,
        row: row.into_iter().map(|(n, v)| (n.into(), v)).collect(),
    }
}
fn simple() -> Fixture {
    Fixture::new(
        "create table t(id integer primary key,v varchar); insert into t values(1,'old'),(2,'neighbor')",
    )
}
fn simple_edit() -> CellEdit {
    edit(
        "v",
        Value::Text("new".into()),
        vec![("id", Value::Int(1)), ("v", Value::Text("old".into()))],
    )
}

fn python(path: &Path, code: &str) -> String {
    let python = std::env::var("DFV_REF_PYTHON")
        .expect("set DFV_REF_PYTHON to independent DuckDB reference Python");
    let code = format!("import duckdb,sys\nc=duckdb.connect(sys.argv[1],read_only=True)\n{code}");
    let output = Command::new(python)
        .args(["-I", "-B", "-c", &code])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn publishes_one_cell_with_receipt_and_independent_readback() {
    let f = simple();
    let Outcome::Updated { stored, receipt } = f.edit(&simple_edit()).unwrap() else {
        panic!("no update")
    };
    assert_eq!(stored, Value::Text("new".into()));
    let publisher = Publisher::new(&f.dir.path().join("receipts"), Protection::default()).unwrap();
    assert_eq!(
        publisher.status(&receipt.id),
        Status::Published {
            finalized: true,
            durable: true
        }
    );
    assert_eq!(
        python(
            &f.path,
            "print(c.execute('select * from t order by id').fetchall())"
        ),
        "[(1, 'new'), (2, 'neighbor')]\n"
    );
    assert!(!f.path.with_extension("duckdb.wal").exists());
}

#[test]
fn preserves_exact_large_scalars_schema_and_other_tables() {
    let f = Fixture::new(
        "create table t(id integer, signed hugeint, unsigned uhugeint, d decimal(38,4), b blob, n integer, s varchar); insert into t values(1,-170141183460469231731687303715884105727,340282366920938463463374607431768211455,12345678901234567890123456789012.3456,from_hex('0000ff2700'),null,'old'); create table neighbor as select DATE '2024-02-29' d,TIMESTAMP_NS '2024-02-29 12:34:56.123456789' ts,INTERVAL '3 months 4 days 5 microseconds' i; create index t_idx on t(id); create view v as select id,s from t;",
    );
    let row = vec![
        ("id", Value::Int(1)),
        (
            "signed",
            Value::HugeInt(-170141183460469231731687303715884105727),
        ),
        ("unsigned", Value::UHugeInt(u128::MAX)),
        (
            "d",
            Value::Decimal(Decimal::new(38, 4, 123456789012345678901234567890123456).unwrap()),
        ),
        ("b", Value::Blob(vec![0, 0, 255, 39, 0])),
        ("n", Value::Null),
        ("s", Value::Text("old".into())),
    ];
    let schema = python(
        &f.path,
        "print(c.execute('select schema_name,table_name,sql from duckdb_tables() order by 1,2').fetchall()); print(c.execute('select sql from duckdb_views() where not internal').fetchall()); print(c.execute('select sql from duckdb_indexes()').fetchall()); print(c.execute('select * from neighbor').fetchall())",
    );
    f.edit(&edit("s", Value::Text("a\0b'\"🚀".into()), row))
        .unwrap();
    assert_eq!(
        schema,
        python(
            &f.path,
            "print(c.execute('select schema_name,table_name,sql from duckdb_tables() order by 1,2').fetchall()); print(c.execute('select sql from duckdb_views() where not internal').fetchall()); print(c.execute('select sql from duckdb_indexes()').fetchall()); print(c.execute('select * from neighbor').fetchall())"
        )
    );
    assert_eq!(
        python(
            &f.path,
            "r=c.execute('select signed::varchar,unsigned::varchar,d::varchar,hex(b),n from t').fetchone(); print(r)"
        ),
        "('-170141183460469231731687303715884105727', '340282366920938463463374607431768211455', '12345678901234567890123456789012.3456', '0000FF2700', None)\n"
    );
    assert_eq!(
        python(
            &f.path,
            "print(c.execute('select hex(s) from t').fetchone()[0])"
        ),
        "6100622722F09F9A80\n"
    );
}

#[test]
fn exact_decimal_unsigned_and_null_target_writes() {
    for (sql, row, value, expected) in [
        (
            "create table t(v decimal(38,4)); insert into t values(1.0000)",
            Value::Decimal(Decimal::new(38, 4, 10000).unwrap()),
            Value::Decimal(Decimal::new(38, 4, 123456789012345678901234567890123456).unwrap()),
            "12345678901234567890123456789012.3456",
        ),
        (
            "create table t(v uhugeint); insert into t values(1)",
            Value::UHugeInt(1),
            Value::UHugeInt(u128::MAX),
            "340282366920938463463374607431768211455",
        ),
        (
            "create table t(v integer); insert into t values(1)",
            Value::Int(1),
            Value::Null,
            "None",
        ),
    ] {
        let f = Fixture::new(sql);
        f.edit(&edit("v", value, vec![("v", row)])).unwrap();
        assert_eq!(
            python(
                &f.path,
                "r=c.execute('select v::varchar from t').fetchone(); print(r[0])"
            ),
            format!("{expected}\n")
        );
    }
}

#[test]
fn preserves_nan_identity_and_negative_zero_bits() {
    let f =
        Fixture::new("create table t(id integer,v double); insert into t values(1,'NaN'::double)");
    f.edit(&edit(
        "v",
        Value::Double(-0.0),
        vec![("id", Value::Int(1)), ("v", Value::Double(f64::NAN))],
    ))
    .unwrap();
    assert_eq!(
        python(
            &f.path,
            "import math\nv=c.execute('select v from t').fetchone()[0]; print(v==0,math.copysign(1,v)==-1)"
        ),
        "True True\n"
    );
}

#[test]
fn nanosecond_identity_and_target_and_enum_are_lossless() {
    let f = Fixture::new(
        "create type mood as enum ('old','new'); create table t(id integer,ts timestamp_ns,v mood); insert into t values(1,make_timestamp_ns(1700000000000000001),'old')",
    );
    let row = vec![
        ("id", Value::Int(1)),
        (
            "ts",
            Value::Timestamp(TimeUnit::Nanosecond, 1700000000000000001),
        ),
        ("v", Value::Enum("old".into())),
    ];
    f.edit(&edit(
        "ts",
        Value::Timestamp(TimeUnit::Nanosecond, 1700000000000000002),
        row,
    ))
    .unwrap();
    let row = vec![
        ("id", Value::Int(1)),
        (
            "ts",
            Value::Timestamp(TimeUnit::Nanosecond, 1700000000000000002),
        ),
        ("v", Value::Enum("old".into())),
    ];
    f.edit(&edit("v", Value::Enum("new".into()), row)).unwrap();
    assert_eq!(
        python(
            &f.path,
            "print(c.execute('select epoch_ns(ts),v from t').fetchone())"
        ),
        "(1700000000000000002, 'new')\n"
    );
}

#[test]
fn refuses_ambiguous_incomplete_and_inexact_edits_without_changing_source() {
    let f =
        Fixture::new("create table t(id integer,v integer); insert into t values(1,2),(1,2),(2,3)");
    let before = std::fs::read(&f.path).unwrap();
    assert!(matches!(
        f.edit(&edit(
            "v",
            Value::Int(8),
            vec![("id", Value::Int(1)), ("v", Value::Int(2))]
        )),
        Err(Error::Ambiguous)
    ));
    assert!(matches!(
        f.edit(&edit("v", Value::Int(8), vec![("id", Value::Int(2))])),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        f.edit(&edit(
            "v",
            Value::Double(1.5),
            vec![("id", Value::Int(2)), ("v", Value::Int(3))]
        )),
        Err(Error::InexactValue)
    ));
    assert!(matches!(
        f.edit(&edit(
            "v",
            Value::Int(8),
            vec![("id", Value::Int(9)), ("v", Value::Int(9))]
        )),
        Ok(Outcome::NoMatch)
    ));
    assert_eq!(before, std::fs::read(&f.path).unwrap());
}

#[test]
fn constraints_and_generated_neighbors_roll_back() {
    for sql in [
        "create table t(id integer primary key,v integer check(v<5)); insert into t values(1,2)",
        "create table t(id integer,v integer,g integer generated always as (v*2)); insert into t(id,v) values(1,2)",
    ] {
        let f = Fixture::new(sql);
        let before = std::fs::read(&f.path).unwrap();
        let mut row = vec![("id", Value::Int(1)), ("v", Value::Int(2))];
        if sql.contains("generated") {
            row.push(("g", Value::Int(4)));
        }
        let result = f.edit(&edit("v", Value::Int(8), row));
        if sql.contains("generated") {
            assert!(
                matches!(result, Err(Error::UnexpectedChanges)),
                "{result:?}"
            );
        } else {
            assert!(
                matches!(result,Err(Error::Database(ref text)) if text.contains("CHECK constraint failed")),
                "{result:?}"
            );
        }
        assert_eq!(before, std::fs::read(&f.path).unwrap());
    }
}

#[test]
fn preserves_sequence_next_value_even_with_volatile_check() {
    let f = Fixture::new(
        "create sequence counter; create table t(v integer check(nextval('counter')+v>0)); insert into t values(1)",
    );
    let before = std::fs::read(&f.path).unwrap();
    let counter = python(
        &f.path,
        "print(c.execute('select sql from duckdb_sequences()').fetchall())",
    );
    let result = f.edit(&edit("v", Value::Int(2), vec![("v", Value::Int(1))]));
    assert_eq!(
        counter,
        python(
            &f.path,
            "print(c.execute('select sql from duckdb_sequences()').fetchall())"
        ),
        "{result:?}"
    );
    assert!(
        matches!(result, Err(Error::UnexpectedChanges)),
        "{result:?}"
    );
    assert_eq!(before, std::fs::read(&f.path).unwrap());
}

#[test]
fn explicit_quoted_schema_and_table_do_not_touch_same_name_neighbor() {
    let f = Fixture::new(
        "create schema \"a'\"; create table \"a'\".\"odd\"\"table\"(\"select\" integer, v varchar); insert into \"a'\".\"odd\"\"table\" values(1,'old'); create table main.\"odd\"\"table\" as select 1 id,'preserve' v",
    );
    let mut e = edit(
        "v",
        Value::Text("new".into()),
        vec![("select", Value::Int(1)), ("v", Value::Text("old".into()))],
    );
    e.schema = "a'".into();
    e.table = "odd\"table".into();
    f.edit(&e).unwrap();
    assert_eq!(
        python(
            &f.path,
            "print(c.execute('select v from main.\"odd\"\"table\"').fetchone()[0])"
        ),
        "preserve\n"
    );
}

#[test]
fn refuses_coerced_row_identity_and_lossy_decimal_without_publishing() {
    let f = Fixture::new("create table t(id integer,v decimal(8,2)); insert into t values(1,2.00)");
    let before = std::fs::read(&f.path).unwrap();
    assert!(matches!(
        f.edit(&edit(
            "v",
            Value::Decimal(Decimal::new(8, 2, 300).unwrap()),
            vec![
                ("id", Value::Text("1".into())),
                ("v", Value::Decimal(Decimal::new(8, 2, 200).unwrap()))
            ]
        )),
        Err(Error::InexactValue)
    ));
    assert!(matches!(
        f.edit(&edit(
            "v",
            Value::Decimal(Decimal::new(9, 3, 3333).unwrap()),
            vec![
                ("id", Value::Int(1)),
                ("v", Value::Decimal(Decimal::new(8, 2, 200).unwrap()))
            ]
        )),
        Err(Error::InexactValue)
    ));
    assert_eq!(before, std::fs::read(&f.path).unwrap());
}

#[test]
fn refuses_stale_source_replacement_and_journals() {
    let f = simple();
    let publisher = Publisher::new(&f.dir.path().join("receipts"), Protection::default()).unwrap();
    let lock = publisher.lock(&f.path).unwrap();
    let plan = writer::plan(lock.target()).unwrap();
    let replacement = f.dir.path().join("replacement.duckdb");
    Connection::open(&replacement)
        .unwrap()
        .execute_batch("create table safe(v varchar); insert into safe values('preserve')")
        .unwrap();
    let original = std::fs::read(&replacement).unwrap();
    std::fs::rename(&replacement, &f.path).unwrap();
    assert!(matches!(
        writer::update_cell(&publisher, &lock, &plan, &simple_edit(), f.dir.path()),
        Err(Error::SourceChanged)
    ));
    assert_eq!(original, std::fs::read(&f.path).unwrap());
    for suffix in [".wal", ".wal.checkpoint", ".wal.recovery"] {
        let journal = PathBuf::from(format!("{}{suffix}", f.path.display()));
        std::fs::write(&journal, b"preserve journal").unwrap();
        assert!(matches!(writer::plan(&f.path), Err(Error::Unsupported(_))));
        assert_eq!(std::fs::read(&journal).unwrap(), b"preserve journal");
        std::fs::remove_file(journal).unwrap();
    }
}

#[test]
fn private_snapshot_must_match_planned_digest_before_write() {
    let f = simple();
    let original = std::fs::read(&f.path).unwrap();
    let publisher = Publisher::new(&f.dir.path().join("receipts"), Protection::default()).unwrap();
    let lock = publisher.lock(&f.path).unwrap();
    let mut plan = writer::plan(lock.target()).unwrap();
    plan.sha256 = "0".repeat(64);
    assert!(matches!(
        writer::update_cell(&publisher, &lock, &plan, &simple_edit(), f.dir.path()),
        Err(Error::SourceChanged)
    ));
    assert_eq!(original, std::fs::read(&f.path).unwrap());
}

#[test]
fn guarded_catalog_does_not_execute_persisted_shadow_macros() {
    let f = Fixture::new(
        "create table t(id integer,v varchar); insert into t values(1,'old'); create macro current_database() as error('persisted shadow executed'); create macro duckdb_tables() as table select error('persisted table macro executed')",
    );
    f.edit(&simple_edit()).unwrap();
    assert_eq!(
        python(&f.path, "print(c.execute('select v from t').fetchone()[0])"),
        "new\n"
    );
}

#[cfg(feature = "test-mutations")]
mod processes {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Stdio},
    };
    struct Process(Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn probe(mode: &str, path: &Path) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_duckdbw_probe"));
        c.arg(mode).arg(path);
        c
    }
    fn pause(path: &Path, stage: &str, milliseconds: u64) -> Process {
        let mut c = probe("edit", path)
            .env("DFV_TEST_PUBLICATION_FAULT", format!("pause:{stage}"))
            .env("DFV_TEST_PUBLICATION_PAUSE_MS", milliseconds.to_string())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let line = BufReader::new(c.stderr.take().unwrap())
            .lines()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(line, format!("PUB_TEST checkpoint {stage}"));
        Process(c)
    }
    #[test]
    fn external_native_writer_lock_refuses_without_source_changes() {
        let f = simple();
        let before = std::fs::read(&f.path).unwrap();
        let mut process = probe("hold", &f.path)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        assert_eq!(
            BufReader::new(process.stdout.take().unwrap())
                .lines()
                .next()
                .unwrap()
                .unwrap(),
            "locked"
        );
        let _process = Process(process);
        assert!(matches!(f.edit(&simple_edit()), Err(Error::Locked(_))));
        assert_eq!(before, std::fs::read(&f.path).unwrap());
    }
    #[test]
    fn source_native_guard_blocks_writer_until_publication_and_kill_preserves_source() {
        let f = simple();
        let alias = f.dir.path().join("alias.duckdb");
        std::os::unix::fs::symlink(&f.path, &alias).unwrap();
        let before = std::fs::read(&f.path).unwrap();
        let process = pause(&f.path, "before_exchange", 60000);
        assert!(
            !probe("try-lock", &f.path)
                .output()
                .unwrap()
                .status
                .success()
        );
        assert!(!probe("try-lock", &alias).output().unwrap().status.success());
        let case_alias = f.path.with_file_name("SOURCE.DUCKDB");
        if case_alias.exists() {
            assert!(
                !probe("try-lock", &case_alias)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        assert_eq!(before, std::fs::read(&f.path).unwrap());
        drop(process);
        assert_eq!(before, std::fs::read(&f.path).unwrap());
        f.edit(&simple_edit()).unwrap();
    }
    #[test]
    fn last_syscall_replacement_is_preserved_as_unconfirmed() {
        let f = simple();
        let mut process = pause(&f.path, "before_exchange", 2000);
        let replacement = f.dir.path().join("foreign.duckdb");
        Connection::open(&replacement).unwrap().execute_batch("create table foreign_data(v varchar); insert into foreign_data values('preserve foreign')").unwrap();
        let foreign = std::fs::read(&replacement).unwrap();
        std::fs::rename(&replacement, &f.path).unwrap();
        assert!(!process.0.wait().unwrap().success());
        let preserved = std::fs::read_dir(f.dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| std::fs::read(entry.path()).is_ok_and(|bytes| bytes == foreign));
        assert!(
            preserved,
            "publication must retain the displaced foreign generation"
        );
        let publisher =
            Publisher::new(&f.dir.path().join("receipts"), Protection::default()).unwrap();
        let states: Vec<_> = std::fs::read_dir(f.dir.path().join("receipts"))
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|e| {
                e.path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(str::to_owned)
            })
            .map(|id| publisher.status(&id))
            .collect();
        assert!(states.contains(&Status::Unconfirmed), "{states:?}");
    }
}
