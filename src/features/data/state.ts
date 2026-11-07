import type { StatsKind } from '../../gridFormat';
import type { QueryTarget, QueryColumn } from '../../queryCatalog';
import type { SortState } from '../../gridOrder';
import type { DetectedSheetTable, SheetPreparationStatus } from '../../backend/types';
import {
  attestsCurrentChoice,
  chooseSheet,
  initialSelection,
  markDispatched,
  settleReply,
  type WorksheetSelection,
} from './worksheetSelection';

export { initialSelection, type WorksheetSelection } from './worksheetSelection';

/**
 * The webview's data state, and the rules for moving it.
 *
 * webview.ts held 21 module-level `let`s and a 20-case message switch that
 * mutated them in among its DOM calls, so none of it could be tested -- and
 * several of those cases carry rules that are subtle, load-bearing and
 * commented precisely because they are not obvious. Three query results arrive
 * on three different messages and each one treats `sortState`, `totalRows`,
 * `serverSorted` and the scroll position DIFFERENTLY, on purpose. Getting one
 * of those crossed shows stale numbers under fresh rows, which nothing errors
 * about.
 *
 * The split is: this module decides what the state becomes and what the DOM
 * must be told; webview.ts still does every bit of the telling. Each case below
 * is the original body moved across with its reasoning intact, DOM calls
 * swapped for effect objects, and no logic changed.
 */

export type TableStatus = 'unchanged' | 'changed' | 'new';

export interface QueryResultFields {
  columns: string[];
  rows: unknown[][];
  columnStatsKind: StatsKind[];
  cellChanged?: boolean[][];
  rowIsNew?: boolean[];
  renamedColumns?: Record<string, string>;
  diffSkipped: boolean;
  hasLimit: boolean;
  truncated?: boolean;
  /** Rows the query matches ignoring its trailing LIMIT. Arrives after the rows. */
  totalRows?: number;
  editable: boolean;
  editableTable?: string;
  timeColumnWarning?: string;
  /** DuckDB already ordered these rows — see computeDisplayOrder, which must not re-sort them. */
  serverSorted?: boolean;
  /** Present only for a verbatim worksheet preview: the worksheet it shows. */
  sheetPreview?: string;
  /** Present only for a verbatim worksheet preview. */
  sheetTables?: DetectedSheetTable[];
  /** SAFE-X1: what table discovery concluded for that worksheet. */
  sheetPreparation?: SheetPreparationStatus;
  /** Echo of the sidebar selection this result answers; absent for SQL the user ran. */
  selectionSeq?: number;
  /** The host's query-catalog generation when that selection was made. */
  sourceGeneration?: number;
  /** Host order of execution: a larger number read the source later. */
  executionSeq?: number;
}

/** Transport metadata the host attaches to every reply. */
interface Reply {
  requestId?: number;
}

export type LastResult = QueryResultFields;

export interface ColumnStatsFields {
  totalRows: number;
  nonNullRows: number;
  nullCount: number;
  distinctCount?: number;
  topValues?: { value: unknown; frequency: number }[];
  min?: unknown;
  max?: unknown;
  mean?: unknown;
  p5?: unknown;
  p95?: unknown;
}

