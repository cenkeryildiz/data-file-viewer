import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { vscodeStub, resetVscodeStub } from './stress/stubs/vscode';
import { DuckDbFile } from '../src/duckdbConnection';
import { DuckDBDocument, DuckDBEditorProvider } from '../src/duckdbEditorProvider';

/**
 * PLOT-02 (row-number axis) and PLOT-03 (plot-only date choice), run against a
 * real DuckDB database and a real CSV.
 *
 * The contract being pinned: the choice only shapes the plot query. It never
 * renames or retypes a column, never reads a plain integer as an epoch time, and
 * never guesses -- a value it cannot place is a refusal that says how many, and
 * the source file's bytes are identical afterwards.
 */

let dir: string;
let dbPath: string;
let csvPath: string;
let dbHash: string;
let csvHash: string;

const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-axis-'));
  dbPath = join(dir, 'axis.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const c = await instance.connect();
  const run = (sql: string) => c.run(sql);

  // No date column at all; a null y between two values.
  await run(`create table nodate (v double)`);
  await run(`insert into nodate values (3.5), (null), (7), (1)`);
  // A real column that collides with the generated "Row" label, in another case.
  await run(`create table collide (ROW double, v double)`);
  await run(`insert into collide values (10, 1), (20, 2), (30, 3)`);
  // A real date column present: Automatic uses it, Row numbers overrides it.
  await run(`create table dated (Date date, v double)`);
  await run(`insert into dated values ('2024-03-01', 1), ('2024-01-01', 2), ('2024-02-01', 3)`);

  // PLOT-03: ISO text under a name the automatic rules do not recognise.
  await run(`create table iso (opened_at varchar, v double)`);
  await run(`insert into iso values ('2024-03-01', 3), ('2024-01-01', 1), ('2024-02-01 12:30:00', 2)`);
  // Day/month text. DuckDB does not read it, and the chart must say so, not guess.
  await run(`create table ambiguous (d varchar, v double)`);
  await run(`insert into ambiguous values ('03/04/2024', 1), ('13/04/2024', 2), ('2024-05-01', 3)`);
  await run(`create table twodigit (d varchar, v double)`);
  await run(`insert into twodigit values ('1/2/24', 1), ('2/3/24', 2)`);
  // Junk and nulls.
  await run(`create table baddates (d varchar, v double)`);
  await run(`insert into baddates values ('2024-01-01', 1), ('n/a', 2), ('2024-01-03', 3), (null, 4)`);
  await run(`create table nulldates (d varchar, v double)`);
  await run(`insert into nulldates values ('2024-01-02', 2), (null, 9), ('2024-01-01', 1), (null, 8)`);
  await run(`create table allnull (d varchar, v double)`);
  await run(`insert into allnull values (null, 1)`);
  // Year labels in several shapes.
  await run(`create table yrs (yr integer, v double)`);
  await run(`insert into yrs values (2023, 3), (2021, 1), (2022, 2)`);
  await run(`create table yrtext (yr varchar, v double)`);
  await run(`insert into yrtext values ('2023', 3), ('2021', 1)`);
  await run(`create table yrfrac (yr double, v double)`);
  await run(`insert into yrfrac values (2023, 1), (2024.5, 2)`);
  await run(`create table counts (n integer, v double)`);
  await run(`insert into counts values (1, 1), (2, 2), (3, 3)`);
  // An integer that would be a plausible epoch: never a date.
  await run(`create table epoch (ts bigint, v double)`);
  await run(`insert into epoch values (1700000000, 1), (1700086400, 2)`);
  // Time zones.
  await run(`create table tzsame (d varchar, v double)`);
  await run(`insert into tzsame values ('2024-03-04 10:00:00+02', 1), ('2024-03-05 10:00:00+02', 2)`);
  await run(`create table tzmixed (d varchar, v double)`);
  await run(`insert into tzmixed values ('2024-03-04 10:00:00+02', 1), ('2024-03-05 10:00:00Z', 2)`);
  await run(`create table tzpartial (d varchar, v double)`);
  await run(`insert into tzpartial values ('2024-03-04 10:00:00+02', 1), ('2024-03-05 10:00:00', 2)`);
  await run(`create table tznative (stamp timestamptz, v double)`);
  await run(`insert into tznative values ('2024-03-04 10:00:00+02', 1), ('2024-03-05 10:00:00+02', 2)`);
  // Not a date-capable type.
  await run(`create table flags (b boolean, v double)`);
  await run(`insert into flags values (true, 1)`);
  await run(`create table "we""ird" (v double)`);
  await run(`insert into "we""ird" values (1)`);
  c.closeSync();
  instance.closeSync();

  csvPath = join(dir, 'ledger.csv');
  await writeFile(csvPath, 'booked,amount\n2024-02-01,20\n2024-01-01,10\nbad,30\n');
  dbHash = await sha(dbPath);
  csvHash = await sha(csvPath);
});

