import vscodeStub, { resetVscodeStub } from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDbFile } from '../src/duckdbConnection';
import { DuckDBDocument, DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { rawReferenceBackend, referenceBackend } from '../src/backend/reference';
import type { BackendFactory } from '../src/backend/types';
import * as detect from '../src/backend/excel/detect';
import * as prepare from '../src/backend/excel/prepare';
import { initialState, reduce, chooseWorksheet } from '../src/features/data';
import { xlsxFile } from './stress/generators/_write';

/*
 * SAFE-X1: table discovery on a worksheet never fails silently. Each injected
 * fault (parse/detector failure, budget, cancellation, unbindable table)
 * yields a typed status, the raw sheet stays readable, the source is
 * unchanged, nothing retries automatically, and an explicit retry starts a
 * fresh generation.
 *
 * Faults are injected by replacing exports of the host-free backend/excel
 * modules (CommonJS exports are read at call time), so the production code
 * path itself is exercised.
 */

const detectMod = detect as unknown as Record<string, unknown>;
const prepareMod = prepare as unknown as Record<string, unknown>;

function patch<T extends Record<string, unknown>>(mod: T, key: string, value: unknown): () => void {
  const original = mod[key];
  (mod as Record<string, unknown>)[key] = value;
  return () => { (mod as Record<string, unknown>)[key] = original; };
}

async function workbook(dir: string): Promise<string> {
  return xlsxFile(join(dir, 'book.xlsx'), [
    { name: 'A', rows: [['id', 'v'], [1, 2], [3, 4]] },
    { name: 'B', rows: [['k', 'w'], [5, 6], [7, 8]] },
  ]);
}

const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

function countingDetector(failFirst: number): { calls: () => number; restore: () => void } {
  const original = detect.detectSheetGrid;
  let calls = 0;
  const restore = patch(detectMod, 'detectSheetGrid', (...args: Parameters<typeof original>) => {
    calls++;
    if (calls <= failFirst) throw new Error('injected detector fault');
    return original(...args);
  });
  return { calls: () => calls, restore };
}

test('SAFE-X1: a detector failure is typed, keeps the raw sheet, does not loop, and retries in a fresh generation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safex1-fail-'));
  const path = await workbook(dir);
  const before = await sha(path);
  const detector = countingDetector(1);
  const file = await DuckDbFile.open(path);
  try {
    assert.equal(file.getSheetPreparation('A')?.state, 'pending');
    const raw = await file.runQuery('select * from "A"');
    assert.equal(raw.rows.length, 3, 'the raw sheet is still readable');
    const failed = file.getSheetPreparation('A')!;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.retryable, true);
    assert.equal(failed.generation, 0);
    assert.match(failed.message ?? '', /injected detector fault/);
    assert.deepEqual(file.getDetectedSheetTables('A'), [], 'no tables, but the status says why');

    // No automatic failure loop: further queries do not call the detector again.
    await file.runQuery('select * from "A"');
    await file.runQuery('select count(*) from "A"');
    assert.equal(detector.calls(), 1);
    assert.equal(file.getSheetPreparation('A')!.state, 'failed');

    const retried = await file.retrySheetPreparation('A');
    assert.equal(retried?.state, 'ready');
    assert.equal(retried?.generation, 1);
    assert.equal(retried?.tables, 1);
    assert.equal(detector.calls(), 2);
    const table = file.getDetectedSheetTables('A')[0];
    assert.equal((await file.runQuery(`select * from "${table.name}"`)).rows.length, 2);

    // Ready is final: another retry changes nothing and does not detect again.
    assert.equal((await file.retrySheetPreparation('A'))?.generation, 1);
    assert.equal(detector.calls(), 2);
    // Sheet B was never touched by A's failure.
    assert.equal(file.getSheetPreparation('B')?.state, 'pending');
  } finally {
    detector.restore();
    file.dispose();
    assert.equal(await sha(path), before, 'source unchanged');
    await rm(dir, { recursive: true, force: true });
  }
});