export type ExtensionMessage =
  | { command: 'queryCatalog'; targets: QueryTarget[]; generation: number; cursor: number; nextCursor?: number; requestId?: number }
  | { command: 'queryTargetDetails'; target: QueryTarget; columns: QueryColumn[]; requestId?: number }
  | { command: 'querySqlDraft'; target: QueryTarget; sql: string; requestId?: number }
  | { command: 'tables'; tables: string[]; combinedTableNames: string[]; previewFirst?: boolean }
  | ({ command: 'queryResult' } & QueryResultFields & Reply)
  | ({ command: 'sortQueryResult' } & QueryResultFields & Reply)
  | { command: 'rowTotal'; sql: string; total: number; requestId?: number }
  | ({ command: 'error'; message: string } & Reply)
  | { command: 'sqlDraft'; sql: string }
  | { command: 'sheetPreparationRetried'; sheet: string; status?: SheetPreparationStatus }
  | { command: 'backupStatus'; message: string }
  | { command: 'tableChangeStatus'; status: Record<string, TableStatus> }
  | { command: 'safeModeState'; safeMode: boolean }
  | {
      command: 'liveRefreshStarted';
      intervalMs: number;
      suggestedIntervalSeconds: number | null;
      hasSource?: boolean;
      sourceLookedFor?: string;
    }
  | { command: 'liveRefreshStopped'; readOnly?: boolean }
  | { command: 'liveRefreshRejected'; reason: string }
  | { command: 'liveRefreshIntervalSet'; intervalMs: number }
  | ({ command: 'liveTick'; lastUpdatedMs: number; unchanged: boolean } & { result?: QueryResultFields })
  | {
      command: 'liveStatus';
      stale: boolean;
      failureCount: number;
      lastError?: string;
      lastSuccessMs?: number;
    }
  | {
      command: 'columnStatsResult';
      column: string;
      statsKind: StatsKind;
    } & ColumnStatsFields
  | { command: 'columnStatsError'; column: string; message: string }
  | ({
      command: 'sheetTableResult';
      table: string;
      sql: string;
      totalRows: number;
    } & Pick<QueryResultFields, 'columns' | 'rows' | 'columnStatsKind'>)
  | {
      command: 'sheetTableStatsResult';
      table: string;
      column: string;
      statsKind: StatsKind;
      shown: ColumnStatsFields;
      all: ColumnStatsFields;
    }
  | { command: 'sheetTableError'; table: string; message: string }
  | { command: 'cellUpdated'; column: string; newValue: unknown; rowValues: Record<string, unknown>; rowsMatched: number }
  | { command: 'cellUpdateError'; column: string; message: string }
  | { command: 'editStatus'; message: string };

export interface WebviewState {
  lastResult: LastResult | undefined;
  selection: WorksheetSelection;
  sortState: SortState | undefined;
  /** The query a pending row-count belongs to; see the rowTotal case. */
  awaitingTotalForSql: string | undefined;
  pinnedToBottom: boolean;
  liveEnabled: boolean;
  liveIntervalMs: number;
  liveLastUpdatedMs: number | undefined;
  /** executionSeq of the rows on screen; older rows never replace them. */
  paintedExecution: number;
  liveStale: boolean;
  /** False when no companion file was found — see liveStatus.ts. */
  liveHasSource?: boolean;
  /** The candidate paths that were looked for, to name them. */
  liveSourceLookedFor?: string;
  liveLastError: string | undefined;
}

export function initialState(): WebviewState {
  return {
    lastResult: undefined,
    selection: initialSelection(),
    sortState: undefined,
    awaitingTotalForSql: undefined,
    pinnedToBottom: true,
    liveEnabled: false,
    liveIntervalMs: 2000,
    liveLastUpdatedMs: undefined,
    paintedExecution: 0,
    liveStale: false,
    liveLastError: undefined,
  };
}

/**
 * What the DOM layer must do, in order.
 *
 * Deliberately a list of instructions rather than callbacks: a reducer that
 * took callbacks would be just as untestable as the switch it replaces, since
 * the assertions would all be about which function got called rather than what
 * was decided.
 */
export type Effect =
  | { kind: 'renderTables'; tables: string[]; combined: string[]; previewFirst: boolean }
  | { kind: 'setRunning'; value: boolean }
  | { kind: 'status'; text: string }
  | { kind: 'showError'; message: string }
  | { kind: 'render'; preserveScroll: boolean }
  | { kind: 'invalidateOrder' }
  | { kind: 'tableChangeStatus'; status: Record<string, TableStatus> }
  | { kind: 'safeModeState'; safeMode: boolean }
  | { kind: 'setLiveUi'; enabled: boolean }
  | { kind: 'setLiveIntervalInput'; intervalMs: number }
  | { kind: 'startLiveStatusTicker' }
  | { kind: 'updateLiveStatusText' }
  | { kind: 'liveRefreshRejected'; reason: string }
  | { kind: 'statsResult'; message: Extract<ExtensionMessage, { command: 'columnStatsResult' }> }
  | { kind: 'statsError'; column: string; message: string }
  | { kind: 'sheetTableResult'; message: Extract<ExtensionMessage, { command: 'sheetTableResult' }> }
  | { kind: 'sheetTableStatsResult'; message: Extract<ExtensionMessage, { command: 'sheetTableStatsResult' }> }
  | { kind: 'sheetTableError'; table: string; message: string }
  | { kind: 'closeCellInspector' }
  | { kind: 'cellUpdateError'; column: string; message: string }
  | { kind: 'editStatus'; message: string }
  | { kind: 'dispatchPreview'; sheet: string; seq: number }
  | { kind: 'selectionChanged' }
  | { kind: 'repreviewSheet'; sheet: string };

