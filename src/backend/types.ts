/** Reference-compatible public data contract. No backend implementation or host APIs. */
import type { QueryCatalogRelation, QueryColumn } from '../queryCatalog';
import type { SeriesFrequency } from '../chartSpec';
import type { NumberLocale } from '../numericLocale';
import type { TableCorrections } from '../sheetTables';
import type { RowSpan, ExcludedRow } from '../sheetRowMap';

export type StatsKind = 'numeric' | 'datetime' | 'other';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  columnStatsKind: StatsKind[];
  /** Set when a maxRows cap actually cut the result short (see runQuery). */
  truncated?: boolean;
}

/** A detected table's coordinates in the verbatim worksheet grid. */
export interface DetectedSheetTable {
  provenance?: 'manual' | 'explicit' | 'heuristic';
  confidence?: number;
  reason?: string;
  name: string;
  sheet: string;
  /** 0-based, inclusive/exclusive grid coordinates. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** 0-based worksheet-grid row, or null when the table has no promoted header. */
  headerRow: number | null;
  columns: string[];
  /** Kinds inferred from the worksheet grid already in memory; used only to gate inline controls. */
  columnStatsKind: StatsKind[];
  /**
   * The source-row map: exactly the grid rows that are this table's data rows,
   * in order. The derived query, the inline grid, stats, plots and edits all
   * read rows through it (sheetRowMap.ts).
   */
  dataRows: RowSpan[];
  /** Rows inside the rectangle below the header that are not data, and why. */
  excludedRows: ExcludedRow[];
  /** Always the number of rows `dataRows` describes. */
  rowCount: number;
}

export type DetectedTableFilterOperator =
  | 'contains'
  | 'equals'
  | 'notEquals'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'isBlank'
  | 'isNotBlank';

export interface DetectedTableFilter {
  column: string;
  operator: DetectedTableFilterOperator;
  value?: string;
  valueTo?: string;
}

export interface DetectedTableSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface DetectedTableQueryResult extends QueryResult {
  /** The exact SQL represented by rows, reused by stats and chart actions. */
  sql: string;
  /** Rows matching the filters before the display LIMIT. */
  totalRows: number;
}

export interface QueryDiff {
  cellChanged: boolean[][];
  rowIsNew: boolean[];
  renamedColumns: Record<string, string>;
}

export interface EditabilityInfo {
  editable: boolean;
  table?: string;
  columns?: string[];
}

export interface TopValuesStats {
  totalRows: number;
  nonNullRows: number;
  nullCount: number;
  distinctCount: number;
  topValues: { value: unknown; frequency: number }[];
}

export interface DescriptiveStats {
  totalRows: number;
  nonNullRows: number;
  nullCount: number;
  min: unknown;
  max: unknown;
  mean: unknown;
  p5: unknown;
  p95: unknown;
}

export type FileKind = 'duckdb' | 'parquet' | 'sqlite' | 'csv' | 'dta' | 'arrow' | 'feather' | 'xlsx' | 'kdb';

export interface DuckDbFileOpenOptions {
  /** Internal read-worker mode. Never populated from a webview message. */
  restrictedReads?: boolean;
  /** Internal: an existing backup created by this document's trusted save path. */
  backupPath?: string;
  /**
   * Internal: this instance is a one-shot writer that is disposed right after
   * its write (ViewerFile's trusted save path). Its in-memory tables are then
   * never read again, so an xlsx edit skips re-reading the edited sheet's
   * tables from the workbook -- measured at 1.3 s on a 21 MB workbook, spent
   * on state nobody looks at. The reader reopens from the file regardless.
   */
  discardAfterWrite?: boolean;
  /** Internal: SHA-256 of the workbook bytes the read worker opened (see locateXlsxEdit). */
  openedSha256?: string;
  /**
   * Internal: text-column decisions an earlier reader recorded, held in the
   * host's memory for the tab's life. Used only when `sha256` equals
   * `openedSha256`, and each one only for a table of the same shape.
   */
  textDecisions?: TextDecisionCache;
  /** Request read-only up front (live-refresh reconnects) instead of trying read-write first. */
  forceReadOnly?: boolean;
  /** Absolute path to the other half of a hot/cold pair, if one was found — see duckdbEditorProvider.ts's sibling detection. */
  siblingPath?: string;
  /**
   * Decimal convention for CSV. `"auto"` (the default) samples the file and
   * decides, refusing when the file carries no evidence. `"en"`/`"eu"` state
   * it outright, which is how a user resolves a column we declined to guess.
   * Mirrors ETL's NUMBER_LOCALE escape hatch.
   */
  numberLocale?: 'auto' | NumberLocale;
  /**
   * Cell values read as "no value here" — Excel's error markers. Defaults to
   * EXCEL_ERROR_TOKENS; an empty array turns the whole interpretation off and
   * shows the file's literal text, which is what makes it reversible.
   */
  nullText?: readonly string[];
  /**
   * Whether to look for tables INSIDE each sheet, and how.
   *
   * The sheet itself is always offered verbatim -- every declared row and
   * column, nothing promoted, nothing excluded, footnotes where the file puts
   * them. This only decides what is offered BESIDE it.
   *
   * `"grid"` (the default) splits a sheet on blank rows AND blank columns, so
   * two tables sitting side by side are two tables. `"rows"` splits on blank
   * rows only, which is what the ETL pipeline does. `"off"` offers the sheets
   * alone.
   */
  sheetTables?: SheetTableMode;
  /**
   * Explicit split/merge answers for sheets whose repeated-header blocks are
   * ambiguous, keyed by sheet name (see sheetTables.TableCorrections). Rows are
   * 0-based grid rows where the corrected block starts.
   */
  sheetTableCorrections?: Record<string, TableCorrections>;
  /** PERF-X1: time the read worker spent in workbook preflight before this open. */
  workbookPreflightMs?: number;
}

