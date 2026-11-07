import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryTarget } from '../src/queryCatalog';
import { groupQueryTargets } from '../src/queryTargetList';

function target(over: Partial<QueryTarget> & { name: string }): QueryTarget {
  return {
    catalog: 'memory',
    schema: 'main',
    sqlName: `"${over.name}"`,
    rawWorksheet: false,
    prepared: true,
    id: over.name,
    generation: 1,
    ...over,
  };
}

// YieldCurve_Data.xlsx once both sheets have been opened.
const workbook = [
  target({ name: 'Raw_Data', worksheet: 'Raw_Data', rawWorksheet: true }),
  target({ name: 'Raw_Data · Table 1', worksheet: 'Raw_Data', range: 'B4:D9' }),
  target({ name: 'Raw_Data · Table 2', worksheet: 'Raw_Data', range: 'B11:CW16814' }),
  target({ name: 'used-YieldCurve', worksheet: 'used-YieldCurve', rawWorksheet: true }),
  target({ name: 'used-YieldCurve · Table 1', worksheet: 'used-YieldCurve', range: 'B2:D3' }),
];

test('with a sheet open, only that sheet is listed: its worksheet, then its tables', () => {
  assert.deepEqual(groupQueryTargets(workbook, 'Raw_Data'), [
    { label: 'Worksheet', options: [{ id: 'Raw_Data', label: 'Raw_Data — whole sheet (A, B, C…)' }] },
    {
      label: 'Tables',
      options: [
        { id: 'Raw_Data · Table 1', label: 'Table 1 — B4:D9' },
        { id: 'Raw_Data · Table 2', label: 'Table 2 — B11:CW16814' },
      ],
    },
  ]);
});

test('the other sheet is never listed alongside the open one', () => {
  const ids = groupQueryTargets(workbook, 'used-YieldCurve').flatMap((g) => g.options.map((o) => o.id));
  assert.deepEqual(ids, ['used-YieldCurve', 'used-YieldCurve · Table 1']);
});

test('a sheet with no detected tables has no empty Tables group', () => {
  const groups = groupQueryTargets([target({ name: 'Notes', worksheet: 'Notes', rawWorksheet: true })], 'Notes');
  assert.deepEqual(groups.map((g) => g.label), ['Worksheet']);
});

test('a table name without the sheet prefix is shown whole', () => {
  const groups = groupQueryTargets(
    [target({ name: 'S', worksheet: 'S', rawWorksheet: true }), target({ name: 'custom', worksheet: 'S', range: 'A1:B2' })],
    'S'
  );
  assert.equal(groups[1].options[0].label, 'custom — A1:B2');
});

test('with no open worksheet, the list is grouped as before', () => {
  const unprepared = [target({ name: 'Raw_Data', worksheet: 'Raw_Data', rawWorksheet: true, prepared: false })];
  assert.deepEqual(groupQueryTargets(unprepared), [
    { label: 'Raw_Data', options: [{ id: 'Raw_Data', label: 'Raw_Data — Raw worksheet (A, B, C…) — not prepared' }] },
  ]);
});

test('a database file (no worksheets) is grouped by catalog.schema, even when a table was previewed', () => {
  const db = [target({ name: 'prices' }), target({ name: 'trades', schema: 'hist' })];
  for (const open of [undefined, 'prices']) {
    assert.deepEqual(groupQueryTargets(db, open), [
      { label: 'memory.main', options: [{ id: 'prices', label: 'prices' }] },
      { label: 'memory.hist', options: [{ id: 'trades', label: 'trades' }] },
    ]);
  }
});

/* ------------------------------------------------- EX-01 reproduced defects */

// Reproduced in the real browser (viewer_plan_validation_20261016,
// picker-missing-raw.png): a current-generation catalog that lacks the open
// sheet's raw entry makes the picker fall back to the whole workbook, so the
// other sheet's tables appear under the selected sheet. Fixed by EX-03.
const twoSheet = [
  target({ name: 'Raw_Data', worksheet: 'Raw_Data', rawWorksheet: true }),
  target({ name: 'Raw_Data · Table 1', worksheet: 'Raw_Data', range: 'A1:B3' }),
  target({ name: 'ZOther', worksheet: 'ZOther', rawWorksheet: true }),
  target({ name: 'ZOther · Table 1', worksheet: 'ZOther', range: 'A1:B3' }),
];
const missingRaw = twoSheet.filter((t) => !(t.rawWorksheet && t.name === 'Raw_Data'));

test('two-sheet catalog with every raw entry: only the open sheet is listed', () => {
  const ids = groupQueryTargets(twoSheet, 'Raw_Data').flatMap((g) => g.options.map((o) => o.id));
  assert.deepEqual(ids, ['Raw_Data', 'Raw_Data · Table 1']);
});

test(
  'missing raw entry for the open sheet never lists another sheet',
  () => {
    const ids = groupQueryTargets(missingRaw, 'Raw_Data').flatMap((g) => g.options.map((o) => o.id));
    assert.ok(!ids.some((id) => id.startsWith('ZOther')), `foreign options: ${ids.join(', ')}`);
    assert.ok(ids.includes('Raw_Data · Table 1'), 'the open sheet\'s own table must stay listed');
  }
);

test(
  'a catalog page holding only another sheet lists nothing for the open sheet',
  () => {
    const page = twoSheet.filter((t) => t.worksheet === 'ZOther');
    const ids = groupQueryTargets(page, 'Raw_Data').flatMap((g) => g.options.map((o) => o.id));
    assert.deepEqual(ids, []);
  }
);

test('an empty catalog with an open sheet has no picker options', () => {
  assert.deepEqual(groupQueryTargets([], 'Raw_Data'), []);
});

test('a page of derived tables without any raw entry stays scoped to the open sheet', () => {
  assert.deepEqual(groupQueryTargets(twoSheet.filter((t) => !t.rawWorksheet), 'Raw_Data'), [
    { label: 'Tables', options: [{ id: 'Raw_Data · Table 1', label: 'Table 1 — A1:B3' }] },
  ]);
});
