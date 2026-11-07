// Extension-side host for the Rust PDF worker (dfv-pdf, stdio protocol). No PDF processing here.
// Ported from the bundle's ui/nativeHost.mjs + ui/launch.mjs + tests/worker_host/host.mjs, minus HTTP/Chrome.
import type * as vscode from 'vscode';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceDrafts } from './sourceDrafts';
import { spawnWorker, WorkerCapacityError } from './native/supervisor';

export interface PdfHost {
  request(method: string, params: unknown): Promise<unknown>;
  exportTo(target: vscode.Uri): Promise<void>;
  dispose(): void;
}

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 65; // Native scheduler: 64 queued plus one active request.
const CONTROL_SLOTS = 4;
const READ_WATCHDOG_MS = 30000 + 5000;
const EDITS = new Set(['annot.note', 'annot.mark', 'annot.update', 'annot.delete', 'page.rotate', 'page.delete', 'page.reorder', 'text.replace', 'text.style', 'text.reflow', 'list.remove_marker']);
const MUTATIONS = new Set(['apply_edit', 'commit_edit', 'undo', 'redo', 'revert_to_saved', 'export_verified', 'create_backup']);
const READS = new Set(['get_capabilities', 'get_state', 'get_document_info', 'get_navigation', 'get_page_links', 'get_page_text', 'get_page_lines', 'search_page', 'list_annotations', 'get_font', 'render_page', 'start_search', 'read_search', 'cancel_search', 'cancel_edit', 'prepare_edit', 'probe_text', 'get_block', 'analyze_formula', 'prepare_formula', 'mark_saved', 'list_recoveries', ...MUTATIONS]);
const CONTROLS = new Set(['cancel_request', 'cancel_search', 'cancel_edit', 'release_resource', 'close_document', 'shutdown']);
const UNTIMED = new Set([...MUTATIONS, 'mark_saved', 'open_document', 'restore_backup', 'close_document', 'delete_backup', 'shutdown']);
const STATUSES: Record<string, number> = { SESSION_CLOSED: 409, STALE_REVISION: 409, STALE_GEOMETRY: 409, CANCELLED: 409, REFUSED: 422, INTEGRITY_FAILED: 422, HISTORY_LIMIT: 422, RECOVERY_FAILED: 500, PROTOCOL_ERROR: 400, NOT_FOUND: 404, INVALID_ARGUMENT: 400, UNAVAILABLE: 503, VERSION_GONE: 410, RESOURCE_LIMIT: 413, TIMEOUT: 504 };