export type SheetTableMode = 'grid' | 'rows' | 'off';

/** Worksheet coordinates: top/left inclusive, bottom/right exclusive. */
export interface ManualSheetTable { top: number; bottom: number; left: number; right: number; headerRow: number | null }

/**
 * SAFE-X1: what table discovery on one worksheet actually concluded. The raw
 * sheet stays readable in every state; only `ready` and `none` are complete
 * answers, and only `none` may be shown as "no tables".
 *
 * - `pending`: not looked at yet (first use prepares it).
 * - `ready`: every detected table is offered.
 * - `none`: detection ran to completion and found no tables.
 * - `disabled`: detection is turned off by the `sheetTables` setting.
 * - `incomplete`: detection ran, but some detected tables could not be offered.
 * - `bounded`: the sheet exceeds the detection budget; nothing was looked for.
 * - `cancelled`: preparation was interrupted.
 * - `failed`: reading or detection threw; `message` says why.
 *
 * Failed and cancelled sheets are never retried automatically: an explicit
 * retry starts a fresh `generation`.
 */
export type SheetPreparationState = 'pending' | 'ready' | 'none' | 'disabled' | 'incomplete' | 'bounded' | 'cancelled' | 'failed';

/** PERF-X1 phases, timed separately (milliseconds). */
export type PreparationPhase =
  | 'workbookPreflight'   // ZIP budget + opening hash (read worker, before open)
  | 'sheetCatalog'        // listing sheets and their declared dimensions at open
  | 'sheetParse'          // materialising one selected sheet (read_xlsx into a table)
  | 'readGrid'            // decoding that sheet into JS for detection
  | 'detection'           // detector + per-table planning/binding
  | 'derivedPreparation'  // first use of a detected table (typed read + text checks)
  | 'catalog'             // building one query-catalog page
  | 'cacheRestore';       // re-materialising an evicted sheet/table

export interface PreparationMetrics {
  /** Accounted decoded payload, excluding compressed source bytes and process RSS. */
  cacheMaxBytes?: number;
  cacheAccounting?: 'decoded-payload-v1';
  phases: Partial<Record<PreparationPhase, { count: number; totalMs: number; maxMs: number; lastMs: number }>>;
  /** Detector runs; must equal the number of distinct sheets prepared (plus explicit retries). */
  detectorCalls: number;
  /** Cells and minimum JS bytes decoded for detection, summed over prepared sheets. */
  gridCells: number;
  gridDecodedBytes: number;
  /** Materialised workbook objects currently held, and the cap they are held under. */
  cachedCells: number;
  cachedObjects: number;
  cacheMaxCells: number;
  cacheEstimatedBytes: number;
  cacheEvictions: number;
  cacheRestores: number;
}

export interface SheetPreparationStatus {
  sheet: string;
  state: SheetPreparationState;
  /** 0 for the first attempt; each explicit retry increments it. */
  generation: number;
  /** Detected tables offered as SQL objects. */
  tables: number;
  /** Detected tables not offered (inconsistent source-row map or a view that could not be bound). */
  skipped: number;
  /** Human-readable reason for incomplete/bounded/cancelled/failed. */
  message?: string;
  /** Whether retrySheetPreparation can start a fresh attempt. */
  retryable: boolean;
}

/** What the locale sniff concluded, for the notice the viewer shows. */
export interface NumberLocaleReport {
  /** Applied convention, or null when the file needed no options. */
  locale: NumberLocale | null;
  /** `true` when the user stated it rather than us sniffing it. */
  forced: boolean;
  /** Columns left as text because nothing in them could break the tie. */
  undecidable: { column: string; samples: string[] }[];
  /** Set when different columns wanted different conventions. */
  conflicting: boolean;
}