after(async () => {
  // Every test left the sources byte-identical.
  assert.equal(await sha(dbPath), dbHash, 'database changed');
  assert.equal(await sha(csvPath), csvHash, 'csv changed');
  await rm(dir, { recursive: true, force: true });
});

const row = (file: DuckDbFile, sql: string, y: string[], x = 'Row') =>
  file.runChartQuery(sql, x, y, false, 0, false, true);
const asDate = (file: DuckDbFile, sql: string, x: string, y: string[]) =>
  file.runChartQuery(sql, x, y, false, 0, false, false, true);

async function withFile<T>(fn: (file: DuckDbFile) => Promise<T>, path = dbPath): Promise<T> {
  const file = await DuckDbFile.open(path);
  try {
    return await fn(file);
  } finally {
    file.dispose();
  }
}

// --------------------------------------------------------------- PLOT-02

test('row numbers: a one-column numeric table plots, null y keeps its row', () =>
  withFile(async (file) => {
    const r = await row(file, 'select * from nodate', ['v']);
    assert.deepEqual(r.columns, ['Row', 'v']);
    assert.equal(r.xAxisMode, 'category');
    assert.deepEqual(r.rows.map((x) => Number(x[0])), [1, 2, 3, 4]);
    assert.deepEqual(r.rows.map((x) => (x[1] === null ? null : Number(x[1]))), [3.5, null, 7, 1]);
  }));

test('row numbers follow filter, sort and LIMIT of the query on screen', () =>
  withFile(async (file) => {
    const r = await row(file, 'select v from nodate where v is not null order by v desc limit 2', ['v']);
    assert.deepEqual(r.rows.map((x) => [Number(x[0]), Number(x[1])]), [[1, 7], [2, 3.5]]);
    // Sorting changes which value is row 1, not how many rows there are.
    const asc = await row(file, 'select v from nodate order by v asc nulls last', ['v']);
    assert.deepEqual(asc.rows.map((x) => (x[1] === null ? null : Number(x[1]))), [1, 3.5, 7, null]);
    assert.deepEqual(asc.rows.map((x) => Number(x[0])), [1, 2, 3, 4]);
  }));

test('the generated Row column steps aside for a real one, case-insensitively', () =>
  withFile(async (file) => {
    const r = await row(file, 'select * from collide', ['ROW']);
    assert.deepEqual(r.columns, ['Row (2)', 'ROW']);
    assert.deepEqual(r.rows.map((x) => [Number(x[0]), Number(x[1])]), [[1, 10], [2, 20], [3, 30]]);
    const twice = await row(file, 'select ROW as "Row (2)", ROW from collide', ['Row (2)', 'ROW']);
    assert.equal(twice.columns[0], 'Row (3)');
  }));

test('an empty result is empty, not an error or a fabricated row', () =>
  withFile(async (file) => {
    const r = await row(file, 'select v from nodate where false', ['v']);
    assert.deepEqual(r.columns, ['Row', 'v']);
    assert.equal(r.rows.length, 0);
  }));

test('row numbers override a date column that Automatic would have used', () =>
  withFile(async (file) => {
    const auto = await file.runChartQuery('select * from dated', 'Date', ['v']);
    assert.equal(auto.xAxisMode, 'time');
    const over = await row(file, 'select * from dated', ['v']);
    assert.equal(over.xAxisMode, 'category');
    // Table order, not date order: the row axis is position, not time.
    assert.deepEqual(over.rows.map((x) => [Number(x[0]), Number(x[1])]), [[1, 1], [2, 2], [3, 3]]);
  }));

test('the point cap still reports truncation on a row axis', () =>
  withFile(async (file) => {
    const r = await file.runChartQuery('select * from nodate', 'Row', ['v'], false, 2, false, true);
    assert.equal(r.truncated, true);
  }));

test('a CSV with no date column plots against row numbers and is not modified', () =>
  withFile(async (file) => {
    const r = await row(file, 'select amount from ledger', ['amount']);
    assert.deepEqual(r.rows.map((x) => Number(x[0])), [1, 2, 3]);
  }, csvPath));

