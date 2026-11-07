"""Differential: Rust byte patch vs the TS reference (DuckDB COPY rewrite), decoded by four independent readers."""
import csv, io, json, os, subprocess, sys, tempfile, hashlib, shutil
import pandas as pd, polars as pl, duckdb
HERE = os.path.dirname(os.path.abspath(__file__))
NATIVE = os.path.abspath(os.path.join(HERE, '../../..'))
RUST = os.environ.get('DFV_CSV_PATCH', os.path.join(NATIVE, 'target/debug/examples/csv_patch'))

def decode(path, delim):
    raw = open(path, 'rb').read().removeprefix(b'\xef\xbb\xbf')
    text = raw.decode('utf-8')
    py = [r for r in csv.reader(io.StringIO(text, newline=''), delimiter=delim) if r]
    pdf = pd.read_csv(io.StringIO(text), sep=delim, dtype=str, keep_default_na=False, na_filter=False, header=None, skip_blank_lines=True)
    pol = pl.read_csv(io.BytesIO(raw), separator=delim, has_header=False, infer_schema_length=0, truncate_ragged_lines=False)
    ddb = duckdb.sql(f"select * from read_csv('{path}', delim='{delim}', header=false, all_varchar=true, quote='\"')").fetchall()
    readers = {'python-csv': py, 'pandas': pdf.values.tolist(),
               'polars': [list(r) for r in pol.rows()], 'duckdb': [['' if v is None else v for v in r] for r in ddb]}
    # polars/duckdb give None for empty cells
    for k in ('polars',):
        readers[k] = [['' if v is None else v for v in r] for r in readers[k]]
    return readers

def ts_edit(path, col, row, value):
    out = subprocess.run(['node', os.path.join(HERE, 'ts_edit.mjs'), path, col, str(row), json.dumps(value)], capture_output=True, text=True, timeout=120)
    return json.loads(out.stdout.strip().splitlines()[-1])

CASES = [
  dict(name='plain_number', text='id,name,qty\n1,widget,2\n2,bolt,7\n', delim=',', col='qty', row=1, kind='number', value='8', tsv=8),
  dict(name='quotes_and_comma', text='id,name,qty\n1,widget,2\n2,bolt,7\n', delim=',', col='name', row=0, kind='text', value='O"Brien, J', tsv='O"Brien, J'),
  dict(name='crlf_bom', text='﻿id,name\r\n1,a\r\n2,b\r\n', delim=',', col='name', row=1, kind='text', value='B', tsv='B'),
  dict(name='semicolon_decimal_comma', text='id;price\n1;1,50\n2;2,25\n', delim=';', col='price', row=0, kind='number', value='3.75', dc=True, tsv=3.75),
  dict(name='number_spelling_untouched', text='id,price\n1,1.50\n2,2.250\n3,3.0\n', delim=',', col='id', row=2, kind='number', value='30', tsv=30),
  dict(name='embedded_newline', text='id,note\n1,"a\nb"\n2,"c, d"\n', delim=',', col='note', row=1, kind='text', value='x\ny', tsv='x\ny'),
  dict(name='leading_zero_code', text='code,n\n007,1\n010,2\n', delim=',', col='n', row=1, kind='number', value='5', tsv=5),
  dict(name='set_null', text='a,b\n1,x\n2,y\n', delim=',', col='b', row=0, kind='null', value='', tsv=None),
  dict(name='unicode', text='k,v\nİstanbul,😀\nb,c\n', delim=',', col='v', row=1, kind='text', value='σ→ş', tsv='σ→ş'),
  dict(name='tab_separated', text='k\tv\nx\t1\ny\t2\n', delim='\t', col='v', row=0, kind='number', value='9', tsv=9),
  dict(name='ambiguous_identical_rows', text='name,qty\nwidget,2\nwidget,2\nbolt,7\n', delim=',', col='qty', row=0, kind='number', value='99', tsv=99, expect='refuse'),
  dict(name='no_row_selector', text='name,qty\nwidget,2\nbolt,7\n', delim=',', col='qty', row='none', kind='number', value='0', tsv=0, expect='refuse'),
]

