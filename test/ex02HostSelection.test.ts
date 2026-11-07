import { vscodeStub, resetVscodeStub } from './stress/stubs/vscode';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rename, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBDocument, DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { ViewerFile } from '../src/viewerFile';
import { QueryPolicyError } from '../src/queryPolicy';
import { xlsxFile } from './stress/generators/_write';

// EX-02 at the provider boundary: the explicit worksheet selection, its
// request sequence and the per-document SQL draft, driven through the real
// message handler with a stub transport.

class Memento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined { return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined; }
  keys(): readonly string[] { return [...this.values.keys()]; }
  update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); return Promise.resolve(); }
}

async function workbook(dir: string, name = 'data.xlsx'): Promise<string> {
  const path = join(dir, name);
  await xlsxFile(path, [
    { name: 'Raw_Data', rows: [['Series', 'Value'], ['a', 1], ['b', 2]] },
    { name: 'ZOther', rows: [['Name', 'Value'], ['other', 7]] },
  ]);
  return path;
}

const openViews = new Set<{ close(): void }>();
async function open(provider: DuckDBEditorProvider, path: string) {
  const document = new DuckDBDocument(vscodeStub.Uri.file(path) as any, await ViewerFile.open(path));
  let receive!: (message: any) => Promise<void>;
  let disposePanel = () => {};
  const messages: any[] = [];
  const webview = {
    asWebviewUri: (uri: unknown) => uri,
    postMessage: (message: unknown) => { messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; },
  };
  await provider.resolveCustomEditor(document, { webview, onDidDispose(cb: () => void) { disposePanel = cb; return { dispose() {} }; } } as any);
  let requestId = 0;
  const send = async (message: Record<string, unknown>) => {
    await receive({ ...message, requestId: ++requestId });
    await document.runExclusive(async () => undefined);
  };
  let closed = false;
  const view = { document, messages, send, receive, nextRequestId: () => ++requestId,
    close: () => { if (closed) return; closed = true; openViews.delete(view); disposePanel(); document.dispose(); } };
  openViews.add(view);
  return view;
}

const preview = (sheet: string, selectionSeq: number) =>
  ({ command: 'runQuery', sql: `SELECT * FROM "${sheet}" LIMIT 100;`, sheetPreview: sheet, selectionSeq });

test('EX-02 host: Live navigation reads a replacement before the scheduled tick without losing selection', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'ex02-live-navigation-'));
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()), workspaceState: new Memento() } as any);
  const source = await workbook(dir);
  const view = await open(provider, source);
  try {
    await view.send(preview('Raw_Data', 1));
    // The scheduler has not ticked: exercise the precise gap between a
    // writer's atomic publish and Live noticing it, without timing sleeps.
    view.document.liveRefreshEnabled = true;
    for (let version = 2; version <= 5; version++) {
      const staged = join(dir, 'staged.xlsx');
      await xlsxFile(staged, [
        { name: 'Raw_Data', rows: [['Name'], [`raw-${version}`]] },
        { name: 'ZOther', rows: [['Name'], [`other-${version}`]] },
      ]);
      await rename(staged, source);
      const published = await readFile(source);
      view.messages.length = 0;
      await view.send(preview('ZOther', version));
      assert.deepEqual(view.messages.filter(m => m.command === 'error'), []);
      const result = view.messages.find(m => m.command === 'queryResult');
      assert.equal(result?.selectionSeq, version);
      assert.equal(result?.sheetPreview, 'ZOther');
      assert.ok(result?.rows.some((row: unknown[]) => row.includes(`other-${version}`)));
      assert.equal(view.document.lastSheetPreviewSeq, version);
      assert.deepEqual(await readFile(source), published, 'navigation preserves the published workbook');
    }
  } finally { for (const v of [...openViews]) v.close(); await rm(dir, { recursive: true, force: true }); }
});

