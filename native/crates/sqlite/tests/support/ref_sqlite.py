"""Independent SQLite reference for tests/independent.rs: Python's sqlite3 (its own SQLite build, not the bundled one).

  ref_sqlite.py build <db> <truth.tsv>   writes a seeded database and the ground truth for row identity
  ref_sqlite.py dump  <db>                prints every table's declared types and cells in a canonical text form

Names are hex of their UTF-8 bytes.  Cell grammar (one per tab-separated field): N | i:<int> | r:<16 hex of the IEEE-754 bits> | t:<hex of the UTF-8/raw bytes> | b:<hex>
"""
import random
import sqlite3
import struct
import sys

SEED = 20261031


class T(bytes):
    """TEXT cells (sqlite3 text_factory), so they stay distinguishable from BLOB cells."""


def hx(s):
    return s.encode().hex()


def q(name):
    return '"' + name.replace('"', '""') + '"'


def canon(v):
    if v is None:
        return "N"
    if isinstance(v, int):
        return "i:%d" % v
    if isinstance(v, float):
        return "r:%016x" % struct.unpack("<Q", struct.pack("<d", v))[0]
    return ("t:" if isinstance(v, T) else "b:") + bytes(v).hex()


def build(path, truth_path):
    rng = random.Random(SEED)
    c = sqlite3.connect(path)
    n = 400

    def maybe(v, p=0.1):
        return None if rng.random() < p else v

    texts = ["", "plain", "İstanbul", "日本語", "a'b\"c", "line\nbreak", "tab\t", "0007", "  pad  ", "emoji \U0001F600", "nul\x00inside"]
    c.execute('create table typed (id integer primary key, i integer, t text, r real, b blob, num numeric, dec decimal(10,5), vc varchar(30), flag boolean, "when" datetime)')
    for k in range(n):
        c.execute("insert into typed values (?,?,?,?,?,?,?,?,?,?)", (
            k + 1,
            maybe(rng.choice([0, 1, -1, 2**63 - 1, -(2**63), 2**53, 2**53 + 1, rng.randint(-10**12, 10**12)])),
            maybe(rng.choice(texts)),
            maybe(rng.choice([0.0, -0.0, 1.5, 5e-324, 1.7976931348623157e308, float("inf"), float("-inf"), rng.uniform(-1e6, 1e6)])),
            maybe(bytes(rng.getrandbits(8) for _ in range(rng.randint(0, 24)))),
            maybe(rng.choice([1, 2.5, "12", "x", 2**62])),
            maybe(rng.choice([1.25, "3", 7])),
            maybe(rng.choice(texts)),
            maybe(rng.choice([0, 1])),
            maybe(rng.choice(["2024-02-29 12:34:56", 1709210096, 2460370.5])),
        ))
    # untyped columns of every uniform and mixed class combination
    c.execute("create table untyped (all_text, all_int, int_real, text_int, blob_only, all_null, wide_ints, with_inf, one_real, tiny)")
    for k in range(n):
        c.execute("insert into untyped values (?,?,?,?,?,?,?,?,?,?)", (
            maybe(rng.choice(texts[:7])),
            maybe(rng.randint(-10**9, 10**9)),
            maybe(rng.choice([1, 2, 3.5, -0.25, 7])),
            maybe(rng.choice(["a", 5, "b"])),
            maybe(bytes([k % 256, 0, 255])),
            None,
            maybe(rng.choice([1, 2**63 - 1, -(2**63), 2**53 + 1, 3.5])),
            maybe(rng.choice([1.5, float("inf"), 2, float("-inf")])),
            maybe(rng.uniform(-1, 1)),
            maybe(rng.choice([5e-324, 2.2250738585072014e-308, 1, 0.5])),
        ))
    # hostile identifiers
    c.execute('create table %s (%s text, %s integer, %s, %s)' % (q('we"ird; drop table typed; --'), q(""), q("[x]"), q("select"), q("a\nb")))
    c.execute('insert into %s values (?,?,?,?)' % q('we"ird; drop table typed; --'), ("e", 1, 2.5, b"\x00"))
    c.execute("create table empty_t (a, b)")
    c.execute("create view v_typed as select id, t from typed where id < 5")
    c.execute("create table gen (a integer, b integer generated always as (a * 2) virtual, c integer generated always as (a + 1) stored)")
    c.executemany("insert into gen (a) values (?)", [(1,), (2,), (None,)])
    c.commit()

    # Row identity ground truth: rows get explicit real rowids through whichever alias is free, so the true
    # rowid of every row is known by construction and never read back through the code under test.
    cases = [
        ("id_plain", "(m text, x)", "(rowid, m, x) values (?,?,1)", lambda r, m: (r, m)),
        ("id_shadow_rowid", "(rowid text, m text)", "(oid, rowid, m) values (?,'u',?)", lambda r, m: (r, m)),
        ("id_shadow_two", "(rowid, oid, m text)", "(_rowid_, rowid, oid, m) values (?,1,2,?)", lambda r, m: (r, m)),
        ("id_pk_alias_named_rowid", "(ROWID integer primary key, m text)", "(rowid, m) values (?,?)", lambda r, m: (r, m)),
        ("id_pk_other_name_shadow_rowid", "(id integer primary key, rowid text, m text)", "(id, rowid, m) values (?,'u',?)", lambda r, m: (r, m)),
        # PRIMARY KEY DESC is the documented exception: not a rowid alias, so `rowid` here is a plain (nullable-unique) column
        ("id_pk_desc_not_alias", "(rowid integer primary key desc, m text)", "(oid, rowid, m) values (?,?,?)", lambda r, m: (r, -r, m)),
        ("id_pk_int_not_alias", "(rowid int primary key, m text)", "(oid, rowid, m) values (?,?,?)", lambda r, m: (r, -r, m)),
        ("id_pk_table_constraint_alias", "(rowid integer, m text, primary key (rowid))", "(rowid, m) values (?,?)", lambda r, m: (r, m)),
        ("id_pk_composite_not_alias", "(a integer, rowid integer, m text, primary key (a, rowid))", "(oid, a, rowid, m) values (?,1,?,?)", lambda r, m: (r, -r, m)),
        ("id_autoincrement_alias", "(rowid integer primary key autoincrement, m text)", "(rowid, m) values (?,?)", lambda r, m: (r, m)),
        ("id_shadow_oid_only", "(oid text, m text)", "(rowid, oid, m) values (?,'u',?)", lambda r, m: (r, m)),
        ("id_quoted_underscore", '("_ROWID_" text, m text)', '(rowid, "_ROWID_", m) values (?,\'u\',?)', lambda r, m: (r, m)),
    ]
    truth = {}
    for name, ddl, ins, params in cases:
        c.execute("create table %s %s" % (name, ddl))
        marks = {}
        for k in range(1, 6):
            real, mark = 1000 + k * 7, "m%d" % k
            c.execute("insert into %s %s" % (name, ins), params(real, mark))
            marks[mark] = real
        truth[name] = marks
        # the construction really produced those rowids (checked through the alias that no column shadows)
    c.execute("create table id_shadow_all (rowid, oid, _rowid_, m text)")
    c.execute("insert into id_shadow_all (m) values ('a'), ('b')")
    truth["id_shadow_all"] = None
    # duplicate user values in a shadowing column: the lookup may never be redirected to them
    c.execute("create table id_dupes (rowid integer, m text)")
    c.execute("insert into id_dupes (oid, rowid, m) values (50, 7, 'a'), (51, 7, 'b')")
    truth["id_dupes"] = {"a": 50, "b": 51}
    c.execute("create table id_without_rowid (k text primary key, m text) without rowid")
    c.execute("insert into id_without_rowid values ('a','m1')")
    truth["id_without_rowid"] = None
    c.commit()
    with open(truth_path, "w") as f:  # `table<TAB>mark<TAB>rowid` lines, `table<TAB>NONE` when no identity exists
        for name, marks in sorted(truth.items()):
            if marks is None:
                f.write("%s\tNONE\n" % name)
            else:
                for mark, real in marks.items():
                    f.write("%s\t%s\t%d\n" % (name, mark, real))


def dump(path):
    c = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    c.text_factory = T
    for (name, kind) in c.execute("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite\\_%' escape '\\' order by name").fetchall():
        name = name.decode()
        cols = [(r[1].decode(), (r[2] or b"").decode()) for r in c.execute("pragma table_xinfo(%s)" % q(name)) if r[6] in (0, 2, 3)]
        print("TABLE\t" + hx(name) + "\t" + kind.decode())
        print("COLS\t" + "\t".join(hx(a) + ":" + hx(b) for a, b in cols))
        # undeclared columns: storage classes present, by SQLite's typeof
        for (cn, ct) in cols:
            classes = sorted({r[0].decode() for r in c.execute("select distinct typeof(%s) from %s" % (q(cn), q(name)))} - {"null"})
            print("CLASSES\t" + hx(cn) + "\t" + ",".join(classes))
        for row in c.execute("select %s from %s" % (", ".join(q(a) for a, _ in cols), q(name))):
            print("ROW\t" + "\t".join(canon(v) for v in row))


if __name__ == "__main__":
    if sys.argv[1] == "build":
        build(sys.argv[2], sys.argv[3])
    else:
        dump(sys.argv[2])
