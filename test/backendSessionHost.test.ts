import vscodeStub, { recorded, resetVscodeStub } from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBDocument, DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { referenceBackend } from '../src/backend/reference';
import type { BackendFactory, DocumentFile } from '../src/backend/types';
import { xlsxFile } from './stress/generators/_write';

// D1.7 session-ownership verification through the real provider message loop:
// every document is opened by the reference backend factory, and a counting
// factory wrapper proves reconnects traverse the captured adapter strategy.

type Posted = Record<string, unknown>;

function countingBackend() {
  const opened: DocumentFile[] = [];
  const backend: BackendFactory = {
    async open(path, kind, options) {
      const file = await referenceBackend.open(path, kind, options);
      opened.push(file);
      return file;
    },
  };
  return { backend, opened };
}

async function openHost(path: string, backend: BackendFactory = referenceBackend) {
  const file = await backend.open(path);
  const document = new DuckDBDocument(vscodeStub.Uri.file(path) as any, file, undefined, undefined, backend);
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any);
  const posted: Posted[] = [];
  let handler!: (message: unknown) => Promise<void>;
  let closed = false;
  const closeListeners: (() => void)[] = [];
  const webview = {
    cspSource: 'vscode-resource:', html: '', options: {}, asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => { handler = callback; return { dispose() {} }; },
    postMessage: async (message: Posted) => { if (closed) throw new Error('Webview is disposed'); posted.push(message); return true; },
  };
  const panel = { webview, onDidDispose: (listener: () => void) => { closeListeners.push(listener); return { dispose() {} }; } };
  await provider.resolveCustomEditor(document, panel as any);
  let requestId = 0;
  const send = (message: Posted) => handler({ ...message, requestId: ++requestId });
  const close = () => { closed = true; for (const listener of closeListeners) listener(); document.dispose(); };
  return { document, posted, send, close };
}

const byCommand = (posted: Posted[], command: string) => posted.filter(m => m.command === command);
const lastResult = (posted: Posted[]) => byCommand(posted, 'queryResult').at(-1) as any;

async function csv(dir: string, name: string, rows = 20, marker = 'v') {
  const path = join(dir, name);
  await writeFile(path, `id,value\n${Array.from({ length: rows }, (_, i) => `${i},${marker}${i}`).join('\n')}\n`);
  return path;
}

test('D1.7 session: Safe Mode backup, edit, diff and re-lock comparison traverse the reference adapter', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'dfv-d17-safe-'));
  const path = await csv(dir, 'data.csv');
  const original = await readFile(path);
  const host = await openHost(path);
  try {
    await host.send({ command: 'ready' });
    // Safe Mode on: edits are refused before reaching the file.
    await host.send({ command: 'runQuery', sql: 'select * from data' });
    assert.equal(lastResult(host.posted).editable, true, JSON.stringify(host.posted.at(-1)));
    await host.send({ command: 'updateCell', column: 'value', rowValues: { id: 3, value: 'v3' }, newValue: 'edited' });
    assert.match(String((byCommand(host.posted, 'cellUpdateError').at(-1) as any).message), /Blocked by Safe Mode/);
    assert.deepEqual(await readFile(path), original);

    await host.send({ command: 'toggleSafeMode', safeMode: false, backupBeforeWrite: true, checkForChanges: true });
    const status = String((byCommand(host.posted, 'backupStatus').at(-1) as any).message);
    assert.match(status, /^Backup created: data\.backup-.*\.csv$/);
    const backupName = status.replace('Backup created: ', '');
    assert.deepEqual(await readFile(join(dir, backupName)), original, 'backup holds the pre-edit bytes');

    await host.send({ command: 'updateCell', column: 'value', rowValues: { id: 3, value: 'v3' }, newValue: 'edited' });
    assert.equal((byCommand(host.posted, 'cellUpdated').at(-1) as any)?.rowsMatched, 1, JSON.stringify(host.posted.at(-1)));
    assert.match(await readFile(path, 'utf8'), /\n3,edited\n/);
    assert.deepEqual(await readFile(join(dir, backupName)), original, 'the edit never touched the backup');

    // The automatic diff marks exactly the edited cell.
    await host.send({ command: 'runQuery', sql: 'select * from data order by id' });
    const diffed = lastResult(host.posted);
    const changed = (diffed.cellChanged as boolean[][]).flatMap((row, r) => row.map((c, k) => c ? `${r}:${k}` : '')).filter(Boolean);
    assert.deepEqual(changed, ['3:1']);

    // Re-locking compares against the backup.
    await host.send({ command: 'toggleSafeMode', safeMode: true, backupBeforeWrite: true, checkForChanges: true });
    assert.deepEqual((byCommand(host.posted, 'tableChangeStatus').at(-1) as any).status, { data: 'changed' });
    assert.equal((byCommand(host.posted, 'safeModeState').at(-1) as any).safeMode, true);
  } finally {
    host.close();
    await host.document.session.close();
  }
  // Closing with a backup reports the comparison after drain.
  assert.ok(recorded.messages.some(m => /data\.csv: 1 of 1 table\(s\) changed since backup/.test(m.text)), JSON.stringify(recorded.messages));
  await rm(dir, { recursive: true, force: true });
});

