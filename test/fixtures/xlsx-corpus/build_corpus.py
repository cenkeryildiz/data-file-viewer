"""
EX-01 XLSX regression corpus: deterministic writer + ground truth.

Writes every fixture in this directory from the CORPUS spec below, with the
Python standard library only (zipfile + hand-written OOXML). That is on purpose:

  - The product reads XLSX through DuckDB's excel extension and its own ZIP/XML
    code. A fixture written by the same stack that reads it agrees with the
    reader by construction (see test/stress/foreign/build_corpus.py).
  - openpyxl is the INDEPENDENT reader (verify_openpyxl.py), so it must not be
    the writer as well.
  - Byte-for-byte determinism: every ZIP member gets a fixed timestamp, fixed
    order and fixed compression; there is no docProps/core.xml timestamp. Two
    runs of this script produce identical files, which is what lets
    manifest.json record their SHA-256 and the tests assert it.

Ground truth (ground-truth.json) is derived from the SAME spec as the cells --
never from detector or DuckDB output. Detector/DuckDB observations live in a
separate file (detector-observed.json, written by record_observed.cjs) and are a
comparator only.

Run with the project's env (never conda base):

    /Users/macc/miniforge3/envs/myproject/bin/python -I test/fixtures/xlsx-corpus/build_corpus.py
    /Users/macc/miniforge3/envs/myproject/bin/python -I test/fixtures/xlsx-corpus/build_corpus.py --check

`--check` rebuilds into memory and fails if any committed file differs.
"""

from __future__ import annotations

import hashlib
import io
import json
import platform
import sys
import zipfile
import zlib
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
FIXED_TIME = (1980, 1, 1, 0, 0, 0)

# --------------------------------------------------------------------- cells
#
# A cell value in the spec is one of:
#   str                  -> shared string
#   int / float          -> number
#   bool                 -> boolean
#   ("err", "#DIV/0!")   -> literal error value (t="e")
#   ("f", "1+1", 2)      -> formula with cached numeric result
#   ("f", "1/0", ("err", "#DIV/0!")) -> formula with cached error result
#   ("f", "\"a\"&\"b\"", "ab")        -> formula with cached string (t="str")


def col_letters(index: int) -> str:
    out = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out


def parse_ref(ref: str) -> tuple[int, int]:
    """'B3' -> (row0=2, col0=1)."""
    letters = "".join(ch for ch in ref if ch.isalpha())
    digits = "".join(ch for ch in ref if ch.isdigit())
    col = 0
    for ch in letters:
        col = col * 26 + (ord(ch) - 64)
    return int(digits) - 1, col - 1


def grid_cells(rows: list[list[object]], origin: str = "A1") -> dict[str, object]:
    """Row-major list -> {ref: value}, skipping None."""
    r0, c0 = parse_ref(origin)
    out: dict[str, object] = {}
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            if value is not None:
                out[f"{col_letters(c0 + c)}{r0 + r + 1}"] = value
    return out


def fmt_number(value: int | float) -> str:
    if isinstance(value, bool):
        raise TypeError("bool is not a number here")
    if isinstance(value, int):
        return str(value)
    text = repr(float(value))
    return text[:-2] if text.endswith(".0") else text


def raw_text(value: object) -> dict[str, str]:
    """What the cell holds, as {type, text} -- the exact stored value."""
    if isinstance(value, tuple) and value[0] == "err":
        return {"type": "error", "text": value[1]}
    if isinstance(value, tuple) and value[0] == "f":
        cached = raw_text(value[2])
        return {"type": "formula", "formula": value[1], "cachedType": cached["type"], "text": cached["text"]}
    if isinstance(value, bool):
        return {"type": "boolean", "text": "TRUE" if value else "FALSE"}
    if isinstance(value, (int, float)):
        return {"type": "number", "text": fmt_number(value)}
    if isinstance(value, str):
        return {"type": "string", "text": value}
    raise TypeError(f"unsupported cell value {value!r}")