type Err = Error & { code?: string; reason?: string; status?: number; details?: any; engineCode?: string };
const hostError = (code: string, message: string, extra: object = {}): Err => Object.assign(new Error(message), { code, reason: code.toLowerCase(), ...extra });
// An error the worker or host answered with is a refusal the viewer can show verbatim (it reads body.detail);
// only WORKER_EXITED means no answer arrived, which the viewer rightly reports as a lost connection.
const asRefusal = (e: any): Err => {
  if (!(e instanceof Error)) e = hostError('INTERNAL_ERROR', String(e), { status: 500 });
  if (e.refused !== undefined || e.code === 'WORKER_EXITED') return e;
  e.status ??= STATUSES[e.engineCode ?? e.code] ?? 500;
  return Object.assign(e, { refused: true, body: { detail: e.message, code: e.code, reason: e.reason, details: e.details } });
};
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Newline-delimited JSON frames on the child's stdio; one live child per instance. */
class Worker extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Err): void; method: string; release(): void; timer?: NodeJS.Timeout }>();
  private reserved = 0;
  private pendingBytes = 0;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private readonly exited: Promise<void>;
  stderr = '';
  alive = true;
  constructor(private child: ChildProcess) {
    super();
    this.exited = new Promise(resolve => {
      child.once('exit', () => resolve());
      child.once('error', () => { if (child.pid === undefined) resolve(); });
    });
    child.stdout!.on('data', c => this.onData(c));
    child.stderr!.on('data', c => { this.stderr = (this.stderr + c.toString('utf8')).slice(-4000); });
    child.on('exit', (code, signal) => this.gone(`exit ${code ?? signal}`));
    child.on('error', e => this.gone(e.message));
    child.stdin!.on('error', () => { /* surfaced through the exit path */ });
  }
  private gone(why: string) {
    if (!this.alive) return;
    this.alive = false;
    for (const { reject, method, release, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      release();
      // Not proof that a mutation did not happen; never resubmitted automatically.
      reject(hostError('WORKER_EXITED', `The PDF worker stopped during ${method} (${why}). The operation may or may not have been applied.`));
    }
    this.pending.clear();
    this.chunks = []; this.buffered = 0;
    this.emit('exit', why);
  }
  private fail(why: string) { this.gone(why); this.child.kill('SIGKILL'); }
  private reserve(bytes: number, control = false): () => void {
    if (!this.alive) throw hostError('WORKER_EXITED', 'The PDF worker is not running.');
    if (bytes - 1 > MAX_FRAME_BYTES || this.reserved >= MAX_PENDING_REQUESTS - (control ? 0 : CONTROL_SLOTS)
      || this.pendingBytes + bytes > MAX_RESOURCE_BYTES - (control ? 0 : MAX_FRAME_BYTES))
      throw hostError('RESOURCE_LIMIT', 'The PDF request exceeds the frame or pending-request budget. Wait for pending work to finish.', { status: 413 });
    this.reserved++; this.pendingBytes += bytes;
    let held = true;
    return () => { if (held) { held = false; this.reserved--; this.pendingBytes -= bytes; } };
  }
  reserveQueued(op: string, params: unknown) {
    return this.reserve(Buffer.byteLength(JSON.stringify({ op, params }), 'utf8') + 1);
  }
  private refreshReadTimers() {
    // A read queued behind a mutation cannot establish a safe mutation execution deadline.
    const mutationPending = [...this.pending.values()].some(p => UNTIMED.has(p.method));
    for (const p of this.pending.values()) {
      if (mutationPending || UNTIMED.has(p.method)) { if (p.timer) clearTimeout(p.timer); p.timer = undefined; }
      else if (!p.timer) p.timer = setTimeout(() => this.fail(`read/control ${p.method} exceeded its 30-second deadline plus 5-second host grace`), READ_WATCHDOG_MS);
    }
  }
  private onData(chunk: Buffer) {
    if (!this.alive) return;
    let rest = chunk;
    while (rest.length) {
      const nl = rest.indexOf(0x0a), piece = nl < 0 ? rest : rest.subarray(0, nl);
      if (this.buffered + piece.length > MAX_FRAME_BYTES) { this.fail('a PDF response exceeded the 8 MiB frame limit'); return; }
      this.chunks.push(piece); this.buffered += piece.length;
      if (nl < 0) break;
      const line = Buffer.concat(this.chunks, this.buffered);
      this.chunks = []; this.buffered = 0;
      rest = rest.subarray(nl + 1);
      let frame: any;
      try { frame = JSON.parse(line.toString('utf8')); } catch { this.fail('the PDF worker sent malformed JSON'); return; }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.protocol_version !== PROTOCOL_VERSION) { this.fail('the PDF worker sent an invalid protocol frame'); return; }
      if ('event' in frame) { this.emit('event', frame); continue; }
      const waiter = this.pending.get(frame.request_id);
      if (!waiter || frame.error?.details?.duplicate) continue;
      this.pending.delete(frame.request_id);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.release();
      this.refreshReadTimers();
      if (frame.error) {
        const e = frame.error;
        waiter.reject(Object.assign(new Error(e.message), { code: e.code, reason: e.reason, details: e.details || {}, engineCode: e.code }));
      } else waiter.resolve(frame.result);
    }
  }
  request(method: string, o: { sessionId?: string; expectedRevision?: number; params?: unknown } = {}): Promise<any> {
    if (!this.alive) return Promise.reject(hostError('WORKER_EXITED', 'The PDF worker is not running.'));
    const id = this.nextId++;
    const frame: any = { protocol_version: PROTOCOL_VERSION, request_id: id, method };
    if (o.sessionId !== undefined) frame.session_id = o.sessionId;
    if (o.expectedRevision !== undefined) frame.expected_revision = o.expectedRevision;
    if (o.params !== undefined) frame.params = o.params;
    const json = JSON.stringify(frame);
    let release: () => void;
    try { release = this.reserve(Buffer.byteLength(json, 'utf8') + 1, CONTROLS.has(method)); }
    catch (error) { return Promise.reject(error); }
    const data = Buffer.from(json + '\n', 'utf8');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, release });
      this.refreshReadTimers();
      try { this.child.stdin!.write(data); } catch { this.fail(`the request pipe failed during ${method}`); }
    });
  }
  async readResource(sessionId: string, resource: any): Promise<Buffer> {
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const r = await this.request('read_resource', { sessionId, params: { handle: resource.handle, offset } });
      if (!r || r.handle !== resource.handle || r.offset !== offset || r.total !== resource.length || r.mime !== resource.mime
        || !Number.isSafeInteger(r.length) || r.length < 0 || r.length > resource.length - offset || typeof r.eof !== 'boolean'
        || r.eof !== (offset + r.length === resource.length) || (!r.eof && r.length === 0)
        || typeof r.data !== 'string' || r.data.length !== Math.ceil(r.length / 3) * 4)
        throw hostError('PROTOCOL_ERROR', 'The PDF worker returned an invalid or non-progressing resource chunk.');
      const piece = Buffer.from(r.data, 'base64');
      if (piece.length !== r.length || piece.toString('base64') !== r.data) throw hostError('PROTOCOL_ERROR', 'The PDF resource chunk has invalid base64 bytes.');
      parts.push(piece);
      offset += r.length;
      if (r.eof) break;
    }
    const out = Buffer.concat(parts);
    if (out.length !== resource.length) throw hostError('PROTOCOL_ERROR', `Resource read ${out.length} of ${resource.length} bytes.`);
    return out;
  }
  stop(): Promise<void> {
    if (!this.alive) return this.exited;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000);
      this.once('exit', () => { clearTimeout(timer); resolve(); });
      this.child.stdin!.end();
    });
  }
}

