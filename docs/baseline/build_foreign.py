"""Reuse the foreign corpus builder without overwriting its tracked manifest."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
source = ROOT / 'test/stress/foreign/build_corpus.py'
spec = importlib.util.spec_from_file_location('foreign_builder', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.MANIFEST = module.OUT / 'generated-manifest.json'
if module.main():
    raise SystemExit(1)
expected = json.loads((source.parent/'manifest.json').read_text())
actual = json.loads(module.MANIFEST.read_text())
missing = sorted({r['file'] for r in expected['files']} - {r['file'] for r in actual['files']})
if missing:
    raise SystemExit('Missing foreign fixtures: ' + ', '.join(missing))
