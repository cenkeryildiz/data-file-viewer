/**
 * Writing one cell back into an .xlsx workbook, without disturbing anything else.
 *
 * The naive save -- regenerate the sheet from the table DuckDB holds -- is what
 * kept .xlsx view-only, and rightly: it replaces formulas with whatever they
 * last evaluated to, drops number formats and styling, and (Excel having no
 * integer type) turns every `1` in the sheet into `1.0`. Editing one cell would
 * quietly rewrite ten thousand you did not touch.
 *
 * So nothing is regenerated. The workbook is unzipped, the ONE `<c>` element
 * the edit targets is rewritten inside the worksheet XML, and the package is
 * zipped back up. Every other cell keeps its bytes: formulas, styles, merged
 * ranges, charts, pivot caches, the other sheets, the parts nobody has heard of.
 *
 * Finding the cell
 * ----------------
 * The hard half, because an edit identifies its row by the row's VALUES (see
 * updateCell -- DuckDB has no stable rowid across the shapes this viewer
 * opens), and this file needs a spreadsheet row NUMBER.
 *
 * Matching values here would mean re-implementing DuckDB's own comparison in
 * JS against raw XML -- dates stored as serial numbers, floats stored at
 * whatever precision Excel wrote, integers indistinguishable from floats. Get
 * it subtly wrong and the result is not an error, it is an edit to the wrong
 * cell of somebody's workbook.
 *
 * Instead DuckDB does the matching, in its own types, and reports the row's
 * ORDINAL (see updateXlsxCell in duckdbConnection.ts). read_xlsx returns rows
 * in sheet order, so the Nth row it returned is the Nth data row of the XML.
 * What remains is finding where the data starts, and that is done by FINDING
 * the header row -- the first row carrying every one of the view's column
 * names -- rather than by arithmetic on row counts. The arithmetic version
 * (rows in the file minus rows in the table) is wrong on any sheet with
 * trailing content, and real workbooks are full of it: the sheet this was
 * first run against holds 136 rows for 121 rows of data, the surplus being
 * notes below the table, which put the "header" fourteen rows into the data.
 *
 * Two independent readings then have to agree before a byte is written: the
 * ordinal DuckDB reported, and the cell's own current contents, which must be
 * what the grid was showing. When they disagree the edit is refused.
 *
 * The cell grammar below follows ETL's reader (ETL/etl_parts/etl_xlsx.py,
 * _parse_batch), including its one non-obvious rule: `t="..."` must be matched
 * anchored INSIDE the `<c ...>` tag. A cell holding a shared formula contains
 * `<f t="shared" si="0"/>`, and an unanchored match takes the formula's type
 * for the cell's -- which in that codebase nulled 182,000 cells in one sheet.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { crc32, indexZip, readMember, rewriteZip, type ZipIndex } from './zipPatch';

const execFileAsync = promisify(execFile);

/** A1 column letters -> 0-based index. "A" -> 0, "Z" -> 25, "AA" -> 26. */
export function columnIndexOf(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0-based index -> A1 column letters. The inverse of columnIndexOf. */
export function columnLettersOf(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" does not become "<"
}

/** One `<row ...>…</row>` block, with where it sits in the sheet XML. */
interface RowBlock {
  /** The row's own `r=` number, 1-based, as Excel counts rows. */
  number: number;
  /** Offsets of the whole block in the XML string. */
  start: number;
  end: number;
  xml: string;
}

const ROW_RE = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;

function readRows(sheetXml: string): RowBlock[] {
  const rows: RowBlock[] = [];
  ROW_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROW_RE.exec(sheetXml)) !== null) {
    const xml = match[0];
    const r = /<row\b[^>]*?\br="(\d+)"/.exec(xml);
    rows.push({
      number: r ? Number(r[1]) : rows.length + 1,
      start: match.index,
      end: match.index + xml.length,
      xml,
    });
  }
  return rows;
}

/** Rows carrying at least one cell. read_xlsx does not return a row of nothing. */
function isNonEmpty(row: RowBlock): boolean {
  return /<c\b/.test(row.xml);
}

/** One cell as the file stores it: what it says, what type and style it declares, any formula. */
interface StoredCell {
  text: string;
  /** The `t=` attribute; absent means a number. */
  type: string | undefined;
  style: number | undefined;
  /** The formula's text when the cell holds one ('' for a shared-formula child). */
  formula: string | undefined;
}