export interface Reduced {
  state: WebviewState;
  effects: Effect[];
}

const READ_ONLY_NOTICE =
  'Live off — but this file is still open read-only, because another process holds the write lock. Editing stays disabled until it releases.';

function resultFrom(message: QueryResultFields, over: Partial<LastResult> = {}): LastResult {
  return {
    columns: message.columns,
    rows: message.rows,
    columnStatsKind: message.columnStatsKind,
    cellChanged: message.cellChanged,
    rowIsNew: message.rowIsNew,
    renamedColumns: message.renamedColumns,
    diffSkipped: message.diffSkipped,
    hasLimit: message.hasLimit,
    truncated: message.truncated,
    editable: message.editable,
    editableTable: message.editableTable,
    sheetPreview: message.sheetPreview,
    sheetTables: message.sheetTables,
    sheetPreparation: message.sheetPreparation,
    ...over,
  };
}

/** Choose a sidebar entry. Takes effect immediately; the preview follows. */
export function chooseWorksheet(state: WebviewState, sheet: string, generation: number, transportSeq: number): Reduced {
  const chosen = chooseSheet(state.selection, sheet, generation, transportSeq);
  const effects: Effect[] = [{ kind: 'selectionChanged' }];
  // The reply to the one in flight dispatches whatever is latest.
  if (chosen.dispatch) effects.push({ kind: 'dispatchPreview', ...chosen.dispatch });
  return { state: { ...state, selection: chosen.selection }, effects };
}

/** Record the transport id of the preview just sent for selection `seq`. */
export function previewDispatched(state: WebviewState, seq: number, requestId: number): WebviewState {
  return { ...state, selection: markDispatched(state.selection, seq, requestId) };
}

/**
 * Settle the in-flight preview if `message` answers it, and decide whether the
 * message is stale -- a reply to a request made before the current choice, or
 * a preview for an older choice. Stale replies change nothing on screen.
 */
function settle(state: WebviewState, next: WebviewState, message: { requestId?: number; selectionSeq?: number }): { stale: boolean; effects: Effect[] } {
  const settled = settleReply(state.selection, message);
  if (settled.selection !== state.selection) next.selection = settled.selection;
  const effects: Effect[] = settled.dispatch ? [{ kind: 'dispatchPreview', ...settled.dispatch }] : [];
  return { stale: settled.stale, effects };
}

function olderThanPainted(state: WebviewState, result: QueryResultFields): boolean {
  return result.executionSeq !== undefined && result.executionSeq < state.paintedExecution;
}

/** Keep worksheet coordinates only when the host attests they belong to the current choice. */
function associate(state: WebviewState, result: QueryResultFields): Partial<LastResult> {
  return attestsCurrentChoice(state.selection, result) ? {} : { sheetPreview: undefined, sheetTables: undefined, sheetPreparation: undefined };
}

