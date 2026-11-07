import { EditorView, basicSetup } from 'codemirror';
import { keymap, ViewUpdate } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { sql, type SQLNamespace } from '@codemirror/lang-sql';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { pickPlotAxis, plottableColumns, type AxisChoice, type XAxis } from './chartSpec';
import { fmtCount, formatStat, formatValue } from './gridFormat';
import { DisplayOrderCache } from './gridOrder';
import { liveStatusText } from './liveStatus';
import { computeVirtualWindow } from './virtualWindow';
import { tableEdges } from './sheetHighlight';
import type { SheetBounds } from './queryCatalog';
import {
  type ColumnStatsFields,
  type Effect,
  type ExtensionMessage,
  type LastResult,
  type QueryResultFields,
  type TableStatus,
  createDataController,
} from './features/data';
import type { DetectedSheetTable, DetectedTableFilter, DetectedTableSort, SheetPreparationStatus } from './backend/types';
import { slotOfGridRow, slotsBefore, tableDataRows } from './sheetRowMap';
import type { ResultRangeContext, selectResultRange } from './queryRange';
// Note what is NOT imported here: ECharts. The chart draws in its own VS Code
// tab (see chartPanel.ts / chartView.ts), so the ~530 KB library loads the
// first time somebody plots something rather than every time a file is opened.

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type StatsKind = 'numeric' | 'datetime' | 'other';



// This document's data-view controller: transport ids, reducer state,
// worksheet selection and the query picker (features/data, MOD-02).
const data = createDataController(acquireVsCodeApi());
const picker = data.picker;
const vscode = {
  /** Returns the transport id, which the host echoes on its replies. */
  postMessage(message: Record<string, unknown>): number {
    return data.post(message);
  },
};

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

root.innerHTML = `
  <div class="layout">
    <div class="sidebar">
      <div class="sidebar-title">Tables</div>
      <div id="table-list" class="table-list"></div>
    </div>
    <div class="main">
      <div class="editor-toolbar">
        <button id="run-btn" title="Run (Ctrl/Cmd+Enter)">Run &#9654;</button>
        <label id="safe-mode-label" class="toolbar-check" title="Prevents cell edits. SQL queries always remain read-only.">
          <input type="checkbox" id="safe-mode-check" checked /> Safe Mode
        </label>
        <span id="unlock-options" class="unlock-options" hidden>
          <label class="toolbar-check" title="Back up the file the moment Safe Mode is turned off">
            <input type="checkbox" id="backup-check" checked /> Backup on unlock
          </label>
          <label class="toolbar-check" title="Compare against the backup and highlight what changed">
            <input type="checkbox" id="check-changes-check" checked /> Check for changes
          </label>
        </span>
        <span id="status" class="status"></span>
        <span class="toolbar-right">
          <label class="toolbar-radio" title="Static snapshot — re-run manually">
            <input type="radio" name="live-mode" id="mode-static-radio" checked /> Static
          </label>
          <label class="toolbar-radio" title="Re-run the current query automatically as the file changes">
            <input type="radio" name="live-mode" id="mode-live-radio" /> Live
          </label>
          <span id="live-options" hidden>
            every <input type="number" id="live-interval-input" min="0.25" step="0.25" value="2" title="Refresh interval, seconds" />s
          </span>
          <span id="live-status" class="live-status"></span>
        </span>
      </div>
      <div class="query-target-toolbar">
        <label for="query-target">Query table</label>
        <select id="query-target"><option value="">Choose a table…</option></select>
        <button id="query-use" disabled>Use in SQL</button>
        <button id="query-more" hidden>More tables</button>
        <button id="query-restore" hidden>Restore draft</button>
        <label for="plot-axis" title="Only changes how a plot is drawn; the data and the query are untouched">Plot axis</label>
        <select id="plot-axis"></select>
      </div>
      <div id="editor" class="editor"></div>
      <form id="range-form" class="query-target-toolbar">
        <label for="range-input">Result range</label>
        <input id="range-input" placeholder="A1:D929" maxlength="40" aria-describedby="range-target" />
        <button id="range-apply" disabled>Preview range</button>
        <span id="range-target">Run a query or open a worksheet first.</span>
      </form>
      <section id="range-preview" hidden aria-label="Read-only range preview"></section>
      <div id="results" class="results"></div>
    </div>
  </div>
`;

const tableListEl = document.getElementById('table-list') as HTMLDivElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
const safeModeCheck = document.getElementById('safe-mode-check') as HTMLInputElement;
const safeModeLabel = document.getElementById('safe-mode-label') as HTMLLabelElement;
const backupCheck = document.getElementById('backup-check') as HTMLInputElement;
const checkChangesCheck = document.getElementById('check-changes-check') as HTMLInputElement;
const unlockOptionsEl = document.getElementById('unlock-options') as HTMLSpanElement;
const modeStaticRadio = document.getElementById('mode-static-radio') as HTMLInputElement;
const modeLiveRadio = document.getElementById('mode-live-radio') as HTMLInputElement;
const liveOptionsEl = document.getElementById('live-options') as HTMLSpanElement;
const liveIntervalInput = document.getElementById('live-interval-input') as HTMLInputElement;
const liveStatusEl = document.getElementById('live-status') as HTMLSpanElement;
const queryTargetEl = document.getElementById('query-target') as HTMLSelectElement;
const queryUseEl = document.getElementById('query-use') as HTMLButtonElement;
const queryMoreEl = document.getElementById('query-more') as HTMLButtonElement;
const queryRestoreEl = document.getElementById('query-restore') as HTMLButtonElement;
const plotAxisEl = document.getElementById('plot-axis') as HTMLSelectElement;
const rangeForm = document.getElementById('range-form') as HTMLFormElement;
const rangeInput = document.getElementById('range-input') as HTMLInputElement;
const rangeApply = document.getElementById('range-apply') as HTMLButtonElement;
const rangeTarget = document.getElementById('range-target')!;
const rangePreview = document.getElementById('range-preview')!;
let rangeContext: ResultRangeContext | undefined;
let rangeRequestId = 0;
let manualRangeRequestId = 0;
type RangePage = ReturnType<typeof selectResultRange>;

function clearRange(): void {
  rangeContext = undefined;
  rangeApply.disabled = true;
  rangePreview.hidden = true;
  rangePreview.replaceChildren();
  rangeTarget.textContent = 'Run a query or open a worksheet first.';
}

function requestRange(offset = 0): void {
  if (!rangeContext || running) return;
  rangeApply.disabled = true;
  rangeRequestId = vscode.postMessage({ command: 'queryRange', range: rangeInput.value, token: rangeContext.token, offset });
}

rangeForm.addEventListener('submit', event => { event.preventDefault(); requestRange(); });

function showRangePage(page: RangePage): void {
  rangePreview.replaceChildren();
  rangePreview.hidden = false;
  const label = document.createElement('p');
  label.textContent = `${page.target} · ${page.range} · rows ${page.firstRow}–${page.firstRow + page.rows.length - 1} (${page.totalRows} selected). Read-only; captured order.`;
  const sqlLabel = document.createElement('label');
  sqlLabel.textContent = 'Corresponding SQL (a new run reads the source again)';
  const sqlText = document.createElement('textarea');
  sqlText.readOnly = true; sqlText.rows = 5; sqlText.value = page.sql;
  sqlLabel.append(sqlText);
  const scroll = document.createElement('div'); scroll.className = 'range-scroll';
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const name of ['Row', ...page.columns]) { const th = document.createElement('th'); th.textContent = name; head.append(th); }
  const body = table.createTBody();
  page.rows.forEach((values, index) => {
    const row = body.insertRow();
    row.insertCell().textContent = String(page.firstRow + index);
    values.forEach(value => { row.insertCell().textContent = formatValue(value); });
  });
  scroll.append(table);
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = 'Previous range page';
  previous.disabled = page.offset === 0;
  previous.addEventListener('click', () => requestRange(Math.max(0, page.offset - page.pageSize)));
  const next = document.createElement('button'); next.type = 'button'; next.textContent = 'Next range page';
  next.disabled = page.nextOffset === undefined;
  next.addEventListener('click', () => { if (page.nextOffset !== undefined) requestRange(page.nextOffset); });
  rangePreview.append(label, sqlLabel, scroll, previous, next);
  if (page.worksheet) {
    const headerLabel = document.createElement('label');
    headerLabel.textContent = 'Header row (blank for none)';
    const header = document.createElement('input');
    header.type = 'number'; header.min = '1'; header.max = '1048576';
    header.value = page.range.match(/^[A-Z]+([0-9]+):/)?.[1] ?? '';
    headerLabel.append(header);
    const useTable = document.createElement('button');
    useTable.dataset.useTable = 'true';
    useTable.type = 'button'; useTable.textContent = 'Use as table';
    useTable.addEventListener('click', () => {
      if (!rangeContext || running || rangeContext.token !== page.token) return;
      if (!header.reportValidity()) return;
      useTable.disabled = true;
      manualRangeRequestId = vscode.postMessage({ command: 'useRangeAsTable', token: page.token, range: page.range,
        headerRow: header.value === '' ? null : Number(header.value) });
    });
    rangePreview.append(headerLabel, useTable);
  }
}
/**
 * The SQL text navigation itself last put in the editor. Anything else in the
 * editor is the user's own draft, which navigation never replaces.
 */
let navigationSql: string | undefined;

let running = false;