// Real Live scheduler at its 250 ms floor; every wait is bounded.
async function waitFor(what: string, done: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const publish = async (dir: string, source: string, raw: string, other: string) => {
  const staged = join(dir, 'staged.xlsx');
  await xlsxFile(staged, [{ name: 'Raw_Data', rows: [['Name'], [raw]] }, { name: 'ZOther', rows: [['Name'], [other]] }]);
  await rename(staged, source); // atomic, as a writer process publishes
};
const rowsHave = (m: any, text: string) => (m.result?.rows ?? m.rows ?? []).some((row: unknown[]) => row.includes(text));

test('EX-02 host: a Live preview that fails on a replaced source is what the next tick refreshes', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'ex02-live-failed-preview-'));
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()), workspaceState: new Memento() } as any);
  const source = join(dir, 'data.xlsx');
  await publish(dir, source, 'raw-1', 'other-1');
  const view = await open(provider, source);
  try {
    await view.send(preview('Raw_Data', 1));
    await view.send({ command: 'toggleLiveRefresh', enabled: true, intervalMs: 250 });
    await waitFor('the first Live tick', () => view.messages.some(m => m.command === 'liveTick' && m.result));
    // The writer publishes while the ZOther preview is reading, so the
    // reader refuses it: the reproduced "workbook changed after opening".
    const file = view.document.file as any;
    const real = file.runQuery;
    let failNext = true;
    file.runQuery = async (sql: string, ...rest: unknown[]) => {
      if (failNext && sql.includes('"ZOther"')) {
        failNext = false;
        await publish(dir, source, 'raw-2', 'other-2');
        throw new QueryPolicyError('The workbook changed after opening. Refresh before querying or editing.');
      }
      return real(sql, ...rest);
    };
    view.messages.length = 0;
    await view.send(preview('ZOther', 2));
    assert.ok(view.messages.some(m => m.command === 'error'), 'the refused preview reports its error');
    await waitFor('a Live tick answering the current selection (ZOther, sequence 2)', () => view.messages.some(m =>
      m.command === 'liveTick' && m.result?.sheetPreview === 'ZOther' && m.result.selectionSeq === 2 && rowsHave(m, 'other-2')));
    assert.ok(!view.messages.some(m => m.command === 'liveTick' && m.result?.sheetPreview === 'Raw_Data'),
      'Live must not refresh the previous selection instead');
  } finally { for (const v of [...openViews]) v.close(); await rm(dir, { recursive: true, force: true }); }
});

test('EX-02 host: Live compares a tick with the rows on screen, not with the previous tick', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'ex02-live-hash-'));
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()), workspaceState: new Memento() } as any);
  const source = join(dir, 'data.xlsx');
  await publish(dir, source, 'same', 'before');
  const view = await open(provider, source);
  try {
    await view.send(preview('Raw_Data', 1));
    await view.send({ command: 'toggleLiveRefresh', enabled: true, intervalMs: 250 });
    await waitFor('the first Live tick', () => view.messages.some(m => m.command === 'liveTick' && m.result));
    // The screen now shows ZOther's rows ('before'), not the tick's ('same').
    await view.send({ command: 'runQuery', sql: 'SELECT * FROM "ZOther" LIMIT 100;' });
    assert.ok(view.messages.some(m => m.command === 'queryResult' && rowsHave(m, 'before')));
    view.messages.length = 0;
    // ZOther now returns exactly the rows the previous tick returned.
    await publish(dir, source, 'same', 'same');
    const ino = (await stat(source)).ino;
    await waitFor('the tick that reads the replacement', () => view.document.lastFileStats?.get(source)?.ino === ino);
    await view.document.runExclusive(async () => undefined);
    assert.ok(view.messages.some(m => m.command === 'liveTick' && !m.unchanged && rowsHave(m, 'same')),
      'the replacement changed the rows on screen, so the tick must repaint them');
  } finally { for (const v of [...openViews]) v.close(); await rm(dir, { recursive: true, force: true }); }
});

