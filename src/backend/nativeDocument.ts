// Native viewer document (D3.18): DocumentFile over dfv-table, through the D1.7 interface.
// All reads are issued as `<method>` with a `session` and snake_case arguments; a method the worker does not
// advertise fails with NativeUnsupportedError (nativeOperations.ts) instead of answering. No Node fallback.
//
// Wire shapes for the methods the Rust table crate does not route yet (the engine must match these or
// the decoders below fail with malformed_value):
//   listTables|listSidebarTables|listSiblingTables|getCombinableTableNames -> {names: string[]}
//   buildCombinedQuery {table, limit_n?: u64 text} -> {sql, time_column: string|null}
//   getPollCadenceSeconds {table} -> {seconds: number|null};  getSeriesFrequency {table} -> {frequency: string|null}
//   buildDetectedTableQuery {table, filters[{column,operator,value?,value_to?}], sort?, limit?: u64 text} -> {sql}
//   runDetectedTableQuery: same args -> paged resource whose `sql` is the query and page.total_rows the match count
//   checkEditableSelect {sql, describe_only} -> {editable, table?, columns?}
//   compareToBackup {} -> {tables: {name: 'unchanged'|'changed'|'new'}}
//   diffQueryAgainstBackup {sql, live_columns, live_rows (wire values)} -> {diff: null | {cell_changed, row_is_new, renamed_columns}}
//   locateXlsxEdit {table, column, row_values} -> {target: null | {sheet_path, column_names, row_ordinal, column_name}, sha256?}
//   retrySheetPreparation {sheet} -> {status, detected_tables, sheet_preparation, has_pending_sheets} (snake_case)
//   createBackup {mutation_id} / updateCell {table, column, new_value, row_values, mutation_id} -> mutation receipt
//   queryMutationOutcome {mutation_id} -> {outcome: 'published'|'not-published'|'unknown', receipt?}
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { QueryCatalogRelation, QueryColumn } from '../queryCatalog';
import { columnLetters } from '../sheetTables';
import type { SeriesFrequency } from '../chartSpec';
import { QUERY_LIMITS } from '../queryPolicy';
import { NativeError, NativeTableClient, decodeRows, decodeValue, isUnconfirmed, type NativeValue, type StartOptions } from './native';
import { NativeUnsupportedError } from './nativeOperations';
import type {
  BackendFactory, DescriptiveStats, DetectedSheetTable, DetectedTableFilter, DetectedTableQueryResult, DetectedTableSort, DocumentFile,
  DuckDbFileOpenOptions, EditabilityInfo, FileKind, ManualSheetTable, NumberLocaleReport, PreparationMetrics, QueryDiff, QueryResult, SheetPreparationStatus, StatsKind, TopValuesStats,
} from './types';
import { PreparationRecorder } from './excel/metrics';

const unsupportedValue = () => new NativeUnsupportedError('value display', 'this date or time is outside the range the viewer can show');
const malformed = () => new NativeError('malformed_value', 'The table worker returned an invalid result.', { category: 'conversion' });
const uint = /^(?:0|[1-9][0-9]*)$/;
const units: Record<string, bigint> = { s: 1n, ms: 1000n, us: 1000000n, ns: 1000000000n };
const FILE_KINDS = new Set<string>(['duckdb', 'parquet', 'sqlite', 'csv', 'dta', 'arrow', 'feather', 'xlsx', 'kdb']);

function timestamp(value: bigint, unit: string, timeOnly = false): string {
  if (!Object.hasOwn(units, unit)) throw malformed();
  if (!timeOnly && (value === 9223372036854775807n || value === -9223372036854775807n)) return value < 0n ? '-infinity' : 'infinity';
  const ticks = units[unit];
  const remainder = ((value % ticks) + ticks) % ticks;
  const seconds = (value - remainder) / ticks;
  const millis = Number(seconds * 1000n);
  const date = new Date(millis);
  if (!Number.isSafeInteger(millis) || !Number.isFinite(date.getTime())) throw unsupportedValue();
  if (!/^\d{4}-/.test(date.toISOString())) throw unsupportedValue();
  if (timeOnly && (seconds < 0n || seconds >= 86400n)) throw unsupportedValue();
  const whole = date.toISOString().slice(timeOnly ? 11 : 0, 19).replace('T', ' ');
  const digits = ticks.toString().length - 1;
  const fraction = remainder.toString().padStart(digits, '0').replace(/0+$/, '');
  return whole + (fraction ? '.' + fraction : '');
}