// Every data-carrying value the message handler mutates lives in data.state;
// the transitions are in features/data/state.ts.
/** The query whose row total is still in flight; see runQuery and the 'rowTotal' case. */
let combinedTableNames = new Set<string>();
let liveStatusTicker: number | undefined;
// Sliding-tail scroll behavior for live combined views: only auto-follow
// new rows in (log-tail style) when the user was already at the bottom —
// otherwise a live tick would repeatedly yank someone inspecting history
// back down to the newest row.

function setRunning(value: boolean): void {
  if (value) clearRange();
  running = value;
  // Stays enabled and turns into a Cancel button while running, rather than
  // being disabled — a runaway query otherwise has no escape hatch short of
  // closing the tab.
  runBtn.textContent = value ? 'Cancel ■' : 'Run ▶';
  runBtn.classList.toggle('run-btn-cancel', value);
  // Disables sort/stats/cell-edit affordances too (via pointer-events),
  // rather than letting a click sent mid-query silently no-op on the host
  // side and leave e.g. a stats popover stuck on "Loading…" forever.
  resultsEl.classList.toggle('busy', value);
}

// One Dark's default selection color is a muted gray-blue; override with a
// more classic, clearly-blue selection highlight. Applied after oneDark in
// the extensions array so its stylesheet wins on the shared selector.
const selectionColor = EditorView.theme({
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: '#3390ff !important',
  },
  // V22 contrast: One Dark's gutter grey is 3.9:1, below WCAG AA 4.5:1. (Its syntax token colours, >=4.0:1, are left as is.)
  '.cm-gutters': { color: '#9199a8 !important' },
});

const runKeymap = keymap.of([
  {
    key: 'Mod-Enter',
    run: () => {
      runQuery(editor.state.doc.toString());
      return true;
    },
  },
]);

// The user's SQL draft is kept by the host per document, so it survives the
// editor being closed and reopened. Sent on every change, not after a pause:
// a tab closed right after typing destroys this page, and the host ignores
// anything that arrives after its document is disposed, so a delayed or
// unload-time save would be lost (EX-02 attempt-05, installed host). The host
// batches the persistence itself.
const DRAFT_MAX_BYTES = 256 * 1024;
let savedDraft = '';
function userDraft(): string {
  const text = editor.state.doc.toString();
  return text === navigationSql ? '' : text;
}
function saveDraftNow(): void {
  const draft = userDraft();
  if (draft === savedDraft) return;
  if (new TextEncoder().encode(draft).length > DRAFT_MAX_BYTES) {
    statusEl.textContent = 'This SQL is too large to keep after the editor closes.';
    return;
  }
  savedDraft = draft;
  vscode.postMessage({ command: 'saveSqlDraft', sql: draft });
}
const draftListener = EditorView.updateListener.of((update: ViewUpdate) => {
  if (update.docChanged) {
    if (rangeContext) { clearRange(); vscode.postMessage({ command: 'invalidateRange' }); }
    saveDraftNow();
  }
});

const sqlLanguage = new Compartment();
const editor = new EditorView({
  doc: '',
  extensions: [basicSetup, sqlLanguage.of(sql()), runKeymap, oneDark, selectionColor, draftListener],
  parent: document.getElementById('editor') as HTMLDivElement,
});

function setEditorText(text: string): void {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
  });
}

/**
 * Show navigation's own SQL, but only in an editor that holds no draft: empty,
 * or still exactly what navigation last put there. A draft is left untouched.
 */
function showNavigationSql(text: string): void {
  const current = editor.state.doc.toString();
  if (current !== '' && current !== navigationSql) return;
  navigationSql = text;
  setEditorText(text);
}

function refreshQueryTargets(): void {
  const selected = picker.selected?.id ?? '';
  queryTargetEl.replaceChildren(new Option('Choose a table…', ''));
  for (const { label, options } of picker.groups(data.state.selection.sheet)) {
    const group = document.createElement('optgroup');
    group.label = label;
    for (const option of options) group.append(new Option(option.label, option.id));
    queryTargetEl.append(group);
  }
  queryTargetEl.value = selected;
  queryUseEl.disabled = !picker.selected;
  queryMoreEl.hidden = picker.nextCursor === undefined;
}

function refreshSqlCompletion(): void {
  const schema = picker.completionSchema();
  editor.dispatch({ effects: sqlLanguage.reconfigure(sql({ schema: schema as SQLNamespace })) });
}

queryTargetEl.addEventListener('change', () => {
  clearRange();
  const chosen = picker.select(queryTargetEl.value);
  refreshQueryTargets();
  refreshTableHighlight();
  if (chosen) vscode.postMessage({ command: 'queryTarget', targetId: chosen.id, generation: picker.generation });
});
queryUseEl.addEventListener('click', () => {
  clearRange();
  if (picker.selected) vscode.postMessage({ command: 'queryTargetSql', targetId: picker.selected.id, generation: picker.generation });
});
queryMoreEl.addEventListener('click', () => {
  if (picker.nextCursor !== undefined) vscode.postMessage({ command: 'queryCatalog', cursor: picker.nextCursor });
});
queryRestoreEl.addEventListener('click', () => {
  const draft = picker.restoreDraft();
  if (draft !== undefined) setEditorText(draft);
  queryRestoreEl.hidden = !picker.hasDrafts;
});

function runQuery(sqlText: string): void {
  if (running) return;
  const trimmed = sqlText.trim();
  if (!trimmed) return;
  setRunning(true);
  statusEl.textContent = 'Running…';
  // Remembered so a 'rowTotal' arriving late can be matched to the query it
  // counted -- it is computed after the rows are already on screen, and by
  // then the user may have run something else.
  data.state.awaitingTotalForSql = trimmed;
  vscode.postMessage({ command: 'runQuery', sql: trimmed });
}

function runCombinedQuery(baseTable: string): number {
  setRunning(true);
  statusEl.textContent = 'Running…';
  showNavigationSql(`-- combined hot+cold view of "${baseTable}" (synthesized, read-only)`);
  return vscode.postMessage({ command: 'runCombinedQuery', table: baseTable });
}

runBtn.addEventListener('click', () => {
  if (running) {
    vscode.postMessage({ command: 'cancelQuery' });
  } else {
    runQuery(editor.state.doc.toString());
  }
});

function sendToggleSafeMode(): void {
  unlockOptionsEl.hidden = safeModeCheck.checked;
  vscode.postMessage({
    command: 'toggleSafeMode',
    safeMode: safeModeCheck.checked,
    backupBeforeWrite: backupCheck.checked,
    checkForChanges: checkChangesCheck.checked,
  });
}

safeModeCheck.addEventListener('change', sendToggleSafeMode);
backupCheck.addEventListener('change', sendToggleSafeMode);
checkChangesCheck.addEventListener('change', sendToggleSafeMode);

function setLiveUiEnabled(enabled: boolean): void {
  data.state.liveEnabled = enabled;
  modeLiveRadio.checked = enabled;
  modeStaticRadio.checked = !enabled;
  liveOptionsEl.hidden = !enabled;
  // Mutually exclusive with Safe Mode in the UI, not just logically — a
  // live-refreshing view of a file another process is actively writing
  // isn't a sensible place to also be toggling backup/diff semantics, and
  // cell editing is locked out server-side regardless while live.
  safeModeLabel.hidden = enabled;
  unlockOptionsEl.hidden = enabled || safeModeCheck.checked;
  if (!enabled) {
    liveStatusEl.textContent = '';
    liveStatusEl.className = 'live-status';
    stopLiveStatusTicker();
  }
}

function stopLiveStatusTicker(): void {
  if (liveStatusTicker !== undefined) {
    window.clearInterval(liveStatusTicker);
    liveStatusTicker = undefined;
  }
}

function updateLiveStatusText(): void {
  if (!data.state.liveEnabled) return;
  const status = liveStatusText({
    enabled: data.state.liveEnabled,
    hostStale: data.state.liveStale,
    hasSource: data.state.liveHasSource,
    sourceLookedFor: data.state.liveSourceLookedFor,
    lastUpdatedMs: data.state.liveLastUpdatedMs,
    intervalMs: data.state.liveIntervalMs,
    lastError: data.state.liveLastError,
  });
  liveStatusEl.textContent = status.text;
  liveStatusEl.className = status.className;
  liveStatusEl.title = status.title;
}

function startLiveStatusTicker(): void {
  stopLiveStatusTicker();
  updateLiveStatusText();
  // Purely a local display refresh for "updated Xs ago" — the actual data
  // refresh cadence is driven entirely by the extension host, independent
  // of this.
  liveStatusTicker = window.setInterval(updateLiveStatusText, 1000);
}

function sendToggleLiveRefresh(enabled: boolean): void {
  const intervalMs = Math.round(Number(liveIntervalInput.value || '2') * 1000);
  vscode.postMessage({ command: 'toggleLiveRefresh', enabled, intervalMs: enabled ? intervalMs : undefined });
}

modeLiveRadio.addEventListener('change', () => {
  if (modeLiveRadio.checked) sendToggleLiveRefresh(true);
});
modeStaticRadio.addEventListener('change', () => {
  if (modeStaticRadio.checked) {
    setLiveUiEnabled(false);
    sendToggleLiveRefresh(false);
  }
});

liveIntervalInput.addEventListener('change', () => {
  if (!data.state.liveEnabled) return;
  const intervalMs = Math.round(Number(liveIntervalInput.value || '2') * 1000);
  vscode.postMessage({ command: 'setLiveRefreshInterval', intervalMs });
});

