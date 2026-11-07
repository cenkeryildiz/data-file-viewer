import { DuckDBTypeId, type DuckDBConnection } from '@duckdb/node-api';
import { isBlank, type Cell } from '../../sheetTables';
import { quoteIdent, replaceWithTable } from '../sql';

/** What cacheSheetAsTable needs to know about the object it may materialise. */
export interface CacheableSource {
  cellCount?: number;
  cached?: boolean;
}

/**
 * Above this, a sheet is left as a view and re-read per query.
 *
 * 10 million cells is roughly 80 MB held as doubles — a ceiling a viewer can
 * justify, against a workbook whose every query would otherwise inflate and
 * XML-parse the whole package. Raw_Data, the sheet this was measured on, is
 * 1.68 million.
 */
export const MAX_CACHED_CELLS = 10_000_000;

/**
 * Read a sheet once, into memory, instead of once per query.
 *
 * Measured on YieldCurve_Data.xlsx (21 MB, two sheets). Opening it inflated
 * and XML-parsed the package SIX times — a 200-row shape sample, a sampling
 * scan and a verification scan, per sheet — and then once more for every
 * query the user made:
 *
 *              as a view     as a table
 *   limit 100      545 ms          8 ms
 *   count(*)       801 ms          0 ms
 *   sort           1369 ms         7 ms
 *
 * The cost is the package, not the row count: reading 200 rows of Raw_Data
 * takes 601 ms, the same as reading all 16,803. So a workbook is the one kind
 * here where re-reading per query is not a reasonable default, and the table
 * costs 646 ms once.
 *
 * Returns whether the swap happened; a failure leaves the view in place and
 * the file simply stays slower.
 */
export async function cacheSheetAsTable(
  connection: DuckDBConnection,
  name: string,
  source: CacheableSource
): Promise<boolean> {
  if (source.cellCount === undefined || source.cellCount > MAX_CACHED_CELLS) return false;
  try {
    await replaceWithTable(connection, name, `select * from ${quoteIdent(name)}`, false);
    source.cached = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * A whole table as rows of JS values, for table detection.
 *
 * The verbatim sheet is all text, and turning 1.7 M cells into JS strings one
 * DuckDB value at a time cost 575 ms on YieldCurve's Raw_Data. Encoding each
 * row as a JSON array in DuckDB and parsing it with V8's JSON parser gives the
 * identical rows (strings and nulls) in ~105 ms. Any non-text column, where
 * JSON would change the value's JS type, takes the ordinary path.
 */
export async function readGrid(connection: DuckDBConnection, name: string): Promise<{ grid: Cell[][]; columnNames: string[] }> {
  const table = quoteIdent(name);
  const head = await connection.runAndReadAll(`select * from ${table} limit 0`);
  const columnNames = head.columnNames();
  if (columnNames.length > 0 && head.columnTypes().every((t) => t.typeId === DuckDBTypeId.VARCHAR)) {
    const reader = await connection.runAndReadAll(`select to_json([${columnNames.map(quoteIdent).join(', ')}]) from ${table}`);
    return { grid: reader.getRows().map((row) => JSON.parse(String(row[0])) as Cell[]), columnNames };
  }
  const reader = await connection.runAndReadAll(`select * from ${table}`);
  return { grid: reader.getRows() as Cell[][], columnNames: reader.columnNames() };
}

/**
 * Trailing blank rows and columns of a verbatim read, as a row/column count to
 * keep.
 *
 * Only TRAILING ones. A blank row in the middle of a sheet separates two
 * tables and is load-bearing; a blank row after the last cell is the sheet's
 * declared rectangle being larger than its contents, which is routine
 * (`efektif_kur` declares 3 columns for 2 columns of data; `chain_gdp` declares
 * 12 for 10). Keeping those would report a 200-row sheet as 16,809 rows.
 */
export function trimTrailingBlanks(rows: readonly Cell[][]): { rows: number; cols: number; firstRow: number; firstCol: number } {
  let lastRow = -1;
  let lastCol = -1;
  // The first used cell too, which the same pass gets for free: together they
  // are the sheet's used range, outlined when the raw worksheet is selected.
  let firstRow = -1;
  let firstCol = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      if (isBlank(row[c])) continue;
      if (firstRow < 0) firstRow = r;
      if (c < firstCol) firstCol = c;
      if (r > lastRow) lastRow = r;
      if (c > lastCol) lastCol = c;
    }
  }
  return { rows: lastRow + 1, cols: lastCol + 1, firstRow, firstCol: firstRow < 0 ? -1 : firstCol };
}

/**
 * Above this many declared cells, table discovery is not attempted (SAFE-X1
 * `bounded`, PERF-X1): reading the whole grid into JS for the detector would
 * cost several bytes per cell on top of the sheet itself. The raw sheet stays
 * readable through SQL; the status says detection was limited instead of
 * pretending the sheet has no tables. Equal to MAX_CACHED_CELLS, so every sheet
 * that is materialised is also looked at.
 */
export const DETECTION_MAX_CELLS = MAX_CACHED_CELLS;

/** DuckDB reports an interrupted statement with this wording (see queryDiagnostics). */
export function isInterruption(error: unknown): boolean {
  return /interrupt/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * PERF-X1: the most workbook cells one document keeps materialised at once
 * (about 240 MB at the 8-byte-per-cell floor). Beyond it, the least recently
 * used sheets and tables NOT read by the current statement become views again
 * and are re-materialised on their next use. One sheet larger than this is
 * still cached while it is the one in use.
 */
export const CACHE_MAX_CELLS = 30_000_000;
