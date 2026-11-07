// Run after tsc -p tsconfig.test.json. Independent readers regenerate every tested format and value.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const python = process.env.DFV_REF_PYTHON;
assert(python, 'Set DFV_REF_PYTHON to the independent-reader Python environment.');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-reader-reference-'));
const { DuckDbFile } = require(path.join(root, 'out-test/src/duckdbConnection'));

(async () => {
  try {
    let files = 0;
    for (const [scripts, frozen, name] of [
      [['arrow-ipc/tools/make_fixtures.py', 'arrow-ipc/tools/make_types_fixtures.py'], 'arrow-ipc/tests/fixtures', 'arrow'],
      [['xlsx/tools/make_zoo.py'], 'xlsx/tests/fixtures/zoo', 'xlsx'],
    ]) {
      const out = path.join(scratch, name);
      for (const script of scripts) {
        process.stdout.write(execFileSync(python, ['-I', path.join(root, 'native/crates', script), out]));
      }
      for (const file of fs.readdirSync(out)) {
        assert.deepEqual(fs.readFileSync(path.join(out, file)),
          fs.readFileSync(path.join(root, 'native/crates', frozen, file)), `Regenerated ${name}/${file}`);
        files++;
      }
    }
    const zoo = path.join(root, 'native/crates/xlsx/tests/fixtures/zoo');
    const expected = JSON.parse(fs.readFileSync(path.join(zoo, 'detector-observed-zoo.json')));
    let sheets = 0, tables = 0;
    for (const [file, layouts] of Object.entries(expected)) {
      const input = path.join(zoo, file), before = fs.readFileSync(input);
      const reader = await DuckDbFile.open(input, undefined, { forceReadOnly: true });
      try {
        for (const [sheet, want] of Object.entries(layouts)) {
          await reader.runQuery(`select * from "${sheet.replaceAll('"', '""')}" limit 1`);
          const got = reader.getDetectedSheetTables(sheet).map(({ top, bottom, left, right, headerRow, columns, rowCount }) =>
            ({ top, bottom, left, right, headerRow, columns, rowCount }));
          assert.deepEqual(got, want, `${file}/${sheet} reference geometry`);
          sheets++;
          tables += got.length;
        }
      } finally {
        await reader.dispose();
      }
      assert.deepEqual(fs.readFileSync(input), before, `${file} source preservation`);
    }
    console.log(`Verified ${files} byte-identical independent fixtures and ${tables} table layouts across ${sheets} sheets.`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