// What clicking a table in the sidebar does. Named, rather than living inline
// in the click handler, so opening a file can run the SAME thing — an
// auto-preview that built its own query would be a second code path to keep in
// step with this one for no reason.
//
// The choice is made at once (sidebar, picker); the preview it asks for is
// dispatched by the reducer -- immediately, or after the one already in flight.
// Navigation never takes over the SQL editor: see showNavigationSql.
function previewTable(name: string): void {
  for (const effect of data.choose(name)) applyEffect(effect);
}

function dispatchPreview(name: string, seq: number): void {
  let requestId: number;
  if (combinedTableNames.has(name)) {
    // Not a real table — a synthesized hot+cold union built server-side
    // (see duckdbConnection.ts's buildCombinedQuery); the extension
    // rebuilds and runs it directly rather than the usual
    // `SELECT * FROM "<name>"`, which wouldn't resolve to anything.
    requestId = runCombinedQuery(name.slice(0, -'_combined'.length));
  } else {
    const sqlText = `SELECT * FROM "${name}" LIMIT 100;`;
    showNavigationSql(sqlText);
    setRunning(true);
    statusEl.textContent = 'Running…';
    data.state.awaitingTotalForSql = sqlText.trim();
    requestId = vscode.postMessage({ command: 'runQuery', sql: sqlText, sheetPreview: name, selectionSeq: seq });
  }
  data.previewSent(seq, requestId);
}

/** The picker, the sidebar mark and the outline all follow the choice at once. */
function applySelection(): void {
  const sheet = data.state.selection.sheet;
  tableListEl.querySelectorAll<HTMLDivElement>('.table-item').forEach((item) => {
    item.setAttribute('aria-selected', String(item.dataset.table === sheet));
    item.classList.toggle('selected', item.dataset.table === sheet);
  });
  picker.dropForeignSelection(sheet);
  refreshQueryTargets();
  refreshTableHighlight();
}

// ------------------------------------------------------------------- charts
//
// The drawing happens in the chart's own VS Code tab (chartPanel.ts +
// chartView.ts). All this half does is decide which columns are worth
// offering a button for, and ask the host to plot one.

/** Plot-only axis choice (PLOT-03); empty is Automatic. Never changes the data or the query. */
let axisChoice: AxisChoice = {};

/** The columns the axis choice can name: the result's, or every detected table's on a worksheet. */
function axisColumns(): string[] {
  const result = data.state.lastResult;
  if (!result) return [];
  return result.sheetTables ? [...new Set(result.sheetTables.flatMap((table) => table.columns))] : result.columns;
}

function refreshAxisChoice(): void {
  const columns = axisColumns();
  if (axisChoice.dateColumn !== undefined && !columns.includes(axisChoice.dateColumn)) axisChoice = {};
  const dates = document.createElement('optgroup');
  dates.label = 'Read column as dates';
  for (const column of columns) dates.append(new Option(column, `date:${column}`));
  plotAxisEl.replaceChildren(new Option('Automatic', 'auto'), new Option('Row numbers', 'row'), dates);
  plotAxisEl.value = axisChoice.row ? 'row' : axisChoice.dateColumn !== undefined ? `date:${axisChoice.dateColumn}` : 'auto';
}

plotAxisEl.addEventListener('change', () => {
  const value = plotAxisEl.value;
  axisChoice = value === 'row' ? { row: true } : value.startsWith('date:') ? { dateColumn: value.slice(5) } : {};
  renderedHeaderKey = undefined;
  renderResults(true);
});

/** The x axis for what is currently on screen, or undefined if it has not got one. */
function chartXAxis(): XAxis | undefined {
  if (!data.state.lastResult) return undefined;
  return pickPlotAxis(data.state.lastResult.columns, data.state.lastResult.columnStatsKind, axisChoice);
}

function requestChart(yColumn: string): void {
  const x = chartXAxis();
  if (!x) return;
  vscode.postMessage({
    command: 'chartQuery',
    xColumn: x.column,
    // Whether the x column is a VARCHAR that merely claims to be a date. The
    // host is what settles time-axis-vs-category, since only it can ask the
    // database whether the strings parse.
    xIsText: x.kind === 'text',
    xIsCategory: x.kind === 'category',
    xIsRow: x.kind === 'row',
    // The chosen column is the axis; xColumn above already names it.
    xDateColumn: x.kind === 'date' ? x.column : undefined,
    yColumns: [yColumn],
  });
}

function renderTables(tables: string[], combined: string[], previewFirst = false): void {
  combinedTableNames = new Set(combined);
  // EX-07: a catalog refresh rebuilds the list; keyboard focus must stay on the same sheet.
  const focusedTable = tableListEl.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.table : undefined;
  tableListEl.innerHTML = '';
  tableListEl.setAttribute('role', 'listbox');
  tableListEl.setAttribute('aria-label', 'Tables');
  for (const name of tables) {
    const item = document.createElement('div');
    item.className = 'table-item';
    item.textContent = name;
    item.dataset.table = name;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(name === data.state.selection.sheet));
    item.classList.toggle('selected', name === data.state.selection.sheet);
    item.tabIndex = 0; // EX-07: reachable and operable by keyboard, not only by mouse
    item.addEventListener('click', () => previewTable(name));
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      previewTable(name);
    });
    tableListEl.appendChild(item);
    if (name === focusedTable) item.focus();
  }
  if (tables.length === 0) {
    tableListEl.innerHTML = '<div class="empty">No tables found.</div>';
  }
  // Show the first table straight away. For the single-table formats
  // (.parquet/.csv/.dta/.arrow/.arrows/.feather) there is exactly one entry
  // and clicking it was the only thing left to do; for a .duckdb or .xlsx the
  // first entry is the one the writer put first, which is the data rather than
  // its metadata.
  //
  // Safe to do when enabled: navigation never replaces a draft in the editor
  // (see showNavigationSql), including one the host restored for this file.
  // Not when the user has already chosen something.
  if (previewFirst && tables.length > 0 && data.state.selection.sheet === undefined) {
    previewTable(tables[0]);
  }
}

function applyTableChangeStatus(status: Record<string, TableStatus>): void {
  const items = tableListEl.querySelectorAll<HTMLDivElement>('.table-item');
  items.forEach((item) => {
    const name = item.dataset.table;
    if (!name) return;
    const s = status[name];
    if (s === 'unchanged') item.textContent = `${name} (unchanged)`;
    else if (s === 'changed') item.textContent = `${name} (changed)`;
    else if (s === 'new') item.textContent = `${name} (new since backup)`;
    else item.textContent = name;
  });
}

interface InlineTableUiState {
  filters: Map<string, Omit<DetectedTableFilter, 'column'>>;
  sort?: DetectedTableSort;
  result?: {
    columns: string[];
    rows: unknown[][];
    columnStatsKind: StatsKind[];
    sql: string;
    totalRows: number;
  };
}

const inlineTableState = new Map<string, InlineTableUiState>();
let inlineOwnerRows: unknown[][] | undefined;

function inlineStateFor(table: string): InlineTableUiState {
  let current = inlineTableState.get(table);
  if (!current) {
    current = { filters: new Map() };
    inlineTableState.set(table, current);
  }
  return current;
}

function sheetTableByName(name: string): DetectedSheetTable | undefined {
  return data.state.lastResult?.sheetTables?.find((table) => table.name === name);
}

function sheetTableDisplayLimit(table: DetectedSheetTable): number {
  if (!data.state.lastResult) return 1;
  // One result row per data-row slot on screen: blank and repeated-header rows
  // are not slots (EX-05 source-row map).
  return Math.max(1, slotsBefore(tableDataRows(table), data.state.lastResult.rows.length));
}

function filtersForMessage(current: InlineTableUiState): DetectedTableFilter[] {
  return [...current.filters].map(([column, filter]) => ({ column, ...filter }));
}

function requestInlineTable(table: DetectedSheetTable): void {
  if (running) return;
  const current = inlineStateFor(table.name);
  setRunning(true);
  statusEl.textContent = `Updating ${table.name}…`;
  vscode.postMessage({
    command: 'sheetTableQuery',
    table: table.name,
    filters: filtersForMessage(current),
    sort: current.sort,
    limit: sheetTableDisplayLimit(table),
  });
}

let filterPopoverEl: HTMLDivElement | null = null;

function closeFilterPopover(): void {
  filterPopoverEl?.remove();
  filterPopoverEl = null;
}

