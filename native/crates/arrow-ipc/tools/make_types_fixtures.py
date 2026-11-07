"""D3.9 type zoo: one column per Arrow type family, written by PyArrow (stream/file, plain/zstd/lz4) and Polars,
with expected.json-style values read back by PyArrow and rendered to the text the viewer shows.
Run: /Users/macc/miniforge3/envs/myproject/bin/python -I tools/make_types_fixtures.py tests/fixtures"""
import datetime, decimal, json, sys, warnings
warnings.simplefilter('ignore')
from pathlib import Path
import numpy as np
import pyarrow as pa, pyarrow.ipc as ipc
import polars as pl

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
D = decimal.Decimal
LONG = 'a long utf8 view value, past the twelve byte inline limit'
cols = {
    'bin': pa.array([b'\x00\xff', b'', None, b'abc'], pa.binary()),
    'lbin': pa.array([b'x', None, b'\x01\x02', b''], pa.large_binary()),
    'fbin': pa.array([b'abcd', None, b'wxyz', b'0000'], pa.binary(4)),
    'sview': pa.array([LONG, 'short', None, ''], pa.string_view()),
    'bview': pa.array([b'\x01' * 20, b'ab', None, b''], pa.binary_view()),
    'i8': pa.array([-128, 127, None, 0], pa.int8()),
    'u32': pa.array([0, 4294967295, None, 7], pa.uint32()),
    'f32': pa.array([1.5, float('inf'), None, float('nan')], pa.float32()),
    'f64': pa.array([0.1, -0.0, None, 1e300], pa.float64()),
    'dec128': pa.array([D('-12345678901234567890.12'), D('0.01'), None, D('99999999999999999999.99')], pa.decimal128(22, 2)),
    'dec256': pa.array([D('1' * 40 + '.5'), D('-1.5'), None, D('0.0')], pa.decimal256(45, 4)),
    'd32': pa.array([datetime.date(1970, 1, 1), datetime.date(2026, 10, 31), None, datetime.date(1900, 2, 28)], pa.date32()),
    'd64': pa.array([datetime.date(1970, 1, 2), None, datetime.date(2000, 2, 29), datetime.date(2026, 10, 31)], pa.date64()),
    't32': pa.array([datetime.time(1, 2, 3), None, datetime.time(0, 0), datetime.time(23, 59, 59)], pa.time32('s')),
    't64': pa.array([datetime.time(1, 2, 3, 456789), None, datetime.time(0, 0), datetime.time(23, 59, 59, 999999)], pa.time64('us')),
    'dur': pa.array([1, -2, None, 3_600_000_000], pa.int64()).cast(pa.duration('us')),
    'ts_ns': pa.array([1, 2**62, None, -5], pa.int64()).cast(pa.timestamp('ns')),
    'ts_named': pa.array([0, 1_700_000_000_000_000, None, 5], pa.int64()).cast(pa.timestamp('us', 'Europe/Istanbul')),
    'null': pa.nulls(4),
    'lst': pa.array([[1, 2], None, [], [2**53 + 1]], pa.list_(pa.int64())),
    'llst': pa.array([['a'], None, [None, 'b', ''], []], pa.large_list(pa.string())),
    'fsl': pa.array([[1, 2], None, [3, 4], [5, 6]], pa.list_(pa.int32(), 2)),
    'st': pa.array([{'a': 1, 'b': 'x'}, None, {'a': None, 'b': 'y'}, {'a': 4, 'b': None}], pa.struct([('a', pa.int64()), ('b', pa.string())])),
    'mp': pa.array([[('k', 1)], None, [], [('p', None), ('q', 2)]], pa.map_(pa.string(), pa.int64())),
    'dict_i64': pa.DictionaryArray.from_arrays(pa.array([0, 1, None, 0], pa.int16()), pa.array([2**53 + 1, -7], pa.int64())),
    'dict_nullval': pa.DictionaryArray.from_arrays(pa.array([0, 1, None, 1], pa.int8()), pa.array(['a', None], pa.string())),
    'dict_lstr': pa.DictionaryArray.from_arrays(pa.array([1, 0, None, 1], pa.uint8()), pa.array(['p', 'q'], pa.large_string())),
}
SCHEMA = pa.schema([pa.field(k, v.type, metadata={'col': k}) for k, v in cols.items()], metadata={'origin': 'd3-9-types'})
TABLE = pa.table(cols, schema=SCHEMA)

