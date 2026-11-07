"""Independent producer and PyArrow/Polars/DuckDB full-value qualification."""
import datetime as dt
import decimal
import pathlib
import sys
import pyarrow as pa
import pyarrow.parquet as pq
import polars as pl
import duckdb


def generate(root):
    schema = pa.schema([
        pa.field('id', pa.int64(), False, metadata={b'PARQUET:field_id': b'11'}),
        pa.field('text', pa.string(), metadata={b'unit': b'UTF-8', b'PARQUET:field_id': b'12'}),
        pa.field('amount', pa.decimal128(38, 6), metadata={b'PARQUET:field_id': b'13'}),
        pa.field('nested', pa.list_(pa.struct([pa.field('code',pa.int32()),pa.field('blob',pa.binary())]))),
        pa.field('when',pa.timestamp('us','UTC')),
        pa.field('real',pa.float64()),
        pa.field('unsigned',pa.uint64()),
    ], metadata={b'owner':b'qualification',b'empty':b'',b'unicode': 'İstanbul'.encode()})
    table = pa.Table.from_pylist([
        dict(id=1,text='original',amount=decimal.Decimal('12345678901234567890123456789012.123456'),nested=[dict(code=4,blob=b'\x00\xff')],when=dt.datetime(2024,1,1,tzinfo=dt.timezone.utc),real=-0.0,unsigned=2**64-1),
        dict(id=2,text=None,amount=None,nested=None,when=None,real=float('nan'),unsigned=0),
        dict(id=3,text='中文',amount=decimal.Decimal('-0.000001'),nested=[],when=dt.datetime(1970,1,1,tzinfo=dt.timezone.utc),real=float('inf'),unsigned=2**63+17),
        dict(id=4,text='',amount=decimal.Decimal('0'),nested=[None,dict(code=None,blob=None)],when=None,real=1.25,unsigned=None),
    ],schema=schema)
    for codec in ['snappy','gzip','zstd','lz4','NONE']:
        for version in ['1.0','2.0']:
            pq.write_table(table,root/f'{codec}-{version}.parquet',compression=codec,row_group_size=2,data_page_version=version)
    pq.write_table(table,root/'indexed.parquet',write_page_index=True)
    pq.write_table(table,root/'sorted.parquet',sorting_columns=[pq.SortingColumn(0)])
    pq.write_table(table,root/'brotli.parquet',compression='brotli')
    pq.write_table(table,root/'int96.parquet',use_deprecated_int96_timestamps=True)
    pq.write_table(table.slice(0,0),root/'empty.parquet')
    pq.write_table(pa.table({'id':[1,1],'text':['same','same']}),root/'ambiguous.parquet')


def verify(source,stage,column,value):
    before=pq.ParquetFile(source);after=pq.ParquetFile(stage)
    assert before.schema.equals(after.schema), (before.schema,after.schema)
    assert before.schema_arrow.equals(after.schema_arrow,check_metadata=True)
    assert before.metadata.metadata==after.metadata.metadata
    assert before.metadata.created_by!=after.metadata.created_by
    assert 'parquet-rs 58.4.0' in after.metadata.created_by
    assert before.num_row_groups==after.num_row_groups
    for gi in range(before.num_row_groups):
        a,b=before.metadata.row_group(gi),after.metadata.row_group(gi)
        assert a.num_rows==b.num_rows
        for ci in range(a.num_columns): assert a.column(ci).compression==b.column(ci).compression
    original=before.read();rows=original.to_pylist()
    if value=='<NULL>': replacement=None
    elif column=='amount':replacement=decimal.Decimal(value)
    elif column=='id':replacement=int(value)
    else:replacement=value
    rows[0][column]=replacement
    expected=pa.Table.from_pylist(rows,schema=original.schema)
    actual=after.read()
    def norm(v):
        if isinstance(v,float):
            import struct
            return ('float-bits',struct.pack('>d',v).hex())
        if isinstance(v,list):return [norm(x) for x in v]
        if isinstance(v,dict):return {k:norm(x) for k,x in v.items()}
        return v
    assert norm(actual.to_pylist())==norm(expected.to_pylist())
    assert norm(pl.read_parquet(stage).to_dicts())==norm(pl.from_arrow(expected).to_dicts())
    db=duckdb.connect(':memory:');db.register('expected',expected)
    assert db.execute('(select * from read_parquet(?) except all select * from expected) union all (select * from expected except all select * from read_parquet(?))',[str(stage),str(stage)]).fetchall()==[]
    db.close()

if __name__=='__main__':
    if sys.argv[1]=='generate':generate(pathlib.Path(sys.argv[2]))
    elif sys.argv[1]=='verify':verify(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),sys.argv[4],sys.argv[5])
