// Process and framing layer for native table/MAT workers (--stdio, protocol v1, NDJSON).
// No table logic and no vscode import: it spawns, frames, correlates ids, enforces deadlines and settles
// every pending call exactly once. Modelled on pdfHost.ts's Worker. Draft until D1.7/D1.9 are accepted.
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { spawnWorker, WorkerCapacityError } from '../native/supervisor';

export const PROTOCOL = 'dfv-table';
export const VERSION = 1;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const UNADDRESSED_ID = '0';

/** Failures that come from this client, not from the worker's own answer. */
export type HostCode = 'worker_exited' | 'worker_timeout' | 'protocol_violation' | 'frame_too_large' | 'client_closed' | 'queue_full' | 'resource_limit' | 'unknown_method';
export type MutationOutcome = 'not-published' | 'published' | 'unknown';

export class NativeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly o: { category?: string; retryable?: boolean; mutationOutcome?: MutationOutcome | null; host?: boolean } = {},
  ) {
    super(message);
    this.name = 'NativeError';
  }
  get category() { return this.o.category ?? 'unknown'; }
  /** The worker's own hint; this client never retries on it. */
  get retryable() { return this.o.retryable ?? false; }
  /** What is on disk after a write: null for reads. 'unknown' = the caller must look; never resubmit blindly. */
  get mutationOutcome() { return this.o.mutationOutcome ?? null; }
  /** True when no answer from the worker arrived (it died, hung or broke the protocol). */
  get host() { return this.o.host === true; }
}

/** A write whose result cannot be known: surfaced as its own outcome, never retried automatically. */
export const isUnconfirmed = (e: unknown): e is NativeError => e instanceof NativeError && e.mutationOutcome === 'unknown';

const hostError = (code: HostCode, message: string, mutation: boolean, retryable = false, sent = true) =>
  new NativeError(code, message, { host: true, retryable, category: code === 'queue_full' || code === 'resource_limit' ? 'resource' : 'unknown', mutationOutcome: mutation ? (sent ? 'unknown' : 'not-published') : null });

export interface WorkerCapabilities {
  engine: { name: string; version: string };
  methods: string[];
  formats: unknown[];
  value_tags: string[];
  time_units: string[];
  limits: { max_frame_bytes: number; queued_requests: number; deadline_ms: number; [k: string]: number };
}

export interface StartOptions {
  executable: string;
  /** Protocol namespace; the table default preserves existing clients. */
  protocol?: 'dfv-table' | 'dfv-mat';
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Largest frame in either direction; the worker's advertised limit may lower it. */
  maxFrameBytes?: number;
  startTimeoutMs?: number;
  /** Time past a request's deadline before the worker is declared hung and killed. */
  graceMs?: number;
}

export interface RequestOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
  /** The call may change a file: if the worker is lost, its outcome is 'unknown' instead of 'none'. */
  mutation?: boolean;
}

interface Pending {
  id: string;
  method: string;
  mutation: boolean;
  resolve(v: unknown): void;
  reject(e: NativeError): void;
  frame: Buffer;
  deadlineMs?: number;
  timer?: NodeJS.Timeout;
  detach?: () => void;
  sent: boolean;
}

const asNumber = (v: unknown, fallback: number) => (typeof v === 'string' && /^(?:0|[1-9][0-9]{0,14})$/.test(v) ? Number(v) : fallback);

