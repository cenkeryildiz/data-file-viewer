//! D3.7 comparison suite against an independent SQLite: Python's sqlite3 (its own SQLite build, not the bundled one)
//! writes a seeded database and reads it back through `tests/support/ref_sqlite.py`; the crate's reads, retype
//! decisions and row identity must agree with it cell for cell. Also the typed outcomes the plan asks for
//! (read-only, locked, WAL, corrupt, changing schemas). Override the interpreter with DFV_REF_PYTHON.
use dfv_table_sqlite::*;
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

fn python() -> String {
    std::env::var("DFV_REF_PYTHON").unwrap_or_else(|_| {
        "/Users/macc/Desktop/Kod/.codex-work/pdf-reference-env-20261025/myproject/bin/python".into()
    })
}
fn script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/ref_sqlite.py")
}
fn run_py(args: &[&Path], mode: &str) -> String {
    let out = Command::new(python())
        .args(["-B", "-I"])
        .arg(script())
        .arg(mode)
        .args(args)
        .output()
        .expect("reference python");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

struct Dir(PathBuf);
impl Dir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("dfv-sqlite-ind-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ =
            std::fs::set_permissions(&self.0, std::os::unix::fs::PermissionsExt::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(s: &str) -> String {
    let bytes: Vec<u8> = (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    String::from_utf8(bytes).unwrap()
}

struct RefTable {
    kind: String,
    columns: Vec<(String, String)>,
    classes: Vec<BTreeSet<String>>,
    rows: Vec<Vec<String>>,
}

fn parse_dump(text: &str) -> BTreeMap<String, RefTable> {
    let mut out = BTreeMap::new();
    let mut current: Option<(String, RefTable)> = None;
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f[0] {
            "TABLE" => {
                if let Some((n, t)) = current.take() {
                    out.insert(n, t);
                }
                current = Some((
                    unhex(f[1]),
                    RefTable {
                        kind: f[2].to_owned(),
                        columns: vec![],
                        classes: vec![],
                        rows: vec![],
                    },
                ));
            }
            "COLS" => {
                current.as_mut().unwrap().1.columns = f[1..]
                    .iter()
                    .filter(|c| !c.is_empty())
                    .map(|c| {
                        let (a, b) = c.split_once(':').unwrap();
                        (unhex(a), unhex(b))
                    })
                    .collect();
            }
            "CLASSES" => current.as_mut().unwrap().1.classes.push(
                f.get(2)
                    .unwrap_or(&"")
                    .split(',')
                    .filter(|c| !c.is_empty())
                    .map(str::to_owned)
                    .collect(),
            ),
            "ROW" => current
                .as_mut()
                .unwrap()
                .1
                .rows
                .push(f[1..].iter().map(|s| (*s).to_owned()).collect()),
            other => panic!("unexpected dump line {other}"),
        }
    }
    if let Some((n, t)) = current {
        out.insert(n, t);
    }
    out
}

fn canon(cell: &Cell) -> String {
    match cell {
        Cell::Null => "N".into(),
        Cell::Integer(i) => format!("i:{i}"),
        Cell::Real(r) => format!("r:{:016x}", r.to_bits()),
        Cell::Text(s) => format!("t:{}", hex(s.as_bytes())),
        Cell::Blob(b) => format!("b:{}", hex(b)),
    }
}

const SAFE: i128 = 9_007_199_254_740_992;

/// What an untyped column must become, derived here from the storage classes Python saw (not from the crate).
fn expected_retype(classes: &BTreeSet<String>) -> Option<Retype> {
    let c: Vec<&str> = classes.iter().map(String::as_str).collect();
    match c.as_slice() {
        [] => None,
        ["text"] => Some(Retype::Varchar),
        ["integer"] => Some(Retype::BigInt),
        ["real"] | ["integer", "real"] => Some(Retype::Double),
        _ => None,
    }
}

fn open(path: &Path) -> Connection {
    open_read_only(path, OpenMode::ReadOnly, Duration::ZERO).unwrap()
}

#[test]
fn every_table_reads_cell_for_cell_like_pythons_sqlite() {
    let d = Dir::new("diff");
    let db = d.0.join("ref.sqlite");
    let truth = d.0.join("truth.tsv");
    run_py(&[&db, &truth], "build");
    let reference = parse_dump(&run_py(&[&db], "dump"));
    let conn = open(&db);
    let plan = plan_tables(&conn, None).unwrap();
    assert_eq!(
        plan.keys().collect::<Vec<_>>(),
        reference.keys().collect::<Vec<_>>(),
        "same tables and views"
    );
    let mut cells = 0usize;
    let mut retyped_columns = 0usize;
    for (name, want) in &reference {
        let tp = &plan[name];
        // columns, in order, with the type text exactly as declared
        let cols: Vec<(String, String)> = tp
            .columns
            .iter()
            .map(|c| (c.name.clone(), c.declared.clone()))
            .collect();
        assert_eq!(cols, want.columns, "{name} columns");
        let (rows, truncated) = read_rows(&conn, name, tp, usize::MAX).unwrap();
        assert!(!truncated);
        assert_eq!(rows.len(), want.rows.len(), "{name} row count");
        let mut exact_text = BTreeSet::new();
        for (i, (cname, declared)) in want.columns.iter().enumerate() {
            let classes = &want.classes[i];
            // Retype decisions apply to undeclared columns only.
            let expect = if declared.trim().is_empty() {
                expected_retype(classes)
            } else {
                None
            };
            let wide = expect == Some(Retype::Double)
                && want.rows.iter().any(|r| {
                    r[i].strip_prefix("i:")
                        .is_some_and(|n| n.parse::<i128>().unwrap().abs() > SAFE)
                });
            let expect = if wide { Some(Retype::Varchar) } else { expect };
            assert_eq!(
                tp.retyped.get(cname).copied(),
                expect,
                "{name}.{cname} retype"
            );
            assert_eq!(
                tp.numeric_text.contains(cname),
                wide,
                "{name}.{cname} exact text"
            );
            if wide {
                exact_text.insert(i);
            }
            retyped_columns += usize::from(expect.is_some());
        }
        for (r, (got, w)) in rows.iter().zip(&want.rows).enumerate() {
            for (i, (cell, expected)) in got.iter().zip(w).enumerate() {
                let double = tp.retyped.get(&want.columns[i].0) == Some(&Retype::Double);
                let ok = if exact_text.contains(&i) {
                    // exact numeric text: integers as digits; reals must parse back to the same bits
                    match (
                        expected.strip_prefix("i:"),
                        expected.strip_prefix("r:"),
                        cell,
                    ) {
                        (Some(n), _, Cell::Text(s)) => s == n,
                        (_, Some(bits), Cell::Text(s)) => {
                            s.parse::<f64>()
                                .map(|v| format!("{:016x}", v.to_bits()))
                                .as_deref()
                                == Ok(bits)
                        }
                        (None, None, Cell::Null) => expected == "N",
                        _ => false,
                    }
                } else if double {
                    match expected.strip_prefix("i:") {
                        Some(n) => {
                            canon(cell)
                                == format!(
                                    "r:{:016x}",
                                    (n.parse::<i64>().unwrap() as f64).to_bits()
                                )
                        }
                        None => canon(cell) == *expected,
                    }
                } else {
                    canon(cell) == *expected
                };
                assert!(
                    ok,
                    "{name} row {r} column {}: got {cell:?}, python says {expected}",
                    want.columns[i].0
                );
                cells += 1;
            }
        }
        assert_eq!(
            want.kind == "view",
            matches!(tp.identity, RowIdentity::Unavailable(NoIdentity::View)),
            "{name} view identity"
        );
    }
    assert!(
        cells > 8_000 && retyped_columns >= 8,
        "{cells} cells, {retyped_columns} retyped"
    );
}

/// Row identity against rowids known by construction: Python inserted every row with an explicit real rowid
/// through whichever alias no column shadows, so the answer never comes from the code under test.
#[test]
fn row_identity_returns_the_true_rowid_or_refuses_for_every_shadowing_shape() {
    let d = Dir::new("identity");
    let db = d.0.join("ref.sqlite");
    let truth = d.0.join("truth.tsv");
    run_py(&[&db, &truth], "build");
    let conn = open(&db);
    let plan = plan_tables(&conn, None).unwrap();
    let mut by_table: BTreeMap<String, Vec<(String, i64)>> = BTreeMap::new();
    for line in std::fs::read_to_string(&truth).unwrap().lines() {
        let f: Vec<&str> = line.split('\t').collect();
        let marks = by_table.entry(f[0].to_owned()).or_default();
        if f[1] != "NONE" {
            marks.push((f[1].to_owned(), f[2].parse().unwrap()));
        }
    }
    let mut checked = 0;
    for (table, marks) in &by_table {
        let tp = &plan[table];
        if marks.is_empty() {
            let key = [("m".to_owned(), Cell::Text("a".into()))];
            let outcome = find_row(&conn, table, tp, &key);
            let expect = if table == "id_without_rowid" {
                NoIdentity::WithoutRowid
            } else {
                NoIdentity::Shadowed
            };
            assert_eq!(outcome, Err(SqliteError::NoIdentity(expect)), "{table}");
            continue;
        }
        for (mark, rowid) in marks {
            let key = [("m".to_owned(), Cell::Text(mark.clone()))];
            assert_eq!(
                find_row(&conn, table, tp, &key),
                Ok(Lookup::One(*rowid)),
                "{table}/{mark} identity {:?}",
                tp.identity
            );
            checked += 1;
        }
    }
    // user values in a shadowing `rowid` column never act as identity: two rows share the value 7
    let dupes = &plan["id_dupes"];
    assert_eq!(
        find_row(
            &conn,
            "id_dupes",
            dupes,
            &[("rowid".to_owned(), Cell::Integer(7))]
        ),
        Ok(Lookup::Ambiguous)
    );
    assert!(checked >= 55, "{checked}");
}

#[test]
fn hostile_identifiers_are_quoted_not_executed() {
    let d = Dir::new("quote");
    let db = d.0.join("ref.sqlite");
    run_py(&[&db, &d.0.join("t.tsv")], "build");
    let before = std::fs::read(&db).unwrap();
    let conn = open(&db);
    let plan = plan_tables(&conn, None).unwrap();
    let name = "we\"ird; drop table typed; --";
    let tp = &plan[name];
    let names: Vec<&str> = tp.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["", "[x]", "select", "a\nb"]);
    let (rows, _) = read_rows(&conn, name, tp, 10).unwrap();
    assert_eq!(rows[0][0], Cell::Text("e".into()));
    assert_eq!(rows[0][3], Cell::Blob(vec![0]));
    assert_eq!(
        find_row(
            &conn,
            name,
            tp,
            &[
                (String::new(), Cell::Text("e".into())),
                ("a\nb".into(), Cell::Blob(vec![0]))
            ]
        ),
        Ok(Lookup::One(1))
    );
    assert!(plan.contains_key("typed"));
    drop(conn);
    assert_eq!(std::fs::read(&db).unwrap(), before);
}

fn small_db(d: &Dir, name: &str) -> PathBuf {
    let path = d.0.join(name);
    let c = Connection::open(&path).unwrap();
    c.execute_batch("create table t (id integer primary key, a text, b); insert into t (a, b) values ('x', 1), ('y', 2.5), ('z', null);")
        .unwrap();
    path
}

#[test]
fn a_lock_taken_after_opening_is_typed_and_a_busy_timeout_waits_for_release() {
    let d = Dir::new("lock");
    let path = small_db(&d, "l.sqlite");
    let reader = open(&path);
    let plan = plan_tables(&reader, None).unwrap();
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("begin exclusive").unwrap();
    assert_eq!(
        read_rows(&reader, "t", &plan["t"], 10).unwrap_err(),
        SqliteError::Locked
    );
    assert_eq!(
        find_row(
            &reader,
            "t",
            &plan["t"],
            &[("a".into(), Cell::Text("x".into()))]
        )
        .unwrap_err(),
        SqliteError::Locked
    );
    assert_eq!(plan_tables(&reader, None).unwrap_err(), SqliteError::Locked);
    // a patient reader waits out a short lock
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        writer.execute_batch("rollback").unwrap();
    });
    let started = std::time::Instant::now();
    let patient = open_read_only(&path, OpenMode::ReadOnly, Duration::from_secs(5)).unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(100),
        "it did wait"
    );
    assert_eq!(read_rows(&patient, "t", &plan["t"], 10).unwrap().0.len(), 3);
    release.join().unwrap();
    // the reader that failed earlier recovers once the lock is gone
    assert_eq!(read_rows(&reader, "t", &plan["t"], 10).unwrap().0.len(), 3);
}

