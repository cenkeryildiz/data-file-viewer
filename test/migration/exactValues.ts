// D1.9 reference codec for the table wire value encoding (schema/common.v1.schema.json).
//
// Wire rules (v1):
//  - JSON null, true/false and strings are the SQL null, boolean and text
//    values; they are never coerced into each other or into numbers.
//  - Every other value is a tagged object {"$t": <tag>, ...}. Bare JSON
//    numbers, bare arrays and untagged objects are malformed in a value slot.
//  - Exact scalars (all integer widths, decimal, temporal counts) are decimal
//    strings and decode to bigint. They never pass through Number, parseInt or
//    parseFloat; only float32/float64 (inexact by type) are decoded as numbers.
//  - Timestamps carry an explicit unit and an explicit tz (null = naive).
//  - Binary is standard padded base64, named by an explicit "encoding".

export type IntTag = 'int8' | 'int16' | 'int32' | 'int64' | 'int128' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'uint128';
export type TimeUnit = 's' | 'ms' | 'us' | 'ns';

export type Decoded =
  | { kind: 'null' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'utf8'; value: string }
  | { kind: IntTag; value: bigint }
  | { kind: 'float32' | 'float64'; value: number }
  | { kind: 'decimal'; unscaled: bigint; precision: number; scale: number }
  | { kind: 'date'; days: bigint }
  | { kind: 'time'; count: bigint; unit: TimeUnit }
  | { kind: 'timestamp'; count: bigint; unit: TimeUnit; tz: string | null }
  | { kind: 'interval'; months: bigint; days: bigint; nanos: bigint }
  | { kind: 'binary'; bytes: Uint8Array }
  | { kind: 'uuid'; value: string }
  | { kind: 'list'; items: Decoded[] }
  | { kind: 'struct'; fields: [string, Decoded][] }
  | { kind: 'map'; entries: [Decoded, Decoded][] };

export class ExactValueError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ExactValueError';
  }
}