function parseCapabilities(frame: any, ceiling: number, protocol: string): WorkerCapabilities {
  if (!frame || frame.kind !== 'capabilities' || frame.protocol !== protocol || frame.version !== VERSION
    || !frame.engine || typeof frame.engine.name !== 'string' || typeof frame.engine.version !== 'string'
    || !Array.isArray(frame.methods) || frame.methods.length === 0 || !frame.methods.every((m: unknown) => typeof m === 'string' && m.length > 0)
    || new Set(frame.methods).size !== frame.methods.length || !Array.isArray(frame.formats)
    || !Array.isArray(frame.value_tags) || !frame.value_tags.every((v: unknown) => typeof v === 'string')
    || !Array.isArray(frame.time_units) || !frame.time_units.every((v: unknown) => typeof v === 'string'))
    throw new NativeError('protocol_violation', 'The first frame was not a valid capabilities frame.', { host: true });
  const l = frame.limits ?? {};
  const maxFrame = asNumber(l.max_frame_bytes, NaN), queued = asNumber(l.queued_requests, NaN), deadline = asNumber(l.deadline_ms, NaN);
  if (![maxFrame, queued, deadline].every(Number.isSafeInteger) || maxFrame < 1 || queued < 0 || deadline < 1)
    throw new NativeError('protocol_violation', 'The worker announced invalid resource limits.', { host: true });
  return {
    engine: frame.engine, methods: frame.methods, formats: frame.formats ?? [], value_tags: frame.value_tags ?? [], time_units: frame.time_units ?? [],
    limits: { ...l, max_frame_bytes: Math.min(ceiling, maxFrame), queued_requests: Math.min(64, queued), deadline_ms: Math.min(2_147_000_000, deadline) },
  };
}

/** One live child. After 'exit' it is dead for good; start a new NativeWorker to recover. */
export class NativeWorker extends EventEmitter {
  readonly stderr: string[] = [];
  alive = true;
  private closing = false;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private waiting: Pending[] = []; // accepted but not sent: the worker's per-session queue is bounded, so ours is too
  private chunks: Buffer[] = [];
  private buffered = 0;
  private lost?: NativeError;
  private onCaps?: (c: WorkerCapabilities | NativeError) => void;
  capabilities!: WorkerCapabilities;
  private readonly exited: Promise<void>;

  private constructor(private child: ChildProcess, private opts: Required<Pick<StartOptions, 'maxFrameBytes' | 'graceMs' | 'protocol'>>) {
    super();
    this.exited = new Promise(resolve => {
      child.once('exit', () => resolve());
      child.once('error', () => { if (child.pid === undefined) resolve(); });
    });
    child.stdout!.on('data', c => this.onData(c));
    child.stderr!.on('data', c => { this.stderr.push(c.toString('utf8')); if (this.stderr.length > 50) this.stderr.shift(); });
    child.stdin!.on('error', () => { /* surfaces through the exit path */ });
    child.on('error', e => this.lose(hostError('worker_exited', `The native worker could not run (${e.message}).`, false)));
    child.on('exit', (code, signal) => this.lose(hostError('worker_exited', `The native worker stopped (exit ${code ?? signal}).`, false)));
  }