/** Exact display boundary: wide integers and decimals never round through a JS number. */
export function nativeDisplayValue(value: NativeValue): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return Object.is(value, -0) ? '-0' : String(value);
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return '\\x' + value.toString('hex');
  switch (value.kind) {
    case 'decimal': return value.text;
    case 'uuid': return value.text;
    case 'date': return Math.abs(value.days) === 2147483647 ? (value.days < 0 ? '-infinity' : 'infinity') : timestamp(BigInt(value.days) * 86400n, 's').split(' ')[0];
    case 'time': return timestamp(value.value, value.unit, true);
    case 'timestamp': {
      if (value.tz !== null && value.tz !== 'UTC') throw unsupportedValue();
      const text = timestamp(value.value, value.unit);
      return text + (value.tz === 'UTC' && !text.endsWith('infinity') ? '+00' : '');
    }
    case 'interval': return `${value.months} months ${value.days} days ${value.nanos} ns`;
    case 'list': return value.items.map(nativeDisplayValue);
    case 'struct': return Object.fromEntries(value.fields.map(([name, field]) => [name, nativeDisplayValue(field)]));
    case 'map': return value.entries.map(([key, item]) => ({ key: nativeDisplayValue(key), value: nativeDisplayValue(item) }));
    default: throw unsupportedValue();
  }
}


interface Column { name: string; type: { id: string }; stats_kind: StatsKind }
interface Page { columns: Column[]; rows: unknown[]; resource: { id: string; source_revision: string }; sql?: string; page: { next_offset: string | null; total_rows?: string | null; truncated: boolean } }
type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
function obj(v: unknown): Obj { if (!isObj(v)) throw malformed(); return v; }
function strings(v: unknown): string[] { if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) throw malformed(); return v; }
/** Exact counts cross as uint64 text; one that a JS number cannot hold is refused, not rounded. */
/** The worker sends a worksheet row as a plain JSON number (an Excel row is at most 1,048,576); canonical strings are accepted too via count(). */
function ordinal(n: number): number { if (!Number.isSafeInteger(n) || n < 0) throw malformed(); return n; }
function count(v: unknown): number { const n = typeof v === 'string' && uint.test(v) ? Number(v) : NaN; if (!Number.isSafeInteger(n)) throw malformed(); return n; }
function revision(v: unknown): string { if (typeof v !== 'string' || !uint.test(v) || v.length > 20 || BigInt(v) > 18446744073709551615n) throw malformed(); return v; }
function page(value: unknown): Page {
  const p = value as Page;
  if (!p || !Array.isArray(p.columns) || !Array.isArray(p.rows) || typeof p.resource?.id !== 'string'
    || typeof p.resource.source_revision !== 'string' || !uint.test(p.resource.source_revision)
    || typeof p.page?.truncated !== 'boolean' || !(p.page.next_offset === null || typeof p.page.next_offset === 'string' && uint.test(p.page.next_offset))
    || !(p.sql === undefined || typeof p.sql === 'string') || !(p.page.total_rows == null || typeof p.page.total_rows === 'string' && uint.test(p.page.total_rows))
    || p.columns.some(c => typeof c?.name !== 'string' || typeof c.type?.id !== 'string' || !['numeric', 'datetime', 'other'].includes(c.stats_kind))) throw malformed();
  return p;
}
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const camelKeys = (v: unknown): any => Array.isArray(v) ? v.map(camelKeys) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelKeys(x)])) : v;
/** An application value (a grid cell or a typed edit) as a tagged wire value; bare numbers are never sent. */
function toWire(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string') return v ?? null;
  if (typeof v === 'bigint') return { $t: 'int64', v: v.toString() };
  if (typeof v === 'number') return Number.isSafeInteger(v) ? { $t: 'int64', v: String(v) } : { $t: 'float64', v: String(v) };
  throw new NativeError('malformed_value', 'This value cannot be sent to the table worker.', { category: 'conversion' });
}
const wireRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toWire(v)]));
const display = (v: unknown) => nativeDisplayValue(decodeValue(v));

interface Paged extends QueryResult { sql?: string; total?: number | null; raw: Obj }
type Receipt = { rows_changed: string; backup_path?: string; notices?: string[] };

