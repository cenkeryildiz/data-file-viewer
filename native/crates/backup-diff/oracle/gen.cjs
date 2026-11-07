// Runs the real compiled TS diffQueryAgainstBackup (read-only use of the viewer's out-test build) on seeded random inputs
// and writes cases.json for tests/differential.rs. Usage: node gen.cjs <out-test/src/duckdbConnection.js> <cases.json>
const fs = require('fs'), crypto = require('crypto');
const [mod, out] = process.argv.slice(2);
const { DuckDbFile } = require(mod);
let backupColumns, backupRows;
const file = Object.create(DuckDbFile.prototype);
Object.assign(file, {
  assertReadSql: async () => {}, synchronizeBackupViews: async () => {}, lastBackupPath: 'x', catalogName: 'c',
  connection: { run: async () => {}, streamAndReadAll: async () => ({ columnNames: () => backupColumns, getRowsJson: () => backupRows }) },
});
let seed = 12345;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const names = ['id', 'name', 'value', 'flag', 'note', 'x', 'y', 'z'];
const pool = [null, '', ' ', 'a', 'b', 'İstanbul', '1', 0, 1, 2, -7, 0.5, 9007199254740991, true, false, [1, 2], ['a', null]];
const cell = () => pool[rnd(pool.length)];
const cases = [];
(async () => {
  for (let k = 0; k < 3000; k++) {
    const nc = 1 + rnd(5);
    const cols = []; while (cols.length < nc) { const n = names[rnd(names.length)]; if (rnd(10) === 0 || !cols.includes(n)) cols.push(n); } // some duplicate names
    const nr = rnd(7);
    const rows = Array.from({ length: nr }, () => cols.map(cell));
    // backup: start from the live data, then mutate (cell edits, renamed/reordered/dropped columns, fewer or more rows)
    let bcols = cols.slice(), brows = rows.map((r) => r.slice());
    if (rnd(3) === 0) bcols = bcols.map((c) => (rnd(3) === 0 ? c + '_old' : c));
    if (rnd(4) === 0) { const p = bcols.map((_, i) => i).sort(() => rnd(3) - 1); bcols = p.map((i) => bcols[i]); brows = brows.map((r) => p.map((i) => r[i])); }
    if (rnd(4) === 0 && bcols.length > 1) { const d = rnd(bcols.length); bcols.splice(d, 1); brows = brows.map((r) => { r = r.slice(); r.splice(d, 1); return r; }); }
    if (rnd(4) === 0) brows = brows.slice(0, rnd(brows.length + 1));
    if (rnd(4) === 0) brows.push(bcols.map(cell));
    brows = brows.map((r) => r.map((v) => (rnd(6) === 0 ? cell() : v)));
    backupColumns = bcols; backupRows = JSON.parse(JSON.stringify(brows));
    const expected = await file.diffQueryAgainstBackup('select 1', cols, JSON.parse(JSON.stringify(rows)));
    cases.push({ liveColumns: cols, liveRows: rows, backupColumns: bcols, backupRows: brows, expected });
  }
  fs.writeFileSync(out, JSON.stringify(cases));
  const h = crypto.createHash('sha256').update(fs.readFileSync(mod)).digest('hex');
  console.log(JSON.stringify({ cases: cases.length, oracle_sha256: h }));
})();
