import vscodeStub, { recorded, resetVscodeStub } from './stress/stubs/vscode';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { DuckDbFile } from '../src/duckdbConnection';
import { ViewerFile } from '../src/viewerFile';
import { nativeBackend, nativeCsvBackend, NativeCsvDocument, nativeDisplayValue } from '../src/backend/nativeDocument';
import { NativeError } from '../src/backend/native';
import type { BackendFactory } from '../src/backend/types';

const worker = process.env.DFV_TABLE_WORKER ?? join(process.cwd(), 'native/target-duck/debug/dfv-table');

test('real native provider captures exact range pages and refuses stale, unordered and changed-source ranges', { skip: !existsSync(worker), timeout: 30000 }, async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'dfv-native-range-'));
  const source = join(dir, 'rows.csv');
  const original = Array.from({ length: 251 }, (_, r) => Array.from({ length: 28 }, (_, c) => r ? String(r * 100 + c) : `c${c}`).join(',')).join('\n') + '\n';
  await writeFile(source, original);
  const backend = nativeBackend({ executable: worker, env: { ...process.env, DFV_TABLE_STATE_DIR: join(dir, 'state') } });
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any, backend);
  const document = await provider.openCustomDocument(vscodeStub.Uri.file(source) as any);
  const messages: Record<string, any>[] = [];
  let receive!: (message: unknown) => Promise<void>;
  const webview = { cspSource: 'vscode-resource:', html: '', options: {}, asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage(fn: typeof receive) { receive = fn; return { dispose() {} }; },
    async postMessage(message: Record<string, any>) { messages.push(message); return true; } };
  let requestId = 0;
  const send = (message: Record<string, unknown>) => receive({ ...message, requestId: ++requestId });
  const last = (command: string) => messages.filter(message => message.command === command).at(-1)!;
  try {
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) } as any);
    await send({ command: 'runQuery', sql: 'SELECT * FROM rows ORDER BY c0' });
    const token = last('queryResult').rangeContext.token;
    await send({ command: 'queryRange', token, range: 'Z2:AB205' });
    let page = last('queryRangeResult');
    assert.equal(page.error, undefined); assert.equal(page.rows.length, 100);
    assert.deepEqual(page.columns, ['c25', 'c26', 'c27']);
    assert.deepEqual(page.rows[0], ['225', '226', '227']);
    const sql = page.sql;
    await send({ command: 'queryRange', token, range: 'Z2:AB205', offset: 200 });
    page = last('queryRangeResult');
    assert.equal(page.rows.length, 4); assert.deepEqual(page.rows.at(-1), ['20525', '20526', '20527']);
    const independentlyRun = await document.file.runQuery(sql, 300);
    assert.equal(independentlyRun.rows.length, 204); assert.deepEqual(independentlyRun.rows[0], ['225', '226', '227']);
    assert.deepEqual(independentlyRun.rows.at(-1), page.rows.at(-1));
    await send({ command: 'queryRange', token, range: 'Z2:AC205' }); assert.match(last('queryRangeResult').error, /exceeds/);
    await send({ command: 'sortQuery', column: 'c0', direction: 'desc' });
    await send({ command: 'queryRange', token, range: 'A1:B2' }); assert.match(last('queryRangeResult').error, /changed/);
    await send({ command: 'runQuery', sql: 'SELECT * FROM rows' });
    await send({ command: 'queryRange', token: last('queryResult').rangeContext.token, range: 'A1:B2' });
    assert.match(last('queryRangeResult').error, /ORDER BY/);
    await send({ command: 'runQuery', sql: 'SELECT * FROM rows ORDER BY c0' });
    const fresh = last('queryResult').rangeContext.token;
    await send({ command: 'queryRange', token, range: 'A1:B2' }); assert.match(last('queryRangeResult').error, /changed/);
    // A stale request does not resurrect its cache; re-run before the external-write check.
    await send({ command: 'runQuery', sql: 'SELECT * FROM rows ORDER BY c0' });
    const beforeWrite = last('queryResult').rangeContext.token;
    assert.ok(beforeWrite > fresh);
    assert.equal(await readFile(source, 'utf8'), original);
    await writeFile(source, original + '\n');
    await send({ command: 'queryRange', token: beforeWrite, range: 'A1:B2' }); assert.match(last('queryRangeResult').error, /changed/);
    assert.equal(await readFile(source, 'utf8'), original + '\n');
  } finally {
    const file = document.file;
    document.dispose();
    if (file instanceof NativeCsvDocument) await file.close();
    else await (file as any).close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('native values reach the grid without rounding or losing temporal precision', () => {
  assert.equal(nativeDisplayValue(9007199254740993n), '9007199254740993');
  assert.equal(nativeDisplayValue(42n), '42');
  assert.equal(JSON.stringify([NaN, Infinity, -Infinity, -0].map(nativeDisplayValue)), '["NaN","Infinity","-Infinity","-0"]');
  assert.equal(nativeDisplayValue({ kind: 'decimal', text: '12345678901234567890.1234', precision: 24, scale: 4 }), '12345678901234567890.1234');
  assert.equal(nativeDisplayValue({ kind: 'timestamp', value: -1n, unit: 'us', tz: null }), '1969-12-31 23:59:59.999999');
  assert.equal(nativeDisplayValue({ kind: 'timestamp', value: 123456789n, unit: 'ns', tz: 'UTC' }), '1970-01-01 00:00:00.123456789+00');
  assert.equal(nativeDisplayValue({ kind: 'time', value: 1234567n, unit: 'us' }), '00:00:01.234567');
  assert.equal(nativeDisplayValue({ kind: 'date', days: -1 }), '1969-12-31');
  assert.equal(nativeDisplayValue(Buffer.from([0, 255])), '\\x00ff');
  assert.equal(nativeDisplayValue({ kind: 'date', days: 2147483647 }), 'infinity');
  assert.equal(nativeDisplayValue({ kind: 'date', days: -2147483647 }), '-infinity');
  assert.equal(nativeDisplayValue({ kind: 'timestamp', value: 9223372036854775807n, unit: 'us', tz: 'UTC' }), 'infinity');
  assert.equal(nativeDisplayValue({ kind: 'timestamp', value: -9223372036854775807n, unit: 'ns', tz: null }), '-infinity');
});

test('native CSV factory refuses unsupported formats and explicit locale before opening a worker', async () => {
  const backend = nativeCsvBackend({ executable: '/must-not-launch' });
  for (const [name, options] of [['book.xlsx', {}], ['rows.csv', { numberLocale: 'eu' }]] as const)
    await assert.rejects(backend.open(name, undefined, options), (e: unknown) => e instanceof NativeError && e.code === 'unsupported');
});

test('nested wire values keep the grid shape and exact leaves, including reserved field names', () => {
  const value = nativeDisplayValue({ kind: 'struct', fields: [
    ['list', { kind: 'list', items: [9007199254740993n, null, { kind: 'decimal', text: '1.50', precision: 3, scale: 2 }] }],
    ['map', { kind: 'map', entries: [[7n, { kind: 'list', items: [Infinity, Buffer.from([0, 255])] }]] }],
    ['__proto__', { kind: 'struct', fields: [['polluted', true]] }],
  ] }) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(({} as any).polluted, undefined);
  assert.equal(JSON.stringify(value), '{"list":["9007199254740993",null,"1.50"],"map":[{"key":"7","value":["Infinity","\\\\x00ff"]}],"__proto__":{"polluted":true}}');
});

test('real native CSV provider shows exact SQL rows and preserves its factory across cancel and refresh', { skip: !existsSync(worker), timeout: 30000 }, async t => {
  let phase = 'opening';
  t.after(() => { if (t.signal.aborted) t.diagnostic(`Native provider timed out while ${phase}`); });
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'dfv-native-provider-')), source = join(dir, 'rows.csv');
  const original = 'id,name\n1,alpha\n2,beta\n'; await writeFile(source, original);
  const files: NativeCsvDocument[] = [], native = nativeCsvBackend({ executable: worker });
  const backend: BackendFactory = { async open(...args) { const file = await native.open(...args); assert.ok(file instanceof NativeCsvDocument); files.push(file); return file; } };
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any, backend);
  const legacyOpen = ViewerFile.open, rawOpen = DuckDbFile.open;
  ViewerFile.open = async () => { throw Error('Unexpected reference backend'); };
  DuckDbFile.open = async () => { throw Error('Unexpected Node processing'); };
  const posted: Record<string, any>[] = []; let receive!: (m: unknown) => Promise<void>;
  let document: Awaited<ReturnType<typeof provider.openCustomDocument>> | undefined;
  try {
    document = await provider.openCustomDocument(vscodeStub.Uri.file(source) as any);
    assert.equal(document.file.getSheetPreparation('rows'), undefined);
    assert.deepEqual(document.file.listSheetPreparation(), []);
    assert.equal(await document.file.retrySheetPreparation('rows'), undefined);
    const metrics = document.file.getPreparationMetrics();
    assert.equal(metrics.cachedObjects, 0);
    assert.equal(metrics.detectorCalls, 0);
    metrics.phases.detection = { count: 1, totalMs: 1, maxMs: 1, lastMs: 1 };
    assert.deepEqual(document.file.getPreparationMetrics().phases, {});
    const webview = { cspSource: 'vscode-resource:', html: '', options: {}, asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage(fn: typeof receive) { receive = fn; return { dispose() {} }; },
      async postMessage(message: Record<string, any>) { JSON.stringify(message); posted.push(message); return true; } };
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) } as any);
    phase = 'reading catalog and exact values';
    let requestId = 0; const send = (m: Record<string, unknown>) => receive({ ...m, requestId: ++requestId });
    await send({ command: 'ready' }); assert.deepEqual(posted.find(m => m.command === 'tables')?.tables, ['rows']);
    await send({ command: 'queryCatalog' });
    const catalog = posted.filter(m => m.command === 'queryCatalog').at(-1)!;
    await send({ command: 'queryTarget', targetId: catalog.targets[0].id, generation: catalog.generation });
    assert.deepEqual(posted.filter(m => m.command === 'queryTargetDetails').at(-1)?.columns, [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }]);
    await send({ command: 'runQuery', sql: "select name, 9007199254740993::BIGINT as exact, 12345678901234567890.1234::DECIMAL(24,4) as dec, 'NaN'::DOUBLE as not_a_number, 'Infinity'::DOUBLE as positive_inf, '-Infinity'::DOUBLE as negative_inf, '-0'::DOUBLE as negative_zero from rows order by id" });
    const result = posted.filter(m => m.command === 'queryResult').at(-1)!;
    assert.deepEqual(result.rows, [['alpha', '9007199254740993', '12345678901234567890.1234', 'NaN', 'Infinity', '-Infinity', '-0'], ['beta', '9007199254740993', '12345678901234567890.1234', 'NaN', 'Infinity', '-Infinity', '-0']]);
    assert.equal(result.editable, false); assert.deepEqual(result.columnStatsKind, ['other', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric']);
    assert.equal(await readFile(source, 'utf8'), original);
    const before = posted.length;
    phase = 'cancelling the running query';
    const long = send({ command: 'runQuery', sql: 'select sum(a.range * b.range) from range(100000) a, range(100000) b' });
    await new Promise(resolve => setTimeout(resolve, 40)); await send({ command: 'cancelQuery' }); await long;
    assert.equal(posted.slice(before).filter(m => m.command === 'queryResult').length, 0);
    phase = 'reading after cancellation';
    await send({ command: 'runQuery', sql: 'select name from rows order by id' });
    const external = 'id,name\n1,delta\n2,gamma\n'; await writeFile(source, external);
    phase = 'enabling live refresh';
    await send({ command: 'toggleLiveRefresh', enabled: true, intervalMs: 600000 });
    phase = 'disabling live refresh';
    await send({ command: 'toggleLiveRefresh', enabled: false });
    assert.equal(files.length, 3); assert.ok(files.every(file => file instanceof NativeCsvDocument));
    await send({ command: 'runQuery', sql: 'select name from rows order by id' });
    assert.deepEqual(posted.filter(m => m.command === 'queryResult').at(-1)?.rows, [['delta'], ['gamma']]);
    assert.equal(await readFile(source, 'utf8'), external);
    assert.ok(!recorded.messages.some(m => /Unexpected/.test(m.text)));
  } finally {
    phase = 'closing workers';
    document?.dispose(); await Promise.all(files.map(file => file.close()));
    ViewerFile.open = legacyOpen; DuckDbFile.open = rawOpen;
    await rm(dir, { recursive: true, force: true }); resetVscodeStub();
  }
});
