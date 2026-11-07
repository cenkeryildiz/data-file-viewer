/*
 * Record what the CURRENT reader does with each corpus fixture, separately
 * from ground truth: detected tables, their derived rows, late warnings, and
 * DuckDB's default read_xlsx inference as a comparator only (never an
 * expected-output generator).
 *
 *   npx tsc -p tsconfig.test.json && node test/fixtures/xlsx-corpus/record_observed.cjs
 *
 * Writes test/fixtures/xlsx-corpus/detector-observed.json.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { DuckDbFile } = require(path.join(ROOT, 'out-test', 'src', 'duckdbConnection'));
const { DuckDBInstance } = require(path.join(ROOT, 'node_modules', '@duckdb', 'node-api'));
const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground-truth.json'), 'utf8'));

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v);
const rows = (rs) => rs.map((r) => r.map(plain));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

(async () => {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {}
  const out = {
    schema: 1,
    note: 'Observed output of the current reader. NOT ground truth; see ground-truth.json.',
    sourceCommit: commit,
    fixtures: {},
  };
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  await c.run('LOAD excel');
  try {
    for (const [name, fx] of Object.entries(truth.fixtures)) {
      const file = path.join(__dirname, fx.file);
      const before = sha(file);
      const entry = { sha256: before, sheets: {} };
      const f = await DuckDbFile.open(file, undefined, { forceReadOnly: true });
      try {
        for (const s of fx.sheets) {
          await f.runQuery(`select * from "${s.name}" limit 1`);
          const tables = [];
          for (const t of f.getDetectedSheetTables(s.name)) {
            const r = await f.runQuery(`select * from "${t.name}"`);
            tables.push({ ...t, queryColumns: r.columns, queryRows: rows(r.rows) });
          }
          entry.sheets[s.name] = { detectedTables: tables };
        }
        entry.lateWarnings = f.takeLateWarnings();
      } catch (e) {
        entry.error = String(e && e.message);
      } finally {
        await f.dispose();
      }
      for (const s of fx.sheets) {
        const literal = file.replaceAll("'", "''");
        try {
          const r = await c.runAndReadAll(`select * from read_xlsx('${literal}', sheet='${s.name.replaceAll("'", "''")}')`);
          entry.sheets[s.name].duckdbDefaultComparator = { columns: r.columnNames(), rows: rows(r.getRows()) };
        } catch (e) {
          entry.sheets[s.name].duckdbDefaultComparator = { error: String(e && e.message) };
        }
      }
      entry.sourceUnchanged = sha(file) === before;
      out.fixtures[name] = entry;
    }
  } finally {
    c.closeSync();
    instance.closeSync();
  }
  fs.writeFileSync(path.join(__dirname, 'detector-observed.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`recorded ${Object.keys(out.fixtures).length} fixtures at ${commit}`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
