// D3.18 NativeDocument: the 8 routed reads against the real dfv-table binary, and the whole operation surface
// (14 further reads, both writes, reconciliation) against a scripted engine. Build the worker with:
//   cargo build -p dfv-table --features test-doc   (CARGO_TARGET_DIR=native/target-adapter, or set DFV_TABLE_WORKER)
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeError } from '../src/backend/native';
import { NativeDocument, nativeBackend } from '../src/backend/nativeDocument';
import { NATIVE_OPERATIONS, NativeUnsupportedError, isUnsupported, nativeCoverage } from '../src/backend/nativeOperations';
import { READ_METHODS } from '../src/queryProtocol';
import { referenceBackend } from '../src/backend/reference';
import { DuckDBInstance } from '@duckdb/node-api';
import { nativeWorkerPath, selectBackend } from '../src/backend/nativeSelect';

const root = path.resolve(__dirname, '..', '..');
const worker = process.env.DFV_TABLE_WORKER ?? path.join(root, 'native', 'target-adapter', 'debug', 'dfv-table');
const fake = path.join(root, 'test', 'fakeNativeWorker.cjs');
const real = { skip: fs.existsSync(worker) ? false : `worker not built: ${worker}` };
const scripted = (env: NodeJS.ProcessEnv = {}) => ({ executable: process.execPath, args: [fake, 'engine'], env });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'native-document-'));

test('the inventory is the 22 reads plus 2 writes and coverage splits it by what the worker advertises', () => {
  assert.equal(READ_METHODS.length, 22);
  assert.deepEqual([...NATIVE_OPERATIONS].sort(), [...READ_METHODS, 'createBackup', 'updateCell'].sort());
  const { routed, unsupported } = nativeCoverage(['ping', 'runQuery', 'open']);
  assert.deepEqual(routed, ['runQuery']);
  assert.equal(unsupported.length, 23);
  assert.ok(!unsupported.includes('runQuery'));
});

