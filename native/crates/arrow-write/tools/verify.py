"""Independent PyArrow + Polars read-back of the D3.15c outputs: container kind, schema incl. metadata,
batch layout, exactly one changed cell holding the expected value, Polars agreement.
Run: /Users/macc/miniforge3/envs/myproject/bin/python -I tools/verify.py <out-dir>"""
import json,os,sys
os.environ['POLARS_IGNORE_TIMEZONE_PARSE_ERROR']='1'  # Polars rejects the fixture's fixed-offset zone name; values are still read
from datetime import datetime,timedelta,timezone
from decimal import Decimal
from pathlib import Path
import pyarrow as pa,pyarrow.ipc as ipc,polars as pl
out=Path(sys.argv[1]);manifest=json.loads((out/'manifest.json').read_text());report=[]
def is_file(p):return Path(p).read_bytes()[:6]==b'ARROW1'
def tables(p):
    r=ipc.open_file(p) if is_file(p) else ipc.open_stream(p)
    bs=[r.get_batch(i) for i in range(r.num_record_batches)] if is_file(p) else list(r)
    return r.schema,bs
for c in manifest:
    sa,ba=tables(c['input']);sb,bb=tables(c['output'])
    assert is_file(c['input'])==is_file(c['output']),c['case']
    if is_file(c['input']):
        assert ipc.open_file(c['input']).metadata == ipc.open_file(c['output']).metadata, (c['case'], 'file footer metadata')
    assert sa.equals(sb,check_metadata=True),(c['case'],'schema/metadata')
    assert [b.num_rows for b in ba]==[b.num_rows for b in bb],(c['case'],'batch layout')
    diffs=[]
    for bi,(x,y) in enumerate(zip(ba,bb)):
        for ci,name in enumerate(sa.names):
            for r,(u,v) in enumerate(zip(x.column(ci).to_pylist(),y.column(ci).to_pylist())):
                if u!=v or type(u)!=type(v):diffs.append((name,bi,r,u,v))
    assert len(diffs)==1,(c['case'],diffs)
    name,bi,r,old,new=diffs[0];expected=eval(c['expect'],dict(datetime=datetime,timezone=timezone,timedelta=timedelta,Decimal=Decimal))
    assert name==c['column'] and new==expected and type(new)==type(expected),(c['case'],diffs[0],expected)
    # Polars sees the same table; skipped only where Polars cannot read the untouched source either.
    rd=lambda p:(pl.read_ipc if is_file(p) else pl.read_ipc_stream)(p)
    try:pi=rd(c['input']);polars=None
    except BaseException as e:polars=f'skipped (Polars cannot read the source): {type(e).__name__}: {str(e)[:70]}'
    if polars is None:
        po=rd(c['output']);assert pi.schema==po.schema,(c['case'],'polars schema')
        pdiff=[(k,i) for k in po.columns for i,(u,v) in enumerate(zip(pi[k].to_list(),po[k].to_list())) if u!=v]
        assert pdiff==[(c['column'],pdiff[0][1])] if pdiff else False,(c['case'],'polars',pdiff)
        polars='agrees'
    report.append(dict(case=c['case'],container='file' if is_file(c['output']) else 'stream',changed=f'{name}[batch {bi}, row {r}]',old=repr(old),new=repr(new),polars=polars))
(out/'readback.json').write_text(json.dumps(dict(pyarrow=pa.__version__,polars=pl.__version__,cases=len(report),report=report),indent=1,ensure_ascii=False))
print(json.dumps(dict(cases=len(report),pyarrow=pa.__version__,polars=pl.__version__)));[print(r['case'],r['polars']) for r in report if r['polars']!='agrees']