test('D1.7 session: queue flood, cancel and retry leave the adapter session usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-d17-flood-'));
  const host = await openHost(await csv(dir, 'flood.csv', 50));
  try {
    await host.send({ command: 'ready' });
    const slow = host.send({ command: 'runQuery', sql: 'select count(*) from range(2000000000) a, range(10) b' });
    await new Promise(r => setTimeout(r, 200));
    // Thirty queued runs while one is executing: none may be lost silently,
    // the queue never exceeds its limit, and only the newest is delivered last.
    const flood = Array.from({ length: 30 }, (_, i) => host.send({ command: 'runQuery', sql: `select ${i} as n` }));
    await host.send({ command: 'cancelQuery' });
    await Promise.all([slow, ...flood]);
    assert.equal(String(lastResult(host.posted).rows[0][0]), '29');
    assert.equal(host.document.isBusy(), false, 'every queued job settled');
    // Retry after the flood.
    await host.send({ command: 'runQuery', sql: 'select count(*) as n from flood' });
    assert.equal(String(lastResult(host.posted).rows[0][0]), '50');
  } finally { host.close(); await host.document.session.close(); await rm(dir, { recursive: true, force: true }); }
});

test('D1.7 session: repeated Live reconnects, alternating documents and close/reopen go through the captured factory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-d17-reopen-'));
  const a = countingBackend(), b = countingBackend();
  const hostA = await openHost(await csv(dir, 'a.csv', 5, 'A'), a.backend);
  const hostB = await openHost(await csv(dir, 'b.csv', 5, 'B'), b.backend);
  try {
    for (const host of [hostA, hostB]) await host.send({ command: 'ready' });
    for (let round = 0; round < 3; round++) {
      // Alternate the two documents, toggling Live (read-only reconnect, then writable reconnect).
      for (const host of [hostA, hostB]) {
        await host.send({ command: 'runQuery', sql: `select value from ${host === hostA ? 'a' : 'b'} where id = 2` });
        await host.send({ command: 'toggleLiveRefresh', enabled: true, intervalMs: 60_000 });
        await host.send({ command: 'toggleLiveRefresh', enabled: false });
      }
    }
    assert.equal(String(lastResult(hostA.posted).rows[0][0]), 'A2');
    assert.equal(String(lastResult(hostB.posted).rows[0][0]), 'B2');
    // Each document reopened only through its own factory; handles never shared.
    assert.ok(a.opened.length >= 4 && b.opened.length >= 4, `${a.opened.length}/${b.opened.length}`);
    assert.ok(!a.opened.some(file => b.opened.includes(file)));
    assert.ok(a.opened.includes(hostA.document.file) && b.opened.includes(hostB.document.file));
    assert.equal(byCommand(hostA.posted, 'liveRefreshStopped').length, 3);
    assert.ok(byCommand(hostA.posted, 'liveRefreshStopped').every(m => m.readOnly === false));
  } finally {
    hostA.close(); hostB.close();
    await Promise.all([hostA.document.session.close(), hostB.document.session.close()]);
  }
  // Closing disposed everything; a fresh open of the same path works.
  const again = await openHost(join(dir, 'a.csv'));
  try {
    await again.send({ command: 'runQuery', sql: 'select count(*) from a' });
    assert.equal(String(lastResult(again.posted).rows[0][0]), '5');
  } finally { again.close(); await again.document.session.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const delayMs of [0, 1, 5, 25, 100]) {
  test(`D1.7 session: an edit racing Live-on and editor close (${delayMs} ms) is either saved or refused, and reported as what happened`, async () => {
    resetVscodeStub();
    const dir = await mkdtemp(join(tmpdir(), 'dfv-d17-saveclose-'));
    const path = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'A', rows: [['A', 'B'], ['old', '1']] }]);
    const host = await openHost(path);
    await host.send({ command: 'runQuery', sql: 'select * from "A"' });
    assert.equal(lastResult(host.posted)?.editable, true, JSON.stringify(host.posted.at(-1)));
    await host.send({ command: 'toggleSafeMode', safeMode: false, backupBeforeWrite: true, checkForChanges: true });
    const backupBytes = await readFile(path);
    const edit = host.send({ command: 'updateCell', column: 'A', newValue: 'edited', rowValues: { A: 'old', B: '1' } });
    const live = host.send({ command: 'toggleLiveRefresh', enabled: true, intervalMs: 60_000 });
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    host.close();
    await Promise.allSettled([edit, live]);
    await host.document.session.close();
    await new Promise(r => setTimeout(r, 50));
    // Whatever the race outcome, the source matches the reported outcome.
    const reread = await openHost(path);
    let value: string;
    try {
      await reread.send({ command: 'runQuery', sql: 'select * from "A"' });
      const rows = lastResult(reread.posted).rows.map((r: unknown[]) => r.map(String));
      // The raw worksheet view: row 0 is the sheet's own first row (A1:B1).
      assert.deepEqual(rows[0], ['A', 'B']);
      assert.equal(rows.length, 2);
      value = rows[1][0];
      assert.equal(rows[1][1], '1');
    } finally { reread.close(); await reread.document.session.close(); }
    const saved = recorded.messages.some(m => /book\.xlsx: The edit to "A" was saved/.test(m.text)) || host.posted.some(m => m.command === 'cellUpdated');
    const refused = recorded.messages.some(m => /book\.xlsx: The edit to "A" did not complete/.test(m.text)) || host.posted.some(m => m.command === 'cellUpdateError');
    assert.ok(saved !== refused, `exactly one outcome is reported: ${JSON.stringify(recorded.messages)}`);
    assert.equal(value, saved ? 'edited' : 'old');
    if (!saved) assert.deepEqual(await readFile(path), backupBytes, 'a refused edit leaves the source byte-identical');
    const names = await readdir(dir);
    assert.equal(names.filter(n => n.startsWith('book.backup-')).length, 1, names.join(', '));
    assert.deepEqual(names.filter(n => !n.startsWith('book.backup-') && n !== 'book.xlsx'), [], 'no stage or lock left behind');
    await rm(dir, { recursive: true, force: true });
  });
}

