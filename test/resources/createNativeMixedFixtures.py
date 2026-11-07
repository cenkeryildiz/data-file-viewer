"""Independent format writers for the native-only resource test, never extension runtime code."""
import csv
import hashlib
import json
import pathlib
import sqlite3
import sys

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pymupdf
import scipy.io
import xlsxwriter

dest, mat_fixtures = map(pathlib.Path, sys.argv[1:])
dest.mkdir(parents=True, exist_ok=True)
count = 200_000
ids = np.arange(count, dtype=np.int64)
amounts = (ids * 7919) % 100_000
regions = np.array(["n", "s", "e", "w"])[ids % 4]
days = np.datetime64("2000-01-01") + ids % 9000
with (dest / "rows200000.csv").open("w", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["id", "region", "amount", "day"])
    writer.writerows(zip(ids.tolist(), regions.tolist(), amounts.tolist(), days.astype(str).tolist()))
pq.write_table(pa.table({"id": ids, "region": regions, "amount": amounts, "day": days}), dest / "rows200000.parquet", compression="NONE")
with sqlite3.connect(dest / "rows200000.sqlite") as connection:
    connection.execute("create table rows200000(id integer, region text, amount integer, day text)")
    connection.executemany("insert into rows200000 values(?,?,?,?)", zip(ids.tolist(), regions.tolist(), amounts.tolist(), days.astype(str).tolist()))
    assert connection.execute("select count(*) from rows200000").fetchone()[0] == count
workbook = xlsxwriter.Workbook(dest / "sheets50.xlsx", {"constant_memory": True})
for sheet in range(50):
    worksheet = workbook.add_worksheet(f"Sheet{sheet}")
    for table in range(10):
        row = table * 6
        worksheet.write_row(row, 0, ["id", f"v{table}"])
        for i in range(4):
            worksheet.write_row(row + i + 1, 0, [i, sheet * 1000 + table * 10 + i])
workbook.close()

# Merge simple supported values from genuine inputs. This generated Level-5 workload is
# a resource fixture, not additional genuine MATLAB codec-oracle acceptance evidence.
values = {k: v for k, v in scipy.io.loadmat(mat_fixtures / "many_v7.mat").items() if not k.startswith("__")}
values.update({k: v for k, v in scipy.io.loadmat(mat_fixtures / "native_v7.mat", variable_names=["tensor", "sparse_values", "unsigned"]).items() if not k.startswith("__")})
assert len(values) == 1003
assert values["tensor"].shape == (2, 3, 4)
assert values["sparse_values"].shape == (1_000_000, 1_000_000) and values["sparse_values"].nnz == 2
scipy.io.savemat(dest / "combined.mat", values, do_compression=True)

for name, pages in [("simple.pdf", 12), ("image-heavy.pdf", 5)]:
    document = pymupdf.open()
    for page_number in range(pages):
        page = document.new_page(width=595, height=842)
        if name == "image-heavy.pdf":
            pixels = np.random.default_rng(page_number).integers(0, 256, (1024, 1024, 3), dtype=np.uint8)
            image = pymupdf.Pixmap(pymupdf.csRGB, 1024, 1024, pixels.tobytes(), False)
            page.insert_image(pymupdf.Rect(20, 80, 575, 800), stream=image.tobytes("png"))
        page.insert_text((30, 40), f"DFV native mixed resource baseline page {page_number}")
    document.save(dest / name, deflate=True)
    document.close()

assert pq.read_metadata(dest / "rows200000.parquet").num_rows == count
print(json.dumps({"rows_per_dataset": count, "xlsx_sheets": 50, "xlsx_tables": 500, "mat_variables": 1003,
                  "files": {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                            for p in sorted(dest.iterdir())}}))
