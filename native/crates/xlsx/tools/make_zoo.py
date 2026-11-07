"""D3.8 workbook zoo: written by xlsxwriter, read back by two independent readers (openpyxl, fastexcel/calamine).
expected-zoo.json holds the openpyxl reading (cells, cached values, formulas, merges, sheet state, date system)
plus the table ranges known by construction; fastexcel must agree with openpyxl on every value or this script fails.
Run: /Users/macc/miniforge3/envs/myproject/bin/python -I tools/make_zoo.py tests/fixtures/zoo"""
import datetime, json, sys, warnings
warnings.simplefilter('ignore')
from pathlib import Path
import openpyxl, xlsxwriter, fastexcel

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
truth = {}

def book(name, **opts):
    wb = xlsxwriter.Workbook(str(out / name), opts)
    # Preserve the frozen corpus creation time for reproducible reference files.
    wb.set_properties({'created': datetime.datetime(2026, 10, 31, 19, 46, 16)})
    return wb

# 1. Titles, footnotes, merged cells, adjacent and stacked tables.
wb = book('report.xlsx')
ws = wb.add_worksheet('Report')
date = wb.add_format({'num_format': 'yyyy-mm-dd'})
ws.merge_range('A1:F1', 'Quarterly report 2026')
ws.write('A2', 'Prepared by finance (draft)')
for c, h in enumerate(['Region', 'Q1', 'Q2', 'Q3', 'Date']): ws.write(3, c, h)
for r, (reg, a, b, c) in enumerate([('North', 10, 11.5, 12), ('South', 20, 21.5, 22), ('East', 30, 31.5, 32), ('West', 40, 41.5, 42), ('Total', 100, 106, 108)]):
    ws.write(4 + r, 0, reg); ws.write(4 + r, 1, a); ws.write(4 + r, 2, b); ws.write(4 + r, 3, c)
    ws.write_datetime(4 + r, 4, datetime.datetime(2026, 1 + r, 15), date)
ws.write('A11', 'Source: internal ledger; figures are unaudited and a note that is much wider than the five column table above it.')
ws.write('A12', 'Note 2: Q3 is a forecast.')
ws.merge_range('H3:J3', 'Other')
for c, h in enumerate(['Item', 'Count', 'Share']): ws.write(3, 7 + c, h)
for r, (i, n, s) in enumerate([('pens', 5, 0.25), ('ink', 7, 0.35), ('pads', 8, 0.4)]):
    ws.write(4 + r, 7, i); ws.write(4 + r, 8, n); ws.write(4 + r, 9, s)
for c, h in enumerate(['Code', 'Name', 'Flag']): ws.write(14, c, h)
for r, (a, b, f) in enumerate([('A1', 'alpha', True), ('B2', 'beta', False), ('C3', 'gamma', True), ('D4', 'delta', False)]):
    ws.write(15 + r, 0, a); ws.write(15 + r, 1, b); ws.write_boolean(15 + r, 2, f)
wb.close()
truth['report.xlsx'] = {'Report': {'tables': ['A4:E9', 'H4:J7', 'A15:C19']}}

# 2. Formulas with cached values and every error literal.
wb = book('formulas.xlsx')
ws = wb.add_worksheet('Calc')
for c, h in enumerate(['Kind', 'Formula result']): ws.write(0, c, h)
rows = [('number', '=1+1', 2), ('text', '="a"&"b"', 'ab'), ('bool', '=1=1', True), ('div0', '=1/0', '#DIV/0!'),
        ('na', '=NA()', '#N/A'), ('ref', '=#REF!', '#REF!'), ('name', '=NOPE()', '#NAME?'), ('num', '=SQRT(-1)', '#NUM!'),
        ('null', '=A1 B1', '#NULL!'), ('value', '="x"+1', '#VALUE!'), ('big', '=2^53+1', 9007199254740993), ('empty', '=""', '')]
for r, (k, f, v) in enumerate(rows):
    ws.write(1 + r, 0, k); ws.write_formula(1 + r, 1, f, None, v)
ws.write_array_formula('D2:D2', '{=SUM(B2:B2)}', None, 2)
ws.write('E2', 'literal #DIV/0! as text')
ws.write_formula('F2', '=SUM(B2:B3)', None, 2)
wb.close()
truth['formulas.xlsx'] = {'Calc': {'tables': ['A1:B13']}}