# ------------------------------------------------------------------- corpus
#
# `tables` in ground truth = what a correct reader of the sheet should offer.
# rows are the logical data rows only (no header, no blank, no repeated header,
# no footer); values are the exact stored value (numbers as numbers, text as
# text, error cells as null with the marker listed in errorCells).

CORPUS: dict[str, dict] = {}


def fixture(name: str, *, description: str, sheets: list[dict], tables: list[dict],
            non_tables: list[dict] | None = None, defects: list[str] | None = None) -> None:
    CORPUS[name] = {
        "description": description,
        "sheets": sheets,
        "tables": tables,
        "nonTables": non_tables or [],
        "defects": defects or [],
    }


fixture(
    "single-column",
    description="One undeclared single-column block. Heuristic policy keeps one-column blocks out "
    "of the table list (sheetTables size gate); the raw sheet must still show every value.",
    sheets=[{"name": "Sheet", "cells": grid_cells([["Name"], ["Alice"], ["Bob"], ["Clara"]])}],
    tables=[],
    non_tables=[{"sheet": "Sheet", "ref": "A1:A4", "why": "undeclared one-column block (heuristic size gate)"}],
)

fixture(
    "explicit-single",
    description="One DECLARED Excel table (xl/tables/table1.xml) covering a single column A1:A3.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([["Name"], ["Alice"], ["Bob"]]),
        "tables": [{"name": "Names", "ref": "A1:A3"}],
    }],
    tables=[{"sheet": "Sheet", "declaredName": "Names", "range": "A1:A3", "headerRows": [1],
             "columns": ["Name"], "rows": [["Alice"], ["Bob"]]}],
    defects=["EX-06 explicit-single-column-missed"],
)

fixture(
    "explicit-adjacent",
    description="Two DECLARED tables side by side with no blank column: LeftData A1:B3, RightData C1:D3.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([["Name", "Value", "Code", "Amount"], ["Alice", 1, "X", 2], ["Bob", 3, "Y", 4]]),
        "tables": [{"name": "LeftData", "ref": "A1:B3"}, {"name": "RightData", "ref": "C1:D3"}],
    }],
    tables=[
        {"sheet": "Sheet", "declaredName": "LeftData", "range": "A1:B3", "headerRows": [1],
         "columns": ["Name", "Value"], "rows": [["Alice", 1], ["Bob", 3]]},
        {"sheet": "Sheet", "declaredName": "RightData", "range": "C1:D3", "headerRows": [1],
         "columns": ["Code", "Amount"], "rows": [["X", 2], ["Y", 4]]},
    ],
    defects=["EX-06 adjacent-explicit-tables-fused"],
)

fixture(
    "explicit-stacked",
    description="Two DECLARED tables stacked with no blank row: Top A1:B3, Bottom A4:B6.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([
            ["Name", "Value"], ["Alice", 1], ["Bob", 2],
            ["Code", "Amount"], ["X", 10], ["Y", 20],
        ]),
        "tables": [{"name": "Top", "ref": "A1:B3"}, {"name": "Bottom", "ref": "A4:B6"}],
    }],
    tables=[
        {"sheet": "Sheet", "declaredName": "Top", "range": "A1:B3", "headerRows": [1],
         "columns": ["Name", "Value"], "rows": [["Alice", 1], ["Bob", 2]]},
        {"sheet": "Sheet", "declaredName": "Bottom", "range": "A4:B6", "headerRows": [4],
         "columns": ["Code", "Amount"], "rows": [["X", 10], ["Y", 20]]},
    ],
    defects=["EX-06 adjacent-explicit-tables-fused (vertical)"],
)

fixture(
    "merged-heading",
    description="Merged title A1:B1 above a two-column table. Existing detector handles this; retain.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([["Annual totals"], ["Name", "Value"], ["Alice", 1], ["Bob", 2]]),
        "merges": ["A1:B1"],
    }],
    tables=[{"sheet": "Sheet", "range": "A2:B4", "headerRows": [2],
             "columns": ["Name", "Value"], "rows": [["Alice", 1], ["Bob", 2]]}],
    non_tables=[{"sheet": "Sheet", "ref": "A1:B1", "why": "merged title"}],
)

