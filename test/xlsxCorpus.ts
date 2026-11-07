/**
 * EX-01 corpus loader: committed XLSX fixtures plus their ground truth.
 *
 * Fixtures and ground-truth.json come from test/fixtures/xlsx-corpus/build_corpus.py
 * (stdlib writer, byte-deterministic). Ground truth is derived from the same
 * spec as the cells, never from detector or DuckDB output.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RawCell {
  type: 'string' | 'number' | 'boolean' | 'error' | 'formula';
  text: string;
  formula?: string;
  cachedType?: string;
}

export interface TruthTable {
  sheet: string;
  range: string;
  headerRows: number[];
  columns: string[] | null;
  columnLevels?: string[][];
  rows: (string | number | null)[][];
  declaredName?: string;
  excludedRows?: number[];
  errorCells?: Record<string, string>;
}

export interface TruthFixture {
  file: string;
  description: string;
  defects: string[];
  sheets: { name: string; raw: Record<string, RawCell>; merges: string[]; declaredTables: { name: string; ref: string }[] }[];
  tables: TruthTable[];
  nonTables: { sheet: string; ref: string; why: string }[];
}

/** Works from both test/ (ts-node style) and out-test/test/ (compiled). */
export const CORPUS_DIR = [
  join(__dirname, '..', '..', 'test', 'fixtures', 'xlsx-corpus'),
  join(__dirname, 'fixtures', 'xlsx-corpus'),
].find((p) => existsSync(join(p, 'ground-truth.json')))!;

export const TRUTH: { fixtures: Record<string, TruthFixture> } = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'ground-truth.json'), 'utf8')
);
export const MANIFEST: { sha256: Record<string, string> } = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8')
);

export function fixturePath(name: string): string {
  return join(CORPUS_DIR, TRUTH.fixtures[name].file);
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 'B3' -> [row0, col0]. */
export function parseRef(ref: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad ref ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, col - 1];
}

export function letters(col0: number): string {
  let n = col0 + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Region (top/left inclusive, bottom/right exclusive, 0-based) -> 'A1:B3'. */
export function regionRef(r: { top: number; bottom: number; left: number; right: number }): string {
  return `${letters(r.left)}${r.top + 1}:${letters(r.right - 1)}${r.bottom}`;
}

/** The stored text grid as an all_varchar read would show it (null where no cell). */
export function rawGrid(sheet: TruthFixture['sheets'][number]): (string | null)[][] {
  let rows = 0;
  let cols = 0;
  for (const ref of Object.keys(sheet.raw)) {
    const [r, c] = parseRef(ref);
    rows = Math.max(rows, r + 1);
    cols = Math.max(cols, c + 1);
  }
  const grid: (string | null)[][] = Array.from({ length: rows }, () => Array<string | null>(cols).fill(null));
  for (const [ref, cell] of Object.entries(sheet.raw)) {
    const [r, c] = parseRef(ref);
    grid[r][c] = cell.text;
  }
  return grid;
}

/**
 * Compare a logical value from ground truth with what a derived query returned.
 * Numbers compare numerically (DuckDB may hand back DOUBLE/DECIMAL/BIGINT),
 * text compares exactly, null must be null.
 */
export function sameValue(got: unknown, want: string | number | null): boolean {
  if (want === null) return got === null || got === undefined;
  if (typeof want === 'number') return got !== null && got !== undefined && got !== '' && Number(got) === want;
  return typeof got === 'string' && got === want;
}

export function normalise(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}