/**
 * What interpretTextColumns decided for one table, without any cell values:
 * enough for a reader restarted on the same bytes (Cancel, a refresh with no
 * change, the reopen after a backup or a refused edit) to apply the same
 * reading without sampling and probing the whole table again -- 0.6 s on
 * YieldCurve's Raw_Data. Held in the host's memory only, for the life of the
 * tab (ViewerFile), and applied only to a table of exactly the same shape.
 */
export interface TextDecisionCache { sha256: string; tables: Record<string, unknown> }

/** One open dataset. Calls are serialized by its owning document/session.
 * Errors retain their concrete policy/worker/publication types. Writes are never retried.
 * A save-notice sink must survive UI closure until the trusted write settles.
 */
export interface DocumentFile {
  readonly fileKind: FileKind;
  readonly openWarnings: readonly string[];
  readonly numberLocale: NumberLocaleReport | undefined;
  /** Presence advertises a mutable sink; absence means this backend emits no save notices. */
  onSaveNotice?: (notice: string) => void;
  isReadOnly(): boolean;
  isReadOnlyByFormat(): boolean;
  hasSibling(): boolean;
  hasPendingSheets(): boolean;
  isWorksheet(name: string): boolean;
  getDetectedSheetTables(sheet: string): DetectedSheetTable[];
  /** SAFE-X1 table-discovery status of one worksheet; undefined for non-worksheets. */
  getSheetPreparation(sheet: string): SheetPreparationStatus | undefined;
  /** PERF-X1 preparation timings and cache counters for this document. */
  getPreparationMetrics(): PreparationMetrics;
  /** SAFE-X1 status of every worksheet that has one. */
  listSheetPreparation(): SheetPreparationStatus[];
  /** SAFE-X1: explicitly retry a failed, cancelled or incomplete sheet in a fresh generation. */
  retrySheetPreparation(sheet: string, manualTables?: readonly ManualSheetTable[]): Promise<SheetPreparationStatus | undefined>;
  takeLateWarnings(): string[];
  interruptCurrentQuery(): void;
  dispose(): void;
  refreshInPlace(): Promise<boolean>;
  listTables(): Promise<string[]>;
  getQueryCatalog(offset?: number): Promise<QueryCatalogRelation[]>;
  getQueryColumns(catalog: string, schema: string, name: string): Promise<QueryColumn[]>;
  locateXlsxEdit(table: string, column: string, rowValues: Record<string, unknown>): Promise<{
    target?: { sheetPath: string; columnNames: string[]; rowOrdinal: number; columnName: string };
    sha256?: string;
  }>;
  listSidebarTables(): Promise<string[]>;
  listSiblingTables(): Promise<string[]>;
  getCombinableTableNames(): Promise<string[]>;
  buildCombinedQuery(table: string, limitN?: number): Promise<{ sql: string; timeColumn: string | null }>;
  getPollCadenceSeconds(table: string): Promise<number | null>;
  getSeriesFrequency(table: string): Promise<SeriesFrequency | null>;
  buildDetectedTableQuery(table: string, filters?: readonly DetectedTableFilter[], sort?: DetectedTableSort, limit?: number): Promise<string>;
  runDetectedTableQuery(table: string, filters?: readonly DetectedTableFilter[], sort?: DetectedTableSort, limit?: number): Promise<DetectedTableQueryResult>;
  runQuery(sql: string, maxRows?: number, selectedWorksheet?: string): Promise<QueryResult>;
  runChartQuery(baseSql: string, xColumn: string, yColumns: string[], xIsText?: boolean, maxPoints?: number, xIsCategory?: boolean, xIsRow?: boolean, xAsDate?: boolean): Promise<QueryResult & { xAxisMode: 'time' | 'category'; note?: string }>;
  runSortedQuery(baseSql: string, column: string, direction: 'asc' | 'desc', maxRows?: number): Promise<QueryResult & { sortedSql: string }>;
  countMatchingRows(sql: string): Promise<number | undefined>;
  getColumnTopValues(baseSql: string, column: string, limit?: number): Promise<TopValuesStats>;
  getColumnDescriptiveStats(baseSql: string, column: string, statsKind: 'numeric' | 'datetime'): Promise<DescriptiveStats>;
  compareToBackup(): Promise<Record<string, 'unchanged' | 'changed' | 'new'>>;
  diffQueryAgainstBackup(sql: string, liveColumns: string[], liveRows: unknown[][]): Promise<QueryDiff | null>;
  checkEditableSelect(sql: string, describeOnly?: boolean): Promise<EditabilityInfo>;
  createBackup(): Promise<string>;
  updateCell(table: string, column: string, newValue: unknown, rowValues: Record<string, unknown>, onStatus?: (message: string) => void): Promise<number>;
}

/** A document captures this strategy once; refresh supplies fresh host settings. */
export interface BackendFactory {
  open(path: string, forceKind?: FileKind, options?: DuckDbFileOpenOptions): Promise<DocumentFile>;
}