function storedCellOf(rowXml: string, letters: string, sharedStrings: string[]): StoredCell {
  const cellRe = new RegExp(`<c\\b([^>]*?\\br="${letters}\\d+"[^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const match = cellRe.exec(rowXml);
  if (!match) return { text: '', type: undefined, style: undefined, formula: undefined };
  const attrs = match[1];
  const body = match[2] ?? '';
  const style = /\bs="(\d+)"/.exec(attrs)?.[1];
  const formula = /<f\b[^>]*?(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
  return {
    text: cellTextsOf(match[0], sharedStrings).get(letters) ?? '',
    type: /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1],
    style: style === undefined ? undefined : Number(style),
    formula: formula ? unescapeXmlText(formula[1] ?? '') : undefined,
  };
}

/** Built-in number formats that display a date or a time (ECMA-376 18.8.30, plus the East Asian date ids). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

/** Whether a custom format code shows a date or time: a d/m/y/h/s token outside quotes, escapes and [colour] blocks. */
function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '');
  return /[dmyhs]/i.test(bare);
}

/** Style indices (positions in cellXfs) whose number format is a date or time. */
function readDateStyles(files: Record<string, Uint8Array>): Set<number> {
  const part = files['xl/styles.xml'];
  const out = new Set<number>();
  if (!part) return out;
  const xml = strFromU8(part);
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*?\bnumFmtId="(\d+)"[^>]*?\bformatCode="([^"]*)"/g)) {
    custom.set(Number(m[1]), unescapeXmlText(m[2]));
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  let index = 0;
  for (const xf of xfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(xf[0])?.[1] ?? '0');
    const code = custom.get(id);
    if (code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id)) out.add(index);
    index++;
  }
  return out;
}

function usesDate1904(files: Record<string, Uint8Array>): boolean {
  const part = files['xl/workbook.xml'];
  return part ? /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(strFromU8(part)) : false;
}

const DAY_MS = 86_400_000;

/**
 * An ISO date, date-time or time of day as an Excel serial, or undefined when
 * the text is not one. What the grid shows for DATE, TIMESTAMP and TIME columns.
 */
function isoToSerial(text: string, date1904: boolean): number | undefined {
  const time = /^(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(text);
  if (time) {
    const [h, m, s] = [Number(time[1]), Number(time[2]), Number(time[3] ?? 0)];
    return h < 24 && m < 60 && s < 60 ? (h * 3600 + m * 60 + s) / 86_400 : undefined;
  }
  const d = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/.exec(text);
  if (!d) return undefined;
  const [y, mo, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [h, mi, s] = [Number(d[4] ?? 0), Number(d[5] ?? 0), Number(d[6] ?? 0)];
  const ms = Date.UTC(y, mo - 1, day);
  const check = new Date(ms);
  // Date.UTC rolls 2026-02-30 over into March; a date that does not exist is not one.
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day || h >= 24 || mi >= 60 || s >= 60) {
    return undefined;
  }
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  let serial = (ms - epoch) / DAY_MS + (h * 3600 + mi * 60 + s) / 86_400;
  // The 1900 system counts a 29 February 1900 that never happened, so serials
  // before 1 March 1900 are one lower than the arithmetic gives.
  if (!date1904 && serial < 61) serial -= 1;
  return serial >= 0 ? serial : undefined;
}

/** The display text of every cell in a row, keyed by column letters. */
function cellTextsOf(rowXml: string, sharedStrings: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellRe.exec(rowXml)) !== null) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
    if (!ref) continue;
    // Anchored in the attribute list, never in the body: see the module note.
    const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1];
    let text = '';
    if (type === 's') {
      const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1');
      text = sharedStrings[index] ?? '';
    } else if (type === 'inlineStr') {
      text = unescapeXmlText(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? '');
    } else {
      text = unescapeXmlText(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
    }
    out.set(ref[1], text);
  }
  return out;
}

function readSharedStrings(files: Record<string, Uint8Array>): string[] {
  const part = files['xl/sharedStrings.xml'];
  if (!part) return [];
  const xml = strFromU8(part);
  const out: string[] = [];
  // An <si> may hold one <t>, or several inside <r> runs that concatenate.
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = siRe.exec(xml)) !== null) {
    const pieces = match[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    out.push(
      pieces.map((p) => unescapeXmlText(p.replace(/<t\b[^>]*>|<\/t>/g, ''))).join('')
    );
  }
  return out;
}

/**
 * The `<c>` element for a new value, keeping the old cell's style.
 *
 * Strings go in as `inlineStr` rather than as an index into sharedStrings.
 * Appending to the shared table would mean renumbering nothing (indices are
 * append-only, so that part is safe) but also rewriting a part every other
 * sheet in the book points into -- a much wider blast radius than the one cell
 * being edited, for no gain. `inlineStr` is in the spec, Excel reads it, and
 * ETL's own reader handles it (etl_xlsx.py routes t="inlineStr" explicitly).
 *
 * Any `<f>` the cell held is NOT carried over. The cell now holds a literal
 * somebody typed, and keeping the formula beside it would mean Excel
 * recomputing the edit away on the next open.
 */
function buildCell(ref: string, styleAttr: string, value: unknown, keepText = false): string {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}"${styleAttr}/>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${styleAttr} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  }
  if (typeof value === 'bigint') {
    return `<c r="${ref}"${styleAttr}><v>${value.toString()}</v></c>`;
  }
  const text = String(value);
  // A number typed into a numeric column arrives as text from the webview.
  // Written as a number so the column stays numeric and the cell's own format
  // still applies -- writing "12.5" as text into a formatted column is how an
  // edited cell ends up left-aligned and excluded from every SUM around it.
  //
  // Not when the cell was stored as text (`keepText`). An identifier column
  // holds "0007" as text on purpose, and rewriting "0009" as <v>0009</v> made
  // it the number 9 in Excel, openpyxl and ETL alike, while this viewer read
  // the raw "0009" back and showed the edit as correct (phase 8, INT-01).
  if (!keepText && /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text.trim())) {
    return `<c r="${ref}"${styleAttr}><v>${text.trim()}</v></c>`;
  }
  return (
    `<c r="${ref}"${styleAttr} t="inlineStr">` +
    `<is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`
  );
}

/**
 * Put `cellXml` into `rowXml` at `ref`, replacing or inserting in column order.
 * `keepText`: the cell being replaced was stored as text, so text stays text.
 */
function spliceCell(rowXml: string, ref: string, letters: string, value: unknown, keepText = false): string {
  const cellRe = new RegExp(`<c\\b[^>]*?\\br="${letters}\\d+"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  const existing = cellRe.exec(rowXml);
  if (existing) {
    // The style index is the cell's link to its number format, alignment,
    // font and borders. Dropping it is how an edited date cell comes back as
    // 45678 and an edited currency cell loses its symbol.
    const style = /\bs="(\d+)"/.exec(existing[0]);
    return rowXml.replace(cellRe, buildCell(ref, style ? ` s="${style[1]}"` : '', value, keepText));
  }

  // The cell is absent -- an empty cell Excel never wrote out. Cells must sit
  // in ascending column order inside a <row>, so insert before the first cell
  // that comes after it rather than appending.
  const target = columnIndexOf(letters);
  const cellRe2 = /<c\b[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellRe2.exec(rowXml)) !== null) {
    if (columnIndexOf(match[1]) > target) {
      const at = match.index;
      return rowXml.slice(0, at) + buildCell(ref, '', value) + rowXml.slice(at);
    }
  }
  // Past every cell in the row, or the row is self-closing (<row r="7"/>).
  if (/<row\b[^>]*\/>/.test(rowXml)) {
    return rowXml.replace(/\/>$/, `>${buildCell(ref, '', value)}</row>`);
  }
  return rowXml.replace(/<\/row>\s*$/, `${buildCell(ref, '', value)}</row>`);
}

export interface PatchCellRequest {
  /** The .xlsx on disk. */
  filePath: string;
  /** Worksheet part inside the package, from listSheets(). */
  sheetPath: string;
  /** Column header text, as the grid shows it. */
  columnName: string;
  /** Every column the sheet's view exposes, in order, for finding the header row. */
  columnNames: readonly string[];
  /**
   * Which row.
   *
   * With `verbatim`, this is the WORKSHEET row number -- row 7 is Excel's row 7.
   * Without it, the 1-based position among the data rows read_xlsx returned,
   * counted from below the header.
   */
  rowOrdinal: number;
  /**
   * The coordinates are the worksheet's own: `rowOrdinal` is an Excel row
   * number and `columnName` is an Excel column letter.
   *
   * Turns the write from a search into arithmetic -- see patchCell.
   */
  verbatim?: boolean;
  /**
   * SHA-256 of the bytes the row was located in (ViewerFile's read worker).
   * When given, the file read here must still hash to it, or nothing is
   * written: the located row is then known to be a row of these bytes.
   */
  expectedSha256?: string;
  /** What the grid showed in this cell. The write is refused if the file disagrees. */
  expectedCurrent: unknown;
  newValue: unknown;
}

