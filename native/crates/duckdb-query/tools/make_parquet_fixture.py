"""Writes tests/fixtures/types.parquet with pyarrow and prints pyarrow's own reading of it (the independent
expected values embedded in tests/engine.rs). Run with the conda env `myproject` (read-only use)."""
import datetime as dt, decimal, json, pathlib, pyarrow as pa, pyarrow.parquet as pq
D = decimal.Decimal
out = pathlib.Path(__file__).resolve().parents[1] / "tests/fixtures/types.parquet"
t = pa.table({
    "big": pa.array([9007199254740993, -9007199254740993, None], pa.int64()),
    "dec": pa.array([D("12345.67"), D("-0.05"), None], pa.decimal128(10, 2)),
    "wide": pa.array([D("1234567890123456789012345678.1234567890"), D("0E-10"), None], pa.decimal128(38, 10)),
    "d": pa.array([dt.date(2024, 1, 31), dt.date(1969, 12, 31), None], pa.date32()),
    "ts": pa.array([dt.datetime(2024, 1, 31, 12, 34, 56, 789012), dt.datetime(1999, 12, 31, 23, 59, 59), None], pa.timestamp("us")),
    "tstz": pa.array([dt.datetime(2024, 1, 31, 12, 34, 56, 789012, tzinfo=dt.timezone.utc), None, None], pa.timestamp("us", tz="UTC")),
    "s": pa.array(["İstanbul σ 😀", "it's \"quoted\"", None], pa.string()),
    "b": pa.array([True, False, None], pa.bool_()),
    "f": pa.array([0.1, 1e300, None], pa.float64()),
    "lst": pa.array([[1, 2, 3], [], None], pa.list_(pa.int32())),
    "st": pa.array([{"a": 1, "b": "x"}, {"a": None, "b": None}, None], pa.struct([("a", pa.int64()), ("b", pa.string())])),
    "mp": pa.array([[("k", 1)], [], None], pa.map_(pa.string(), pa.int32())),
})
pq.write_table(t, out, compression="none", row_group_size=2)
r = pq.read_table(out)
f = pq.ParquetFile(out)
print(json.dumps({
    "schema": [(x.name, str(x.physical_type), str(x.logical_type), x.converted_type if hasattr(x, "converted_type") else None) for x in (f.schema.column(i) for i in range(len(f.schema)))],
    "num_rows": f.metadata.num_rows, "row_groups": f.metadata.num_row_groups,
    "rows": {c: [str(v) if v is not None else None for v in r.column(c).to_pylist()] for c in r.column_names},
}, ensure_ascii=False, indent=1, default=str))
