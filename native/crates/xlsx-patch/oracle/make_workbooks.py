"""Writes openpyxl workbooks and their edit cases (read-only use of the myproject env).
usage: python make_workbooks.py <corpus-dir>   -> <corpus-dir>/*.xlsx and cases-openpyxl.json"""
import datetime as dt, json, sys
from pathlib import Path
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.hyperlink import Hyperlink

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
S = "xl/worksheets/sheet1.xml"
V = lambda t, v=None: {"t": t, **({} if v is None else {"v": v})}

wb = openpyxl.Workbook(); ws = wb.active; ws.title = "data"
ws.append(["id", "name", "amount", "when", "flag", "calc"])
for i in range(1, 41):
    ws.append([i, f"item {i} & <co>", i * 1.25, dt.datetime(2026, 1, 1) + dt.timedelta(days=i, hours=i % 24), i % 2 == 0, f"=C{i+1}*2"])
for r in range(2, 42):
    ws.cell(r, 4).number_format = "yyyy-mm-dd hh:mm"; ws.cell(r, 3).number_format = "#,##0.00"
    ws.cell(r, 2).font = Font(bold=r % 2 == 0); ws.cell(r, 3).fill = PatternFill("solid", fgColor="FFFF00")
ws.merge_cells("H1:J2"); ws["H1"] = "merged"
ws["B5"].hyperlink = "https://example.com/x"; ws["B6"].hyperlink = Hyperlink(ref="B6", location="data!A1")
ws2 = wb.create_sheet("other"); ws2.append(["keep", "me"]); ws2["A2"] = "second sheet"; ws2["B2"] = 7
wb.defined_names["Amounts"] = DefinedName("Amounts", attr_text="data!$C$2:$C$41")
ws.freeze_panes = "A2"; ws.column_dimensions["B"].width = 30
wb.save(out / "op_table.xlsx")

wb = openpyxl.Workbook(); ws = wb.active; ws.title = "data"
ws.append(["code", "qty"])
for code, q in [("0007", 3), ("0009", 4), ("A-1", 5)]:
    ws.append([code, q])
for r in (2, 3, 4):
    ws.cell(r, 1).number_format = "@"
wb.epoch = openpyxl.utils.datetime.CALENDAR_MAC_1904
ws["C1"] = "when"; ws["C2"] = dt.datetime(2026, 3, 4); ws["C2"].number_format = "yyyy-mm-dd"
wb.save(out / "op_1904_text.xlsx")

cases = []
def c(wbname, cid, col, row, cur, new, **kw):
    cases.append({"id": cid, "workbook": wbname, "request": {"sheetPath": S, "columnName": col, "rowOrdinal": row, "verbatim": True,
        "columnNames": [], "expectedCurrent": cur, "newValue": new, **kw}})
T = "op_table.xlsx"
c(T, "op-number", "C", 3, V("num", "2.5"), V("num", "99"))
c(T, "op-number-text", "C", 3, V("num", "2.5"), V("str", "12.5"))
c(T, "op-string", "B", 3, V("str", "item 2 & <co>"), V("str", "new <text> & \"q\""))
c(T, "op-string-cr", "B", 3, V("str", "item 2 & <co>"), V("str", "line1\r\nline2\rtab\t😀"))
c(T, "op-string-dollar", "B", 3, V("str", "item 2 & <co>"), V("str", "cost $& $1 $$"))
c(T, "op-string-numlike-keeps-text", "B", 3, V("str", "item 2 & <co>"), V("str", "0009"))
c(T, "op-empty", "B", 3, V("str", "item 2 & <co>"), V("null"))
c(T, "op-bool", "E", 3, V("bool", True), V("bool", False))
c(T, "op-date-iso", "D", 3, V("str", "2026-01-03 02:00:00"), V("str", "2026-06-07 08:09:10"))
c(T, "op-date-bad", "D", 3, V("str", "2026-01-03 02:00:00"), V("str", "2026-13-40"))
c(T, "op-formula-refused", "F", 3, V("num", "5"), V("num", "1"))
c(T, "op-hyperlink-cell", "B", 5, V("str", "item 4 & <co>"), V("str", "linked cell edited"))
c(T, "op-merged-cell", "H", 1, V("str", "merged"), V("str", "still merged"))
c(T, "op-stale-expected", "C", 3, V("num", "7"), V("num", "1"))
c(T, "op-sha-mismatch", "C", 3, V("num", "2.5"), V("num", "1"), expectedSha256="0" * 64)
c(T, "op-missing-row", "C", 500, V("null"), V("num", "1"))
c(T, "op-bad-column", "c", 3, V("num", "2.5"), V("num", "1"))
c(T, "op-insert-cell-after", "K", 3, V("null"), V("str", "far right"))
c(T, "op-insert-cell-before", "A", 1, V("str", "id"), V("str", "ID"))
c("op_1904_text.xlsx", "op-1904-date", "C", 2, V("str", "2026-03-04"), V("str", "2026-05-06"))
c("op_1904_text.xlsx", "op-text-col-keeps-text", "A", 3, V("str", "0007"), V("str", "0008"))
c("op_1904_text.xlsx", "op-text-col-number", "B", 3, V("num", "3"), V("num", "30"))
(out / "cases-openpyxl.json").write_text(json.dumps(cases, indent=1))
print(len(cases), "cases")