const INTEGER_TEXT = /^-?\d+$/;
const NUMBER_TEXT = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * Whether the cell holds the value the grid was showing, judged by what the
 * cell declares itself to be.
 *
 * Loose about FORM, exact about VALUE. Excel stores 12.50 as "12.5" and a date
 * as its serial number, so a character comparison would refuse legitimate
 * edits. But nothing here guesses (E16): this used to accept any number within
 * one part in a billion -- a whole unit at 10^9 -- and any pair where only one
 * side was numeric, which let a stale grid overwrite exactly the cells the
 * check exists to protect.
 *
 *   - a text cell matches only its own text;
 *   - a number matches exactly: integers as integers of any width, anything
 *     else as the same double, which is what DuckDB read the cell as and what
 *     the grid's JSON carries back unchanged;
 *   - a date-formatted number also matches the ISO date, date-time or time the
 *     grid shows for it.
 */
function holdsExpectedValue(
  cell: StoredCell,
  expected: unknown,
  dateStyled: boolean,
  date1904: boolean
): boolean {
  if (cell.type !== undefined && cell.type !== 'n' && cell.type !== 'b') {
    return expected !== null && expected !== undefined
      ? cell.text === String(expected)
      : cell.text === '';
  }
  const stored = cell.text.trim();
  if (expected === null || expected === undefined) return stored === '';
  const wanted = String(expected).trim();
  if (stored === wanted) return true;

  if (cell.type === 'b') return (stored === '1' ? 'true' : 'false') === wanted.toLowerCase();
  if (cell.type !== undefined && cell.type !== 'n') return false;
  if (!NUMBER_TEXT.test(stored)) return false;

  if (NUMBER_TEXT.test(wanted)) {
    if (INTEGER_TEXT.test(stored) && INTEGER_TEXT.test(wanted)) return BigInt(stored) === BigInt(wanted);
    return Number(stored) === Number(wanted);
  }
  if (!dateStyled) return false;
  const serial = isoToSerial(wanted, date1904);
  if (serial === undefined) return false;
  const value = Number(stored);
  // A date-only value is the day the cell falls on, whatever time it carries;
  // a date-time or time is compared to the millisecond.
  if (/^\d{4}-\d{2}-\d{2}$/.test(wanted)) return Math.floor(value) === serial;
  return Math.abs(value - serial) * DAY_MS < 1;
}

/** The edit worked out in memory: the candidate package and what it must contain. */
interface PatchPlan {
  bytes: Buffer;
  sheetPath: string;
  /** The worksheet XML before and after the edit. */
  sheetXml: string;
  intendedSheet: Uint8Array;
  target: RowBlock;
  ref: string;
  letters: string;
  sharedStrings: string[];
  /** What the edited cell must read back as, and the style it must keep. */
  expectedText: string;
  expectedStyle: number | undefined;
  /** The source's central directory, when it was patched through zipPatch. */
  sourceIndex?: ZipIndex;
  /** Otherwise every source member, inflated. */
  sourceFiles?: Record<string, Uint8Array>;
}

/** The text a cell built by buildCell(value, keepText) reads back as. */
function storedTextOf(value: unknown, keepText: boolean): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  const text = String(value);
  return !keepText && NUMBER_TEXT.test(text.trim()) ? text.trim() : text;
}

/**
 * Work out the edit against `original`. Throws rather than guessing when the
 * sheet's shape does not support the mapping -- a refused edit is
 * recoverable, a misplaced one is not.
 */
