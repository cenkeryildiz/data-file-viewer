import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRangeReadWithinCells, RANGE_READ_CELLS, hasResultOrder, parseCellRange, selectResultRange, tableFromRange, type RangeSnapshot } from '../src/queryRange';
import { join } from 'node:path';
import { SchemaSet } from './migration/schemaSubset';

test('manual table coordinates require a current raw worksheet and an in-range header', () => {
  const snapshot: RangeSnapshot = { context: { token: 2, label: 'Raw', rows: 4, columns: 2 }, worksheet: 'Data', sql: 'select * from "Data"',
    result: { columns: ['A', 'B'], rows: [['title', null], ['name', 'value'], ['a', 1], ['b', 2]], columnStatsKind: ['other', 'other'] } };
  assert.deepEqual(tableFromRange(snapshot, 2, 'A1:B4', 2), { top: 0, bottom: 4, left: 0, right: 2, headerRow: 1 });
  assert.equal(tableFromRange(snapshot, 2, 'B2:B4', null).headerRow, null);
  const schemas = new SchemaSet(join(process.cwd(), 'test/migration/schema'));
  for (const value of [{ command: 'useRangeAsTable', token: 2, range: 'A1:B4', headerRow: null },
    { command: 'useRangeAsTable', token: 2, range: 'A1:B4', headerRow: 2 },
    { command: 'queryRangeResult', ...selectResultRange(snapshot, 2, 'A1:B4') }]) {
    assert.deepEqual(schemas.validate(JSON.parse(JSON.stringify(value)), 'query-range.v1.schema.json'), []);
  }
  for (const header of [0, 5, 1.5, NaN]) assert.throws(() => tableFromRange(snapshot, 2, 'A1:B4', header));
  assert.throws(() => tableFromRange(snapshot, 1, 'A1:B4', 1));
  assert.throws(() => tableFromRange({ ...snapshot, worksheet: undefined }, 2, 'A1:B4', 1));
  assert.throws(() => tableFromRange(snapshot, 2, 'A1:B5', 1));
});

test('range coordinates, explicit order and malformed bounds', () => {
  assert.deepEqual(parseCellRange(' z2:ab10 '), { firstColumn: 26, lastColumn: 28, firstRow: 2, lastRow: 10, range: 'Z2:AB10' });
  for (const range of ['A0:B2', 'B2:A3', 'A3:B2', 'XFE1:XFE2', 'A1:B1048577', 'A1', 'A1:B2; DROP', 'A1:B02']) assert.throws(() => parseCellRange(range));
  assert.equal(hasResultOrder('select row_number() over (order by a) from t'), false);
  assert.equal(hasResultOrder('with x as (select * from t order by a) select * from x'), false);
  assert.equal(hasResultOrder(`select 'order by', "order by" from t -- order by\n`), false);
  assert.equal(hasResultOrder('with x as (select * from t) select * from x ORDER /* retained */ BY a'), true);
});

test('range pages freeze exact cells, multi-letter columns and duplicate names without mutation', () => {
  const snapshot: RangeSnapshot = { context: { token: 12, label: 'Result 12', rows: 250, columns: 28 }, sql: 'select * from t order by id;',
    result: { columns: Array.from({ length: 28 }, (_, i) => i === 27 ? 'same' : i === 26 ? 'same' : `c${i}`),
      rows: Array.from({ length: 250 }, (_, r) => Array.from({ length: 28 }, (_, c) => `${r + 1}:${c + 1}:9007199254740993`)), columnStatsKind: Array(28).fill('other') } };
  const original = JSON.stringify(snapshot);
  const page = selectResultRange(snapshot, 12, 'Z2:AB205');
  assert.deepEqual(page.columns, ['c25', 'same', 'same']);
  assert.deepEqual(page.rows[0], ['2:26:9007199254740993', '2:27:9007199254740993', '2:28:9007199254740993']);
  assert.equal(page.rows.length, 100); assert.equal(page.nextOffset, 100);
  const last = selectResultRange(snapshot, 12, 'Z2:AB205', 200);
  assert.equal(last.rows.length, 4); assert.equal(last.rows.at(-1)?.[2], '205:28:9007199254740993');
  assert.equal(last.nextOffset, undefined); assert.match(last.sql, /BETWEEN 2 AND 205/);
  assert.equal(JSON.stringify(snapshot), original);
  for (const [token, range, offset] of [[11, 'A1:B2', 0], [12, 'A1:AC2', 0], [12, 'A1:B251', 0], [12, 'A1:B2', 2], [12, 'A1:B2', -1]] as const) assert.throws(() => selectResultRange(snapshot, token, range, offset));
  assert.throws(() => selectResultRange({ ...snapshot, sql: 'select * from t' }, 12, 'A1:B2'), /ORDER BY/);
  assert.doesNotThrow(() => selectResultRange({ ...snapshot, worksheet: 'Sheet', sql: 'select * from "Sheet"' }, 12, 'A1:B2'));
});

