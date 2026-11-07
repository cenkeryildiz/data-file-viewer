/** MAT v1 values stay exact decimal text throughout the read-only viewer. */
export interface MatInfo {
  name: string; class: string; className: string; dims: string[]; complex: boolean; sparse: boolean;
  global: boolean; nzmax: string; nnz: string | null; fields: string[]; children: string | null;
  support: { supported: boolean; code?: string; reason?: string };
}
export interface MatItem { handle: string; info: MatInfo; label?: string; preview?: MatData | null }
export interface MatData { kind: 'numeric' | 'char'; class?: string; re?: unknown[]; im?: unknown[] | null; rows?: string[]; lossy?: boolean }
export interface MatPage { total: string; offset: string; items: MatItem[] }
export interface MatSlice { dims: string[]; start: string[]; count: string[]; index_base: '1'; order: 'column-major'; data: MatData }
export interface MatSparse { shape: string[]; nnz: string; offset: string; has_more: boolean; implicit_zero: true; entries: { row: string; col: string; re: unknown; im: unknown }[] }
export const uint64 = (v: unknown): v is string => typeof v === 'string' && v.length <= 20 && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= 18446744073709551615n;
export function scalarText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MAT scalar.');
  const v = value as { $t?: string; v?: unknown };
  if (typeof v.$t !== 'string' || typeof v.v !== 'string' || v.v.length > 128) throw new Error('Invalid MAT scalar.');
  const integer = /^(u?int)(8|16|32|64)$/.exec(v.$t);
  if (integer) {
    if (!/^(?:0|-?[1-9][0-9]*)$/.test(v.v)) throw new Error('Invalid MAT integer.');
    const n = BigInt(v.v), bits = BigInt(integer[2]), unsigned = integer[1] === 'uint';
    if (n < (unsigned ? 0n : -(1n << (bits - 1n))) || n >= (1n << (unsigned ? bits : bits - 1n))) throw new Error('MAT integer is outside its class range.');
  } else if (!['float32', 'float64'].includes(v.$t) || !/^(?:NaN|Infinity|-Infinity|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(v.v)) {
    throw new Error('Invalid MAT scalar.');
  }
  return v.v;
}
export function firstRegion(dims: string[], sparse = false): { start: string[]; count: string[] } {
  let left = 1000n;
  return { start: dims.map(() => '1'), count: dims.map(d => { const n = BigInt(d); const c = sparse ? n : n < left ? n : left; left /= c || 1n; return c.toString(); }) };
}
/** Coordinates for bounded MATLAB column-major cells, without converting source dimensions to doubles. */
export function coordinates(index: number, start: string[], count: string[]): string[] {
  let n = BigInt(index);
  return count.map((c, d) => { const size = BigInt(c); const out = BigInt(start[d]) + n % size; n /= size; return out.toString(); });
}
