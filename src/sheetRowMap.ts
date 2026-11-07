/**
 * The source-row map of a table detected inside a worksheet (EX-05).
 *
 * A detected table is not "every row of its rectangle below the header". A
 * table whose header repeats after a blank row occupies five sheet rows and
 * holds two data rows; the other three are structure. Every consumer -- the
 * derived query, the inline grid overlay, the stats/plot inputs and the edit
 * that turns a table row back into a worksheet cell -- reads the SAME list of
 * data rows from here, so they cannot disagree about which rows are data.
 *
 * Coordinates are 0-based worksheet-grid rows (grid row i is Excel row i+1).
 * Pure and dependency-free: it is bundled into the webview as well.
 */

/** A run of consecutive data rows: `start` inclusive, `end` exclusive. */
export interface RowSpan {
  start: number;
  end: number;
}

/** Why a row inside a table's rectangle is not one of its data rows. */
export type ExcludedRowReason = 'blank' | 'header';

export interface ExcludedRow {
  row: number;
  reason: ExcludedRowReason;
}

/** True when spans are non-empty integer runs, ascending and non-overlapping. */
export function validSpans(spans: unknown): spans is RowSpan[] {
  if (!Array.isArray(spans)) return false;
  let last = -1;
  for (const s of spans) {
    if (!s || typeof s !== 'object') return false;
    const { start, end } = s as RowSpan;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
    if (start < 0 || end <= start || start < last) return false;
    last = end;
  }
  return true;
}

/** How many data rows the spans hold. */
export function spanRowCount(spans: readonly RowSpan[]): number {
  let n = 0;
  for (const s of spans) n += s.end - s.start;
  return n;
}

/** Grid row of the `slot`-th data row (0-based), or undefined when there is none. */
export function gridRowOfSlot(spans: readonly RowSpan[], slot: number): number | undefined {
  if (!Number.isSafeInteger(slot) || slot < 0) return undefined;
  let remaining = slot;
  for (const s of spans) {
    const len = s.end - s.start;
    if (remaining < len) return s.start + remaining;
    remaining -= len;
  }
  return undefined;
}

/** Index of `row` among the data rows, or -1 when the row is not a data row. */
export function slotOfGridRow(spans: readonly RowSpan[], row: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (row < s.start) hi = mid - 1;
    else if (row >= s.end) lo = mid + 1;
    else {
      let before = 0;
      for (let i = 0; i < mid; i++) before += spans[i].end - spans[i].start;
      return before + (row - s.start);
    }
  }
  return -1;
}

/** How many data rows sit above grid row `limitRow` (exclusive). */
export function slotsBefore(spans: readonly RowSpan[], limitRow: number): number {
  let n = 0;
  for (const s of spans) {
    if (s.start >= limitRow) break;
    n += Math.min(s.end, limitRow) - s.start;
  }
  return n;
}

/**
 * The data rows of a detected-table description. A description restored from
 * an older webview state has no map; it is read the way it was written then --
 * every row of the rectangle below the header.
 */
export function tableDataRows(table: {
  dataRows?: unknown;
  top: number;
  bottom: number;
  headerRow: number | null;
}): RowSpan[] {
  if (validSpans(table.dataRows)) return table.dataRows;
  const first = table.headerRow === null ? table.top : table.headerRow + 1;
  return first < table.bottom ? [{ start: first, end: table.bottom }] : [];
}
