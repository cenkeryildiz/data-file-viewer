"""Independent openpyxl reading of the SAFE-X2 after-fix probe workbooks.

Usage (Conda myproject): python -I verify_openpyxl.py <outdir>
Writes <outdir>/openpyxl.json and exits non-zero on any expectation failure.
"""
import json
import sys
from pathlib import Path

import openpyxl

out = Path(sys.argv[1]).resolve()
fixtures = out / "fixtures"
expected = {
    "disk-full.xlsx": ["old", 1],
    "rename-refused.xlsx": ["old", 1],
    "corrupt-stage.xlsx": ["old", 1],
    "external-replacement.xlsx": ["external", 7],
    "rename-then-error.xlsx": ["edited", 1],
    "crash-exit-before.xlsx": ["old", 5],
    "crash-exit-after.xlsx": ["edited", 5],
    "concurrent.xlsx": ["new-A", 1],
}
result, failures = {}, []
for name, want in expected.items():
    with (fixtures / name).open("rb") as stream:
        book = openpyxl.load_workbook(stream)
        got = [book.worksheets[0]["A2"].value, book.worksheets[0]["B2"].value]
        book.close()
    result[name] = {"row2": got, "expected": want, "ok": got == want}
    if got != want:
        failures.append(name)
result["openpyxl"] = openpyxl.__version__
result["failures"] = failures
(out / "openpyxl.json").write_text(json.dumps(result, indent=2) + "\n")
print("failures:", failures)
sys.exit(1 if failures else 0)