// --------------------------------------------------------------- PLOT-03

test('a differently named ISO text column is read as dates on request', () =>
  withFile(async (file) => {
    const r = await asDate(file, 'select * from iso', 'opened_at', ['v']);
    assert.equal(r.xAxisMode, 'time');
    assert.deepEqual(r.columns, ['opened_at', 'v']);
    // Ordered by the parsed date, and the time of day survived.
    assert.deepEqual(r.rows.map((x) => Number(x[1])), [1, 2, 3]);
    assert.ok(Number.isFinite(Date.parse(String(r.rows[1][0]))));
    assert.match(String(r.rows[1][0]), /12:30/);
    assert.equal(r.note, undefined);
  }));

test('a native DATE column named anything is used as it is', () =>
  withFile(async (file) => {
    const r = await asDate(file, 'select Date as "when", v from dated', 'when', ['v']);
    assert.equal(r.xAxisMode, 'time');
    assert.deepEqual(r.rows.map((x) => Number(x[1])), [2, 3, 1]);
  }));

test('ambiguous day/month text is refused with the count, not guessed', () =>
  withFile(async (file) => {
    await assert.rejects(asDate(file, 'select * from ambiguous', 'd', ['v']), (err: Error) => {
      assert.match(err.message, /2 of 3 values in "d" are not recognised dates/);
      assert.match(err.message, /ambiguous/);
      // Counts and the column label only: no cell value is echoed.
      assert.doesNotMatch(err.message, /2024/);
      return true;
    });
    // Two-digit years would parse as year 1; they are refused too.
    await assert.rejects(asDate(file, 'select * from twodigit', 'd', ['v']), /2 of 2 values/);
  }));

test('unparseable dates are refused with a count; null dates are left out and counted', () =>
  withFile(async (file) => {
    await assert.rejects(asDate(file, 'select * from baddates', 'd', ['v']), (err: Error) => {
      assert.match(err.message, /1 of 3 values in "d"/);
      assert.doesNotMatch(err.message, /n\/a/);
      return true;
    });
    const r = await asDate(file, 'select * from nulldates', 'd', ['v']);
    assert.deepEqual(r.rows.map((x) => Number(x[1])), [1, 2]);
    assert.equal(r.note, '2 rows with no date left out');
    await assert.rejects(asDate(file, 'select * from allnull', 'd', ['v']), /no dates to plot/);
  }));

test('year labels: integers and digit text become 1 January; fractions and counts do not', () =>
  withFile(async (file) => {
    const ints = await asDate(file, 'select * from yrs', 'yr', ['v']);
    assert.equal(ints.xAxisMode, 'time');
    assert.deepEqual(ints.rows.map((x) => Number(x[1])), [1, 2, 3]);
    assert.match(String(ints.rows[0][0]), /^2021-01-01/);
    const text = await asDate(file, 'select * from yrtext', 'yr', ['v']);
    assert.deepEqual(text.rows.map((x) => Number(x[1])), [1, 3]);
    // 2024.5 must not round to a year.
    await assert.rejects(asDate(file, 'select * from yrfrac', 'yr', ['v']), /1 of 2 values/);
    // 1, 2, 3 is a count, not the years 1-3.
    await assert.rejects(asDate(file, 'select * from counts', 'n', ['v']), /3 of 3 values/);
  }));

test('an integer is never an epoch timestamp', () =>
  withFile(async (file) => {
    await assert.rejects(asDate(file, 'select * from epoch', 'ts', ['v']), (err: Error) => {
      assert.match(err.message, /2 of 2 values/);
      assert.match(err.message, /not epoch times/);
      return true;
    });
  }));

test('time zones: one shared offset is plotted as written and says so; a mix is refused', () =>
  withFile(async (file) => {
    const same = await asDate(file, 'select * from tzsame', 'd', ['v']);
    assert.match(String(same.rows[0][0]), /10:00:00/);
    assert.match(same.note ?? '', /UTC offset \+02 not applied/);
    await assert.rejects(asDate(file, 'select * from tzmixed', 'd', ['v']), /mixes UTC offsets/);
    await assert.rejects(asDate(file, 'select * from tzpartial', 'd', ['v']), /mixes UTC offsets/);
    // A real TIMESTAMPTZ column already has one meaning; it is used as it is.
    const native = await asDate(file, 'select * from tznative', 'stamp', ['v']);
    assert.equal(native.xAxisMode, 'time');
    assert.equal(native.rows.length, 2);
  }));