test('real worker: routed reads return exact values and every unrouted operation fails typed', real, async () => {
  const dir = tmp(), file = path.join(dir, 'rows.csv'), source = 'id,name\n1,alpha\n2,beta\n3,gamma\n';
  fs.writeFileSync(file, source);
  const doc = await NativeDocument.open({ executable: worker }, file);
  try {
    const { routed, unsupported } = nativeCoverage((doc as any).client.capabilities.methods);
    for (const method of ['countMatchingRows', 'getColumnDescriptiveStats', 'getColumnTopValues', 'getQueryCatalog', 'getQueryColumns', 'runChartQuery', 'runQuery', 'runSortedQuery']) assert.ok(routed.includes(method), method);
    assert.equal(routed.length + unsupported.length, NATIVE_OPERATIONS.length);
    assert.equal(doc.fileKind, 'csv');
    const [relation] = await doc.getQueryCatalog();
    assert.equal(relation.name, 'rows');
    assert.deepEqual(await doc.getQueryColumns(relation.catalog, relation.schema, relation.name), [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }]);
    const q = await doc.runQuery('select id, name, 9007199254740993::BIGINT as exact, 12345678901234567890.1234::DECIMAL(24,4) as dec from rows order by id');
    assert.deepEqual(q.rows[0], ['1', 'alpha', '9007199254740993', '12345678901234567890.1234']);
    assert.deepEqual(q.columnStatsKind, ['numeric', 'other', 'numeric', 'numeric']);
    const sorted = await doc.runSortedQuery('select * from rows', 'id', 'desc', 2);
    assert.deepEqual(sorted.rows.map(r => r[1]), ['gamma', 'beta']);
    assert.match(sorted.sortedSql, /order by/i);
    assert.equal(await doc.countMatchingRows('select * from rows limit 1'), 3);
    assert.equal(await doc.countMatchingRows('select * from nothing_here'), undefined); // a count is a nicety
    const chart = await doc.runChartQuery('select * from rows', 'id', ['id'], false, 0, false);
    assert.equal(chart.xAxisMode, 'time'); assert.equal(chart.rows.length, 3);
    const top = await doc.getColumnTopValues('select 9007199254740993::bigint as exact from rows', 'exact');
    assert.deepEqual(top, { totalRows: 3, nonNullRows: 3, nullCount: 0, distinctCount: 1, topValues: [{ value: '9007199254740993', frequency: 3 }] });
    const stats = await doc.getColumnDescriptiveStats('select * from rows', 'id', 'numeric');
    assert.equal(stats.totalRows, 3); assert.equal(stats.min, '1'); assert.equal(stats.max, '3');
    // Not routed by this worker: typed, enumerable, and never a made-up answer.
    const unrouted: Record<string, unknown[]> = { buildCombinedQuery: ['t'], buildDetectedTableQuery: ['t'], runDetectedTableQuery: ['t'], compareToBackup: [], diffQueryAgainstBackup: ['x', [], []],
      locateXlsxEdit: ['t', 'c', {}], createBackup: [], updateCell: ['t', 'c', 1, {}] };
    for (const [op, args] of Object.entries(unrouted)) {
      if (routed.includes(op)) continue; // routed methods have their own result/refusal contracts in the strict engine gate
      const e = await (doc as any)[op](...args).then(() => assert.fail(op), (x: unknown) => x);
      assert.ok(isUnsupported(e) && e instanceof NativeUnsupportedError && e.code === 'unsupported' && e.operation === op, `${op}: ${e}`);
    }
    assert.equal(await doc.retrySheetPreparation('rows'), undefined); // not a worksheet: nothing to retry
    assert.equal(await doc.checkEditableSelect('select 1').then(r => r.editable), false); // a constant SELECT edits no source table
    assert.equal(await doc.getPollCadenceSeconds('rows'), null);
    assert.deepEqual(await doc.listSiblingTables(), []);
    assert.deepEqual(await doc.listTables(), ['rows']);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real worker: a cancelled read and a closed document settle typed, and the worker stays usable', real, async () => {
  const dir = tmp(), file = path.join(dir, 'rows.csv');
  fs.writeFileSync(file, 'id\n1\n');
  const doc = await NativeDocument.open({ executable: worker }, file);
  try {
    const long = doc.runQuery('select sum(a.range * b.range) from range(100000) a, range(100000) b');
    setTimeout(() => doc.interruptCurrentQuery(), 50);
    await assert.rejects(long, (e: unknown) => e instanceof NativeError && e.code === 'cancelled');
    assert.equal((await doc.runQuery('select id from rows')).rows.length, 1);
  } finally { await doc.close(); }
  await assert.rejects(doc.runQuery('select 1'), (e: unknown) => e instanceof NativeError && e.code === 'not_open');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real worker: catalog hints, row/date chart flags and stale source boundaries reach the native engine', real, async () => {
  const dir = tmp(), file = path.join(dir, 'fixture.duckdb');
  const instance = await DuckDBInstance.create(file), connection = await instance.connect();
  try {
    await connection.run("create table t(id integer, observed varchar, value integer); insert into t values (1,'2024-01-03',30),(2,null,null),(3,'2024-01-01',10)");
    await connection.run("create table sheet_metadata(table_name varchar, extra_json varchar, frequency varchar); insert into sheet_metadata values ('t','{\"live_poll_seconds\":2.5}','monthly')");
  } finally { connection.closeSync(); instance.closeSync(); }
  const before = fs.readFileSync(file);
  const doc = await NativeDocument.open({ executable: worker }, file);
  try {
    assert.deepEqual(await doc.listTables(), ['sheet_metadata', 't']);
    assert.deepEqual(await doc.listSidebarTables(), ['sheet_metadata', 't']);
    assert.deepEqual(await doc.listSiblingTables(), []);
    assert.deepEqual(await doc.getCombinableTableNames(), []);
    await assert.rejects(doc.buildCombinedQuery('t'), (e: any) => e.code === 'unsupported');
    assert.equal(await doc.getPollCadenceSeconds('t'), 2.5);
    assert.equal(await doc.getSeriesFrequency('t'), 'monthly');
    assert.deepEqual((await doc.runQuery("select date 'infinity' as d, timestamp '-infinity' as ts, timestamptz 'infinity' as tz")).rows, [['infinity', '-infinity', 'infinity']]);
    const row = await doc.runChartQuery('select * from t order by id desc limit 2', 'Row', ['value'], false, 0, false, true);
    assert.equal(row.xAxisMode, 'category');
    assert.deepEqual(row.rows, [[1, 10], [2, null]]);
    const dated = await doc.runChartQuery('select * from t', 'observed', ['value'], false, 0, false, false, true);
    assert.equal(dated.xAxisMode, 'time');
    assert.equal(dated.note, '1 row with no date left out');
    assert.deepEqual(dated.rows.map(r => r[1]), [10, 30]);
    assert.deepEqual(fs.readFileSync(file), before);
    fs.renameSync(file, file + '.old');
    fs.copyFileSync(file + '.old', file);
    await assert.rejects(doc.runQuery('select * from t'), (e: any) => e.code === 'stale_source');
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real worker: nested Parquet values reach document rows with exact leaves and no source changes', real, async () => {
  const dir = tmp(), file = path.join(dir, 'nested.parquet');
  fs.copyFileSync(path.join(root, 'native/crates/duckdb-query/tests/fixtures/parquet/nested.parquet'), file);
  const before = fs.readFileSync(file);
  const doc = await NativeDocument.open({ executable: worker }, file, undefined, { forceReadOnly: true });
  try {
    assert.deepEqual((await doc.runQuery('select lst, lst_null_item, st, mp, ld from nested')).rows, [
      [[1, 2, 3], ['1', null], { a: '1', b: 'x' }, [{ key: 'k', value: 1 }], ['1.50', null]],
      [[], null, { a: null, b: null }, [], null],
      [null, [null], null, null, []],
    ]);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real worker: backup, consecutive guarded CSV saves and reopen preserve the intended cells', real, async () => {
  const dir = tmp(), file = path.join(dir, 'rows.csv'), state = path.join(dir, 'state');
  const original = 'id,name\n1,alpha\n2,beta\n';
  fs.writeFileSync(file, original);
  const start = { executable: worker, env: { DFV_TABLE_STATE_DIR: state } };
  const doc = await NativeDocument.open(start, file);
  let reopened: NativeDocument | undefined;
  try {
    assert.equal(doc.isReadOnly(), false);
    const backup = await doc.createBackup();
    assert.equal(fs.readFileSync(backup, 'utf8'), original);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(await doc.updateCell('rows', 'name', 'changed', { id: '1', name: 'alpha' }), 1);
    assert.deepEqual((await doc.runQuery('select * from rows order by id')).rows, [['1', 'changed'], ['2', 'beta']]);
    assert.equal(await doc.updateCell('rows', 'name', 'second', { id: '2', name: 'beta' }), 1);
    assert.equal(fs.readFileSync(backup, 'utf8'), original);
    await doc.close();
    reopened = await NativeDocument.open(start, file);
    assert.deepEqual((await reopened.runQuery('select * from rows order by id')).rows, [['1', 'changed'], ['2', 'second']]);
    const instance = await DuckDBInstance.create(':memory:'), connection = await instance.connect();
    try {
      const literal = file.replace(/'/g, "''");
      const independent = await connection.runAndReadAll(`select name from read_csv_auto('${literal}') order by id`);
      assert.deepEqual(independent.getRowsJson(), [['changed'], ['second']]);
    } finally { connection.closeSync(); instance.closeSync(); }
  } finally { await doc.close(); await reopened?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real worker: remembered backup survives reopen and rejects altered or foreign proof', real, async () => {
  const dir = tmp(), file = path.join(dir, 'rows.csv'), state = path.join(dir, 'state');
  fs.writeFileSync(file, 'id,name\n1,alpha\n2,beta\n');
  const start = { executable: worker, env: { DFV_TABLE_STATE_DIR: state } };
  const writer = await NativeDocument.open(start, file);
  let reader: NativeDocument | undefined;
  try {
    const backup = await writer.createBackup();
    const original = fs.readFileSync(backup);
    await writer.updateCell('rows', 'name', 'changed', { id: '1', name: 'alpha' });
    await writer.close();
    const live = fs.readFileSync(file);
    reader = await NativeDocument.open(start, file, undefined, { backupPath: backup, forceReadOnly: true });
    assert.deepEqual(await reader.compareToBackup(), { rows: 'changed' });
    const query = await reader.runQuery('select * from rows order by id');
    assert.deepEqual((await reader.diffQueryAgainstBackup('select * from rows order by id', query.columns, query.rows))?.cellChanged,
      [[false, true], [false, false]]);
    await reader.close();
    const records = path.join(state, 'mutations');
    const receiptFile = fs.readdirSync(records).map(name => path.join(records, name))
      .find(p => JSON.parse(fs.readFileSync(p, 'utf8')).receipt?.operation === 'createBackup')!;
    const recordBytes = fs.readFileSync(receiptFile), record = JSON.parse(recordBytes.toString());
    const publicationFile = path.join(state, 'publication', `${record.receipt_id}.json`);
    const publicationBytes = fs.readFileSync(publicationFile);
    const reject = async (backupPath = backup) => {
      await assert.rejects(NativeDocument.open(start, file, undefined, { backupPath }),
        (e: unknown) => e instanceof NativeError && ['stale_source', 'policy_refused'].includes(e.code));
      assert.deepEqual(fs.readFileSync(file), live);
    };
    fs.writeFileSync(backup, 'id,name\n1,tampered\n2,beta\n'); await reject(); fs.writeFileSync(backup, original);
    fs.renameSync(backup, `${backup}.held`); await reject(); fs.renameSync(`${backup}.held`, backup);
    fs.writeFileSync(publicationFile, '{}'); await reject(); fs.writeFileSync(publicationFile, publicationBytes);
    fs.renameSync(publicationFile, `${publicationFile}.held`); await reject(); fs.renameSync(`${publicationFile}.held`, publicationFile);
    fs.writeFileSync(receiptFile, '{}'); await reject(); fs.writeFileSync(receiptFile, recordBytes);
    fs.renameSync(receiptFile, `${receiptFile}.held`); await reject(); fs.renameSync(`${receiptFile}.held`, receiptFile);
    const duplicate = path.join(records, 'mutation-11111111-1111-4111-8111-111111111111.json');
    fs.writeFileSync(duplicate, recordBytes); await reject(); fs.unlinkSync(duplicate);
    const link = path.join(dir, 'rows.backup-20260101-000000-12345678.csv');
    fs.symlinkSync(backup, link); await reject(link); fs.unlinkSync(link);
    const foreign = path.join(dir, 'other.csv'); fs.writeFileSync(foreign, live);
    await assert.rejects(NativeDocument.open(start, foreign, undefined, { backupPath: backup }),
      (e: unknown) => e instanceof NativeError && e.code === 'policy_refused');
    reader = await NativeDocument.open(start, file, undefined, { backupPath: backup });
    assert.deepEqual(await reader.compareToBackup(), { rows: 'changed' });
    assert.deepEqual(fs.readFileSync(backup), original);
    assert.deepEqual(fs.readFileSync(file), live);
  } finally { await writer.close(); await reader?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real worker: query diff preserves exact original types and detects changed display cells', real, async () => {
  const dir = tmp(), file = path.join(dir, 'types.duckdb'), state = path.join(dir, 'state');
  const instance = await DuckDBInstance.create(file), connection = await instance.connect();
  try { await connection.run(`create table typed as select 1::BIGINT as number, '1'::VARCHAR as text,
    9007199254740993::BIGINT as wide, 1.50::DECIMAL(18,2) as decimal, DATE '2024-01-01' as day,
    [1::BIGINT,NULL] as nested, NULL::VARCHAR as empty`); }
  finally { connection.closeSync(); instance.closeSync(); }
  const start = { executable: worker, env: { DFV_TABLE_STATE_DIR: state } };
  const writer = await NativeDocument.open(start, file);
  let reader: NativeDocument | undefined;
  try {
    const backup = await writer.createBackup(); await writer.close();
    reader = await NativeDocument.open(start, file, undefined, { backupPath: backup });
    const sql = 'select * from typed', result = await reader.runQuery(sql);
    assert.equal(result.rows[0][0], '1'); assert.equal(result.rows[0][1], '1');
    assert.equal(result.rows[0][2], '9007199254740993');
    assert.deepEqual((await reader.diffQueryAgainstBackup(sql, result.columns, result.rows))?.cellChanged,
      [[false, false, false, false, false, false, false]]);
    result.rows[0][0] = 2n;
    result.rows[0][1] = 1n; // Same displayed text still changes VARCHAR into a typed integer.
    assert.deepEqual((await reader.diffQueryAgainstBackup(sql, result.columns, result.rows))?.cellChanged,
      [[true, true, false, false, false, false, false]]);
    const changed = await reader.runQuery(sql);
    changed.rows[0][0] = 'changed';
    assert.deepEqual((await reader.diffQueryAgainstBackup(sql, changed.columns, changed.rows))?.cellChanged,
      [[true, false, false, false, false, false, false]]);
  } finally { await writer.close(); await reader?.close(); fs.rmSync(dir, {recursive:true,force:true}); }
});

test('real worker: ambiguous schema names refuse edits and unique main edits preserve other schemas', real, async () => {
  const dir = tmp(), file = path.join(dir, 'schemas.duckdb'), state = path.join(dir, 'state');
  const instance = await DuckDBInstance.create(file), connection = await instance.connect();
  try { await connection.run(`create schema other; create table data(id BIGINT,value VARCHAR);
    insert into data values(1,'main'); create table other.data(id BIGINT,value VARCHAR);
    insert into other.data values(1,'other'); create table unique_main(id BIGINT,value VARCHAR);
    insert into unique_main values(1,'old'); create table other.neighbor(id BIGINT,value VARCHAR);
    insert into other.neighbor values(2,'untouched')`); }
  finally { connection.closeSync(); instance.closeSync(); }
  const doc = await NativeDocument.open({ executable: worker, env:{DFV_TABLE_STATE_DIR:state} }, file);
  try {
    const original = fs.readFileSync(file);
    assert.equal((await doc.checkEditableSelect('select * from data')).editable, false);
    await assert.rejects(doc.updateCell('data', 'value', 'wrong', {id:1n,value:'main'}),
      (e:unknown) => e instanceof NativeError && e.code === 'malformed_value' && e.mutationOutcome === 'not-published');
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual((await doc.runQuery('select * from main.data')).rows, [['1','main']]);
    assert.deepEqual((await doc.runQuery('select * from other.data')).rows, [['1','other']]);
    assert.equal(await doc.updateCell('unique_main', 'value', 'changed', {id:1n,value:'old'}), 1);
    assert.deepEqual((await doc.runQuery('select * from unique_main')).rows, [['1','changed']]);
    assert.deepEqual((await doc.runQuery('select * from main.data')).rows, [['1','main']]);
    assert.deepEqual((await doc.runQuery('select * from other.data')).rows, [['1','other']]);
    assert.deepEqual((await doc.runQuery('select * from other.neighbor')).rows, [['2','untouched']]);
  } finally { await doc.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('scripted engine: all 22 reads route, decode exactly, and pass the row-number axis through', async () => {
  const doc = await NativeDocument.open(scripted(), '/data/book.xlsx');
  try {
    const { unsupported } = nativeCoverage((doc as any).client.capabilities.methods);
    assert.deepEqual(unsupported, []);
    assert.equal(doc.fileKind, 'xlsx'); assert.equal(doc.hasSibling(), true); assert.equal(doc.isWorksheet('Sheet1'), true);
    assert.deepEqual(doc.getDetectedSheetTables('Sheet1').map(t => [t.name, t.rowCount, t.dataRows, t.columnStatsKind]), [['T1', 2, [{ start: 1, end: 3 }], ['numeric', 'other']]]);
    const catalog = await doc.getQueryCatalog();
    assert.equal(catalog[0].worksheet, 'Sheet1');
    assert.deepEqual(catalog[1], { catalog: 'c', schema: 's', name: 'T1', sqlName: '"T1"', worksheet: 'Sheet1', rawWorksheet: false, prepared: true, range: 'A1:B3', bounds: { top: 0, bottom: 3, left: 0, right: 2 } });
    assert.equal(doc.getSheetPreparation('Sheet1')?.state, 'ready');
    assert.deepEqual([await doc.listTables(), await doc.listSidebarTables(), await doc.listSiblingTables(), await doc.getCombinableTableNames()], [['listTables'], ['listSidebarTables'], ['listSiblingTables'], ['getCombinableTableNames']]);
    assert.deepEqual(await doc.buildCombinedQuery('T1', 5), { sql: 'select 1 /*5*/', timeColumn: null });
    assert.equal(await doc.getPollCadenceSeconds('T1'), 60);
    assert.equal(await doc.getSeriesFrequency('T1'), 'monthly');
    assert.match(await doc.buildDetectedTableQuery('T1', [{ column: 'id', operator: 'between', value: '1', valueTo: '2' }], undefined, 10), /"value_to":"2"\}\]10/);
    const detected = await doc.runDetectedTableQuery('T1');
    assert.equal(detected.sql, 'select * from T1'); assert.equal(detected.totalRows, 7); assert.equal(detected.rows[0][0], '9007199254740993');
    const chart: any = await doc.runChartQuery('select 1', 'x', ['y'], false, 0, false, true); // xIsRow
    assert.equal(chart.xAxisMode, 'category');
    assert.equal((await doc.runChartQuery('select 1', 'x', ['y'], false, 0, false, false, true)).note, '1 row with no date left out');
    assert.equal((await doc.runChartQuery('select 1', 'x', ['y'])).xAxisMode, 'time');
    assert.deepEqual(await doc.checkEditableSelect('select 1'), { editable: true, table: 'T1', columns: ['id', 'name'] });
    assert.deepEqual((await doc.getColumnDescriptiveStats('select 1', 'id', 'numeric')).max, '9007199254740993');
    assert.deepEqual(await doc.compareToBackup(), { T1: 'changed' });
    assert.deepEqual(await doc.diffQueryAgainstBackup('x', ['id'], [[1]]), { cellChanged: [[true]], rowIsNew: [false], renamedColumns: {} });
    assert.equal(await doc.diffQueryAgainstBackup('same', ['id'], []), null);
    assert.deepEqual(await doc.locateXlsxEdit('T1', 'id', { id: 1 }), { target: { sheetPath: 'xl/worksheets/sheet1.xml', columnNames: ['id'], rowOrdinal: 3, columnName: 'id' }, sha256: 'a'.repeat(64) });
    assert.equal((await doc.retrySheetPreparation('Sheet1'))?.generation, 1);
    assert.equal(await doc.countMatchingRows('select 1'), 7);
    assert.equal(await doc.countMatchingRows('none'), undefined);
    assert.equal(await doc.createBackup(), '/tmp/x.bak');
    const notices: string[] = []; doc.onSaveNotice = n => notices.push(n);
    assert.equal(await doc.updateCell('T1', 'id', 5, { id: 1 }), 1);
    assert.deepEqual(notices, ['saved']);
  } finally { await doc.close(); }
});

test('cadence accepts positive fractional JSON numbers and null, rejecting malformed hints', async () => {
  for (const seconds of [0.25, 2.5, 60, null, 0, -1, '60', {}, []]) {
    const doc = await NativeDocument.open(scripted({ DFV_FAKE_SECONDS: JSON.stringify(seconds) }), '/data/book.xlsx');
    try {
      if (seconds === null || typeof seconds === 'number' && seconds > 0) assert.equal(await doc.getPollCadenceSeconds('T1'), seconds);
      else await assert.rejects(doc.getPollCadenceSeconds('T1'), (e: any) => e.code === 'malformed_value');
    } finally { await doc.close(); }
  }
});

test('updates turn worker Safe Mode off before mutation and carry the current exact source revision', async () => {
  const dir = tmp(), wire = path.join(dir, 'wire.jsonl');
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_WIRE: wire, DFV_FAKE_CHECK_REVISION: '1' }), '/data/book.xlsx');
  try {
    await doc.createBackup();
    await doc.updateCell('T1', 'id', 5, { id: 1 });
    await doc.updateCell('T1', 'id', 6, { id: 5 });
    const frames = fs.readFileSync(wire, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(f => ['createBackup', 'setSafeMode', 'updateCell'].includes(f.method));
    assert.deepEqual(frames.map(f => [f.method, f.args.expected_revision]), [['createBackup', '1'], ['setSafeMode', '1'], ['updateCell', '1'], ['setSafeMode', '2'], ['updateCell', '2']]);
    assert.equal(frames[1].args.enabled, false);
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed worker Safe Mode transition never sends an update', async () => {
  const dir = tmp(), wire = path.join(dir, 'wire.jsonl');
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_WIRE: wire, DFV_FAKE_SAFE_REFUSE: '1' }), '/data/book.xlsx');
  try {
    await assert.rejects(doc.updateCell('T1', 'id', 5, { id: 1 }), (e: any) => e.code === 'policy_refused' && e.mutationOutcome === 'not-published');
    assert.ok(!fs.readFileSync(wire, 'utf8').includes('"method":"updateCell"'));
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worksheet edit locations reject malformed or inexact row ordinals', async () => {
  for (const row of ['-1', '01', '9007199254740993']) {
    const doc = await NativeDocument.open(scripted({ DFV_FAKE_ROW_ORDINAL: row }), '/data/book.xlsx');
    try { await assert.rejects(doc.locateXlsxEdit('T1', 'id', { id: 1 }), (e: any) => e.code === 'malformed_value'); }
    finally { await doc.close(); }
  }
});

test('a source generation change between result pages refuses the entire result and releases its handle', async () => {
  const dir = tmp(), wire = path.join(dir, 'wire.jsonl');
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_WIRE: wire, DFV_FAKE_PAGE_DRIFT: '1' }), '/data/book.xlsx');
  try {
    await assert.rejects(doc.runQuery('select * from T1'), (e: any) => e.code === 'malformed_value');
    const frames = fs.readFileSync(wire, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(frames.filter(f => f.method === 'releaseResource' && f.args.resource === 'r1').length, 1);
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Every operation the viewer can ask for, with arguments that reach the wire (xlsx scripted open: writable, worksheet Sheet1, has a sibling).
const EVERY_OPERATION: Record<string, (d: NativeDocument) => Promise<unknown>> = {
  listTables: d => d.listTables(), listSidebarTables: d => d.listSidebarTables(), listSiblingTables: d => d.listSiblingTables(), getCombinableTableNames: d => d.getCombinableTableNames(),
  buildCombinedQuery: d => d.buildCombinedQuery('T1', 5), getPollCadenceSeconds: d => d.getPollCadenceSeconds('T1'), getSeriesFrequency: d => d.getSeriesFrequency('T1'),
  buildDetectedTableQuery: d => d.buildDetectedTableQuery('T1', []), runDetectedTableQuery: d => d.runDetectedTableQuery('T1'),
  runQuery: d => d.runQuery('select 1'), runChartQuery: d => d.runChartQuery('select 1', 'x', ['y']), runSortedQuery: d => d.runSortedQuery('select 1', 'x', 'asc', 5),
  countMatchingRows: d => d.countMatchingRows('select 1'), checkEditableSelect: d => d.checkEditableSelect('select 1'),
  getColumnTopValues: d => d.getColumnTopValues('select 1', 'id'), getColumnDescriptiveStats: d => d.getColumnDescriptiveStats('select 1', 'id', 'numeric'),
  compareToBackup: d => d.compareToBackup(), diffQueryAgainstBackup: d => d.diffQueryAgainstBackup('x', ['id'], [[1]]),
  getQueryCatalog: d => d.getQueryCatalog(), getQueryColumns: d => d.getQueryColumns('c', 's', 'Sheet1'),
  locateXlsxEdit: d => d.locateXlsxEdit('T1', 'id', { id: 1 }), retrySheetPreparation: d => d.retrySheetPreparation('Sheet1'),
  createBackup: d => d.createBackup(), updateCell: d => d.updateCell('T1', 'id', 5, { id: 1 }),
};

test('scripted engine: every operation has a call here, and a worker that refuses each one surfaces its typed refusal', async () => {
  assert.deepEqual(Object.keys(EVERY_OPERATION).sort(), [...NATIVE_OPERATIONS].sort());
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_REFUSE: '1' }), '/data/book.xlsx');
  try {
    for (const [op, run] of Object.entries(EVERY_OPERATION)) {
      const outcome = await run(doc).then(v => ({ v }), (e: unknown) => ({ e }));
      if (op === 'countMatchingRows') { assert.deepEqual(outcome, { v: undefined }, op); continue; } // a count is a nicety: the rows must not be lost with it
      const e: any = (outcome as any).e;
      assert.ok(e instanceof NativeError && e.code === 'refused_by_test' && e.category === 'blocked' && !isUnsupported(e), `${op}: ${(outcome as any).v ?? e}`);
      if (op === 'updateCell' || op === 'createBackup') assert.equal(e.mutationOutcome, 'not-published', op);
    }
  } finally { await doc.close(); }
});

test('scripted engine: a worker that advertises no operation refuses each one as unsupported', async () => {
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_METHODS: 'open,close' }), '/data/book.xlsx');
  try {
    assert.deepEqual(nativeCoverage((doc as any).client.capabilities.methods).routed, []);
    for (const [op, run] of Object.entries(EVERY_OPERATION)) {
      if (['listTables', 'listSidebarTables'].includes(op)) { await assert.rejects(run(doc), (e: any) => e.code === 'unsupported' && e.operation === 'getQueryCatalog', op); continue; } // derived from the catalog, which is also unrouted
      const e: any = await run(doc).then(() => assert.fail(op), x => x);
      assert.ok(isUnsupported(e) && e.operation === op, `${op}: ${e}`);
    }
  } finally { await doc.close(); }
});