test('EX-02 host: latest worksheet selection wins and its result echoes the selection sequence', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'ex02-host-'));
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()), workspaceState: new Memento() } as any);
  const view = await open(provider, await workbook(dir));
  try {
    // A→B→A without waiting: only the last selection may produce a preview.
    const sent = [preview('Raw_Data', 1), preview('ZOther', 2), preview('Raw_Data', 3)]
      .map(message => view.receive({ ...message, requestId: view.nextRequestId() }));
    await Promise.all(sent);
    await view.document.runExclusive(async () => undefined);
    const previews = view.messages.filter(m => m.command === 'queryResult' && m.sheetPreview !== undefined);
    assert.equal(previews.length, 1, JSON.stringify(view.messages.map(m => [m.command, m.sheetPreview, m.message])));
    assert.equal(previews[0].sheetPreview, 'Raw_Data');
    assert.equal(previews[0].selectionSeq, 3);
    assert.equal(typeof previews[0].sourceGeneration, 'number');
    assert.deepEqual({ sheet: (view.document as any).worksheetSelection?.sheet, seq: (view.document as any).worksheetSelection?.clientSeq }, { sheet: 'Raw_Data', seq: 3 });

    // Generic SQL: the explicit selection survives, but the rows are not the
    // sheet's, carry no worksheet association and enable no coordinate edits.
    view.messages.length = 0;
    await view.send({ command: 'runQuery', sql: 'SELECT 42 AS answer;' });
    const generic = view.messages.find(m => m.command === 'queryResult');
    assert.ok(generic);
    assert.equal(generic.sheetPreview, undefined);
    assert.equal(generic.sheetTables, undefined);
    assert.equal(generic.selectionSeq, undefined);
    assert.equal(generic.editable, false);
    assert.equal(view.document.lastSheetPreview, undefined);
    assert.equal((view.document as any).worksheetSelection?.sheet, 'Raw_Data');

    // A selection naming something that is not a worksheet is not a preview.
    view.messages.length = 0;
    await view.send(preview('ex02_missing', 4));
    assert.ok(view.messages.some(m => m.command === 'error'));
    assert.equal(view.document.lastSheetPreview, undefined);
  } finally { for (const v of [...openViews]) v.close(); await rm(dir, { recursive: true, force: true }); }
});

test('EX-02 host: the SQL draft is kept per document across close and reopen, exactly', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'ex02-draft-'));
  const workspaceState = new Memento();
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()), workspaceState } as any);
  const first = await workbook(dir), second = await workbook(dir, 'second.xlsx');
  const draft = '-- exact\nSELECT 42 AS saved_draft;\n  \t';
  try {
    const a = await open(provider, first);
    const b = await open(provider, second);
    await a.send({ command: 'saveSqlDraft', sql: draft });
    await b.send({ command: 'saveSqlDraft', sql: 'SELECT 2;' });
    assert.ok(!a.messages.some(m => m.command === 'error'), JSON.stringify(a.messages));
    a.close(); b.close();

    const reopened = await open(provider, first);
    await reopened.send({ command: 'ready' });
    const restored = reopened.messages.find(m => m.command === 'sqlDraft');
    assert.ok(restored, JSON.stringify(reopened.messages.map(m => m.command)));
    assert.equal(restored.sql, draft);
    assert.ok(reopened.messages.indexOf(restored) < reopened.messages.findIndex(m => m.command === 'tables'),
      'the draft must arrive before the sidebar can auto-preview');
    const other = await open(provider, second);
    await other.send({ command: 'ready' });
    assert.equal(other.messages.find(m => m.command === 'sqlDraft')?.sql, 'SELECT 2;');

    // An emptied editor clears the stored draft; nothing is restored then.
    await reopened.send({ command: 'saveSqlDraft', sql: '' });
    reopened.close(); other.close();
    const third = await open(provider, first);
    await third.send({ command: 'ready' });
    assert.equal(third.messages.find(m => m.command === 'sqlDraft'), undefined);
    third.close();

    // Oversized drafts are refused rather than truncated.
    const big = await open(provider, first);
    await big.send({ command: 'saveSqlDraft', sql: 'x'.repeat(300 * 1024) });
    assert.ok(big.messages.some(m => m.command === 'error'));
    big.close();
  } finally { for (const v of [...openViews]) v.close(); await rm(dir, { recursive: true, force: true }); }
});

test('EX-02 host: every keystroke is kept in memory at once; workspace state gets the latest after flush', async () => {
  const { SqlDraftStore } = await import('../src/sqlDraftStore');
  const memento = new Memento();
  let writes = 0;
  const counting = { get: memento.get.bind(memento), update: (k: string, v: unknown) => { writes++; return memento.update(k, v); } };
  const store = new SqlDraftStore(counting);
  let typed = '';
  for (const ch of 'SELECT 1 AS typed;') { typed += ch; store.set('file:///a.xlsx', typed); assert.equal(store.get('file:///a.xlsx'), typed); }
  assert.equal(writes, 0, 'keystrokes are not each written to workspace state');
  await store.flush();
  assert.equal(writes, 1);
  assert.equal(new SqlDraftStore(memento).get('file:///a.xlsx'), 'SELECT 1 AS typed;', 'a new session restores the latest text');
  store.set('file:///a.xlsx', 'SELECT 2;');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(new SqlDraftStore(memento).get('file:///a.xlsx'), 'SELECT 2;', 'persisted after the pause without a flush');
  await store.flush();
});