test('D1.7 session: closing during post-save reader reload preserves the published outcome even if reload fails', { timeout: 30000 }, async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'dfv-d17-reload-close-'));
  const path = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'A', rows: [['A', 'B'], ['old', '1']] }]);
  const original = await readFile(path);
  const host = await openHost(path);
  let release!: () => void;
  let reached!: () => void;
  const reloading = new Promise<void>(resolve => { reached = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const file = host.document.file as any;
  const originalOpen = file.ensureOpen;
  const originalCancel = file.worker.cancel;
  let cancellations = 0;
  try {
    await host.send({ command: 'runQuery', sql: 'select * from "A"' });
    await host.send({ command: 'toggleSafeMode', safeMode: false, backupBeforeWrite: true, checkForChanges: true });
    file.ensureOpen = async function(allowChanged = false) {
      if (allowChanged) {
        reached();
        await proceed;
        throw new Error('injected reader reload failure after publication');
      }
      return originalOpen.call(this, allowChanged);
    };
    file.worker.cancel = function() { cancellations++; return originalCancel.call(this); };
    const edit = host.send({ command: 'updateCell', column: 'A', newValue: 'edited', rowValues: { A: 'old', B: '1' } });
    await reloading;
    host.close();
    assert.equal(cancellations, 0, 'closing must drain the trusted save, including its reader handoff');
    release();
    await edit;
    await host.document.session.close();
    assert.ok(recorded.messages.some(m => /The edit to "A" was saved/.test(m.text)), JSON.stringify(recorded.messages));
    assert.ok(recorded.messages.some(m => /completed, but the viewer could not reload/.test(m.text)), JSON.stringify(recorded.messages));
    assert.ok(!recorded.messages.some(m => /The edit to "A" did not complete/.test(m.text)), JSON.stringify(recorded.messages));
    const reread = await openHost(path);
    try {
      await reread.send({ command: 'runQuery', sql: 'select * from "A"' });
      assert.deepEqual(lastResult(reread.posted).rows.map((row: unknown[]) => row.map(String)), [['A', 'B'], ['edited', '1']]);
    } finally { reread.close(); await reread.document.session.close(); }
    const backup = (await readdir(dir)).filter(name => name.startsWith('book.backup-'));
    assert.equal(backup.length, 1);
    assert.deepEqual(await readFile(join(dir, backup[0])), original);
  } finally {
    release();
    file.ensureOpen = originalOpen;
    file.worker.cancel = originalCancel;
    host.close();
    await host.document.session.close();
    await rm(dir, { recursive: true, force: true });
  }
});
