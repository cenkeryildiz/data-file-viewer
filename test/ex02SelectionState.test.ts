import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Effect,
  type QueryResultFields,
  type WebviewState,
  chooseWorksheet,
  initialState,
  previewDispatched,
  reduce,
} from '../src/webviewState';

// EX-02: the explicit worksheet selection, its sequence and the in-flight
// preview, as pure state transitions (the browser and installed-host tests
// drive the same code through the real DOM and transport).

function result(over: Partial<QueryResultFields> & { requestId?: number } = {}) {
  return {
    command: 'queryResult' as const,
    columns: ['a'], rows: [[1]], columnStatsKind: ['numeric' as const],
    diffSkipped: false, hasLimit: true, editable: false, ...over,
  };
}
const painted = (state: WebviewState) => state.lastResult?.sheetPreview;
const dispatched = (effects: Effect[]) => effects.filter(e => e.kind === 'dispatchPreview') as Extract<Effect, { kind: 'dispatchPreview' }>[];

/** A webview that clicks, and sends each dispatched preview with the next transport id. */
function simulator() {
  let state: WebviewState = initialState();
  let transport = 0;
  const wire: { sheet: string; seq: number; requestId: number }[] = [];
  const run = (effects: Effect[]) => {
    for (const effect of dispatched(effects)) {
      const requestId = ++transport;
      wire.push({ sheet: effect.sheet, seq: effect.seq, requestId });
      state = previewDispatched(state, effect.seq, requestId);
    }
  };
  return {
    get state() { return state; },
    wire,
    click(sheet: string) { const r = chooseWorksheet(state, sheet, 0, transport); state = r.state; run(r.effects); },
    deliver(message: Parameters<typeof reduce>[1]) { const r = reduce(state, message); state = r.state; run(r.effects); return r; },
    reply(sent: { sheet: string; seq: number; requestId: number }) {
      return this.deliver(result({ sheetPreview: sent.sheet, sheetTables: [], selectionSeq: sent.seq, requestId: sent.requestId }));
    },
  };
}

test('a choice is immediate; a burst sends one preview at a time and ends on the latest choice', () => {
  const view = simulator();
  for (let i = 0; i < 100; i++) view.click(i % 2 ? 'Raw_Data' : 'ZOther');
  assert.equal(view.state.selection.sheet, 'Raw_Data');
  assert.equal(view.wire.length, 1, 'only the first click is on the wire');
  const first = view.reply(view.wire[0]);
  assert.equal(view.state.lastResult, undefined, 'the reply for an older choice is not painted');
  assert.ok(!first.effects.some(e => e.kind === 'render' || e.kind === 'setRunning'));
  assert.equal(view.wire.length, 2);
  assert.deepEqual([view.wire[1].sheet, view.wire[1].seq], ['Raw_Data', 100]);
  view.reply(view.wire[1]);
  assert.equal(painted(view.state), 'Raw_Data');
  assert.equal(view.state.selection.inFlight, undefined);
});

test('A→B→A: an older preview for the same sheet name is still stale', () => {
  const view = simulator();
  view.click('A'); view.click('B'); view.click('A');
  view.reply(view.wire[0]);
  assert.equal(view.state.lastResult, undefined);
  assert.equal(view.wire.at(-1)!.seq, 3);
  view.reply(view.wire.at(-1)!);
  assert.equal(painted(view.state), 'A');
  // A replay of the first reply, delivered late, changes nothing.
  const before = view.state.lastResult;
  view.reply(view.wire[0]);
  assert.equal(view.state.lastResult, before);
});

test('a delayed row count cannot repaint the old worksheet while a newer preview is pending', () => {
  const view = simulator();
  view.click('A'); view.reply(view.wire[0]);
  view.click('B');
  const oldB = view.wire.at(-1)!;
  view.click('A'); view.click('B');
  view.reply(oldB); // discarded; latest B is now on the wire, A stays visible
  view.state.awaitingTotalForSql = 'SELECT * FROM "B" LIMIT 100;';
  const before = view.state.lastResult;
  const counted = view.deliver({ command: 'rowTotal', sql: view.state.awaitingTotalForSql,
    total: 200, requestId: oldB.requestId });
  assert.equal(view.state.lastResult, before, 'a count for discarded B cannot be attached to A rows');
  assert.ok(!counted.effects.some(e => e.kind === 'render'), 'old A rows must not be repainted under selected B');
  const currentB = view.wire.at(-1)!;
  view.reply(currentB);
  const paintedB = view.state.lastResult;
  view.deliver({ command: 'rowTotal', sql: view.state.awaitingTotalForSql!, total: 200, requestId: oldB.requestId });
  assert.equal(view.state.lastResult, paintedB, 'old counts stay stale after the current preview arrives');
  view.deliver({ command: 'rowTotal', sql: view.state.awaitingTotalForSql!, total: 300, requestId: currentB.requestId });
  assert.equal(view.state.lastResult?.totalRows, 300, 'the current preview still receives its total');
});

test('generic SQL keeps the explicit selection but gains no worksheet association', () => {
  const view = simulator();
  view.click('Raw_Data'); view.reply(view.wire[0]);
  view.deliver(result({ requestId: 50, sheetPreview: 'Raw_Data', sheetTables: [] })); // no selectionSeq: not a choice's preview
  assert.equal(view.state.selection.sheet, 'Raw_Data');
  assert.equal(view.state.lastResult?.sheetPreview, undefined);
  assert.equal(view.state.lastResult?.sheetTables, undefined);
});

