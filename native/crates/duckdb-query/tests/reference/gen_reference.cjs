// D3.5 reference generator: runs one fixed case list through the TypeScript reference (src/duckdbConnection.ts
// compiled by `tsc -p tsconfig.test.json --outDir <dir>`) and writes the logical results/typed refusals the
// native engine is compared against. Usage (TZ is pinned so datetime means print the +00 zone):
//   TZ=UTC NODE_PATH=<repo>/node_modules node gen_reference.cjs <compiled-ts-dir> <out.json>
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const [, , tsOut, outFile] = process.argv;
const { DuckDBInstance } = require('@duckdb/node-api');
const { DuckDbFile } = require(path.join(tsOut, 'src/duckdbConnection.js'));
const { QueryPolicyError } = require(path.join(tsOut, 'src/queryPolicy.js'));
const repo = path.resolve(__dirname, '../../../../..');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceFiles = ['src/duckdbConnection.ts', 'src/queryPolicy.ts', 'src/backend/sql.ts', 'src/chartSpec.ts', 'package-lock.json', 'tsconfig.test.json'];

const NAMES = ['Zebra', 'apple', 'çilek', 'Şeker', 'ıspanak', 'item10', 'item9'];
const BIG = ['9', '10', '100', '1000', '-5', '1152921504606846976', '1152921504606846975'];
const FIXTURE = [
  'create table t (id integer, big bigint, huge hugeint, dec decimal(30, 4), ts timestamp, name varchar)',
  `insert into t values ${NAMES.map((name, i) =>
    `(${i}, ${BIG[i]}, ${BIG[i]}::hugeint * 1000000000000, ${(i * 3.25 - 4).toFixed(4)}, timestamp '2024-0${(i % 9) + 1}-15 0${i}:30:00', '${name}')`).join(', ')}`,
  'insert into t values (99, null, null, null, null, null)',
  'create table native (Date date, Rate double)',
  "insert into native select date '2000-01-01' + interval (i) month, i * 1.5 from range(0, 200) as t(i)",
  'create table etl (Date varchar, SVENF01 double)',
  "insert into etl select strftime(Date, '%Y-%m-%d'), Rate from native",
  'create table labels (Date varchar, ff double)',
  "insert into labels values ('1996-3Q', 5.3), ('1996-1Q', 5.1), ('1996-2Q', 5.2)",
  'create table years (Year integer, Rate double)',
  'insert into years values (2023, 3.0), (2021, 1.0), (2022, 2.0)',
  'create table months (Month integer, Rate double)',
  'insert into months values (3, 3.0), (1, 1.0), (2, 2.0)',
  'create table mostly (Date varchar, v double)',
  "insert into mostly select strftime(Date, '%Y-%m-%d'), Rate from native limit 100",
  "insert into mostly values ('n/a', 1.0), ('', 2.0)",
  'create schema other; create table other.t(k integer, "Odd ""Name""" varchar); insert into other.t values (1, \'x\')',
];

const cases = [];
const q = (name, sql, maxRows) => cases.push({ name, method: 'runQuery', args: { sql, maxRows } });
q('all rows', 'select * from t order by id');
q('cap truncates', 'select * from t order by id', 3);
q('cap equals size is not truncated', 'select id from t', 9);
q('semicolon and trailing limit', 'select id from t order by id limit 4;');
q('nulls and exact integers', 'select big, huge, dec, ts from t order by id');
q('aggregate', 'select count(*) as n, sum(big) as s, min(ts) as lo from t');
q('quoted mixed-case identifiers', 'select * from other.t');
q('describe is read only', 'describe select * from t');
q('limit zero rows', 'select * from t where false');
for (const col of ['big', 'huge', 'dec', 'ts', 'name', 'id']) for (const direction of ['asc', 'desc'])
  cases.push({ name: `sorted ${col} ${direction}`, method: 'runSortedQuery', args: { baseSql: 'select * from t limit 100', column: col, direction } });
cases.push({ name: 'sorted spans the data set, not the limit window', method: 'runSortedQuery', args: { baseSql: 'select * from t limit 2', column: 'big', direction: 'desc' } });
cases.push({ name: 'sorted hostile column name', method: 'runSortedQuery', args: { baseSql: 'select * from t', column: 'id" from t; drop table t; --', direction: 'asc' } });
for (const sql of ['select * from t', 'select * from t limit 3', 'select * from t where big > 50;', 'select * from t where false', 'select * from nosuch', 'select * from t limit', 'drop table t', 'select * from read_csv(\'/etc/passwd\')'])
  cases.push({ name: `count ${sql}`, method: 'countMatchingRows', args: { sql } });