test('SAFE-X1: a retry that fails again stays failed in its own generation without leaking tables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safex1-refail-'));
  const path = await workbook(dir);
  const detector = countingDetector(2);
  const file = await DuckDbFile.open(path);
  try {
    await file.runQuery('select * from "A"');
    const again = await file.retrySheetPreparation('A');
    assert.equal(again?.state, 'failed');
    assert.equal(again?.generation, 1);
    const third = await file.retrySheetPreparation('A');
    assert.equal(third?.state, 'ready');
    assert.equal(third?.generation, 2);
    assert.equal(detector.calls(), 3);
    assert.equal((await file.listTables()).filter((t) => t.startsWith('A · Table')).length, 1);
  } finally {
    detector.restore();
    file.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SAFE-X1: a budget hit is reported as bounded, not as "no tables", and is not retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safex1-budget-'));
  const path = await workbook(dir);
  const before = await sha(path);
  const restore = patch(prepareMod, 'DETECTION_MAX_CELLS', 1);
  const detector = countingDetector(0);
  const file = await DuckDbFile.open(path);
  try {
    assert.equal((await file.runQuery('select * from "A"')).rows.length, 3);
    const status = file.getSheetPreparation('A')!;
    assert.equal(status.state, 'bounded');
    assert.equal(status.retryable, false);
    assert.match(status.message ?? '', /detection limit/);
    assert.equal(detector.calls(), 0, 'the detector never ran on a sheet over budget');
    assert.equal((await file.retrySheetPreparation('A'))?.state, 'bounded');
    assert.equal(detector.calls(), 0);
  } finally {
    restore();
    detector.restore();
    file.dispose();
    assert.equal(await sha(path), before);
    await rm(dir, { recursive: true, force: true });
  }
});