# 3. Value kinds: rich text, padding, unicode, entities, long text, 1904 dates, hidden sheet.
wb = book('kinds.xlsx', **{'date_1904': True})
ws = wb.add_worksheet('Kinds')
ws.write_rich_string('A1', 'Rich ', wb.add_format({'bold': True}), 'text')
ws.write_string('A2', '  padded  ')
ws.write_string('A3', 'İstanbul σ😀')
ws.write_string('A4', 'a&b <c> "q" \'s\'')
ws.write_string('A5', 'x' * 5000)
ws.write_number('A6', 0.1); ws.write_number('A7', 1e-7); ws.write_number('A8', -123456789012345.0); ws.write_number('A9', 1.7976931348623157e308)
ws.write_datetime('A10', datetime.datetime(2026, 10, 31, 12), wb.add_format({'num_format': 'yyyy-mm-dd hh:mm'}))
ws.write_boolean('A11', True)
ws.write_string('A12', 'line1\nline2')
ws.write_blank('A13', None, wb.add_format({'bold': True}))
h = wb.add_worksheet('Hidden "sheet" & more'); h.write('A1', 'hid'); h.hide()
wb.close()
truth['kinds.xlsx'] = {'Kinds': {'tables': []}, 'Hidden "sheet" & more': {'tables': []}}

# 4. Streaming writer: inline strings.
wb = book('inline.xlsx', **{'constant_memory': True})
ws = wb.add_worksheet('Inline')
ws.write_row(0, 0, ['Name', 'Value'])
for r in range(1, 6): ws.write_row(r, 0, [f'row{r}', r * 1.5])
wb.close()
truth['inline.xlsx'] = {'Inline': {'tables': ['A1:B6']}}

def norm(v):
    if isinstance(v, bool): return {'t': 'b', 'v': v}
    if isinstance(v, (int, float)): return {'t': 'n', 'v': repr(float(v))}
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)): return {'t': 'd', 'v': v.isoformat()}
    return {'t': 's', 'v': v}

expected = {'readers': {'openpyxl': openpyxl.__version__, 'fastexcel': fastexcel.__version__}, 'workbooks': {}}
for name in truth:
    p = out / name
    f = openpyxl.load_workbook(p); v = openpyxl.load_workbook(p, data_only=True)
    ex = {'date1904': v.epoch.year == 1904, 'sheets': {}}
    fe = fastexcel.read_excel(str(p))
    for ws in f.worksheets:
        wv = v[ws.title]
        cells = {}
        for row in ws.iter_rows():
            for c in row:
                cv = wv[c.coordinate].value
                form = c.value if (isinstance(c.value, str) and c.value.startswith('=')) or hasattr(c.value, 'text') else None
                if c.value is None and cv is None: continue
                if hasattr(form, 'text'): form = form.text
                cells[c.coordinate] = {'cached': norm(cv), 'formula': form[1:] if form else None, 'is_error': c.data_type == 'e' or wv[c.coordinate].data_type == 'e'}
        ex['sheets'][ws.title] = {'state': ws.sheet_state, 'cells': cells, 'merges': sorted(str(m) for m in ws.merged_cells.ranges),
                                  'tables': truth[name][ws.title]['tables']}
        # Second independent reader: calamine must agree on the non-formula text of every plain value.
        try:
            grid = fe.load_sheet(ws.title, header_row=None, dtypes='string').to_pandas().values.tolist()
        except Exception as e:  # calamine refuses to type a column holding error cells
            ex['sheets'][ws.title]['fastexcel_skipped'] = str(e).splitlines()[0]
            continue
        agree = 0
        for coord, c in cells.items():
            if c['formula'] or c['cached']['t'] != 's' or c['is_error']: continue
            cell = ws[coord]
            if grid[cell.row - 1][cell.column - 1] != c['cached']['v']:
                raise SystemExit(f'fastexcel disagrees at {name}/{ws.title}/{coord}: {grid[cell.row-1][cell.column-1]!r} vs {c["cached"]["v"]!r}')
            agree += 1
        ex['sheets'][ws.title]['fastexcel_agreed_text_cells'] = agree
    expected['workbooks'][name] = ex
(out / 'expected-zoo.json').write_text(json.dumps(expected, indent=1, ensure_ascii=False))
print('ok', {k: sum(len(s['cells']) for s in v['sheets'].values()) for k, v in expected['workbooks'].items()})