function openInlineFilter(anchor: HTMLElement, table: DetectedSheetTable, column: string): void {
  if (running) return;
  closeStatsPopover();
  closeFilterPopover();
  const current = inlineStateFor(table.name);
  const popover = document.createElement('div');
  popover.className = 'filter-popover';

  const title = document.createElement('div');
  title.className = 'stats-title';
  title.textContent = `Filter ${column}`;
  const existing = current.filters.get(column);
  const operator = document.createElement('select');
  operator.className = 'filter-operator';
  const choices: [DetectedTableFilter['operator'], string][] = [
    ['contains', 'Contains'],
    ['equals', 'Equals'],
    ['notEquals', 'Not equal'],
    ['gt', 'Greater than'],
    ['gte', 'Greater than or equal'],
    ['lt', 'Less than'],
    ['lte', 'Less than or equal'],
    ['between', 'Between'],
    ['isBlank', 'Is blank'],
    ['isNotBlank', 'Is not blank'],
  ];
  for (const [value, label] of choices) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    operator.appendChild(option);
  }
  operator.value = existing?.operator ?? 'contains';
  const input = document.createElement('input');
  input.className = 'filter-input';
  input.placeholder = 'Value…';
  input.value = existing?.value ?? '';
  const inputTo = document.createElement('input');
  inputTo.className = 'filter-input';
  inputTo.placeholder = 'And…';
  inputTo.value = existing?.valueTo ?? '';
  const actions = document.createElement('div');
  actions.className = 'filter-actions';
  const clear = document.createElement('button');
  clear.textContent = 'Clear';
  const apply = document.createElement('button');
  apply.textContent = 'Apply';
  actions.appendChild(clear);
  actions.appendChild(apply);
  popover.appendChild(title);
  popover.appendChild(operator);
  popover.appendChild(input);
  popover.appendChild(inputTo);
  popover.appendChild(actions);
  document.body.appendChild(popover);
  positionPopover(popover, anchor);
  filterPopoverEl = popover;

  const closeOnOutsideClick = (event: MouseEvent) => {
    if (!filterPopoverEl || !filterPopoverEl.contains(event.target as Node)) {
      closeFilterPopover();
      document.removeEventListener('click', closeOnOutsideClick, true);
    }
  };
  window.setTimeout(() => document.addEventListener('click', closeOnOutsideClick, true), 0);

  const selectedOperator = () => operator.value as DetectedTableFilter['operator'];
  const updateInputs = () => {
    const selected = selectedOperator();
    const needsNoValue = selected === 'isBlank' || selected === 'isNotBlank';
    input.hidden = needsNoValue;
    inputTo.hidden = selected !== 'between';
  };
  updateInputs();
  operator.addEventListener('change', updateInputs);

  const commit = () => {
    const selected = selectedOperator();
    const needsNoValue = selected === 'isBlank' || selected === 'isNotBlank';
    if (!needsNoValue && (input.value === '' || (selected === 'between' && inputTo.value === ''))) {
      current.filters.delete(column);
    } else {
      current.filters.set(column, {
        operator: selected,
        value: needsNoValue ? undefined : input.value,
        valueTo: selected === 'between' ? inputTo.value : undefined,
      });
    }
    closeFilterPopover();
    requestInlineTable(table);
  };
  clear.addEventListener('click', () => {
    current.filters.delete(column);
    closeFilterPopover();
    requestInlineTable(table);
  });
  apply.addEventListener('click', commit);
  for (const field of [input, inputTo]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit();
      else if (event.key === 'Escape') closeFilterPopover();
    });
  }
  window.setTimeout(() => (input.hidden ? operator : input).focus(), 0);
}

function requestInlineStats(anchor: HTMLElement, table: DetectedSheetTable, column: string): void {
  if (running) return;
  closeFilterPopover();
  closeStatsPopover();
  const popover = document.createElement('div');
  popover.className = 'stats-popover';
  popover.innerHTML = '<div class="stats-loading">Loading…</div>';
  document.body.appendChild(popover);
  positionPopover(popover, anchor);
  statsPopoverEl = popover;
  pendingStatsColumn = column;
  pendingStatsTable = table.name;
  pendingStatsAnchor = anchor;
  const closeOnOutsideClick = (event: MouseEvent) => {
    if (!statsPopoverEl || !statsPopoverEl.contains(event.target as Node)) {
      closeStatsPopover();
      document.removeEventListener('click', closeOnOutsideClick, true);
    }
  };
  window.setTimeout(() => document.addEventListener('click', closeOnOutsideClick, true), 0);
  const current = inlineStateFor(table.name);
  vscode.postMessage({
    command: 'sheetTableStats',
    table: table.name,
    column,
    filters: filtersForMessage(current),
    sort: current.sort,
    limit: sheetTableDisplayLimit(table),
  });
}

function requestInlineChart(table: DetectedSheetTable, column: string): void {
  if (running) return;
  const current = inlineStateFor(table.name);
  vscode.postMessage({
    command: 'sheetTableChart',
    table: table.name,
    column,
    xIsRow: axisChoice.row,
    xDateColumn: axisChoice.dateColumn,
    filters: filtersForMessage(current),
    sort: current.sort,
    limit: sheetTableDisplayLimit(table),
  });
}

/**
 * Thin wrapper over the shared ordering logic in sortOrder.ts: decides
 * *whether* to sort, which is webview state, and delegates *how* to sort,
 * which is pure and lives where it can be tested against DuckDB's own output.
 */
// The ordering rules and their memo now live in gridOrder.ts, where they can
// be tested; this is the single cache instance the grid uses.
const displayOrderCache = new DisplayOrderCache();

function displayOrder(): number[] {
  return displayOrderCache.order(data.state.lastResult!, data.state.sortState);
}

