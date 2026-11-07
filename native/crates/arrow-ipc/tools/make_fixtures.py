"""Writes the D3.9 fixtures with PyArrow and Polars, plus expected.json read back by PyArrow (independent of the Rust crate).
Run: /Users/macc/miniforge3/envs/myproject/bin/python -I tools/make_fixtures.py tests/fixtures"""
import json,sys,decimal,datetime,struct,warnings
warnings.simplefilter('ignore')
from pathlib import Path
import pyarrow as pa,pyarrow.feather as pf,pyarrow.ipc as ipc,polars as pl
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
BIG=[2**53+1,2**63-1,-2**63,0,-(2**53)-1,7]
def wide(lo,hi):
    n=hi-lo;s=slice(lo,hi)
    cat=pa.DictionaryArray.from_arrays(pa.array([i%3 for i in range(lo,hi)],pa.int8()),pa.array(['red','green','blue']))
    return pa.table({
     'i64':pa.array(BIG[s],pa.int64()),
     'u64':pa.array([2**64-1,2**63,2**53+1,1,0,3][s],pa.uint64()),
     'str':pa.array(['a','İstanbul','σ😀','',None,'z'][s],pa.string()),
     'lstr':pa.array(['x','y',None,'long'*3,'q','r'][s],pa.large_string()),
     'dec':pa.array([decimal.Decimal(v) for v in ['123.4500','-0.0001','99999999999999999.9999','0.0000','1.0000','2.5000']][s],pa.decimal128(21,4)),
     'ts_utc':pa.array([1,2,None,4,5,6][s],pa.int64()).cast(pa.timestamp('us','UTC')),
     'ts_off':pa.array([10,20,30,None,50,60][s],pa.int64()).cast(pa.timestamp('ms','+05:30')),
     'flag':pa.array([True,False,None,True,False,True][s]),
     'nul':pa.array([None,None,None,None,None,None][s],pa.int32()),
     'cat':cat,
    },schema=SCHEMA)
SCHEMA=pa.schema([
 pa.field('i64',pa.int64(),nullable=False,metadata={'unit':'count'}),pa.field('u64',pa.uint64()),pa.field('str',pa.string()),pa.field('lstr',pa.large_string()),
 pa.field('dec',pa.decimal128(21,4)),pa.field('ts_utc',pa.timestamp('us','UTC')),pa.field('ts_off',pa.timestamp('ms','+05:30')),
 pa.field('flag',pa.bool_()),pa.field('nul',pa.int32()),pa.field('cat',pa.dictionary(pa.int8(),pa.string()))],metadata={'origin':'d3-9-fixture'})
batches=[wide(0,2),wide(2,4),wide(4,6)]
def stream(path,opts=None):
    with pa.OSFile(str(path),'wb') as f,ipc.new_stream(f,SCHEMA,options=opts) as w:
        for b in batches:w.write_table(b)
def file_(path,opts=None):
    with pa.OSFile(str(path),'wb') as f,ipc.new_file(f,SCHEMA,options=opts) as w:
        for b in batches:w.write_table(b)
stream(out/'wide.arrows');file_(out/'wide.feather')
for codec in('lz4','zstd'):
    file_(out/f'wide-{codec}.feather',ipc.IpcWriteOptions(compression=codec));stream(out/f'wide-{codec}.arrows',ipc.IpcWriteOptions(compression=codec))
# Cross-batch dictionaries: delta then a full replacement.
dschema=pa.schema([pa.field('d',pa.dictionary(pa.int8(),pa.string()))])
def dbatch(idx,vals):return pa.record_batch([pa.DictionaryArray.from_arrays(pa.array(idx,pa.int8()),pa.array(vals))],schema=dschema)
for name,opts in(('dict-delta',ipc.IpcWriteOptions(emit_dictionary_deltas=True)),('dict-replace',ipc.IpcWriteOptions())):
    with pa.OSFile(str(out/(name+'.arrows')),'wb') as f,ipc.new_stream(f,dschema,options=opts) as w:
        w.write_batch(dbatch([0,1],['a','b']));w.write_batch(dbatch([2,0],['a','b','c']));w.write_batch(dbatch([0,1],['x','y']))
