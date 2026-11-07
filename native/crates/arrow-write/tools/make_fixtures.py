"""Decimal-free compressed fixtures (a compressed rewrite of Decimal128 is refused, see write_arrow.rs).
Run: /Users/macc/miniforge3/envs/myproject/bin/python -I tools/make_fixtures.py tests/fixtures"""
import sys,warnings
warnings.simplefilter('ignore')
from pathlib import Path
import pyarrow as pa,pyarrow.ipc as ipc
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
S=pa.schema([pa.field('i64',pa.int64(),nullable=False,metadata={'unit':'count'}),pa.field('str',pa.string()),pa.field('lstr',pa.large_string()),
 pa.field('ts_utc',pa.timestamp('us','UTC')),pa.field('flag',pa.bool_()),pa.field('f64',pa.float64()),pa.field('cat',pa.dictionary(pa.int8(),pa.string()))],metadata={'origin':'d3-15c-fixture'})
BIG=[2**53+1,2**63-1,-2**63,0,-(2**53)-1,7]
def batch(lo,hi):
    s=slice(lo,hi)
    return pa.record_batch([pa.array(BIG[s],pa.int64()),pa.array(['a','İstanbul','σ😀','',None,'z'][s]),pa.array(['x','y',None,'long'*9,'q','r'][s],pa.large_string()),
     pa.array([1,2,None,4,5,6][s],pa.int64()).cast(pa.timestamp('us','UTC')),pa.array([True,False,None,True,False,True][s]),pa.array([0.1,2.5,None,1e300,-0.0,3.0][s]),
     pa.DictionaryArray.from_arrays(pa.array([i%3 for i in range(lo,hi)],pa.int8()),pa.array(['red','green','blue']))],schema=S)
bs=[batch(0,2),batch(2,4),batch(4,6)]
for codec in('lz4','zstd'):
    o=ipc.IpcWriteOptions(compression=codec)
    with pa.OSFile(str(out/f'nodec-{codec}.arrows'),'wb') as f,ipc.new_stream(f,S,options=o) as w:
        [w.write_batch(b) for b in bs]
    with pa.OSFile(str(out/f'nodec-{codec}.feather'),'wb') as f,ipc.new_file(f,S,options=o) as w:
        [w.write_batch(b) for b in bs]
# File-level metadata must survive; message metadata must be preserved or refused.
with pa.OSFile(str(out/'footer-metadata.feather'), 'wb') as f, ipc.new_file(f, S, metadata={'owner':'σ😀', 'revision':'007'}) as w:
    for b in bs: w.write_batch(b)
for ext, factory in [('arrows', ipc.new_stream), ('feather', ipc.new_file)]:
    with pa.OSFile(str(out/f'batch-metadata.{ext}'), 'wb') as f, factory(f, S) as w:
        for b in bs: w.write_batch(b, custom_metadata={'provenance':'must-survive'})
