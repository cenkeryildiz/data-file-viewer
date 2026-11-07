"""External reopen: every Rust-patched workbook loads in openpyxl and differs from its original ONLY in the edited cell.
usage: python verify_openpyxl.py <work-dir>"""
import json, sys
from pathlib import Path
import openpyxl
W = Path(sys.argv[1]); corpus = W / 'corpus'
cases = {c['id']: c for f in ('cases-ts.json', 'cases-openpyxl.json') for c in json.loads((corpus / f).read_text())}
results = json.loads((W / 'rust-out/results.json').read_text())
def snap(ws):
    cells = {}
    for row in ws.iter_rows():
        for c in row:
            if c.value is not None or c.has_style:
                cells[c.coordinate] = (c.value, c.number_format, c.font.b, c.fill.fgColor.rgb if c.fill and c.fill.fill_type else None, c.hyperlink.target if c.hyperlink else None, c.hyperlink.location if c.hyperlink else None)
    return cells
checked = skipped = 0; bad = []
for cid, res in results.items():
    if not res['ok']:
        continue
    cs = cases[cid]
    try:
        a = openpyxl.load_workbook(corpus / cs['workbook'])
    except Exception as e:
        skipped += 1; continue
    try:
        b = openpyxl.load_workbook(W / 'rust-out' / f'{cid}.xlsx')
    except Exception as e:
        bad.append(f'{cid}: candidate cannot be reopened: {e}'); continue
    if cid == 'op-string-cr' and b.active[res['cell']].value != cs['request']['newValue']['v']:
        bad.append(f'{cid}: carriage returns/newlines/tabs changed')
    if a.sheetnames != b.sheetnames: bad.append(f'{cid}: sheet names'); continue
    if sorted(a.defined_names) != sorted(b.defined_names): bad.append(f'{cid}: defined names')
    target = res['cell']
    for name in a.sheetnames:
        wa, wb_ = a[name], b[name]
        if name == a.sheetnames[0]:
            sa, sb = snap(wa), snap(wb_)
            diff = {k for k in set(sa) | set(sb) if sa.get(k) != sb.get(k)}
            if not diff <= {target}: bad.append(f'{cid}: unexpected cell changes {sorted(diff - {target})[:5]}')
        else:
            if snap(wa) != snap(wb_): bad.append(f'{cid}: other sheet {name} changed')
        if sorted(map(str, wa.merged_cells.ranges)) != sorted(map(str, wb_.merged_cells.ranges)): bad.append(f'{cid}: merged ranges')
        if wa.freeze_panes != wb_.freeze_panes: bad.append(f'{cid}: freeze panes')
    checked += 1
print(json.dumps({'reopened_in_openpyxl': checked, 'skipped_unloadable_original': skipped, 'problems': bad}, indent=1))
sys.exit(1 if bad else 0)