fixture(
    "multilevel-header",
    description="Two-level header: merged group captions Q1 (B1:C1) and Q2 (D1:E1) over Units/Revenue.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([
            ["Item", "Q1", None, "Q2", None],
            [None, "Units", "Revenue", "Units", "Revenue"],
            ["Apples", 10, 25.5, 12, 30],
            ["Pears", 4, 8, 6, 12.25],
            ["Plums", 7, 14, 9, 18],
        ]),
        "merges": ["B1:C1", "D1:E1", "A1:A2"],
    }],
    tables=[{"sheet": "Sheet", "range": "A1:E5", "headerRows": [1, 2],
             "columns": None,
             "columnLevels": [["Item", "Q1", "Q1", "Q2", "Q2"], ["Item", "Units", "Revenue", "Units", "Revenue"]],
             "rows": [["Apples", 10, 25.5, 12, 30], ["Pears", 4, 8, 6, 12.25], ["Plums", 7, 14, 9, 18]]}],
    defects=["EX-06 multilevel-header (no two-level header support)"],
)

fixture(
    "footer",
    description="Table followed by a blank row and a one-cell source footnote. Existing detector excludes it; retain.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([["Name", "Value"], ["Alice", 1], ["Bob", 2], [], ["Source: synthetic fixture"]]),
    }],
    tables=[{"sheet": "Sheet", "range": "A1:B3", "headerRows": [1],
             "columns": ["Name", "Value"], "rows": [["Alice", 1], ["Bob", 2]]}],
    non_tables=[{"sheet": "Sheet", "ref": "A5", "why": "footnote"}],
)

fixture(
    "duplicate-headings",
    description="Header row repeats captions (Value, Value, Note, Note) inside one table.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([
            ["Date", "Value", "Value", "Note", "Note"],
            ["2024-01-01", 1, 2, "a", "b"],
            ["2024-01-02", 3, 4, "c", "d"],
        ]),
    }],
    tables=[{"sheet": "Sheet", "range": "A1:E3", "headerRows": [1],
             "columns": ["Date", "Value", "Value_1", "Note", "Note_1"],
             "rows": [["2024-01-01", 1, 2, "a", "b"], ["2024-01-02", 3, 4, "c", "d"]]}],
)

fixture(
    "repeated",
    description="One logical table whose header repeats after a blank row (Name/Value, Alice/1, blank, "
    "Name/Value, Bob/2). Correct logical rows are exactly Alice/1 and Bob/2.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([["Name", "Value"], ["Alice", 1], [], ["Name", "Value"], ["Bob", 2]]),
    }],
    tables=[{"sheet": "Sheet", "range": "A1:B5", "headerRows": [1], "excludedRows": [3, 4],
             "columns": ["Name", "Value"], "rows": [["Alice", 1], ["Bob", 2]]}],
    defects=["EX-05 repeated-header-rows-in-query (detector rowCount=2, query returns 4 rows)"],
)

fixture(
    "sparse",
    description="Small table at A1:B3 plus one distant note at AZ1000.",
    sheets=[{
        "name": "Sheet",
        "cells": {**grid_cells([["Name", "Value"], ["Alice", 1], ["Bob", 2]]), "AZ1000": "far note"},
    }],
    tables=[{"sheet": "Sheet", "range": "A1:B3", "headerRows": [1],
             "columns": ["Name", "Value"], "rows": [["Alice", 1], ["Bob", 2]]}],
    non_tables=[{"sheet": "Sheet", "ref": "AZ1000", "why": "distant single note"}],
)

fixture(
    "mixed-value",
    description="Numeric column with one non-numeric text value (Bob / 'not numeric').",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([["Name", "Value"], ["Alice", 1], ["Bob", "not numeric"], ["Clara", 3]]),
    }],
    tables=[{"sheet": "Sheet", "range": "A1:B4", "headerRows": [1],
             "columns": ["Name", "Value"], "rows": [["Alice", 1], ["Bob", "not numeric"], ["Clara", 3]]}],
    defects=["EX-05 mixed-text-converted-to-null-without-warning"],
)