def main():
    results = []
    for c in CASES:
        d = tempfile.mkdtemp(prefix='csvdiff-')
        src = os.path.join(d, c['name'] + '.csv'); open(src, 'w', encoding='utf-8', newline='').write(c['text'])
        before = open(src, 'rb').read()
        base = decode(src, c['delim']); ref = base['python-csv']
        # --- Rust
        rs_out = os.path.join(d, 'rust.csv'); table_rows = ref[1:]
        if c['row'] == 'none': match = []
        else: match = [[h, v] for h, v in zip(ref[0], table_rows[c['row']])]
        args = [RUST, src, rs_out, c['delim'], c['col'], json.dumps(match), c['kind'], c['value']] + (['dc'] if c.get('dc') else [])
        rp = subprocess.run(args, capture_output=True, text=True)
        rust_refused = rp.returncode == 3
        # --- TS (own copy)
        ts_path = os.path.join(d, 'ts', c['name'] + '.csv'); os.makedirs(os.path.dirname(ts_path)); shutil.copy(src, ts_path)
        ts = ts_edit(ts_path, c['col'], c['row'], c['tsv'])
        rec = dict(case=c['name'], rust_refused=rust_refused, ts_ok=ts['ok'], ts_error=ts.get('error'))
        if c.get('expect') == 'refuse':
            rec['agree_refusal'] = rust_refused and not ts['ok'] and open(src, 'rb').read() == before and open(ts_path, 'rb').read() == before
            rec['pass'] = rec['agree_refusal']
        else:
            assert not rust_refused and ts['ok'], (c['name'], rp.stdout, ts)
            colix = ref[0].index(c['col']); want = [r[:] for r in ref]; want[c['row'] + 1][colix] = ('' if c['kind'] == 'null' else (c['value'].replace('.', ',') if c.get('dc') else c['value']))
            outs = decode(rs_out, c['delim'])
            rec['rust_readers_agree_with_expected'] = {k: v == want for k, v in outs.items()}
            tsr = decode(ts_path, ',')   # the TS rewrite always comes out comma-delimited
            ts_py = tsr['python-csv']
            rec['ts_edited_cell'] = ts_py[c['row'] + 1][colix]
            rec['ts_shape_same'] = len(ts_py) == len(want)
            changed_untouched = [(i, j) for i in range(len(want)) for j in range(len(want[i]))
                                 if (i, j) != (c['row'] + 1, colix) and i < len(ts_py) and j < len(ts_py[i]) and ts_py[i][j] != want[i][j]]
            rec['ts_untouched_cells_reformatted'] = len(changed_untouched)
            rec['ts_delimiter_changed'] = c['delim'] != ','
            rec['ts_bytes_identical_to_rust_bytes'] = open(ts_path, 'rb').read() == open(rs_out, 'rb').read()
            # Rust byte-exactness: everything outside the edited field identical
            rb = open(rs_out, 'rb').read(); p = next((i for i, (x, y) in enumerate(zip(before, rb)) if x != y), min(len(before), len(rb)))
            s = next((i for i, (x, y) in enumerate(zip(before[::-1][: len(before) - p], rb[::-1][: len(rb) - p])) if x != y), min(len(before), len(rb)) - p)
            rec['rust_bytes_changed_span'] = [p, len(before) - s]
            rec['rust_bom_kept'] = rb.startswith(b'\xef\xbb\xbf') == before.startswith(b'\xef\xbb\xbf')
            rec['rust_eol_kept'] = (b'\r\n' in rb) == (b'\r\n' in before)
            rec['pass'] = all(rec['rust_readers_agree_with_expected'].values()) and rec['rust_bom_kept'] and rec['rust_eol_kept']
        results.append(rec); shutil.rmtree(d)
    print(json.dumps(results, indent=1, ensure_ascii=False))
    sys.exit(0 if all(r['pass'] for r in results) else 1)
main()