function planPatch(original: Buffer, request: PatchCellRequest): PatchPlan {
  const { sheetPath, columnName, columnNames, rowOrdinal, expectedCurrent, newValue } = request;

  // Only the parts this function reads are inflated when the archive is in
  // zipPatch's scope; otherwise every member, as before.
  const index = indexZip(original);
  const files: Record<string, Uint8Array> = index
    ? Object.fromEntries(
        [sheetPath, 'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/workbook.xml'].flatMap((name) => {
          const member = readMember(index, name);
          return member ? [[name, member] as const] : [];
        })
      )
    : unzipSync(new Uint8Array(original));
  const part = files[sheetPath];
  if (!part) throw new Error(`The workbook has no worksheet part at ${sheetPath}.`);

  const sheetXml = strFromU8(part);
  const rows = readRows(sheetXml).filter(isNonEmpty);

  const sharedStrings = readSharedStrings(files);

  // The header row is FOUND, not counted to.
  //
  // The obvious derivation -- rows in the file minus rows in the table -- is
  // wrong on any sheet with trailing content, and real workbooks have plenty:
  // the sheet this was first run against holds 136 rows for 121 rows of data,
  // the surplus being notes below the table. That arithmetic put the "header"
  // fourteen rows into the data.
  //
  // So the header is the first row that actually carries the column names,
  // which is also a check: a row that matches every one of them is the header
  // in a way no count can be wrong about. Data rows are the rows after it, in
  // order -- read_xlsx returns them in sheet order, so its Nth row is the Nth
  // row here. Trailing junk sits past the end and is never indexed into,
  // because the ordinal always counts from the top.
  let letters: string;
  let target: RowBlock;

  if (request.verbatim) {
    // The sheet is read verbatim, anchored at A1 with no header promoted, so
    // the grid's coordinates ARE the worksheet's: grid row N is Excel row N and
    // a column called "B" is column B. Nothing has to be found, and the class
    // of bug the search below exists to avoid cannot arise -- there is no
    // header to locate wrongly and no count to be off by.
    //
    // This is the payoff of showing the sheet as it is. The old view promoted a
    // header and dropped everything above it, so the writer had to reconstruct
    // where the data started by searching the XML for the column names.
    if (!/^[A-Z]+$/.test(columnName)) {
      throw new Error(`"${columnName}" is not a column of the sheet. The cell was not changed.`);
    }
    letters = columnName;
    const found = rows.find((r) => r.number === rowOrdinal);
    if (rowOrdinal < 1 || !found) {
      throw new Error(
        `Row ${rowOrdinal} holds nothing in this sheet, so there is no cell to change.`
      );
    }
    target = found;
  } else {
    const wanted = new Set(columnNames);
    let headerIndex = -1;
    let headerCells = new Map<string, string>();
    for (let i = 0; i < rows.length; i++) {
      const cells = cellTextsOf(rows[i].xml, sharedStrings);
      const texts = new Set(cells.values());
      if ([...wanted].every((name) => texts.has(name))) {
        headerIndex = i;
        headerCells = cells;
        break;
      }
    }
    if (headerIndex === -1) {
      throw new Error(
        'Could not find the header row in this sheet, so there is no way to tell ' +
          'which row and column the edit belongs to. The cell was not changed.'
      );
    }

    // Which COLUMN, by the header's own text rather than by counting: a sheet
    // whose first column is blank starts at B, and every positional guess is
    // then one column out.
    let byHeader: string | undefined;
    for (const [ref, text] of headerCells) {
      if (text === columnName) {
        byHeader = ref;
        break;
      }
    }
    if (!byHeader) {
      throw new Error(
        `Could not find a column headed "${columnName}" in the sheet, so the edit ` +
          `cannot be placed. The cell was not changed.`
      );
    }
    letters = byHeader;

    const targetIndex = headerIndex + rowOrdinal;
    if (rowOrdinal < 1 || targetIndex >= rows.length) {
      throw new Error(
        `Row ${rowOrdinal} is past the end of this sheet (${rows.length} row(s) below ` +
          `the header). The cell was not changed.`
      );
    }
    target = rows[targetIndex];
  }
  const ref = `${letters}${target.number}`;

  // The second reading. DuckDB said this is the row; the file has to agree that
  // this cell currently holds what the grid was showing, or the two disagree
  // about which row is which and nothing should be written.
  const cell = storedCellOf(target.xml, letters, sharedStrings);
  const current = cell.text;
  const dateStyled = cell.style !== undefined && readDateStyles(files).has(cell.style);
  const date1904 = usesDate1904(files);
  if (!holdsExpectedValue(cell, expectedCurrent, dateStyled, date1904)) {
    throw new Error(
      `Cell ${ref} holds ${current === '' ? '(empty)' : `"${current}"`}, but the grid was ` +
        `showing ${expectedCurrent === null || expectedCurrent === undefined
          ? '(empty)'
          : `"${String(expectedCurrent)}"`}. Refusing to overwrite a cell that is not the ` +
        `one you edited — reopen the file and try again. The workbook was not changed.`
    );
  }

  // Writing a value over a formula deletes the formula, and the grid shows only
  // its last result, so the edit would look like a correction to a number.
  if (cell.formula !== undefined) {
    throw new Error(
      `Cell ${ref} holds a formula${cell.formula ? ` (=${cell.formula})` : ''}, and editing it ` +
        `would replace the formula with a fixed value. The workbook was not changed.`
    );
  }

  // A date typed into a date-formatted cell is written as the serial number
  // Excel stores dates as. Written as the typed text it would keep the date
  // style and stop being a date: no longer sortable, no longer in any date sum.
  let value = newValue;
  if (dateStyled && typeof newValue === 'string' && newValue.trim() !== '') {
    const typed = newValue.trim();
    const serial = isoToSerial(typed, date1904);
    if (serial !== undefined) {
      value = serial;
    } else if (!NUMBER_TEXT.test(typed)) {
      throw new Error(
        `Cell ${ref} is formatted as a date, and "${typed}" is not one it can store. Type it as ` +
          `YYYY-MM-DD, YYYY-MM-DD HH:MM:SS or HH:MM:SS. The workbook was not changed.`
      );
    }
  }

  // A shared string, an inline string or a formula's text result: the cell
  // says it holds text, and an edit keeps that.
  const storedAsText = cell.type === 's' || cell.type === 'inlineStr' || cell.type === 'str';
  const patched = spliceCell(target.xml, ref, letters, value, storedAsText);

  const updatedSheet = sheetXml.slice(0, target.start) + patched + sheetXml.slice(target.end);
  const sourceFiles = index ? undefined : { ...files };
  const intendedSheet = strToU8(updatedSheet);
  files[sheetPath] = intendedSheet;

  // The central directory has to be rebuilt when any member's compressed size
  // changes. With zipPatch, only the edited sheet is re-encoded and every other
  // member's compressed bytes are copied through (21 MB workbook: 2.7 s -> see
  // docs/review-handoff.md). An archive outside zipPatch's scope (ZIP64,
  // encryption, other methods) keeps the old path, which inflates and
  // re-deflates every member; the member contents are identical either way.
  const bytes = index
    ? rewriteZip(index, new Map([[sheetPath, intendedSheet]]))
    : Buffer.from(zipSync(files));

  return {
    bytes,
    sheetPath,
    sheetXml,
    intendedSheet,
    target,
    ref,
    letters,
    sharedStrings,
    expectedText: storedTextOf(value, storedAsText),
    expectedStyle: cell.style,
    sourceIndex: index,
    sourceFiles,
  };
}

// ---------------------------------------------------------------------------
// Publication (SAFE-X2)
// ---------------------------------------------------------------------------
//
// The edit is written to an exclusively created sibling, flushed, read back
// from disk and checked on its own terms -- the intended cell, every other
// member unchanged -- and only then renamed over the workbook. Concurrent
// writers in other processes (two VS Code windows) coordinate through a lock
// file beside the workbook, held from the first read of the source through the
// rename, and the source's identity and bytes are checked once more right
// before the rename, which also catches programs that ignore the lock. The
// lock is created atomically and never rewritten; what is about to be
// published goes in a separate intent file. A lock is abandoned only when its
// process is certainly gone: dead, from an earlier boot, or its id now held by
// a process that started at another time.
//
// Every failure is reported with what it left on disk: `not-published` (the
// workbook is exactly as it was), or `unknown` (an error after the rename was
// attempted, and the workbook now matches neither side). An error after a
// rename that did land is reconciled by re-reading the workbook and returned
// as the save it was. Nothing is ever retried automatically.
//
// Limits, stated rather than implied: fsync is the platform's (macOS fsync
// does not force the drive cache; F_FULLFSYNC is not used), the directory is
// synced only where a directory can be opened for it (not on Windows), and a
// program that ignores the lock can still replace the workbook between the
// final check and the rename. Nothing here is a guarantee against power loss.

