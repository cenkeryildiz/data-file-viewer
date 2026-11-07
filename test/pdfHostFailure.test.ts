import vscodeStub from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPdfHost, PdfHost } from '../src/pdfHost';

// Failure behaviour of the extension-side PDF host against the REAL dfv-pdf worker and a fake
// ExtensionContext. The binary comes from DFV_PDF_BIN; without it the suite is skipped, not faked.
// A killed or stopped worker is how a crash, an OOM kill and a hung engine look to the host.

const BIN = process.env.DFV_PDF_BIN;
const skip = !BIN || !existsSync(BIN) ? 'set DFV_PDF_BIN to the dfv-pdf binary' : false;

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const uri = (path: string) => vscodeStub.Uri.file(path) as any;

// A one-page PDF with a correct xref, so no fixture file is needed.
function tinyPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    undefined,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 18 Tf 20 100 Td (Failure test) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

interface Fixture { dir: string; source: string; sourceSha: string; store: string; context: any; hosts: PdfHost[]; open(): Promise<PdfHost>; close(): void }

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'dfv-pdf-failure-'));
  const ext = join(dir, 'ext');
  mkdirSync(join(ext, 'media', 'pdf', 'bin'), { recursive: true });
  symlinkSync(BIN!, join(ext, 'media', 'pdf', 'bin', 'dfv-pdf'));
  const store = join(dir, 'globalStorage');
  const source = join(dir, 'original.pdf');
  writeFileSync(source, tinyPdf());
  const context = { extensionPath: ext, extensionUri: uri(ext), globalStorageUri: uri(store), subscriptions: [] } as any;
  const hosts: PdfHost[] = [];
  return {
    dir, source, sourceSha: sha(source), store, context, hosts,
    open: async () => { const h = await createPdfHost(context, uri(source)); hosts.push(h); return h; },
    close: () => { for (const h of hosts) h.dispose(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Worker processes spawned by this test process. */
function workerPids(): number[] {
  try { return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); }
  catch { return []; }
}
const only = (pids: number[]) => { assert.equal(pids.length, 1, `expected one worker, found ${pids}`); return pids[0]; };

// Re-reads state afterwards: the host only learns the new revision from get_state (see the todo test).
const rotate = async (host: PdfHost) => {
  const s = await host.request('get_state', {}) as any;
  const done = await host.request('page.rotate', { pages: [0], degrees: 90, layout: s.layout }) as any;
  await host.request('get_state', {});
  return done;
};
const settled = <T>(p: Promise<T>) => p.then(value => ({ value }), (error: any) => ({ error }));
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} did not settle within ${ms} ms`); })]);
/** Files below `dir` other than `keep`, for "no partial output" checks. */
const strays = (dir: string, keep: string[]) => readdirSync(dir).filter(n => !keep.includes(n));

test('SIGKILL mid-session: honest error, original untouched, restart recovers the unsaved edit from extension storage', { skip, timeout: 60000 }, async () => {
  const fx = fixture();
  try {
    const host = await fx.open();
    await rotate(host);
    assert.equal(((await host.request('get_state', {})) as any).dirty, true);
    // No explicit backup call: the worker records an "edit" recovery under DFV_PDF_RECOVERY_ROOT itself.
    const before = await host.request('get_state', {}) as any;

    process.kill(only(workerPids()), 'SIGKILL');
    // The next request must not pretend: it names a stopped worker, never a stale success.
    const failed = (await settled(within(host.request('get_state', {}), 15000, 'request after kill'))) as any;
    assert.ok(failed.error, 'a request after SIGKILL must fail');
    assert.match(String(failed.error.code), /WORKER_/);
    assert.match(failed.error.message, /worker/i);
    // A write is refused too (never silently accepted by a dead worker).
    const write = (await settled(within(rotate(host), 15000, 'write after kill'))) as any;
    assert.ok(write.error, 'a write after SIGKILL must fail');

    // Restart: the host relaunches, then recovery from extension-owned storage works.
    const state = await within((async () => {
      for (let i = 0; i < 5; i++) {
        const s = await settled(host.request('get_state', {})) as any;
        if (s.value) return s.value;
        await sleep(200);
      }
      throw new Error('host never recovered');
    })(), 20000, 'restart');
    assert.equal(state.dirty, false, 'the restarted session is clean: unsaved edits are not silently kept');

    const listed = await host.request('list_recoveries', {}) as any;
    const record = listed.recoveries.find((r: any) => r.current_state_id === before.current_state_id);
    assert.ok(record, `edit not listed after restart: ${JSON.stringify(listed)}`);
    assert.ok(String(record.path).startsWith(fx.store), `backup must live in extension storage, not ${record.path}`);
    const restored = await host.request('restore_recovery', { backup_id: record.backup_id, revision: state.revision }) as any;
    assert.equal(restored.state.dirty, true);
    assert.equal(restored.state.can_undo, true, 'the edit is a real history step, not a flattened copy');

    // Export the recovered edit; it must differ from the original and be a PDF.
    const target = join(fx.dir, 'recovered.pdf');
    await host.exportTo(uri(target));
    assert.equal(readFileSync(target).subarray(0, 5).toString('latin1'), '%PDF-');
    assert.notEqual(sha(target), fx.sourceSha, 'the recovered export carries the edit');
    assert.match(readFileSync(target).toString('latin1'), /\/Rotate\s+90/);
    assert.equal(sha(fx.source), fx.sourceSha, 'original bytes unchanged');
  } finally { fx.close(); }
});

test('SIGKILL with a request in flight rejects it with WORKER_EXITED (not a hang, not a success)', { skip, timeout: 30000 }, async () => {
  const fx = fixture();
  try {
    const host = await fx.open();
    const pid = only(workerPids());
    process.kill(pid, 'SIGSTOP'); // the request is written but never answered
    const inflight = settled(host.request('get_state', {}));
    await sleep(100);
    process.kill(pid, 'SIGKILL');
    const r = await within(inflight, 10000, 'in-flight request') as any;
    assert.equal(r.error?.code, 'WORKER_EXITED');
    assert.match(r.error.message, /may or may not have been applied|stopped/i);
  } finally { fx.close(); }
});

// Host bug: `state` is refreshed only by get_state, so exportTo sends the pre-edit revision.
test('Save straight after an edit (no get_state in between) exports the edit', { skip, timeout: 30000 }, async () => {
  const fx = fixture();
  try {
    const host = await fx.open();
    const s = await host.request('get_state', {}) as any;
    await host.request('page.rotate', { pages: [0], degrees: 90, layout: s.layout });
    const target = join(fx.dir, 'now.pdf');
    await host.exportTo(uri(target));
    assert.match(readFileSync(target).toString('latin1'), /\/Rotate\s+90/);
  } finally { fx.close(); }
});

test('original PDF bytes are identical after edit, export, kill and restart', { skip, timeout: 60000 }, async () => {
  const fx = fixture();
  try {
    const host = await fx.open();
    await rotate(host);
    assert.equal(sha(fx.source), fx.sourceSha, 'after edit');
    await host.exportTo(uri(join(fx.dir, 'out.pdf')));
    assert.equal(sha(fx.source), fx.sourceSha, 'after export');
    // Exporting onto the original is refused outright.
    await assert.rejects(host.exportTo(uri(fx.source)), /never overwritten/);
    assert.equal(sha(fx.source), fx.sourceSha, 'after refused overwrite');
    process.kill(only(workerPids()), 'SIGKILL');
    await sleep(300);
    await settled(host.request('get_state', {}));
    assert.equal(sha(fx.source), fx.sourceSha, 'after kill and restart');
    assert.equal(strays(fx.dir, ['ext', 'globalStorage', 'original.pdf', 'out.pdf']).length, 0, 'nothing written beside the original');
  } finally { fx.close(); }
});

test('export interrupted by a worker kill leaves no target and no partial file', { skip, timeout: 30000 }, async () => {
  const fx = fixture();
  try {
    const host = await fx.open();
    await rotate(host);
    const pid = only(workerPids());
    process.kill(pid, 'SIGSTOP');
    const target = join(fx.dir, 'cancelled.pdf');
    const exporting = settled(host.exportTo(uri(target)));
    await sleep(100);
    process.kill(pid, 'SIGKILL');
    const r = await within(exporting, 10000, 'interrupted export') as any;
    assert.ok(r.error, 'an interrupted export must fail');
    assert.equal(existsSync(target), false, 'no target file');
    assert.deepEqual(strays(fx.dir, ['ext', 'globalStorage', 'original.pdf']), [], 'no temp or partial file beside the target');
    const work = join(fx.store, 'pdf-work');
    assert.deepEqual(readdirSync(work).filter(n => n.startsWith('export-')), [], 'staging copy removed');
    assert.equal(sha(fx.source), fx.sourceSha);
  } finally { fx.close(); }
});

test('export to an unwritable target fails cleanly with no partial file', { skip, timeout: 30000 }, async () => {
  const fx = fixture();
  try {
    const host = await fx.open();
    await rotate(host);
    await assert.rejects(host.exportTo(uri(join(fx.dir, 'missing-dir', 'out.pdf'))));
    assert.deepEqual(strays(fx.dir, ['ext', 'globalStorage', 'original.pdf']), []);
    assert.deepEqual(readdirSync(join(fx.store, 'pdf-work')).filter(n => n.startsWith('export-')), []);
    // The host is still usable afterwards.
    await host.exportTo(uri(join(fx.dir, 'ok.pdf')));
    assert.equal(readFileSync(join(fx.dir, 'ok.pdf')).subarray(0, 5).toString('latin1'), '%PDF-');
  } finally { fx.close(); }
});

test('Save As cancelled in the dialog writes nothing and keeps the original', { skip, timeout: 30000 }, async () => {
  const fx = fixture();
  const stub = vscodeStub as any;
  const saved = { dialog: stub.window.showSaveDialog, register: stub.window.registerCustomEditorProvider };
  try {
    stub.EventEmitter = class { event = () => ({ dispose() {} }); fire() {} dispose() {} };
    // Imported only now: `import * as vscode` copies the module's members when first loaded.
    const { PdfEditorProvider } = await import('../src/pdfEditorProvider');
    stub.window.showSaveDialog = async () => undefined; // the user pressed Cancel
    let provider: any;
    stub.window.registerCustomEditorProvider = (_t: string, p: unknown) => { provider = p; return { dispose() {} }; };
    PdfEditorProvider.register(fx.context);
    const doc = await provider.openCustomDocument(uri(fx.source));
    try {
      await rotate(doc.host);
      await assert.rejects(provider.saveCustomDocument(doc), (e: any) => e instanceof stub.CancellationError);
      assert.equal((await doc.host.request('get_state', {})).dirty, true, 'cancellation keeps the edit unsaved');
      assert.deepEqual(strays(fx.dir, ['ext', 'globalStorage', 'original.pdf']), []);
      assert.equal(sha(fx.source), fx.sourceSha);
    } finally { doc.dispose(); }
  } finally {
    stub.window.showSaveDialog = saved.dialog; stub.window.registerCustomEditorProvider = saved.register;
    fx.close();
  }
});

test('dispose with a request in flight settles the request and ends the worker (healthy worker)', { skip, timeout: 30000 }, async () => {
  const fx = fixture();
  try {
    const host = await fx.open();
    const pid = only(workerPids());
    const inflight = settled(host.request('render_page', { page: 0, scale: 2 }));
    host.dispose();
    await within(inflight, 10000, 'in-flight request after dispose');
    const gone = async () => { for (let i = 0; i < 50 && workerPids().includes(pid); i++) await sleep(100); return !workerPids().includes(pid); };
    assert.ok(await gone(), 'worker process exited after dispose');
    // Later calls fail fast with a clear error rather than hanging.
    const late = await within(settled(host.request('get_state', {})), 2000, 'request after dispose') as any;
    assert.equal(late.error?.code, 'SESSION_CLOSED');
    host.dispose(); // idempotent
  } finally { fx.close(); }
});

test('dispose with a request in flight on an unresponsive worker settles within the kill grace period', { skip, timeout: 30000 }, async () => {
  const fx = fixture();
  try {
    const host = await fx.open();
    const pid = only(workerPids());
    process.kill(pid, 'SIGSTOP');
    const inflight = settled(host.request('get_state', {}));
    await sleep(100);
    host.dispose();
    const r = await within(inflight, 12000, 'in-flight request after dispose of a hung worker') as any;
    assert.ok(r.error, 'the pending request fails');
    for (let i = 0; i < 30 && workerPids().includes(pid); i++) await sleep(100);
    assert.equal(workerPids().includes(pid), false, 'hung worker was killed');
  } finally { fx.close(); }
});