function renderStatsPopoverContent(container: HTMLElement, message: Extract<ExtensionMessage, { command: 'columnStatsResult' }>): void {
  container.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'stats-title';
  title.textContent = message.column;
  container.appendChild(title);

  if (message.totalRows === 0) {
    const empty = document.createElement('div');
    empty.className = 'stats-empty';
    empty.textContent = 'No data.';
    container.appendChild(empty);
    return;
  }
  if (message.nonNullRows === 0) {
    const empty = document.createElement('div');
    empty.className = 'stats-empty';
    empty.textContent = `All ${message.totalRows} value${message.totalRows === 1 ? '' : 's'} are NULL.`;
    container.appendChild(empty);
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'stats-summary';
  summary.textContent = `${message.nonNullRows} of ${message.totalRows} rows non-null (${message.nullCount} null)`;
  container.appendChild(summary);

  if (message.statsKind === 'other') {
    const distinct = document.createElement('div');
    distinct.className = 'stats-summary';
    distinct.textContent = `${message.distinctCount ?? 0} distinct value${message.distinctCount === 1 ? '' : 's'}`;
    container.appendChild(distinct);

    const list = document.createElement('div');
    list.className = 'stats-top-values';
    for (const { value, frequency } of message.topValues ?? []) {
      const row = document.createElement('div');
      row.className = 'stats-top-value-row';
      const val = document.createElement('span');
      val.className = 'stats-top-value';
      val.textContent = formatValue(value, message.statsKind);
      const freq = document.createElement('span');
      freq.className = 'stats-top-freq';
      freq.textContent = String(frequency);
      row.appendChild(val);
      row.appendChild(freq);
      list.appendChild(row);
    }
    container.appendChild(list);
  } else {
    // `rounded` marks the three that are COMPUTED rather than observed. min
    // and max are values that are actually in the data, and shortening one is
    // shortening an observation; avg is an average and p5/p95 already say
    // "approx." on the label, so the seventeenth decimal of either was never
    // telling anyone anything.
    const rows: [string, unknown, boolean][] = [
      ['min', message.min, false],
      ['max', message.max, false],
      ['avg', message.mean, true],
      ['p5 (approx.)', message.p5, true],
      ['p95 (approx.)', message.p95, true],
    ];
    const table = document.createElement('div');
    table.className = 'stats-descriptive';
    for (const [label, value, rounded] of rows) {
      const row = document.createElement('div');
      row.className = 'stats-descriptive-row';
      const l = document.createElement('span');
      l.className = 'stats-descriptive-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'stats-descriptive-value';
      v.textContent =
        rounded && message.statsKind === 'numeric'
          ? formatStat(value)
          : formatValue(value, message.statsKind);
      row.appendChild(l);
      row.appendChild(v);
      table.appendChild(row);
    }
    container.appendChild(table);
  }
}

function renderInlineStatsPopover(
  container: HTMLElement,
  column: string,
  statsKind: StatsKind,
  shown: ColumnStatsFields,
  all: ColumnStatsFields
): void {
  container.innerHTML = '';
  const shownSection = document.createElement('section');
  shownSection.className = 'stats-scope';
  renderStatsPopoverContent(shownSection, {
    command: 'columnStatsResult',
    column: `${column} — shown`,
    statsKind,
    ...shown,
  });
  const allSection = document.createElement('section');
  allSection.className = 'stats-scope';
  renderStatsPopoverContent(allSection, {
    command: 'columnStatsResult',
    column: `${column} — all table rows`,
    statsKind,
    ...all,
  });
  container.appendChild(shownSection);
  container.appendChild(allSection);
}

let statsPopoverEl: HTMLDivElement | null = null;
let pendingStatsColumn: string | null = null;
let pendingStatsTable: string | null = null;
let pendingStatsAnchor: HTMLElement | null = null;

function closeStatsPopover(): void {
  statsPopoverEl?.remove();
  statsPopoverEl = null;
  pendingStatsColumn = null;
  pendingStatsTable = null;
  pendingStatsAnchor = null;
}

// The popover's size changes once real content replaces the "Loading…"
// placeholder, so this is called both right after opening (rough initial
// placement) and again once the final content is rendered (correct
// placement) -- a single up-front clamp using the small placeholder's size
// would let a wide/tall result overflow again after it loads.
function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();

  let left = anchorRect.left;
  if (left + popRect.width > window.innerWidth) {
    left = anchorRect.right - popRect.width;
  }
  left = Math.max(0, left);

  let top = anchorRect.bottom + 4;
  if (top + popRect.height > window.innerHeight) {
    top = anchorRect.top - popRect.height - 4;
  }
  top = Math.max(0, top);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function openStatsPopover(anchor: HTMLElement, column: string, statsKind: StatsKind): void {
  if (running) return;
  closeStatsPopover();
  closeCellInspector();

  const popover = document.createElement('div');
  popover.className = 'stats-popover';
  popover.innerHTML = '<div class="stats-loading">Loading…</div>';
  document.body.appendChild(popover);
  positionPopover(popover, anchor);
  statsPopoverEl = popover;
  pendingStatsColumn = column;
  pendingStatsTable = null;
  pendingStatsAnchor = anchor;

  const closeOnOutsideClick = (e: MouseEvent) => {
    if (!statsPopoverEl || !statsPopoverEl.contains(e.target as Node)) {
      closeStatsPopover();
      document.removeEventListener('click', closeOnOutsideClick, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutsideClick, true), 0);

  vscode.postMessage({ command: 'columnStats', column, statsKind, limit: 20 });
}

let inspectorCleanup: (() => void) | null = null;
let pendingCellEdit: {
  rowIdx: number;
  colIdx: number;
  column: string;
  statusEl: HTMLSpanElement;
  saveBtn: HTMLButtonElement;
} | null = null;

function closeCellInspector(): void {
  inspectorCleanup?.();
  inspectorCleanup = null;
  pendingCellEdit = null;
}

function openCellInspector(rowIdx: number, colIdx: number): void {
  if (!data.state.lastResult || running) return;
  closeStatsPopover();
  closeCellInspector();

  const column = data.state.lastResult.columns[colIdx];
  // A cell under a sorted/filtered inline table shows another row's value; its
  // sheet coordinate is not the row the user sees, so it is never edited here.
  const overlay = isWorksheetPreview()
    ? inlineCellValue(rowIdx, colIdx, data.state.lastResult.rows[rowIdx][colIdx])
    : { value: data.state.lastResult.rows[rowIdx][colIdx], filteredOut: false, reordered: false };
  const overlaid = overlay.reordered || overlay.filteredOut;
  const value = overlaid ? overlay.value : data.state.lastResult.rows[rowIdx][colIdx];
  const canEdit = data.state.lastResult.editable && !safeModeCheck.checked && !overlaid;

  const isObjectValue = typeof value === 'object' && value !== null;
  let jsonParsed: unknown;
  let looksLikeJson = false;
  if (!isObjectValue && typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        jsonParsed = JSON.parse(trimmed);
        looksLikeJson = true;
      } catch {
        // Not actually JSON — fall through to plain text display.
      }
    }
  }
  const isNullValue = value === null || value === undefined;
  const displayText = isNullValue
    ? ''
    : isObjectValue
      ? JSON.stringify(value, null, 2)
      : looksLikeJson
        ? JSON.stringify(jsonParsed, null, 2)
        : String(value);
  const useJsonLang = isObjectValue || looksLikeJson;

  const backdrop = document.createElement('div');
  backdrop.className = 'cell-inspector-backdrop';
  const panel = document.createElement('div');
  panel.className = 'cell-inspector-panel';

  const header = document.createElement('div');
  header.className = 'cell-inspector-header';
  const title = document.createElement('span');
  title.textContent = column;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'cell-inspector-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', closeCellInspector);
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'cell-inspector-body';
  panel.appendChild(body);

  const editorExtensions = [basicSetup, oneDark, EditorView.lineWrapping];
  if (useJsonLang) editorExtensions.push(json());
  if (!canEdit) editorExtensions.push(EditorView.editable.of(false));

  const inspectorEditor = new EditorView({
    doc: displayText,
    extensions: editorExtensions,
    parent: body,
  });

  const footer = document.createElement('div');
  footer.className = 'cell-inspector-footer';

  if (canEdit) {
    const nullBtn = document.createElement('button');
    nullBtn.className = 'cell-inspector-secondary';
    nullBtn.textContent = 'Set NULL';
    nullBtn.addEventListener('click', () => {
      inspectorEditor.dispatch({ changes: { from: 0, to: inspectorEditor.state.doc.length, insert: '' } });
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    const statusSpan = document.createElement('span');
    statusSpan.className = 'cell-inspector-status';

    saveBtn.addEventListener('click', () => {
      // The host serializes edits rather than dropping a second one, so a
      // double-click would otherwise send two updates and the second would
      // come back as "no matching row" against the row the first just changed.
      if (running || !data.state.lastResult || saveBtn.disabled) return;
      saveBtn.disabled = true;
      const text = inspectorEditor.state.doc.toString();
      // Empty input means NULL, not the literal empty string — matches how
      // NULL is already shown as literal text "NULL" elsewhere in the grid.
      const newValue = text === '' ? null : text;
      const rowValues: Record<string, unknown> = {};
      data.state.lastResult.columns.forEach((c, j) => {
        rowValues[c] = data.state.lastResult!.rows[rowIdx][j];
      });
      pendingCellEdit = { rowIdx, colIdx, column, statusEl: statusSpan, saveBtn };
      statusSpan.textContent = 'Saving…';
      vscode.postMessage({ command: 'updateCell', column, newValue, rowValues });
    });

    footer.appendChild(nullBtn);
    footer.appendChild(saveBtn);
    footer.appendChild(statusSpan);
  } else {
    const note = document.createElement('span');
    note.className = 'cell-inspector-note';
    note.textContent = overlaid
      ? 'View only — this table is sorted or filtered, so this cell is not the sheet row it sits on. Clear its sort and filters, or open it with SQL, to edit.'
      : !data.state.lastResult.editable
      ? "View only — this result isn't a plain single-table SELECT, so it can't be edited."
      : 'View only — uncheck Safe Mode to edit.';
    footer.appendChild(note);
  }
  panel.appendChild(footer);

  backdrop.appendChild(panel);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeCellInspector();
  });
  document.body.appendChild(backdrop);

  inspectorCleanup = () => {
    inspectorEditor.destroy();
    backdrop.remove();
  };
}

// Windowed/virtualized rendering: above VIRTUALIZE_THRESHOLD rows, only the
// rows in (or just outside) the visible viewport get real <tr> DOM nodes —
// two spacer rows stand in for the skipped rows above/below, sized so the
// native scrollbar behaves as if every row were present. This matters most
// for a live view that can re-run every tick, and especially the combined
// hot+cold view where the result can hold real history.
const VIRTUALIZE_THRESHOLD = 200;
let measuredRowHeight = 25; // corrected from a real rendered row below; this is just the initial estimate
// Signature of the header currently on screen — see the reuse check in renderResults.
let renderedHeaderKey: string | undefined;
let virtualState: { order: number[]; rowHeight: number } | undefined;
let virtualRenderScheduled = false;

function inlineCellValue(
  rowIndex: number,
  columnIndex: number,
  original: unknown
): { value: unknown; filteredOut: boolean; reordered: boolean } {
  for (const table of data.state.lastResult?.sheetTables ?? []) {
    const ui = inlineTableState.get(table.name);
    const current = ui?.result;
    if (!current || columnIndex < table.left || columnIndex >= table.right) continue;
    // Result row k fills the k-th data row of the source-row map; a blank or
    // repeated-header row inside the table keeps showing the sheet.
    const slot = slotOfGridRow(tableDataRows(table), rowIndex);
    if (slot < 0) continue;
    // Sorted or filtered, the cell no longer shows this sheet row's value.
    const reordered = ui.filters.size > 0 || ui.sort !== undefined;
    const resultRow = current.rows[slot];
    if (!resultRow) return { value: '', filteredOut: true, reordered };
    return { value: resultRow[columnIndex - table.left], filteredOut: false, reordered };
  }
  return { value: original, filteredOut: false, reordered: false };
}

function appendInlineHeaderControls(
  td: HTMLTableCellElement,
  table: DetectedSheetTable,
  sheetColumnIndex: number
): void {
  const columnIndex = sheetColumnIndex - table.left;
  const column = table.columns[columnIndex];
  if (column === undefined) return;
  td.classList.add('sheet-table-header');

  const controls = document.createElement('span');
  controls.className = 'sheet-table-controls';
  controls.title = table.name;
  controls.addEventListener('dblclick', (event) => event.stopPropagation());
  const current = inlineStateFor(table.name);

  if (columnIndex === 0) {
    const label = document.createElement('span');
    label.className = 'sheet-table-label';
    const count = current.result
      ? `${current.result.rows.length} shown · ${current.result.totalRows} match · ${table.rowCount} total`
      : `${table.rowCount} rows`;
    label.textContent = `${table.name.slice(table.name.lastIndexOf('·'))} · ${count}`;
    controls.appendChild(label);
    const sqlButton = document.createElement('button');
    sqlButton.className = 'sheet-table-sql';
    sqlButton.textContent = 'SQL';
    sqlButton.title = 'Open this table’s current filter and sort in the SQL editor';
    sqlButton.addEventListener('click', event => {
      event.stopPropagation();
      vscode.postMessage({ command: 'sheetTableSql', table: table.name, filters: filtersForMessage(current), sort: current.sort,
        limit: sheetTableDisplayLimit(table), generation: picker.generation });
    });
    controls.appendChild(sqlButton);
  }

  const isActiveSort = current.sort?.column === column;
  const sort = document.createElement('button');
  sort.className = 'sheet-table-sort';
  sort.classList.toggle('active', isActiveSort);
  sort.textContent = isActiveSort ? (current.sort!.direction === 'asc' ? '▲' : '▼') : '⇅';
  sort.title = isActiveSort ? 'Reverse this table sort' : `Sort this table by ${column}`;
  sort.addEventListener('click', (event) => {
    event.stopPropagation();
    const latest = inlineStateFor(table.name);
    latest.sort = {
      column,
      direction: latest.sort?.column === column && latest.sort.direction === 'asc' ? 'desc' : 'asc',
    };
    requestInlineTable(table);
  });

  const filter = document.createElement('button');
  filter.className = 'sheet-table-filter';
  filter.classList.toggle('active', current.filters.has(column));
  filter.textContent = '⌕';
  filter.title = `Filter this table by ${column}`;
  filter.addEventListener('click', (event) => {
    event.stopPropagation();
    openInlineFilter(filter, table, column);
  });

  const stats = document.createElement('button');
  stats.className = 'sheet-table-stats';
  stats.textContent = '≡';
  stats.title = `Statistics for shown and all ${column} values`;
  stats.addEventListener('click', (event) => {
    event.stopPropagation();
    requestInlineStats(stats, table, column);
  });

  controls.appendChild(sort);
  controls.appendChild(filter);
  controls.appendChild(stats);
  const kinds = current.result?.columnStatsKind ?? table.columnStatsKind;
  if (plottableColumns(table.columns, kinds, axisChoice).includes(column)) {
    const plot = document.createElement('button');
    plot.className = 'sheet-table-plot';
    plot.textContent = '📈';
    plot.title = `Plot the rows shown for ${column}`;
    plot.addEventListener('click', (event) => {
      event.stopPropagation();
      requestInlineChart(table, column);
    });
    controls.appendChild(plot);
  }
  td.appendChild(controls);
}

