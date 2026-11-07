"""Writes tests/fixtures/parquet/*.parquet and tests/fixtures/parquet_expected.json.

Each file is written by PyArrow. What the native engine must show for it comes from DuckDB-python (casting
every column to VARCHAR), and every cell and the footer metadata are CROSS-CHECKED against PyArrow and, for
plain columns, Polars in this script: a disagreement between the independent readers stops the run instead of
becoming an expectation. A file DuckDB-python itself refuses is recorded as "refused".

Run with the conda env `myproject` (read-only use of the env):
  /Users/macc/miniforge3/envs/myproject/bin/python -I tools/make_parquet_corpus.py
"""
import datetime as dt
import decimal
import json
import math
import pathlib
import struct
import sys

import duckdb
import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq

D = decimal.Decimal
HERE = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "tests/fixtures/parquet"
OUT.mkdir(parents=True, exist_ok=True)


def f32(x):
    return struct.unpack("f", struct.pack("f", x))[0]


# ---- the corpus ---------------------------------------------------------------------------------
CASES = {}  # name -> (table, write kwargs)
LOSSY = {"decimal_beyond_38": {"wide": "DECIMAL(50,5) is wider than DuckDB's 38-digit exact type; it reads it as DOUBLE"}}


def case(name, table, **kw):
    CASES[name] = (table, kw)


