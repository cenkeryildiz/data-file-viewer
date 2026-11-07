// V13 adapter closure: every one of the 24 operations the viewer calls (22 reads + createBackup + updateCell) goes
// through NativeDocument to the REAL Rust worker, returns a concrete result, and is refused with a typed error after
// the source changes (stale_source) and after the document is closed (not_open). No scripted engine, no skips when
// the worker is named; a missing DFV_TABLE_WORKER skips the file with the reason (the matrix test fails if the
// inventory drifts, so a skipped run cannot hide a missing method).
import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeError } from '../src/backend/native';
import { NativeDocument } from '../src/backend/nativeDocument';
import { NATIVE_OPERATIONS } from '../src/backend/nativeOperations';
import { duckdbFile, xlsxFile } from './stress/generators/_write';

const worker = process.env.DFV_TABLE_WORKER;
const real = { skip: worker && fs.existsSync(worker) ? false : 'name the built worker with DFV_TABLE_WORKER' };
type Fixture = 'csv' | 'pair' | 'xlsx';
let root: string;
// Every case gets private copies, so a source change or a write never touches another case or the master fixture.
let n = 0;
const copies = (fixture: Fixture) => {
  const dir = path.join(root, `case${n++}`); fs.mkdirSync(dir);
  const files = fixture === 'pair' ? ['cold.duckdb', 'hot.duckdb'] : [fixture === 'csv' ? 'rows.csv' : 'book.xlsx'];
  for (const f of files) fs.copyFileSync(path.join(root, 'master', f), path.join(dir, f));
  return { dir, files: files.map(f => path.join(dir, f)) };
};
const open = async (fixture: Fixture, dir: string, files: string[]) => NativeDocument.open(
  { executable: worker!, env: { ...process.env, DFV_TABLE_STATE_DIR: path.join(dir, 'state') } },
  files[0], undefined, fixture === 'pair' ? { siblingPath: files[1] } : {});
const changeSource = async (fixture: Fixture, files: string[]) => {
  if (fixture === 'xlsx') await xlsxFile(files[0], [{ name: 'Data', rows: [['id', 'v'], [1, 2], [3, 4], [5, 6]] }]);
  else fs.appendFileSync(files[0], fixture === 'csv' ? '3,gamma\n' : 'x');
};