/** A worksheet preview, where grid row i is Excel row i + 1 and the columns are Excel letters. */
function isWorksheetPreview(): boolean {
  return data.state.lastResult?.sheetTables !== undefined;
}

/**
 * What the Query table choice outlines on the worksheet shown: a detected
 * table's cells, or the raw worksheet's used range. Nothing when the choice
 * belongs to another sheet or no worksheet preview is on screen.
 */
function highlightedTable(): SheetBounds | undefined {
  const target = picker.selected;
  const result = data.state.lastResult;
  if (!target || result?.sheetTables === undefined) return undefined;
  if (target.worksheet !== undefined && target.worksheet === result.sheetPreview && target.bounds) return target.bounds;
  // The catalog page carrying bounds can arrive just after the rows; the
  // detected tables in the result already know their own cells.
  return result.sheetTables.find((table) => table.name === target.name);
}

const HIGHLIGHT_COLOR = '#e5c07b';

// Inset shadows rather than borders: under border-collapse a border would
// widen the cell and shift the grid every time the selection changes.
function applyTableHighlight(td: HTMLTableCellElement, i: number, j: number, table: SheetBounds | undefined = highlightedTable()): void {
  const edges = table ? tableEdges(table, i, j) : undefined;
  const shadows: string[] = [];
  if (edges?.top) shadows.push(`inset 0 1px 0 ${HIGHLIGHT_COLOR}`);
  if (edges?.right) shadows.push(`inset -1px 0 0 ${HIGHLIGHT_COLOR}`);
  if (edges?.bottom) shadows.push(`inset 0 -1px 0 ${HIGHLIGHT_COLOR}`);
  if (edges?.left) shadows.push(`inset 1px 0 0 ${HIGHLIGHT_COLOR}`);
  td.style.boxShadow = shadows.join(', ');
}

/** Redraws the outline on the rows already in the DOM, without re-rendering the grid. */
function refreshTableHighlight(): void {
  const table = highlightedTable();
  resultsEl.querySelectorAll<HTMLTableCellElement>('td[data-r]').forEach((td) => {
    applyTableHighlight(td, Number(td.dataset.r), Number(td.dataset.c), table);
  });
}

function buildRowElement(i: number, displayIdx: number): HTMLTableRowElement {
  const { rows, cellChanged, rowIsNew, columnStatsKind } = data.state.lastResult!;
  const row = rows[i];
  const tr = document.createElement('tr');
  tr.className = displayIdx % 2 === 0 ? 'even' : 'odd';
  const isNewRow = rowIsNew?.[i] === true;
  if (isNewRow) tr.classList.add('row-new');
  const highlighted = highlightedTable();
  if (isWorksheetPreview()) {
    // No data-r/data-c, so the delegated double-click leaves it alone. A
    // preview is never re-sorted, so i is the worksheet row.
    const rowNum = document.createElement('td');
    rowNum.className = 'row-num';
    rowNum.textContent = String(i + 1);
    tr.appendChild(rowNum);
  }
  row.forEach((originalValue, j) => {
    const td = document.createElement('td');
    const { value, filteredOut } = inlineCellValue(i, j, originalValue);
    td.textContent = filteredOut ? '' : formatValue(value, columnStatsKind[j]);
    if (!filteredOut && (value === null || value === undefined)) td.classList.add('cell-null');
    if (filteredOut) td.classList.add('cell-filtered-out');
    if (!isNewRow && cellChanged?.[i]?.[j]) td.classList.add('cell-changed');
    // Coordinates on the element, handled by one delegated listener below,
    // rather than a closure per cell: renderVirtualWindow rebuilds its window
    // on every scroll frame, so per-cell listeners meant thousands of closure
    // allocations per frame.
    td.dataset.r = String(i);
    td.dataset.c = String(j);
    if (j % 2 === 1) td.classList.add('col-odd');
    if (highlighted) applyTableHighlight(td, i, j, highlighted);
    for (const table of data.state.lastResult?.sheetTables ?? []) {
      const headerRow = table.headerRow ?? table.top;
      if (i === headerRow && j >= table.left && j < table.right) {
        appendInlineHeaderControls(td, table, j);
        break;
      }
    }
    tr.appendChild(td);
  });
  return tr;
}

function appendSpacerRow(tbody: HTMLTableSectionElement, heightPx: number, colCount: number): void {
  if (heightPx <= 0) return;
  const tr = document.createElement('tr');
  tr.className = 'spacer-row';
  tr.style.height = `${heightPx}px`;
  const td = document.createElement('td');
  td.colSpan = colCount;
  td.style.padding = '0';
  td.style.border = 'none';
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderVirtualWindow(): void {
  if (!virtualState || !data.state.lastResult) return;
  const tbody = resultsEl.querySelector('tbody');
  if (!tbody) return;
  const { order, rowHeight } = virtualState;
  const { start, end, topSpacerPx, bottomSpacerPx } = computeVirtualWindow({
    scrollTop: resultsEl.scrollTop,
    viewportHeight: resultsEl.clientHeight,
    rowHeight,
    rowCount: order.length,
  });
  tbody.innerHTML = '';
  const colCount = data.state.lastResult.columns.length + (isWorksheetPreview() ? 1 : 0);
  appendSpacerRow(tbody, topSpacerPx, colCount);
  const frag = document.createDocumentFragment();
  for (let displayIdx = start; displayIdx < end; displayIdx++) {
    frag.appendChild(buildRowElement(order[displayIdx], displayIdx));
  }
  tbody.appendChild(frag);
  appendSpacerRow(tbody, bottomSpacerPx, colCount);
}

// Delegated cell-inspector trigger. Attached to #results, which survives every
// re-render, so it covers rows that don't exist yet — including the ones the
// virtual window creates and destroys as you scroll.
resultsEl.addEventListener('dblclick', (e) => {
  const td = (e.target as HTMLElement | null)?.closest?.('td');
  if (!td || !resultsEl.contains(td)) return;
  const { r, c } = (td as HTMLTableCellElement).dataset;
  if (r === undefined || c === undefined) return;
  openCellInspector(Number(r), Number(c));
});

// Attached once, not per-render — renderResults() below fully rebuilds
// #results' contents on every call, which would orphan a listener declared
// there. Reads whatever `virtualState`/`state.lastResult` currently hold instead.
resultsEl.addEventListener('scroll', () => {
  // Pinned-to-bottom tracking for live mode's sliding tail window: only
  // auto-follow new rows in when the user was already at the bottom (log
  // tail/chat-scroll convention) — otherwise a live tick would repeatedly
  // yank someone inspecting history back down to the newest row.
  data.state.pinnedToBottom = resultsEl.scrollTop + resultsEl.clientHeight >= resultsEl.scrollHeight - 4;
  if (virtualRenderScheduled) return;
  virtualRenderScheduled = true;
  requestAnimationFrame(() => {
    virtualRenderScheduled = false;
    renderVirtualWindow();
  });
});

/**
 * `preserveScroll` is used for live ticks re-rendering the *same* ongoing
 * query — a fresh manual query/sort always starts scrolled to the top
 * (the default, `false`). Scroll position is preserved by raw pixel offset,
 * not by anchoring to a specific row's identity — a live tail's `LIMIT N`
 * window means the oldest visible row can drop out from under a fixed
 * index between ticks, so pixel-offset preservation is an approximation,
 * not a guarantee the exact same row stays under the cursor. Good enough
 * for the common case (a handful of new rows per tick); true identity-based
 * anchoring would be a further refinement.
 */
/**
 * SAFE-X1: a worksheet whose table discovery did not complete says so above
 * the grid, so a failure never looks like "this sheet has no tables". The raw
 * sheet below stays fully usable. Retry is explicit and only offered when a
 * fresh attempt could change the answer.
 */
function preparationBanner(status: SheetPreparationStatus | undefined): HTMLElement | null {
  // EX-07: every state that is not "tables ready" says so, so an empty or switched-off detection never looks like a blank success.
  const titles: Partial<Record<SheetPreparationStatus['state'], string>> = {
    pending: 'Detecting tables…', none: 'No tables found', disabled: 'Table detection is off',
    failed: 'Table detection failed', cancelled: 'Table detection cancelled', incomplete: 'Detection incomplete', bounded: 'Detection limited',
  };
  const fallback: Partial<Record<SheetPreparationStatus['state'], string>> = {
    none: 'The whole sheet is shown below.', disabled: 'Enable dataFileViewer.sheetTables to look for tables; the whole sheet is shown below.',
  };
  const title = status ? titles[status.state] : undefined;
  if (!status || !title) return null;
  const banner = document.createElement('div');
  banner.className = `sheet-preparation sheet-preparation-${status.state}`;
  banner.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = status.state === 'pending' ? title : `${title}. ${status.message ?? fallback[status.state] ?? ''}`.trim();
  banner.appendChild(text);
  if (status.retryable) {
    const retry = document.createElement('button');
    retry.className = 'sheet-preparation-retry';
    retry.textContent = 'Retry detection';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      retry.textContent = 'Detecting…';
      vscode.postMessage({ command: 'retrySheetPreparation', sheet: status.sheet });
    });
    banner.appendChild(retry);
  }
  return banner;
}

