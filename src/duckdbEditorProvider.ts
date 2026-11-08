import * as vscode from 'vscode';
import { basename, dirname, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { open as fsOpen, readFile, stat, unlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import type { DescriptiveStats, DetectedTableFilter, DetectedTableSort, FileKind, QueryDiff, SheetTableMode, TopValuesStats } from './backend/types';
import { FNV_OFFSET_BASIS, fnv1aFold } from './contentSignature';
import { EXCEL_ERROR_TOKENS } from './textColumns';
import { ChartPanel } from './chartPanel';
import { pickPlotAxis, type AxisChoice } from './chartSpec';
import { destructiveReason, hasMultipleStatements } from './sqlSafety';
import { LiveRefreshController, LiveStatus } from './liveRefresh';
import type { BackendFactory, DocumentFile, ManualSheetTable } from './backend/types';
import { referenceBackend, referenceBackendFor } from './backend/reference';
import { DatasetSession } from './backend/session';
import { QUERY_LIMITS, QueryPolicyError } from './queryPolicy';
import { queryDiagnostic } from './queryDiagnostics';
import { validateQueryMessage } from './queryMessages';
import type { QueryTarget } from './queryCatalog';
import { SqlDraftStore } from './sqlDraftStore';
import { assertRangeReadWithinCells, parseCellRange, selectResultRange, tableFromRange, type RangeSnapshot } from './queryRange';
import { quoteIdent, baseTableOfSelect, hasTrailingLimit } from './backend/sql';

// Real, permanent debug channel rather than throwaway instrumentation — this
// feature accumulates enough internal state machinery (backoff phase,
// watcher health, stat-gate skip/hit, coalesced-vs-separate ticks, the
// auto-detect cache) that "why did my live view stop updating" is a
// realistic support question. Silent unless dataFileViewer.debugLiveRefresh
// is on.
const liveRefreshChannel = vscode.window.createOutputChannel('Data File Viewer: Live Refresh');

function isDebugLiveRefreshEnabled(): boolean {
  return vscode.workspace.getConfiguration('dataFileViewer').get<boolean>('debugLiveRefresh', false) === true;
}

function logLive(message: 'stat-gate skipped' | 'connection busy' | 'tick complete' | 'tick timeout' | 'scheduler event' | 'refresh started' | 'reconnect failed' | 'refresh stopped'): void {
  if (!isDebugLiveRefreshEnabled()) return;
  liveRefreshChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

// Whether opening a file should also preview its first table, rather than
// leaving an empty grid until something is clicked. Read per message rather
// than cached so toggling the setting takes effect on the next file opened.
function isPreviewFirstTableEnabled(): boolean {
  return vscode.workspace.getConfiguration('dataFileViewer').get<boolean>('previewFirstTableOnOpen', true) !== false;
}

// Decimal convention for CSV. "auto" sniffs and refuses when the file carries
// no evidence; "en"/"eu" state it outright, which is how a user resolves a
// column the sniff declined to guess. Read per open, so changing it and
// reopening the file is the whole workflow.
function numberLocaleSetting(): 'auto' | 'en' | 'eu' {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<string>('numberLocale', 'auto');
  return value === 'en' || value === 'eu' ? value : 'auto';
}

// Cell text that means "no value here" — Excel's error markers. Read per open
// like the locale above, so setting it to [] and reopening shows the file's
// literal text, which is what makes the interpretation reversible rather than
// merely announced.
function nullTextSetting(): readonly string[] {
  const value = vscode.workspace
    .getConfiguration('dataFileViewer')
    .get<unknown>('nullText', EXCEL_ERROR_TOKENS as unknown as string[]);
  // An explicit [] is a real answer and must survive; only a non-array (a
  // hand-edited settings.json with a string in it) falls back to the default.
  if (!Array.isArray(value)) return EXCEL_ERROR_TOKENS;
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/** Whether to look for tables inside a sheet, and how; see DuckDbFileOpenOptions. */
function sheetTablesSetting(): SheetTableMode {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<unknown>('sheetTables', 'grid');
  return value === 'rows' || value === 'off' ? value : 'grid';
}

// Most points a chart will draw. This is the viewer's OWN ceiling, not the
// query's: a LIMIT you typed is honoured by runChartQuery and plotted in full.
// This cap exists for the query that has no limit and matches ten million rows,
// and it is refused rather than applied, with the true count reported --
// silently drawing the first N would be a chart of a query nobody wrote.
function getChartMaxPoints(): number {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<number>('chartMaxPoints', 200_000);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 200_000;
}

function getGlobalLiveRefreshIntervalMs(): number {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<number>('liveRefreshIntervalMs', 2000);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(250, value) : 2000;
}

// The refresh-interval value shown/edited in the UI (and any auto-detected
// sheet_metadata hint) is exactly as untrusted as the table/column names
// handled elsewhere in this extension — clamp/type-check before it can ever
// reach the tick engine, so a corrupt or crafted value can't bypass the
// floor the rest of the design relies on to avoid tight-loop refreshing.
function clampIntervalMs(candidateMs: unknown): number {
  const n = typeof candidateMs === 'number' && Number.isFinite(candidateMs) ? candidateMs : NaN;
  return Number.isFinite(n) && n > 0 ? Math.max(250, n) : getGlobalLiveRefreshIntervalMs();
}

function inlineFilters(value: unknown): DetectedTableFilter[] {
  if (!Array.isArray(value)) return [];
  const operators = new Set([
    'contains', 'equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'between', 'isBlank', 'isNotBlank',
  ]);
  return value.flatMap((item): DetectedTableFilter[] => {
    if (typeof item !== 'object' || item === null) return [];
    const candidate = item as Partial<DetectedTableFilter>;
    if (typeof candidate.column !== 'string' || !operators.has(String(candidate.operator))) return [];
    if (candidate.value !== undefined && typeof candidate.value !== 'string') return [];
    if (candidate.valueTo !== undefined && typeof candidate.valueTo !== 'string') return [];
    return [{
      column: candidate.column,
      operator: candidate.operator!,
      value: candidate.value,
      valueTo: candidate.valueTo,
    }];
  }).slice(0, 100);
}

function inlineSort(value: unknown): DetectedTableSort | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DetectedTableSort>;
  if (typeof candidate.column !== 'string') return undefined;
  if (candidate.direction !== 'asc' && candidate.direction !== 'desc') return undefined;
  return { column: candidate.column, direction: candidate.direction };
}

function inlineLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, 100_000)
    : 100;
}

// A UX nicety, not a security boundary: the read-only reconnect used for
// every live tick is what actually prevents a write from executing, so this
// only needs to catch the common case well enough to produce a clear error
// instead of a confusing stale/backoff spiral — no need for a real SQL
// parser here. Kept deliberately narrower than Safe Mode's allowlist (no
// explain/describe/show), but it does share the multi-statement check: a
// leading "select" is exactly as easy to satisfy with `select 1; drop table
// x` here as it was there.
function looksReadOnly(sql: string): boolean {
  const t = sql.trim().toLowerCase();
  if (hasMultipleStatements(sql)) return false;
  return t.startsWith('select') || t.startsWith('with');
}

function getWalCandidatesFor(filePath: string): string[] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.sqlite') || lower.endsWith('.db')) {
    // WAL mode: the main file's mtime often doesn't move until a
    // checkpoint, so the -wal file is what actually tracks freshness.
    return [`${filePath}-wal`, `${filePath}-shm`];
  }
  if (lower.endsWith('.duckdb')) {
    // DuckDB checkpoints through its own WAL file before flushing to the
    // main file — same under-reported-freshness risk applies symmetrically
    // here, not just on the SQLite side.
    return [`${filePath}.wal`];
  }
  return [];
}

function watchPathsFor(primaryPath: string, siblingPath: string | undefined): string[] {
  const paths = [primaryPath, ...getWalCandidatesFor(primaryPath)];
  if (siblingPath) paths.push(siblingPath, ...getWalCandidatesFor(siblingPath));
  return paths;
}

interface FileStat {
  mtimeMs: number;
  size: number;
  /** Catches an atomic write-then-rename whose replacement happens to land on the same mtime and size. */
  ino: number;
}

async function statAll(paths: string[]): Promise<Map<string, FileStat>> {
  const map = new Map<string, FileStat>();
  await Promise.all(
    paths.map(async (p) => {
      try {
        const s = await stat(p);
        map.set(p, { mtimeMs: s.mtimeMs, size: s.size, ino: Number(s.ino) });
      } catch {
        // Doesn't exist yet (no WAL file, or no sibling) — absence is
        // itself a valid, comparable state below.
      }
    })
  );
  return map;
}

function statsChanged(prev: Map<string, FileStat> | undefined, next: Map<string, FileStat>): boolean {
  if (!prev) return true;
  const keys = new Set([...prev.keys(), ...next.keys()]);
  for (const key of keys) {
    const a = prev.get(key);
    const b = next.get(key);
    if (!a || !b) return true; // appeared or disappeared
    if (a.mtimeMs !== b.mtimeMs || a.size !== b.size || a.ino !== b.ino) return true;
  }
  return false;
}

// Sentinels for hashRows below: no cell rendered by String()/JSON.stringify can
// contain a control character, so the data can never forge a cell or row
// boundary and collide with a genuinely different result.
const NULL_MARK = String.fromCharCode(0);
const CELL_MARK_A = String.fromCharCode(1);
const CELL_MARK_B = String.fromCharCode(2);
const ROW_MARK_A = String.fromCharCode(3);
const ROW_MARK_B = String.fromCharCode(4);

/**
 * Cheap content signature for the "skip the repost if unchanged" check — only
 * computed below a size threshold (see runLiveTick).
 *
 * Folded cell by cell rather than over one `JSON.stringify` of the whole
 * result: that allocated a multi-megabyte transient string on every tick,
 * which is a strange price to pay for deciding whether to *avoid* sending
 * data. Two lanes (different seeds, different delimiters) rather than one,
 * since a single 32-bit signature over a few thousand rows is thin enough
 * that a silently-missed update becomes plausible across a long session.
 */