/** A native document: reads (and, where the worker routes them, writes) go to dfv-table; nothing is answered locally except facts the open reply carries. */
export class NativeDocument implements DocumentFile {
  readonly fileKind: FileKind;
  readonly numberLocale: NumberLocaleReport | undefined;
  readonly openWarnings: readonly string[];
  onSaveNotice?: (notice: string) => void;
  private readonly active = new Set<AbortController>();
  private closing?: Promise<void>;
  private sourceRevision: string;
  // Display strings lose SQL types. Keep the bounded wire snapshot only while its result is reachable.
  private readonly diffSnapshots = new WeakMap<unknown[][], { columns: string[]; rows: unknown[][] }>();
  private constructor(private readonly client: NativeTableClient, private session: string, private readonly meta: Obj,
    private readonly reopen: () => Promise<Obj>, private readonly openArgs: Obj) {
    this.fileKind = meta.file_kind;
    this.sourceRevision = revision(meta.source_revision);
    this.openWarnings = meta.open_warnings;
    const l = meta.number_locale;
    this.numberLocale = isObj(l) ? { locale: l.locale ?? null, forced: l.forced === true, undecidable: l.undecidable ?? [], conflicting: l.conflicting === true } : undefined;
  }

  static async open(start: StartOptions, path: string, kind?: FileKind, options: DuckDbFileOpenOptions = {}, csvOnly = false): Promise<NativeDocument> {
    // The CSV profile is the narrow, already-qualified one: refuse before a worker is even started.
    if (csvOnly && ((kind !== undefined && kind !== 'csv') || extname(path).toLowerCase() !== '.csv'
      || options.siblingPath || options.numberLocale && options.numberLocale !== 'auto')) throw new NativeUnsupportedError('open', 'this native profile reads CSV files only');
    const client = await NativeTableClient.start(start);
    const args: Obj = { path };
    if (csvOnly || options.forceReadOnly) args.force_read_only = true;
    if (kind) args.force_kind = kind;
    if (options.numberLocale) args.number_locale = options.numberLocale;
    if (options.nullText) args.null_text = [...options.nullText];
    if (options.siblingPath) args.sibling_path = options.siblingPath;
    if (options.backupPath) args.backup_path = options.backupPath;
    if (options.sheetTables) args.sheet_tables = options.sheetTables;
    if (options.sheetTableCorrections) args.sheet_table_corrections = Object.fromEntries(Object.entries(options.sheetTableCorrections).map(([sheet, {manualTables, ...rest}]) =>
      [sheet, {...rest, ...(manualTables === undefined ? {} : {manual_tables: manualTables.map(({headerRow,...region}) => ({...region,header_row:headerRow}))})}]));
    const openSession = async () => {
      const o = obj(await client.call('open', args, { deadlineMs: QUERY_LIMITS.deadlineMs }));
      if (typeof o.session !== 'string' || !FILE_KINDS.has(o.file_kind) || typeof o.read_only !== 'boolean') throw malformed();
      strings(o.open_warnings);
      if (csvOnly && o.file_kind !== 'csv') throw new NativeUnsupportedError('open', 'this native profile reads CSV files only');
      return csvOnly || options.forceReadOnly ? { ...o, read_only: true } : o;
    };
    try {
      const meta = await openSession();
      return new NativeDocument(client, meta.session, meta, openSession, args);
    } catch (error) { await client.close(); throw error; }
  }

