import vscodeStub from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// Worker-failure and restart-recovery UX of PdfEditorProvider against the REAL dfv-pdf worker and a
// fake vscode (same harness idea as pdfHostFailure.test.ts). Without DFV_PDF_BIN the suite is skipped.

const BIN = process.env.DFV_PDF_BIN;
const skip = !BIN || !existsSync(BIN) ? 'set DFV_PDF_BIN to the dfv-pdf binary' : false;
const stub = vscodeStub as any;
const uri = (path: string) => stub.Uri.file(path) as any;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function tinyPdf(): Buffer {
  const stream = 'BT /F1 18 Tf 20 100 Td (Recovery offer) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dfv-pdf-offer-'));
  const ext = join(dir, 'ext');
  mkdirSync(join(ext, 'media', 'pdf', 'bin'), { recursive: true });
  mkdirSync(join(ext, 'media', 'pdf', 'web', 'static'), { recursive: true });
  writeFileSync(join(ext, 'media', 'pdf', 'web', 'static', 'index.html'), '<html><head></head><body><script src="/static/editorTransport.js"></script></body></html>');
  symlinkSync(BIN!, join(ext, 'media', 'pdf', 'bin', 'dfv-pdf'));
  const source = join(dir, 'original.pdf');
  writeFileSync(source, tinyPdf());
  const context = { extensionPath: ext, extensionUri: uri(ext), globalStorageUri: uri(join(dir, 'store')), subscriptions: [] } as any;

  const fired: unknown[] = [];
  const warnings: { text: string; items: string[] }[] = [];
  const errors: string[] = [];
  let choice: string | undefined;
  const saved = { E: stub.EventEmitter, w: stub.window.showWarningMessage, e: stub.window.showErrorMessage, d: stub.window.showSaveDialog, r: stub.window.registerCustomEditorProvider };
  stub.EventEmitter = class { event = () => ({ dispose() {} }); fire(e: unknown) { fired.push(e); } dispose() {} };
  stub.window.showWarningMessage = async (text: string, ...items: string[]) => { warnings.push({ text, items }); return choice && items.includes(choice) ? choice : undefined; };
  stub.window.showErrorMessage = async (t: string) => { errors.push(t); };
  let provider: any;
  stub.window.registerCustomEditorProvider = (_t: string, p: unknown) => { provider = p; return { dispose() {} }; };
  // Imported only now: `import * as vscode` copies the module's members when first loaded.
  const { PdfEditorProvider } = await import('../src/pdfEditorProvider');
  PdfEditorProvider.register(context);

  const docs: any[] = [];
  /** Opens a document with a fake panel; `send` plays the webview side of the req/res protocol. */
  const open = async () => {
    const doc = await provider.openCustomDocument(uri(source));
    docs.push(doc);
    let handler: (m: any) => Promise<void> = async () => {};
    const posted: any[] = [];
    let htmls = 0, lastHtml = '';
    const panel = { webview: { options: {}, cspSource: 'csp:', asWebviewUri: (u: any) => u, postMessage: async (m: unknown) => { posted.push(m); return true; },
      onDidReceiveMessage: (f: any) => { handler = f; return { dispose() {} }; }, set html(v: string) { htmls++; lastHtml = v; }, get html() { return lastHtml; } } };
    await provider.resolveCustomEditor(doc, panel);
    let id = 0;
    const send = async (op: string, params: any = {}) => {
      const mine = ++id; await handler({ type: 'req', id: mine, op, params });
      return posted.filter(m => m.type === 'res' && m.id === mine).pop();
    };
    return { doc, send, htmls: () => htmls, posted, html: () => lastHtml };
  };
  const settle = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await sleep(100); };
  const workers = () => { try { return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
  return {
    provider, open, warnings, errors, fired, settle, workers, source,
    pick: (c?: string) => { choice = c; },
    close: () => {
      for (const d of docs) d.dispose();
      stub.EventEmitter = saved.E; stub.window.showWarningMessage = saved.w; stub.window.showErrorMessage = saved.e;
      stub.window.showSaveDialog = saved.d; stub.window.registerCustomEditorProvider = saved.r;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const rotate = async (t: { send(op: string, p?: any): Promise<any> }) => {
  const s = (await t.send('get_state')).value;
  const r = await t.send('page.rotate', { pages: [0], degrees: 90, layout: s.layout });
  assert.ok(!r.error, JSON.stringify(r.error));
};

test('worker crash: user is warned by name, restore is offered, never applied silently', { skip, timeout: 90000 }, async () => {
  const fx = await setup();
  try {
    const t = await fx.open();
    assert.equal(fx.warnings.length, 0, 'a clean open with no recoveries shows nothing');
    await rotate(t);
    assert.equal(fx.fired.length, 1, 'the edit marks the document dirty');

    process.kill(fx.workers()[0], 'SIGKILL');
    const failed = await t.send('get_state');
    assert.match(failed.error.code, /^WORKER_/);
    await fx.settle(() => fx.warnings.length > 0);
    assert.equal(fx.warnings.length, 1);
    assert.match(fx.warnings[0].text, /PDF worker problem \(WORKER_[A-Z]+\)/);
    assert.deepEqual(fx.warnings[0].items, ['Restore unsaved edits']);
    assert.equal(fx.fired.length, 1, 'declining the offer restores nothing');
    assert.equal(((await t.send('get_state')).value).dirty, false);

    // The user accepts the next offer: it restores the edit as real history and reloads the webview.
    fx.pick('Restore unsaved edits');
    const htmlBefore = t.htmls();
    await fx.provider.notify(t.doc);
    const state = (await t.send('get_state')).value;
    assert.equal(state.dirty, true);
    assert.equal(state.can_undo, true);
    assert.equal(fx.fired.length, 2, 'restored edits mark the document dirty so VS Code asks before closing');
    assert.equal(t.htmls(), htmlBefore + 1, 'webview reloaded');
    assert.deepEqual(fx.errors, []);
  } finally { fx.close(); }
});

test('open offers recoveries left by an earlier session; Save As cancel keeps the document dirty', { skip, timeout: 90000 }, async () => {
  const fx = await setup();
  try {
    const first = await fx.open();
    await rotate(first);
    process.kill(fx.workers()[0], 'SIGKILL'); // the earlier session dies with an unsaved edit
    await sleep(300);

    const second = await fx.open();
    await fx.settle(() => fx.warnings.length > 0);
    assert.equal(fx.warnings.length, 1, 'open shows the offer');
    assert.match(fx.warnings[0].text, /unsaved edit session\(s\) for original\.pdf can be restored/);
    assert.deepEqual(fx.warnings[0].items, ['Restore unsaved edits']);
    assert.equal(((await second.send('get_state')).value).dirty, false, 'nothing restored until the user asks');

    fx.pick('Restore unsaved edits');
    await fx.provider.notify(second.doc);
    assert.equal(((await second.send('get_state')).value).dirty, true);

    stub.window.showSaveDialog = async () => undefined;
    await assert.rejects(fx.provider.saveCustomDocument(second.doc), /cancelled/i);
    assert.equal(((await second.send('get_state')).value).dirty, true, 'a cancelled save leaves the edits unsaved');
  } finally { fx.close(); }
});

test('restore picks the newest recovery by `created`, whatever order the worker lists them in', async () => {
  const { newestRecovery } = await import('../src/pdfEditorProvider');
  const [a, b, c] = [{ backup_id: 'a', created: 10 }, { backup_id: 'b', created: 30.5 }, { backup_id: 'c', created: 20 }];
  for (const order of [[a, b, c], [c, b, a], [b, a, c]]) assert.equal(newestRecovery(order).backup_id, 'b');
  assert.equal(newestRecovery([{ backup_id: 'x' }, { backup_id: 'y' }]).backup_id, 'y', 'no stamps: later in the list wins');
});

test('accepting the offer restores the newest session even when the worker lists it first', { skip, timeout: 90000 }, async () => {
  const fx = await setup();
  try {
    const first = await fx.open();
    await rotate(first);
    process.kill(fx.workers()[0], 'SIGKILL');
    await sleep(1100); // `created` has sub-second precision, but keep the two sessions clearly apart
    const second = await fx.open();
    await rotate(second); await rotate(second);
    process.kill(fx.workers()[0], 'SIGKILL');
    await sleep(300);

    const third = await fx.open();
    const listed = ((await third.send('list_recoveries')).value.recoveries) as any[];
    assert.equal(listed.length, 2);
    const newest = listed.reduce((a, b) => (b.created > a.created ? b : a));
    // Reverse the list so that "the last item" is the OLDEST session.
    const real = third.doc.host.request.bind(third.doc.host);
    let restoredId: string | undefined;
    third.doc.host.request = async (op: string, p: any) => {
      if (op === 'restore_recovery') restoredId = p.backup_id;
      const v = await real(op, p) as any;
      return op === 'list_recoveries' ? { ...v, recoveries: [...v.recoveries].reverse() } : v;
    };
    fx.pick('Restore unsaved edits');
    await fx.provider.notify(third.doc);
    assert.equal(restoredId, newest.backup_id);
    assert.deepEqual(fx.errors, []);
  } finally { fx.close(); }
});

test('the webview shim blocks formula tools and any edit kind the engine does not report, with a reason', { skip, timeout: 60000 }, async () => {
  const fx = await setup();
  try {
    const t = await fx.open();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(t.html())![1];
    const el = () => ({ dataset: {} as Record<string, string>, title: '' });
    const els: Record<string, any[]> = { '#rot-l,#rot-r': [el(), el()], '#del': [el()], '#text-toggle': [el()], '#stylegroup': [el()], '#markgroup': [el()], '#formula-toggle': [el()] };
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const toasts: string[] = [];
    let caps: (v: any) => any = v => v;
    const win: any = { addEventListener: (n: string, f: any) => (listeners[n] ??= []).push(f), toast: (m: string) => toasts.push(m) };
    win.globalThis = win;
    win.document = { querySelectorAll: (sel: string) => els[sel] ?? [] };
    win.acquireVsCodeApi = () => ({ postMessage: async (m: any) => {
      const r = (await t.send(m.op, m.params)) as any;
      const value = m.op === 'get_capabilities' ? caps(r.value) : r.value;
      for (const f of listeners.message) f({ data: { type: 'res', id: m.id, value, error: r.error } });
    } });
    // Pretend the engine lost page.delete; the real worker still answers the math question (not available).
    caps = v => ({ ...v, edit_kinds: v.edit_kinds.filter((k: string) => k !== 'page.delete') });
    vm.runInNewContext(script, win);
    for (const f of listeners.DOMContentLoaded) await f({});
    await sleep(500);

    assert.match(els['#formula-toggle'][0].dataset.unsupported, /./, 'formula replacement is blocked');
    assert.equal(els['#formula-toggle'][0].title, els['#formula-toggle'][0].dataset.unsupported, 'and says why');
    assert.match(els['#del'][0].dataset.unsupported, /page\.delete/);
    for (const k of ['#rot-l,#rot-r', '#text-toggle', '#stylegroup', '#markgroup'])
      for (const e of els[k]) assert.equal(e.dataset.unsupported, undefined, `${k} stays enabled`);

    let stopped = false;
    const click = (target: any) => listeners.click[0]({ target, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    click({ closest: () => els['#del'][0] });
    assert.ok(stopped && toasts.length === 1, 'a click on a blocked control is swallowed and explained');
    stopped = false;
    click({ closest: () => null });
    assert.equal(stopped, false, 'other clicks pass through');
  } finally { fx.close(); }
});

test('edit, kill, restore cycles never accumulate recoveries: the restored record replaces the old one', { skip, timeout: 120000 }, async () => {
  const fx = await setup();
  try {
    const listed = async (t: { send(op: string, p?: any): Promise<any> }) => ((await t.send('list_recoveries')).value.recoveries) as any[];
    let t = await fx.open();
    await rotate(t);
    for (let cycle = 1; cycle <= 3; cycle++) {
      process.kill(fx.workers()[0], 'SIGKILL'); // the session dies with unsaved edits
      await sleep(300);
      fx.warnings.length = 0;
      t = await fx.open();
      await fx.settle(() => fx.warnings.length > 0);
      assert.match(fx.warnings[0].text, /^1 unsaved edit session\(s\) for original\.pdf/, `cycle ${cycle}: exactly one record is offered`);
      fx.pick('Restore unsaved edits');
      await fx.provider.notify(t.doc);
      assert.equal(((await t.send('get_state')).value).dirty, true, `cycle ${cycle}: restored`);
      assert.equal((await listed(t)).length, 0, 'the live session\'s own record is not listed, and the old one is gone');
      await rotate(t); // keep editing after the restore
    }
    fx.pick(undefined);
    process.kill(fx.workers()[0], 'SIGKILL');
    await sleep(300);
    const last = await fx.open();
    assert.equal((await listed(last)).length, 1, 'after the last kill exactly one record remains');
    assert.deepEqual(fx.errors, []);
  } finally { fx.close(); }
});

test('a tab VS Code reopens from its hot-exit backup is restored without a prompt', { skip, timeout: 90000 }, async () => {
  const fx = await setup();
  try {
    const first = await fx.open();
    await rotate(first);
    process.kill(fx.workers()[0], 'SIGKILL');
    await sleep(300);
    fx.warnings.length = 0;

    // Same as fx.open() but with the backupId VS Code passes when it reopens a dirty tab.
    const doc = await fx.provider.openCustomDocument(uri(fx.source), { backupId: 'vscode-custom-editor://x/backup' });
    const panel = { webview: { options: {}, cspSource: 'csp:', asWebviewUri: (u: any) => u, postMessage: async () => true, onDidReceiveMessage: () => ({ dispose() {} }), html: '' } };
    try {
      await fx.provider.resolveCustomEditor(doc, panel);
      assert.equal(((await doc.host.request('get_state', {})) as any).dirty, true, 'the edited state is back before the page loads');
      assert.equal(fx.warnings.length, 0, 'no second "Restore unsaved edits" prompt');
      assert.equal(((await doc.host.request('list_recoveries', {})) as any).recoveries.length, 0);

      // A backupId with no engine record (the live session's own record is not listed) is reported by name, not shown as clean.
      const bare = await fx.provider.openCustomDocument(uri(fx.source), { backupId: 'vscode-custom-editor://x/backup' });
      try {
        await fx.provider.resolveCustomEditor(bare, panel);
        await fx.settle(() => fx.warnings.length > 0);
        assert.match(fx.warnings[0].text, /no record of them/);
      } finally { bare.dispose(); }
    } finally { doc.dispose(); }
  } finally { fx.close(); }
});

// Dirty flags of every recovery record the engine left in the document's extension storage.
const recordDirty = (source: string): boolean[] => {
  const dir = join(dirname(source), 'store', 'pdf-recovery');
  const names = existsSync(dir) ? readdirSync(dir) : [];
  return names.flatMap(n => { try { return [JSON.parse(readFileSync(join(dir, n, 'manifest.json'), 'utf8')).dirty === true]; } catch { return []; } });
};

test("\"Don't Save\" (revert, then dispose) leaves no record to offer; a plain dispose (window quit) keeps it", { skip, timeout: 90000 }, async () => {
  const fx = await setup();
  const gone = async (pid: number) => fx.settle(() => !fx.workers().includes(pid));
  try {
    // VS Code's "Don't Save" calls revertCustomDocument and then disposes the document (observed in a packaged window).
    const discarded = await fx.open();
    await rotate(discarded);
    assert.deepEqual(recordDirty(fx.source), [true], 'the edit is recorded while open');
    const pid = fx.workers()[0];
    await fx.provider.revertCustomDocument(discarded.doc);
    discarded.doc.dispose();
    await gone(pid);
    assert.deepEqual(recordDirty(fx.source), [], 'the discarded edits leave no record');
    const again = await fx.open();
    await sleep(1500);
    assert.equal(fx.warnings.length, 0, 'no "Restore unsaved edits" offer after an explicit discard');
    assert.equal(((await again.send('get_state')).value).dirty, false);

    // Window quit / hot exit: VS Code backs the document up and disposes it without any revert. The edits must survive that.
    await rotate(again);
    const pid2 = fx.workers().find(p => p !== pid)!;
    again.doc.dispose();
    await gone(pid2);
    assert.deepEqual(recordDirty(fx.source), [true], 'dispose without revert keeps the dirty record');
    await fx.open();
    await fx.settle(() => fx.warnings.length > 0);
    assert.deepEqual(fx.warnings[0].items, ['Restore unsaved edits'], 'the edits are offered back after a quit');
  } finally { fx.close(); }
});

test('Save As clears the record: several edit-save cycles leave nothing dirty and nothing to offer', { skip, timeout: 90000 }, async () => {
  const fx = await setup();
  try {
    const t = await fx.open();
    const dir = dirname(fx.source);
    for (let i = 1; i <= 3; i++) {
      await rotate(t);
      assert.deepEqual(recordDirty(fx.source), [true], `cycle ${i}: dirty record while edited`);
      await fx.provider.saveCustomDocumentAs(t.doc, uri(join(dir, `saved${i}.pdf`)));
      assert.equal(((await t.send('get_state')).value).dirty, false, `cycle ${i}: clean after save`);
      assert.deepEqual(recordDirty(fx.source), [false], `cycle ${i}: the record is clean after save`);
    }
    const pid = fx.workers()[0];
    t.doc.dispose();
    await fx.settle(() => !fx.workers().includes(pid));
    assert.deepEqual(recordDirty(fx.source), [], 'closing a saved document leaves no record');
    await fx.open();
    await sleep(1500);
    assert.equal(fx.warnings.length, 0, 'no stale offer after saving');
  } finally { fx.close(); }
});
