import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryPolicyError } from '../src/queryPolicy';
import { validateQueryMessage, validateTableFilters } from '../src/queryMessages';

test('message boundary refuses malformed, oversized and invalid enum values', () => {
  for (const message of [null, [], 'runQuery', {}, { command: 'unknown' },
    { command: 'runQuery', sql: {} }, { command: 'runQuery', sql: 'é'.repeat(140000) },
    { command: 'sortQuery', column: 'x', direction: 'desc; drop table t' },
    { command: 'queryTarget', targetId: 'id', generation: NaN },
    { command: 'queryTarget', targetId: 'id', generation: -1 },
    { command: 'queryCatalog', cursor: Infinity },
    { command: 'toggleSafeMode', safeMode: 'false', backupBeforeWrite: true, checkForChanges: true },
    JSON.parse('{"command":"ready","__proto__":{"sql":"secret"}}'),
  ]) assert.throws(() => validateQueryMessage(message));
  validateQueryMessage({ command: 'runQuery', sql: 'select 1' });
  validateQueryMessage({ command: 'queryTarget', targetId: 'opaque', generation: 2 });
});

test('filter handoff refuses overflow rather than changing the predicate', () => {
  const filter = { column: 'Date', operator: 'gte', value: '1990-01-01' };
  validateTableFilters([filter], { column: 'Date', direction: 'desc' }, 100);
  for (const [filters, sort, limit] of [
    [Array(101).fill(filter), undefined, 100],
    [[{ ...filter, value: 'x'.repeat(4001) }], undefined, 100],
    [[filter], { column: 'Date', direction: 'DROP' }, 100],
    [[filter], undefined, 100001], [[filter], undefined, -1], [[filter], undefined, NaN],
  ]) assert.throws(() => validateTableFilters(filters, sort, limit));
});

test('range messages keep tokens and page offsets bounded before host access', () => {
  validateQueryMessage({ command: 'queryRange', token: 1, range: 'Z2:AB205', offset: 100 });
  validateQueryMessage({ command: 'invalidateRange' });
  validateQueryMessage({ command: 'useRangeAsTable', token: 1, range: 'A1:B2', headerRow: null });
  validateQueryMessage({ command: 'useRangeAsTable', token: 1, range: 'A1:B2', headerRow: 1 });
  for (const message of [
    { command: 'queryRange', token: 0, range: 'A1:B2' },
    { command: 'queryRange', token: '1', range: 'A1:B2' },
    { command: 'queryRange', token: 1, range: {} },
    { command: 'queryRange', token: 1, range: 'A'.repeat(41) },
    { command: 'queryRange', token: 1, range: 'A1:B2', offset: -1 },
    { command: 'queryRange', token: 1, range: 'A1:B2', offset: 1048576 },
    { command: 'useRangeAsTable', token: 0, range: 'A1:B2', headerRow: 1 },
    { command: 'useRangeAsTable', token: 1, range: 'A1:B2', headerRow: '1' },
    { command: 'useRangeAsTable', token: 1, range: 'A1:B2', headerRow: 0 },
    { command: 'useRangeAsTable', token: 1, range: 'A1:B2' },
  ]) assert.throws(() => validateQueryMessage(message), QueryPolicyError);
});

test('enum objects are typed refusals, including the seed 538030117 regression', () => {
  const invalid = [Object.create(null), JSON.parse('{"toString":null}'), {}, [],
    ['asc'], new String('asc'), null, undefined, true, 1];
  for (const value of invalid) {
    assert.throws(() => validateQueryMessage({ command: 'sortQuery', column: 'x', direction: value }), QueryPolicyError);
    assert.throws(() => validateQueryMessage({ command: 'columnStats', column: 'x', statsKind: value }), QueryPolicyError);
    assert.throws(() => validateTableFilters([{ column: 'x', operator: value }], undefined, 10), QueryPolicyError);
    assert.throws(() => validateTableFilters([], { column: 'x', direction: value }, 10), QueryPolicyError);
  }
});

test('enum validation never invokes object coercion', () => {
  let calls = 0;
  const coercible = (value: string) => ({ toString() { calls++; return value; } });
  assert.throws(() => validateQueryMessage({ command: 'sortQuery', column: 'x', direction: coercible('asc') }), QueryPolicyError);
  assert.throws(() => validateQueryMessage({ command: 'columnStats', column: 'x', statsKind: coercible('numeric') }), QueryPolicyError);
  assert.throws(() => validateTableFilters([{ column: 'x', operator: coercible('equals') }], undefined, 10), QueryPolicyError);
  assert.throws(() => validateTableFilters([], { column: 'x', direction: coercible('desc') }, 10), QueryPolicyError);
  assert.equal(calls, 0);
});

test('all supported string enums remain accepted without changing requests', () => {
  for (const direction of ['asc', 'desc']) {
    validateQueryMessage({ command: 'sortQuery', column: 'x', direction });
    validateTableFilters([], { column: 'x', direction }, 10);
  }
  for (const statsKind of ['numeric', 'datetime', 'other']) {
    validateQueryMessage({ command: 'columnStats', column: 'x', statsKind });
  }
  for (const operator of ['contains', 'equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'between', 'isBlank', 'isNotBlank']) {
    const filters = [{ column: 'x', operator, value: 'long exact value', valueTo: 'z' }];
    const before = structuredClone(filters);
    validateTableFilters(filters, undefined, 100);
    assert.deepEqual(filters, before);
  }
});

test('the plot axis choice is validated: booleans and text only, never both', () => {
  const chart = { command: 'chartQuery', xColumn: 'Row', xIsText: false, yColumns: ['v'] };
  validateQueryMessage(chart);
  validateQueryMessage({ ...chart, xIsRow: true });
  validateQueryMessage({ ...chart, xColumn: 'opened', xDateColumn: 'opened' });
  for (const bad of [
    { xIsRow: 'true' }, { xIsRow: 1 }, { xIsRow: null }, { xDateColumn: 7 },
    { xDateColumn: 'x'.repeat(4001) }, { xDateColumn: 'opened', xIsRow: true },
  ]) assert.throws(() => validateQueryMessage({ ...chart, ...bad }), QueryPolicyError, JSON.stringify(bad));

  const sheet = { command: 'sheetTableChart', table: 't', column: 'v', filters: [], limit: 100 };
  validateQueryMessage(sheet);
  validateQueryMessage({ ...sheet, xIsRow: true });
  validateQueryMessage({ ...sheet, xDateColumn: 'opened' });
  for (const bad of [{ xIsRow: 'yes' }, { xDateColumn: {} }, { xDateColumn: 'opened', xIsRow: true }]) {
    assert.throws(() => validateQueryMessage({ ...sheet, ...bad }), QueryPolicyError, JSON.stringify(bad));
  }
});
