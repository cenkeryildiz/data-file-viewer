"""Regenerates the frozen kdb+ corpus in this directory with a real q (pykx) and writes expected.tsv.

Run once, not in CI:  QLIC=~/.pykx-license python -I generate_corpus.py <outdir>
q writes every *.kdb file with `` `:file set table`` and reads it back itself (`get`); expected.tsv is derived from
q's own read-back (raw numeric casts plus q's `string` rendering), then converted to the Rust decoder's units with
Python arithmetic, never with the Rust code under test. The files are frozen: the Rust test checks their hashes.
Format of expected.tsv, one tab-separated line per item: `file ROWS n`, `file COL index name_json q_type cell...`,
`file ERR code`.  Cell grammar: null | b:0/1 | i:<int> | f4:<hex32> | f8:<hex64> | s:<ascii-json string> |
<tag>:<int> (p micros, m/d days, z micros, n nanos, u/v/t micros) | [cell,...] | {keys=>values}.
"""
import datetime as dt
from fractions import Fraction
import hashlib
import json
import math
import os
import random
import struct
import sys

os.environ.setdefault("QLIC", os.path.expanduser("~/.pykx-license"))  # must precede the pykx import
import pykx as kx  # noqa: E402

q = kx.q
out = os.path.abspath(sys.argv[1])
os.makedirs(out, exist_ok=True)
EPOCH_DAYS = 10957  # 1970-01-01 -> 2000-01-01


def js(s):
    return "s:" + json.dumps(s, ensure_ascii=True)


def f4(x):
    return "f4:%08x" % struct.unpack("<I", struct.pack("<f", x))[0]


def f8(x):
    return "f8:%016x" % struct.unpack("<Q", struct.pack("<d", x))[0]


def civil_days(y, m, d):
    """Days since 1970-01-01 of a proleptic Gregorian date (any year; datetime only covers 1..9999)."""
    if 1 <= y <= 9999:
        return dt.date(y, m, d).toordinal() - 719163
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m - 3 if m > 2 else m + 9) + 2) // 5 + d - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468


