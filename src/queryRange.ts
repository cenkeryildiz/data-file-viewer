import type { QueryResult } from './backend/types';
import { quoteIdent } from './backend/sql';
import { QueryPolicyError } from './queryPolicy';
import { hasMultipleStatements, stripCommentsAndLiterals } from './sqlSafety';

export interface ResultRangeContext { token: number; label: string; rows: number; columns: number }
export interface RangeSnapshot {
  context: ResultRangeContext;
  sql: string;
  result: QueryResult;
  worksheet?: string;
}

function refuse(message: string): never { throw new QueryPolicyError(message); }
export const RANGE_PAGE_ROWS = 100;
export const RANGE_PAGE_CELLS = 16384;
/** Most cells one raw-worksheet range read may load; independent of maxResultRows (0 = uncapped rows). */
export const RANGE_READ_CELLS = 2_000_000;

/** Refuse, never truncate: the read loads rows 1..lastRow across every column of the worksheet. */
export function assertRangeReadWithinCells(lastRow: number, columns: number): void {
  const cells = lastRow * columns;
  if (cells > RANGE_READ_CELLS) refuse(`Reading rows 1-${lastRow} of this ${columns}-column worksheet would load ${cells} cells; the cell limit is ${RANGE_READ_CELLS}. Choose a range that ends at row ${Math.floor(RANGE_READ_CELLS / columns)} or earlier.`);
}

/** Only an outer ORDER BY attests the result order; window/CTE sorts do not. */
export function hasResultOrder(sql: string): boolean {
  const tokens = stripCommentsAndLiterals(sql).match(/[A-Za-z_][A-Za-z_0-9]*|[()]/g) ?? [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '(') depth++;
    else if (tokens[i] === ')') depth--;
    else if (depth === 0 && tokens[i].toUpperCase() === 'ORDER' && tokens[i + 1]?.toUpperCase() === 'BY') return true;
  }
  return false;
}

export function parseCellRange(text: string): { firstColumn: number; lastColumn: number; firstRow: number; lastRow: number; range: string } {
  const match = /^([a-z]{1,3})([1-9][0-9]{0,6}):([a-z]{1,3})([1-9][0-9]{0,6})$/i.exec(text.trim());
  if (!match) refuse('Enter a rectangle such as A1:D929, using one-based rows and column letters.');
  const column = (s: string) => [...s.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const [firstColumn, lastColumn] = [column(match[1]), column(match[3])];
  const [firstRow, lastRow] = [Number(match[2]), Number(match[4])];
  if (firstColumn > lastColumn || firstRow > lastRow || lastColumn > 16384 || lastRow > 1048576) refuse('The range is reversed or exceeds worksheet coordinate limits.');
  return { firstColumn, lastColumn, firstRow, lastRow, range: text.trim().toUpperCase() };
}

/** Only captured raw worksheet coordinates can correct table discovery. */
export function tableFromRange(snapshot: RangeSnapshot, token: number, text: string, headerRow: number | null) {
  if (!snapshot.worksheet) refuse('Open a raw worksheet before defining a table.');
  selectResultRange(snapshot, token, text);
  const range = parseCellRange(text);
  if (headerRow !== null && (!Number.isSafeInteger(headerRow) || headerRow < range.firstRow || headerRow > range.lastRow)) {
    refuse('The header row must be inside the selected range, or blank for no header.');
  }
  return { top: range.firstRow - 1, bottom: range.lastRow, left: range.firstColumn - 1, right: range.lastColumn,
    headerRow: headerRow === null ? null : headerRow - 1 };
}

/** Slice the captured order, never re-execute a query whose ties might move between pages. */
export function selectResultRange(snapshot: RangeSnapshot, token: number, text: string, offset = 0) {
  if (token !== snapshot.context.token) refuse('This result has changed. Run the query and select the range again.');
  if (!snapshot.worksheet && !hasResultOrder(snapshot.sql)) refuse('Add an explicit outer ORDER BY, run the query, then select a range. Row 1 is the first data row.');
  const range = parseCellRange(text);
  const { firstColumn, lastColumn, firstRow, lastRow } = range;
  if (lastColumn > snapshot.result.columns.length || lastRow > snapshot.result.rows.length) refuse('The range exceeds this captured result. Run a query that includes all requested rows and columns first.');
  const totalRows = lastRow - firstRow + 1;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= totalRows) refuse('This range page is out of bounds.');
  const pageSize = Math.max(1, Math.min(RANGE_PAGE_ROWS, Math.floor(RANGE_PAGE_CELLS / (lastColumn - firstColumn + 1))));
  const take = Math.min(pageSize, totalRows - offset);
  const columns = snapshot.result.columns.slice(firstColumn - 1, lastColumn);
  const rows = snapshot.result.rows.slice(firstRow - 1 + offset, firstRow - 1 + offset + take).map(row => row.slice(firstColumn - 1, lastColumn));
  const aliases = snapshot.result.columns.map((_, i) => quoteIdent(`__dfv_c${i + 1}`));
  // The preview is pinned to the captured order. This SQL describes the same rectangle on a new run.
  let sourceSql = snapshot.sql.trim();
  if (hasMultipleStatements(sourceSql)) refuse('A range requires a single result query.');
  if (sourceSql.endsWith(';')) sourceSql = sourceSql.slice(0, -1);
  else if (stripCommentsAndLiterals(sourceSql).includes(';')) refuse('Remove comments after the final semicolon before selecting a range.');
  const sql = `WITH "__dfv_source" (${aliases.join(', ')}) AS (\n${sourceSql}\n), "__dfv_rows" AS (\n  SELECT row_number() OVER () AS "__dfv_row", * FROM "__dfv_source"\n)\nSELECT ${columns.map((name, i) => `${aliases[firstColumn - 1 + i]} AS ${quoteIdent(name)}`).join(', ')}\nFROM "__dfv_rows"\nWHERE "__dfv_row" BETWEEN ${firstRow} AND ${lastRow}\nORDER BY "__dfv_row";`;
  return { range: range.range, target: snapshot.context.label, token, offset, pageSize, totalRows, capturedRows: snapshot.result.rows.length, ...(snapshot.worksheet ? { worksheet: snapshot.worksheet } : {}), nextOffset: offset + take < totalRows ? offset + take : undefined,
    firstRow: firstRow + offset, firstColumn, columns, rows, sql };
}
