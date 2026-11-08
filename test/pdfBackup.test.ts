import vscodeStub from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// backupCustomDocument (VS Code hot exit) of PdfEditorProvider against the REAL dfv-pdf worker and a fake vscode.
// The backup is the worker's own recovery record; these tests pin that it is real: it survives the worker being killed,
// the existing restore offer returns the edit, and a document the engine could not record is refused, not "backed up".
// Without DFV_PDF_BIN the real-worker test is skipped.

const BIN = process.env.DFV_PDF_BIN;
const skip = !BIN || !existsSync(BIN) ? 'set DFV_PDF_BIN to the dfv-pdf binary' : false;
const stub = vscodeStub as any;
const uri = (path: string) => stub.Uri.file(path) as any;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function tinyPdf(): Buffer {
  const stream = 'BT /F1 18 Tf 20 100 Td (Backup) Tj ET';
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

/** Provider with a fake panel. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dfv-pdf-backup-'));
  const ext = join(dir, 'ext');
  mkdirSync(join(ext, 'media', 'pdf', 'bin'), { recursive: true });
  mkdirSync(join(ext, 'media', 'pdf', 'web', 'static'), { recursive: true });
  writeFileSync(join(ext, 'media', 'pdf', 'web', 'static', 'index.html'), '<html><head></head><body><script src="/static/editorTransport.js"></script></body></html>');
  if (BIN) symlinkSync(BIN, join(ext, 'media', 'pdf', 'bin', 'dfv-pdf'));
  const source = join(dir, 'original.pdf');
  writeFileSync(source, tinyPdf());
  const context = { extensionPath: ext, extensionUri: uri(ext), globalStorageUri: uri(join(dir, 'store')), subscriptions: [] } as any;

  const warnings: { text: string; items: string[] }[] = [];
  const saved = { E: stub.EventEmitter, w: stub.window.showWarningMessage, r: stub.window.registerCustomEditorProvider };
  stub.EventEmitter = class { event = () => ({ dispose() {} }); fire() {} dispose() {} };
  stub.window.showWarningMessage = async (text: string, ...items: string[]) => { warnings.push({ text, items }); return items[0]; }; // the user accepts every offer
  let provider: any;
  stub.window.registerCustomEditorProvider = (_t: string, p: unknown) => { provider = p; return { dispose() {} }; };
  const { PdfEditorProvider } = await import('../src/pdfEditorProvider');
  PdfEditorProvider.register(context);

  const docs: any[] = [];
  const open = async () => {
    const doc = await provider.openCustomDocument(uri(source));
    docs.push(doc);
    let handler: (m: any) => Promise<void> = async () => {};
    const posted: any[] = [];
    const panel = { webview: { options: {}, cspSource: 'csp:', asWebviewUri: (u: any) => u, postMessage: async (m: unknown) => { posted.push(m); return true; },
      onDidReceiveMessage: (f: any) => { handler = f; return { dispose() {} }; }, html: '' } };
    await provider.resolveCustomEditor(doc, panel);
    let id = 0;
    const send = async (op: string, params: any = {}) => { const mine = ++id; await handler({ type: 'req', id: mine, op, params }); return posted.filter(m => m.type === 'res' && m.id === mine).pop(); };
    return { doc, send };
  };
  const workers = () => { try { return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
  return {
    provider, open, warnings, workers, source,
    close: () => {
      for (const d of docs) d.dispose();
      stub.EventEmitter = saved.E; stub.window.showWarningMessage = saved.w; stub.window.registerCustomEditorProvider = saved.r;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ctx = { destination: uri('/tmp/backup-destination') } as any;

test('backup of a dirty document is the recovery record: it survives the kill and the restart offer restores it', { skip, timeout: 90000 }, async () => {
  const fx = await setup();
  const before = sha(fx.source);
  try {
    const t = await fx.open();
    const clean = await fx.provider.backupCustomDocument(t.doc, ctx);
    assert.equal(clean.id, ctx.destination.toString());
    const s = (await t.send('get_state')).value;
    assert.ok(!(await t.send('page.rotate', { pages: [0], degrees: 90, layout: s.layout })).error);
    assert.equal((await t.send('get_state')).value.dirty, true);

    const backup = await fx.provider.backupCustomDocument(t.doc, ctx);
    assert.equal(backup.id, ctx.destination.toString());
    backup.delete(); // VS Code deletes superseded backups; the record must outlive that
    process.kill(fx.workers()[0], 'SIGKILL'); // VS Code killed: the worker dies with the edit unsaved
    await sleep(300);

    const t2 = await fx.open(); // the reopened document offers (and, accepted here, restores) the edit
    for (let i = 0; i < 100 && !fx.warnings.length; i++) await sleep(100);
    assert.equal(fx.warnings.length, 1);
    assert.match(fx.warnings[0].text, /unsaved edit session\(s\) for original\.pdf can be restored/);
    // Recovery restores asynchronously; a read can still be refused during adoption.
    for (let i = 0; i < 100 && !(await t2.send('get_state')).value?.dirty; i++) await sleep(100);
    const state = (await t2.send('get_state')).value;
    assert.ok(state, 'recovery must settle to a readable state');
    assert.equal(state.dirty, true, 'the unsaved edit is back');
    assert.equal(state.can_undo, true);
    assert.equal(sha(fx.source), before, 'original bytes unchanged');
  } finally { fx.close(); }
});

test('backup refuses a dirty document the engine could not record, and ignores a clean one', async () => {
  const fx = await setup();
  const provider = fx.provider;
  const doc = (state: unknown) => ({ host: { request: async () => state } }) as any;
  try {
    await assert.rejects(provider.backupCustomDocument(doc({ dirty: true, recovery: 'failed' }), ctx), /could not record the unsaved edits.*failed/);
    await assert.rejects(provider.backupCustomDocument(doc({ dirty: true }), ctx), /unknown/);
    assert.equal((await provider.backupCustomDocument(doc({ dirty: true, recovery: 'ok' }), ctx)).id, ctx.destination.toString());
    assert.equal((await provider.backupCustomDocument(doc({ dirty: false, recovery: 'failed' }), ctx)).id, ctx.destination.toString());
  } finally { fx.close(); }
});
