"""Independent Pandas/ReadStat DTA corpus. Run with the existing Conda myproject Python."""
import datetime, hashlib, json, math, struct, sys
from pathlib import Path
import numpy as np
import pandas as pd
import pyreadstat

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime(2026, 10, 31, 12, 0)
cases = {}
for release in (117, 118, 119):
    for order, tag in (('<', 'le'), ('>', 'be')):
        text = 'München' if release == 117 else 'İstanbul σ😀'
        df = pd.DataFrame({
            'byte_value': np.array([-127, 0, 100, 1], dtype='int8'),
            'int_value': np.array([-32767, 32740, 1, 0], dtype='int16'),
            'long_value': np.array([-2147483647, 2147483620, 0, 7], dtype='int32'),
            'float_value': np.array([-1.5, 1.25, np.nan, 1e30], dtype='float32'),
            'double_value': np.array([-1.25, 1e200, np.nan, -0.0], dtype='float64'),
            'code': ['007', '010', '123', ''],
            'text': [text, 'a&b <c>', '', ' padded '],
            'long_text': ['long ' * 600, '', 'same ' * 600, 'long ' * 600],
            'status': np.array([1, 2, 1, 3], dtype='int8'),
        })
        name = f'v{release}-{tag}.dta'
        df.to_stata(out / name, write_index=False, version=release, byteorder=order,
                    time_stamp=stamp, data_label=f'Lossless DTA {release}',
                    variable_labels={'code': 'Do not turn text into numbers', 'status': 'State'},
                    value_labels={'status': {1: 'one', 2: 'two', 3: 'three'}},
                    convert_strl=['long_text'] if release == 117 else None)
        cases[name] = {}

df.head(0).to_stata(out / 'empty-118.dta', write_index=False, version=118, time_stamp=stamp)
cases['empty-118.dta'] = {}

# Exercise all five on-disk numeric missing encodings; both independent readers verify the tags below.
data = bytearray((out / 'v118-le.dta').read_bytes())
start = data.index(b'<data>') + 6
row_width = 1 + 2 + 4 + 4 + 8 + 3 + len('İstanbul σ😀'.encode()) + 8 + 1
for row, tag in ((1, 1), (2, 26), (3, 0)):
    encoded = struct.pack('<bhI', 101 + tag, 32741 + tag, 2147483621 + tag)
    encoded += struct.pack('<IQ', 0x7f000000 + tag * 0x800, 0x7fe0000000000000 + tag * 0x10000000000)
    data[start + row * row_width:start + row * row_width + len(encoded)] = encoded
(out / 'all-tags-118.dta').write_bytes(data)
cases['all-tags-118.dta'] = {}

pd.DataFrame({'id': np.arange(20_000, dtype=np.int32), 'value': np.arange(20_000, dtype=np.float64) / 8}).to_stata(
    out / 'paged-119.dta', write_index=False, version=119, time_stamp=stamp)
cases['paged-119.dta'] = {'paging': True}

# ReadStat independently produces extended missing tags and date/time display metadata.
tagged = pd.DataFrame({'value': [1.5, 'a', 'z', None], 'day': [0., 1., -1., None],
                       'clock': [0., 1., -1000., None], 'code': ['007', '010', '123', '']})
for version in (14, 15):
    name = f'readstat-{version}.dta'
    pyreadstat.write_dta(tagged, out / name, version=version, file_label='Tags and temporal formats',
                        column_labels={'value': 'Tagged missing values'},
                        missing_user_values={'value': ['a', 'z']},
                        variable_format={'day': '%td', 'clock': '%tc'})
    # Only the header timestamp varies; replace it without altering field lengths.
    data = (out / name).read_bytes(); a = data.index(b'<timestamp>') + len(b'<timestamp>')
    n = data[a]; fixed = b'31 Oct 2026 12:00'
    assert n == len(fixed)
    (out / name).write_bytes(data[:a+1] + fixed + data[a+1+n:])
    cases[name] = {}

for name in cases:
    df, meta = pyreadstat.read_dta(out / name, user_missing=True, disable_datetime_conversion=True,
                                  apply_value_formats=False)
    nulls, _ = pyreadstat.read_dta(out / name, user_missing=False, disable_datetime_conversion=True,
                                  apply_value_formats=False)
    # Pandas independently verifies row values and labels on every fixture too.
    with pd.io.stata.StataReader(out / name, convert_dates=False, convert_categoricals=False,
                                convert_missing=True) as reader:
        other = reader.read()
        assert list(other.columns) == list(df.columns)
        assert other.shape == df.shape
        for column in df:
            for row_index, (a, b) in enumerate(zip(df[column], other[column])):
                if isinstance(b, pd.io.stata.StataMissingValue):
                    if b.string == '.':
                        # Use ReadStat's default null mask for system missing alongside tagged integers.
                        assert pd.isna(nulls.at[row_index, column]), (name, column, row_index)
                        df.at[row_index, column] = np.nan
                    else:
                        assert b.string == '.' + str(a), (name, column, a, b.string)
                else:
                    assert a == b, (name, column, a, b)
    def cell(value, column):
        kind = meta.readstat_variable_types[column]
        if kind != 'string' and isinstance(value, str): return {'missing': '.' + value}
        if isinstance(value, float) and math.isnan(value): return {'missing': '.'}
        if kind == 'string': return {'text': value}
        if kind.startswith('int'): return {'integer': int(value)}
        return {'float': float(value)}
    data = (out / name).read_bytes()
    paging = cases[name].get('paging', False)
    cases[name] = {
        'sha256': hashlib.sha256(data).hexdigest(),
        'release': int(data.split(b'<release>')[1][:3]), 'label': meta.file_label or '',
        'columns': [{'name': c, 'label': meta.column_names_to_labels[c] or '',
                     'kind': meta.readstat_variable_types[c], 'width': meta.variable_storage_width[c],
                     'format': meta.original_variable_types[c], 'value_label': meta.variable_to_label.get(c, '')}
                    for c in df],
        'value_labels': meta.value_labels,
        'rows': [[cell(row[c], c) for c in df] for _, row in (df.iloc[[0, 17, 9999, 19999]] if paging else df).iterrows()],
        'offsets': [0, 17, 9999, 19999] if paging else list(range(len(df))),
        'row_count': len(df),
    }
(out / 'expected.json').write_text(json.dumps(cases, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
print(f'Generated and independently verified {len(cases)} DTA fixtures.')