fixture(
    "formula-errors",
    description="Numbers, text, formulas with cached numeric/string results and cached Excel errors.",
    sheets=[{
        "name": "Sheet",
        "cells": grid_cells([
            ["Name", "Value", "Label"],
            ["Alice", 1, "plain"],
            ["Bob", ("f", "1+1", 2), ("f", "\"a\"&\"b\"", "ab")],
            ["Clara", ("f", "1/0", ("err", "#DIV/0!")), "after div"],
            ["Dan", ("f", "NA()", ("err", "#N/A")), "after na"],
            ["Eve", ("err", "#REF!"), "literal ref error"],
            ["Finn", 2.5, "last"],
        ]),
    }],
    tables=[{"sheet": "Sheet", "range": "A1:C7", "headerRows": [1],
             "columns": ["Name", "Value", "Label"],
             "rows": [["Alice", 1, "plain"], ["Bob", 2, "ab"], ["Clara", None, "after div"],
                      ["Dan", None, "after na"], ["Eve", None, "literal ref error"], ["Finn", 2.5, "last"]],
             "errorCells": {"B4": "#DIV/0!", "B5": "#N/A", "B6": "#REF!"}}],
)

fixture(
    "two-sheet",
    description="Raw_Data and ZOther each hold one table; source of the picker missing-raw-entry reproduction.",
    sheets=[
        {"name": "Raw_Data", "cells": grid_cells([["Date", "Rate"], ["2024-01-01", 1.5], ["2024-01-02", 1.75]])},
        {"name": "ZOther", "cells": grid_cells([["Code", "Amount"], ["X", 10], ["Y", 20]])},
    ],
    tables=[
        {"sheet": "Raw_Data", "range": "A1:B3", "headerRows": [1], "columns": ["Date", "Rate"],
         "rows": [["2024-01-01", 1.5], ["2024-01-02", 1.75]]},
        {"sheet": "ZOther", "range": "A1:B3", "headerRows": [1], "columns": ["Code", "Amount"],
         "rows": [["X", 10], ["Y", 20]]},
    ],
)

# ------------------------------------------------------------------- writer

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


def sort_key(ref: str) -> tuple[int, int]:
    return parse_ref(ref)