/**
 * PERF-X1: each grid render is recorded as one `dfv-render` performance
 * measure (only the latest is kept), so the render phase can be timed
 * separately from host-side preparation without a debug build.
 */
function renderResults(preserveScroll = false): void {
  const started = performance.now();
  try { renderResultsNow(preserveScroll); } finally {
    try { performance.clearMeasures('dfv-render'); performance.measure('dfv-render', { start: started, end: performance.now() }); } catch { /* timing is optional */ }
  }
}

function renderResultsNow(preserveScroll: boolean): void {
  const preservedScrollTop = preserveScroll ? resultsEl.scrollTop : 0;
  const wasPinnedToBottom = preserveScroll && data.state.pinnedToBottom;

  virtualState = undefined;
  if (!data.state.lastResult) {
    resultsEl.innerHTML = '';
    renderedHeaderKey = undefined;
    return;
  }
  if (inlineOwnerRows !== data.state.lastResult.rows) {
    inlineTableState.clear();
    inlineOwnerRows = data.state.lastResult.rows;
    closeFilterPopover();
  }
  const { columns, rows, cellChanged, rowIsNew, renamedColumns, columnStatsKind } = data.state.lastResult;

  if (columns.length === 0) {
    resultsEl.innerHTML = '<div class="empty">Query returned no columns.</div>';
    renderedHeaderKey = undefined;
    return;
  }

  // A live tick re-runs the same query, so the header is almost always
  // identical to the one already on screen. Rebuilding it anyway threw away
  // the sort/stats buttons several times a second — and with them the anchor
  // element an open stats popover positions against.
  const preparation = isWorksheetPreview() ? data.state.lastResult.sheetPreparation : undefined;
  const headerKey = JSON.stringify([columns, renamedColumns ?? null, data.state.sortState ?? null, columnStatsKind, isWorksheetPreview(), axisChoice,
    preparation ? [preparation.state, preparation.generation, preparation.skipped] : null]);
  const existingTable = resultsEl.querySelector('table');
  const reuseHeader = preserveScroll && existingTable !== null && headerKey === renderedHeaderKey;

  if (reuseHeader) {
    renderRowsInto(existingTable, preservedScrollTop, wasPinnedToBottom);
    return;
  }

  resultsEl.innerHTML = '';
  renderedHeaderKey = headerKey;
  refreshAxisChoice();
  const banner = preparationBanner(preparation);
  if (banner) resultsEl.appendChild(banner);

  const table = document.createElement('table');

  const plottable = new Set(plottableColumns(columns, columnStatsKind, axisChoice));
  const xAxis = chartXAxis();

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  if (isWorksheetPreview()) {
    const corner = document.createElement('th');
    corner.className = 'sheet-corner';
    headRow.appendChild(corner);
  }
  columns.forEach((col, colIdx) => {
    const th = document.createElement('th');
    // display:flex has to live on this inner wrapper, not on <th> itself --
    // see the .th-inner comment in main.css for why.
    const inner = document.createElement('span');
    inner.className = 'th-inner';
    const label = document.createElement('span');
    label.className = 'th-label';
    label.textContent = col;
    const renamedFrom = renamedColumns?.[col];
    if (renamedFrom) {
      th.title = `renamed from "${renamedFrom}"`;
      th.classList.add('col-renamed');
    }
    inner.appendChild(label);

    // A worksheet's A/B/C headers describe the page grid, not one data
    // table. Sorting one of them would move whole worksheet rows and detach
    // every detected region from its coordinates; the real table controls
    // live on each promoted header below instead.
    if (data.state.lastResult?.sheetTables !== undefined) {
      th.classList.add('sheet-letter');
      th.appendChild(inner);
      headRow.appendChild(th);
      return;
    }

    const controls = document.createElement('span');
    controls.className = 'th-controls';

    const isActiveSort = data.state.sortState?.columnIndex === colIdx;
    const sortBtn = document.createElement('button');
    sortBtn.className = 'th-sort-btn';
    sortBtn.classList.toggle('th-sort-btn-active', isActiveSort);
    sortBtn.textContent = isActiveSort ? (data.state.sortState!.direction === 'asc' ? '▲' : '▼') : '⇅';
    sortBtn.title = isActiveSort
      ? `Sorted ${data.state.sortState!.direction === 'asc' ? 'ascending' : 'descending'} — click to reverse`
      : 'Sort ascending';
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (running) return;
      clearRange();
      vscode.postMessage({ command: 'invalidateRange' });
      const direction = isActiveSort && data.state.sortState!.direction === 'asc' ? 'desc' : 'asc';
      data.state.sortState = { columnIndex: colIdx, direction };
      if (data.state.lastResult) data.state.lastResult.serverSorted = false;
      if (data.state.lastResult?.hasLimit) {
        // A LIMIT-ed result can't be correctly re-sorted from just the rows
        // already in memory (see hasLimit's origin in duckdbConnection.ts) --
        // ask the host to re-run the query sorted against the full data.
        setRunning(true);
        statusEl.textContent = 'Sorting…';
        vscode.postMessage({ command: 'sortQuery', column: col, direction });
      } else {
        renderResults();
      }
    });

    const statsBtn = document.createElement('button');
    statsBtn.className = 'th-stats-btn';
    statsBtn.textContent = '≡';
    statsBtn.title = columnStatsKind[colIdx] === 'other' ? 'Top values' : 'Descriptive stats';
    statsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStatsPopover(statsBtn, col, columnStatsKind[colIdx]);
    });

    controls.appendChild(sortBtn);
    controls.appendChild(statsBtn);

    // Only on the columns that can actually be drawn, and only when this
    // result has an axis to draw them against -- an offer to plot something
    // that cannot be plotted is worse than no offer. plottable is computed
    // once per render rather than per column, since pickXAxis scans the whole
    // header each time.
    if (plottable.has(col)) {
      const plotBtn = document.createElement('button');
      plotBtn.className = 'th-plot-btn';
      plotBtn.textContent = '📈';
      plotBtn.title = `Plot ${col} against ${xAxis?.kind === 'row' ? 'row numbers' : xAxis?.column} — the whole series, not just this page`;
      plotBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (running) return;
        requestChart(col);
      });
      controls.appendChild(plotBtn);
    }

    inner.appendChild(controls);
    th.appendChild(inner);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  resultsEl.appendChild(table);

  renderRowsInto(table, preservedScrollTop, wasPinnedToBottom);
}

/** Thousands separators, so a six-figure row count is readable at a glance. */
/** Body + footer only. Split out so a live tick can refresh the rows under an untouched header. */
function renderRowsInto(table: HTMLTableElement, preservedScrollTop: number, wasPinnedToBottom: boolean): void {
  const { rows } = data.state.lastResult!;

  table.querySelector('tbody')?.remove();
  resultsEl.querySelector('.results-footer')?.remove();

  const tbody = document.createElement('tbody');
  const order = displayOrder();
  const useVirtual = order.length > VIRTUALIZE_THRESHOLD;

  if (!useVirtual) {
    const frag = document.createDocumentFragment();
    order.forEach((i, displayIdx) => frag.appendChild(buildRowElement(i, displayIdx)));
    tbody.appendChild(frag);
  } else {
    virtualState = { order, rowHeight: measuredRowHeight };
  }
  table.appendChild(tbody);

  const footer = document.createElement('div');
  footer.className = 'results-footer';
  // "146 rows shown" cannot say whether 146 IS the answer or merely where it
  // stopped — write `limit 200` against a 146-row table and you get the same
  // footer you would get if a million rows were waiting behind it. So the
  // total is spelled out even when the two match: "146 of 146" is redundant
  // only until it is the thing you needed to know.
  const total = data.state.lastResult!.totalRows;
  const shown = rows.length;
  footer.textContent =
    total === undefined
      ? `${fmtCount(shown)} row${shown === 1 ? '' : 's'} shown`
      : `${fmtCount(shown)} of ${fmtCount(total)} row${total === 1 ? '' : 's'} shown`;

  if (data.state.lastResult!.truncated) {
    // The count above is the whole story only when nothing was cut -- say so
    // explicitly, otherwise a capped result reads as the complete answer.
    const cap = document.createElement('span');
    cap.className = 'diff-skipped-note';
    cap.textContent = ' — capped by dataFileViewer.maxResultRows; there are more rows.';
    footer.appendChild(cap);
  }

  if (data.state.lastResult!.diffSkipped) {
    const note = document.createElement('span');
    note.className = 'diff-skipped-note';
    note.textContent = ' — result too large to auto-diff against the backup.';
    const diffBtn = document.createElement('button');
    diffBtn.className = 'diff-anyway-btn';
    diffBtn.textContent = 'Diff anyway';
    diffBtn.addEventListener('click', () => {
      if (running) return;
      setRunning(true);
      statusEl.textContent = 'Diffing…';
      vscode.postMessage({ command: 'diffQuery' });
    });
    note.appendChild(diffBtn);
    footer.appendChild(note);
  }

  resultsEl.appendChild(footer);

  if (useVirtual) {
    resultsEl.scrollTop = preservedScrollTop;
    renderVirtualWindow();
    // Correct the row-height estimate from a real rendered row, now that
    // one exists, and re-render the window against the corrected value —
    // the initial constant is just a seed for the very first paint.
    const sample = tbody.querySelector('tr:not(.spacer-row)') as HTMLTableRowElement | null;
    if (sample) {
      const h = sample.getBoundingClientRect().height;
      if (h > 0 && Math.abs(h - measuredRowHeight) > 0.5) {
        measuredRowHeight = h;
        if (virtualState) virtualState.rowHeight = h;
        renderVirtualWindow();
      }
    }
    if (wasPinnedToBottom) resultsEl.scrollTop = resultsEl.scrollHeight;
  }
}