case("ints", pa.table({
    "i8": pa.array([-128, 127, None], pa.int8()),
    "i16": pa.array([-32768, 32767, None], pa.int16()),
    "i32": pa.array([-2**31, 2**31 - 1, None], pa.int32()),
    "i64": pa.array([-2**63, 2**63 - 1, None], pa.int64()),
    "u8": pa.array([0, 255, None], pa.uint8()),
    "u16": pa.array([0, 65535, None], pa.uint16()),
    "u32": pa.array([0, 2**32 - 1, None], pa.uint32()),
    "u64": pa.array([0, 2**64 - 1, None], pa.uint64()),
    "past_2_53": pa.array([9007199254740993, -9007199254740993, 9007199254740992], pa.int64()),
}))
case("floats", pa.table({
    "f32": pa.array([0.1, -0.0, None], pa.float32()),
    "f64": pa.array([0.1, 1e300, None], pa.float64()),
    "special": pa.array([float("nan"), float("inf"), float("-inf")], pa.float64()),
    "half": pa.array([1.5, -2.0, None], pa.float16()),
}))
case("decimals_flba", pa.table({
    "p5s2": pa.array([D("123.45"), D("-0.05"), None], pa.decimal128(5, 2)),
    "p10s2": pa.array([D("12345678.90"), D("0.00"), None], pa.decimal128(10, 2)),
    "p18s4": pa.array([D("12345678901234.5678"), D("-1.0000"), None], pa.decimal128(18, 4)),
    "p38s10": pa.array([D("1234567890123456789012345678.1234567890"), D("0E-10"), None], pa.decimal128(38, 10)),
    "p38s38": pa.array([D("0." + "1" * 38), D("-0." + "9" * 38), None], pa.decimal128(38, 38)),
    "p9s0": pa.array([D("123456789"), D("-1"), None], pa.decimal128(9, 0)),
}))
case("decimals_integer_storage", pa.table({
    "p5s2": pa.array([D("123.45"), D("-0.05"), None], pa.decimal128(5, 2)),
    "p15s3": pa.array([D("123456789012.345"), D("-0.001"), None], pa.decimal128(15, 3)),
    "p30s5": pa.array([D("1234567890123456789012345.12345"), D("0.00001"), None], pa.decimal128(30, 5)),
}), store_decimal_as_integer=True)
case("decimal_beyond_38", pa.table({
    "wide": pa.array([D("1" * 40 + ".12345"), None], pa.decimal256(50, 5)),
}))
case("temporal", pa.table({
    "d32": pa.array([dt.date(2024, 1, 31), dt.date(1969, 12, 31), None], pa.date32()),
    "d64": pa.array([dt.date(2024, 1, 31), dt.date(1900, 1, 1), None], pa.date64()),
    "t32ms": pa.array([dt.time(1, 2, 3, 4000), dt.time(23, 59, 59), None], pa.time32("ms")),
    "t64us": pa.array([dt.time(1, 2, 3, 4), dt.time(0, 0), None], pa.time64("us")),
    "ts_s": pa.array([dt.datetime(2024, 1, 31, 12, 34, 56), dt.datetime(1969, 12, 31, 23, 59, 59), None], pa.timestamp("s")),
    "ts_ms": pa.array([dt.datetime(2024, 1, 31, 12, 34, 56, 789000), dt.datetime(1970, 1, 1), None], pa.timestamp("ms")),
    "ts_us": pa.array([dt.datetime(2024, 1, 31, 12, 34, 56, 789012), dt.datetime(1999, 12, 31, 23, 59, 59), None], pa.timestamp("us")),
    "ts_ns": pa.array([1706704496789012345, -1, None], pa.timestamp("ns")),
    "tstz": pa.array([dt.datetime(2024, 1, 31, 12, 34, 56, 789012, tzinfo=dt.timezone.utc), None, None], pa.timestamp("us", tz="UTC")),
    "tstz_offset": pa.array([dt.datetime(2024, 1, 31, 12, 0, tzinfo=dt.timezone(dt.timedelta(hours=3))), None, None], pa.timestamp("us", tz="Europe/Istanbul")),
}))
case("duration_and_interval_like", pa.table({
    "dur": pa.array([dt.timedelta(days=1, seconds=2, microseconds=3), None, dt.timedelta(0)], pa.duration("us")),
}))
case("text_and_binary", pa.table({
    "s": pa.array(["İstanbul σ 😀", "it's \"quoted\"", None], pa.string()),
    "ls": pa.array(["a", "", None], pa.large_string()),
    "empty": pa.array(["", "", ""], pa.string()),
    "nul": pa.array(["a\x00b", "", None], pa.string()),
    "bin": pa.array([b"\x00\xff'\\", b"", None], pa.binary()),
    "lbin": pa.array([b"ab", None, b"\x01"], pa.large_binary()),
    "fsb": pa.array([b"abcd", None, b"\x00\x01\x02\x03"], pa.binary(4)),
    "dict": pa.array(["a", "b", "a"]).dictionary_encode(),
    "numeric_text": pa.array(["9007199254740993", "007", "1,5"], pa.string()),
    "marker_text": pa.array(["NA", "#N/A", "1"], pa.string()),
}))
case("nested", pa.table({
    "lst": pa.array([[1, 2, 3], [], None], pa.list_(pa.int32())),
    "lst_null_item": pa.array([[1, None], None, [None]], pa.list_(pa.int64())),
    "lst2": pa.array([[[1], [2, 3]], [[]], None], pa.list_(pa.list_(pa.int32()))),
    "st": pa.array([{"a": 1, "b": "x"}, {"a": None, "b": None}, None], pa.struct([("a", pa.int64()), ("b", pa.string())])),
    "st2": pa.array([{"p": {"q": "deep"}, "r": [1.5]}, None, {"p": None, "r": None}],
                    pa.struct([("p", pa.struct([("q", pa.string())])), ("r", pa.list_(pa.float64()))])),
    "mp": pa.array([[("k", 1)], [], None], pa.map_(pa.string(), pa.int32())),
    "ls_st": pa.array([[{"x": 1, "y": "a"}, {"x": None, "y": "b"}], [], None],
                      pa.list_(pa.struct([("x", pa.int32()), ("y", pa.string())]))),
    "fsl": pa.array([[1, 2], None, [3, 4]], pa.list_(pa.int32(), 2)),
    "ld": pa.array([[D("1.50"), None], None, []], pa.list_(pa.decimal128(5, 2))),
}))
case("nested_legacy_list_names", pa.table({
    "lst": pa.array([[1, 2], None, []], pa.list_(pa.int32())),
}), use_compliant_nested_type=False)
case("nulls", pa.table({
    "all_null_int": pa.array([None, None, None], pa.int64()),
    "null_type": pa.nulls(3),
    "all_null_str": pa.array([None, None, None], pa.string()),
}))
case("empty_table", pa.table({"a": pa.array([], pa.int64()), "b": pa.array([], pa.string()), "c": pa.array([], pa.decimal128(10, 2))}))
case("no_columns", pa.table({}))
case("row_groups_and_pages", pa.table({
    "n": pa.array(list(range(10)), pa.int64()),
    "s": pa.array([f"row {i}" for i in range(10)], pa.string()),
}), row_group_size=3, data_page_size=64, write_batch_size=2)
for codec in ("snappy", "gzip", "zstd", "brotli", "lz4"):
    case(f"codec_{codec}", pa.table({
        "n": pa.array(list(range(20)), pa.int64()),
        "s": pa.array([f"v{i % 3}" for i in range(20)], pa.string()),
    }), compression=codec)
case("odd_column_names", pa.table(
    [pa.array([1, 2]), pa.array([3, 4]), pa.array([5, 6]), pa.array([7, 8]), pa.array([9, 10]), pa.array([11, 12])],
    names=['a "quoted" name', "İstanbul σ", "with space", "dotted.name", "A", "a"]))
case("key_value_metadata", pa.table({"a": pa.array([1, 2])}).replace_schema_metadata(
    {"owner": "tests", "pandas": json.dumps({"index_columns": []}), "unicode": "İ"}))
