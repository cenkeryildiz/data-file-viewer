import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDbFile } from '../src/duckdbConnection';
import { referenceBackend } from '../src/backend/reference';
import * as prepare from '../src/backend/excel/prepare';
import { xlsxFile } from './stress/generators/_write';

/*
 * PERF-X1: preparation is instrumented per phase, detection work follows only
 * the sheets actually used (never the unopened ones), and the materialised
 * workbook cache is capped, evicting least recently used inactive objects to
 * views of the same shape and re-materialising them on use, with no change to
 * what any query returns.
 */

const prepareMod = prepare as unknown as Record<string, unknown>;
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

function sheetRows(tag: string, rows: number): (string | number)[][] {
  return [['id', 'value'], ...Array.from({ length: rows }, (_, i) => [i, `${tag}${i}`])];
}

test('PERF-X1: phases are timed and detection scales with sheets used, not with unopened sheets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perfx1-scale-'));
  try {
    const sheets = [{ name: 'Active', rows: sheetRows('a', 20) }];
    for (let i = 0; i < 19; i++) sheets.push({ name: `Other${i}`, rows: sheetRows(`o${i}`, 200) });
    const path = await xlsxFile(join(dir, 'wide.xlsx'), sheets);
    const file = await DuckDbFile.open(path);
    try {
      const atOpen = file.getPreparationMetrics();
      assert.equal(atOpen.detectorCalls, 0, 'opening detects nothing');
      assert.equal(atOpen.gridCells, 0);
      assert.equal(atOpen.phases.sheetCatalog?.count, 1);

      await file.runQuery('select * from "Active"');
      await file.runQuery('select * from "Active"');
      await file.getQueryCatalog(0);
      const used = file.getPreparationMetrics();
      assert.equal(used.detectorCalls, 1, 'one sheet used, one detection');
      assert.equal(used.gridCells, 21 * 2, 'decoded cells are the active sheet only');
      assert.ok(used.gridDecodedBytes >= used.gridCells * 8);
      for (const phase of ['sheetParse', 'readGrid', 'detection', 'catalog'] as const) {
        assert.equal(used.phases[phase]?.count, 1, `${phase} ran once`);
        assert.ok((used.phases[phase]?.totalMs ?? -1) >= 0);
      }
      assert.equal(used.cachedObjects, 1);
      assert.equal(used.cachedCells, 42);

      const table = file.getDetectedSheetTables('Active')[0].name;
      await file.runQuery(`select * from "${table}"`);
      const derived = file.getPreparationMetrics();
      assert.equal(derived.phases.derivedPreparation?.count, 1);
      assert.equal(derived.detectorCalls, 1, 'using a detected table does not detect again');
      assert.equal(derived.cachedObjects, 2);
    } finally { file.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PERF-X1: the cache is capped; inactive objects are evicted to same-shape views and restored on use', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perfx1-evict-'));
  const restore = (() => { const original = prepare.CACHE_MAX_CELLS; prepareMod.CACHE_MAX_CELLS = 30; return () => { prepareMod.CACHE_MAX_CELLS = original; }; })();
  try {
    const path = await xlsxFile(join(dir, 'book.xlsx'), [
      { name: 'A', rows: sheetRows('a', 10) },
      { name: 'B', rows: sheetRows('b', 10) },
    ]);
    const before = await sha(path);
    const file = await DuckDbFile.open(path);
    try {
      const a1 = await file.runQuery('select * from "A"');
      assert.equal(file.getPreparationMetrics().cachedObjects, 1);
      const b1 = await file.runQuery('select * from "B"');
      let m = file.getPreparationMetrics();
      assert.equal(m.cacheEvictions, 1, 'A evicted to keep the cache under budget');
      assert.equal(m.cachedObjects, 1);
      assert.ok(m.cachedCells <= 30 || m.cachedObjects === 1);

      // Evicted A answers identically (same trimmed shape), and comes back cached.
      const a2 = await file.runQuery('select * from "A"');
      assert.deepEqual(a2.columns, a1.columns);
      assert.deepEqual(a2.rows, a1.rows);
      m = file.getPreparationMetrics();
      assert.equal(m.cacheRestores, 1);
      assert.equal(m.cacheEvictions, 2, 'B now evicted in turn');
      assert.equal(m.phases.cacheRestore?.count, 1);
      assert.equal(m.detectorCalls, 2, 'eviction and restore never re-run detection');
      assert.deepEqual((await file.runQuery('select * from "B"')).rows, b1.rows);
      assert.equal(await sha(path), before, 'eviction never touches the source');
    } finally { file.dispose(); }
  } finally { restore(); await rm(dir, { recursive: true, force: true }); }
});

test('PERF-X1: an edit made while its sheet is evicted is what the sheet shows afterwards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perfx1-edit-'));
  const restore = (() => { const original = prepare.CACHE_MAX_CELLS; prepareMod.CACHE_MAX_CELLS = 30; return () => { prepareMod.CACHE_MAX_CELLS = original; }; })();
  try {
    const path = await xlsxFile(join(dir, 'book.xlsx'), [
      { name: 'A', rows: sheetRows('a', 10) },
      { name: 'B', rows: sheetRows('b', 10) },
    ]);
    const file = await DuckDbFile.open(path);
    try {
      await file.runQuery('select * from "A"');
      const table = file.getDetectedSheetTables('A')[0].name;
      const row = await file.runQuery(`select * from "${table}" where id = 3`);
      const rowValues: Record<string, unknown> = {};
      row.columns.forEach((c, i) => (rowValues[c] = row.rows[0][i]));
      await file.runQuery('select * from "B"');
      assert.ok(file.getPreparationMetrics().cacheEvictions >= 1);
      assert.equal(await file.updateCell(table, 'value', 'edited', rowValues), 1);
      const sheet = await file.runQuery('select * from "A"');
      assert.ok(sheet.rows.some((r) => r.includes('edited')), 'the evicted sheet shows the edit');
      const typed = await file.runQuery(`select value from "${table}" where id = 3`);
      assert.equal(typed.rows[0][0], 'edited');
    } finally { file.dispose(); }
  } finally { restore(); await rm(dir, { recursive: true, force: true }); }
});

test('PERF-X1 adapter: the restricted reader reports workbook preflight and phase metrics through metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perfx1-viewer-'));
  try {
    const path = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'A', rows: sheetRows('a', 5) }, { name: 'B', rows: sheetRows('b', 5) }]);
    const file = await referenceBackend.open(path);
    try {
      await file.runQuery('select * from "A" limit 1');
      const m = file.getPreparationMetrics();
      assert.equal(m.phases.workbookPreflight?.count, 1);
      assert.equal(m.phases.sheetCatalog?.count, 1);
      assert.equal(m.detectorCalls, 1);
      assert.equal(m.cacheMaxCells, prepare.CACHE_MAX_CELLS);
      // A copy: mutating it cannot reach the document.
      m.detectorCalls = 99;
      assert.equal(file.getPreparationMetrics().detectorCalls, 1);
    } finally { file.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