test('SAFE-X1: an interrupted preparation is cancelled (not failed, not empty) and retry recovers it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safex1-cancel-'));
  const path = await workbook(dir);
  const original = prepare.readGrid;
  let first = true;
  // DuckDB's own wording for an interrupted statement.
  const restore = patch(prepareMod, 'readGrid', async (...args: Parameters<typeof original>) => {
    if (first) { first = false; throw new Error('INTERRUPT Error: Interrupted!'); }
    return original(...args);
  });
  const file = await DuckDbFile.open(path);
  try {
    assert.equal((await file.runQuery('select * from "A"')).rows.length, 3);
    const status = file.getSheetPreparation('A')!;
    assert.equal(status.state, 'cancelled');
    assert.equal(status.retryable, true);
    assert.equal((await file.retrySheetPreparation('A'))?.state, 'ready');
  } finally {
    restore();
    file.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SAFE-X1: a table that cannot be offered makes the sheet incomplete; retry restores it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safex1-incomplete-'));
  const path = await workbook(dir);
  const original = detect.planDetectedTable;
  let refuse = true;
  const restore = patch(detectMod, 'planDetectedTable', (...args: Parameters<typeof original>) => refuse ? undefined : original(...args));
  const file = await DuckDbFile.open(path);
  try {
    await file.runQuery('select * from "A"');
    const status = file.getSheetPreparation('A')!;
    assert.equal(status.state, 'incomplete');
    assert.equal(status.skipped, 1);
    assert.equal(status.tables, 0);
    refuse = false;
    const retried = await file.retrySheetPreparation('A');
    assert.equal(retried?.state, 'ready');
    assert.equal(retried?.tables, 1);
    assert.equal(retried?.skipped, 0);
  } finally {
    restore();
    file.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SAFE-X1: "none" is reserved for a completed detection that found nothing; "disabled" for detection off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safex1-none-'));
  const path = await xlsxFile(join(dir, 'empty.xlsx'), [{ name: 'Notes', rows: [['just a note']] }]);
  const file = await DuckDbFile.open(path);
  const off = await DuckDbFile.open(path, undefined, { sheetTables: 'off' });
  try {
    await file.runQuery('select * from "Notes"');
    assert.equal(file.getSheetPreparation('Notes')?.state, 'none');
    await off.runQuery('select * from "Notes"');
    assert.equal(off.getSheetPreparation('Notes')?.state, 'disabled');
    assert.equal(file.getSheetPreparation('not a sheet'), undefined);
  } finally {
    file.dispose();
    off.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

async function openHost(path: string, backend: BackendFactory) {
  const file = await backend.open(path);
  const document = new DuckDBDocument(vscodeStub.Uri.file(path) as any, file, undefined, undefined, backend);
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any);
  const posted: Record<string, any>[] = [];
  let handler!: (message: unknown) => Promise<void>;
  const webview = {
    cspSource: 'vscode-resource:', html: '', options: {}, asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => { handler = callback; return { dispose() {} }; },
    postMessage: async (message: Record<string, any>) => { posted.push(message); return true; },
  };
  const panel = { webview, onDidDispose: () => ({ dispose() {} }) };
  await provider.resolveCustomEditor(document, panel as any);
  let requestId = 0;
  const send = (message: Record<string, unknown>) => handler({ ...message, requestId: ++requestId });
  return { document, posted, send };
}

test('SAFE-X1 host: the preview carries the failure, the webview keeps it, and an explicit retry message recovers', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'safex1-host-'));
  const path = await workbook(dir);
  const before = await sha(path);
  const detector = countingDetector(1);
  const host = await openHost(path, rawReferenceBackend);
  try {
    await host.send({ command: 'ready' });
    await host.send({ command: 'runQuery', sql: 'SELECT * FROM "A" LIMIT 100;', sheetPreview: 'A', selectionSeq: 1 });
    const result = host.posted.filter((m) => m.command === 'queryResult').at(-1)!;
    assert.equal(result.sheetPreview, 'A');
    assert.equal(result.sheetPreparation?.state, 'failed', JSON.stringify(result.sheetPreparation));
    assert.deepEqual(result.sheetTables, []);

    // The webview keeps the failure with the rows instead of a blank success.
    let state = chooseWorksheet(initialState(), 'A', 0, 0).state;
    state = { ...state, selection: { ...state.selection, inFlight: undefined } };
    const reduced = reduce(state, { ...result, selectionSeq: state.selection.seq } as any);
    assert.equal(reduced.state.lastResult?.sheetPreparation?.state, 'failed');

    await host.send({ command: 'retrySheetPreparation', sheet: 'A' });
    const retried = host.posted.filter((m) => m.command === 'sheetPreparationRetried').at(-1)!;
    assert.equal(retried.status.state, 'ready');
    assert.equal(retried.status.generation, 1);
    const after = reduce(reduced.state, retried as any);
    assert.deepEqual(after.effects, [{ kind: 'repreviewSheet', sheet: 'A' }], 'the chosen sheet is re-previewed, never re-selected');
    assert.equal(detector.calls(), 2);

    await host.send({ command: 'retrySheetPreparation', sheet: 'no such sheet' });
    assert.match(String(host.posted.at(-1)?.message), /no longer in the file/);
  } finally {
    detector.restore();
    host.document.dispose();
    assert.equal(await sha(path), before);
    await rm(dir, { recursive: true, force: true });
  }
});

test('SAFE-X1 adapter: the restricted reader reports per-sheet status through metadata and routes retry', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'safex1-viewer-'));
  const path = await workbook(dir);
  const file = await referenceBackend.open(path);
  try {
    await file.runQuery('select * from "A" limit 1');
    assert.equal(file.getSheetPreparation('A')?.state, 'ready');
    assert.equal(file.getSheetPreparation('B')?.state, 'pending');
    assert.deepEqual(file.listSheetPreparation().map((s) => [s.sheet, s.state]).sort(), [['A', 'ready'], ['B', 'pending']]);
    // Nothing to retry: the worker answers with the unchanged status.
    const unchanged = await file.retrySheetPreparation('A');
    assert.equal(unchanged?.state, 'ready');
    assert.equal(unchanged?.generation, 0);
    assert.equal(file.getDetectedSheetTables('A').length, 1);
  } finally {
    file.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