type Doc = NativeDocument;
interface Case { fixture: Fixture; /** A count is a nicety: a typed read failure is swallowed to undefined by design, a closed document answers undefined too (its row read refuses, typed). */ soft?: true; call: (d: Doc, ctx: { detected: string }) => Promise<unknown>; check: (r: any, ctx: { detected: string }) => void }
const query = 'select * from rows order by id';
const cases: Record<string, Case> = {
  listTables: { fixture: 'csv', call: d => d.listTables(), check: r => assert.deepEqual(r, ['rows']) },
  listSidebarTables: { fixture: 'csv', call: d => d.listSidebarTables(), check: r => assert.deepEqual(r, ['rows']) },
  listSiblingTables: { fixture: 'pair', call: d => d.listSiblingTables(), check: r => assert.deepEqual(r, ['only_hot', 'sheet_metadata', 't']) },
  getCombinableTableNames: { fixture: 'pair', call: d => d.getCombinableTableNames(), check: r => assert.deepEqual(r, ['sheet_metadata', 't']) },
  buildCombinedQuery: { fixture: 'pair', call: d => d.buildCombinedQuery('t'), check: r => { assert.equal(r.timeColumn, 'Datetime'); assert.equal(typeof r.sql, 'string'); } },
  getPollCadenceSeconds: { fixture: 'pair', call: d => d.getPollCadenceSeconds('t'), check: r => assert.equal(r, 30) },
  getSeriesFrequency: { fixture: 'pair', call: d => d.getSeriesFrequency('t'), check: r => assert.equal(r, 'monthly') },
  buildDetectedTableQuery: { fixture: 'xlsx', call: (d, c) => d.buildDetectedTableQuery(c.detected), check: r => assert.equal(typeof r, 'string') },
  runDetectedTableQuery: { fixture: 'xlsx', call: (d, c) => d.runDetectedTableQuery(c.detected), check: r => {
    assert.equal(r.rows.length, 2); assert.equal(r.totalRows, 2); assert.deepEqual(r.rows[1], [3, 4]);
  } },
  runQuery: { fixture: 'csv', call: d => d.runQuery(query), check: r => assert.deepEqual(r.rows, [['1', 'alpha'], ['2', 'beta']]) },
  runChartQuery: { fixture: 'csv', call: d => d.runChartQuery(query, 'name', ['id'], true), check: r => {
    assert.equal(r.xAxisMode, 'category'); assert.deepEqual(r.rows.map((row: unknown[]) => row[0]), ['alpha', 'beta']);
  } },
  runSortedQuery: { fixture: 'csv', call: d => d.runSortedQuery(query, 'id', 'desc', 1), check: r => assert.deepEqual(r.rows, [['2', 'beta']]) },
  countMatchingRows: { fixture: 'csv', soft: true, call: d => d.countMatchingRows('select * from rows limit 1'), check: r => assert.equal(r, 2) },
  checkEditableSelect: { fixture: 'csv', call: d => d.checkEditableSelect('select * from rows'), check: r => {
    assert.equal(r.editable, true); assert.equal(r.table, 'rows'); assert.deepEqual(r.columns, ['id', 'name']);
  } },
  getColumnTopValues: { fixture: 'csv', call: d => d.getColumnTopValues(query, 'name'), check: r => {
    assert.equal(r.totalRows, 2); assert.equal(r.distinctCount, 2); assert.deepEqual(r.topValues.map((v: any) => v.value).sort(), ['alpha', 'beta']);
  } },
  getColumnDescriptiveStats: { fixture: 'csv', call: d => d.getColumnDescriptiveStats(query, 'id', 'numeric'), check: r => {
    assert.equal(r.totalRows, 2); assert.equal(r.min, '1'); assert.equal(r.max, '2');
  } },
  // No backup exists yet on a fresh copy: the reads that need one are exercised after createBackup in the combined case below.
  getQueryCatalog: { fixture: 'csv', call: d => d.getQueryCatalog(), check: r => { assert.equal(r.length, 1); assert.equal(r[0].name, 'rows'); } },
  getQueryColumns: { fixture: 'csv', call: d => d.getQueryColumns('memory', 'main', 'rows'), check: r => assert.deepEqual(r, [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }]) },
  locateXlsxEdit: { fixture: 'xlsx', call: (d, c) => d.locateXlsxEdit(c.detected, 'v', { id: 3, v: 4 }), check: r => {
    assert.equal(r.target.rowOrdinal, 3); assert.equal(r.target.columnName, 'B'); assert.match(r.sha256, /^[0-9a-f]{64}$/);
  } },
  retrySheetPreparation: { fixture: 'xlsx', call: d => d.retrySheetPreparation('Data'), check: r => { assert.equal(r.state, 'ready'); assert.equal(r.sheet, 'Data'); } },
  createBackup: { fixture: 'csv', call: d => d.createBackup(), check: r => { assert.equal(typeof r, 'string'); assert.equal(fs.readFileSync(r, 'utf8'), 'id,name\n1,alpha\n2,beta\n'); } },
  updateCell: { fixture: 'csv', call: d => d.updateCell('rows', 'name', 'changed', { id: 1, name: 'alpha' }), check: r => assert.equal(r, 1) },
  // The two backup reads need a backup and a changed live table, so their case builds its own document state.
  compareToBackup: { fixture: 'csv', call: async d => { await d.createBackup(); await d.updateCell('rows', 'name', 'changed', { id: 1, name: 'alpha' }); return d.compareToBackup(); }, check: r => assert.deepEqual(r, { rows: 'changed' }) },
  diffQueryAgainstBackup: { fixture: 'csv', call: async d => {
    await d.createBackup(); await d.updateCell('rows', 'name', 'changed', { id: 1, name: 'alpha' });
    const live = await d.runQuery(query); return d.diffQueryAgainstBackup(query, live.columns, live.rows);
  }, check: r => assert.deepEqual(r.cellChanged, [[false, true], [false, false]]) },
};

