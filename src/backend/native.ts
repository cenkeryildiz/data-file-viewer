// Native table backend client (D3.18): a restartable handle on dfv-table plus exact wire-value decoding.
// Not bound to the viewer's providers yet (that goes through the D1.7 interface); no vscode import.
import { NativeWorker, NativeError, isUnconfirmed, type StartOptions, type RequestOptions, type WorkerCapabilities } from './nativeWorker';

export { NativeError, isUnconfirmed, type StartOptions, type RequestOptions, type WorkerCapabilities };

/** A decoded wire value. Integers wider than 32 bits are bigint, so nothing is rounded through a double. */
export type NativeValue =
  | null | boolean | string | number | bigint | Buffer
  | { kind: 'decimal'; text: string; precision: number; scale: number }
  | { kind: 'date'; days: number }
  | { kind: 'time'; value: bigint; unit: string }
  | { kind: 'timestamp'; value: bigint; unit: string; tz: string | null }
  | { kind: 'interval'; months: number; days: number; nanos: bigint }
  | { kind: 'uuid'; text: string }
  | { kind: 'list'; items: NativeValue[] }
  | { kind: 'struct'; fields: [string, NativeValue][] }
  | { kind: 'map'; entries: [NativeValue, NativeValue][] };

const malformed = (what: string) => new NativeError('malformed_value', `Malformed wire value: ${what}.`, { category: 'conversion' });
const INT = /^(?:0|-?[1-9][0-9]*)$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const BITS: Record<string, [bigint, bigint]> = {
  int8: [-(1n << 7n), (1n << 7n) - 1n], int16: [-(1n << 15n), (1n << 15n) - 1n], int32: [-(1n << 31n), (1n << 31n) - 1n],
  int64: [-(1n << 63n), (1n << 63n) - 1n], int128: [-(1n << 127n), (1n << 127n) - 1n],
  uint8: [0n, (1n << 8n) - 1n], uint16: [0n, (1n << 16n) - 1n], uint32: [0n, (1n << 32n) - 1n],
  uint64: [0n, (1n << 64n) - 1n], uint128: [0n, (1n << 128n) - 1n],
};
const SMALL = new Set(['int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32']);
const FLOAT = /^(?:NaN|Infinity|-Infinity|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[-+][0-9]+)?)$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UNITS = new Set(['s', 'ms', 'us', 'ns']);

function integer(tag: string, v: unknown): bigint {
  if (typeof v !== 'string' || !(tag.startsWith('u') ? UINT : INT).test(v)) throw malformed(`${tag} is not canonical decimal text`);
  const n = BigInt(v);
  const [lo, hi] = BITS[tag];
  if (n < lo || n > hi) throw malformed(`${tag} out of range`);
  return n;
}
const unit = (v: unknown) => { if (typeof v !== 'string' || !UNITS.has(v)) throw malformed('unknown time unit'); return v; };