function hashRows(rows: unknown[][]): string {
  let h1 = FNV_OFFSET_BASIS;
  let h2 = 0x9dc5811c;
  for (const row of rows) {
    for (const value of row) {
      const s =
        value === null || value === undefined
          ? NULL_MARK
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
      // Distinct delimiters per lane, so the two don't avalanche identically
      // despite sharing a fold.
      h1 = fnv1aFold(fnv1aFold(h1, s), CELL_MARK_A);
      h2 = fnv1aFold(fnv1aFold(h2, s), CELL_MARK_B);
    }
    h1 = fnv1aFold(h1, ROW_MARK_A);
    h2 = fnv1aFold(h2, ROW_MARK_B);
  }
  return `${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}
const HASH_ROW_THRESHOLD = 5000;

/**
 * Sibling detection for the combined hot+cold view: filename-convention
 * based (there's no dialog step to supply a second path — VS Code's custom
 * editor API only ever hands the extension one URI on open), trying both
 * naming conventions this codebase's own writers use
 * (`<base>.sqlite`/`<base>.duckdb` same-basename, or `<base>_hot.sqlite`
 * suffix) and using whichever candidate actually exists on disk. Verifies
 * the resolved path is still within the same directory (guards against a
 * symlink swapped in between this check and the caller's later ATTACH)
 * before returning it — the file itself being a valid database is verified
 * separately, by DuckDbFile.open's own attach-and-probe fallback.
 */
/**
 * Filename patterns for the hot half of a hot/cold pair, `{base}` standing
 * for the cold file's basename.
 *
 * Declarative because the writer's naming is not this extension's to fix in
 * place: trading_project sets SQLITE_HOT_NAME = "auto" (config_trading.py),
 * so a rename there would silently end live updates here with nothing to
 * change but a hardcoded string. The setting is the seam.
 */
const DEFAULT_HOT_PATTERNS = ['{base}.sqlite', '{base}_hot.sqlite'];

function hotFilePatterns(): string[] {
  const configured = vscode.workspace
    .getConfiguration('dataFileViewer')
    .get<string[]>('hotFilePatterns', DEFAULT_HOT_PATTERNS);
  const usable = Array.isArray(configured) ? configured.filter((p) => typeof p === 'string' && p.includes('{base}')) : [];
  return usable.length > 0 ? usable : DEFAULT_HOT_PATTERNS;
}

/** Every path that would have counted as this file's partner, tried in order. */
function siblingCandidates(fsPath: string): string[] {
  const dir = dirname(fsPath);
  const ext = extname(fsPath);
  const lowerExt = ext.toLowerCase();
  const base = basename(fsPath, ext);

  // Cold half opened: look for the hot half by pattern.
  if (lowerExt === '.duckdb') {
    return hotFilePatterns().map((p) => join(dir, p.replace('{base}', base)));
  }

  // Hot half opened: look for the cold half. Derived by inverting the same
  // patterns, so a custom pattern keeps working in this direction too rather
  // than only the one it was written for.
  if (lowerExt === '.sqlite' || lowerExt === '.db') {
    const out = [join(dir, `${base}.duckdb`)];
    for (const pattern of hotFilePatterns()) {
      const [prefix, suffixWithExt] = pattern.split('{base}');
      const suffix = suffixWithExt?.replace(/\.[^.]*$/, '') ?? '';
      if (base.startsWith(prefix) && base.endsWith(suffix) && (prefix || suffix)) {
        const coldBase = base.slice(prefix.length, base.length - suffix.length);
        if (coldBase) out.push(join(dir, `${coldBase}.duckdb`));
      }
    }
    return out;
  }
  return [];
}

function resolveSiblingPath(fsPath: string): string | undefined {
  const dir = dirname(fsPath);
  for (const candidate of siblingCandidates(fsPath)) {
    if (isVerifiedSiblingPath(dir, candidate)) return candidate;
  }
  return undefined;
}

function isVerifiedSiblingPath(expectedDir: string, candidate: string): boolean {
  try {
    if (!existsSync(candidate)) return false;
    return dirname(realpathSync(candidate)) === realpathSync(expectedDir);
  } catch {
    return false;
  }
}

// Above this many rows, the automatic post-query diff against the backup
// (an O(rows) comparison) is skipped by default — see the runQuery and
// sortQuery handlers below. User-configurable via
// dataFileViewer.diffRowThreshold; read live (not cached) so a settings
// change takes effect immediately without a window reload.
function getDiffRowThreshold(): number {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<number>('diffRowThreshold', 50_000);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 50_000;
}

// 0 (the default) means uncapped, i.e. exactly what this extension did before
// the setting existed. Anything unparseable falls back to uncapped too --
// silently showing fewer rows than the data has would be the worse failure.
function getMaxResultRows(): number {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<number>('maxResultRows', 0);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Cross-process (specifically cross-VS-Code-window) file lock for kinds
 * that DuckDB itself doesn't natively lock (.csv/.parquet — see
 * openFlatFilePaths below for the same-window guard this backstops).
 * PID-aware rather than purely presence-based, so a lock file left behind
 * by a crashed VS Code window self-heals on the next open instead of
 * requiring a manual force-clear.
 */
function releaseFileLockSync(lockPath: string): void {
  unlink(lockPath).catch(() => {});
}

async function acquireFileLock(path: string): Promise<() => void> {
  const lockPath = `${path}.dfv.lock`;

  const tryAcquire = async (): Promise<void> => {
    const handle = await fsOpen(lockPath, 'wx'); // atomically fails if it already exists
    await handle.writeFile(String(process.pid));
    await handle.close();
  };

  try {
    await tryAcquire();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    let stale = false;
    try {
      const pid = Number((await readFile(lockPath, 'utf8')).trim());
      if (!Number.isInteger(pid)) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0); // sends no signal, just tests whether the process exists
        } catch {
          stale = true;
        }
      }
    } catch {
      // Lock file vanished between the EEXIST and reading it (raced with
      // another process releasing it) — safe to just retry acquiring.
      stale = true;
    }

    if (!stale) {
      throw new Error(
        `${basename(
          path
        )} is already open in another VS Code window — this file type has no native lock, so a second window could silently overwrite edits from the first. Close the other window first.`
      );
    }
    releaseFileLockSync(lockPath);
    await tryAcquire();
  }

  return () => releaseFileLockSync(lockPath);
}

// Exported for the stress suite, which drives the document directly rather
// than through the extension host: the connection lock, the stats cache and
// the sibling resolution below are the parts with no coverage, and they are
// all reachable from an instance. Nothing outside this file constructs one.
export class DuckDBDocument implements vscode.CustomDocument {
  private tablesCache: string[] | undefined;
  queryCatalogGeneration = 0;
  readonly queryTargets = new Map<string, QueryTarget>();
  activeQueryRequest = 0;
  rangeSnapshot: { value: RangeSnapshot; stats: Map<string, FileStat> } | undefined;
  readonly manualSheetTables = new Map<string, { tables: ManualSheetTable[]; stats: Map<string, FileStat> }>();
  // name (e.g. "orders_combined") -> the synthesized SQL that entry runs.
  combinedQueryMap = new Map<string, string>();

  safeMode = true;
  backupBeforeWrite = true;
  checkForChanges = true;
  hasBackup = false;

  // Set by the runQuery handler after each run, so columnStats/updateCell
  // (which don't carry the SQL text themselves) know what to re-run/target,
  // and so editability is always server-derived, never trusted from the webview.
  lastSql: string | undefined;
  lastEditableTable: string | undefined;
  lastEditableColumns: string[] | undefined;
  // The base table behind lastSql, whether from a plain single-table SELECT
  // or a synthesized `_combined` query — used to look up the poll-cadence
  // auto-detect hint. Distinct from lastEditableTable since a `_combined`
  // query is never "editable" but still has a meaningful base table.
  lastQueriedBaseTable: string | undefined;
  /** Set only when the grid is the untouched worksheet preview with valid coordinates. */
  lastSheetPreview: string | undefined;
  /** The webview's selection sequence that produced lastSheetPreview. */
  lastSheetPreviewSeq: number | undefined;
  /**
   * The sidebar entry the user explicitly chose, set the moment the request
   * arrives. Independent of the result kind: SQL the user runs leaves it as it
   * is, but never gains worksheet coordinates from it. `hostSeq` orders
   * choices on this side; `clientSeq` is the webview's own, echoed back.
   */
  worksheetSelection: { sheet: string; clientSeq: number | undefined; hostSeq: number; generation: number; worksheet: boolean } | undefined;
  private worksheetSelectionCounter = 0;
  /**
   * Increments, under the query lock, for every query a result is posted
   * for (user/sidebar runs and live ticks), so the view can tell which of two
   * results describes the source later, whatever order they arrive in.
   */
  executionSeq = 0;

  selectWorksheet(sheet: string, clientSeq: number | undefined): number {
    const hostSeq = ++this.worksheetSelectionCounter;
    this.worksheetSelection = { sheet, clientSeq, hostSeq, generation: this.queryCatalogGeneration, worksheet: this.file.isWorksheet(sheet) };
    return hostSeq;
  }

  /**
   * After the source was re-read: a selected worksheet the new source no
   * longer has is cleared, with its coordinates. Returns true when that
   * happened, so the caller refreshes the sidebar (which clears the view's
   * choice too). Only a metadata lookup, so it costs a live tick nothing.
   */
  clearVanishedWorksheet(): boolean {
    const selection = this.worksheetSelection;
    if (!selection?.worksheet || this.file.isWorksheet(selection.sheet)) return false;
    this.worksheetSelection = undefined;
    this.lastSheetPreview = undefined;
    this.lastSheetPreviewSeq = undefined;
    return true;
  }

  // Keyed by `${statsKind}:${column}` — cleared whenever a new query runs,
  // since stats are scoped to the current base query.
  readonly statsCache = new Map<string, TopValuesStats | DescriptiveStats>();
  private static readonly MAX_STATS_CACHE_ENTRIES = 50;

  // Live-refresh state.
  liveRefreshEnabled = false;
  liveRefreshIntervalMs = 2000;
  liveRefreshController: LiveRefreshController | undefined;
  lastFileStats: Map<string, FileStat> | undefined;
  lastResultRowCount: number | undefined;
  lastResultHash: string | undefined;
  /** Source stats taken just before Live last opened the reader. */
  liveReaderStats: Map<string, FileStat> | undefined;

  /**
   * The query Live refreshes from now on. The screen no longer shows the last
   * tick's rows, so the next tick must not call identical rows "unchanged".
   */
  setLiveQuery(sql: string, sheetPreview: string | undefined, sheetPreviewSeq: number | undefined): void {
    this.lastSql = sql;
    this.lastSheetPreview = sheetPreview;
    this.lastSheetPreviewSeq = sheetPreview !== undefined ? sheetPreviewSeq : undefined;
    this.lastResultRowCount = undefined;
    this.lastResultHash = undefined;
  }
  // Cached per base table so repeated toggle-off/toggle-on within the same
  // session doesn't re-read sheet_metadata each time. `null` is a cached
  // "checked, no hint found" — distinct from `undefined` ("not checked yet").
  pollCadenceCache: number | null | undefined;
  pollCadenceCacheTable: string | undefined;
  get disposed(): boolean { return this.session.closed; }

  // Sibling resolution costs an existsSync plus two realpathSync per candidate,
  // and the live path was paying for it twice per tick. Cached, but re-checked
  // periodically rather than once for the session: a cold file appearing
  // partway through is exactly the kind of thing live mode exists to notice.
  private siblingPathCache: string | undefined;
  private siblingPathCheckedAt = 0;
  private static readonly SIBLING_RECHECK_MS = 30_000;

  readonly session: DatasetSession;

  constructor(
    readonly uri: vscode.Uri,
    file: DocumentFile,
    private readonly onDispose?: () => void,
    /** Set only for kinds that can't be sniffed from the path (kdb+), so a live reconnect re-opens as the right kind. */
    readonly forceKind?: FileKind,
    /** Capture the backend strategy once, preserving deliberate raw reference injection. */
    readonly backend: BackendFactory = referenceBackendFor(file)
  ) {
    this.session = new DatasetSession(file, backend, {
      authorize: () => {
        if (vscode.workspace.isTrusted === false) throw new QueryPolicyError('Trust this workspace before opening datasets or running queries.');
      },
      onSaveNotice: notice => { void vscode.window.showWarningMessage(`${basename(this.uri.fsPath)}: ${notice}`); },
      onClosing: () => {
        this.worksheetSelection = undefined;
        this.lastSheetPreview = undefined;
        this.lastSheetPreviewSeq = undefined;
        try { this.liveRefreshController?.dispose(); }
        finally { this.liveRefreshController = undefined; }
      },
      beforeDispose: file => {
        if (!this.hasBackup || !this.checkForChanges || vscode.workspace.isTrusted === false) return;
        return this.reportChangesOnClose(file);
      },
      onDisposed: () => {
        this.manualSheetTables.clear();
        this.queryTargets.clear(); this.combinedQueryMap.clear(); this.statsCache.clear();
        this.lastSql = undefined; this.lastEditableColumns = undefined;
        this.onDispose?.();
      },
    });
  }

  get file(): DocumentFile { return this.session.file; }
  set file(next: DocumentFile) { this.session.file = next; }
  isBusy(): boolean { return this.session.isBusy(); }

  /** Queue and authorization are owned by the host-free dataset session. */
  runExclusive<T>(fn: () => Promise<T>, isSuperseded?: () => boolean): Promise<T> {
    return this.session.runExclusive(fn, isSuperseded);
  }

  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    return this.session.tryRunExclusive(fn);
  }

  private async reportChangesOnClose(file: DocumentFile): Promise<void> {
    const entries = Object.entries(await file.compareToBackup());
    const changed = entries.filter(([, status]) => status !== 'unchanged');
    if (entries.length) vscode.window.showInformationMessage(
      changed.length ? `${basename(this.uri.fsPath)}: ${changed.length} of ${entries.length} table(s) changed since backup.`
        : `${basename(this.uri.fsPath)}: no changes since backup.`
    );
  }

  getSiblingPath(): string | undefined {
    // kdb+ tables are extensionless and standalone — there's no naming
    // convention to pair them off by.
    if (this.forceKind === 'kdb') return undefined;
    const now = Date.now();
    if (now - this.siblingPathCheckedAt >= DuckDBDocument.SIBLING_RECHECK_MS) {
      this.siblingPathCache = resolveSiblingPath(this.uri.fsPath);
      this.siblingPathCheckedAt = now;
    }
    return this.siblingPathCache;
  }

  invalidateTablesCache(): void {
    this.rangeSnapshot = undefined;
    this.tablesCache = undefined;
    this.queryCatalogGeneration++;
    this.queryTargets.clear();
  }

  async queryCatalogPage(cursor = 0): Promise<{ targets: QueryTarget[]; generation: number; nextCursor?: number }> {
    const relations = await this.file.getQueryCatalog(cursor);
    const targets = relations.map(relation => {
      const existing = [...this.queryTargets.values()].find(target =>
        target.catalog === relation.catalog && target.schema === relation.schema && target.name === relation.name);
      const target = { ...relation, id: existing?.id ?? randomBytes(16).toString('hex'), generation: this.queryCatalogGeneration };
      this.queryTargets.set(target.id, target);
      return target;
    });
    if (this.queryTargets.size > 5000) throw new QueryPolicyError('The query catalog exceeds 5,000 targets.');
    const result = { targets, generation: this.queryCatalogGeneration, nextCursor: relations.length === 100 ? cursor + 100 : undefined };
    if (Buffer.byteLength(JSON.stringify(result)) > QUERY_LIMITS.catalogBytes) throw new QueryPolicyError('The catalog page exceeds 1 MiB.');
    return result;
  }

  queryTarget(id: string, generation: number): QueryTarget {
    const target = this.queryTargets.get(id);
    if (generation !== this.queryCatalogGeneration || !target) throw new QueryPolicyError('The query target changed. Select it again.');
    return target;
  }

  // Capped insert — cheap insurance against unbounded growth if caching
  // ever extends beyond "cleared on every new query" in the future.
  setStatsCache(key: string, value: TopValuesStats | DescriptiveStats): void {
    if (this.statsCache.size >= DuckDBDocument.MAX_STATS_CACHE_ENTRIES && !this.statsCache.has(key)) {
      const oldestKey = this.statsCache.keys().next().value; // Map preserves insertion order
      if (oldestKey !== undefined) this.statsCache.delete(oldestKey);
    }
    this.statsCache.set(key, value);
  }

  async getTables(): Promise<string[]> {
    if (this.tablesCache) return this.tablesCache;

    const ownTables = await this.file.listSidebarTables();
    this.combinedQueryMap.clear();
    const combinable = await this.file.getCombinableTableNames().catch(() => [] as string[]);
    const combinedNames: string[] = [];
    for (const table of combinable) {
      try {
        const { sql } = await this.file.buildCombinedQuery(table);
        const name = `${table}_combined`;
        this.combinedQueryMap.set(sql, table);
        combinedNames.push(name);
      } catch {
        // Best-effort — a table that fails to build a combined query (e.g.
        // an introspection error) just doesn't get a synthesized entry.
      }
    }

    this.tablesCache = [...ownTables, ...combinedNames];
    return this.tablesCache;
  }

  dispose(): void { this.rangeSnapshot = undefined; void this.session.close(); }

}

/**
 * Reconnects a document's underlying file, swapping `document.file` to a
 * fresh connection — used both for the initial live-tick reconnect and for
 * restoring a normal (read-write-attempting) connection when Live turns
 * off. DuckDB's single-connection model isn't built for observing another
 * process's commits made after the connection opened, so this is the
 * mechanism live mode relies on to actually see fresh writes (mirrors
 * dashboard.py's own `_read_cold_with_retry`/`_cold_connection` pattern in
 * trading_project, which reconnects fresh on every read for the same
 * reason).
 */
async function reconnectDocument(document: DuckDBDocument, forceReadOnly: boolean): Promise<void> {
  const sourceStats = await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath()));
  let cleared = false;
  for (const [sheet, selection] of document.manualSheetTables) {
    if (statsChanged(selection.stats, sourceStats)) { document.manualSheetTables.delete(sheet); cleared = true; }
  }
  if (cleared) void vscode.window.showWarningMessage('The workbook changed. Manual table selections were cleared; select the ranges again.');
  await document.session.reopen(document.uri.fsPath, document.forceKind, forceReadOnly, () => ({
    siblingPath: document.getSiblingPath(),
    numberLocale: numberLocaleSetting(),
    nullText: nullTextSetting(),
    sheetTables: sheetTablesSetting(),
    sheetTableCorrections: Object.fromEntries([...document.manualSheetTables].map(([sheet, selection]) => [sheet, { manualTables: selection.tables }])),
  }), () => document.invalidateTablesCache());
  if (document.manualSheetTables.size && statsChanged(sourceStats, await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath())))) {
    document.manualSheetTables.clear();
    void vscode.window.showWarningMessage('The workbook changed while reopening. Manual table selections were cleared; select the ranges again.');
    await document.session.reopen(document.uri.fsPath, document.forceKind, forceReadOnly, () => ({
      siblingPath: document.getSiblingPath(), numberLocale: numberLocaleSetting(), nullText: nullTextSetting(), sheetTables: sheetTablesSetting(),
    }), () => document.invalidateTablesCache());
  }
}

async function runLiveTick(document: DuckDBDocument, webview: vscode.Webview, generation: number): Promise<void> {
  const label = basename(document.uri.fsPath);
  const queryOwner = document.activeQueryRequest;
  // A tick abandoned at its deadline can still settle later. Nothing it
  // computed may reach the view after that point — the scheduler has already
  // moved on, and a late post would overwrite fresher data with older data.
  const isCurrent = () =>
    !document.disposed && queryOwner === document.activeQueryRequest && document.liveRefreshController?.isCurrentGeneration(generation) === true;

  const paths = watchPathsFor(document.uri.fsPath, document.getSiblingPath());
  const stats = await statAll(paths);

  if (!statsChanged(document.lastFileStats, stats)) {
    logLive('stat-gate skipped');
    if (isCurrent()) {
      webview.postMessage({ command: 'liveTick', lastUpdatedMs: Date.now(), unchanged: true });
    }
    return;
  }

  const outcome = await document.tryRunExclusive(async () => {
    await reconnectDocument(document, true);
    document.liveReaderStats = stats;
    // A replaced source can drop the selected sheet. Tell the view before
    // anything else, so it never keeps that sheet selected or editable.
    if (!document.disposed && document.clearVanishedWorksheet()) {
      const tables = await document.getTables();
      if (isCurrent()) {
        webview.postMessage({
          command: 'tables',
          tables,
          combinedTableNames: [...document.combinedQueryMap.values()].map((table) => `${table}_combined`),
          previewFirst: false,
        });
      }
    }
    // dispose() can fire while the reconnect is in flight, in which case
    // reconnectDocument deliberately declines to install the new connection —
    // leaving document.file as the one dispose() just closed. Querying that is
    // a use-after-close in native code, not a catchable error.
    const sql = document.lastSql;
    if (document.disposed || !sql) return undefined;
    // Same cap as the manual run that produced lastSql, so a live tick can't
    // quietly return a different number of rows than the view it's refreshing.
    // What the rows describe is captured with the query, under the lock: a
    // sidebar choice that runs after this section must not relabel them.
    const sheetPreview = document.lastSheetPreview;
    const selectionSeq = sheetPreview ? document.lastSheetPreviewSeq : undefined;
    const executionSeq = ++document.executionSeq;
    return { sql, sheetPreview, selectionSeq, executionSeq, result: await document.file.runQuery(sql, getMaxResultRows(), sheetPreview) };
  });

  if (!outcome.ran) {
    // A user-initiated query holds the connection. Not a failure — deliberately
    // not counted as one, since it says nothing about the file's health.
    logLive('connection busy');
    return;
  }
  if (outcome.value === undefined || !isCurrent()) return;
  const { sql, sheetPreview, selectionSeq, executionSeq, result } = outcome.value;

  const rowCount = result.rows.length;
  const shouldHash = rowCount <= HASH_ROW_THRESHOLD;
  const newHash = shouldHash ? hashRows(result.rows) : undefined;
  const unchanged = shouldHash && document.lastResultRowCount === rowCount && newHash === document.lastResultHash;
  document.lastResultRowCount = rowCount;
  document.lastResultHash = newHash;

  // Committed only now that the tick has actually succeeded. Recording it up
  // front meant a query that then threw still advanced the gate, so the next
  // tick saw "no change on disk" and skipped — leaving the grid frozen on old
  // data until the file happened to change again.
  document.lastFileStats = stats;

  logLive('tick complete');

  if (unchanged) {
    webview.postMessage({ command: 'liveTick', lastUpdatedMs: Date.now(), unchanged: true });
    return;
  }

  // The underlying data moved, so any cached column stats describe a result
  // that no longer exists.
  document.statsCache.clear();

  webview.postMessage({
    command: 'liveTick',
    lastUpdatedMs: Date.now(),
    unchanged: false,
    result: {
      ...result,
      diffSkipped: false,
      hasLimit: hasTrailingLimit(sql),
      editable: false,
      editableTable: undefined,
      serverSorted: false,
      sheetPreview,
      sheetTables: sheetPreview ? document.file.getDetectedSheetTables(sheetPreview) : undefined,
      sheetPreparation: sheetPreview ? document.file.getSheetPreparation(sheetPreview) : undefined,
      // The choice these rows were previewed for, so a view that has since
      // chosen another sheet can tell they are not its rows.
      selectionSeq,
      executionSeq,
    },
  });
}

/**
 * Send the footer its "of N" total, once it is known.
 *
 * Posted as a follow-up rather than folded into the queryResult above,
 * because the count is a SECOND execution of the query without its LIMIT.
 * `select * from big limit 100` returns instantly and its count does not, so
 * blocking the grid on it would make every limited query feel as slow as the
 * unlimited one it was written to avoid. The rows land first and the total
 * fills in behind them.
 *
 * Skipped entirely when the rows in hand already are the total: no trailing
 * LIMIT and nothing cut by maxResultRows means the count is `rows.length`,
 * and re-running the whole query to rediscover a number we have would be the
 * expensive way to learn nothing.
 */
async function reportRowTotal(
  document: DuckDBDocument,
  webview: vscode.Webview,
  sql: string,
  result: { rows: unknown[][]; truncated?: boolean }
): Promise<void> {
  const couldBeMore = result.truncated === true || hasTrailingLimit(sql);
  if (!couldBeMore) {
    webview.postMessage({ command: 'rowTotal', sql, total: result.rows.length });
    return;
  }
  const total = await document.runExclusive(() => document.file.countMatchingRows(sql)).catch(() => undefined);
  if (total === undefined) return;
  // The user may have run something else while the count was in flight; a
  // stale total under a newer result would be worse than none at all. The
  // webview checks this against the query the footer belongs to.
  webview.postMessage({ command: 'rowTotal', sql, total });
}

async function startLiveRefresh(
  document: DuckDBDocument,
  webview: vscode.Webview,
  requestedIntervalMs: number | undefined
): Promise<void> {
  const label = basename(document.uri.fsPath);

  let suggestedSeconds: number | null = null;
  if (document.lastQueriedBaseTable) {
    if (document.pollCadenceCacheTable !== document.lastQueriedBaseTable) {
      const table = document.lastQueriedBaseTable;
      document.pollCadenceCache = await document
        .runExclusive(() => document.file.getPollCadenceSeconds(table))
        .catch(() => null);
      document.pollCadenceCacheTable = table;
    }
    suggestedSeconds = document.pollCadenceCache ?? null;
  }

  const intervalMs = clampIntervalMs(requestedIntervalMs ?? (suggestedSeconds ? suggestedSeconds * 1000 : undefined));
  document.liveRefreshEnabled = true;
  document.liveRefreshIntervalMs = intervalMs;
  document.lastFileStats = undefined;
  document.lastResultRowCount = undefined;
  document.lastResultHash = undefined;

  // Reconnect immediately, read-only — this is also what locks out cell
  // editing the moment Live turns on (checkEditableSelect already refuses
  // to edit a read-only connection), rather than deferring the read-only
  // switch until the first tick.
  await document.runExclusive(async () => {
    const stats = await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath()));
    await reconnectDocument(document, true);
    document.liveReaderStats = stats;
  });
  if (document.disposed) return;

  document.liveRefreshController?.dispose();
  const controller = new LiveRefreshController(intervalMs, {
    onTick: (generation) => runLiveTick(document, webview, generation),
    // The scheduler has given up waiting; unblock whatever the connection is
    // stuck on so the next tick has a chance of getting through. Best-effort
    // by design — the scheduler doesn't wait for this to take effect.
    onTimeout: () => {
      logLive('tick timeout');
      try {
        document.file.interruptCurrentQuery();
      } catch {
        // The connection may already be closed/swapped; nothing to interrupt.
      }
    },
    onStatus: (status) => postLiveStatus(webview, status),
    onLog: () => logLive('scheduler event'),
  });
  document.liveRefreshController = controller;

  // Whether anything is actually writing alongside this file. Without it the
  // status line reported a healthy "Live · waiting for first update…" forever
  // on a file with no partner -- see liveStatus.ts.
  const candidates = siblingCandidates(document.uri.fsPath);
  webview.postMessage({
    command: 'liveRefreshStarted',
    intervalMs,
    suggestedIntervalSeconds: suggestedSeconds,
    hasSource: document.file.hasSibling(),
    sourceLookedFor: candidates.map((c) => basename(c)).join(', '),
  });
  logLive('refresh started');

  // start() schedules the first tick at delay 0. Running one directly here as
  // well used to produce two concurrent first ticks, each reconnecting and
  // disposing the connection the other had just installed.
  controller.start(watchPathsFor(document.uri.fsPath, document.getSiblingPath()));
}

function postLiveStatus(webview: vscode.Webview, status: LiveStatus): void {
  webview.postMessage({
    command: 'liveStatus',
    stale: status.stale,
    failureCount: status.failureCount,
    lastError: status.lastError ? queryDiagnostic(new Error(status.lastError)).message : undefined,
    lastSuccessMs: status.lastSuccessMs,
  });
}

async function stopLiveRefresh(document: DuckDBDocument, webview: vscode.Webview): Promise<void> {
  document.liveRefreshEnabled = false;
  document.liveRefreshController?.dispose();
  document.liveRefreshController = undefined;

  let restoredWritable = true;
  try {
    await document.runExclusive(() => reconnectDocument(document, false));
  } catch (err) {
    // The writer still holds the lock. The read-only connection is still
    // perfectly usable for browsing, so keep it — but say so, rather than
    // leaving the user with silently-disabled editing and a generic error.
    restoredWritable = false;
    logLive('reconnect failed');
  }
  if (document.disposed) return;

  webview.postMessage({
    command: 'liveRefreshStopped',
    readOnly: !restoredWritable || document.file.isReadOnly(),
  });
  logLive('refresh stopped');
}

export class DuckDBEditorProvider implements vscode.CustomReadonlyEditorProvider<DuckDBDocument> {
  public static readonly viewType = 'dataFileViewer.editor';
  // .db is a genuinely ambiguous extension (plenty of non-SQLite formats use
  // it), so it stays "option" priority in package.json -- opt-in per file
  // rather than silently claiming every .db on the system. .sqlite has no
  // such ambiguity, so it gets its own viewType registered at "default"
  // priority instead, so it opens automatically like .duckdb/.parquet/.csv.
  public static readonly sqliteViewType = 'dataFileViewer.sqliteEditor';
  public static readonly sqliteDefaultViewType = 'dataFileViewer.sqliteEditorDefault';
  // kdb+ table files are extensionless (see kdbParser.ts) and their names are
  // pipeline-specific (Raw_Data, used_YieldCurve, ...), so there's no stable
  // filename pattern to associate by default or offer in "Open With" the
  // normal way. This viewType exists purely to be invoked programmatically —
  // package.json gives it a harmless catch-all "option"-priority selector,
  // and the real entry point is the dataFileViewer.openKdbFile command below
  // (bound to the Explorer context menu, scoped to *_kdb/ folders).
  public static readonly kdbViewType = 'dataFileViewer.kdbEditor';

  static register(context: vscode.ExtensionContext, backend?: BackendFactory): vscode.Disposable {
    const provider = new DuckDBEditorProvider(context, backend);
    const registerOptions = {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    };
    const kdbProvider: vscode.CustomReadonlyEditorProvider<DuckDBDocument> = {
      openCustomDocument: (uri) => provider.openKdbDocument(uri),
      resolveCustomEditor: (document, panel) => provider.resolveCustomEditor(document, panel),
    };
    return vscode.Disposable.from(
      liveRefreshChannel,
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.viewType, provider, registerOptions),
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.sqliteViewType, provider, registerOptions),
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.sqliteDefaultViewType, provider, registerOptions),
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.kdbViewType, kdbProvider, registerOptions),
      vscode.commands.registerCommand('dataFileViewer.openKdbFile', (uri: vscode.Uri) =>
        vscode.commands.executeCommand('vscode.openWith', uri, DuckDBEditorProvider.kdbViewType)
      )
    );
  }

  // Unlike .duckdb (direct open) and .db/.sqlite (ATTACH), DuckDB doesn't
  // put any file-level lock on .parquet/.csv/.dta — they're read into a
  // :memory: instance, so nothing today stops opening the same path in two tabs, each
  // with its own independent copy and no lock-conflict warning. That's fine
  // for read-only browsing, but with cell editing now writing back to these
  // files, two tabs editing the same path would silently last-write-wins.
  // Guard it the same way the existing DuckDB-native lock error already
  // reads, scoped to just these kinds since duckdb/sqlite already have their
  // own (better — graceful read-only fallback) protection via DuckDbFile.open().
  private readonly openFlatFilePaths = new Set<string>();

  /** User SQL drafts per document; outlives any one editor tab. */
  private readonly sqlDrafts: SqlDraftStore;

  // Legacy direct test harnesses keep their reference default; activation always injects selectBackend.
  constructor(private readonly context: vscode.ExtensionContext, private readonly backend: BackendFactory = referenceBackend) {
    this.sqlDrafts = new SqlDraftStore(context.workspaceState);
  }

  async openCustomDocument(uri: vscode.Uri): Promise<DuckDBDocument> {
    return this.openDocumentInternal(uri);
  }

  /** Entry point for the kdb+ viewType (see register() above) — no filename pattern to sniff a kind from. */
  async openKdbDocument(uri: vscode.Uri): Promise<DuckDBDocument> {
    return this.openDocumentInternal(uri, 'kdb');
  }

  private async openDocumentInternal(uri: vscode.Uri, forceKind?: FileKind): Promise<DuckDBDocument> {
    const isFlatFile = forceKind === undefined && /\.(parquet|csv|dta|arrows?)$/i.test(uri.fsPath);
    if (isFlatFile && this.openFlatFilePaths.has(uri.fsPath)) {
      const message = `${basename(
        uri.fsPath
      )} is already open in another tab — this file type has no native lock, so a second tab could silently overwrite edits from the first. Close the other tab first.`;
      vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    let releaseLock: (() => void) | undefined;
    try {
      // In-memory openFlatFilePaths above catches same-window double-opens
      // fast, without touching the filesystem; this lock is the backstop
      // for a second VS Code *window*, which gets its own process and
      // wouldn't see that in-memory guard at all.
      if (isFlatFile) releaseLock = await acquireFileLock(uri.fsPath);

      const siblingPath = forceKind === 'kdb' ? undefined : resolveSiblingPath(uri.fsPath);
      if (vscode.workspace.isTrusted === false) throw new QueryPolicyError('Trust this workspace before opening datasets or running queries.');
      const file = await this.backend.open(uri.fsPath, forceKind, {
        siblingPath,
        numberLocale: numberLocaleSetting(),
        nullText: nullTextSetting(),
        sheetTables: sheetTablesSetting(),
      });
      // A format that opens read-only by design says why in its own open
      // warning below; "already open elsewhere" would be wrong about it.
      if (file.isReadOnly() && !file.isReadOnlyByFormat()) {
        vscode.window.showWarningMessage(
          `${basename(uri.fsPath)}: opened read-only — this file is already open elsewhere. Edits will fail until the other handle is released.`
        );
      }
      // Said at open, once, rather than left for the user to notice as a blank
      // cell and wonder about. The file is fine and usable — this is about
      // what is IN it.
      for (const warning of file.openWarnings) {
        vscode.window.showWarningMessage(`${basename(uri.fsPath)}: ${warning}`);
      }
      if (isFlatFile) this.openFlatFilePaths.add(uri.fsPath);
      return new DuckDBDocument(
        uri,
        file,
        isFlatFile
          ? () => {
              this.openFlatFilePaths.delete(uri.fsPath);
              releaseLock?.();
            }
          : undefined,
        // Carried so a live reconnect re-opens as the same kind. kdb+ files are
        // extensionless, so without this the reconnect would sniff the path,
        // find nothing, and try to open a kdb+ table as a DuckDB database.
        forceKind,
        this.backend
      );
    } catch (err) {
      releaseLock?.();
      const message = queryDiagnostic(err).message;
      vscode.window.showErrorMessage(message);
      throw err;
    }
  }

  async resolveCustomEditor(
    document: DuckDBDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css')
    );
    webview.html = getHtml(webview, scriptUri, styleUri);

    // Ordering is enforced by document.runExclusive rather than a boolean
    // guard: the old flag only covered messages from this webview, so it said
    // nothing about the live tick, which uses the same connection and disposes
    // it on reconnect. User-initiated work queues (never silently dropped);
    // live ticks yield (see tryRunExclusive).
    type IncomingPayload =
      | { command: 'ready' }
      | { command: 'runQuery'; sql: string; sheetPreview?: string; selectionSeq?: number }
      | { command: 'queryRange'; range: string; token: number; offset?: number }
      | { command: 'useRangeAsTable'; range: string; token: number; headerRow: number | null }
      | { command: 'invalidateRange' }
      | { command: 'saveSqlDraft'; sql: string }
      | { command: 'queryCatalog'; cursor?: number }
      | { command: 'queryTarget' | 'queryTargetSql'; targetId: string; generation: number }
      | { command: 'sheetTableSql'; table: string; filters: DetectedTableFilter[]; sort?: DetectedTableSort; limit: number; generation: number }
      | { command: 'cancelQuery' }
      | { command: 'diffQuery' }
      | { command: 'sortQuery'; column: string; direction: 'asc' | 'desc' }
      | { command: 'toggleSafeMode'; safeMode: boolean; backupBeforeWrite: boolean; checkForChanges: boolean }
      | { command: 'columnStats'; column: string; statsKind: 'numeric' | 'datetime' | 'other'; limit?: number }
      | { command: 'updateCell'; column: string; newValue: unknown; rowValues: Record<string, unknown> }
      | { command: 'toggleLiveRefresh'; enabled: boolean; intervalMs?: number }
      | { command: 'setLiveRefreshInterval'; intervalMs: number }
      | { command: 'runCombinedQuery'; table: string }
      | { command: 'retrySheetPreparation'; sheet: string }
      | { command: 'chartQuery'; xColumn: string; xIsText: boolean; xIsCategory?: boolean; xIsRow?: boolean; xDateColumn?: string; xIsValue?: boolean; refresh?: boolean; yColumns: string[] }
      | {
          command: 'sheetTableQuery';
          table: string;
          filters: DetectedTableFilter[];
          sort?: DetectedTableSort;
          limit: number;
        }
      | {
          command: 'sheetTableStats';
          table: string;
          column: string;
          filters: DetectedTableFilter[];
          sort?: DetectedTableSort;
          limit: number;
        }
      | {
          command: 'sheetTableChart';
          table: string;
          column: string;
          refresh?: boolean;
          xColumn?: string;
          xIsRow?: boolean;
          xDateColumn?: string;
          filters: DetectedTableFilter[];
          sort?: DetectedTableSort;
          limit: number;
        };

    // One chart tab per TABLE, created on that table's first plot click.
    //
    // Plotting another column of the same table still replaces that table's
    // chart -- the reason for reusing a panel is that a column clicked by
    // mistake should not have to be tidied up afterwards, and that is about
    // columns. Two tables are a different matter: a workbook sheet now offers
    // its secondary tables as objects of their own, and "plot this one, then
    // plot that one, and look at both" is the whole point of that.
    const chartPanels = new Map<string, ChartPanel>();

    type IncomingMessage = IncomingPayload & { requestId?: number };
    const hostWebview = webview;
    let lastRequestId = 0;
    const messageSub = webview.onDidReceiveMessage(async (message: IncomingMessage) => {
      const queryCommands = ['runQuery', 'runCombinedQuery', 'sortQuery', 'queryRange', 'useRangeAsTable'];
      let owner = document.activeQueryRequest;
      const webview = new Proxy(hostWebview, {
        get(target, property) {
          if (property === 'postMessage') return (payload: Record<string, unknown>) => {
            const sensitive = ['queryResult', 'sortQueryResult', 'queryRangeResult', 'rowTotal', 'error', 'columnStatsResult', 'columnStatsError', 'cellUpdated', 'cellUpdateError'];
            if (document.disposed || (sensitive.includes(String(payload.command)) && owner !== document.activeQueryRequest)) return Promise.resolve(false);
            return target.postMessage({ ...payload, requestId: message?.requestId });
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.command !== 'string' || document.disposed) return;
      try { validateQueryMessage(message); }
      catch (error) { webview.postMessage({ command: 'error', message: queryDiagnostic(error).message }); return; }
      if (message.requestId !== undefined) {
        if (message.requestId <= lastRequestId) {
          webview.postMessage({ command: 'error', message: 'This request has expired. Repeat the action from the current view.' });
          return;
        }
        lastRequestId = message.requestId;
      }
      if (queryCommands.includes(message.command)) owner = ++document.activeQueryRequest;
      if (['runQuery', 'runCombinedQuery', 'sortQuery', 'sheetTableQuery', 'updateCell', 'retrySheetPreparation', 'toggleLiveRefresh', 'queryTarget', 'queryTargetSql'].includes(message.command)) document.rangeSnapshot = undefined;
      const superseded = () => owner !== document.activeQueryRequest;
      if (vscode.workspace.isTrusted === false) {
        webview.postMessage({ command: 'error', message: 'Trust this workspace before opening datasets or running queries.' });
        return;
      }
      if (message.command === 'invalidateRange') { document.rangeSnapshot = undefined; return; }
      if (message.command === 'queryRange') {
        try {
          const result = await document.runExclusive(async () => {
            const captured = document.rangeSnapshot;
            if (!captured || document.liveRefreshEnabled || captured.value.context.token !== message.token || statsChanged(captured.stats, await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath())))) {
              document.rangeSnapshot = undefined;
              throw new QueryPolicyError('This result or source has changed. Run the query and select the range again.');
            }
            // The worker also validates its immutable source generation before serving a read.
            await document.file.runQuery('SELECT 1', 1);
            const rectangle = parseCellRange(message.range);
            if (captured.value.worksheet && rectangle.lastRow > captured.value.result.rows.length) {
              const rowLimit = getMaxResultRows();
              if (rowLimit > 0 && rectangle.lastRow > rowLimit) throw new QueryPolicyError('The range exceeds the configured result-row limit. Choose a smaller rectangle.');
              assertRangeReadWithinCells(rectangle.lastRow, captured.value.result.columns.length);
              // Sidebar previews may contain only 100 rows; raw worksheet order still has exact cell coordinates.
              const sourceSql = `SELECT * FROM ${quoteIdent(captured.value.worksheet)} LIMIT ${rectangle.lastRow}`;
              const expanded = await document.file.runQuery(sourceSql, rectangle.lastRow);
              if (statsChanged(captured.stats, await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath())))) {
                document.rangeSnapshot = undefined;
                throw new QueryPolicyError('The source changed. Open the worksheet and select the range again.');
              }
              captured.value.result = expanded;
              captured.value.sql = sourceSql;
              captured.value.context.rows = expanded.rows.length;
            }
            return selectResultRange(captured.value, message.token, message.range, message.offset ?? 0);
          }, superseded);
          webview.postMessage({ command: 'queryRangeResult', ...result });
        } catch (error) { webview.postMessage({ command: 'queryRangeResult', error: queryDiagnostic(error).message, token: message.token }); }
        return;
      }
      if (message.command === 'useRangeAsTable') {
        try {
          const result = await document.runExclusive(async () => {
            const captured = document.rangeSnapshot;
            if (!captured || document.liveRefreshEnabled || statsChanged(captured.stats, await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath())))) {
              document.rangeSnapshot = undefined;
              throw new QueryPolicyError('The source or result changed. Preview the worksheet range again.');
            }
            const table = tableFromRange(captured.value, message.token, message.range, message.headerRow);
            const sheet = captured.value.worksheet!;
            if (!document.file.isWorksheet(sheet)) throw new QueryPolicyError('That worksheet is no longer in the file.');
            await document.file.runQuery('SELECT 1', 1);
            const previous = document.file.getDetectedSheetTables(sheet).filter(t => t.provenance === 'manual'
              && !(t.top < table.bottom && table.top < t.bottom && t.left < table.right && table.left < t.right));
            const manualTables = [...previous.map(t => ({
              top: t.top, bottom: t.bottom, left: t.left, right: t.right, headerRow: t.headerRow,
            })), table];
            const status = await document.file.retrySheetPreparation(sheet, manualTables);
            document.manualSheetTables.set(sheet, { tables: manualTables, stats: captured.stats });
            document.invalidateTablesCache();
            document.statsCache.clear();
            return { sheet, status, tables: await document.getTables() };
          }, superseded);
          webview.postMessage({ command: 'sheetPreparationRetried', sheet: result.sheet, status: result.status });
          webview.postMessage({ command: 'tables', tables: result.tables,
            combinedTableNames: [...document.combinedQueryMap.values()].map(t => `${t}_combined`), previewFirst: false });
        } catch (error) { webview.postMessage({ command: 'error', message: queryDiagnostic(error).message }); }
        return;
      }
      if (message.command === 'queryCatalog') {
        try {
          const catalog = await document.runExclusive(() => document.queryCatalogPage(message.cursor ?? 0));
          webview.postMessage({ command: 'queryCatalog', ...catalog, cursor: message.cursor ?? 0 });
        } catch (error) { webview.postMessage({ command: 'error', message: queryDiagnostic(error).message }); }
        return;
      }
      if (message.command === 'queryTarget' || message.command === 'queryTargetSql') {
        try {
          const details = await document.runExclusive(async () => {
            const target = document.queryTarget(message.targetId, message.generation);
            const columns = await document.file.getQueryColumns(target.catalog, target.schema, target.name);
            return { target, columns };
          });
          webview.postMessage({ command: 'queryTargetDetails', ...details });
          if (message.command === 'queryTargetSql') webview.postMessage({
            command: 'querySqlDraft', target: details.target, sql: `SELECT *\nFROM ${details.target.sqlName}\nLIMIT 100;`,
          });
          const catalog = await document.runExclusive(() => document.queryCatalogPage());
          webview.postMessage({ command: 'queryCatalog', ...catalog, cursor: 0 });
        } catch (error) { webview.postMessage({ command: 'error', message: queryDiagnostic(error).message }); }
        return;
      }
      if (message.command === 'sheetTableSql') {
        try {
          const draft = await document.runExclusive(async () => {
            if (message.generation !== document.queryCatalogGeneration) throw new QueryPolicyError('The worksheet changed. Select the table again.');
            const sql = await document.file.buildDetectedTableQuery(message.table, message.filters, message.sort, message.limit);
            let cursor = 0;
            let target: QueryTarget | undefined;
            do {
              const page = await document.queryCatalogPage(cursor);
              target = page.targets.find(target => target.name === message.table && target.worksheet);
              if (target || page.nextCursor === undefined) break;
              cursor = page.nextCursor;
            } while (cursor < 5000);
            if (!target) throw new QueryPolicyError('The detected table is no longer available.');
            const columns = await document.file.getQueryColumns(target.catalog, target.schema, target.name);
            return { sql, target, columns };
          });
          webview.postMessage({ command: 'queryTargetDetails', target: draft.target, columns: draft.columns });
          webview.postMessage({ command: 'querySqlDraft', sql: draft.sql, target: draft.target });
        } catch (error) { webview.postMessage({ command: 'error', message: queryDiagnostic(error).message }); }
        return;
      }
      if (message.command === 'retrySheetPreparation') {
        // SAFE-X1: an explicit, user-requested retry of one worksheet's table
        // discovery. Never automatic; the reply says what the fresh attempt found.
        try {
          const status = await document.runExclusive(async () => {
            if (!document.file.isWorksheet(message.sheet)) throw new QueryPolicyError('That worksheet is no longer in the file.');
            return document.file.retrySheetPreparation(message.sheet);
          });
          webview.postMessage({ command: 'sheetPreparationRetried', sheet: message.sheet, status });
          const tables = await document.runExclusive(() => document.getTables());
          webview.postMessage({
            command: 'tables', tables,
            combinedTableNames: [...document.combinedQueryMap.values()].map((t) => `${t}_combined`),
            previewFirst: false,
          });
        } catch (error) { webview.postMessage({ command: 'error', message: queryDiagnostic(error).message }); }
        return;
      }
      if (message.command === 'saveSqlDraft') {
        this.sqlDrafts.set(document.uri.toString(), message.sql);
        return;
      }
      if (message.command === 'ready') {
        // Before the sidebar: the webview must hold the draft before anything
        // can auto-preview, so nothing ever has a chance to replace it.
        const draft = this.sqlDrafts.get(document.uri.toString());
        if (draft !== undefined) webview.postMessage({ command: 'sqlDraft', sql: draft });
        try {
          const tables = await document.runExclusive(() => document.getTables());
          webview.postMessage({
            command: 'tables',
            tables,
            combinedTableNames: [...document.combinedQueryMap.values()].map((table) => `${table}_combined`),
            previewFirst: isPreviewFirstTableEnabled(),
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: queryDiagnostic(err).message });
        }
        return;
      }

      if (message.command === 'cancelQuery') {
        // Deliberately not gated by `running` — cancelling only makes sense
        // while something is in flight, and interrupting an idle connection
        // is harmless (DuckDB just has nothing to stop).
        document.file.interruptCurrentQuery();
        return;
      }

      if (message.command === 'toggleLiveRefresh') {
        if (message.enabled) {
          if (!document.lastSql || !looksReadOnly(document.lastSql)) {
            webview.postMessage({
              command: 'liveRefreshRejected',
              reason: 'Live requires a read-only query — run a SELECT first.',
            });
            return;
          }
          try {
            await startLiveRefresh(document, webview, message.intervalMs);
          } catch (err) {
            webview.postMessage({ command: 'error', message: queryDiagnostic(err).message });
          }
        } else {
          try {
            await stopLiveRefresh(document, webview);
          } catch (err) {
            webview.postMessage({ command: 'error', message: queryDiagnostic(err).message });
          }
        }
        return;
      }

      if (message.command === 'setLiveRefreshInterval') {
        if (!document.liveRefreshEnabled || !document.liveRefreshController) return;
        const intervalMs = clampIntervalMs(message.intervalMs);
        document.liveRefreshIntervalMs = intervalMs;
        document.liveRefreshController.setIntervalMs(intervalMs);
        webview.postMessage({ command: 'liveRefreshIntervalSet', intervalMs });
        return;
      }

      if (message.command === 'runCombinedQuery') {
        try {
          const { sql, timeColumn, result } = await document.runExclusive(async () => {
            const built = await document.file.buildCombinedQuery(message.table);
            document.setLiveQuery(built.sql, undefined, undefined);
            document.lastQueriedBaseTable = message.table;
            document.combinedQueryMap.set(built.sql, message.table);
            document.statsCache.clear();
            return { ...built, result: await document.file.runQuery(built.sql, getMaxResultRows()) };
          }, superseded);
          // Never editable — a UNION/subquery, not a plain single-table
          // SELECT, independent of Live state (checkEditableSelect's own
          // structural gate already excludes it; this just avoids the
          // round-trip to re-derive that for a query the extension itself
          // built and already knows the shape of).
          document.lastEditableTable = undefined;
          document.lastEditableColumns = undefined;

          webview.postMessage({
            command: 'queryResult',
            ...result,
            diffSkipped: true,
            hasLimit: false,
            editable: false,
            editableTable: undefined,
            timeColumnWarning: timeColumn
              ? undefined
              : 'No shared time column found between hot and cold — showing an unbounded union instead of a tail window.',
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: queryDiagnostic(err).message });
        }
        return;
      }

      if (message.command === 'toggleSafeMode') {
        const wasSafeMode = document.safeMode;
        document.backupBeforeWrite = message.backupBeforeWrite;
        document.checkForChanges = message.checkForChanges;

        if (wasSafeMode && !message.safeMode) {
          // Turning Safe Mode OFF.
          if (document.backupBeforeWrite) {
            try {
              const backupPath = await document.runExclusive(() => document.file.createBackup());
              document.hasBackup = true;
              document.safeMode = false;
              webview.postMessage({ command: 'backupStatus', message: `Backup created: ${basename(backupPath)}` });
              // A fresh backup makes any previous comparison labels stale.
              webview.postMessage({ command: 'tableChangeStatus', status: {} });
            } catch (err) {
              webview.postMessage({
                command: 'backupStatus',
                message: `Could not create backup — Safe Mode stays on: ${queryDiagnostic(err).message}`,
              });
            }
          } else {
            document.safeMode = false;
            webview.postMessage({ command: 'backupStatus', message: 'Safe Mode off — no backup was made.' });
            webview.postMessage({ command: 'tableChangeStatus', status: {} });
          }
        } else if (!wasSafeMode && message.safeMode) {
          // Turning Safe Mode back ON (re-lock).
          document.safeMode = true;
          if (document.checkForChanges && document.hasBackup) {
            try {
              const status = await document.runExclusive(() => document.file.compareToBackup());
              webview.postMessage({ command: 'tableChangeStatus', status });
            } catch (err) {
              webview.postMessage({ command: 'error', message: queryDiagnostic(err).message });
            }
          } else {
            webview.postMessage({ command: 'tableChangeStatus', status: {} });
          }
        }

        webview.postMessage({ command: 'safeModeState', safeMode: document.safeMode });
        return;
      }

      if (message.command === 'runQuery' && typeof message.sql === 'string') {
        try {
          // Re-validated on every manual Run while Live stays engaged, not
          // just at the moment the toggle was flipped on — a new query can
          // replace lastSql mid-session. The read-only reconnect used for
          // live ticks is what actually prevents a write from executing;
          // this just turns "runs forever, fails every tick, spins into
          // backoff" into a clear, immediate message.
          if (document.liveRefreshEnabled && !looksReadOnly(message.sql)) {
            webview.postMessage({
              command: 'error',
              message: 'Live is on, so this file is open read-only — turn off Live to run write statements.',
            });
            return;
          }

          // The reason, not the first word: for `select 1; drop table x` the
          // first word is the harmless half, so reporting it would describe
          // the query as a select while blocking it as a write.
          const reason = destructiveReason(message.sql);
          const destructive = reason !== null;
          if (document.safeMode && destructive) {
            webview.postMessage({
              command: 'error',
              message: `Blocked by Safe Mode: this looks like a write statement (${reason}). Uncheck Safe Mode to allow it.`,
            });
            return;
          }

          const sql = message.sql;
          // A sidebar click selects immediately, before the preview runs.
          const selectionHostSeq = message.sheetPreview !== undefined
            ? document.selectWorksheet(message.sheetPreview, message.selectionSeq)
            : undefined;
          const isCurrentSelection = () =>
            selectionHostSeq !== undefined && document.worksheetSelection?.hostSeq === selectionHostSeq;
          // A workbook sheet finds the tables inside it the first time it is
          // queried, not when the file opens — reading every sheet to show one
          // is what made opening slow. So the sidebar can gain entries as a
          // result of this query, and has to be told.
          const hadPendingSheets = document.file.hasPendingSheets();
          const { result, diffFields, diffSkipped, editability, sheetPreview, executionSeq } = await document.runExclusive(async () => {
            if (document.safeMode && destructive) throw new QueryPolicyError('Blocked by Safe Mode.');
            // Coordinates are meaningful only for the untouched preview the
            // sidebar generated for the current choice; any other SQL --
            // including hand-written SQL on the selected sheet -- gets none.
            const previewSheet = message.sheetPreview;
            const coordinatesFor = () =>
              previewSheet !== undefined && isCurrentSelection() &&
              document.file.isWorksheet(previewSheet) && baseTableOfSelect(sql) === previewSheet
                ? previewSheet
                : undefined;
            const livePreview = document.liveRefreshEnabled && previewSheet !== undefined;
            if (livePreview) {
              // A writer may have replaced the source since Live last opened
              // the reader; the old reader would refuse this preview.
              const stats = await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath()));
              if (statsChanged(document.liveReaderStats, stats)) {
                await reconnectDocument(document, true);
                document.liveReaderStats = stats;
              }
            }
            const executionSeq = ++document.executionSeq;
            const rangeStats = await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath()));
            let queryResult: Awaited<ReturnType<typeof document.file.runQuery>>;
            try {
              queryResult = await document.file.runQuery(sql, getMaxResultRows(), coordinatesFor());
            } catch (error) {
              // The source can still change while this preview reads it. Live
              // then refreshes the current choice, not the previous one, whose
              // rows the view would discard as stale.
              if (livePreview && isCurrentSelection()) document.setLiveQuery(sql, coordinatesFor(), message.selectionSeq);
              throw error;
            }
            // Set together with the SQL, under the same lock, so a live tick
            // can never pair it with the previous sheet's coordinates.
            document.setLiveQuery(sql, coordinatesFor(), message.selectionSeq);
            document.statsCache.clear();
            if (!destructive && !document.liveRefreshEnabled && !superseded() && !statsChanged(rangeStats, await statAll(watchPathsFor(document.uri.fsPath, document.getSiblingPath())))) {
              document.rangeSnapshot = { stats: rangeStats, value: {
                context: { token: executionSeq, label: document.lastSheetPreview ? `Worksheet ${document.lastSheetPreview}` : `SQL result ${executionSeq} (row 1 is the first data row)`, rows: queryResult.rows.length, columns: queryResult.columns.length },
                sql, result: queryResult, worksheet: document.lastSheetPreview,
              } };
            }

            let fields: Partial<QueryDiff> = {};
            let skipped = false;
            if (!destructive && document.checkForChanges && document.hasBackup) {
              if (queryResult.rows.length > getDiffRowThreshold()) {
                // An O(rows) comparison nobody explicitly asked for isn't worth
                // paying for automatically on a huge result — offer it as an
                // on-demand action instead (see the diffQuery handler below).
                skipped = true;
              } else {
                try {
                  const diff = await document.file.diffQueryAgainstBackup(sql, queryResult.columns, queryResult.rows);
                  if (diff) fields = diff;
                } catch {
                  // Diff highlighting is a nice-to-have; never let it block showing the result.
                }
              }
            }

            return {
              result: queryResult,
              executionSeq,
              sheetPreview: document.lastSheetPreview,
              diffFields: fields,
              diffSkipped: skipped,
              editability: destructive ? { editable: false as const } : await document.file.checkEditableSelect(sql),
            };
          }, superseded);

          // Raised by the query rather than by opening the file — a workbook
          // whose sheets had to be re-read tolerating uncomputable cells. Said
          // once, when it first becomes true, rather than on every run.
          for (const warning of document.file.takeLateWarnings()) {
            vscode.window.showWarningMessage(`${basename(document.uri.fsPath)}: ${warning}`);
          }

          document.lastEditableTable = editability.editable ? editability.table : undefined;
          document.lastEditableColumns = editability.editable ? editability.columns : undefined;
          document.lastQueriedBaseTable =
            document.combinedQueryMap.get(sql) ?? (editability.editable ? editability.table : undefined);

          webview.postMessage({
            command: 'queryResult',
            ...result,
            ...diffFields,
            diffSkipped,
            hasLimit: hasTrailingLimit(sql),
            editable: editability.editable,
            editableTable: editability.editable ? editability.table : undefined,
            // Coordinates are meaningful only for the untouched preview the
            // sidebar generated. A hand-written WHERE/ORDER BY can rearrange
            // worksheet rows, so it deliberately gets an ordinary result.
            sheetPreview,
            sheetTables: sheetPreview ? document.file.getDetectedSheetTables(sheetPreview) : undefined,
            sheetPreparation: sheetPreview ? document.file.getSheetPreparation(sheetPreview) : undefined,
            // Echoed only for a sidebar choice, so the webview can drop a
            // preview that answers an older one.
            selectionSeq: selectionHostSeq !== undefined ? message.selectionSeq : undefined,
            sourceGeneration: selectionHostSeq !== undefined ? document.worksheetSelection?.generation : undefined,
            executionSeq,
            rangeContext: document.rangeSnapshot?.value.context,
          });

          // Posted AFTER the result, so the rows the user asked for are never
          // waiting behind a sidebar refresh.
          if (hadPendingSheets) {
            try {
              const tables = await document.runExclusive(() => document.getTables());
              webview.postMessage({
                command: 'tables',
                tables,
                combinedTableNames: [...document.combinedQueryMap.values()].map((t) => `${t}_combined`),
                previewFirst: false,
              });
            } catch {
              // The sidebar keeps what it had; the tables are still queryable.
            }
          }
          void reportRowTotal(document, webview, sql, result);
        } catch (err) {
          const table = baseTableOfSelect(message.sql);
          webview.postMessage({
            command: 'error',
            message: queryDiagnostic(err, !!message.sheetPreview || (table !== undefined && document.file.isWorksheet(table))).message,
          });
        }
        return;
      }

      if (message.command === 'diffQuery') {
        // On-demand counterpart to runQuery's automatic diff, for results
        // large enough that diffSkipped was set — explicit opt-in, since the
        // comparison itself is the expensive part being deferred here.
        if (!document.lastSql || !document.hasBackup) return;
        const baseSql = document.lastSql;
        try {
          const { result, diff } = await document.runExclusive(async () => {
            const queryResult = await document.file.runQuery(baseSql, getMaxResultRows());
            return {
              result: queryResult,
              diff: await document.file.diffQueryAgainstBackup(baseSql, queryResult.columns, queryResult.rows),
            };
          });
          webview.postMessage({
            command: 'queryResult',
            ...result,
            ...(diff ?? {}),
            diffSkipped: false,
            hasLimit: hasTrailingLimit(baseSql),
            // Editability is unchanged from the original run — this is the
            // same query re-executed only to compute the diff, not a new one.
            editable: !!document.lastEditableTable,
            editableTable: document.lastEditableTable,
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: queryDiagnostic(err).message });
        }
        return;
      }

      if (message.command === 'sheetTableQuery') {
        try {
          const result = await document.runExclusive(() =>
            document.file.runDetectedTableQuery(
              message.table,
              inlineFilters(message.filters),
              inlineSort(message.sort),
              inlineLimit(message.limit)
            )
          );
          webview.postMessage({ command: 'sheetTableResult', table: message.table, ...result });
        } catch (err) {
          webview.postMessage({
            command: 'sheetTableError',
            table: message.table,
            message: queryDiagnostic(err).message,
          });
        }
        return;
      }

      if (message.command === 'sheetTableStats') {
        try {
          const filters = inlineFilters(message.filters);
          const sort = inlineSort(message.sort);
          const limit = inlineLimit(message.limit);
          const { statsKind, shown, all } = await document.runExclusive(async () => {
            const shownSql = await document.file.buildDetectedTableQuery(
              message.table,
              filters,
              sort,
              limit
            );
            const allSql = await document.file.buildDetectedTableQuery(message.table);
            const probe = await document.file.runQuery(shownSql, 1);
            const columnIndex = probe.columns.indexOf(message.column);
            if (columnIndex === -1) throw new Error(`Column "${message.column}" was not found.`);
            const kind = probe.columnStatsKind[columnIndex] ?? 'other';
            const readStats = (sql: string): Promise<TopValuesStats | DescriptiveStats> =>
              kind === 'other'
                ? document.file.getColumnTopValues(sql, message.column, 20)
                : document.file.getColumnDescriptiveStats(sql, message.column, kind);
            return {
              statsKind: kind,
              shown: await readStats(shownSql),
              all: await readStats(allSql),
            };
          });
          webview.postMessage({
            command: 'sheetTableStatsResult',
            table: message.table,
            column: message.column,
            statsKind,
            shown,
            all,
          });
        } catch (err) {
          webview.postMessage({
            command: 'sheetTableError',
            table: message.table,
            message: queryDiagnostic(err).message,
          });
        }
        return;
      }

      if (message.command === 'sheetTableChart') {
        // A refresh redraws a chart that is open; it never opens one the user closed.
        if (message.refresh && !chartPanels.get(message.table)?.isOpen) return;
        const cap = getChartMaxPoints();
        const chartPanel = chartPanels.get(message.table) ?? new ChartPanel(this.context.extensionUri, basename(document.uri.fsPath));
        chartPanels.set(message.table, chartPanel);
        const label = `${message.table} — ${message.column}`;
        try {
          const result = await document.runExclusive(async () => {
            const sql = await document.file.buildDetectedTableQuery(
              message.table,
              inlineFilters(message.filters),
              inlineSort(message.sort),
              inlineLimit(message.limit)
            );
            const probe = await document.file.runQuery(sql, 1);
            const yIndex = probe.columns.indexOf(message.column);
            if (yIndex === -1 || probe.columnStatsKind[yIndex] !== 'numeric') {
              throw new Error(`"${message.column}" is not numeric, so it cannot be plotted.`);
            }
            const choice: AxisChoice = { column: message.xColumn };
            if (choice.column !== undefined && !probe.columns.includes(choice.column)) {
              throw new QueryPolicyError('This table has no such column for the x axis. Change the x axis.');
            }
            if (choice.column === message.column) {
              throw new QueryPolicyError('The x axis cannot also be the plotted column. Change the x axis.');
            }
            const x = pickPlotAxis(probe.columns, probe.columnStatsKind, choice);
            if (!x) throw new Error('This table cannot be plotted.');
            return document.file.runChartQuery(
              sql,
              x.column,
              [message.column],
              x.kind === 'text',
              cap,
              x.kind === 'category',
              x.kind === 'row',
              x.kind === 'date',
              x.kind === 'value'
            );
          });
          chartPanel.reveal(label, {
            command: 'chart',
            frequency: null,
            xColumn: result.columns[0],
            yColumns: [message.column],
            columns: result.columns,
            rows: result.rows,
            xAxisMode: result.xAxisMode,
            note: result.note,
            truncated: result.truncated === true,
            maxPoints: cap,
          });
        } catch (err) {
          chartPanel.reveal(label, { command: 'chartError', message: queryDiagnostic(err).message });
        }
        return;
      }

      if (message.command === 'chartQuery') {
        // Runs against document.lastSql, so the chart follows whatever is on
        // screen -- a table preview, or a query somebody wrote. lastSql is
        // deliberately not overwritten: the grid, editability and stats keep
        // describing the user's own query, and the chart is a second reading
        // of it rather than a replacement.
        if (!document.lastSql) return;
        // Validated before anything is read off it. The type says
        // `yColumns: string[]`, but types are erased and this handler is async:
        // a message without the field would throw OUT of the callback as an
        // unhandled rejection rather than reaching the chartError path below.
        if (
          !Array.isArray(message.yColumns) ||
          message.yColumns.length === 0 ||
          !message.yColumns.every((c) => typeof c === 'string') ||
          typeof message.xColumn !== 'string'
        ) {
          webview.postMessage({ command: 'chartError', message: 'Nothing to plot.' });
          return;
        }
        const cap = getChartMaxPoints();
        // An explicit date column is the axis, whatever xColumn says.
        const xAsDate = typeof message.xDateColumn === 'string';
        const series = message.yColumns.length === 1 ? message.yColumns[0] : `${message.yColumns.length} series`;
        // Keyed by the table being plotted, so a second table opens a second
        // tab instead of taking over the first one's. A query somebody typed
        // has no base table and shares one key -- it is one thing on screen.
        // lastQueriedBaseTable is only set for a table that may be WRITTEN to,
        // which a block of a sheet and every read-only file are not -- so the
        // key comes from the SQL on screen instead. Otherwise every block of
        // every sheet would share one chart tab.
        const chartTable = document.lastQueriedBaseTable ?? baseTableOfSelect(document.lastSql);
        const chartKey = chartTable ?? '(query)';
        const label = chartTable ? `${chartTable} — ${series}` : series;
        if (message.refresh && !chartPanels.get(chartKey)?.isOpen) return;
        let chartPanel = chartPanels.get(chartKey);
        if (!chartPanel) {
          chartPanel = new ChartPanel(this.context.extensionUri, basename(document.uri.fsPath));
          chartPanels.set(chartKey, chartPanel);
        }
        try {
          const result = await document.runExclusive(() =>
            document.file.runChartQuery(
              document.lastSql!,
              xAsDate ? message.xDateColumn! : message.xColumn,
              message.yColumns,
              message.xIsText === true,
              cap,
              message.xIsCategory === true,
              message.xIsRow === true,
              xAsDate,
              message.xIsValue === true
            )
          );
          // Read after the chart query, and never allowed to fail the chart:
          // a file with no sheet_metadata plots with plain dates, which is the
          // whole point of the frequency being optional. Not cached -- it is
          // one row, read once per click on a plot button.
          const frequency = document.lastQueriedBaseTable
            ? await document
                .runExclusive(() =>
                  document.file.getSeriesFrequency(document.lastQueriedBaseTable!)
                )
                .catch(() => null)
            : null;
          chartPanel.reveal(label, {
            command: 'chart',
            frequency,
            // columns[0], not message.xColumn: a generated row axis may have been renamed.
            xColumn: result.columns[0],
            yColumns: message.yColumns,
            columns: result.columns,
            rows: result.rows,
            xAxisMode: result.xAxisMode,
            note: result.note,
            // `truncated` means the cap actually bit. The chart view reports
            // the refusal instead of drawing a prefix of the series.
            truncated: result.truncated === true,
            maxPoints: cap,
          });
        } catch (err) {
          // In the chart's own tab, not the grid's status line: the tab is
          // where the user is looking, and a chart that silently never appears
          // is the failure worth avoiding.
          chartPanel.reveal(label, { command: 'chartError', message: queryDiagnostic(err, false, xAsDate).message });
        }
        return;
      }

      if (message.command === 'sortQuery') {
        // Only reachable when the base query has a trailing LIMIT (the
        // webview only sends this then — see hasLimit in queryResult) — a
        // client-side re-sort of already-fetched rows can't recover the
        // true top/bottom N from a LIMIT-ed, unordered result, so this
        // re-runs the query with the LIMIT stripped, sorted, then
        // re-applied. document.lastSql is deliberately left untouched:
        // editability/stats continue to reflect the user's real query.
        if (!document.lastSql) return;
        const baseSql = document.lastSql;
        try {
          const { result, diffFields, diffSkipped } = await document.runExclusive(async () => {
            const sorted = await document.file.runSortedQuery(
              baseSql,
              message.column,
              message.direction,
              getMaxResultRows()
            );

            let fields: Partial<QueryDiff> = {};
            let skipped = false;
            if (document.checkForChanges && document.hasBackup) {
              if (sorted.rows.length > getDiffRowThreshold()) {
                skipped = true;
              } else {
                try {
                  // The *sorted* SQL, not the base query. diffQueryAgainstBackup
                  // compares rows positionally, so running the unsorted base
                  // query against the backup lines sorted rows up against
                  // unsorted ones and reports nearly every cell as changed.
                  const diff = await document.file.diffQueryAgainstBackup(
                    sorted.sortedSql,
                    sorted.columns,
                    sorted.rows
                  );
                  if (diff) fields = diff;
                } catch {
                  // Diff highlighting is a nice-to-have; never let it block showing the result.
                }
              }
            }
            return { result: sorted, diffFields: fields, diffSkipped: skipped };
          }, superseded);

          webview.postMessage({
            command: 'sortQueryResult',
            ...result,
            ...diffFields,
            diffSkipped,
            hasLimit: true,
            // DuckDB has already ordered these rows across the full data set.
            // Without this the webview re-sorts them client-side, which is both
            // wasted work and — since the client comparator can disagree with
            // DuckDB's ordering — able to scramble a correct top-N back into a
            // wrong one.
            serverSorted: true,
            // Editability is unchanged from the original run — sorting
            // doesn't change the query's shape, only row order.
            editable: !!document.lastEditableTable,
            editableTable: document.lastEditableTable,
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: queryDiagnostic(err).message });
        }
        return;
      }

      if (message.command === 'columnStats') {
        if (!document.lastSql) return;
        const baseSql = document.lastSql;
        const limit = Number.isInteger(message.limit) && message.limit! > 0 && message.limit! <= 200 ? message.limit! : 20;
        const cacheKey = `${message.statsKind}:${message.column}`;
        const cached = document.statsCache.get(cacheKey);
        if (cached) {
          webview.postMessage({ command: 'columnStatsResult', column: message.column, statsKind: message.statsKind, ...cached });
          return;
        }
        try {
          if (message.statsKind === 'other') {
            const stats = await document.runExclusive(() =>
              document.file.getColumnTopValues(baseSql, message.column, limit)
            );
            document.setStatsCache(cacheKey, stats);
            webview.postMessage({ command: 'columnStatsResult', column: message.column, statsKind: 'other', ...stats });
          } else {
            const statsKind = message.statsKind;
            const stats = await document.runExclusive(() =>
              document.file.getColumnDescriptiveStats(baseSql, message.column, statsKind)
            );
            document.setStatsCache(cacheKey, stats);
            webview.postMessage({
              command: 'columnStatsResult',
              column: message.column,
              statsKind,
              ...stats,
            });
          }
        } catch (err) {
          webview.postMessage({ command: 'columnStatsError', column: message.column, message: queryDiagnostic(err).message });
        }
        return;
      }

      if (message.command === 'updateCell') {
        if (document.safeMode) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'Blocked by Safe Mode: uncheck Safe Mode to allow edits.',
          });
          return;
        }
        if (!document.lastEditableTable || !document.lastEditableColumns?.includes(message.column)) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'This result is not editable.',
          });
          return;
        }
        const expectedCols = new Set(document.lastEditableColumns);
        const gotCols = Object.keys(message.rowValues);
        if (gotCols.length !== expectedCols.size || !gotCols.every((c) => expectedCols.has(c))) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'Result changed since this row was loaded — re-run the query and try again.',
          });
          return;
        }

        const editableTable = document.lastEditableTable;
        // An edit's outcome must reach the user even when the view cannot take
        // it any more -- the editor closed during the save, or a newer query
        // replaced the grid: then it is said in a notification instead.
        const label = basename(document.uri.fsPath);
        const deliver = async (payload: Record<string, unknown>, text: string, failed: boolean) => {
          let shown = false;
          try { shown = (await webview.postMessage(payload)) !== false; } catch { shown = false; }
          if (!shown) void (failed ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(`${label}: ${text}`);
        };
        try {
          const rowsMatched = await document.runExclusive(() => {
            if (document.safeMode || document.lastEditableTable !== editableTable) throw new QueryPolicyError('The edit state changed. Re-run the query before editing.');
            return document.file.updateCell(
              editableTable,
              message.column,
              message.newValue,
              message.rowValues,
              (statusMessage) => webview.postMessage({ command: 'editStatus', message: statusMessage })
            );
          });
          if (rowsMatched === 0) {
            const text = 'No matching row found — the data may have changed. Re-run the query and try again.';
            await deliver({ command: 'cellUpdateError', column: message.column, message: text },
              `The edit to "${message.column}" was not saved. ${text}`, true);
          } else {
            document.invalidateTablesCache();
            await deliver({
              command: 'cellUpdated',
              column: message.column,
              newValue: message.newValue,
              rowValues: message.rowValues,
              rowsMatched,
            }, `The edit to "${message.column}" was saved.`, false);
          }
        } catch (err) {
          const text = queryDiagnostic(err).message;
          await deliver({ command: 'cellUpdateError', column: message.column, message: text },
            `The edit to "${message.column}" did not complete: ${text}`, true);
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      messageSub.dispose();
      // The draft is already in memory; persist it now rather than after the
      // store's pause, so a window closing right after this tab keeps it.
      void this.sqlDrafts.flush();
      // A chart of a document nobody has open is furniture.
      for (const panel of chartPanels.values()) panel.dispose();
      chartPanels.clear();
      // The panel going away is the end of anyone being able to see a tick's
      // result, so stop scheduling them. Document disposal usually follows
      // immediately, but nothing guarantees it happens first.
      document.liveRefreshController?.dispose();
      document.liveRefreshController = undefined;
      document.liveRefreshEnabled = false;
    });
  }
}

function getHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Data File Viewer</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  // A CSP nonce must be unguessable — Math.random() isn't a CSPRNG and its
  // output is statistically predictable given enough samples, which defeats
  // the point of using a nonce at all.
  return randomBytes(16).toString('hex');
}