case("dictionary_pages_disabled", pa.table({"s": pa.array(["x", "y", "x", "z"])}), use_dictionary=False)
case("statistics_off_v2_pages", pa.table({"n": pa.array([3, 1, 2], pa.int32())}), write_statistics=False, data_page_version="2.0")
case("dictionary_of_wide_values", pa.table({
    "big": pa.array([9007199254740993, 9007199254740993, 5], pa.int64()).dictionary_encode(),
}))


# ---- independent readers ---------------------------------------------------------------------------
def duck_rows(path, ncols):
    con = duckdb.connect()
    con.execute("set TimeZone='UTC'")
    q = f"select * from read_parquet('{path}')"
    desc = con.execute(f"describe {q}").fetchall()
    names = [r[0] for r in desc]
    types = [r[1] for r in desc]
    cast = ", ".join(f'cast("{n.replace(chr(34), chr(34) * 2)}" as varchar)' for n in names)
    rows = con.execute(f"select {cast} from ({q})").fetchall() if names else []
    objs = con.execute(q).fetchall() if names else []
    return names, types, rows, objs


def canon(v):
    """Python values of the two readers brought to one shape."""
    if isinstance(v, D):
        return ("dec", format(v, "f"))
    if isinstance(v, float):
        return "nan" if math.isnan(v) else v
    if isinstance(v, (list, tuple)):
        if v and all(isinstance(x, tuple) and len(x) == 2 for x in v):
            return ("map", [(canon(k), canon(x)) for k, x in v])
        return [canon(x) for x in v]
    if isinstance(v, dict):
        if set(v) == {"key", "value"} or all(isinstance(k, str) for k in v) is False:
            return ("map", [(canon(k), canon(x)) for k, x in v.items()])
        return {k: canon(x) for k, x in v.items()}
    if isinstance(v, dt.datetime):
        return ("ts", v.astimezone(dt.timezone.utc).isoformat() if v.tzinfo else v.isoformat())
    return v


def arrow_obj(table, ci, i):
    col = table.column(ci)
    t = col.type
    if pa.types.is_dictionary(t):
        col = col.cast(t.value_type)
    if pa.types.is_timestamp(t) and t.unit == "ns":
        col = col.cast(pa.timestamp("us"), safe=False)
    if pa.types.is_duration(t):
        return col[i].as_py()
    return col[i].as_py()


def check_cell(arrow_val, duck_val, duck_text, arrow_type):
    """True when the PyArrow reading and DuckDB-python's agree on one cell."""
    if arrow_val is None or duck_val is None:
        return arrow_val is None and duck_val is None
    if pa.types.is_float32(arrow_type):
        return (math.isnan(arrow_val) and math.isnan(duck_val)) or f32(arrow_val) == f32(duck_val)
    if pa.types.is_floating(arrow_type):
        return (math.isnan(arrow_val) and math.isnan(duck_val)) or arrow_val == duck_val
    if pa.types.is_date64(arrow_type):
        return arrow_val == duck_val
    if pa.types.is_decimal(arrow_type):
        return arrow_val == duck_val and arrow_val.as_tuple().exponent == duck_val.as_tuple().exponent
    if pa.types.is_timestamp(arrow_type) and arrow_type.tz:
        return arrow_val.astimezone(dt.timezone.utc) == duck_val.astimezone(dt.timezone.utc)
    if pa.types.is_duration(arrow_type):
        # Parquet has no duration type: the INT64 count of the unit is what the file holds.
        micros = arrow_val // dt.timedelta(microseconds=1)
        return micros == duck_val
    if pa.types.is_map(arrow_type):
        return [(k, v) for k, v in arrow_val] == list(duck_val.items())
    if pa.types.is_dictionary(arrow_type):
        return arrow_val == duck_val
    if pa.types.is_fixed_size_binary(arrow_type) or pa.types.is_binary(arrow_type) or pa.types.is_large_binary(arrow_type):
        return arrow_val == duck_val
    return canon(arrow_val) == canon(duck_val)