def write(path, kind, comp=None):
    opts = ipc.IpcWriteOptions(compression=comp)
    with pa.OSFile(str(path), 'wb') as f, (ipc.new_stream if kind == 'stream' else ipc.new_file)(f, SCHEMA, options=opts) as w:
        for lo in (0, 2):
            w.write_table(TABLE.slice(lo, 2))
for comp in (None, 'zstd', 'lz4'):
    tag = '' if comp is None else '-' + comp
    write(out / f'types{tag}.arrows', 'stream', comp)
    write(out / f'types{tag}.feather', 'file', comp)

# Expected display text, derived from PyArrow's own to_pylist(): this is the independent half.
def iso(dt): return dt.isoformat(sep='T')
def nn(v, t): return 'null' if v is None else show(v, t)
def show(v, t):
    if v is None: return None
    if pa.types.is_binary(t) or pa.types.is_large_binary(t) or pa.types.is_fixed_size_binary(t) or pa.types.is_binary_view(t): return v.hex()
    if pa.types.is_floating(t):
        if v != v: return 'NaN'
        if v in (float('inf'), float('-inf')): return 'inf' if v > 0 else '-inf'
        return (repr(float(np.float32(v))) if pa.types.is_float32(t) else repr(v)).replace('e+', 'e')
    if pa.types.is_decimal(t): return format(v, 'f')
    if pa.types.is_date32(t): return v.isoformat()
    if pa.types.is_date64(t): return v.isoformat() + 'T00:00:00'  # arrow-cast shows Date64 as a datetime
    if pa.types.is_time(t): return v.isoformat()
    if pa.types.is_list(t) or pa.types.is_large_list(t) or pa.types.is_fixed_size_list(t): return '[' + ', '.join(nn(x, t.value_type) for x in v) + ']'
    if pa.types.is_struct(t): return '{' + ', '.join(f"{f.name}: {nn(v[f.name], f.type)}" for f in t) + '}'
    if pa.types.is_map(t): return '{' + ', '.join(f"{show(k, t.key_type)}: {nn(x, t.item_type)}" for k, x in v) + '}'
    if pa.types.is_boolean(t): return 'true' if v else 'false'
    return str(v)
expected = {'rows': TABLE.num_rows, 'schema_metadata': {'origin': 'd3-9-types'}, 'columns': []}
rt = ipc.open_file(str(out / 'types.feather')).read_all()   # read back through the written file, not the in-memory table
for f in rt.schema:
    c = rt.column(f.name)
    t = f.type
    if pa.types.is_dictionary(t):
        vals = [None if x is None else str(x) for x in c.to_pylist()]
    elif pa.types.is_timestamp(t) or pa.types.is_duration(t):
        vals = [None if x is None else str(x) for x in c.cast(pa.int64()).to_pylist()]
    elif pa.types.is_null(t):
        vals = [None] * len(c)
    else:
        vals = [show(x, t) for x in c.to_pylist()]
    expected['columns'].append({'name': f.name, 'type': str(t), 'metadata': {k.decode(): v.decode() for k, v in (f.metadata or {}).items()}, 'values': vals})
(out / 'expected-types.json').write_text(json.dumps(expected, indent=1))

# Polars writes (independent writer), including the oldest-compat form and Utf8View/Categorical.
df = pl.DataFrame({'n': [2**53 + 1, -(2**63), None], 'f': [1.5, float('nan'), None], 's': ['a', None, LONG],
                   'b': [True, None, False], 'lst': [[1, 2], None, []], 'bin': [b'\x00', None, b'ab'],
                   'dt': [datetime.datetime(2026, 10, 31, 1, 2, 3, 456789), None, datetime.datetime(1900, 1, 1)],
                   'dec': pl.Series([D('1.50'), None, D('-99999999999999999.99')], dtype=pl.Decimal(22, 2))})
df.write_ipc(out / 'polars-types.feather'); df.write_ipc_stream(out / 'polars-types.arrows')
df.write_ipc(out / 'polars-types-zstd.feather', compression='zstd')
assert pl.read_ipc(out / 'polars-types.feather').equals(df, null_equal=True)
pol = {'rows': df.height, 'columns': {c: [None if x is None else (x.hex() if isinstance(x, bytes) else json.dumps(x) if isinstance(x, list) else str(x)) for x in df[c].to_list()] for c in df.columns}}
(out / 'expected-polars-types.json').write_text(json.dumps(pol, indent=1, default=str))
print('ok', len(expected['columns']), 'columns')