/** Decode one tagged wire value (common.v1 `value`). Bare numbers, arrays and untagged objects are refused. */
export function decodeValue(v: unknown): NativeValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v !== 'object' || Array.isArray(v)) throw malformed('bare number, array or untagged object');
  const o = v as Record<string, any>;
  const tag = o.$t;
  if (typeof tag === 'string' && Object.hasOwn(BITS, tag)) {
    const n = integer(tag, o.v);
    return SMALL.has(tag) ? Number(n) : n;
  }
  switch (tag) {
    case 'float32': case 'float64':
      if (typeof o.v !== 'string' || !FLOAT.test(o.v)) throw malformed('float text');
      const numeric = tag === 'float32' ? Math.fround(Number(o.v)) : Number(o.v);
      if (!['NaN', 'Infinity', '-Infinity'].includes(o.v) && !Number.isFinite(numeric)) throw malformed('float overflow');
      return numeric;
    case 'decimal':
      if (typeof o.v !== 'string' || !DECIMAL.test(o.v) || o.v === '-0' || !Number.isInteger(o.precision) || o.precision < 1 || o.precision > 38 || !Number.isInteger(o.scale) || o.scale < 0 || o.scale > o.precision) throw malformed('decimal');
      if ((o.v.split('.')[1] ?? '').length !== o.scale || o.v.replace(/[-.]/g, '').replace(/^0+(?=\d)/, '').length > o.precision) throw malformed('decimal scale or precision');
      return { kind: 'decimal', text: o.v, precision: o.precision, scale: o.scale };
    case 'date': return { kind: 'date', days: Number(integer('int32', o.v)) };
    case 'time': return { kind: 'time', value: integer('int64', o.v), unit: unit(o.unit) };
    case 'timestamp':
      if (o.tz !== null && typeof o.tz !== 'string') throw malformed('timestamp zone');
      return { kind: 'timestamp', value: integer('int64', o.v), unit: unit(o.unit), tz: o.tz };
    case 'interval': return { kind: 'interval', months: Number(integer('int32', o.months)), days: Number(integer('int32', o.days)), nanos: integer('int64', o.nanos) };
    case 'binary':
      if (o.encoding !== 'base64' || typeof o.v !== 'string' || !B64.test(o.v)) throw malformed('binary');
      return Buffer.from(o.v, 'base64');
    case 'uuid':
      if (typeof o.v !== 'string' || !UUID.test(o.v)) throw malformed('uuid');
      return { kind: 'uuid', text: o.v };
    case 'list':
      if (!Array.isArray(o.v)) throw malformed('list');
      return { kind: 'list', items: o.v.map(decodeValue) };
    case 'struct': {
      if (!Array.isArray(o.v)) throw malformed('struct');
      const names = new Set<string>();
      const fields = o.v.map((p: unknown): [string, NativeValue] => {
        if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string') throw malformed('struct field');
        if (names.has(p[0])) throw malformed('duplicate struct field name');
        names.add(p[0]);
        return [p[0], decodeValue(p[1])];
      });
      return { kind: 'struct', fields };
    }
    case 'map':
      if (!Array.isArray(o.v)) throw malformed('map');
      return { kind: 'map', entries: o.v.map((p: unknown): [NativeValue, NativeValue] => {
        if (!Array.isArray(p) || p.length !== 2) throw malformed('map entry');
        return [decodeValue(p[0]), decodeValue(p[1])];
      }) };
    default: throw malformed('unknown tag');
  }
}

/** Decode a page's rows (paged-resource `rows`); the first bad cell fails the whole page, never a partial result. */
export const decodeRows = (rows: unknown): NativeValue[][] => {
  if (!Array.isArray(rows)) throw malformed('rows');
  return rows.map(r => { if (!Array.isArray(r)) throw malformed('row'); return r.map(decodeValue); });
};

/**
 * A handle on the native worker. A lost worker settles every pending call with a typed error and the handle
 * stays dead until restart(); nothing is resubmitted, so a write of unknown outcome is never repeated.
 */
export class NativeTableClient {
  private restarting?: Promise<void>;
  private constructor(private worker: NativeWorker, private readonly options: StartOptions) {}

  static async start(options: StartOptions): Promise<NativeTableClient> {
    return new NativeTableClient(await NativeWorker.start(options), options);
  }

  get capabilities(): WorkerCapabilities { return this.worker.capabilities; }
  get alive(): boolean { return this.worker.alive; }
  get pid(): number | undefined { return this.worker.pid; }
  get stderr(): string { return this.worker.stderr.join(''); }
  onExit(listener: (why: NativeError) => void) { this.worker.once('exit', listener); }

  call(method: string, args: Record<string, unknown> = {}, o: RequestOptions = {}): Promise<unknown> {
    return this.worker.request(method, args, o);
  }

  /** Replace a dead (or live) worker with a fresh process. Sessions and handles of the old one are gone with it. */
  restart(): Promise<void> {
    if (!this.restarting) this.restarting = (async () => {
      const old = this.worker;
      old.kill();
      await old.waitForExit();
      this.worker = await NativeWorker.start(this.options);
    })().finally(() => { this.restarting = undefined; });
    return this.restarting;
  }

  async close(): Promise<void> {
    if (this.restarting) await this.restarting.catch(() => {});
    await this.worker.stop();
  }
}