for (const [column, limit] of [['name', 20], ['id', 3], ['dec', 5], ['ts', 2], ['big', 0], ['name', 1000]])
  cases.push({ name: `top values ${column} ${limit}`, method: 'getColumnTopValues', args: { baseSql: 'select * from t', column, limit } });
cases.push({ name: 'top values over a limited query', method: 'getColumnTopValues', args: { baseSql: 'select * from t limit 4', column: 'name', limit: 10 } });
for (const [column, statsKind] of [['big', 'numeric'], ['huge', 'numeric'], ['dec', 'numeric'], ['id', 'numeric'], ['ts', 'datetime']])
  cases.push({ name: `stats ${column} ${statsKind}`, method: 'getColumnDescriptiveStats', args: { baseSql: 'select * from t', column, statsKind } });
cases.push({ name: 'stats over an empty query', method: 'getColumnDescriptiveStats', args: { baseSql: 'select * from t where false', column: 'id', statsKind: 'numeric' } });
cases.push({ name: 'stats on a missing column', method: 'getColumnDescriptiveStats', args: { baseSql: 'select * from t', column: 'nope', statsKind: 'numeric' } });
const chart = (name, baseSql, x, ys, xIsText = false, maxPoints = 0, xIsCategory = false) =>
  cases.push({ name: `chart ${name}`, method: 'runChartQuery', args: { baseSql, xColumn: x, yColumns: ys, xIsText, maxPoints, xIsCategory } });
chart('native DATE is a time axis', 'select * from native', 'Date', ['Rate']);
chart('trailing LIMIT is honoured', 'SELECT * FROM "native" LIMIT 100;', 'Date', ['Rate']);
chart('limited rows are the ones on screen', 'select * from "native" order by "Date" desc limit 10', 'Date', ['Rate']);
chart('VARCHAR ISO text is cast to time', 'select * from etl', 'Date', ['SVENF01'], true);
chart('junk rows do not downgrade a date column', 'select * from mostly', 'Date', ['v'], true);
chart('period labels stay a category in stored order', 'select * from labels', 'Date', ['ff'], true);
chart('numeric Year is an ordered time axis', 'select * from years', 'Year', ['Rate'], false, 0, true);
chart('numeric period that is not a year stays a category', 'select * from months', 'Month', ['Rate'], false, 0, true);
chart('point cap is reported', 'select * from native', 'Date', ['Rate'], false, 50);
chart('hostile x column name', 'select * from native', 'Date" from native; drop table native; --', ['Rate']);
chart('refused sql', 'drop table native', 'Date', ['Rate']);
cases.push({ name: 'catalog', method: 'getQueryCatalog', args: { offset: 0 } });
cases.push({ name: 'catalog invalid page', method: 'getQueryCatalog', args: { offset: 1000001 } });
for (const [schema, name] of [['main', 't'], ['other', 't'], ['main', 'nosuch']])
  cases.push({ name: `columns ${schema}.${name}`, method: 'getQueryColumns', args: { catalog: 'CATALOG', schema, name } });
cases.push({ name: 'columns unknown catalog', method: 'getQueryColumns', args: { catalog: 'elsewhere', schema: 'main', name: 't' } });
for (const [i, sql] of [
  "select * from read_csv('/etc/passwd')", 'drop table t', 'select 1; select 2', '', '   ', "copy t to '/tmp/d35-copy.csv'", "attach '/tmp/d35.db' as x",
  'pragma version', 'install httpfs', 'select * from duckdb_settings()', 'select * from duckdb_tables()', 'select * from information_schema.schemata',
  "select * from read_text('/etc/hosts')", "select getenv('HOME')", "select * from glob('/tmp/*')", 'insert into t values (1,1,1,1,null,null)', 'select * from nosuch',
  'select nosuchcol from t', 'select 1 +', "select rpad('x', 5 * 1024 * 1024, 'x')", "select rpad('x', 3000000, 'x') from range(12)", 'x'.repeat(300 * 1024),
].entries()) cases.push({ name: `refusal ${i}`, method: 'runQuery', args: { sql } });

