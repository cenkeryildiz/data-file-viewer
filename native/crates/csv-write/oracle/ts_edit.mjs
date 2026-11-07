// Runs the TypeScript reference (compiled out-test of the viewer, read-only) on one edit:
// node ts_edit.mjs <file> <column> <rowIndex|none> <newValueJson>
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { DuckDbFile } = require('../../../../out-test/src/duckdbConnection.js');
const [file, column, rowIndex, valueJson] = process.argv.slice(2);
const table = path.basename(file).replace(/\.csv$/i, '');
const f = await DuckDbFile.open(file);
try {
  const r = await f.runQuery(`select * from "${table}"`);
  let row = {};
  if (rowIndex !== 'none') r.columns.forEach((c, i) => { row[c] = r.rows[Number(rowIndex)][i]; });
  const changed = await f.updateCell(table, column, JSON.parse(valueJson), row);
  console.log(JSON.stringify({ ok: true, changed }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) })); }
finally { f.dispose(); }