test('a column that cannot be dates, is missing, or is also the series is refused by name', () =>
  withFile(async (file) => {
    await assert.rejects(asDate(file, 'select * from flags', 'b', ['v']), /"b" \(BOOLEAN\) cannot be read as dates/);
    await assert.rejects(asDate(file, 'select * from iso', 'absent', ['v']));
    await assert.rejects(asDate(file, 'select * from iso', 'v', ['v']), /cannot also be the plotted series/);
  }));

test('the explicit date choice honours the query: filter, sort and LIMIT', () =>
  withFile(async (file) => {
    const r = await asDate(file, 'select * from iso order by v desc limit 2', 'opened_at', ['v']);
    assert.deepEqual(r.rows.map((x) => Number(x[1])), [2, 3]);
    // A column name with a quote cannot break out of the generated SQL.
    const odd = await row(file, 'select * from "we""ird"', ['v']);
    assert.equal(odd.rows.length, 1);
  }));

test('a CSV column with a bad date is refused and the CSV is not touched', () =>
  withFile(async (file) => {
    await assert.rejects(asDate(file, 'select * from ledger', 'booked', ['amount']), /1 of 3 values in "booked"/);
    // Row numbers remain available as the way to see the same data.
    const r = await row(file, 'select * from ledger', ['amount']);
    assert.equal(r.rows.length, 3);
  }, csvPath));

// ------------------------------------------------------- the host message

test('the editor host routes the axis choice through a chartQuery and renames nothing', async () => {
  resetVscodeStub();
  const file = await DuckDbFile.open(dbPath);
  const posted: any[] = [];
  const stub = vscodeStub as any;
  const originalCreate = stub.window.createWebviewPanel;
  stub.window.createWebviewPanel = () => {
    let ready: ((m: unknown) => void) | undefined;
    const panel = {
      title: '',
      viewColumn: 1,
      reveal: () => undefined,
      onDidDispose: () => ({ dispose() {} }),
      dispose: () => undefined,
      webview: {
        html: '',
        cspSource: '',
        asWebviewUri: (uri: unknown) => uri,
        onDidReceiveMessage: (h: (m: unknown) => void) => { ready = h; return { dispose() {} }; },
        postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); },
      },
    };
    queueMicrotask(() => ready?.({ command: 'ready' }));
    return panel;
  };
  try {
    const document = new DuckDBDocument(vscodeStub.Uri.file(dbPath) as any, file);
    const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any);
    let receive!: (m: any) => Promise<void>;
    const messages: any[] = [];
    await provider.resolveCustomEditor(document, {
      webview: {
        asWebviewUri: (u: unknown) => u,
        postMessage: (m: unknown) => { messages.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (h: typeof receive) => { receive = h; return { dispose() {} }; },
      },
      onDidDispose() {},
    } as any);
    const send = async (m: any) => {
      await receive(m);
      await document.runExclusive(async () => undefined);
      await new Promise((r) => setImmediate(r));
    };

    await send({ command: 'runQuery', sql: 'select * from collide' });
    await send({ command: 'chartQuery', xColumn: 'Row', xIsText: false, xIsRow: true, yColumns: ['ROW'] });
    const rowChart = posted.at(-1);
    assert.equal(rowChart.command, 'chart', JSON.stringify(rowChart));
    assert.equal(rowChart.xColumn, 'Row (2)', 'the chart is told the name the host actually used');
    assert.deepEqual(rowChart.columns, ['Row (2)', 'ROW']);

    await send({ command: 'runQuery', sql: 'select * from iso' });
    await send({ command: 'chartQuery', xColumn: 'opened_at', xDateColumn: 'opened_at', xIsText: false, yColumns: ['v'] });
    const dateChart = posted.at(-1);
    assert.equal(dateChart.command, 'chart', JSON.stringify(dateChart));
    assert.equal(dateChart.xAxisMode, 'time');
    assert.equal(dateChart.xColumn, 'opened_at');

    await send({ command: 'runQuery', sql: 'select * from ambiguous' });
    await send({ command: 'chartQuery', xColumn: 'd', xDateColumn: 'd', xIsText: false, yColumns: ['v'] });
    const refused = posted.at(-1);
    assert.equal(refused.command, 'chartError');
    assert.match(refused.message, /2 of 3 values in "d"/);
  } finally {
    stub.window.createWebviewPanel = originalCreate;
    file.dispose();
  }
});
