import { columnLetters, detectTables, type Cell, type SheetTable, type TableCorrections } from '../../sheetTables';
import { spanRowCount, validSpans, type RowSpan } from '../../sheetRowMap';
import type { DetectedSheetTable, SheetTableMode } from '../types';
import { expectedValueCounts, inferDetectedTableKinds, type SheetTableInfo } from './sourceMap';

/*
 * Table discovery for one worksheet grid: run the detector and describe each
 * table it finds. Pure and host-free (MOD-02); binding views stays with the
 * connection that owns them.
 */

/**
 * `name`, or the first suffixed variant of it nothing else has claimed.
 *
 * A workbook may hold a sheet literally called `Data (rows 4-9)` beside a sheet
 * called `Data`, and two objects cannot share a name. The sheet keeps the name
 * it has in Excel; the derived block is the one that moves -- which is why
 * `isTaken` has to know every sheet name in the workbook up front, not just the
 * ones opened so far. Without that, a block of the FIRST sheet claimed the
 * name, `create view` for the real sheet failed, and the sheet was reported
 * unreadable: a whole sheet lost to a naming collision.
 */
export function uniqueName(name: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}_${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** Find the tables in a sheet's used grid, with the viewer's detection mode and saved corrections. */
export function detectSheetGrid(
  grid: readonly Cell[][],
  usedRows: number,
  mode: Exclude<SheetTableMode, 'off'>,
  corrections: TableCorrections | undefined
): SheetTable[] {
  return detectTables(grid.slice(0, usedRows), { splitColumns: mode === 'grid', corrections });
}

/** One detected table, ready to bind: everything except its unique SQL name. */
export interface DetectedTablePlan {
  /** What this object is called after the sheet's name: `· Table 2`. */
  suffix: string;
  info: SheetTableInfo;
  /** Cells inside the table's rectangle; the materialisation budget reads it. */
  cellCount: number;
  origin: {
    sheet: string;
    startRow: number;
    firstCol: number;
    hasHeader: boolean;
    dataRows: RowSpan[];
    width: number;
    expectedValues: number[];
    info: SheetTableInfo;
  };
  /** The public description; `name` is filled in once the name is reserved. */
  describe(name: string): DetectedSheetTable;
}

/**
 * Turn the detector's `index`-th (1-based) table into the description its view
 * is built from, or `undefined` when the table's source-row map does not add up.
 *
 * Grid row i is Excel row i+1, and grid column j is column letter j, because the
 * verbatim read is anchored at A1. That is the whole reason it is anchored there.
 * The map must describe rows inside the rectangle and agree with the count; a
 * table whose description does not add up is not offered.
 */
export function planDetectedTable(
  sheet: string,
  table: SheetTable,
  index: number,
  grid: readonly Cell[][],
  nullText: readonly string[]
): DetectedTablePlan | undefined {
  if (
    !validSpans(table.dataRows) ||
    spanRowCount(table.dataRows) !== table.rowCount ||
    table.dataRows.some((s) => s.start <= (table.headerRow ?? table.region.top - 1) || s.end > table.region.bottom)
  ) return undefined;
  let rowColumn = '__dfv_source_row';
  while (table.columns.some((column) => column.toLowerCase() === rowColumn.toLowerCase())) rowColumn += '_';
  const info: SheetTableInfo = {
    startRow: table.region.top + 1,
    endRow: table.region.bottom,
    firstCol: columnLetters(table.region.left),
    lastCol: columnLetters(table.region.right - 1),
    hasHeader: table.headerRow !== null,
    suffix: `· Table ${index}`,
    bodyTop: table.headerRow === null ? table.region.top : table.headerRow + 1,
    dataRows: table.dataRows.map((s) => ({ ...s })),
    rowColumn,
  };
  return {
    suffix: info.suffix,
    info,
    cellCount: (table.region.bottom - table.region.top) * (table.region.right - table.region.left),
    origin: {
      sheet,
      startRow: info.startRow,
      firstCol: table.region.left,
      hasHeader: info.hasHeader,
      dataRows: info.dataRows,
      width: table.region.right - table.region.left,
      expectedValues: expectedValueCounts(grid, table, nullText),
      info,
    },
    describe: (name) => ({
      name,
      sheet,
      top: table.region.top,
      bottom: table.region.bottom,
      left: table.region.left,
      right: table.region.right,
      headerRow: table.headerRow,
      columns: [...table.columns],
      columnStatsKind: inferDetectedTableKinds(grid, table, nullText),
      dataRows: table.dataRows.map((s) => ({ ...s })),
      excludedRows: table.excludedRows.map((r) => ({ ...r })),
      rowCount: table.rowCount,
    }),
  };
}