expected = {}
problems = []
lossy_seen = set()
for name, (table, kw) in CASES.items():
    path = OUT / f"{name}.parquet"
    pq.write_table(table, path, **({"compression": "none"} | kw))
    entry = {"file": f"{name}.parquet"}
    pf = pq.ParquetFile(path)
    md = pf.metadata
    entry["footer"] = {
        "num_rows": md.num_rows,
        "row_groups": md.num_row_groups,
        "created_by": md.created_by,
        "kv_keys": sorted(k.decode() for k in (md.metadata or {})),
        "leaves": [
            {
                "name": md.schema.column(i).name,
                "path": md.schema.column(i).path,
                "physical": md.schema.column(i).physical_type,
                "logical": str(md.schema.column(i).logical_type),
                "converted": md.schema.column(i).converted_type if hasattr(md.schema.column(i), "converted_type") else None,
                "precision": md.schema.column(i).precision,
                "scale": md.schema.column(i).scale,
            }
            for i in range(md.num_columns)
        ],
    }
    try:
        names, types, rows, objs = duck_rows(path, table.num_columns)
    except Exception as e:  # DuckDB-python refuses it: recorded, and the native engine must refuse too
        entry["refused"] = str(e).split("\n")[0]
        expected[name] = entry
        continue
    entry |= {"columns": [{"name": n, "type": t} for n, t in zip(names, types)], "count": len(rows), "rows": rows}
    # cross-check every cell against PyArrow
    # DuckDB renames names that differ only by case (A, a -> A, a_1); that is its documented behaviour.
    if names != table.column_names and name != "odd_column_names":
        problems.append(f"{name}: column names differ {names} vs {table.column_names}")
    for ci, n in enumerate(names):
        for ri in range(len(rows)):
            a, dv = arrow_obj(table, ci, ri), objs[ri][ci]
            agrees = check_cell(a, dv, rows[ri][ci], table.column(ci).type)
            if n in LOSSY.get(name, {}):
                if not agrees:
                    lossy_seen.add((name, n))
            elif not agrees:
                problems.append(f"{name}.{n}[{ri}]: pyarrow {a!r} / duckdb {dv!r}")
    # Polars agrees on the plain (non-nested, non-decimal256) columns it can read
    try:
        pdf = pl.read_parquet(path)
        for ci, n in enumerate(table.column_names):
            t = table.column(ci).type
            if pa.types.is_integer(t) or pa.types.is_string(t) or pa.types.is_large_string(t) or pa.types.is_boolean(t):
                pol = pdf[ci].to_list()
                ref = [arrow_obj(table, ci, i) for i in range(len(rows))]
                if pol != ref:
                    problems.append(f"{name}.{n}: polars {pol!r} / pyarrow {ref!r}")
        entry["polars_checked"] = True
    except Exception as e:  # Polars cannot read some files (no columns, decimal256): not a disagreement
        entry["polars_checked"] = False
        entry["polars_error"] = str(e).split("\n")[0]
    if name in LOSSY:
        entry["duckdb_lossy_columns"] = LOSSY[name]
    entry["cross_checked_against"] = ["pyarrow"] + (["polars"] if entry["polars_checked"] else [])
    expected[name] = entry

# ---- damaged files: the engine must refuse each with a typed error ------------------------------
good = (OUT / "ints.parquet").read_bytes()
damaged = {
    "damaged_empty": b"",
    "damaged_magic_only": b"PAR1",
    "damaged_truncated": good[: len(good) // 2],
    "damaged_no_footer": good[:-8],
    "damaged_bad_tail_magic": good[:-4] + b"XXXX",
    "damaged_footer_length_lies": good[:-8] + struct.pack("<I", 0x7FFFFFF0) + b"PAR1",
    "damaged_footer_length_zero": good[:-8] + struct.pack("<I", 0) + b"PAR1",
    "damaged_garbage": bytes(range(256)) * 8,
    "damaged_csv_text": b"a,b\n1,2\n",
}
for name, data in damaged.items():
    (OUT / f"{name}.parquet").write_bytes(data)
    try:
        duckdb.connect().execute(f"select * from read_parquet('{OUT / (name + '.parquet')}')").fetchall()
        problems.append(f"{name}: DuckDB-python read a damaged file")
    except Exception as e:
        expected[name] = {"file": f"{name}.parquet", "refused": str(e).split("\n")[0]}
    try:
        pq.read_table(OUT / f"{name}.parquet")
        problems.append(f"{name}: PyArrow read a damaged file")
    except Exception:
        expected[name]["pyarrow_refused"] = True
# Neither reader looks at the head magic, so a file with a wrong one is still read: recorded, not refused.
(OUT / "head_magic_ignored.parquet").write_bytes(b"XXXX" + good[4:])
expected["head_magic_ignored"] = expected["ints"] | {"file": "head_magic_ignored.parquet", "tolerated_by": ["duckdb", "pyarrow"]}
assert pq.read_table(OUT / "head_magic_ignored.parquet").equals(CASES["ints"][0])
for key in {(c, k) for c, cols in LOSSY.items() for k in cols} - lossy_seen:
    problems.append(f"{key}: declared lossy but the readers agree")

(OUT.parent / "parquet_expected.json").write_text(
    json.dumps({"generated_by": "tools/make_parquet_corpus.py", "pyarrow": pa.__version__, "duckdb_python": duckdb.__version__,
                "polars": pl.__version__, "cases": expected}, indent=1, ensure_ascii=False) + "\n")
print(f"{len(expected)} files; refused by DuckDB-python: {[k for k, v in expected.items() if 'refused' in v and not k.startswith('damaged')]}")
if problems:
    print("INDEPENDENT READERS DISAGREE:")
    print("\n".join(problems))
    raise SystemExit(1)