/** What a save did. Only ever returned for a workbook that now holds the edit. */
export interface PatchCellReceipt {
  outcome: 'published';
  /** The A1 reference of the edited cell. */
  cell: string;
  filePath: string;
  /** SHA-256 of the workbook the edit was made from. */
  sourceSha256: string;
  /** SHA-256 of the verified candidate that is now the workbook. */
  publishedSha256: string;
  /** True when the rename reported an error and publication was established by re-reading the workbook. */
  reconciled: boolean;
  /** Whether the directory entry was flushed after the rename. */
  directorySync: 'synced' | 'unsupported' | 'failed';
  /** Debris of earlier interrupted saves that was cleaned up first. */
  recovered: RecoveredSave[];
}

export interface RecoveredSave {
  kind: 'stage' | 'lock';
  name: string;
  /** For a lock: what became of the save it protected, judged from the workbook on disk now. */
  outcome?: 'published' | 'not-published' | 'unknown';
}

/**
 * A save that did not complete. `outcome` says what is on disk:
 * `not-published` -- the workbook was not changed; `unknown` -- the workbook
 * matches neither the original nor the edit and was left alone.
 */
export class XlsxPublishError extends Error {
  constructor(message: string, readonly outcome: 'not-published' | 'unknown', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'XlsxPublishError';
  }
}

const STAGE_MARK = '.dfv-tmp-';
const LOCK_SUFFIX = '.dfv-lock';
/** Beside the lock: only the holder of this may remove another save's abandoned lock. */
const TAKEOVER_SUFFIX = '.takeover';
/** Beside the lock: what the holder was about to publish, written right before the rename. */
const INTENT_MARK = '.intent-';
/** A lock's contents are written here first and then linked into place, so a lock is never seen half-written. */
const NEW_MARK = '.new-';
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;
/** A lock that cannot be read (written by something else, or damaged) is abandoned this long after it last changed. */
const UNREADABLE_LOCK_STALE_MS = 30_000;
/** Stages named by the earlier writer carry no host, so they are only removed once this old. */
const LEGACY_STAGE_STALE_MS = 60_000;
const MAX_RECOVERED_STAGES = 32;
/** Which computer a lock or stage belongs to; a process id means nothing on another one. */
const HOST_TAG = createHash('sha256').update(hostname()).digest('hex').slice(0, 8);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True unless the process is known to be gone. Unknown counts as alive: nothing is removed on a guess. */
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

// A process id alone does not identify a process: after a reboot, or once ids
// wrap, the id in an old lock can belong to anything (even this process), and
// the lock would then look live forever. So a lock also records which boot it
// was made in and its process's start, both read from the kernel and compared
// for exact equality (never as clock times, so a clock change cannot make a
// live lock look old). Where the platform offers neither, the mark is absent
// and only the process id is used, as before.

/** This boot's identity: macOS kern.bootsessionuuid, Linux boot_id. Undefined elsewhere. */
let bootIdentity: Promise<string | undefined> | undefined;
function currentBoot(): Promise<string | undefined> {
  bootIdentity ??= (async () => {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 2_000 });
        return stdout.trim() || undefined;
      }
      if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || undefined;
    } catch {
      // Unknown: the boot is simply not compared.
    }
    return undefined;
  })();
  return bootIdentity;
}

/**
 * The kernel's record of when `pid` started, as an opaque string compared only
 * for equality. `null`: no such process. `undefined`: cannot tell.
 */
async function processStart(pid: number): Promise<string | null | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // Field 22, starttime (clock ticks after boot); the name in field 2 may hold spaces.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || undefined;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      });
      return stdout.trim() || null;
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && process.platform === 'linux') return null;
    // ps exits 1, printing nothing, for a process that does not exist.
    if (process.platform === 'darwin' && (error as { code?: unknown }).code === 1 && !String((error as { stdout?: unknown }).stdout ?? '').trim()) return null;
  }
  return undefined;
}

let ownStart: Promise<string | undefined> | undefined;
const currentStart = () => (ownStart ??= processStart(process.pid).then((mark) => mark ?? undefined));

interface LockRecord {
  version: 1;
  token: string;
  pid: number;
  host: string;
  created: string;
  /** The boot the lock was made in, where the platform identifies one. */
  boot?: string;
  /** The holder's start, as processStart reads it. */
  start?: string;
}

/** What the holder was about to publish, recorded beside its lock right before the rename. */
interface IntentRecord {
  sourceSha256: string;
  candidateSha256: string;
}

interface HeldLock {
  path: string;
  record: LockRecord;
  dev: number;
  ino: number;
  /** Set once the intent file exists, so it is removed with the lock. */
  intent?: string;
}

interface FoundLock {
  raw: Buffer;
  record?: LockRecord;
  mtimeMs: number;
  dev: number;
  ino: number;
}

const intentPath = (lockPath: string, record: Pick<LockRecord, 'pid' | 'host' | 'token'>) =>
  `${lockPath}${INTENT_MARK}${record.pid}-${record.host}-${record.token}`;

async function newRecord(): Promise<LockRecord> {
  const [boot, start] = await Promise.all([currentBoot(), currentStart()]);
  return {
    version: 1,
    token: randomBytes(16).toString('hex'),
    pid: process.pid,
    host: HOST_TAG,
    created: new Date().toISOString(),
    ...(boot ? { boot } : {}),
    ...(start ? { start } : {}),
  };
}

async function readLock(path: string): Promise<FoundLock | undefined> {
  let raw: Buffer;
  let info;
  try {
    [raw, info] = await Promise.all([readFile(path), lstat(path)]);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let record: LockRecord | undefined;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed?.version === 1 && typeof parsed.token === 'string' && typeof parsed.pid === 'number' &&
        typeof parsed.host === 'string') record = parsed;
  } catch {
    record = undefined;
  }
  return { raw, record, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino };
}

/**
 * Whether the save that made this lock is certainly over. Unknown counts as
 * not over: a lock is never removed on a guess.
 */
async function lockAbandoned(found: FoundLock, starts: Map<number, Promise<string | null | undefined>>): Promise<boolean> {
  const record = found.record;
  if (!record) return Date.now() - found.mtimeMs > UNREADABLE_LOCK_STALE_MS;
  if (record.host !== HOST_TAG) return false;
  const boot = await currentBoot();
  if (record.boot && boot && record.boot !== boot) return true; // every process of that boot is gone
  if (!processAlive(record.pid)) return true;
  if (record.start === undefined) return false;
  if (!starts.has(record.pid)) starts.set(record.pid, record.pid === process.pid ? currentStart() : processStart(record.pid));
  const now = await starts.get(record.pid)!;
  if (now === null) return true;
  return now !== undefined && now !== record.start; // the id now belongs to another process
}