  static async start(o: StartOptions): Promise<NativeWorker> {
    let child: ChildProcess;
    try {
      child = spawnWorker(o.protocol === 'dfv-mat' ? 'mat' : 'table', o.executable, o.args ?? ['--stdio'], {
        cwd: o.cwd,
        env: { ...process.env, PATH: '/nonexistent-no-python', ...o.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (error instanceof WorkerCapacityError) throw hostError('resource_limit', error.message, false, true, false);
      throw error;
    }
    const w = new NativeWorker(child, { maxFrameBytes: o.maxFrameBytes ?? MAX_FRAME_BYTES, graceMs: o.graceMs ?? 5000, protocol: o.protocol ?? PROTOCOL });
    const first = new Promise<WorkerCapabilities | NativeError>(resolve => { w.onCaps = resolve; });
    const timer = setTimeout(() => w.onCaps?.(hostError('worker_timeout', 'The native worker did not announce its capabilities in time.', false)), o.startTimeoutMs ?? 10_000);
    const got = await first;
    clearTimeout(timer);
    if (got instanceof NativeError) { w.kill(); throw got; }
    w.capabilities = got;
    return w;
  }

  private lose(why: NativeError) {
    if (this.lost) return;
    this.lost = why;
    this.alive = false;
    this.onCaps?.(why);
    this.onCaps = undefined;
    const all = [...this.pending.values(), ...this.waiting];
    this.pending.clear();
    this.waiting = [];
    for (const p of all) this.settle(p, hostError(why.code as HostCode, `${why.message} ${p.mutation && p.sent ? 'The write may or may not have happened; it was not retried.' : ''}`.trim(), p.mutation, false, p.sent));
    this.emit('exit', why);
  }

  /** Protocol breakage or a hang: the worker can no longer be trusted, so it is killed and everything pending is settled. */
  private fail(code: HostCode, message: string) {
    this.lose(hostError(code, message, false));
    this.kill();
  }

  get pid() { return this.child.pid; }
  waitForExit() { return this.exited; }
  kill() { try { this.child.kill('SIGKILL'); } catch { /* already gone */ } }

  private settle(p: Pending, e: NativeError | undefined, v?: unknown) {
    if (p.timer) clearTimeout(p.timer);
    p.detach?.();
    if (e) p.reject(e); else p.resolve(v);
  }

  private onData(chunk: Buffer) {
    // Bounded: a line is never allowed to grow past the frame limit, however the bytes are split.
    let rest = chunk;
    for (let nl = rest.indexOf(0x0a); nl >= 0; nl = rest.indexOf(0x0a)) {
      this.chunks.push(rest.subarray(0, nl));
      this.buffered += nl;
      rest = rest.subarray(nl + 1);
      const line = Buffer.concat(this.chunks, this.buffered);
      this.chunks = [];
      this.buffered = 0;
      if (line.length > this.limit()) return this.fail('protocol_violation', `The worker sent a frame over ${this.limit()} bytes.`);
      if (!this.alive) return;
      this.onFrame(line);
      if (!this.alive) return;
    }
    this.chunks.push(rest);
    this.buffered += rest.length;
    if (this.buffered > this.limit()) this.fail('protocol_violation', `The worker sent a frame over ${this.limit()} bytes.`);
  }

  private limit() { return this.capabilities?.limits.max_frame_bytes ?? this.opts.maxFrameBytes; }

  private onFrame(line: Buffer) {
    if (line.length === 0 || (line.length === 1 && line[0] === 0x0d)) return;
    let f: any;
    try { f = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { return this.fail('protocol_violation', 'The worker sent a frame that is not valid UTF-8 JSON.'); }
    if (this.onCaps) {
      const cb = this.onCaps;
      this.onCaps = undefined;
      try { cb(parseCapabilities(f, this.opts.maxFrameBytes, this.opts.protocol)); } catch (e) { cb(e as NativeError); }
      return;
    }
    if (!f || typeof f !== 'object' || f.protocol !== this.opts.protocol || f.version !== VERSION || f.kind !== 'response' || typeof f.id !== 'string')
      return this.fail('protocol_violation', 'The worker sent a frame outside protocol v1.');
    const p = this.pending.get(f.id);
    // An unmatched id (including the unaddressed "0") means a reply we cannot attribute: nothing can be trusted after it.
    if (!p) return this.fail('protocol_violation', f.id === UNADDRESSED_ID ? 'The worker rejected a frame this client sent.' : 'The worker answered an unknown request.');
    if (f.ok === true && Object.hasOwn(f, 'result') && !Object.hasOwn(f, 'error')) this.settle(p, undefined, f.result);
    else if (f.ok === false && !Object.hasOwn(f, 'result') && f.error && typeof f.error.code === 'string'
      && typeof f.error.message === 'string' && typeof f.error.category === 'string' && typeof f.error.retryable === 'boolean'
      && [null, 'not-published', 'published', 'unknown'].includes(f.error.mutation_outcome))
      this.settle(p, new NativeError(f.error.code, String(f.error.message ?? ''), { category: f.error.category, retryable: f.error.retryable === true, mutationOutcome: f.error.mutation_outcome ?? (p.mutation && f.error.code === 'mutation_unknown' ? 'unknown' : null) }));
    else return this.fail('protocol_violation', 'The worker sent a response with neither valid result nor error.');
    this.pending.delete(f.id);
    this.pump();
  }

  /** Send queued requests while the worker has room; the client never overruns the advertised queue. */
  private pump() {
    const room = Math.max(1, this.capabilities?.limits.queued_requests ?? 1) + 1; // queued + the one running
    while (this.alive && this.waiting.length && this.pending.size < room) this.send(this.waiting.shift()!);
  }

  private send(p: Pending) {
    p.sent = true;
    this.pending.set(p.id, p);
    const hard = (p.deadlineMs ?? this.capabilities.limits.deadline_ms) + this.opts.graceMs;
    // The worker answers deadline_exceeded itself; this timer only catches a worker that cannot (hung).
    p.timer = setTimeout(() => this.fail('worker_timeout', `The native worker did not answer ${p.method} within its deadline and was stopped.`), hard);
    this.child.stdin!.write(p.frame);
  }

  request(method: string, args: Record<string, unknown> = {}, o: RequestOptions = {}): Promise<unknown> {
    const mutation = o.mutation === true;
    if (!this.alive) return Promise.reject(hostError(this.lost!.code as HostCode, this.lost!.message, mutation, false, false));
    if (this.closing) return Promise.reject(hostError('client_closed', 'The native worker is closing.', mutation, false, false));
    if (!this.capabilities.methods.includes(method)) return Promise.reject(hostError('unknown_method', `The worker does not offer ${method}.`, mutation, false, false));
    if (o.signal?.aborted) return Promise.reject(new NativeError('cancelled', 'Cancelled before it was sent.', { category: 'cancelled', mutationOutcome: mutation ? 'not-published' : null }));
    if (o.deadlineMs !== undefined && (!Number.isSafeInteger(o.deadlineMs) || o.deadlineMs < 1 || o.deadlineMs > 2_147_000_000))
      return Promise.reject(new NativeError('malformed_value', 'The request deadline must be a positive, bounded integer.', { category: 'conversion', mutationOutcome: mutation ? 'not-published' : null }));
    const id = String(this.nextId++);
    const body: Record<string, unknown> = { protocol: this.opts.protocol, version: VERSION, kind: 'request', id, method, args };
    if (o.deadlineMs !== undefined) body.deadline_ms = String(Math.max(1, Math.floor(o.deadlineMs)));
    const frame = Buffer.from(JSON.stringify(body) + '\n', 'utf8');
    if (frame.length - 1 > this.limit()) return Promise.reject(hostError('frame_too_large', `The request of ${frame.length} bytes exceeds the ${this.limit()} byte frame limit.`, mutation, false, false));
    const cap = Math.max(1, this.capabilities.limits.queued_requests) * 4;
    if (this.waiting.length >= cap) return Promise.reject(hostError('queue_full', 'Too many requests are waiting for the native worker.', mutation, true, false));
    return new Promise((resolve, reject) => {
      const p: Pending = { id, method, mutation, resolve, reject, frame, deadlineMs: o.deadlineMs, sent: false };
      if (o.signal) {
        const abort = () => {
          if (!p.sent) { // never reached the worker, so nothing to wait for
            this.waiting = this.waiting.filter(w => w !== p);
            this.settle(p, new NativeError('cancelled', 'Cancelled before it was sent.', { category: 'cancelled' }));
          } else this.child.stdin!.write(Buffer.from(JSON.stringify({ protocol: this.opts.protocol, version: VERSION, kind: 'cancel', id }) + '\n'));
        };
        o.signal.addEventListener('abort', abort, { once: true });
        p.detach = () => o.signal!.removeEventListener('abort', abort);
      }
      this.waiting.push(p);
      this.pump();
    });
  }

  /** Orderly stop: close stdin, settle anything pending as lost, kill if it lingers. */
  stop(): Promise<void> {
    if (!this.alive) return this.exited;
    this.closing = true;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.kill(), 5000);
      this.once('exit', () => { clearTimeout(timer); resolve(); });
      this.lost = undefined;
      const pend = [...this.pending.values(), ...this.waiting];
      this.pending.clear();
      this.waiting = [];
      for (const p of pend) this.settle(p, hostError('client_closed', 'The native worker was closed.', p.mutation, false, p.sent));
      this.child.stdin!.end();
    });
  }
}