export async function createPdfHost(context: vscode.ExtensionContext, sourceUri: vscode.Uri): Promise<PdfHost> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The PDF editor currently supports macOS on Apple silicon (arm64) only.');
  const executable = path.join(context.extensionPath, 'media', 'pdf', 'bin', 'dfv-pdf');
  const source = sourceUri.fsPath;
  // Everything the host writes lives here, never beside the original.
  const store = context.globalStorageUri.fsPath;
  const dirs = { recovery: path.join(store, 'pdf-recovery'), work: path.join(store, 'pdf-work'), drafts: path.join(store, 'pdf-drafts') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(executable)) throw hostError('UNAVAILABLE', `The PDF engine is missing from this extension build (${executable}).`, { status: 503 });
  try { fs.accessSync(source, fs.constants.R_OK); } catch { throw hostError('NOT_FOUND', `Cannot read ${source}.`, { status: 404 }); }

  let worker!: Worker;
  let state: any;
  let disposed = false;
  let needsRestart = false;
  let ownMutations = 0;

  const launch = async () => {
    let child: ChildProcess;
    try {
      child = spawnWorker('pdf', executable, ['--stdio'], {
        cwd: dirs.work,
        env: { ...process.env, PATH: '/nonexistent-no-python', TMPDIR: dirs.work, DFV_PDF_RECOVERY_ROOT: dirs.recovery },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (error instanceof WorkerCapacityError) throw hostError('RESOURCE_LIMIT', error.message, { status: 413 });
      throw error;
    }
    const w = new Worker(child);
    w.on('exit', () => { if (!disposed && worker === w) needsRestart = true; });
    w.on('event', (e: any) => { if (e.session_id === state?.session_id && e.state && !ownMutations) state = e.state; });
    worker = w;
    try { state = await w.request('open_document', { params: { source_path: source } }); }
    catch (e) { void w.stop(); throw failure(e as Err); }
  };
  await launch();

  function failure(error: Err): Err {
    if (!error.code || error.code === 'WORKER_EXITED' || error.status) return error;
    const reason = error.reason || 'internal_error';
    return Object.assign(new Error(error.message), { code: reason, reason, engineCode: error.code, status: STATUSES[error.code] ?? 500, details: error.details });
  }

  // Restart is lazy and explicit: the caller is told once that in-memory edits are gone.
  let restarting: Promise<void> | undefined;
  const recover = () => restarting ??= (async () => {
    try { await worker.stop(); await launch(); needsRestart = false; } finally { restarting = undefined; }
  })();

  let writes: Promise<unknown> = Promise.resolve();
  function request(op: string, params: unknown = {}): Promise<unknown> {
    if (disposed) return Promise.reject(hostError('SESSION_CLOSED', 'The PDF host is closed.', { status: 409 }));
    const p = (params ?? {}) as Record<string, any>;
    if (!EDITS.has(op) && !MUTATIONS.has(op) && op !== 'restore_recovery' && op !== 'mark_saved') return dispatch(op, p);
    if (needsRestart) return dispatch(op, p);
    let release: () => void;
    try { release = worker.reserveQueued(op, p); }
    catch (error) { return Promise.reject(failure(error as Err)); }
    const sessionId = state.session_id;
    const result = writes.then(() => {
      release();
      if (state.session_id !== sessionId) throw failure(hostError('STALE_REVISION', 'The document session changed before this request was sent.', { reason: 'stale_session' }));
      return dispatch(op, p);
    }).finally(release);
    writes = result.catch(() => { });
    return result;
  }

  async function dispatch(op: string, params: Record<string, any>): Promise<any> {
    if (needsRestart) {
      try { await recover(); } catch (e) { throw hostError('WORKER_UNAVAILABLE', `The PDF worker could not be restarted: ${(e as Error).message}`, { status: 503 }); }
      throw hostError('WORKER_RESTARTED', 'The PDF worker stopped and was restarted. The document was reopened from the original file; edits not exported or backed up are lost. Check recovered sessions before continuing.', { status: 503 });
    }
    if (['list_drafts', 'checkpoint_draft', 'discard_draft'].includes(op)) {
      const info = await request('get_document_info') as any;
      if (op !== 'list_drafts' && params.doc !== info.doc) throw failure(hostError('STALE_REVISION', 'This draft belongs to another document session.', { reason: 'stale_draft' }));
      try {
        const store = new SourceDrafts(dirs.drafts, info.path);
        if (op === 'list_drafts') return store.list(info.source_digest);
        if (op === 'discard_draft') return store.discard(params.id, params.generation);
        return store.put(params.draft, { source_digest: info.source_digest, verified_digest: info.verified_digest, verified_length: info.verified_length, revision: info.revision, doc: info.doc, matches_draft_revision: params.draft?.base_revision === info.revision });
      } catch { throw failure(hostError('UNAVAILABLE', 'Draft recovery could not be confirmed. Keep the editor open and copy your source before closing.', { reason: 'draft_recovery_unavailable' })); }
    }
    if (op === 'restore_recovery') {
      const current = await request('get_state') as any;
      if (current.revision !== params.revision || current.dirty) throw failure(hostError('STALE_REVISION', 'Export current changes before restoring another session.', { reason: 'stale_state' }));
      const records = await request('list_recoveries') as any;
      const record = records.recoveries.find((r: any) => r.backup_id === params.backup_id);
      if (!record) throw failure(hostError('NOT_FOUND', 'This recovery is no longer available.', { reason: 'not_found' }));
      const previous = state.session_id;
      ownMutations++;
      let restored: any;
      try {
        restored = await worker.request('restore_backup', { params: { backup_path: record.path } });
        // Keep the previous session until its replacement has reopened.
        await worker.request('close_document', { sessionId: previous });
        state = restored.state;
        // The restored session has written its own record; the old one would be offered again as a second session.
        // Only dropped once the new record is confirmed, so a failed checkpoint never leaves the edits with no record at all.
        if (restored.state.recovery === 'ok') await worker.request('delete_backup', { params: { backup_id: params.backup_id } }).catch(() => { });
        return restored;
      } catch (e) {
        if (restored) {
          try { await worker.request('close_document', { sessionId: restored.state.session_id, params: { disposition: 'discard' } }); }
          catch (c) { throw failure(hostError('RECOVERY_FAILED', 'Recovery was not switched and its extra session could not be closed.', { reason: 'recovery_cleanup_failed', details: { previous_session_id: previous, restored_session_id: restored.state.session_id, close_error: (e as Error).message, cleanup_error: (c as Error).message } })); }
        }
        throw failure(e as Err);
      } finally { ownMutations--; }
    }
    let method = op, args: Record<string, any> = { ...params };
    if (op === 'get_math_capabilities') return { available: false, reason: 'Native formula editing is not implemented.' };
    if (op === 'get_block') { method = 'read_block'; args.page_no = args.page; delete args.page; args.block_id = args.block; delete args.block; }
    if (EDITS.has(op)) {
      // The viewer's `kind` is the mark type (Highlight/Underline/StrikeOut) and belongs in the engine's `mark`;
      // the command's own `kind` is the edit kind. Both revision spellings are frame fields, not command fields.
      const { revision, expected_revision, kind, ...command } = args;
      if (op === 'annot.mark' && kind !== undefined) command.mark = kind;
      method = 'apply_edit'; args = { command: { ...command, kind: op } };
    }
    else if (!READS.has(op)) throw failure(hostError('UNAVAILABLE', `The native host does not implement ${op}.`, { reason: 'not_implemented' }));
    if (['render_page', 'get_page_text', 'get_page_lines', 'search_page', 'get_page_links'].includes(method) && 'page' in args) { args.page_no = args.page; delete args.page; }
    if ('v' in args) { args.version = args.v; delete args.v; }
    if (method === 'export_verified') { delete args.defer_saved; if ('path' in args) { args.destination = args.path; delete args.path; } }
    if (method === 'list_recoveries') args.sweep = false;
    const expectedRevision = params.revision ?? (EDITS.has(op) ? params.expected_revision : undefined) ?? state.revision;
    if (method !== 'start_search') delete args.revision;
    else if ('revision' in args) { args.expected_revision = args.revision; delete args.revision; }
    const mutation = MUTATIONS.has(method);
    const sessionId = method === 'get_capabilities' || method === 'list_recoveries' ? undefined : state.session_id;
    const w = worker;
    if (mutation) ownMutations++;
    try {
      const result = await w.request(method, { sessionId, params: args, ...(MUTATIONS.has(method) ? { expectedRevision } : {}) });
      let value = result;
      if (result?.resource) {
        const r = result.resource;
        if (!Number.isSafeInteger(r.length) || r.length < 0 || r.length > MAX_RESOURCE_BYTES) {
          await w.request('release_resource', { sessionId, params: { handle: r.handle } });
          throw failure(hostError('RESOURCE_LIMIT', 'The native resource exceeds the host byte limit.', { reason: 'host_resource_limit' }));
        }
        let bytes: Buffer;
        try { bytes = await w.readResource(sessionId!, r); }
        finally { await w.request('release_resource', { sessionId, params: { handle: r.handle } }).catch(() => { }); }
        value = r.mime === 'application/json' ? JSON.parse(bytes.toString('utf8')) : { mime: r.mime, base64: bytes.toString('base64'), length: bytes.length };
      }
      if (method === 'get_state' && state.session_id === sessionId) state = value;
      // own mutations suppress worker events, so re-read the revision or the next edit/Save sends a stale one
      if (mutation && sessionId && state.session_id === sessionId) state = await w.request('get_state', { sessionId, params: {} });
      if (method === 'list_recoveries') {
        const info = await request('get_document_info') as any;
        value = { ...value, recoveries: value.recoveries.filter((r: any) => r.source_path === info.path) };
      }
      return value;
    } catch (e) { throw failure(e as Err); }
    finally { if (mutation) ownMutations--; }
  }

  // Save As: the worker writes a verified copy into extension storage, the host re-verifies it
  // against the receipt, copies it to the target, reads the target back and acknowledges the receipt (mark_saved). The original is never written.
  async function exportTo(target: vscode.Uri): Promise<void> {
    if (target.scheme === 'file' && path.resolve(target.fsPath) === path.resolve(source)) throw hostError('REFUSED', 'Export to a different file; the original PDF is never overwritten.', { status: 422 });
    const staging = path.join(dirs.work, `export-${crypto.randomUUID()}.pdf`);
    try {
      const result = await request('export_verified', { path: staging, revision: state.revision }) as any;
      const bytes = fs.readFileSync(staging);
      const receipt = result?.receipt;
      if (!receipt || bytes.length !== receipt.length || sha256(bytes) !== receipt.digest || bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
        throw hostError('INTEGRITY_FAILED', 'The exported copy did not match the worker receipt; nothing was written to the target.', { status: 422 });
      let back: Buffer;
      if (target.scheme === 'file') {
        const temp = path.join(path.dirname(target.fsPath), `.${path.basename(target.fsPath)}.${crypto.randomUUID()}.tmp`);
        try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, target.fsPath); } finally { fs.rmSync(temp, { force: true }); }
        back = fs.readFileSync(target.fsPath);
      } else {
        const vs = require('vscode') as typeof vscode;
        await vs.workspace.fs.writeFile(target, bytes);
        back = Buffer.from(await vs.workspace.fs.readFile(target));
      }
      if (!back.equals(bytes)) throw hostError('INTEGRITY_FAILED', 'The saved copy differs from the verified export. Try another location.', { status: 422 });
      await request('mark_saved', { receipt }); // the worker only accepts the receipt of the export it just made
    } finally { fs.rmSync(staging, { force: true }); }
  }

  return {
    request: (m, p) => request(m, p).catch(e => { throw asRefusal(e); }),
    exportTo: t => exportTo(t).catch(e => { throw asRefusal(e); }),
    dispose() { if (disposed) return; disposed = true; void worker.stop(); },
  };
}