test('wide range pages bound cells as well as rows', () => {
  const snapshot: RangeSnapshot = { context: { token: 1, label: 'Wide', rows: 200, columns: 1000 }, sql: 'select * from wide order by id',
    result: { columns: Array.from({ length: 1000 }, (_, i) => `c${i}`), rows: Array.from({ length: 200 }, (_, r) => Array.from({ length: 1000 }, (_, c) => `${r}:${c}`)), columnStatsKind: Array(1000).fill('other') } };
  const first = selectResultRange(snapshot, 1, 'A1:ALL200');
  assert.equal(first.rows.length, 16); assert.equal(first.pageSize, 16); assert.equal(first.rows.flat().length, 16000);
  const second = selectResultRange(snapshot, 1, 'A1:ALL200', first.nextOffset);
  assert.equal(second.firstRow, 17); assert.equal(second.rows[0][999], '16:999');
  const widest: RangeSnapshot = { context: { token: 2, label: 'Widest', rows: 2, columns: 16384 }, sql: 'select * from wide order by id',
    result: { columns: Array.from({ length: 16384 }, (_, i) => `c${i}`), rows: Array.from({ length: 2 }, () => Array(16384).fill('x')), columnStatsKind: Array(16384).fill('other') } };
  const one = selectResultRange(widest, 2, 'A1:XFD2');
  assert.equal(one.rows.length, 1); assert.equal(one.rows.flat().length, 16384); assert.equal(one.nextOffset, 1);
  assert.equal(selectResultRange(widest, 2, 'A1:XFD2', 1).firstRow, 2);
});

test('host range request and reply schema preserves the frozen exact display values', () => {
  const schemas = new SchemaSet(join(process.cwd(), 'test/migration/schema'));
  schemas.checkClosed();
  const snapshot: RangeSnapshot = { context: { token: 1, label: 'Exact', rows: 1, columns: 2 }, sql: 'select * from exact order by id',
    result: { columns: ['id', 'amount'], rows: [['9007199254740993', '12345678901234567890.1234']], columnStatsKind: ['numeric', 'numeric'] } };
  const reply = JSON.parse(JSON.stringify({ command: 'queryRangeResult', ...selectResultRange(snapshot, 1, 'A1:B1') }));
  const schema = 'query-range.v1.schema.json';
  for (const value of [reply, { command: 'queryRange', range: 'A1:B1', token: 1 }, { command: 'invalidateRange' }, { command: 'queryRangeResult', token: 1, error: 'Stale result.' }]) assert.deepEqual(schemas.validate(value, schema), []);
  for (const value of [{ command: 'queryRange', range: 'A1:B1', token: '1' }, { ...reply, rows: Array(101).fill(reply.rows[0]) }, { ...reply, pageSize: 101 }, { ...reply, unexpected: true }]) assert.ok(schemas.validate(value, schema).length > 0);
  assert.equal(reply.rows[0][0], '9007199254740993');
});

test('a raw-worksheet range read refuses beyond the total-cell cap instead of truncating', () => {
  assert.equal(RANGE_READ_CELLS, 2_000_000);
  assertRangeReadWithinCells(100_000, 20); // exactly at the cap
  assertRangeReadWithinCells(1_048_576, 1); // the longest legal sheet at one column
  assert.throws(() => assertRangeReadWithinCells(100_000, 21), /2100000 cells.*limit is 2000000.*row 95238/);
  assert.throws(() => assertRangeReadWithinCells(1_048_576, 16384), /would load 17179869184 cells/);
  assert.throws(() => assertRangeReadWithinCells(1_000, 2_001), { name: 'QueryPolicyError', message: /would load 2001000 cells.*row 999 or earlier/ });
});