test('errors: the current preview error is shown; an older one is dropped and the latest choice proceeds', () => {
  const view = simulator();
  view.click('A');
  view.click('B');
  const stale = view.deliver({ command: 'error', message: 'A failed', requestId: view.wire[0].requestId });
  assert.ok(!stale.effects.some(e => e.kind === 'showError'));
  assert.equal(view.wire.at(-1)!.sheet, 'B');
  const current = view.deliver({ command: 'error', message: 'B failed', requestId: view.wire.at(-1)!.requestId });
  assert.ok(current.effects.some(e => e.kind === 'showError'));
  assert.equal(view.state.selection.sheet, 'B', 'a failed preview leaves the choice in place');
  assert.equal(view.state.selection.inFlight, undefined);
});

test('empty previews and live ticks: nothing paints for another choice or while a preview is pending', () => {
  const view = simulator();
  view.click('A'); view.deliver(result({ rows: [], sheetPreview: 'A', sheetTables: [], selectionSeq: 1, requestId: view.wire[0].requestId }));
  assert.equal(view.state.lastResult?.rows.length, 0);
  assert.equal(view.state.lastResult?.sheetPreview, 'A');
  view.click('B');
  const tick = (selectionSeq: number, sheet: string) => view.deliver({ command: 'liveTick', lastUpdatedMs: 1, unchanged: false,
    result: { ...result({ sheetPreview: sheet, sheetTables: [], selectionSeq }), rows: [[9]] } });
  tick(1, 'A');
  assert.equal(view.state.lastResult?.sheetPreview, 'A', 'pending: the tick is ignored');
  assert.deepEqual(view.state.lastResult?.rows, []);
  view.reply(view.wire.at(-1)!);
  tick(1, 'A');
  assert.equal(view.state.lastResult?.sheetPreview, 'B', 'a tick for the old choice is ignored');
  tick(2, 'B');
  assert.deepEqual(view.state.lastResult?.rows, [[9]]);
});

test('a sidebar refresh without the chosen sheet clears the choice and invalidates its preview', () => {
  const view = simulator();
  view.click('Gone');
  view.deliver({ command: 'tables', tables: ['Other'], combinedTableNames: [] });
  assert.equal(view.state.selection.sheet, undefined);
  view.reply(view.wire[0]);
  assert.equal(view.state.lastResult, undefined);
});

test('a replaced source without the painted sheet strips that sheet\'s coordinates and detected tables', () => {
  const view = simulator();
  view.click('Gone'); view.reply(view.wire[0]);
  assert.equal(painted(view.state), 'Gone');
  const refreshed = view.deliver({ command: 'tables', tables: ['Other'], combinedTableNames: [] });
  assert.equal(view.state.selection.sheet, undefined);
  assert.equal(view.state.lastResult?.sheetPreview, undefined, 'no worksheet coordinates for a sheet that no longer exists');
  assert.equal(view.state.lastResult?.sheetTables, undefined);
  assert.ok(refreshed.effects.some(e => e.kind === 'render'), 'the grid is repainted without them');
});

test('live: a tick for the current choice is painted even while its preview is in flight; the older preview reply cannot overwrite it', () => {
  const view = simulator();
  view.click('A'); view.reply(view.wire[0]);
  view.click('B');
  const sent = view.wire.at(-1)!;
  // The host re-read the source and ran B's preview SQL after the preview
  // itself had run on the old connection: the tick is newer, and lands first.
  view.deliver({ command: 'liveTick', lastUpdatedMs: 1, unchanged: false,
    result: { ...result({ sheetPreview: 'B', sheetTables: [], selectionSeq: sent.seq, executionSeq: 11 } as any), rows: [['new']] } });
  assert.deepEqual(view.state.lastResult?.rows, [['new']], 'the current choice\'s fresh rows are shown');
  const late = view.deliver(result({ sheetPreview: 'B', sheetTables: [], selectionSeq: sent.seq, requestId: sent.requestId, executionSeq: 10, rows: [['old']] } as any));
  assert.deepEqual(view.state.lastResult?.rows, [['new']], 'older rows never replace newer ones');
  assert.ok(late.effects.some(e => e.kind === 'setRunning' && e.value === false), 'the view stops waiting');
  assert.equal(view.state.selection.inFlight, undefined);
});

test('live: a tick that ran before generic SQL does not paint the selected sheet over the generic result', () => {
  const view = simulator();
  view.click('A');
  view.deliver(result({ sheetPreview: 'A', sheetTables: [], selectionSeq: 1, requestId: view.wire[0].requestId, executionSeq: 1 } as any));
  view.deliver(result({ requestId: 40, executionSeq: 3, rows: [[42]] } as any)); // SELECT 42, selection kept
  view.deliver({ command: 'liveTick', lastUpdatedMs: 1, unchanged: false,
    result: { ...result({ sheetPreview: 'A', sheetTables: [], selectionSeq: 1, executionSeq: 2 } as any), rows: [['sheet A']] } });
  assert.deepEqual(view.state.lastResult?.rows, [[42]]);
  assert.equal(view.state.lastResult?.sheetPreview, undefined);
});