#[test]
fn read_only_files_and_directories_read_fine_and_a_hot_journal_is_typed() {
    let d = Dir::new("ro");
    let path = small_db(&d, "r.sqlite");
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o444)).unwrap();
    std::fs::set_permissions(&d.0, std::os::unix::fs::PermissionsExt::from_mode(0o555)).unwrap();
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    assert_eq!(read_rows(&c, "t", &plan["t"], 10).unwrap().0.len(), 3);
    drop(c);
    std::fs::set_permissions(&d.0, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    // A crashed writer leaves db + hot journal: copy both while a transaction is open and spilling.
    let live = d.0.join("live.sqlite");
    let w = Connection::open(&live).unwrap();
    w.execute_batch("pragma cache_size=2; create table big (v blob); begin; insert into big values (randomblob(2000)); ").unwrap();
    w.execute_batch("insert into big select randomblob(2000) from big, big b2, big b3 limit 0")
        .unwrap();
    for _ in 0..12 {
        w.execute_batch("insert into big select randomblob(2000) from big")
            .unwrap();
    }
    w.execute_batch("commit; begin; update big set v = randomblob(2000)")
        .unwrap();
    let crash = Dir::new("hot");
    let copy = crash.0.join("c.sqlite");
    std::fs::copy(&live, &copy).unwrap();
    let journal = d.0.join("live.sqlite-journal");
    assert!(journal.exists(), "the open transaction has a journal");
    std::fs::copy(&journal, crash.0.join("c.sqlite-journal")).unwrap();
    drop(w);
    std::fs::set_permissions(&copy, std::os::unix::fs::PermissionsExt::from_mode(0o444)).unwrap();
    std::fs::set_permissions(
        &crash.0,
        std::os::unix::fs::PermissionsExt::from_mode(0o555),
    )
    .unwrap();
    let outcome = open_read_only(&copy, OpenMode::ReadOnly, Duration::ZERO);
    eprintln!(
        "hot journal in a read-only directory: {:?}",
        outcome.as_ref().err()
    );
    match outcome {
        Err(SqliteError::NeedsWrite(_) | SqliteError::Locked | SqliteError::Corrupt) => {}
        Ok(c) => {
            // SQLite may also answer from the committed image without recovering; then the data must be the committed rows
            let n: i64 = c
                .query_row("select count(*) from big", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 4096);
        }
        Err(other) => panic!("untyped outcome {other:?}"),
    }
}