test('scripted engine: every request names its session (or resource handle) and sends snake_case arguments only', async () => {
  const dir = tmp(), wire = path.join(dir, 'wire.jsonl');
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_WIRE: wire }), '/data/book.xlsx');
  try {
    for (const run of Object.values(EVERY_OPERATION)) await run(doc);
  } finally { await doc.close(); }
  const frames = fs.readFileSync(wire, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(f => f.method !== 'open' && f.method !== 'close');
  assert.ok(new Set(frames.map(f => f.method)).size >= 24, 'every operation reached the wire');
  for (const f of frames) {
    if (f.method === 'readResource' || f.method === 'releaseResource') assert.ok(f.args.resource, f.method); // a resource handle already names its session
    else assert.match(f.args.session ?? '', /^s\d+$/, f.method);
    for (const key of Object.keys(f.args)) assert.match(key, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${f.method}.${key}`);
    if (f.method === 'updateCell' || f.method === 'createBackup') assert.match(f.args.mutation_id, /^[0-9a-f-]{36}$/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scripted engine: a write whose worker dies is reconciled by id, sent exactly once', async () => {
  for (const [mode, expect] of [['publish-then-die', 'published'], ['die-first', 'not-published']] as const) {
    const dir = tmp(), state = path.join(dir, 'journal');
    const doc = await NativeDocument.open(scripted({ DFV_FAKE_STATE: state, DFV_FAKE_UPDATE: mode }), '/data/book.xlsx');
    try {
      const result = doc.updateCell('T1', 'id', 5, { id: 1 });
      if (expect === 'published') {
        assert.equal(await result, 1);
      } else {
        const e: any = await result.then(() => assert.fail('expected a refusal'), x => x);
        assert.equal(e.code, 'mutation_not_published'); assert.equal(e.mutationOutcome, 'not-published');
      }
      assert.equal(fs.readFileSync(state, 'utf8').split('\n').filter(l => l.startsWith('send ')).length, 1, 'the write was never resubmitted');
    } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('scripted engine: with no way to ask about the outcome, the write stays unconfirmed and is not retried', async () => {
  const dir = tmp(), state = path.join(dir, 'journal');
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_STATE: state, DFV_FAKE_UPDATE: 'publish-then-die', DFV_FAKE_NO_OUTCOME: '1' }), '/data/book.xlsx');
  try {
    const e: any = await doc.updateCell('T1', 'id', 5, { id: 1 }).then(() => assert.fail('expected a refusal'), x => x);
    assert.equal(e.mutationOutcome, 'unknown');
    assert.equal(fs.readFileSync(state, 'utf8').split('\n').filter(l => l.startsWith('send ')).length, 1);
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restart reconciliation retains the newly opened session revision for the next write', async () => {
  const dir = tmp(), state = path.join(dir, 'journal');
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_STATE: state, DFV_FAKE_UPDATE: 'publish-then-die', DFV_FAKE_CHECK_REVISION: '1' }), '/data/book.xlsx');
  try {
    assert.equal(await doc.updateCell('T1', 'id', 5, { id: 1 }), 1);
    assert.equal(await doc.updateCell('T1', 'id', 6, { id: 5 }), 1);
    assert.equal(fs.readFileSync(state, 'utf8').split('\n').filter(l => l.startsWith('send ')).length, 2);
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed write receipt is reconciled by mutation id and never resubmitted', async () => {
  for (const noOutcome of [false, true]) {
    const dir = tmp(), state = path.join(dir, 'journal');
    const doc = await NativeDocument.open(scripted({ DFV_FAKE_STATE: state, DFV_FAKE_BAD_RECEIPT: '1', ...(noOutcome ? { DFV_FAKE_NO_OUTCOME: '1' } : {}) }), '/data/book.xlsx');
    try {
      const update = doc.updateCell('T1', 'id', 5, { id: 1 });
      if (noOutcome) await assert.rejects(update, (e: any) => e.mutationOutcome === 'unknown');
      else assert.equal(await update, 1);
      assert.equal(fs.readFileSync(state, 'utf8').split('\n').filter(l => l.startsWith('send ')).length, 1);
    } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('the general factory opens through the worker and refuses nothing by extension', async () => {
  const backend = nativeBackend(scripted());
  const doc = await backend.open('/data/book.xlsx');
  assert.equal(doc.fileKind, 'xlsx');
  await (doc as NativeDocument).close();
});

test('a forced read-only document never unlocks or sends mutations even when the worker offers writes', async () => {
  const dir = tmp(), wire = path.join(dir, 'wire.jsonl');
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_WIRE: wire }), '/data/book.xlsx', undefined, { forceReadOnly: true });
  try {
    assert.equal(doc.isReadOnly(), true);
    await assert.rejects(doc.updateCell('T1', 'id', 5, { id: 1 }), isUnsupported);
    await assert.rejects(doc.createBackup(), isUnsupported);
    const frames = fs.readFileSync(wire, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(frames[0].args.force_read_only, true);
    assert.ok(!frames.some(f => ['setSafeMode', 'updateCell', 'createBackup'].includes(f.method)));
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the host defaults to native and requires an explicit reference development override', () => {
  assert.notEqual(selectBackend('/ext', {}), referenceBackend);
  assert.equal(selectBackend('/ext', { DFV_BACKEND: 'reference' }), referenceBackend);
  assert.throws(() => selectBackend('/ext', { DFV_BACKEND: 'typo' }), /Unknown DFV_BACKEND/);
  assert.notEqual(selectBackend('/ext', { DFV_BACKEND: 'native' }), referenceBackend);
  assert.equal(nativeWorkerPath('/ext', {}), path.join('/ext', 'bin', process.platform === 'win32' ? 'dfv-table.exe' : 'dfv-table'));
  assert.equal(nativeWorkerPath('/ext', { DFV_TABLE_WORKER: '/built/dfv-table' }), '/built/dfv-table');
});


test('scripted engine: retry replaces derived tables and refreshes the whole preparation snapshot atomically', async () => {
  const doc = await NativeDocument.open(scripted(), '/data/book.xlsx');
  try {
    assert.equal(doc.getDetectedSheetTables('Sheet1')[0].name, 'T1');
    const status = await doc.retrySheetPreparation('Sheet1');
    assert.deepEqual(doc.getSheetPreparation('Sheet1'), status);
    assert.deepEqual(doc.getDetectedSheetTables('Sheet1').map(t => [t.name, t.columns, t.rowCount]), [['T2', ['new'], 3]]);
    assert.equal(doc.getDetectedSheetTables('Other')[0].name, 'Unchanged');
    assert.equal(doc.getSheetPreparation('Other')?.state, 'pending');
    assert.equal(doc.listSheetPreparation().length, 2);
    assert.equal(doc.hasPendingSheets(), true);
  } finally { await doc.close(); }
});

test('scripted engine: malformed retry leaves cached tables and statuses unchanged', async () => {
  const doc = await NativeDocument.open(scripted({ DFV_FAKE_BAD_RETRY: '1' }), '/data/book.xlsx');
  try {
    const before = [doc.getDetectedSheetTables('Sheet1'), doc.listSheetPreparation(), doc.hasPendingSheets()];
    await assert.rejects(doc.retrySheetPreparation('Sheet1'), (e: unknown) => e instanceof NativeError && e.code === 'malformed_value');
    assert.deepEqual([doc.getDetectedSheetTables('Sheet1'), doc.listSheetPreparation(), doc.hasPendingSheets()], before);
  } finally { await doc.close(); }
});


test('real worker: default 200k chart cap supports row/date axes while ordinary reads remain bounded', real, async () => {
  const dir = tmp(), source = path.join(dir, 'rows.csv');
  const bytes = 'id,name\n1,alpha\n2,beta\n3,gamma\n';
  fs.writeFileSync(source, bytes);
  const doc = await NativeDocument.open({ executable: worker }, source);
  try {
    const row = await doc.runChartQuery('select * from rows order by id desc', 'Row', ['id'], false, 200000, false, true);
    assert.equal(row.xAxisMode, 'category');
    assert.deepEqual(row.rows, [[1,'3'],[2,'2'],[3,'1']]);
    const date = await doc.runChartQuery("select '2024-01-01' as observed,id from rows", 'observed', ['id'], false, 200000, false, false, true);
    assert.equal(date.xAxisMode, 'time'); assert.equal(date.rows.length, 3);
    const zero = await doc.runChartQuery('select range as v from range(100001)', 'Row', ['v'], false, 0, false, true);
    assert.equal(zero.rows.length, 100001, 'zero uses the supported chart maximum, beyond ordinary read cap');
    assert.equal(zero.truncated, false);
    assert.deepEqual(zero.rows[0], [1,'0']); assert.deepEqual(zero.rows.at(-1), [100001,'100000']);
    await assert.rejects(doc.runChartQuery('select * from rows', 'Row', ['id'], false, 200001, false, true),
      (e: unknown) => e instanceof NativeError && e.code === 'resource_limit' && e.category === 'resource' && /200,000 points/.test(e.message));
    await assert.rejects(doc.runQuery('select * from rows', 100001),
      (e: unknown) => e instanceof NativeError && e.code === 'resource_limit');
    assert.equal(fs.readFileSync(source, 'utf8'), bytes);
  } finally { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
