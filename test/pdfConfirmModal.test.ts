import vscodeStub from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

// The webview sandbox has no allow-modals, so the viewer's confirm() always answers "no". The provider patches the
// served scripts to ask the host for a real modal instead. No worker needed: html() and the ui.confirm message only.

const stub = vscodeStub as any;
const uri = (path: string) => stub.Uri.file(path) as any;
const bundle = resolve(__dirname, '..', '..', 'media', 'pdf', 'web', 'static'); // compiled test lives in out-test/test
const skip = existsSync(join(bundle, 'viewer.js')) ? false : 'media/pdf bundle not built';

async function setup(staticSrc: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dfv-pdf-confirm-'));
  cpSync(staticSrc, join(dir, 'media', 'pdf', 'web', 'static'), { recursive: true });
  const context = { extensionPath: dir, extensionUri: uri(dir), globalStorageUri: uri(join(dir, 'store')), subscriptions: [] } as any;
  const asked: { text: string; opts: any; items: string[] }[] = [];
  let answer: (items: string[]) => string | undefined = () => undefined;
  const saved = { E: stub.EventEmitter, w: stub.window.showWarningMessage, r: stub.window.registerCustomEditorProvider };
  stub.EventEmitter = class { event = () => ({ dispose() {} }); fire() {} dispose() {} };
  stub.window.showWarningMessage = async (text: string, opts: any, ...items: string[]) => { asked.push({ text, opts, items }); return answer(items); };
  let provider: any;
  stub.window.registerCustomEditorProvider = (_t: string, p: unknown) => { provider = p; return { dispose() {} }; };
  const { PdfEditorProvider } = await import('../src/pdfEditorProvider');
  PdfEditorProvider.register(context);
  const posted: any[] = [];
  const webview = { cspSource: 'csp:', asWebviewUri: (u: any) => u, postMessage: async (m: unknown) => { posted.push(m); return true; } };
  return {
    provider, webview, asked, posted,
    answer: (f: typeof answer) => { answer = f; },
    close: () => { stub.EventEmitter = saved.E; stub.window.showWarningMessage = saved.w; stub.window.registerCustomEditorProvider = saved.r; rmSync(dir, { recursive: true, force: true }); },
  };
}

test('every confirm() call site in the shipped bundle is routed to the host', { skip }, async () => {
  const fx = await setup(bundle);
  try {
    const html: string = fx.provider.html(fx.webview);
    assert.doesNotMatch(html, /(?<![\w$.])confirm\s*\(/, 'no synchronous confirm() is left in the served page');
    assert.equal(html.match(/!await dfvConfirm\(/g)?.length, 6, 'page delete, annotation delete, 2x Export anyway, Restore session, Discard checkpoint');
    for (const label of ['Delete', 'Export anyway', 'Restore session', 'Discard']) assert.ok(html.includes(`dfvConfirm('${label}'`), label);
    assert.match(html, /<script nonce="[^"]+">[^]*dfvConfirm/, 'patched scripts are inlined under the CSP nonce');
    const inline = [...html.matchAll(/<script nonce="[^"]+">([^]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(inline.length >= 4);
    for (const code of inline) new vm.Script(code); // patched text must still parse (async arrow, await in async functions)
  } finally { fx.close(); }
});

test('a bundle whose confirm() sites changed refuses to open instead of losing the prompt', { skip }, async () => {
  const fx = await setup(bundle);
  const dir = mkdtempSync(join(tmpdir(), 'dfv-pdf-confirm-bad-'));
  try {
    const { patchedScript } = await import('../src/pdfEditorProvider');
    mkdirSync(dir, { recursive: true });
    const viewer = readFileSync(join(bundle, 'viewer.js'), 'utf8');
    writeFileSync(join(dir, 'viewer.js'), viewer.replace('!confirm(`Delete ${pages.length}', '!window.nothing(`Delete ${pages.length}'));
    assert.throws(() => patchedScript(dir, 'viewer.js'), /PDF viewer bundle changed/);
    writeFileSync(join(dir, 'viewer.js'), viewer);
    writeFileSync(join(dir, 'newfeature.js'), 'if (confirm("sure?")) go();');
    assert.throws(() => patchedScript(dir, 'newfeature.js'), /not in CONFIRM_PATCHES/);
    writeFileSync(join(dir, 'newfeature.js'), 'if (window.confirm("sure?")) go();');
    assert.throws(() => patchedScript(dir, 'newfeature.js'), /not in CONFIRM_PATCHES/);
    writeFileSync(join(dir, 'newfeature.js'), 'const x = confirmExport(y); obj.confirm(z);');
    assert.equal(patchedScript(dir, 'newfeature.js'), undefined);
    assert.equal(patchedScript(dir, 'missing.js'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); fx.close(); }
});

test('ui.confirm shows a host modal and only the action button answers yes', async () => {
  const fx = await setup(mkdtempSync(join(tmpdir(), 'dfv-empty-')));
  try {
    const ask = async (id: number, params: any) => {
      await fx.provider.onMessage({}, fx.webview, { type: 'req', id, op: 'ui.confirm', params });
      return fx.posted.filter(m => m.id === id).pop();
    };
    fx.answer(items => items[0]);
    assert.deepEqual(await ask(1, { label: 'Export anyway', message: 'Drafts are not included.' }), { type: 'res', id: 1, value: true });
    assert.deepEqual(fx.asked[0], { text: 'Drafts are not included.', opts: { modal: true }, items: ['Export anyway'] });
    fx.answer(() => undefined); // Cancel / Esc
    assert.equal((await ask(2, { label: 'Delete', message: 'Delete?' })).value, false);
    assert.equal((await ask(3, { label: 'Delete' })).value, false, 'a malformed request is a no');
    assert.equal(fx.asked.length, 2, 'and does not open a dialog');
    stub.window.showWarningMessage = async () => { throw new Error('boom'); };
    assert.equal((await ask(4, { label: 'Delete', message: 'x' })).value, false, 'a failing dialog is a no');
  } finally { fx.close(); }
});

test('the injected shim hides recoveries from the viewer only and carries confirms to the host', { skip }, async () => {
  const fx = await setup(bundle);
  try {
    const html: string = fx.provider.html(fx.webview);
    const shim = [...html.matchAll(/<script nonce="[^"]+">([^]*?)<\/script>/g)].map(m => m[1]).find(c => c.includes('acquireVsCodeApi'))!;
    const sent: any[] = [];
    const g: any = { acquireVsCodeApi: () => ({ postMessage: (m: any) => sent.push(m) }), addEventListener() {}, document: { querySelectorAll: () => [] },
      PDFStudioNativeTransport: { create: (channel: any) => channel } };
    g.globalThis = g;
    vm.runInNewContext(shim, g);
    const channel = g.PDFStudioHost.createTransport({});
    assert.equal(JSON.stringify(await channel.request('list_recoveries', {})), '{"recoveries":[]}', 'the viewer sees no recoveries, so it shows no banner');
    assert.equal(sent.length, 0, 'and the worker is not asked');
    void channel.request('get_state', {});
    assert.equal(sent[0].op, 'get_state', 'other operations still reach the host');
    void g.dfvConfirm('Delete', 'Delete?');
    assert.equal(JSON.stringify([sent[1].op, sent[1].params]), '["ui.confirm",{"label":"Delete","message":"Delete?"}]');
  } finally { fx.close(); }
});