export function reduce(state: WebviewState, message: ExtensionMessage): Reduced {
  const next: WebviewState = { ...state };
  const effects: Effect[] = [];

  switch (message.command) {
    case 'sheetPreparationRetried':
      // SAFE-X1: show the fresh attempt's tables, but only if that sheet is
      // still the one chosen; a retry never changes the selection.
      if (state.selection.sheet === message.sheet) effects.push({ kind: 'repreviewSheet', sheet: message.sheet });
      break;
    case 'tables':
      // A choice whose sheet is gone (replaced or renamed source) is cleared,
      // and the bump invalidates any preview still on its way for it.
      if (state.selection.sheet !== undefined && !message.tables.includes(state.selection.sheet)) {
        next.selection = { ...state.selection, sheet: undefined, seq: state.selection.seq + 1 };
        effects.push({ kind: 'selectionChanged' });
        // Rows already on screen for that sheet keep showing, but lose its
        // coordinates and detected tables: nothing may be edited or outlined
        // against a sheet the source no longer has.
        if (state.lastResult?.sheetPreview === state.selection.sheet) {
          next.lastResult = { ...state.lastResult, sheetPreview: undefined, sheetTables: undefined, sheetPreparation: undefined };
          effects.push({ kind: 'render', preserveScroll: true });
        }
      }
      effects.push({
        kind: 'renderTables',
        tables: message.tables,
        combined: message.combinedTableNames,
        previewFirst: message.previewFirst === true,
      });
      break;

    case 'queryResult': {
      const settled = settle(state, next, message);
      if (settled.stale) return { state: next, effects: settled.effects };
      if (olderThanPainted(state, message)) {
        // A live tick that read the source later is already on screen: these
        // rows are older. The request is answered, but nothing is repainted.
        return { state: next, effects: [...settled.effects, { kind: 'setRunning', value: false }, { kind: 'status', text: '' }] };
      }
      next.lastResult = resultFrom(message, { serverSorted: false, ...associate(state, message) });
      next.paintedExecution = message.executionSeq ?? state.paintedExecution;
      next.sortState = undefined;
      // A brand-new query result (not a live tick re-running the same one)
      // always starts scrolled to the top — "pinned to bottom" only matters
      // once this same query starts live-ticking.
      next.pinnedToBottom = false;
      effects.push(
        { kind: 'setRunning', value: false },
        { kind: 'status', text: message.timeColumnWarning ?? '' },
        { kind: 'render', preserveScroll: false }
      );
      break;
    }

    case 'rowTotal':
      // Late-arriving companion to the queryResult above. Ignored unless it
      // counted the query currently on screen — the user can run something
      // else while a count is still running, and a total from the previous
      // query under these rows would be worse than no total at all.
      // The same SQL can be requested again during A→B→A→B navigation.
      // Matching SQL alone lets the discarded B count repaint A's retained
      // rows while the current B preview is pending.
      if (state.lastResult && !state.selection.inFlight &&
          (message.requestId === undefined || message.requestId > state.selection.since) &&
          message.sql === state.awaitingTotalForSql) {
        next.lastResult = { ...state.lastResult, totalRows: message.total };
        effects.push({ kind: 'render', preserveScroll: false });
      }
      break;

    case 'sortQueryResult': {
      const settled = settle(state, next, message);
      if (settled.stale) return { state: next, effects: settled.effects };
      next.lastResult = resultFrom(message, {
        ...associate(state, message),
        // Sorting re-orders the same matching rows and re-applies the same
        // LIMIT, so the total is unchanged — carried across rather than
        // recomputed, which would re-run the count on every column click.
        totalRows: state.lastResult?.totalRows,
        // DuckDB ordered these across the full data set; computeDisplayOrder
        // must leave them exactly as they arrived.
        serverSorted: message.serverSorted ?? true,
      });
      // sortState is intentionally left as-is -- this response IS the result
      // of the sort that was just clicked, so the arrow icon must keep showing
      // it (unlike a fresh queryResult, which clears it above).
      effects.push(
        { kind: 'setRunning', value: false },
        { kind: 'status', text: '' },
        { kind: 'render', preserveScroll: false }
      );
      break;
    }

    case 'error': {
      const settled = settle(state, next, message);
      if (settled.stale) return { state: next, effects: settled.effects };
      effects.push(
        { kind: 'setRunning', value: false },
        { kind: 'status', text: '' },
        { kind: 'showError', message: message.message }
      );
      break;
    }

    case 'backupStatus':
      effects.push({ kind: 'status', text: message.message });
      break;

    case 'tableChangeStatus':
      effects.push({ kind: 'tableChangeStatus', status: message.status });
      break;

    case 'safeModeState':
      effects.push({ kind: 'safeModeState', safeMode: message.safeMode });
      break;

    case 'liveRefreshStarted':
      next.liveEnabled = true;
      next.liveIntervalMs = message.intervalMs;
      next.liveLastUpdatedMs = undefined;
      next.liveStale = false;
      next.liveLastError = undefined;
      // Absent means "not reported" -> treated as sourced, so an older host
      // cannot make every file look sourceless.
      next.liveHasSource = message.hasSource;
      next.liveSourceLookedFor = message.sourceLookedFor;
      effects.push(
        { kind: 'setLiveUi', enabled: true },
        { kind: 'setLiveIntervalInput', intervalMs: message.intervalMs },
        { kind: 'startLiveStatusTicker' }
      );
      break;

    case 'liveRefreshStopped':
      next.liveEnabled = false;
      effects.push({ kind: 'setLiveUi', enabled: false });
      if (message.readOnly) {
        effects.push({ kind: 'status', text: READ_ONLY_NOTICE });
      }
      break;

    case 'liveRefreshRejected':
      effects.push(
        { kind: 'liveRefreshRejected', reason: message.reason },
        { kind: 'status', text: message.reason }
      );
      break;

    case 'liveRefreshIntervalSet':
      next.liveIntervalMs = message.intervalMs;
      effects.push({ kind: 'setLiveIntervalInput', intervalMs: message.intervalMs });
      break;

    case 'liveStatus':
      next.liveStale = message.stale;
      next.liveLastError = message.lastError;
      effects.push({ kind: 'updateLiveStatusText' });
      break;

    case 'liveTick':
      next.liveLastUpdatedMs = message.lastUpdatedMs;
      effects.push({ kind: 'updateLiveStatusText' });
      // While a preview is on its way, or for a choice that is no longer
      // current, a tick describes rows the user has already navigated away from.
      //
      // A tick for the current choice is shown even while its own preview is
      // still on the wire (it may have read a newer source than the preview).
      // Anything that executed before the rows on screen is older, whatever
      // order it arrives in.
      if (
        !message.unchanged && message.result && !olderThanPainted(state, message.result) &&
        (message.result.selectionSeq === undefined ? !state.selection.inFlight : message.result.selectionSeq === state.selection.seq)
      ) {
        next.paintedExecution = message.result.executionSeq ?? state.paintedExecution;
        next.lastResult = resultFrom(message.result, {
          ...associate(state, message.result),
          // Deliberately NOT carried across. A live tick means the underlying
          // data just moved, so the previous total is exactly the number that
          // has stopped being true — the footer drops back to "N rows shown"
          // rather than asserting a stale one. Recounting every tick would
          // double the cost of the poll loop to state something that is
          // already about to change again.
          totalRows: undefined,
          // A live tick re-runs the user's own query, which carries whatever
          // ORDER BY they wrote but not the client-side sort — so any active
          // column sort still has to be applied here.
          serverSorted: false,
        });
        // preserve scroll position / pinned-bottom auto-follow — this is the
        // same ongoing query, not a fresh one.
        effects.push({ kind: 'render', preserveScroll: true });
      }
      break;

    case 'columnStatsResult':
      effects.push({ kind: 'statsResult', message });
      break;

    case 'columnStatsError':
      effects.push({ kind: 'statsError', column: message.column, message: message.message });
      break;

    case 'sheetTableResult':
      effects.push(
        { kind: 'setRunning', value: false },
        { kind: 'status', text: '' },
        { kind: 'sheetTableResult', message }
      );
      break;

    case 'sheetTableStatsResult':
      effects.push({ kind: 'sheetTableStatsResult', message });
      break;

    case 'sheetTableError':
      effects.push(
        { kind: 'setRunning', value: false },
        { kind: 'sheetTableError', table: message.table, message: message.message }
      );
      break;

    case 'cellUpdated': {
      if (state.lastResult) {
        // Re-match by full-row equality (same principle used server-side),
        // robust to any client-side sort that happened between send and
        // receive — display order never matches the underlying row index.
        const result = state.lastResult;
        const colIdx = result.columns.indexOf(message.column);
        const rowIdx = result.rows.findIndex((row) =>
          result.columns.every((c, j) => {
            const expected = message.rowValues[c];
            return c === message.column ? true : row[j] === expected || (row[j] == null && expected == null);
          })
        );
        if (colIdx !== -1 && rowIdx !== -1) {
          result.rows[rowIdx][colIdx] = message.newValue;
          // Edited in place, so the rows array keeps its identity — the cached
          // permutation has to be dropped explicitly or an edit to the sort
          // column would leave the row sitting in its old position.
          effects.push({ kind: 'invalidateOrder' });
          if (result.cellChanged) {
            if (!result.cellChanged[rowIdx]) {
              result.cellChanged[rowIdx] = result.columns.map(() => false);
            }
            result.cellChanged[rowIdx][colIdx] = true;
          }
        }
      }
      effects.push({ kind: 'closeCellInspector' }, { kind: 'render', preserveScroll: false });
      break;
    }

    case 'cellUpdateError':
      effects.push({ kind: 'cellUpdateError', column: message.column, message: message.message });
      break;

    case 'editStatus':
      effects.push({ kind: 'editStatus', message: message.message });
      break;
  }

  return { state: next, effects };
}
