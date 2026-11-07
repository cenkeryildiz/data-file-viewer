import { join } from 'node:path';
import { NativeError, NativeWorker, type StartOptions } from '../../backend/nativeWorker';
import { uint64, scalarText, type MatInfo, type MatItem, type MatPage, type MatSlice, type MatSparse } from './protocol';

const malformed = () => new NativeError('malformed_value', 'The MAT worker returned an invalid result.', { category: 'conversion' });
function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed(); return value as Record<string, any>; }
function info(value: unknown): MatInfo {
  const v = object(value);
  if (typeof v.name !== 'string' || typeof v.class !== 'string' || typeof v.className !== 'string'
    || !Array.isArray(v.dims) || (v.support?.supported === true && v.dims.length < 2) || v.dims.length > 32 || !v.dims.every(uint64) || !['complex', 'sparse', 'global'].every(k => typeof v[k] === 'boolean')
    || !uint64(v.nzmax) || !(v.nnz === null || uint64(v.nnz)) || !(v.children === null || uint64(v.children))
    || !Array.isArray(v.fields) || !v.fields.every((s: unknown) => typeof s === 'string') || typeof v.support?.supported !== 'boolean'
    || (!v.support.supported && typeof v.support.reason !== 'string')) throw malformed();
  return v as MatInfo;
}
export function matWorkerPath(extensionPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.DFV_MAT_WORKER || join(extensionPath, 'bin', process.platform === 'win32' ? 'dfv-mat.exe' : 'dfv-mat');
}
/** One read-only MAT source; sessions/handles are never reused after worker death or source replacement. */
export class MatClient {
  private handles = new Set<string>();
  private closing?: Promise<void>;
  private constructor(private worker: NativeWorker, readonly session: string, readonly generation: string, readonly variables: string, private readonly options: StartOptions, private readonly path: string) {}
  get pid() { return this.worker.pid; }
  static async open(options: StartOptions, path: string, signal?: AbortSignal): Promise<MatClient> {
    const worker = await NativeWorker.start({ ...options, protocol: 'dfv-mat', maxFrameBytes: 8 * 1024 * 1024 });
    try {
      const r = object(await worker.request('open', { path }, { signal, deadlineMs: 30000 }));
      if (typeof r.session !== 'string' || !uint64(r.generation) || !uint64(r.variables) || r.read_only !== true) throw malformed();
      return new MatClient(worker, r.session, r.generation, r.variables, options, path);
    } catch (e) { await worker.stop(); throw e; }
  }
  private async call(method: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const r = object(await this.worker.request(method, { ...args, session: this.session, generation: this.generation }, { signal, deadlineMs: 30000 }));
    if (r.session !== this.session || r.generation !== this.generation) throw malformed();
    return r;
  }
  private handle(handle: unknown): string {
    if (typeof handle !== 'string' || !this.handles.has(handle)) throw new NativeError('not_open', 'This MAT value is no longer open.');
    return handle;
  }
  private page(r: Record<string, any>): MatPage {
    if (!uint64(r.total) || !uint64(r.offset) || !Array.isArray(r.items) || r.items.length > 1000) throw malformed();
    const items: MatItem[] = r.items.map((value: unknown) => {
      const i = object(value);
      if (typeof i.handle !== 'string' || i.handle.length > 256 || this.handles.has(i.handle) || (i.label !== undefined && typeof i.label !== 'string')) throw malformed();
      return { ...i, info: info(i.info) } as MatItem;
    });
    for (const i of items) this.handles.add(i.handle);
    return { total: r.total, offset: r.offset, items };
  }
  async catalog(offset = '0', signal?: AbortSignal) { return this.page(await this.call('catalog', { offset, limit: '100' }, signal)); }
  async describe(handle: string, signal?: AbortSignal) { return info((await this.call('describe', { handle: this.handle(handle) }, signal)).info); }
  async children(handle: string, offset = '0', signal?: AbortSignal) { return this.page(await this.call('children', { handle: this.handle(handle), offset, limit: '100' }, signal)); }
  async slice(handle: string, start: string[], count: string[], signal?: AbortSignal): Promise<MatSlice> {
    const r = await this.call('slice', { handle: this.handle(handle), start, count }, signal);
    if (r.index_base !== '1' || r.order !== 'column-major' || !Array.isArray(r.count) || !r.count.every(uint64) || !Array.isArray(r.start) || !r.start.every(uint64) || !Array.isArray(r.dims) || !r.dims.every(uint64) || !r.data || !['numeric', 'char'].includes(r.data.kind)) throw malformed();
    if (r.count.length !== count.length || r.start.length !== start.length || r.dims.length !== count.length || !r.count.every((n: string, i: number) => n === count[i]) || !r.start.every((n: string, i: number) => n === start[i])) throw malformed();
    const cells = r.count.reduce((n: bigint, c: string) => n * BigInt(c), 1n);
    if (cells > 10000n) throw malformed();
    if (r.data.kind === 'numeric') {
      if (!Array.isArray(r.data.re) || r.data.re.length !== Number(cells) || !(r.data.im === null || Array.isArray(r.data.im) && r.data.im.length === Number(cells))) throw malformed();
      for (const v of [...r.data.re, ...(r.data.im ?? [])]) scalarText(v);
    } else if (!Array.isArray(r.data.rows) || r.data.rows.length > 10000 || !r.data.rows.every((v: unknown) => typeof v === 'string') || typeof r.data.lossy !== 'boolean') throw malformed();
    return r as MatSlice;
  }
  async sparse(handle: string, start: string[], count: string[], offset = '0', signal?: AbortSignal): Promise<MatSparse> {
    const r = await this.call('sparse', { handle: this.handle(handle), start, count, offset, limit: '100' }, signal);
    if (r.index_base !== '1' || r.order !== 'column-major' || !uint64(r.nnz) || !uint64(r.offset) || typeof r.has_more !== 'boolean' || r.implicit_zero !== true || !Array.isArray(r.shape) || !r.shape.every(uint64) || !Array.isArray(r.entries) || r.entries.length > 100) throw malformed();
    for (const e of r.entries) {
      if (!uint64(e.row) || !uint64(e.col)) throw malformed();
      scalarText(e.re); if (e.im !== null) scalarText(e.im);
    }
    return r as MatSparse;
  }
  async release(handles: string[]) {
    const owned = [...new Set(handles.filter(h => this.handles.has(h)))];
    if (!owned.length) return;
    const r = object(await this.worker.request('release', { session: this.session, generation: this.generation, handles: owned }));
    if (!uint64(r.released)) throw malformed();
    for (const h of owned) this.handles.delete(h);
  }
  /** Explicit user refresh discards the old worker and every old handle. */
  async reopen() { await this.close(); return MatClient.open(this.options, this.path); }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { if (this.worker.alive) await this.worker.request('close', { session: this.session, generation: this.generation }, { deadlineMs: 3000 }); }
      catch (e) { if (!(e instanceof NativeError) || !['not_open', 'stale_source'].includes(e.code)) throw e; }
      finally { this.handles.clear(); await this.worker.stop(); }
    })();
  }
}
