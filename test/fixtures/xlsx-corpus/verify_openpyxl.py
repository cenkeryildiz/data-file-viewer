"""
Independent-reader check for the EX-01 corpus.

Opens every fixture with openpyxl (not the writer, not the product) and checks
that each stored cell, formula, cached value, merge and declared table matches
ground-truth.json exactly, that no extra cells exist, and that every file's
SHA-256 matches manifest.json.

    /Users/macc/miniforge3/envs/myproject/bin/python -I test/fixtures/xlsx-corpus/verify_openpyxl.py [out.json]
"""

from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent


def expected_value(raw: dict, data_only: bool):
    kind = raw["type"]
    if kind == "formula":
        if not data_only:
            return "=" + raw["formula"]
        kind = raw["cachedType"]
    text = raw["text"]
    if kind == "number":
        return float(text) if any(ch in text for ch in ".eE") else int(text)
    if kind == "boolean":
        return text == "TRUE"
    return text  # string and error markers are both text in openpyxl


def main(argv: list[str]) -> int:
    truth = json.loads((HERE / "ground-truth.json").read_text("utf-8"))
    manifest = json.loads((HERE / "manifest.json").read_text("utf-8"))
    report: dict = {"reader": f"openpyxl {openpyxl.__version__}", "python": sys.version.split()[0], "fixtures": {}}
    failures: list[str] = []
    for name, fx in truth["fixtures"].items():
        path = HERE / fx["file"]
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        entry: dict = {"sha256": digest, "manifestMatch": digest == manifest["sha256"].get(fx["file"]), "sheets": {}}
        if not entry["manifestMatch"]:
            failures.append(f"{name}: sha256 differs from manifest")
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            entry["zipMembersUnique"] = len(names) == len(set(names))
            entry["zipTestOk"] = zf.testzip() is None
        books = {flag: openpyxl.load_workbook(path, data_only=flag) for flag in (False, True)}
        try:
            if books[False].sheetnames != [s["name"] for s in fx["sheets"]]:
                failures.append(f"{name}: sheet names {books[False].sheetnames}")
            for sheet in fx["sheets"]:
                checked = 0
                for flag, wb in books.items():
                    ws = wb[sheet["name"]]
                    seen = {c.coordinate: c for row in ws.iter_rows() for c in row if c.value is not None}
                    if set(seen) != set(sheet["raw"]):
                        failures.append(f"{name}/{sheet['name']}: cell set differs (data_only={flag}): "
                                        f"{sorted(set(seen) ^ set(sheet['raw']))}")
                    for ref, raw in sheet["raw"].items():
                        got = seen[ref].value if ref in seen else None
                        want = expected_value(raw, flag)
                        if got != want or type(got) is not type(want):
                            failures.append(f"{name}/{sheet['name']}!{ref} data_only={flag}: {got!r} != {want!r}")
                        checked += 1
                    if not flag:
                        merges = sorted(str(r) for r in ws.merged_cells.ranges)
                        if merges != sorted(sheet["merges"]):
                            failures.append(f"{name}/{sheet['name']}: merges {merges}")
                        tables = sorted((t.displayName, t.ref) for t in ws.tables.values())
                        want_tables = sorted((t["name"], t["ref"]) for t in sheet["declaredTables"])
                        if tables != want_tables:
                            failures.append(f"{name}/{sheet['name']}: tables {tables} != {want_tables}")
                        entry["sheets"][sheet["name"]] = {"merges": merges, "tables": tables}
                entry["sheets"][sheet["name"]]["cellsChecked"] = checked
        finally:
            for wb in books.values():
                wb.close()
        report["fixtures"][name] = entry
    report["failures"] = failures
    report["ok"] = not failures
    text = json.dumps(report, indent=2) + "\n"
    if len(argv) > 0:
        Path(argv[0]).write_text(text, "utf-8")
    print(text if failures else f"OK: {len(report['fixtures'])} fixtures verified by {report['reader']}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