/**
 * Create `path` holding `record`, atomically and only if nothing is there:
 * the contents are written and flushed in a private file first, then linked
 * into place (link never replaces an existing name). Undefined: `path` exists.
 */
async function createExclusive(path: string, record: LockRecord): Promise<HeldLock | undefined> {
  const temp = `${path}${NEW_MARK}${process.pid}-${HOST_TAG}-${randomBytes(8).toString('hex')}`;
  const body = JSON.stringify(record);
  let handle = await open(temp, 'wx');
  let identity;
  try {
    await handle.writeFile(body);
    await handle.sync();
    identity = await handle.stat();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await link(temp, path);
    return { path, record, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return undefined;
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'].includes(errorCode(error) ?? '')) throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
  // A filesystem without hard links: create in place. A reader can then see
  // the lock empty for a moment, and an empty lock is only ever treated as
  // abandoned once it is UNREADABLE_LOCK_STALE_MS old.
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return undefined;
    throw error;
  }
  try {
    await handle.writeFile(body);
    await handle.sync();
    identity = await handle.stat();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
  await handle.close();
  return { path, record, dev: identity.dev, ino: identity.ino };
}

/** True when `path` is still exactly this lock: the same file, holding this token. */
async function lockStillHeld(held: HeldLock): Promise<boolean> {
  const found = await readLock(held.path).catch(() => undefined);
  return !!found && found.dev === held.dev && found.ino === held.ino && found.record?.token === held.record.token;
}

/**
 * Remove a lock this save holds. Safe without an atomic compare: once it is
 * confirmed ours, nothing else removes a live lock -- other saves only remove
 * a lock judged abandoned, under the takeover lock.
 */
async function releaseLock(held: HeldLock): Promise<void> {
  if (await lockStillHeld(held)) await unlink(held.path).catch(() => {});
  if (held.intent) await unlink(held.intent).catch(() => {});
}

/** Remove a dead takeover holder's lock without removing a newer one put there meanwhile. */
async function clearDeadTakeover(path: string, found: FoundLock): Promise<void> {
  const aside = `${path}.stale-${randomBytes(8).toString('hex')}`;
  try {
    await rename(path, aside);
  } catch {
    return;
  }
  const moved = await lstat(aside).catch(() => undefined);
  if (moved && (moved.dev !== found.dev || moved.ino !== found.ino)) await link(aside, path).catch(() => {});
  await unlink(aside).catch(() => {});
}

async function readIntent(lockPath: string, record: LockRecord | undefined): Promise<{ path?: string; intent?: IntentRecord }> {
  if (!record) return {};
  const path = intentPath(lockPath, record);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const intent = typeof parsed?.sourceSha256 === 'string' && typeof parsed?.candidateSha256 === 'string' ? parsed : undefined;
    return { path, intent };
  } catch {
    // Missing: no rename began. Unreadable: its write never completed, so no rename began either.
    return { path };
  }
}

interface TakenLock {
  name: string;
  intent?: IntentRecord;
}

/**
 * Remove a lock judged abandoned, without ever removing a live one. Only the
 * holder of the takeover lock may do this, and it judges the lock again
 * first: the same file, the same bytes, still abandoned. Since a lock is only
 * ever removed by its own holder or under the takeover lock, the lock judged
 * there is still the one removed.
 */
async function takeAbandonedLock(lockPath: string, found: FoundLock,
  starts: Map<number, Promise<string | null | undefined>>): Promise<TakenLock | undefined> {
  const takeoverPath = lockPath + TAKEOVER_SUFFIX;
  const takeover = await createExclusive(takeoverPath, await newRecord());
  if (!takeover) {
    const other = await readLock(takeoverPath);
    if (other && await lockAbandoned(other, starts)) await clearDeadTakeover(takeoverPath, other);
    return undefined;
  }
  try {
    const again = await readLock(lockPath);
    if (!again || again.dev !== found.dev || again.ino !== found.ino || !again.raw.equals(found.raw) ||
        !(await lockAbandoned(again, starts))) return undefined;
    const { path: intentFile, intent } = await readIntent(lockPath, again.record);
    await unlink(lockPath);
    if (intentFile) await unlink(intentFile).catch(() => {});
    return { name: basename(lockPath), intent };
  } finally {
    await releaseLock(takeover);
  }
}

function busyMessage(lockPath: string, found: FoundLock | undefined): string {
  const record = found?.record;
  if (found && !record) {
    return `Another save to this workbook may be in progress: its lock file ${lockPath} cannot be read. ` +
      `The workbook was not changed. It is cleared automatically ${UNREADABLE_LOCK_STALE_MS / 1000} s after it last ` +
      `changed; if no other window or program is saving this workbook, you can delete ${lockPath} and save again.`;
  }
  const where = record && record.host !== HOST_TAG ? ' on another computer' : '';
  return `Another save to this workbook is in progress${where} (process ${record?.pid ?? 'unknown'}, lock file ${lockPath}). ` +
    `The workbook was not changed. Try again once it has finished. If no other window, computer or program is ` +
    `saving this workbook -- for example after a crash -- delete ${lockPath} and save again.`;
}

async function acquireLock(filePath: string): Promise<{ held: HeldLock; abandoned: TakenLock[] }> {
  const path = filePath + LOCK_SUFFIX;
  const abandoned: TakenLock[] = [];
  const starts = new Map<number, Promise<string | null | undefined>>();
  const deadline = performance.now() + LOCK_WAIT_MS;
  try {
    const record = await newRecord();
    for (;;) {
      let held;
      try {
        held = await createExclusive(path, record);
      } catch (error) {
        throw new XlsxPublishError(
          `The save could not start: the lock file ${path} could not be written (${messageOf(error)}). The workbook was not changed.`,
          'not-published', { cause: error });
      }
      if (held) return { held, abandoned };
      const found = await readLock(path);
      if (found && await lockAbandoned(found, starts)) {
        const taken = await takeAbandonedLock(path, found, starts);
        if (taken) {
          abandoned.push(taken);
          continue;
        }
      }
      if (performance.now() >= deadline) throw new XlsxPublishError(busyMessage(path, found), 'not-published');
      await delay(LOCK_POLL_MS);
    }
  } catch (error) {
    if (error instanceof XlsxPublishError) throw error;
    throw new XlsxPublishError(
      `The workbook's folder cannot be used for a safe save (${messageOf(error)}). The workbook was not changed.`,
      'not-published', { cause: error });
  }
}

/**
 * Record, beside the lock, the publication about to happen, so a later save
 * can reconcile it if this process dies. A new file of this save's own,
 * created exclusively: the lock itself is never rewritten, so no failure here
 * can leave it unreadable, and nothing written here can land in another
 * save's lock.
 */
async function recordIntent(held: HeldLock, intent: IntentRecord): Promise<void> {
  const path = intentPath(held.path, held.record);
  const handle = await open(path, 'wx');
  held.intent = path;
  try {
    await handle.writeFile(JSON.stringify(intent));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** What became of the save an abandoned lock was protecting, from the workbook's bytes now. */
function abandonedOutcome(intent: IntentRecord | undefined, currentSha256: string): RecoveredSave['outcome'] {
  // Intent is recorded right before the rename; without it, no rename began.
  if (!intent) return 'not-published';
  if (intent.candidateSha256 === currentSha256) return 'published';
  if (intent.sourceSha256 === currentSha256) return 'not-published';
  return 'unknown';
}

/**
 * Remove staging files abandoned by writers that are gone. Only names this
 * writer makes, only regular files, only for a process known to be dead on this
 * computer, and a bounded number per save. Never published: an unfinished
 * stage was never verified against the workbook as it is now.
 */
async function recoverStages(filePath: string): Promise<RecoveredSave[]> {
  const folder = dirname(filePath);
  const prefix = basename(filePath) + STAGE_MARK;
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  // The lock's own debris, from a writer that died between two steps: a lock
  // or takeover lock not yet linked into place, or an intent whose lock was
  // already removed. Never published, never a lock anyone holds.
  const lockBase = basename(filePath) + LOCK_SUFFIX;
  const lockDebris = [lockBase + NEW_MARK, lockBase + TAKEOVER_SUFFIX + NEW_MARK, lockBase + INTENT_MARK];
  const out: RecoveredSave[] = [];
  for (const name of names) {
    if (out.length >= MAX_RECOVERED_STAGES) break;
    const debris = lockDebris.find((mark) => name.startsWith(mark));
    if (!debris && !name.startsWith(prefix)) continue;
    const tag = name.slice((debris ?? prefix).length);
    const current = debris
      ? /^(\d+)-([0-9a-f]{8})-(?:[0-9a-f]{16}|[0-9a-f]{32})$/.exec(tag)
      : /^(\d+)-([0-9a-f]{8})-[0-9a-f]{16}$/.exec(tag);
    const legacy = debris ? null : /^(\d+)-(\d{10,})$/.exec(tag);
    if (!current && !legacy) continue;
    if (current && current[2] !== HOST_TAG) continue;
    if (processAlive(Number((current ?? legacy)![1]))) continue;
    const path = join(folder, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (legacy && Date.now() - info.mtimeMs < LEGACY_STAGE_STALE_MS) continue;
    try {
      await unlink(path);
      out.push({ kind: debris ? 'lock' : 'stage', name });
    } catch {
      // Left for a later save.
    }
  }
  return out;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

const sameIdentity = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** A member's stored (compressed) bytes, from its local header. */
function storedBytes(index: ZipIndex, entry: ZipIndex['entries'][number]): Buffer {
  const { bytes } = index;
  const header = entry.localOffset;
  const data = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
  return bytes.subarray(data, data + entry.compressedSize);
}

/**
 * Check the staged package as read back from disk, on its own terms: the
 * archive parses, every member other than the edited sheet is unchanged, the
 * edited sheet decodes (CRC-checked) to the intended XML, everything outside the
 * edited row is the original XML, and the edited cell reads back as the value
 * with its style, no formula, and every other cell of the row unchanged.
 */
function verifyCandidate(staged: Buffer, plan: PatchPlan): void {
  const fail = (why: string): never => {
    throw new XlsxPublishError(
      `The edited workbook failed verification before it was saved (${why}). The workbook was not changed.`,
      'not-published');
  };
  if (!staged.equals(plan.bytes)) fail('the staged copy on disk differs from what was written');

  let sheet: Uint8Array | undefined;
  if (plan.sourceIndex) {
    const index = indexZip(staged) ?? fail('the staged archive does not parse');
    const before = plan.sourceIndex.entries;
    const after = index.entries;
    if (before.length !== after.length) fail('the number of parts changed');
    for (let i = 0; i < before.length; i++) {
      const [a, b] = [before[i], after[i]];
      if (a.name !== b.name) fail(`part ${a.name} is missing or moved`);
      if (a.name === plan.sheetPath) continue;
      if (a.method !== b.method || a.crc !== b.crc || a.size !== b.size || a.compressedSize !== b.compressedSize ||
          !storedBytes(plan.sourceIndex, a).equals(storedBytes(index, b))) fail(`part ${a.name} changed`);
    }
    const entry = after.find((e) => e.name === plan.sheetPath) ?? fail('the edited sheet is missing');
    const stored = storedBytes(index, entry);
    try {
      sheet = entry.method === 0
        ? stored
        : zlib.inflateRawSync(stored, { maxOutputLength: Math.max(1, plan.intendedSheet.length) });
    } catch {
      fail('the edited sheet does not decode');
    }
    if (sheet!.length !== entry.size) fail('the edited sheet does not match its declared size');
    // zipPatch's crc32 falls back to its own table where zlib.crc32 is missing
    // (Node before 20.15/22.2, which VS Code 1.85 ships), so this always runs.
    if (crc32(sheet!) !== entry.crc >>> 0) fail('the edited sheet fails its CRC');
  } else {
    let files: Record<string, Uint8Array> = {};
    try {
      files = unzipSync(new Uint8Array(staged));
    } catch {
      fail('the staged archive does not parse');
    }
    const source = plan.sourceFiles!;
    const names = Object.keys(source);
    if (Object.keys(files).length !== names.length) fail('the number of parts changed');
    for (const name of names) {
      if (!files[name]) fail(`part ${name} is missing`);
      if (name !== plan.sheetPath && !Buffer.from(files[name]).equals(Buffer.from(source[name]))) fail(`part ${name} changed`);
    }
    sheet = files[plan.sheetPath];
  }
  if (!sheet || !Buffer.from(sheet).equals(Buffer.from(plan.intendedSheet))) fail('the edited sheet is not the intended XML');

  const xml = strFromU8(sheet!);
  const tail = plan.sheetXml.length - plan.target.end;
  if (xml.slice(0, plan.target.start) !== plan.sheetXml.slice(0, plan.target.start) ||
      xml.slice(xml.length - tail) !== plan.sheetXml.slice(plan.target.end)) {
    fail('content outside the edited row changed');
  }
  const rowXml = xml.slice(plan.target.start, xml.length - tail);
  const rows = readRows(rowXml);
  if (rows.length !== 1 || rows[0].number !== plan.target.number || rows[0].xml !== rowXml) fail('the edited row is malformed');
  const cell = storedCellOf(rowXml, plan.letters, plan.sharedStrings);
  if (cell.formula !== undefined) fail(`cell ${plan.ref} still holds a formula`);
  if (cell.text !== plan.expectedText) fail(`cell ${plan.ref} does not read back as the new value`);
  if (cell.style !== plan.expectedStyle) fail(`cell ${plan.ref} lost its style`);
  const beforeCells = cellTextsOf(plan.target.xml, plan.sharedStrings);
  const afterCells = cellTextsOf(rowXml, plan.sharedStrings);
  for (const [letters, text] of beforeCells) {
    if (letters !== plan.letters && afterCells.get(letters) !== text) fail(`cell ${letters}${plan.target.number} changed`);
  }
  for (const letters of afterCells.keys()) {
    if (letters !== plan.letters && !beforeCells.has(letters)) fail(`cell ${letters}${plan.target.number} appeared`);
  }
}

/** Flush the directory entry the rename changed, where the platform allows opening a directory to do so. */
async function syncDirectory(folder: string): Promise<PatchCellReceipt['directorySync']> {
  if (process.platform === 'win32') return 'unsupported';
  const unsupported = new Set(['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF']);
  let handle;
  try {
    handle = await open(folder, 'r');
  } catch (error) {
    return unsupported.has(errorCode(error) ?? '') ? 'unsupported' : 'failed';
  }
  try {
    await handle.sync();
    return 'synced';
  } catch (error) {
    return errorCode(error) === 'EINVAL' || errorCode(error) === 'ENOTSUP' ? 'unsupported' : 'failed';
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Write one cell of a workbook on disk, and say truthfully what happened.
 *
 * Resolves only when the workbook now holds the verified edit (including when
 * the rename reported an error but the edit is there). Rejects with an
 * XlsxPublishError whose `outcome` says what is on disk otherwise.
 */
export async function patchCell(request: PatchCellRequest): Promise<PatchCellReceipt> {
  const { filePath } = request;
  const { held, abandoned } = await acquireLock(filePath);
  try {
    const recovered = await recoverStages(filePath);
    const identity = await stat(filePath);
    const original = await readFile(filePath);
    if (!sameIdentity(identity, await stat(filePath)) || identity.size !== original.length) {
      throw new XlsxPublishError(
        'The workbook was being changed while it was read, so the cell was not changed. Refresh before editing.',
        'not-published');
    }
    const sourceSha256 = sha256(original);
    for (const lock of abandoned) {
      recovered.push({ kind: 'lock', name: lock.name, outcome: abandonedOutcome(lock.intent, sourceSha256) });
    }
    if (request.expectedSha256 !== undefined && sourceSha256 !== request.expectedSha256) {
      throw new XlsxPublishError(
        'The workbook changed after it was read, so the cell was not changed. Refresh before editing.',
        'not-published');
    }
    const plan = planPatch(original, request);
    return await publish(filePath, plan, identity, sourceSha256, held, recovered);
  } catch (error) {
    if (error instanceof XlsxPublishError) throw error;
    throw new XlsxPublishError(messageOf(error), 'not-published', { cause: error });
  } finally {
    await releaseLock(held);
  }
}

async function publish(
  filePath: string,
  plan: PatchPlan,
  identity: FileIdentity,
  sourceSha256: string,
  held: HeldLock,
  recovered: RecoveredSave[]
): Promise<PatchCellReceipt> {
  const publishedSha256 = sha256(plan.bytes);
  const receipt = (reconciled: boolean, directorySync: PatchCellReceipt['directorySync']): PatchCellReceipt => ({
    outcome: 'published', cell: plan.ref, filePath, sourceSha256, publishedSha256, reconciled, directorySync, recovered,
  });

  // Written beside the file and moved into place, never over it: writing the
  // workbook's own path truncates it first. The name is unpredictable and
  // created exclusively, so it can never be a backup or another writer's file.
  const stage = `${filePath}${STAGE_MARK}${process.pid}-${HOST_TAG}-${randomBytes(8).toString('hex')}`;
  try {
    const handle = await open(stage, 'wx');
    try {
      await handle.writeFile(plan.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    verifyCandidate(await readFile(stage), plan);

    // The final check, as late as possible: still this save's turn, and the
    // workbook still the very file and bytes the edit was made from.
    const lost = () => new XlsxPublishError(
      'Another save took over this workbook, so the cell was not changed. Refresh before editing.', 'not-published');
    if (!(await lockStillHeld(held))) throw lost();
    const now = await stat(filePath);
    if (!sameIdentity(identity, now) || sha256(await readFile(filePath)) !== sourceSha256) {
      throw new XlsxPublishError(
        'The workbook was changed by another program during the save, so the cell was not changed. Refresh before editing.',
        'not-published');
    }
    // Ownership once more, after the source re-read and around the intent,
    // so a save whose lock was lost meanwhile never publishes.
    if (!(await lockStillHeld(held))) throw lost();
    await recordIntent(held, { sourceSha256, candidateSha256: publishedSha256 });
    if (!(await lockStillHeld(held))) throw lost();
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    if (error instanceof XlsxPublishError) throw error;
    throw new XlsxPublishError(
      `The edited workbook could not be saved (${messageOf(error)}). The workbook was not changed.`,
      'not-published', { cause: error });
  }

  try {
    await rename(stage, filePath);
  } catch (error) {
    // The acknowledgement is lost, not the answer: read what is there now.
    // Never retried -- a second rename could overwrite whatever has since
    // replaced the workbook.
    let onDisk: string | undefined;
    try {
      onDisk = sha256(await readFile(filePath));
    } catch {
      onDisk = undefined;
    }
    await rm(stage, { force: true }).catch(() => {});
    if (onDisk === publishedSha256) return receipt(true, await syncDirectory(dirname(filePath)));
    if (onDisk === sourceSha256) {
      throw new XlsxPublishError(
        `The edited workbook could not be moved into place (${messageOf(error)}). The workbook was not changed.`,
        'not-published', { cause: error });
    }
    throw new XlsxPublishError(
      `Saving reported an error (${messageOf(error)}), and the workbook on disk now matches neither the original ` +
        `nor the edit -- another program may have changed it. Nothing was retried; reopen the file to see what it holds.`,
      'unknown', { cause: error });
  }
  return receipt(false, await syncDirectory(dirname(filePath)));
}
