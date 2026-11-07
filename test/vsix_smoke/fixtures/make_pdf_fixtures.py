"""Reproduce the bounded PDF edit inputs from the qualified paragraph fixture recipe."""
import hashlib
import json
from pathlib import Path
import matplotlib
import pymupdf as fitz

out = Path(__file__).resolve().parent
font_dir = Path(matplotlib.get_data_path()) / "fonts/ttf"
font = font_dir / "DejaVuSans.ttf"
for name in ("base", "unicode"):
    doc = fitz.open()
    page = doc.new_page(width=420, height=500)
    face = "helv"
    lines = ["Original paragraph with source words.", "More source words follow here."]
    if name == "unicode":
        face = "Own"
        page.insert_font(fontname=face, fontfile=font)
        lines = ["Own font İstanbul sigma σ café paragraph.", "This source face stays exact."]
    for i, text in enumerate(lines):
        page.insert_text((40, 60 + i * 14.4), text, fontsize=12, fontname=face)
    page.insert_text((40, 450), "Unrelated footer stays unchanged.", fontsize=12, fontname="helv")
    assert all(text in page.get_text() for text in lines)
    doc.save(out / (name + ".pdf"))
    doc.close()
for name in ("markers", "marker_separate"):
    doc = fitz.open()
    page = doc.new_page(width=420, height=360)
    if name == "markers":
        for y, text in [(40, "1. Numbered source item."), (80, "  (iv)   Roman source item."), (120, "2.3) Hierarchy source item."), (160, "· Bullet source item."), (200, "1.1 Introduction"), (300, "Unrelated footer.")]:
            page.insert_text((40, y), text, fontsize=14, fontname="helv")
    else:
        page.insert_text((40, 60), "1.", fontsize=14, fontname="helv")
        page.insert_text((90, 60), "Separately positioned body.", fontsize=14, fontname="helv")
        page.insert_text((40, 300), "Unrelated footer.", fontsize=14, fontname="helv")
    doc.save(out / (name + ".pdf"))
    doc.close()
(out / "LICENSE_DEJAVU").write_bytes((font_dir / "LICENSE_DEJAVU").read_bytes())
(out / "manifest.json").write_text(json.dumps({"recipe": "qualified build_paragraph_fixtures.py base/unicode subset", "reader": fitz.VersionBind, "font_sha256": hashlib.sha256(font.read_bytes()).hexdigest(), "files": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in out.glob("*.pdf")}}, indent=2) + "\n")