const canon = (v) => v === null || v === undefined ? null : typeof v === 'boolean' ? v : typeof v === 'number' ? String(v) : String(v);
const rows = (r) => r.rows.map((row) => row.map(canon));
function shape(method, r, args) {
  switch (method) {
    case 'runQuery': return { columns: r.columns, column_stats_kind: r.columnStatsKind, rows: rows(r), truncated: !!r.truncated };
    case 'runSortedQuery': return { columns: r.columns, column_stats_kind: r.columnStatsKind, rows: rows(r), truncated: !!r.truncated, sorted_sql: r.sortedSql };
    case 'runChartQuery': return { columns: r.columns, column_stats_kind: r.columnStatsKind, rows: rows(r), truncated: !!r.truncated, x_axis_mode: r.xAxisMode };
    case 'countMatchingRows': return { count: r === undefined ? null : String(r) };
    case 'getColumnTopValues': return { total_rows: String(r.totalRows), non_null_rows: String(r.nonNullRows), null_count: String(r.nullCount), distinct_count: String(r.distinctCount), top_values: r.topValues.map((t) => ({ value: canon(t.value), frequency: String(t.frequency) })) };
    case 'getColumnDescriptiveStats': return { total_rows: String(r.totalRows), non_null_rows: String(r.nonNullRows), null_count: String(r.nullCount), min: canon(r.min), max: canon(r.max), mean: canon(r.mean), p5: canon(r.p5), p95: canon(r.p95) };
    case 'getQueryCatalog': return r.map((t) => ({ catalog: t.catalog, schema: t.schema, name: t.name, sql_name: t.sqlName }));
    case 'getQueryColumns': return r.map((c) => ({ name: c.name, source_type: c.type }));
  }
  throw new Error(method);
}
const errorClass = (e) => e instanceof QueryPolicyError
  ? (/exceeds|too large|larger|32 MiB|4 MiB|256 KiB/i.test(e.message) ? 'resource' : 'policy')
  : /^(Invalid catalog page|Unknown query catalog)/.test(e.message) ? 'invalid' : 'engine';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd35-ref-'));
  const p = path.join(dir, 'fixture.duckdb');
  const inst = await DuckDBInstance.create(p); const c = await inst.connect();
  for (const sql of FIXTURE) await c.run(sql);
  c.closeSync(); inst.closeSync();
  const file = await DuckDbFile.open(p, undefined, { forceReadOnly: true, restrictedReads: true });
  const catalog = (await file.getQueryCatalog())[0].catalog;
  const call = {
    runQuery: (a) => file.runQuery(a.sql, a.maxRows ?? 0),
    runSortedQuery: (a) => file.runSortedQuery(a.baseSql, a.column, a.direction, 0),
    runChartQuery: (a) => file.runChartQuery(a.baseSql, a.xColumn, a.yColumns, a.xIsText, a.maxPoints, a.xIsCategory),
    countMatchingRows: (a) => file.countMatchingRows(a.sql),
    getColumnTopValues: (a) => file.getColumnTopValues(a.baseSql, a.column, a.limit),
    getColumnDescriptiveStats: (a) => file.getColumnDescriptiveStats(a.baseSql, a.column, a.statsKind),
    getQueryCatalog: (a) => file.getQueryCatalog(a.offset),
    getQueryColumns: (a) => file.getQueryColumns(a.catalog === 'CATALOG' ? catalog : a.catalog, a.schema, a.name),
  };
  for (const k of cases) {
    try { k.expect = { kind: 'ok', result: shape(k.method, await call[k.method](k.args), k.args) }; }
    catch (e) { k.expect = { kind: 'error', error_class: errorClass(e), reference_error: e.constructor.name, message: String(e.message).slice(0, 200) }; }
  }
  file.dispose();
  const here = fs.readFileSync(__filename);
  const out = {
    meta: {
      generator: 'native/crates/duckdb-query/tests/reference/gen_reference.cjs',
      generator_sha256: crypto.createHash('sha256').update(here).digest('hex'),
      reference_source: 'src/duckdbConnection.ts DuckDbFile (restrictedReads, forceReadOnly)',
      source_sha256: Object.fromEntries(sourceFiles.map((file) => [file, sha256(path.join(repo, file))])),
      compiled_sha256: Object.fromEntries(sourceFiles.filter((file) => file.endsWith('.ts')).map((file) => [file.replace(/\.ts$/, '.js'), sha256(path.join(tsOut, file.replace(/\.ts$/, '.js')))])),
      duckdb_node_api: require('@duckdb/node-api/package.json').version,
      node: process.version, tz: process.env.TZ ?? null, catalog,
      note: 'Cells are canonical text: ints and decimals as decimal text, floats as JS String(), dates and timestamps as DuckDB text.',
    },
    fixture_sql: FIXTURE,
    cases,
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${cases.length} cases, ${cases.filter((k) => k.expect.kind === 'error').length} errors -> ${outFile}`);
})();