def build_xlsx(spec: dict) -> bytes:
    strings: list[str] = []
    index: dict[str, int] = {}

    def sst(text: str) -> int:
        if text not in index:
            index[text] = len(strings)
            strings.append(text)
        return index[text]

    def cell_xml(ref: str, value: object) -> str:
        if isinstance(value, tuple) and value[0] == "f":
            formula, cached = value[1], value[2]
            f = f"<f>{escape(formula)}</f>"
            if isinstance(cached, tuple) and cached[0] == "err":
                return f'<c r="{ref}" t="e">{f}<v>{escape(cached[1])}</v></c>'
            if isinstance(cached, str):
                return f'<c r="{ref}" t="str">{f}<v>{escape(cached)}</v></c>'
            return f'<c r="{ref}">{f}<v>{fmt_number(cached)}</v></c>'
        if isinstance(value, tuple) and value[0] == "err":
            return f'<c r="{ref}" t="e"><v>{escape(value[1])}</v></c>'
        if isinstance(value, bool):
            return f'<c r="{ref}" t="b"><v>{1 if value else 0}</v></c>'
        if isinstance(value, (int, float)):
            return f'<c r="{ref}"><v>{fmt_number(value)}</v></c>'
        if isinstance(value, str):
            return f'<c r="{ref}" t="s"><v>{sst(value)}</v></c>'
        raise TypeError(value)

    parts: list[tuple[str, str]] = []
    content_overrides: list[tuple[str, str]] = []
    workbook_sheets: list[str] = []
    workbook_rels: list[str] = []
    table_counter = 0

    for s_index, sheet in enumerate(spec["sheets"], start=1):
        cells: dict[str, object] = sheet["cells"]
        refs = sorted(cells, key=sort_key)
        rows: dict[int, list[str]] = {}
        max_r = max_c = 0
        for ref in refs:
            r, c = parse_ref(ref)
            max_r, max_c = max(max_r, r), max(max_c, c)
            rows.setdefault(r, []).append(cell_xml(ref, cells[ref]))
        dim = f"A1:{col_letters(max_c)}{max_r + 1}" if refs else "A1"
        body = "".join(f'<row r="{r + 1}">{"".join(rows[r])}</row>' for r in sorted(rows))
        merges = sheet.get("merges", [])
        merge_xml = (
            f'<mergeCells count="{len(merges)}">' + "".join(f'<mergeCell ref="{m}"/>' for m in merges) + "</mergeCells>"
            if merges else ""
        )
        sheet_rels: list[str] = []
        table_parts = ""
        for t_local, table in enumerate(sheet.get("tables", []), start=1):
            table_counter += 1
            rid = f"rId{t_local}"
            sheet_rels.append(
                f'<Relationship Id="{rid}" Type="{NS_REL}/table" Target="../tables/table{table_counter}.xml"/>'
            )
            (r1, c1) = parse_ref(table["ref"].split(":")[0])
            (r2, c2) = parse_ref(table["ref"].split(":")[1])
            headers = []
            for c in range(c1, c2 + 1):
                v = cells.get(f"{col_letters(c)}{r1 + 1}")
                headers.append(str(v) if v is not None else f"Column{c - c1 + 1}")
            cols = "".join(f'<tableColumn id="{i}" name="{escape(h)}"/>' for i, h in enumerate(headers, start=1))
            parts.append((
                f"xl/tables/table{table_counter}.xml",
                XML_DECL
                + f'<table xmlns="{NS_MAIN}" id="{table_counter}" name="{table["name"]}" '
                f'displayName="{table["name"]}" ref="{table["ref"]}" totalsRowShown="0">'
                f'<autoFilter ref="{table["ref"]}"/>'
                f'<tableColumns count="{len(headers)}">{cols}</tableColumns>'
                '<tableStyleInfo name="TableStyleMedium9" showFirstColumn="0" showLastColumn="0" '
                'showRowStripes="1" showColumnStripes="0"/></table>',
            ))
            content_overrides.append((
                f"/xl/tables/table{table_counter}.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml",
            ))
        if sheet_rels:
            table_parts = (
                f'<tableParts count="{len(sheet_rels)}">'
                + "".join(f'<tablePart r:id="rId{i}"/>' for i in range(1, len(sheet_rels) + 1))
                + "</tableParts>"
            )
            parts.append((
                f"xl/worksheets/_rels/sheet{s_index}.xml.rels",
                XML_DECL + f'<Relationships xmlns="{NS_PKG_REL}">' + "".join(sheet_rels) + "</Relationships>",
            ))
        parts.append((
            f"xl/worksheets/sheet{s_index}.xml",
            XML_DECL
            + f'<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_REL}"><dimension ref="{dim}"/>'
            f"<sheetData>{body}</sheetData>{merge_xml}{table_parts}</worksheet>",
        ))
        content_overrides.append((
            f"/xl/worksheets/sheet{s_index}.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        ))
        workbook_sheets.append(f'<sheet name="{escape(sheet["name"])}" sheetId="{s_index}" r:id="rId{s_index}"/>')
        workbook_rels.append(
            f'<Relationship Id="rId{s_index}" Type="{NS_REL}/worksheet" Target="worksheets/sheet{s_index}.xml"/>'
        )

    n = len(spec["sheets"])
    workbook_rels.append(f'<Relationship Id="rId{n + 1}" Type="{NS_REL}/styles" Target="styles.xml"/>')
    workbook_rels.append(f'<Relationship Id="rId{n + 2}" Type="{NS_REL}/sharedStrings" Target="sharedStrings.xml"/>')

    sst_xml = (
        XML_DECL + f'<sst xmlns="{NS_MAIN}" count="{len(strings)}" uniqueCount="{len(strings)}">'
        + "".join(f'<si><t xml:space="preserve">{escape(s)}</t></si>' for s in strings) + "</sst>"
    )
    styles_xml = (
        XML_DECL + f'<styleSheet xmlns="{NS_MAIN}">'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )
    workbook_xml = (
        XML_DECL + f'<workbook xmlns="{NS_MAIN}" xmlns:r="{NS_REL}"><sheets>' + "".join(workbook_sheets)
        + "</sheets></workbook>"
    )
    content_types = (
        XML_DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/xl/sharedStrings.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        + "".join(f'<Override PartName="{p}" ContentType="{t}"/>' for p, t in content_overrides)
        + "</Types>"
    )
    root_rels = (
        XML_DECL + f'<Relationships xmlns="{NS_PKG_REL}">'
        f'<Relationship Id="rId1" Type="{NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    )
    ordered = [
        ("[Content_Types].xml", content_types),
        ("_rels/.rels", root_rels),
        ("xl/workbook.xml", workbook_xml),
        ("xl/_rels/workbook.xml.rels",
         XML_DECL + f'<Relationships xmlns="{NS_PKG_REL}">' + "".join(workbook_rels) + "</Relationships>"),
        ("xl/styles.xml", styles_xml),
        ("xl/sharedStrings.xml", sst_xml),
        *sorted(parts),
    ]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in ordered:
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.create_system = 0
            zf.writestr(info, text.encode("utf-8"), compresslevel=6)
    return buf.getvalue()


def ground_truth() -> dict:
    out: dict = {
        "schema": 1,
        "note": "Ground truth derived from the fixture spec in build_corpus.py, never from detector or "
        "DuckDB output. Rows are logical data rows; raw holds every stored cell exactly. "
        "Row numbers (headerRows/excludedRows) are 1-based Excel rows.",
        "fixtures": {},
    }
    for name, spec in CORPUS.items():
        out["fixtures"][name] = {
            "file": f"{name}.xlsx",
            "description": spec["description"],
            "defects": spec["defects"],
            "sheets": [
                {
                    "name": s["name"],
                    "raw": {ref: raw_text(s["cells"][ref]) for ref in sorted(s["cells"], key=sort_key)},
                    "merges": s.get("merges", []),
                    "declaredTables": s.get("tables", []),
                }
                for s in spec["sheets"]
            ],
            "tables": spec["tables"],
            "nonTables": spec["nonTables"],
        }
    return out


def render_all() -> dict[str, bytes]:
    files = {f"{name}.xlsx": build_xlsx(spec) for name, spec in CORPUS.items()}
    files["ground-truth.json"] = (json.dumps(ground_truth(), indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    manifest = {
        "schema": 1,
        "generator": "test/fixtures/xlsx-corpus/build_corpus.py (stdlib zipfile; fixed timestamps)",
        "generatedWith": {"python": platform.python_version(), "zlib": zlib.ZLIB_RUNTIME_VERSION},
        "sha256": {
            name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())
        },
    }
    files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    return files


def main(argv: list[str]) -> int:
    files = render_all()
    if "--check" in argv:
        bad = []
        for name, data in files.items():
            path = HERE / name
            if name == "manifest.json":
                # The generatedWith block may legitimately differ by interpreter.
                committed = json.loads(path.read_text("utf-8"))
                if committed["sha256"] != json.loads(data)["sha256"]:
                    bad.append(name)
                continue
            if not path.exists() or path.read_bytes() != data:
                bad.append(name)
        if bad:
            print("MISMATCH: " + ", ".join(sorted(bad)))
            return 1
        print(f"OK: {len(files)} files reproduce byte-for-byte")
        return 0
    for name, data in files.items():
        (HERE / name).write_bytes(data)
    print(f"wrote {len(files)} files to {HERE}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