def trunc_div(a, b):
    return -(-a // b) if a < 0 else a // b


def round_half_up(x):
    return math.floor(x + 0.5) if abs(x) < 2**52 else x


q("{[]}")  # warm-up
UNDERLYING = {1: "boolean", 4: "byte", 5: "short", 6: "int", 7: "long", 8: "real", 9: "float", 12: "long", 13: "int",
              14: "int", 15: "float", 16: "long", 17: "int", 18: "int", 19: "int"}
NULLS = q("{null x}")
STRS = q("{string each x}")


def vec_cells(v, atom=False):
    """Canonical cells of any q vector, from q's own view of it."""
    t = int(q("{abs type x}", v))
    n = int(q("count", v))
    if t == 0:
        return [elem_cell(q("{x y}", v, kx.LongAtom(i))) for i in range(n)]
    nul = NULLS(v).py()
    if t in (2, 11):
        raw = STRS(v).py()
    elif t == 10:
        raw = [ord(c) for c in q("{`char$x}", v).py()] if False else list(q("{`byte$x}", v).np())
    else:
        # q's own cast to the underlying type, then numpy: raw values, no infinity/null translation
        raw = [x.item() for x in q("{x$y}", kx.SymbolAtom(UNDERLYING[t]), v).np()]
    out_ = []
    for i in range(n):
        if t == 1:
            out_.append("b:%d" % raw[i])
            continue
        if t == 4:
            out_.append("i:%d" % raw[i])
            continue
        if t == 10 and raw[i] == 32 and atom:  # a char atom 32 is null; inside a char vector it stays a space (as the TS)
            out_.append("null")
            continue
        if nul[i] and t != 10:
            out_.append("null")
            continue
        r = raw[i]
        if t in (5, 6, 7):
            out_.append("i:%d" % r)
        elif t == 8:
            out_.append(f4(r))
        elif t == 9:
            out_.append(f8(r))
        elif t == 10:
            out_.append(js(chr(r)))  # ASCII only: UTF-8 char columns are a refused case
        elif t == 11:
            out_.append(js(r.decode("utf-8") if isinstance(r, bytes) else r))
        elif t == 2:
            out_.append(js(r if isinstance(r, str) else r.decode()))
        elif t == 12:
            out_.append("p:%d" % (trunc_div(r, 1000) + EPOCH_DAYS * 86400 * 10**6))
        elif t == 13:
            out_.append("m:%d" % civil_days(2000 + r // 12, r % 12 + 1, 1))
        elif t == 14:
            out_.append("d:%d" % (r + EPOCH_DAYS))
        elif t == 15:
            # Independently round q's stored double with exact rational arithmetic.
            out_.append("z:%d" % math.floor((Fraction(r) + EPOCH_DAYS) * 86400 * 10**6 + Fraction(1, 2)))
        elif t == 16:
            out_.append("n:%d" % r)
        elif t == 17:
            out_.append("u:%d" % (r * 60 * 10**6))
        elif t == 18:
            out_.append("v:%d" % (r * 10**6))
        elif t == 19:
            out_.append("t:%d" % (r * 1000))
        else:
            raise SystemExit(f"type {t} not handled")
    return out_


def elem_cell(e):
    t = int(q("{type x}", e))
    if t == 0:
        return "[" + ",".join(vec_cells(e)) + "]"
    if t < 0:
        return vec_cells(q("enlist", e), atom=True)[0]
    return "[" + ",".join(vec_cells(e)) + "]"


LINES = []
MANIFEST = {}


def write(name, expr, note):
    """Have q write `expr` (a table) to <name>.kdb, then record what q reads back."""
    path = os.path.join(out, name + ".kdb")
    if os.path.exists(path):
        os.remove(path)
    q(f'(`$":{path}") set {" ".join(expr.split())}')
    back = q(f'get `$":{path}"')
    cols = list(q("cols", back).py())
    LINES.append(f"{name}\tROWS\t{int(q('count', back))}")
    for i, c in enumerate(cols):
        col = q("{x y}", back, kx.SymbolAtom(c))
        t = int(q("{type x}", col))
        LINES.append("\t".join([name, "COL", str(i), json.dumps(c), str(t)] + vec_cells(col)))
    MANIFEST[name + ".kdb"] = {"sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
                               "bytes": os.path.getsize(path), "note": note}


# 1. every atom type with its null, infinities and extremes (hand-chosen so the expected values are checkable by eye)
write("atoms", """([]
 b:10110101b; g:(0Ng;"G"$"8c6b8b64-6815-6084-0a3e-178401251b68";"G"$"00000000-0000-0000-0000-000000000001";0Ng;"G"$"ffffffff-ffff-ffff-ffff-ffffffffffff";0Ng;"G"$"deadbeef-0000-4000-8000-000000000000";0Ng);
 x:0x0001ff7f80aa5501; h:0N -32767 32767 0 -1 1 0W -0Wh;
 i:0N -2147483647 2147483647 0 -1 1 0W -0Wi; j:0N -9223372036854775807 9223372036854775807 0 -1 1 0W -0Wj;
 e:`real$(0n;0w;-0w;0f;-0f;1.5;3.4028235e38;1.4e-45);
 f:(0n;0w;-0w;0f;-0f;5e-324;1.7976931348623157e308;0.1);
 c:"a z.~0 9"; s:(`a;`;`$"İstanbul";`a_long_symbol_0123456789;`$"x y";`$"日本語";`end;`$"");
 p:(2000.01.01D00:00:00.000000000;2024.02.29D12:34:56.123456789;1999.12.31D23:59:59.999999999;0Np;0Wp;-0Wp;1969.12.31D23:59:59.999999999;1970.01.01D00:00:00.000000001);
 m:(2000.01m;2024.02m;1999.12m;0Nm;0Wm;-0Wm;0001.01m;9999.12m);
 d:(2000.01.01;2024.02.29;1969.12.31;0Nd;0Wd;-0Wd;0001.01.01;9999.12.31);
 z:(2000.01.01T00:00:00.000;2024.02.29T12:34:56.789;0Nz;1969.12.31T23:59:59.999;1970.01.01T00:00:00.000;2000.01.01T00:00:00.001;1900.01.01T00:00:00.000;2100.06.15T01:02:03.004);
 n:(0D00:00:00.000000001;-0D00:00:00.000000001;0D12:34:56.123456789;0Nn;0Wn;-0Wn;0D00:00:00.000000000;106751D00:00:00.000000000);
 u:(12:34;00:00;23:59;0Nu;0Wu;-0Wu;-00:01;100:00);
 v:(12:34:56;00:00:00;23:59:59;0Nv;0Wv;-0Wv;-00:00:01;100:00:00);
 t:(12:34:56.789;00:00:00.000;23:59:59.999;0Nt;0Wt;-0Wt;-00:00:00.001;100:00:00.000))""",
      "every atom type 1..19 with null/infinity/extreme sentinels; UTF-8 symbols")

# 2. a seeded 1500-row table of every type with random raw values (nulls and infinities mixed in)
rng = random.Random(20261031)
N = 1500


def pick(special, gen, p=0.08):
    return [rng.choice(special) if rng.random() < p else gen() for _ in range(N)]


def L(xs):
    return kx.LongVector(xs)


rj = pick([-(2**63), 2**63 - 1, -(2**63) + 1, 0], lambda: rng.randint(-(2**62), 2**62))
ri = pick([-(2**31), 2**31 - 1, -(2**31) + 1, 0], lambda: rng.randint(-(2**31) + 1, 2**31 - 2))
rh = pick([-32768, 32767, -32767, 0], lambda: rng.randint(-32766, 32766))
rf = pick([float("nan"), float("inf"), float("-inf"), 0.0, -0.0, 5e-324, 1.7976931348623157e308],
          lambda: struct.unpack("<d", struct.pack("<Q", rng.getrandbits(64)))[0])
rz = pick([float("nan"), 0.0, 1e-9], lambda: rng.uniform(-40000, 60000))
rb = [rng.randint(0, 1) for _ in range(N)]
rx = [rng.randint(0, 255) for _ in range(N)]
rc = [rng.choice(list("abcXYZ019 .,;_~")) for _ in range(N)]
rs = [rng.choice(["a", "", "bb", "İstanbul", "日本", "sym_%d" % rng.randint(0, 99), "x y"]) for _ in range(N)]
for _n, _v in dict(randj=L(rj), randi=kx.IntVector(ri), randh=kx.ShortVector(rh), randf=kx.FloatVector(rf), randz=kx.FloatVector(rz),
                   randb=kx.BooleanVector([bool(x) for x in rb]), randx=kx.ByteVector(rx), randc=kx.CharVector("".join(rc)),
                   rands=kx.SymbolVector(rs)).items():
    q[_n] = _v
q["randg"] = kx.GUIDVector([__import__("uuid").UUID(int=rng.getrandbits(128)) if rng.random() > 0.05 else __import__("uuid").UUID(int=0) for _ in range(N)])
write("random1500", """([]
 b:randb; g:randg; x:randx; h:randh; i:randi; j:randj; e:`real$randf; f:randf; c:randc; s:rands;
 p:`timestamp$randj; m:`month$randi; d:`date$randi; z:`datetime$randz; n:`timespan$randj;
 u:`minute$randi; v:`second$randi; t:`time$randi)""",
      "1500 rows x 18 types, seeded random raw values with sentinels")

# 3. general (mixed) list columns and an empty-table shape, as q itself stores them
write("general_lists", """([] id:1 2 3 4j; mixed:(1j;2.5f;`sym;"c"); vecs:(1 2 3j;`a`b;"str";enlist 1.5f); empty:(();`long$();`symbol$();""))""",
      "general list columns: atoms of different types, typed vectors, empty lists")
write("empty_table", "([] a:`long$(); s:`symbol$(); t:`timestamp$())", "zero rows, typed columns")
write("single_row", "([] a:enlist 7j; s:enlist `only)", "one row")
write("wide_names", """flip (`$("a b";"Ünï";"select";"x1";"_x"))!(1 2j;`p`q;3 4f;1 0b;"ab")""", "unusual column names")

# 4. kinds of file the reader must refuse; q writes them all
ERR = []


def refuse(name, expr, code, note, zd=None):
    path = os.path.join(out, name + ".kdb")
    if os.path.isdir(path):
        raise SystemExit("unexpected directory")
    if os.path.exists(path):
        os.remove(path)
    if zd:
        q(f".z.zd:{zd}")
    # q only compresses extensionless targets, so write one and rename it
    target = path[: -len(".kdb")] if zd else path
    q(f'(`$":{target}") set {expr}')
    q("system \"x .z.zd\"")
    if zd:
        os.replace(target, path)
    ERR.append(f"{name}\tERR\t{code}")
    MANIFEST[name + ".kdb"] = {"sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
                               "bytes": os.path.getsize(path), "note": note}


q("`sym set `symbol$()")
refuse("compressed", "([] a:til 2000)", "kdb_compressed", "q file compression (.z.zd), header 'kxzipped'", zd="(17;2;6)")
refuse("enumerated", "([] s:`sym?`a`b`a)", "kdb_unsupported_type", "enumerated symbol column (type 21) in a flat table")
refuse("keyed_table", "([k:1 2j] v:`a`b)", "kdb_not_a_table", "keyed table (a dict of two tables)")
refuse("plain_list", "1 2 3j", "kdb_bad_header", "a vector: q writes it with a different (0xfe 0x20) header")
refuse("symbol_atom", "`abc", "kdb_not_a_table", "an atom, not a table")
refuse("dict", "`a`b!1 2j", "kdb_not_a_table", "a dict, not a table")
refuse("lambda", "{x+1}", "kdb_not_a_table", "a function object")
refuse("utf8_char_column", """([] a:1 2 3j; c:"aé")""", "kdb_ragged_columns",
       "a char column holding UTF-8 bytes decodes to fewer code points than rows: refused, not misaligned")
refuse("inf_datetime", "([] z:enlist 0wz)", "kdb_datetime_out_of_range", "0wz does not fit i64 microseconds")
# splayed directory pieces written by q: the .d file is a symbol vector, a column file has a different header
spl = os.path.join(out, "splayed")
import shutil
shutil.rmtree(spl, ignore_errors=True)
q(f'(`$":{spl}/") set ([] a:1 2 3j; s:`sym?`a`b`c)')
for f, code in ((".d", "kdb_not_a_table"), ("a", "kdb_bad_header"), ("s", "kdb_bad_header")):
    os.replace(os.path.join(spl, f), os.path.join(out, "splayed_" + f.strip(".") + ".kdb"))
    ERR.append(f"splayed_{f.strip('.')}\tERR\t{code}")
    p = os.path.join(out, "splayed_" + f.strip(".") + ".kdb")
    MANIFEST[os.path.basename(p)] = {"sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(),
                                      "bytes": os.path.getsize(p), "note": f"q splayed column/dir file {f}"}
shutil.rmtree(spl, ignore_errors=True)

open(os.path.join(out, "expected.tsv"), "w").write("\n".join(LINES + ERR) + "\n")
json.dump({"generator": "generate_corpus.py", "pykx": kx.__version__, "q_release": str(q(".z.K")) + " " + str(q(".z.k")),
           "files": MANIFEST}, open(os.path.join(out, "manifest.json"), "w"), indent=1, sort_keys=True)
print("ok", len(MANIFEST), "files")