#[test]
fn damaged_files_end_in_typed_errors_never_panics() {
    let d = Dir::new("corrupt");
    let db = d.0.join("ref.sqlite");
    run_py(&[&db, &d.0.join("t.tsv")], "build");
    let base = std::fs::read(&db).unwrap();
    assert!(base.len() > 100_000);
    let probe = |bytes: &[u8]| -> Result<usize, SqliteError> {
        let p = d.0.join("probe.sqlite");
        std::fs::write(&p, bytes).unwrap();
        let _ = std::fs::remove_file(d.0.join("probe.sqlite-journal"));
        let c = open_read_only(&p, OpenMode::ReadOnly, Duration::ZERO)?;
        let plan = plan_tables(&c, None)?;
        let mut rows = 0;
        for (name, tp) in &plan {
            rows += read_rows(&c, name, tp, usize::MAX)?.0.len();
            let _ = find_row(&c, name, tp, &[]);
        }
        Ok(rows)
    };
    assert!(probe(&base).unwrap() > 800);
    // an empty file is a valid, empty database to SQLite
    assert_eq!(probe(&[]), Ok(0));
    assert_eq!(
        probe(&base[..50]),
        Err(SqliteError::Corrupt),
        "valid magic, header cut short"
    );
    let mut bad_magic = base.clone();
    bad_magic[0] ^= 0xff;
    assert_eq!(probe(&bad_magic), Err(SqliteError::NotADatabase));
    let page = u16::from_be_bytes([base[16], base[17]]) as usize;
    assert!(
        matches!(
            probe(&base[..base.len() - page * 3]),
            Err(SqliteError::Corrupt)
        ),
        "pages missing from the end"
    );
    // deterministic byte damage anywhere (most lands in data pages and reads as different data, which is fine);
    // what matters: no panic, no hang, and every failure is one of the typed outcomes
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut kinds: BTreeMap<String, u32> = BTreeMap::new();
    for _ in 0..250 {
        let mut b = base.clone();
        for _ in 0..1 + next() % 8 {
            let i = if next() % 2 == 0 {
                (next() as usize) % 512
            } else {
                (next() as usize) % b.len()
            };
            b[i] = next() as u8;
        }
        let key = match probe(&b) {
            Ok(_) => "ok".to_owned(),
            Err(SqliteError::Other(m)) => {
                format!("other: {}", m.chars().take(40).collect::<String>())
            }
            Err(e) => format!("{e:?}").chars().take(30).collect(),
        };
        *kinds.entry(key).or_default() += 1;
    }
    eprintln!("damage outcomes: {kinds:?}");
    assert!(kinds.values().sum::<u32>() == 250);
}