function showError(message: string): void {
  resultsEl.innerHTML = '';
  data.state.lastResult = undefined;
  const el = document.createElement('div');
  el.className = 'error';
  el.textContent = message;
  resultsEl.appendChild(el);
}

/**
 * The message loop, split in two.
 *
 * What each message DOES to the state -- and the several places where three
 * different query results deliberately treat state.sortState, totalRows and the
 * scroll position differently -- now lives in webviewState.ts, where it can be
 * tested. What is left here is the half that needs a DOM: applying the effects
 * the reducer asked for, in the order it asked for them.
 */
function applyEffect(effect: Effect): void {
  switch (effect.kind) {
    case 'renderTables':
      renderTables(effect.tables, effect.combined, effect.previewFirst);
      break;
    case 'setRunning':
      setRunning(effect.value);
      break;
    case 'status':
      statusEl.textContent = effect.text;
      break;
    case 'showError':
      showError(effect.message);
      break;
    case 'render':
      renderResults(effect.preserveScroll);
      break;
    case 'invalidateOrder':
      displayOrderCache.invalidate();
      break;
    case 'tableChangeStatus':
      applyTableChangeStatus(effect.status);
      break;
    case 'safeModeState':
      safeModeCheck.checked = effect.safeMode;
      unlockOptionsEl.hidden = effect.safeMode || data.state.liveEnabled;
      break;
    case 'setLiveUi':
      setLiveUiEnabled(effect.enabled);
      break;
    case 'setLiveIntervalInput':
      liveIntervalInput.value = String(effect.intervalMs / 1000);
      break;
    case 'startLiveStatusTicker':
      startLiveStatusTicker();
      break;
    case 'updateLiveStatusText':
      updateLiveStatusText();
      break;
    case 'liveRefreshRejected':
      modeStaticRadio.checked = true;
      modeLiveRadio.checked = false;
      break;
    case 'statsResult':
      if (statsPopoverEl && pendingStatsColumn === effect.message.column) {
        renderStatsPopoverContent(statsPopoverEl, effect.message);
        if (pendingStatsAnchor) positionPopover(statsPopoverEl, pendingStatsAnchor);
      }
      break;
    case 'statsError':
      if (statsPopoverEl && pendingStatsColumn === effect.column) {
        statsPopoverEl.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'stats-empty';
        el.textContent = effect.message;
        statsPopoverEl.appendChild(el);
        if (pendingStatsAnchor) positionPopover(statsPopoverEl, pendingStatsAnchor);
      }
      break;
    case 'sheetTableResult': {
      const current = inlineStateFor(effect.message.table);
      current.result = {
        columns: effect.message.columns,
        rows: effect.message.rows,
        columnStatsKind: effect.message.columnStatsKind,
        sql: effect.message.sql,
        totalRows: effect.message.totalRows,
      };
      renderResults(true);
      break;
    }
    case 'sheetTableStatsResult':
      if (
        statsPopoverEl &&
        pendingStatsTable === effect.message.table &&
        pendingStatsColumn === effect.message.column
      ) {
        renderInlineStatsPopover(
          statsPopoverEl,
          effect.message.column,
          effect.message.statsKind,
          effect.message.shown,
          effect.message.all
        );
        if (pendingStatsAnchor) positionPopover(statsPopoverEl, pendingStatsAnchor);
      }
      break;
    case 'sheetTableError':
      if (statsPopoverEl && pendingStatsTable === effect.table) {
        statsPopoverEl.innerHTML = '';
        const error = document.createElement('div');
        error.className = 'stats-empty';
        error.textContent = effect.message;
        statsPopoverEl.appendChild(error);
        if (pendingStatsAnchor) positionPopover(statsPopoverEl, pendingStatsAnchor);
      } else {
        statusEl.textContent = effect.message;
      }
      break;
    case 'closeCellInspector':
      closeCellInspector();
      break;
    case 'cellUpdateError':
      if (pendingCellEdit && pendingCellEdit.column === effect.column) {
        pendingCellEdit.statusEl.textContent = effect.message;
        // Re-armed so a failed edit can be corrected and retried.
        pendingCellEdit.saveBtn.disabled = false;
      }
      break;
    case 'editStatus':
      if (pendingCellEdit) {
        pendingCellEdit.statusEl.textContent = effect.message;
      }
      break;
    case 'dispatchPreview':
      dispatchPreview(effect.sheet, effect.seq);
      break;
    case 'selectionChanged':
      applySelection();
      break;
    case 'repreviewSheet':
      previewTable(effect.sheet);
      break;
  }
}

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  const wasRunning = running;
  if (message.command === 'queryCatalog') {
    const outcome = picker.acceptCatalog(message);
    if (outcome === 'ignored') return;
    if (outcome === 'reset') statusEl.textContent = 'The source changed. Select a query table again.';
    refreshQueryTargets(); refreshSqlCompletion(); refreshTableHighlight();
    return;
  }
  if (message.command === 'queryTargetDetails') {
    if (!picker.acceptDetails(message, data.state.selection.seq)) return;
    refreshQueryTargets(); refreshSqlCompletion(); refreshTableHighlight();
    return;
  }
  if (message.command === 'querySqlDraft') {
    const outcome = picker.acceptSqlDraft(message, editor.state.doc.toString(), data.state.selection.seq);
    if (outcome === 'ignored') return;
    if (outcome === 'full') { statusEl.textContent = 'Restore a saved draft before opening another SQL draft.'; return; }
    setEditorText(message.sql); queryRestoreEl.hidden = false; refreshQueryTargets(); refreshTableHighlight();
    editor.focus();
    return;
  }
  if (message.command === 'sqlDraft') {
    // The draft this file had when its editor was last closed. Restored only
    // into an editor that holds nothing of the user's yet.
    const current = editor.state.doc.toString();
    if (current === '' || current === navigationSql) { setEditorText(message.sql); savedDraft = message.sql; }
    return;
  }
  const resultBefore = data.state.lastResult;
  const effects = data.receive(event.data);
  for (const effect of effects) applyEffect(effect);
  // A stale reply changed nothing; it must not trigger a catalog refresh either.
  if ((message.command === 'queryResult' || message.command === 'error') && data.state.lastResult === resultBefore && !effects.some(e => e.kind === 'showError')) return;
  if (message.command === 'queryResult' || message.command === 'cellUpdated' || (message.command === 'error' && wasRunning) || message.command === 'tables' || (message.command === 'liveTick' && !message.unchanged)) {
    vscode.postMessage({ command: 'queryCatalog', cursor: 0 });
  }
});

refreshAxisChoice();
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message.command === 'queryResult' && message.executionSeq === data.state.paintedExecution) {
    clearRange();
    rangeContext = message.rangeContext;
    rangeApply.disabled = !rangeContext;
    if (rangeContext) rangeTarget.textContent = `${rangeContext.label} · ${rangeContext.rows} captured rows, ${rangeContext.columns} columns`;
  } else if (message.command === 'queryRangeResult' && rangeContext && rangeContext.token === message.token && message.requestId === rangeRequestId) {
    rangeApply.disabled = false;
    if (message.error) { rangePreview.hidden = false; rangePreview.textContent = message.error; }
    else {
      rangeContext.rows = message.capturedRows;
      rangeTarget.textContent = `${rangeContext.label} · ${rangeContext.rows} captured rows, ${rangeContext.columns} columns`;
      showRangePage(message);
    }
  } else if (message.command === 'error' && rangeContext && message.requestId === manualRangeRequestId) {
    const button = rangePreview.querySelector<HTMLButtonElement>('[data-use-table]');
    if (button) button.disabled = false;
  } else if (['sortQueryResult', 'cellUpdated', 'liveTick', 'sheetPreparationRetried'].includes(message.command)) clearRange();
});
vscode.postMessage({ command: 'ready' });