const INT_RANGE: Record<IntTag, [bigint, bigint]> = {
  int8: [-(2n ** 7n), 2n ** 7n - 1n],
  int16: [-(2n ** 15n), 2n ** 15n - 1n],
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  int128: [-(2n ** 127n), 2n ** 127n - 1n],
  uint8: [0n, 2n ** 8n - 1n],
  uint16: [0n, 2n ** 16n - 1n],
  uint32: [0n, 2n ** 32n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
  uint128: [0n, 2n ** 128n - 1n],
};
const INT_TAGS = Object.keys(INT_RANGE) as IntTag[];
const UNITS: readonly TimeUnit[] = ['s', 'ms', 'us', 'ns'];
/** Canonical decimal integer: no sign on zero, no leading zeros, no '+', no exponent. */
const INTEGER_TEXT = /^(?:0|-?[1-9][0-9]*)$/;
const UNSIGNED_TEXT = /^(?:0|[1-9][0-9]*)$/;
const DECIMAL_TEXT =/^-?(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const FLOAT_TEXT = /^(?:NaN|Infinity|-Infinity|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[-+][0-9]+)?)$/;
const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** "UTC", a fixed offset, or an IANA-shaped name (existence is the consumer's tz database question). */
const TZ_TEXT = /^(?:UTC|[+-](?:0[0-9]|1[0-4]):[0-5][0-9]|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

const KEYS: Record<string, readonly string[]> = {
  ...Object.fromEntries(INT_TAGS.map(t => [t, ['v']])),
  float32: ['v'], float64: ['v'], decimal: ['v', 'precision', 'scale'], date: ['v'], time: ['v', 'unit'],
  timestamp: ['v', 'unit', 'tz'], interval: ['months', 'days', 'nanos'], binary: ['encoding', 'v'], uuid: ['v'],
  list: ['v'], struct: ['v'], map: ['v'],
};

function fail(code: string, path: string, message: string): never { throw new ExactValueError(code, path, message); }

/** Exact integer from its decimal text; BigInt(string) only, never Number. */
function exactInteger(text: unknown, tag: IntTag, path: string): bigint {
  if (typeof text !== 'string') fail('exact_not_string', path, `${tag} must be a decimal string`);
  // Unsigned text carries no sign at all (matches the schema's uint*Text pattern).
  if (!(tag.startsWith('u') ? UNSIGNED_TEXT : INTEGER_TEXT).test(text)) fail('exact_not_canonical', path, `${tag} text "${text}" is not a canonical decimal integer`);
  const value = BigInt(text);
  const [min, max] = INT_RANGE[tag];
  if (value < min || value > max) fail('exact_out_of_range', path, `${text} is outside ${tag}`);
  return value;
}

function smallInteger(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('bad_parameter', path, `expected an integer in [${min}, ${max}]`);
  }
  return value;
}

/** The only place a wire value becomes a JS number: floats, which are inexact by type. */
function decodeFloat(text: unknown, tag: 'float32' | 'float64', path: string): number {
  if (typeof text !== 'string' || !FLOAT_TEXT.test(text)) fail('float_not_canonical', path, `${tag} must be a float string`);
  const value = Number(text);
  if (tag === 'float32' && Number.isFinite(value) && Math.fround(value) !== value) fail('float_not_representable', path, `${text} is not a float32`);
  return value;
}

function decodeUnit(value: unknown, path: string): TimeUnit {
  if (typeof value !== 'string' || !(UNITS as readonly string[]).includes(value)) fail('bad_unit', path, 'unit must be s, ms, us or ns');
  return value as TimeUnit;
}

function decodeBase64(text: unknown, path: string): Uint8Array {
  if (typeof text !== 'string' || !BASE64_TEXT.test(text)) fail('bad_base64', path, 'binary must be standard padded base64');
  return new Uint8Array(Buffer.from(text, 'base64'));
}

export function decodeValue(wire: unknown, path = '$'): Decoded {
  if (wire === null) return { kind: 'null' };
  if (typeof wire === 'boolean') return { kind: 'bool', value: wire };
  if (typeof wire === 'string') return { kind: 'utf8', value: wire };
  if (typeof wire === 'number') fail('bare_number', path, 'bare JSON numbers are not values; use a tagged scalar');
  if (Array.isArray(wire)) fail('bare_array', path, 'arrays must be tagged {"$t":"list"}');
  if (typeof wire !== 'object') fail('bad_value', path, `unsupported JSON ${typeof wire}`);
  const object = wire as Record<string, unknown>;
  const tag = object.$t;
  if (typeof tag !== 'string') fail('missing_tag', path, 'objects in a value slot need a string "$t"');
  const keys = KEYS[tag];
  if (!keys) fail('unknown_tag', path, `unknown tag "${tag}"`);
  for (const key of Object.keys(object)) if (key !== '$t' && !keys.includes(key)) fail('unexpected_key', path, `"${key}" is not part of ${tag}`);
  for (const key of keys) if (!(key in object)) fail('missing_key', path, `${tag} requires "${key}"`);
  const v = object.v;
  switch (tag) {
    case 'float32': case 'float64': return { kind: tag, value: decodeFloat(v, tag, `${path}.v`) };
    case 'decimal': {
      const precision = smallInteger(object.precision, 1, 38, `${path}.precision`);
      const scale = smallInteger(object.scale, 0, precision, `${path}.scale`);
      if (typeof v !== 'string') fail('exact_not_string', `${path}.v`, 'decimal must be a decimal string');
      const match = DECIMAL_TEXT.exec(v);
      if (!match) fail('exact_not_canonical', `${path}.v`, `decimal text "${v}" is malformed`);
      const fraction = match[1] ?? '';
      if (fraction.length !== scale) fail('decimal_scale_mismatch', `${path}.v`, `"${v}" has ${fraction.length} fraction digits, scale is ${scale}`);
      const negative = v.startsWith('-');
      const digits = (negative ? v.slice(1) : v).replace('.', '').replace(/^0+(?=.)/, '');
      const unscaled = BigInt(digits) * (negative ? -1n : 1n);
      if (negative && unscaled === 0n) fail('exact_not_canonical', `${path}.v`, 'negative zero decimal');
      if (digits.length > precision) fail('decimal_precision_overflow', `${path}.v`, `"${v}" needs ${digits.length} digits, precision is ${precision}`);
      return { kind: 'decimal', unscaled, precision, scale };
    }
    case 'date': return { kind: 'date', days: exactInteger(v, 'int32', `${path}.v`) };
    case 'time': return { kind: 'time', count: exactInteger(v, 'int64', `${path}.v`), unit: decodeUnit(object.unit, `${path}.unit`) };
    case 'timestamp': {
      const tz = object.tz;
      if (tz !== null && (typeof tz !== 'string' || !TZ_TEXT.test(tz))) fail('bad_timezone', `${path}.tz`, 'tz must be null (naive), "UTC", ±HH:MM or an IANA name');
      return { kind: 'timestamp', count: exactInteger(v, 'int64', `${path}.v`), unit: decodeUnit(object.unit, `${path}.unit`), tz };
    }
    case 'interval': return {
      kind: 'interval', months: exactInteger(object.months, 'int32', `${path}.months`),
      days: exactInteger(object.days, 'int32', `${path}.days`), nanos: exactInteger(object.nanos, 'int64', `${path}.nanos`),
    };
    case 'binary':
      if (object.encoding !== 'base64') fail('bad_encoding', `${path}.encoding`, 'encoding must be "base64"');
      return { kind: 'binary', bytes: decodeBase64(v, `${path}.v`) };
    case 'uuid':
      if (typeof v !== 'string' || !UUID_TEXT.test(v)) fail('bad_uuid', `${path}.v`, 'uuid must be canonical lowercase 8-4-4-4-12');
      return { kind: 'uuid', value: v };
    case 'list':
      if (!Array.isArray(v)) fail('bad_container', `${path}.v`, 'list v must be an array');
      return { kind: 'list', items: v.map((item, i) => decodeValue(item, `${path}.v[${i}]`)) };
    case 'struct': {
      if (!Array.isArray(v)) fail('bad_container', `${path}.v`, 'struct v must be an array of [name, value]');
      const names = new Set<string>();
      return { kind: 'struct', fields: v.map((pair, i): [string, Decoded] => {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') fail('bad_container', `${path}.v[${i}]`, 'struct field must be [name, value]');
        if (names.has(pair[0])) fail('duplicate_field', `${path}.v[${i}]`, `duplicate struct field "${pair[0]}"`);
        names.add(pair[0]);
        return [pair[0], decodeValue(pair[1], `${path}.v[${i}][1]`)];
      }) };
    }
    case 'map':
      if (!Array.isArray(v)) fail('bad_container', `${path}.v`, 'map v must be an array of [key, value]');
      return { kind: 'map', entries: v.map((pair, i): [Decoded, Decoded] => {
        if (!Array.isArray(pair) || pair.length !== 2) fail('bad_container', `${path}.v[${i}]`, 'map entry must be [key, value]');
        return [decodeValue(pair[0], `${path}.v[${i}][0]`), decodeValue(pair[1], `${path}.v[${i}][1]`)];
      }) };
    default:
      return { kind: tag as IntTag, value: exactInteger(v, tag as IntTag, `${path}.v`) };
  }
}

/** Decode a whole wire text. JSON.parse has already rounded any bare number, so those are refused. */
export function decodeWireText(text: string): Decoded {
  return decodeValue(JSON.parse(text));
}

function floatText(value: number): string {
  if (Object.is(value, -0)) return '-0';
  // JS shortest round-trip text: "NaN", "Infinity", "1e+21", "5e-324".
  return String(value);
}

function decimalText(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
  const whole = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return negative ? `-${whole}` : whole;
}

/** Canonical wire form; decodeValue(encodeValue(d)) round-trips exactly. */
export function encodeValue(value: Decoded): unknown {
  switch (value.kind) {
    case 'null': return null;
    case 'bool': case 'utf8': return value.value;
    case 'float32': case 'float64': return { $t: value.kind, v: floatText(value.value) };
    case 'decimal': return { $t: 'decimal', v: decimalText(value.unscaled, value.scale), precision: value.precision, scale: value.scale };
    case 'date': return { $t: 'date', v: value.days.toString() };
    case 'time': return { $t: 'time', v: value.count.toString(), unit: value.unit };
    case 'timestamp': return { $t: 'timestamp', v: value.count.toString(), unit: value.unit, tz: value.tz };
    case 'interval': return { $t: 'interval', months: value.months.toString(), days: value.days.toString(), nanos: value.nanos.toString() };
    case 'binary': return { $t: 'binary', encoding: 'base64', v: Buffer.from(value.bytes).toString('base64') };
    case 'uuid': return { $t: 'uuid', v: value.value };
    case 'list': return { $t: 'list', v: value.items.map(encodeValue) };
    case 'struct': return { $t: 'struct', v: value.fields.map(([name, item]) => [name, encodeValue(item)]) };
    case 'map': return { $t: 'map', v: value.entries.map(([k, item]) => [encodeValue(k), encodeValue(item)]) };
    default: return { $t: value.kind, v: value.value.toString() };
  }
}

/** Plain, comparable description for fixtures; exact parts stay strings. */
export function describe(value: Decoded): unknown {
  switch (value.kind) {
    case 'null': return null;
    case 'bool': case 'utf8': case 'uuid': return { [value.kind]: value.value };
    case 'float32': case 'float64': return { [value.kind]: floatText(value.value) };
    case 'decimal': return { decimal: { unscaled: value.unscaled.toString(), precision: value.precision, scale: value.scale } };
    case 'date': return { date: value.days.toString() };
    case 'time': return { time: { count: value.count.toString(), unit: value.unit } };
    case 'timestamp': return { timestamp: { count: value.count.toString(), unit: value.unit, tz: value.tz } };
    case 'interval': return { interval: { months: value.months.toString(), days: value.days.toString(), nanos: value.nanos.toString() } };
    case 'binary': return { binary_hex: Buffer.from(value.bytes).toString('hex') };
    case 'list': return { list: value.items.map(describe) };
    case 'struct': return { struct: value.fields.map(([n, item]) => [n, describe(item)]) };
    case 'map': return { map: value.entries.map(([k, item]) => [describe(k), describe(item)]) };
    default: return { [value.kind]: value.value.toString() };
  }
}
