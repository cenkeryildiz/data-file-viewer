import type { DuckDBConnection } from '@duckdb/node-api';

/** SQL spelling shared by every backend module. Host-free: no vscode, no PDF. */

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

let nextLoadId = 0;

/**
 * Replace whatever object stands behind `name` with a real table holding
 * `body`'s result.
 *
 * Built under a temporary name and renamed into place rather than dropped
 * first: a failure part-way through then leaves the existing object standing,
 * instead of leaving the workbook with a sheet that no longer exists.
 *
 * `create or replace table x as select ... from x` is not an option — it is
 * the object being read, and DuckDB has no promise that the read completes
 * before the replace begins.
 */
export async function replaceWithTable(
  connection: DuckDBConnection,
  name: string,
  body: string,
  currentlyCached: boolean
): Promise<void> {
  const target = quoteIdent(name);
  const tmp = quoteIdent(`__dfv_load_${nextLoadId++}`);
  await connection.run(`create table ${tmp} as ${body}`);
  try {
    await connection.run(currentlyCached ? `drop table ${target}` : `drop view ${target}`);
  } catch (err) {
    await connection.run(`drop table if exists ${tmp}`);
    throw err;
  }
  await connection.run(`alter table ${tmp} rename to ${target}`);
}

// $-anchored so only the outermost/final LIMIT is matched -- a LIMIT nested
// inside an inner subquery (part of the query's own logic) is left alone.
export const TRAILING_LIMIT_RE = /\s+limit\s+\d+(?:\s+offset\s+\d+)?\s*;?\s*$/i;

export function hasTrailingLimit(sql: string): boolean {
  return TRAILING_LIMIT_RE.test(sql);
}

// Structural gate for "is this SELECT * FROM <one table> [WHERE][ORDER BY]
// [LIMIT]". Intentionally conservative: a false negative just disables the
// edit affordance for that query, never misclassifies something dangerous
// as safe. The real security boundary is the extractStatements()/
// statementType check in checkEditableSelect, run before this regex.
export const EDITABLE_SELECT_RE = new RegExp(
  '^select\\s+\\*\\s+from\\s+' +
    '("(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_]*)' +
    '(?:\\s+where\\s+[\\s\\S]+?)?' +
    '(?:\\s+order\\s+by\\s+[\\s\\S]+?)?' +
    '(?:\\s+limit\\s+\\d+(?:\\s+offset\\s+\\d+)?)?' +
    '\\s*;?\\s*$',
  'i'
);
export const FORBIDDEN_KEYWORDS_RE = /\b(join|group\s+by|distinct|union|intersect|except|using|window)\b/i;

/**
 * The one table a plain `select * from X` reads, or undefined for anything else.
 *
 * Deliberately not checkEditableSelect: that answers "may this be written to",
 * which is false for a read-only file and for a block of a sheet, and the
 * caller here only wants to know WHICH table is on screen. Used to give each
 * table its own chart tab.
 */
export function baseTableOfSelect(sql: string | undefined): string | undefined {
  if (!sql) return undefined;
  const match = EDITABLE_SELECT_RE.exec(sql.trim());
  if (!match || FORBIDDEN_KEYWORDS_RE.test(sql)) return undefined;
  const raw = match[1];
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
}
