import sys, sqlite3, os
import pandas as pd, pyarrow as pa, pyarrow.ipc as ipc, pyarrow.parquet as pq, duckdb
d = sys.argv[1]; os.makedirs(d, exist_ok=True)
df = pd.DataFrame({'id': [1, 2, 3], 'name': ['alpha', 'beta', 'gamma'], 'score': [10.5, 20.25, 30.0]})
t = pa.Table.from_pandas(df)
pq.write_table(t, f'{d}/sample.parquet')
df.to_excel(f'{d}/sample.xlsx', index=False)
with ipc.new_file(f'{d}/sample.arrow', t.schema) as w: w.write_table(t)
with ipc.new_stream(f'{d}/sample.arrows', t.schema) as w: w.write_table(t)
import pyarrow.feather as ft; ft.write_feather(t, f'{d}/sample.feather', compression='uncompressed')  # the viewer cannot read compressed Feather
df.to_stata(f'{d}/sample.dta', write_index=False, version=118)  # pandas' default (114) is not readable by DuckDB read_dta
for n in ('sample.sqlite', 'sample.db'):
    p = f'{d}/{n}'
    if os.path.exists(p): os.remove(p)
    c = sqlite3.connect(p); df.to_sql('items', c, index=False); c.commit(); c.close()
p = f'{d}/sample.duckdb'
if os.path.exists(p): os.remove(p)
c = duckdb.connect(); c.register('df', df)  # pin the storage format: a newer duckdb defaults to files the bundled engine (64-68) rejects
c.execute(f"attach '{p}' as o (storage_version 'v1.4.0')"); c.execute('create table o.items as select * from df'); c.close()