  private async controlled<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) throw new NativeError('not_open', 'This document is closed.');
    const control = new AbortController(); this.active.add(control);
    try { return await work(control.signal); } finally { this.active.delete(control); }
  }
  private routed(op: string) { return this.client.capabilities.methods.includes(op); }
  /** One routed call; an operation the worker does not advertise is refused here, before anything is sent. */
  private rpc(op: string, args: Obj, signal?: AbortSignal): Promise<unknown> {
    if (!this.routed(op)) throw new NativeUnsupportedError(op);
    return this.client.call(op, { session: this.session, ...args }, { signal, deadlineMs: QUERY_LIMITS.deadlineMs });
  }
  private read(op: string, args: Obj = {}): Promise<Obj> { return this.controlled(async signal => {
    const result=obj(await this.rpc(op,args,signal));
    if (result.workbook_metadata !== undefined) this.applyWorkbookMetadata(obj(result.workbook_metadata));
    return result;
  }); }

  // Facts the open reply carries (D1.9 read-metadata); absent fields take the answer a plain read-only table gives.
  isReadOnly() { return this.meta.read_only; }
  isReadOnlyByFormat() { return this.meta.read_only_by_format ?? true; }
  hasSibling() { return this.meta.has_sibling === true; }
  hasPendingSheets() { return this.meta.has_pending_sheets === true; }
  isWorksheet(name: string) { return Array.isArray(this.meta.worksheets) && this.meta.worksheets.includes(name); }
  getDetectedSheetTables(sheet: string): DetectedSheetTable[] {
    return (this.meta.detected_tables ?? []).filter((t: Obj) => t.sheet === sheet).map((t: Obj) => ({ ...camelKeys(t), rowCount: count(t.row_count) }));
  }
  getSheetPreparation(sheet: string) { return this.listSheetPreparation().find(s => s.sheet === sheet); }
  listSheetPreparation(): SheetPreparationStatus[] { return camelKeys(this.meta.sheet_preparation ?? []); }
  getPreparationMetrics(): PreparationMetrics {
    const m = this.meta.preparation_metrics;
    if (!isObj(m)) return new PreparationRecorder().snapshot({ cells: 0, objects: 0, maxCells: 0 });
    const out = camelKeys(m);
    for (const k of ['gridCells', 'gridDecodedBytes', 'cachedCells', 'cacheMaxCells', 'cacheEstimatedBytes']) out[k] = count(out[k]);
    if (out.cacheMaxBytes !== undefined) out.cacheMaxBytes=count(out.cacheMaxBytes);
    return out;
  }
  takeLateWarnings(): string[] { return []; }
  interruptCurrentQuery() { for (const control of this.active) control.abort(); }
  dispose() { void this.close().catch(() => {}); }
  close(): Promise<void> {
    if (!this.closing) { this.interruptCurrentQuery(); this.closing = this.client.close(); }
    return this.closing;
  }
  /** A new session is the refresh: the host reopens through its factory. */
  async refreshInPlace() { return false; }

  async retrySheetPreparation(sheet: string, manualTables?: readonly ManualSheetTable[]): Promise<SheetPreparationStatus | undefined> {
    if (!this.isWorksheet(sheet)) return undefined; // only worksheets have a preparation status to retry
    const r = await this.read('retrySheetPreparation', { sheet, ...(manualTables === undefined ? {} : {manual_tables: manualTables.map(({headerRow, ...region}) => ({...region,header_row:headerRow}))}) });
    const status = this.applyWorkbookMetadata(r, sheet);
    if (manualTables !== undefined) this.openArgs.sheet_table_corrections = {...this.openArgs.sheet_table_corrections,
      [sheet]: {...this.openArgs.sheet_table_corrections?.[sheet], manual_tables: manualTables.map(({headerRow,...region}) => ({...region,header_row:headerRow}))}};
    return status;
  }

  private applyWorkbookMetadata(r: Obj, sheet?: string): SheetPreparationStatus | undefined {
    if (!Array.isArray(r.detected_tables) || !Array.isArray(r.sheet_preparation) || typeof r.has_pending_sheets !== 'boolean') throw malformed();
    const statuses = r.sheet_preparation.map((value: unknown) => {
      const s = obj(value);
      if (typeof s.sheet !== 'string' || !['pending', 'ready', 'none', 'disabled', 'incomplete', 'bounded', 'cancelled', 'failed'].includes(s.state)
        || ![s.generation, s.tables, s.skipped].every(n => Number.isSafeInteger(n) && n >= 0) || typeof s.retryable !== 'boolean') throw malformed();
      return s;
    });
    for (const value of r.detected_tables) {
      const t = obj(value);
      if (typeof t.name !== 'string' || typeof t.sheet !== 'string') throw malformed();
      strings(t.columns); count(t.row_count);
      if (t.provenance !== undefined && (!['manual','explicit','heuristic'].includes(t.provenance)
        || typeof t.reason !== 'string' || typeof t.confidence !== 'number' || !Number.isFinite(t.confidence) || t.confidence < 0 || t.confidence > 1
        || ![t.top,t.bottom,t.left,t.right].every(n => Number.isSafeInteger(n) && n >= 0)
        || t.top >= t.bottom || t.left >= t.right || t.bottom > 1048576 || t.right > 16384
        || (t.header_row !== null && (!Number.isSafeInteger(t.header_row) || t.header_row < t.top || t.header_row >= t.bottom)))) throw malformed();
    }
    const status = r.status == null ? undefined : obj(r.status);
    if (status && ((sheet !== undefined && status.sheet !== sheet) || !statuses.some(s => ['sheet', 'state', 'generation', 'tables', 'skipped', 'retryable', 'message'].every(k => s[k] === status[k])))) throw malformed();
    // Replace the workbook snapshot only after the complete reply has been checked.
    let preparationMetrics: Obj | undefined;
    if (r.preparation_metrics !== undefined) {
      const metrics=obj(r.preparation_metrics);
      for (const key of ['grid_cells','grid_decoded_bytes','cached_cells','cache_max_cells','cache_estimated_bytes']) count(metrics[key]);
      if (metrics.cache_max_bytes !== undefined) count(metrics.cache_max_bytes);
      if (metrics.cache_accounting !== undefined && metrics.cache_accounting !== 'decoded-payload-v1') throw malformed();
      preparationMetrics=metrics;
    }
    Object.assign(this.meta, { detected_tables: r.detected_tables, sheet_preparation: statuses, has_pending_sheets: r.has_pending_sheets,
      ...(preparationMetrics === undefined ? {} : {preparation_metrics:preparationMetrics}) });
    return status ? camelKeys(status) : undefined;
  }

  async getQueryCatalog(offset = 0): Promise<QueryCatalogRelation[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw malformed();
    const result = await this.read('getQueryCatalog', { offset: offset.toString() });
    if (!Array.isArray(result.relations) || result.relations.length > 100) throw malformed();
    const detectedTables: DetectedSheetTable[] = (this.meta.worksheets ?? []).flatMap((sheet: string) => this.getDetectedSheetTables(sheet));
    return result.relations.map((r: Obj) => {
      if (!r || [r.catalog, r.schema, r.name, r.sql_name].some(v => typeof v !== 'string')) throw malformed();
      const detected = detectedTables.find(table => table.name === r.name);
      const rawWorksheet = this.isWorksheet(r.name);
      return {
        catalog: r.catalog, schema: r.schema, name: r.name, sqlName: r.sql_name, rawWorksheet,
        prepared: !rawWorksheet || this.getSheetPreparation(r.name)?.state !== 'pending',
        worksheet: detected?.sheet ?? (rawWorksheet ? r.name : undefined),
        bounds: detected ? { top: detected.top, bottom: detected.bottom, left: detected.left, right: detected.right } : undefined,
        range: detected ? `${columnLetters(detected.left)}${detected.top + 1}:${columnLetters(detected.right - 1)}${detected.bottom}` : undefined,
      };
    });
  }
  async getQueryColumns(catalog: string, schema: string, name: string): Promise<QueryColumn[]> {
    const { columns } = await this.read('getQueryColumns', { catalog, schema, name });
    if (!Array.isArray(columns) || columns.some((c: Obj) => typeof c?.name !== 'string' || typeof c.source_type !== 'string')) throw malformed();
    return columns.map((c: Obj) => ({ name: c.name, type: c.source_type }));
  }
  private async names(op: string): Promise<string[]> { return strings((await this.read(op)).names); }
  async listTables(): Promise<string[]> {
    if (this.routed('listTables')) return this.names('listTables');
    // The catalog is the same worker's answer, paged; a document with more than 5,000 relations is refused, not cut.
    const names: string[] = [];
    for (let offset = 0; offset <= 5000; offset += 100) {
      const relations = await this.getQueryCatalog(offset); names.push(...relations.map(r => r.name));
      if (names.length > 5000) break;
      if (relations.length < 100) return names;
    }
    throw new NativeError('resource_limit', 'The catalog exceeds 5,000 tables.');
  }
  async listSidebarTables() { return this.routed('listSidebarTables') ? this.names('listSidebarTables') : this.listTables(); }
  async listSiblingTables() { return this.hasSibling() || this.routed('listSiblingTables') ? this.names('listSiblingTables') : []; }
  async getCombinableTableNames() { return this.hasSibling() || this.routed('getCombinableTableNames') ? this.names('getCombinableTableNames') : []; }
  async buildCombinedQuery(table: string, limitN?: number) {
    const r = await this.read('buildCombinedQuery', { table, ...(limitN === undefined ? {} : { limit_n: String(limitN) }) });
    if (typeof r.sql !== 'string' || !(r.time_column === null || typeof r.time_column === 'string')) throw malformed();
    return { sql: r.sql, timeColumn: r.time_column as string | null };
  }
  async getPollCadenceSeconds(table: string): Promise<number | null> {
    if (this.fileKind === 'csv') return null; // a flat file carries no metadata table to read a cadence from
    const { seconds } = await this.read('getPollCadenceSeconds', { table });
    if (seconds !== null && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)) throw malformed();
    return seconds;
  }
  async getSeriesFrequency(table: string): Promise<SeriesFrequency | null> {
    if (this.fileKind === 'csv') return null;
    const { frequency } = await this.read('getSeriesFrequency', { table });
    if (frequency !== null && !['annual', 'semiannual', 'quarterly', 'monthly', 'weekly', 'daily'].includes(frequency)) throw malformed();
    return frequency;
  }
  async checkEditableSelect(sql: string, describeOnly = false): Promise<EditabilityInfo> {
    if (this.isReadOnly()) return { editable: false }; // a read-only document edits nothing, whatever the query
    const r = await this.read('checkEditableSelect', { sql, describe_only: describeOnly });
    if (typeof r.editable !== 'boolean') throw malformed();
    return { editable: r.editable, ...(r.table === undefined ? {} : { table: r.table }), ...(r.columns === undefined ? {} : { columns: strings(r.columns) }) };
  }

  /** Query-shaped call: every page is read and released, decoded exactly, and checked against the first for drift. */
  private paged(op: string, args: Obj, cap: number, unwrap: (raw: Obj) => unknown = raw => raw): Promise<Paged> {
    const maximum = op === 'runChartQuery' ? 200000 : 100000;
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > maximum) throw new NativeError('resource_limit',
      op === 'runChartQuery' ? 'A native chart supports at most 200,000 points.' : 'A native read supports at most 100,000 rows.',
      { category: 'resource' });
    return this.controlled(async signal => {
      let handle: string | undefined;
      try {
        const raw = obj(await this.rpc(op, { ...args, page_size: 1000 }, signal));
        let p = page(unwrap(raw));
        handle = p.resource.id;
        const columns = p.columns, rows: unknown[][] = [], truncated = p.page.truncated, sourceRevision = revision(p.resource.source_revision);
        const wireRows: unknown[][] | undefined = ['runQuery', 'runSortedQuery', 'runDetectedTableQuery'].includes(op) ? [] : undefined;
        let offset = 0;
        while (true) {
          if (p.resource.id !== handle || p.resource.source_revision !== sourceRevision || p.page.truncated !== truncated || JSON.stringify(p.columns) !== JSON.stringify(columns)) throw malformed();
          const decoded = decodeRows(p.rows);
          if (decoded.some(row => row.length !== columns.length) || rows.length + decoded.length > (cap || 100000)) throw malformed();
          rows.push(...decoded.map(row => row.map(nativeDisplayValue)));
          wireRows?.push(...p.rows as unknown[][]);
          if (p.page.next_offset === null) break;
          const next = Number(p.page.next_offset);
          if (!Number.isSafeInteger(next) || next <= offset || next !== rows.length) throw malformed();
          offset = next;
          p = page(await this.client.call('readResource', { resource: handle, offset: p.page.next_offset, page_size: 1000 }, { signal, deadlineMs: QUERY_LIMITS.deadlineMs }));
        }
        const first = page(unwrap(raw));
        if (signal.aborted || this.closing) throw new NativeError('cancelled', 'Cancelled.');
        if (raw.workbook_metadata !== undefined) this.applyWorkbookMetadata(obj(raw.workbook_metadata));
        if (wireRows) this.diffSnapshots.set(rows, { columns: columns.map(c => c.name), rows: wireRows });
        return { columns: columns.map(c => c.name), columnStatsKind: columns.map(c => c.stats_kind), rows, truncated,
          sql: first.sql, total: first.page.total_rows == null ? null : count(first.page.total_rows), raw };
      } finally { if (handle) await this.client.call('releaseResource', { resource: handle }).catch(() => {}); }
    });
  }
  private static result({ raw: _, sql: __, total: ___, ...result }: Paged): QueryResult { return result; }
  async runQuery(sql: string, maxRows = 0, selectedWorksheet?: string): Promise<QueryResult> {
    if (selectedWorksheet !== undefined && !this.isWorksheet(selectedWorksheet)) throw malformed();
    return NativeDocument.result(await this.paged('runQuery', { sql, max_rows: maxRows || 100000,
      ...(selectedWorksheet === undefined ? {} : { prepare_sheet: selectedWorksheet }) }, maxRows));
  }
  async runSortedQuery(baseSql: string, column: string, direction: 'asc' | 'desc', maxRows = 0): Promise<QueryResult & { sortedSql: string }> {
    const r = await this.paged('runSortedQuery', { sql: baseSql, column, direction, max_rows: maxRows || 100000 }, maxRows);
    if (typeof r.sql !== 'string') throw malformed();
    return { ...NativeDocument.result(r), sortedSql: r.sql };
  }
  async runChartQuery(baseSql: string, xColumn: string, yColumns: string[], xIsText = false, maxPoints = 0, xIsCategory = false, xIsRow = false, xAsDate = false, xAsValue = false): Promise<QueryResult & { xAxisMode: 'time' | 'category' | 'value'; note?: string }> {
    const pointLimit = maxPoints === 0 ? 200000 : maxPoints;
    const r = await this.paged('runChartQuery', {
      sql: baseSql, x_column: xColumn, y_columns: yColumns, x_is_text: xIsText, x_is_category: xIsCategory, max_points: pointLimit,
      ...(xIsRow ? { x_is_row: true } : {}), ...(xAsDate ? { x_as_date: true } : {}), ...(xAsValue ? { x_as_value: true } : {}),
    }, pointLimit, raw => raw.result);
    if (r.raw.x_axis_mode !== 'time' && r.raw.x_axis_mode !== 'category' && r.raw.x_axis_mode !== 'value') throw malformed();
    if (r.raw.note !== undefined && typeof r.raw.note !== 'string') throw malformed();
    return { ...NativeDocument.result(r), xAxisMode: r.raw.x_axis_mode, ...(r.raw.note === undefined ? {} : { note: r.raw.note }) };
  }
  async buildDetectedTableQuery(table: string, filters: readonly DetectedTableFilter[] = [], sort?: DetectedTableSort, limit = 0): Promise<string> {
    const r = await this.read('buildDetectedTableQuery', detectedArgs(table, filters, sort, limit));
    if (typeof r.sql !== 'string') throw malformed();
    return r.sql;
  }
  async runDetectedTableQuery(table: string, filters: readonly DetectedTableFilter[] = [], sort?: DetectedTableSort, limit = 0): Promise<DetectedTableQueryResult> {
    const r = await this.paged('runDetectedTableQuery', { ...detectedArgs(table, filters, sort, limit), max_rows: 100000 }, 0);
    if (typeof r.sql !== 'string') throw malformed();
    return { ...NativeDocument.result(r), sql: r.sql, totalRows: r.total ?? r.rows.length };
  }
  async countMatchingRows(sql: string): Promise<number | undefined> {
    try {
      const { count: n } = await this.read('countMatchingRows', { sql });
      return n === null ? undefined : count(n);
    } catch (error) {
      // A count is a nicety: a failed or cancelled one must not cost the rows. Unrouted and lost-worker errors still surface.
      if (error instanceof NativeError && !error.host && error.code !== 'unsupported') return undefined;
      throw error;
    }
  }
  async getColumnTopValues(baseSql: string, column: string, limit = 20): Promise<TopValuesStats> {
    const r = await this.read('getColumnTopValues', { sql: baseSql, column, limit });
    if (!Array.isArray(r.top_values)) throw malformed();
    return { totalRows: count(r.total_rows), nonNullRows: count(r.non_null_rows), nullCount: count(r.null_count), distinctCount: count(r.distinct_count),
      topValues: r.top_values.map((t: Obj) => ({ value: display(t.value), frequency: count(t.frequency) })) };
  }
  async getColumnDescriptiveStats(baseSql: string, column: string, statsKind: 'numeric' | 'datetime'): Promise<DescriptiveStats> {
    const r = await this.read('getColumnDescriptiveStats', { sql: baseSql, column, stats_kind: statsKind });
    return { totalRows: count(r.total_rows), nonNullRows: count(r.non_null_rows), nullCount: count(r.null_count),
      min: display(r.min), max: display(r.max), mean: display(r.mean), p5: display(r.p5), p95: display(r.p95) };
  }
  async compareToBackup(): Promise<Record<string, 'unchanged' | 'changed' | 'new'>> {
    const { tables } = await this.read('compareToBackup');
    if (!isObj(tables) || Object.values(tables).some(s => !['unchanged', 'changed', 'new'].includes(s))) throw malformed();
    return tables;
  }
  async diffQueryAgainstBackup(sql: string, liveColumns: string[], liveRows: unknown[][]): Promise<QueryDiff | null> {
    const snapshot = this.diffSnapshots.get(liveRows);
    const wireRows = liveRows.map((row, r) => row.map((value, c) => {
      const wire = snapshot?.rows[r]?.[c];
      return snapshot?.columns[c] === liveColumns[c] && wire !== undefined && isDeepStrictEqual(value, display(wire)) ? wire : toWire(value);
    }));
    const { diff } = await this.read('diffQueryAgainstBackup', { sql, live_columns: liveColumns, live_rows: wireRows });
    if (diff === null) return null;
    const d = obj(diff);
    if (!Array.isArray(d.cell_changed) || !Array.isArray(d.row_is_new) || !isObj(d.renamed_columns)) throw malformed();
    return { cellChanged: d.cell_changed, rowIsNew: d.row_is_new, renamedColumns: d.renamed_columns };
  }
  async locateXlsxEdit(table: string, column: string, rowValues: Record<string, unknown>) {
    const r = await this.read('locateXlsxEdit', { table, column, row_values: wireRow(rowValues) });
    const t = r.target;
    if (t == null) return { ...(typeof r.sha256 === 'string' ? { sha256: r.sha256 } : {}) };
    if (typeof t.sheet_path !== 'string' || typeof t.column_name !== 'string') throw malformed();
    return { target: { sheetPath: t.sheet_path, columnNames: strings(t.column_names), rowOrdinal: typeof t.row_ordinal === 'number' ? ordinal(t.row_ordinal) : count(t.row_ordinal), columnName: t.column_name },
      ...(typeof r.sha256 === 'string' ? { sha256: r.sha256 } : {}) };
  }

  // Writes. Sent once with a mutation id; if the outcome is unknown the id is asked about, never the write repeated.
  async createBackup(): Promise<string> {
    const receipt = await this.mutate('createBackup', {});
    if (typeof receipt.backup_path !== 'string') throw malformed();
    return receipt.backup_path;
  }
  async updateCell(table: string, column: string, newValue: unknown, rowValues: Record<string, unknown>, onStatus?: (message: string) => void): Promise<number> {
    if (this.isReadOnly()) throw new NativeUnsupportedError('updateCell', 'this document is read-only');
    if (!this.routed('updateCell')) throw new NativeUnsupportedError('updateCell');
    const args = { table, column, new_value: toWire(newValue), row_values: wireRow(rowValues) };
    const safeMode = await this.read('setSafeMode', { enabled: false, expected_revision: this.sourceRevision });
    if (safeMode.enabled !== false) throw new NativeError('policy_refused', 'The worker did not unlock editing.', { category: 'blocked', mutationOutcome: 'not-published' });
    onStatus?.('Saving...');
    const receipt = await this.mutate('updateCell', args);
    for (const notice of receipt.notices ?? []) this.onSaveNotice?.(notice);
    return count(receipt.rows_changed);
  }
  private async mutate(op: string, args: Obj): Promise<Receipt> {
    if (this.closing) throw new NativeError('not_open', 'This document is closed.', { mutationOutcome: 'not-published' });
    if (this.isReadOnly()) throw new NativeUnsupportedError(op, 'this document is read-only');
    if (!this.routed(op)) throw new NativeUnsupportedError(op);
    const id = randomUUID();
    try {
      return this.receipt(await this.client.call(op, { session: this.session, ...args, expected_revision: this.sourceRevision, mutation_id: id }, { mutation: true }));
    } catch (error) {
      if (!isUnconfirmed(error)) throw error;
      return this.reconcile(id, error);
    }
  }
  private receipt(v: unknown, currentSession = true): Receipt {
    try {
      const r = obj(v);
      if (!(r.outcome === 'published' || r.outcome === 'no_match')) throw malformed();
      count(r.rows_changed);
      if (r.notices !== undefined) strings(r.notices);
      if (r.source_after != null) {
        const after = revision(obj(r.source_after).revision);
        if (currentSession) this.sourceRevision = after;
      }
      return r as Receipt;
    } catch {
      throw new NativeError('malformed_value', 'The worker returned an invalid mutation receipt. The write outcome must be checked.', { category: 'conversion', mutationOutcome: 'unknown' });
    }
  }
  private async reconcile(id: string, cause: NativeError): Promise<Receipt> {
    if (!this.routed('queryMutationOutcome')) throw cause; // nothing can say what happened: the caller must look at the file
    try {
      const currentSession = this.client.alive;
      if (!this.client.alive) {
        await this.client.restart();
        const opened = await this.reopen();
        this.session = opened.session;
        this.sourceRevision = revision(opened.source_revision);
      }
      const r = obj(await this.client.call('queryMutationOutcome', { mutation_id: id }, { deadlineMs: QUERY_LIMITS.deadlineMs }));
      if (r.outcome === 'published') return this.receipt(r.receipt, currentSession);
      if (r.outcome === 'not-published') throw new NativeError('mutation_not_published', 'The worker confirmed the write did not happen.', { category: 'unknown', mutationOutcome: 'not-published' });
    } catch (error) { if (!(error instanceof NativeError) || error.mutationOutcome === 'not-published') throw error; }
    throw cause;
  }
}

function detectedArgs(table: string, filters: readonly DetectedTableFilter[], sort: DetectedTableSort | undefined, limit: number): Obj {
  return {
    table, filters: filters.map(f => ({ column: f.column, operator: f.operator, ...(f.value === undefined ? {} : { value: f.value }), ...(f.valueTo === undefined ? {} : { value_to: f.valueTo }) })),
    ...(sort ? { sort } : {}), ...(limit ? { limit: String(limit) } : {}),
  };
}

/** The qualified CSV profile (refuses everything else before starting a worker); kept for the existing provider binding. */
export { NativeDocument as NativeCsvDocument };
export const nativeCsvBackend = (start: StartOptions): BackendFactory => ({
  open: (path, kind, options) => NativeDocument.open(start, path, kind, options, true),
});
/** The general native backend: the worker decides which formats it opens and which operations it routes. */
export const nativeBackend = (start: StartOptions): BackendFactory => ({
  open: (path, kind, options) => NativeDocument.open(start, path, kind, options),
});