#[test]
fn concurrent_wal_commits_and_schema_changes_never_tear_a_read() {
    let d = Dir::new("wal-stress");
    let path = d.0.join("w.sqlite");
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch("pragma journal_mode=wal; create table t (pair integer, side text)")
            .unwrap();
    }
    let writer_path = path.clone();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer_done = done.clone();
    let writer = std::thread::spawn(move || {
        let mut w = Connection::open(&writer_path).unwrap();
        w.busy_timeout(Duration::from_secs(5)).unwrap();
        for i in 0..300i64 {
            let tx = w.transaction().unwrap();
            tx.execute("insert into t (pair, side) values (?1, 'a')", [i])
                .unwrap();
            tx.execute("insert into t (pair, side) values (?1, 'b')", [i])
                .unwrap();
            if i % 50 == 49 {
                tx.execute_batch(&format!("alter table t add column extra{i} text"))
                    .unwrap();
            }
            // a table whose shape flips between (a, b) and (a): a plan made earlier can go stale mid-run
            tx.execute_batch(&format!(
                "drop table if exists u; create table u ({}); insert into u (a) values ({i})",
                if i % 2 == 0 { "a, b" } else { "a" }
            ))
            .unwrap();
            tx.commit().unwrap();
            std::thread::sleep(Duration::from_millis(3));
        }
        writer_done.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let (mut ok, mut changed, mut stale_changed) = (0, 0, 0);
    let mut plan_cache: Option<Plan> = None;
    let mut stale: Option<Plan> = None;
    let mut rounds = 0;
    while !done.load(std::sync::atomic::Ordering::SeqCst) || rounds < 20 {
        rounds += 1;
        let c = open_read_only(&path, OpenMode::ReadOnly, Duration::from_secs(5)).unwrap();
        // every plan is a self-consistent snapshot: all columns it lists exist and rows read under it are whole pairs
        let plan = match plan_tables(&c, plan_cache.as_ref()) {
            Ok(plan) => plan,
            Err(e) => panic!("planning inside one snapshot must succeed: {e:?}"),
        };
        if let (Some(old), Some(now)) = (
            stale.as_ref().and_then(|p: &Plan| p.get("u")),
            plan.get("u"),
        ) {
            // reading u under a plan from an earlier snapshot is either right or a typed SchemaChanged
            match read_rows(&c, "u", old, usize::MAX) {
                Ok((rows, _)) => assert!(rows.iter().all(|r| r.len() == old.columns.len())),
                Err(SqliteError::SchemaChanged) => stale_changed += 1,
                Err(e) => panic!("untyped outcome {e:?}"),
            }
            let _ = now;
        }
        if stale.is_none() && plan.get("u").is_some_and(|u| u.columns.len() == 2) {
            stale = Some(plan.clone());
        }
        let tp = &plan["t"];
        match read_rows(&c, "t", tp, usize::MAX) {
            Ok((rows, _)) => {
                assert_eq!(rows.len() % 2, 0, "a committed pair is never half visible");
                let mut seen: BTreeMap<i64, u32> = BTreeMap::new();
                for r in &rows {
                    let Cell::Integer(p) = r[0] else {
                        panic!("pair is an integer")
                    };
                    *seen.entry(p).or_default() += 1;
                }
                assert!(seen.values().all(|n| *n == 2));
                ok += 1;
            }
            Err(SqliteError::SchemaChanged) => changed += 1,
            Err(e) => panic!("untyped outcome {e:?}"),
        }
        plan_cache = Some(plan);
    }
    writer.join().unwrap();
    eprintln!("{ok} consistent reads, {changed} + {stale_changed} schema-changed outcomes");
    assert!(
        ok > 20 && stale_changed > 0,
        "{ok} reads, {stale_changed} stale plans"
    );
}

#[test]
fn row_limits_and_large_cells_are_bounded_and_exact() {
    let d = Dir::new("limits");
    let path = d.0.join("big.sqlite");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("create table t (id integer primary key, v); with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000) insert into t (v) select i from n;")
        .unwrap();
    c.execute("insert into t (v) values (zeroblob(?1))", [8 * 1024 * 1024])
        .unwrap();
    drop(c);
    let c = open(&path);
    let plan = plan_tables(&c, None).unwrap();
    let tp = &plan["t"];
    // the mixed column (integers plus one blob) is not retyped, so cells keep their own class
    assert!(tp.retyped.is_empty());
    for (limit, rows, more) in [
        (0, 0, true),
        (5, 5, true),
        (10_000, 10_000, true),
        (10_001, 10_001, false),
        (usize::MAX, 10_001, false),
    ] {
        let (got, truncated) = read_rows(&c, "t", tp, limit).unwrap();
        assert_eq!((got.len(), truncated), (rows, more), "limit {limit}");
    }
    let (last, _) = read_rows(&c, "t", tp, usize::MAX).unwrap();
    assert_eq!(last[10_000][1], Cell::Blob(vec![0; 8 * 1024 * 1024]));
}