before(async () => {
  if (real.skip) return;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-native-doc-ops-')));
  fs.mkdirSync(path.join(root, 'master'));
  fs.writeFileSync(path.join(root, 'master', 'rows.csv'), 'id,name\n1,alpha\n2,beta\n');
  await xlsxFile(path.join(root, 'master', 'book.xlsx'), [{ name: 'Data', rows: [['id', 'v'], [1, 2], [3, 4]] }]);
  for (const [file, hot] of [['cold.duckdb', false], ['hot.duckdb', true]] as const) {
    await duckdbFile(path.join(root, 'master', file), [
      { name: 't', columns: [{ name: 'Datetime', type: 'TIMESTAMP' }, { name: 'v', type: 'BIGINT' }], rows: hot ? [['2024-01-03', 3]] : [['2024-01-01', 1], ['2024-01-02', 2]] },
      { name: hot ? 'only_hot' : 'only_cold', columns: [{ name: 'a', type: 'INTEGER' }], rows: [[1]] },
      { name: 'sheet_metadata', columns: [{ name: 'table_name', type: 'VARCHAR' }, { name: 'extra_json', type: 'VARCHAR' }, { name: 'frequency', type: 'VARCHAR' }],
        rows: [['t', JSON.stringify({ live_poll_seconds: hot ? 2.5 : 30 }), hot ? 'daily' : ' Monthly ']] },
    ]);
  }
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('the adapter matrix names exactly the 24 operations the viewer calls', () => {
  assert.deepEqual(Object.keys(cases).sort(), [...NATIVE_OPERATIONS].sort());
});

const typed = (code: string, label: string) => (e: unknown) => { assert.ok(e instanceof NativeError && e.code === code, `${label}: ${e}`); return true; };

for (const [method, c] of Object.entries(cases)) {
  test(`NativeDocument.${method} on the real worker: concrete result, stale_source after a source change, not_open after close`, real, async () => {
    const { dir, files } = copies(c.fixture);
    const doc = await open(c.fixture, dir, files);
    try {
      const ctx = { detected: '' };
      if (c.fixture === 'xlsx') {
        await doc.runQuery('select * from Data', 0, 'Data'); // prepares the sheet; its detected table is what the derived-table calls name
        ctx.detected = doc.getDetectedSheetTables('Data')[0].name;
      }
      c.check(await c.call(doc, ctx), ctx);
      // The source changes underneath the open document: the reply that would describe other bytes is refused, typed.
      await changeSource(c.fixture, files);
      const changed = fs.readFileSync(files[0]);
      if (c.soft) assert.equal(await c.call(doc, ctx), undefined, `${method} after change`);
      else await assert.rejects(c.call(doc, ctx), typed('stale_source', `${method} after change`));
      assert.deepEqual(fs.readFileSync(files[0]), changed); // the refusal neither repaired nor rewrote the source
      await doc.close();
      if (c.soft) assert.equal(await c.call(doc, ctx), undefined, `${method} after close`);
      else await assert.rejects(c.call(doc, ctx), typed('not_open', `${method} after close`));
    } finally { await doc.close(); }
  });
}

// V14.3 defect 1: a save reopens the workbook inside the worker; the detected-table names in use must keep answering
// afterwards, with the edited value, without re-selecting the sheet.
test('NativeDocument: a detected table is still queryable by name after updateCell', real, async () => {
  const { dir, files } = copies('xlsx');
  const doc = await open('xlsx', dir, files);
  try {
    await doc.runQuery('select * from Data', 0, 'Data');
    const detected = doc.getDetectedSheetTables('Data')[0].name;
    const sql = `select v from "${detected}" order by id`;
    assert.equal(await doc.updateCell(detected, 'v', 40, { id: 3, v: 4 }), 1);
    assert.deepEqual((await doc.runQuery(sql)).rows, [[2], [40]]);
    assert.equal(await doc.updateCell(detected, 'v', 50, { id: 3, v: 40 }), 1);
    assert.deepEqual((await doc.runQuery(sql)).rows, [[2], [50]]);
  } finally { await doc.close(); }
});
