import { isBlank, type Cell, type SheetTable } from '../../sheetTables';
import type { RowSpan } from '../../sheetRowMap';
import { classifyTextColumn, isExcelError } from '../../textColumns';
import type { SheetDimension } from '../../xlsxSheets';
import type { StatsKind } from '../types';
import { quoteIdent } from '../sql';

/**
 * The source map between a worksheet grid and the SQL objects read from it:
 * the verbatim sheet read, the ranged read for one detected table, and the
 * per-column facts the grid already proves. Host-free (MOD-02).
 */

/**
 * One detected table, as the Excel addresses `read_xlsx`'s `range` speaks.
 *
 * `sheetTables.detectTables` works in 0-based indices into the grid it was
 * given; because that grid is always read from `A1`, an index i is Excel row
 * i+1 and column index j is column letter j. This is the same thing in the only
 * form DuckDB accepts.
 */
export interface SheetTableInfo {
  /** 1-based Excel rows, inclusive at both ends. */
  startRow: number;
  endRow: number;
  firstCol: string;
  lastCol: string;
  /** `header = true` when the table's first row names its columns. */
  hasHeader: boolean;
  /** What this object is called after the sheet's name: `· Table 2`. */
  suffix: string;
  /**
   * 0-based grid row of the first row the ranged read returns (the row after
   * the header, or the table's top), and the data rows to keep of them.
   */
  bodyTop: number;
  dataRows: RowSpan[];
  /** Name of the internal row-number column; never one of the table's own names. */
  rowColumn: string;
  /**
   * Columns whose typed reading lost a value (a non-blank cell read back as
   * NULL), read instead from an all-text read of the same range, so the cell's
   * exact text survives. Set by ensureDerivedPrepared; with `columnNames`, the
   * typed read's column order.
   */
  textColumns?: ReadonlySet<string>;
  columnNames?: readonly string[];
}

/**
 * The sheet, verbatim: every declared row and column, as text, columns named
 * after their Excel letters.
 *
 * This is what the sheet's own object shows, and it is the whole point of the
 * design. A viewer is asked "what is in this file"; anything it hides, moves or
 * retypes is an answer to a different question. So:
 *
 *   - **Anchored at A1**, not at the dimension's first cell. Grid row N is then
 *     Excel row N and grid column J is Excel column J, exactly, which is what
 *     makes "the footnote is where it was" true rather than approximately true
 *     -- and what lets a cell edit address the right cell by arithmetic instead
 *     of by matching header text down the sheet.
 *   - **`header = false`**, so nothing on the sheet is promoted out of the data
 *     into a name. `read_xlsx` gives the columns their Excel letters for free.
 *   - **`all_varchar`**, so a footnote under a numeric column cannot retype the
 *     column, and nothing has to be excluded to protect a type.
 *
 * The dimension routinely OVER-declares (see the project's xlsx geometry
 * notes), which would otherwise pad the sheet with phantom trailing rows. The
 * caller trims trailing blank rows and columns after the read; interior blanks
 * are kept, because those are structure -- they are what separates one table
 * from the next.
 */
export function xlsxVerbatimExpr(
  filePathLiteral: string,
  sheetLiteral: string,
  dim: SheetDimension | undefined
): string {
  const range = dim ? `, range = 'A1:${dim.lastCol}${dim.lastRow}'` : '';
  return (
    `read_xlsx('${filePathLiteral}', sheet = '${sheetLiteral}'${range}, ` +
    `header = false, all_varchar = true, ignore_errors = true)`
  );
}

/**
 * The read for one detected table.
 *
 * Typed, unlike the verbatim sheet: this is the object the grid sorts, the
 * stats panel summarises and the chart plots, so its columns need to be numbers
 * where the file holds numbers.
 *
 * `ignore_errors`: a ranged read types each column from the range, and one
 * uncomputable cell in a 16,000-row sheet would otherwise refuse the lot.
 */
export function xlsxTableExpr(
  filePathLiteral: string,
  sheetLiteral: string,
  table: SheetTableInfo
): string {
  const range = `${table.firstCol}${table.startRow}:${table.lastCol}${table.endRow}`;
  const shape = table.hasHeader ? 'header = true' : 'header = false, all_varchar = true';
  const typed =
    `read_xlsx('${filePathLiteral}', sheet = '${sheetLiteral}', ` +
    `range = '${range}', ${shape}, ignore_errors = true)`;
  const bodyRows = table.endRow - (table.bodyTop + 1) + 1;
  const whole =
    table.dataRows.length === 1 &&
    table.dataRows[0].start === table.bodyTop &&
    table.dataRows[0].end - table.dataRows[0].start === bodyRows;
  const text = table.textColumns && table.textColumns.size > 0 && table.columnNames ? table.textColumns : undefined;
  // The plain ranged read, exactly as before, when every row it returns is data
  // and no column needs its text kept.
  if (whole && !text) return typed;

  // Otherwise: number the read's rows by their grid row, keep exactly the
  // source-row map's rows, and take any lossy column from a text read of the
  // same range (POSITIONAL JOIN: both reads return the same rows in order).
  const row = quoteIdent(table.rowColumn);
  const keep =
    table.dataRows.length === 0
      ? 'false'
      : table.dataRows.map((s) => `${row} between ${s.start} and ${s.end - 1}`).join(' or ');
  const numbered = `(select ${table.bodyTop - 1} + row_number() over () as ${row}, * from ${typed}) as t`;
  if (!text) return `(select t.* exclude (${row}) from ${numbered} where ${keep})`;
  const asText =
    `read_xlsx('${filePathLiteral}', sheet = '${sheetLiteral}', ` +
    `range = '${range}', header = ${table.hasHeader ? 'true' : 'false'}, all_varchar = true, ignore_errors = true) as v`;
  const projection = table.columnNames!
    .map((c) => `${text.has(c) ? 'v' : 't'}.${quoteIdent(c)} as ${quoteIdent(c)}`)
    .join(', ');
  return `(select ${projection} from ${numbered} positional join ${asText} where ${keep})`;
}

/**
 * Infer enough type information to hide impossible inline plot buttons without
 * loading a detected table. The worksheet grid has already been read for
 * detection, so this is CPU-only and keeps detected tables lazy.
 */
export function inferDetectedTableKinds(
  grid: readonly Cell[][],
  table: SheetTable,
  nullText: readonly string[]
): StatsKind[] {
  return table.columns.map((_, offset) => {
    const values: (string | null)[] = [];
    const column = table.region.left + offset;
    // The source-row map's rows only: a repeated header is not a value.
    for (const span of table.dataRows) {
      for (let row = span.start; row < span.end; row++) {
        const value = grid[row]?.[column];
        values.push(isBlank(value) ? null : String(value));
      }
    }
    return classifyTextColumn(values, nullText).kind === 'numeric' ? 'numeric' : 'other';
  });
}

/**
 * Per column, how many data cells hold a value a typed read must keep: not
 * blank, and not an Excel error marker (those are read as empty and disclosed
 * separately). A typed column with fewer non-NULL values than this lost one.
 */
export function expectedValueCounts(grid: readonly Cell[][], table: SheetTable, nullText: readonly string[]): number[] {
  return table.columns.map((_, offset) => {
    const column = table.region.left + offset;
    let n = 0;
    for (const span of table.dataRows) {
      for (let row = span.start; row < span.end; row++) {
        const value = grid[row]?.[column];
        if (isBlank(value)) continue;
        if (typeof value === 'string' && isExcelError(value, nullText)) continue;
        n++;
      }
    }
    return n;
  });
}