# Polars defaults: Utf8View strings + categorical.
df=pl.DataFrame({'n':[1,2**53+1,None],'s':['a','İ',None],'c':pl.Series(['u','v','u'],dtype=pl.Categorical)})
df.write_ipc(out/'polars-view.feather');df.write_ipc_stream(out/'polars-view.arrows')
df.write_ipc(out/'polars-oldest.feather',compat_level=pl.CompatLevel.oldest())
df.write_ipc(out/'polars-zstd.feather',compression='zstd');df.write_ipc(out/'polars-lz4.feather',compression='lz4')
# Empty (zero-row) stream and file; Feather V1.
with pa.OSFile(str(out/'empty.arrows'),'wb') as f,ipc.new_stream(f,SCHEMA):pass
with pa.OSFile(str(out/'empty.feather'),'wb') as f,ipc.new_file(f,SCHEMA):pass
pf.write_feather(pa.table({'a':[1,2,3]}),str(out/'v1.feather'),version=1)
# Damaged inputs.
good=(out/'wide.arrows').read_bytes();gf=(out/'wide.feather').read_bytes()
(out/'truncated-90.arrows').write_bytes(good[:int(len(good)*.9)]);(out/'truncated-50.arrows').write_bytes(good[:len(good)//2])
(out/'no-eos.arrows').write_bytes(good[:-8]);(out/'truncated.feather').write_bytes(gf[:len(gf)//2]);(out/'no-tail.feather').write_bytes(gf[:-6])
(out/'empty.bin').write_bytes(b'');(out/'text.arrows').write_bytes(b'this is not a binary file, it is a sentence.\n')
import pyarrow.parquet as pq;pq.write_table(pa.table({'a':[1]}),str(out/'parquet-in-disguise.arrows'))
# A compressed buffer whose length prefix lies (claims 2 GiB) -- must be refused before any decode.
zs=(out/'wide-zstd.arrows').read_bytes();pos=0;bad=bytearray(zs)
with pa.OSFile(str(out/'wide-zstd.arrows'),'rb') as f:
    ipc.read_message(f)  # schema
    m=ipc.read_message(f);end=f.tell()
    while m.type!='record batch':m=ipc.read_message(f);end=f.tell()
    bs=end-m.body.size;assert zs[bs:bs+8]!=b'\xff'*8
    # first non-empty buffer prefix
    p=bs
    while struct.unpack('<q',zs[p:p+8])[0]==0:p+=8
    bad[p:p+8]=struct.pack('<q',2<<30)
(out/'lying-prefix.arrows').write_bytes(bytes(bad))
big=pa.table({'x':pa.array([0]*1_000_000,pa.int64())})
with pa.OSFile(str(out/'big-zero.arrows'),'wb') as f,ipc.new_stream(f,big.schema,options=ipc.IpcWriteOptions(compression='zstd')) as w:w.write_table(big)
# Expected values, read back through PyArrow (independent of the Rust crate).
def cell(v):
    if v is None:return None
    if isinstance(v,bool):return 'true' if v else 'false'
    if isinstance(v,datetime.datetime):return 'ts'
    return str(v)
def expect(path):
    with pa.OSFile(str(path),'rb') as f:
        r=ipc.open_stream(f) if path.suffix=='.arrows' else ipc.open_file(f)
        t=r.read_all()
    cols=[]
    for fl in t.schema:
        a=t.column(fl.name)
        if pa.types.is_timestamp(fl.type):vals=[None if x is None else str(x) for x in a.cast(pa.int64()).to_pylist()]
        elif pa.types.is_dictionary(fl.type):vals=[cell(x) for x in a.to_pylist()]
        else:vals=[cell(x) for x in a.to_pylist()]
        cols.append(dict(name=fl.name,type=str(fl.type),nullable=fl.nullable,metadata={k.decode():v.decode() for k,v in (fl.metadata or {}).items()},values=vals))
    return dict(rows=t.num_rows,columns=cols,schema_metadata={k.decode():v.decode() for k,v in (t.schema.metadata or {}).items()})
exp={p.name:expect(p) for p in sorted(out.glob('*.arrows'))+sorted(out.glob('*.feather')) if p.name.split('.')[0] in('wide','wide-lz4','wide-zstd','dict-delta','dict-replace','empty','polars-view','polars-oldest','polars-zstd','polars-lz4')}
(out/'expected.json').write_text(json.dumps(exp,indent=1,ensure_ascii=False))
print(len(exp),'expected;',sum(p.stat().st_size for p in out.iterdir()),'bytes')
