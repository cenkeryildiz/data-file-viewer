// Executable V13 audit matrix: every promised read uses the actual Rust worker,
// checks a concrete result, and proves session/revision refusal. No reference backend.
import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTableClient, NativeError } from '../src/backend/native';
import { READ_METHODS } from '../src/queryProtocol';
import { duckdbFile, xlsxFile } from './stress/generators/_write';

type Method = typeof READ_METHODS[number];
type Obj = Record<string, any>;
type Fixture = 'csv' | 'pair' | 'xlsx';
interface Contract { fixture: Fixture; args: () => Obj; result: (value: Obj) => Promise<void> | void }
const binary = process.env.DFV_TABLE_WORKER;
const enabled = !!binary && fs.existsSync(binary);
let client: NativeTableClient, dir: string;
const sessions: Record<Fixture, string> = { csv: '', pair: '', xlsx: '' };
let detected: string, backup: string;
let prepared = false;
const immutable = new Map<string, Buffer>();
const query = 'select * from rows order by id';
const integer = (v: string) => ({ $t: 'int64', v });
const q = async (method: string, args: Obj): Promise<any> => {
  const result = await client.call(method, args) as Obj;
  const resource = result.resource ?? result.result?.resource;
  if (resource) await client.call('releaseResource', { resource: typeof resource === 'string' ? resource : resource.id });
  return result;
};
const rows = (result: Obj) => result.rows;
const check = (actual: unknown, expected: unknown) => assert.deepEqual(actual, expected);

// These keys are both the human-readable evidence matrix and a compile-time exhaustive inventory.
const contracts: Record<Method, Contract> = {
  listTables: { fixture:'csv', args:() => ({}), result:r => check(r.names, ['rows']) },
  listSidebarTables: { fixture:'csv', args:() => ({}), result:r => check(r.names, ['rows']) },
  listSiblingTables: { fixture:'pair', args:() => ({}), result:r => check(r.names, ['only_hot','sheet_metadata','t']) },
  getCombinableTableNames: { fixture:'pair', args:() => ({}), result:r => check(r.names, ['sheet_metadata','t']) },
  buildCombinedQuery: { fixture:'pair', args:() => ({table:'t'}), result:async r => {
    assert.equal(r.time_column, 'Datetime');
    const page = await q('runQuery', {session:sessions.pair,sql:r.sql});
    check(page.rows.map((row: any[]) => row[1]), [integer('1'),integer('2'),integer('3')]);
    check(page.rows.map((row: any[]) => row[2]), [false,false,true]);
  } },
  getPollCadenceSeconds: { fixture:'pair', args:() => ({table:'t'}), result:r => assert.equal(r.seconds, 30) },
  getSeriesFrequency: { fixture:'pair', args:() => ({table:'t'}), result:r => assert.equal(r.frequency, 'monthly') },
  buildDetectedTableQuery: { fixture:'xlsx', args:() => ({table:detected}), result:async r => {
    assert.equal(typeof r.sql, 'string');
    const page = await q('runQuery', {session:sessions.xlsx,sql:r.sql});
    assert.equal(page.rows.length, 2);
  } },
  runDetectedTableQuery: { fixture:'xlsx', args:() => ({table:detected}), result:r => {
    assert.equal(typeof r.sql, 'string'); assert.equal(r.rows.length, 2);
    check(r.rows[1], [{$t:'float64',v:'3'},{$t:'float64',v:'4'}]);
  } },
  runQuery: { fixture:'csv', args:() => ({sql:query}), result:r => check(rows(r), [[integer('1'),'changed'],[integer('2'),'beta']]) },
  runChartQuery: { fixture:'csv', args:() => ({sql:query,x_column:'name',y_columns:['id'],x_is_text:true}), result:r => {
    assert.equal(r.x_axis_mode, 'category'); check(r.result.rows.map((row: any[]) => row[0]), ['changed','beta']);
  } },
  runSortedQuery: { fixture:'csv', args:() => ({sql:query,column:'id',direction:'desc',max_rows:1}), result:r => check(r.rows, [[integer('2'),'beta']]) },
  countMatchingRows: { fixture:'csv', args:() => ({sql:'select * from rows limit 1'}), result:r => assert.equal(r.count, '2') },
  checkEditableSelect: { fixture:'csv', args:() => ({sql:'select * from rows'}), result:r => {
    assert.equal(r.editable, true); assert.equal(r.table, 'rows'); check(r.columns, ['id','name']);
  } },
  getColumnTopValues: { fixture:'csv', args:() => ({sql:query,column:'name',limit:20}), result:r => {
    assert.equal(r.total_rows, '2'); assert.equal(r.distinct_count, '2');
    check(r.top_values.map((v: Obj) => v.value).sort(), ['beta','changed']);
  } },
  getColumnDescriptiveStats: { fixture:'csv', args:() => ({sql:query,column:'id',stats_kind:'numeric'}), result:r => {
    assert.equal(r.total_rows, '2'); check(r.min,integer('1')); check(r.max,integer('2'));
  } },
  compareToBackup: { fixture:'csv', args:() => ({}), result:r => check(r.tables, {rows:'changed'}) },
  diffQueryAgainstBackup: { fixture:'csv', args:() => ({sql:query,live_columns:['id','name'],live_rows:[[integer('1'),'changed'],[integer('2'),'beta']]}), result:r => check(r.diff.cell_changed, [[false,true],[false,false]]) },
  getQueryCatalog: { fixture:'csv', args:() => ({offset:'0',len:100}), result:r => {
    assert.equal(r.relations.length,1); assert.equal(r.relations[0].name,'rows'); assert.equal(r.relations[0].schema,'main');
  } },
  getQueryColumns: { fixture:'csv', args:() => ({catalog:'memory',schema:'main',name:'rows'}), result:r => check(r.columns.map((c: Obj) => [c.name,c.source_type]), [['id','BIGINT'],['name','VARCHAR']]) },
  locateXlsxEdit: { fixture:'xlsx', args:() => ({table:detected,column:'v',row_values:{id:{$t:'float64',v:'3'},v:{$t:'float64',v:'4'}}}), result:r => {
    assert.equal(r.target.row_ordinal,3); assert.equal(r.target.column_name,'B'); assert.match(r.sha256,/^[0-9a-f]{64}$/);
  } },
  retrySheetPreparation: { fixture:'xlsx', args:() => ({sheet:'Data'}), result:r => {
    assert.equal(r.status.state,'ready'); assert.equal(r.status.generation,0); // Ready sheets are returned unchanged; SAFE-X1 separately proves fresh failed-sheet retry.
    assert.equal(r.detected_tables.length,1); assert.equal(r.has_pending_sheets,false);
  } },
};

before(async () => {
  if (!enabled) return;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dfv-native-operations-')));
  const csv = path.join(dir,'rows.csv'), workbook = path.join(dir,'book.xlsx');
  fs.writeFileSync(csv,'id,name\n1,alpha\n2,beta\n');
  await xlsxFile(workbook,[{name:'Data',rows:[['id','v'],[1,2],[3,4]]}]);
  const cold = path.join(dir,'cold.duckdb'), hot = path.join(dir,'hot.duckdb');
  for (const [file,hotSide] of [[cold,false],[hot,true]] as const) {
    await duckdbFile(file,[
      {name:'t',columns:[{name:'Datetime',type:'TIMESTAMP'},{name:'v',type:'BIGINT'}],rows:hotSide?[['2024-01-03',3]]:[['2024-01-01',1],['2024-01-02',2]]},
      {name:hotSide?'only_hot':'only_cold',columns:[{name:'a',type:'INTEGER'}],rows:[[1]]},
      {name:'sheet_metadata',columns:[{name:'table_name',type:'VARCHAR'},{name:'extra_json',type:'VARCHAR'},{name:'frequency',type:'VARCHAR'}],rows:[['t',JSON.stringify({live_poll_seconds:hotSide?2.5:30}),hotSide?'daily':' Monthly ']]},
    ]);
  }
  for (const file of [workbook,cold,hot]) immutable.set(file,fs.readFileSync(file));
  client = await NativeTableClient.start({executable:binary!,env:{...process.env,DFV_TABLE_STATE_DIR:path.join(dir,'state')}});
  for (const method of READ_METHODS) assert.ok(client.capabilities.methods.includes(method), `Unadvertised ${method}`);
  sessions.csv = (await q('open',{path:csv})).session;
  sessions.pair = (await q('open',{path:cold,sibling_path:hot})).session;
  const opened = await q('open',{path:workbook}); sessions.xlsx = opened.session;
  const preview = await q('runQuery',{session:opened.session,sql:'select * from Data',prepare_sheet:'Data'});
  detected = preview.workbook_metadata.detected_tables[0].name;
  const saved = await q('createBackup',{session:sessions.csv,mutation_id:'coverage-backup',expected_revision:'1'}); backup = saved.backup_path;
  await q('setSafeMode',{session:sessions.csv,enabled:false,expected_revision:'1'});
  const changed = await q('updateCell',{session:sessions.csv,mutation_id:'coverage-save',expected_revision:'1',table:'rows',column:'name',new_value:'changed',row_values:{id:integer('1'),name:'alpha'}});
  assert.equal(changed.rows_changed,'1');
  assert.equal((await q('checkEditableSelect',{session:sessions.csv,sql:'select id,name from rows'})).editable,false);
  assert.equal(fs.readFileSync(backup,'utf8'),'id,name\n1,alpha\n2,beta\n');
  prepared = true;
});
after(async () => {
  try {
    if (prepared) {
      for (const [file,bytes] of immutable) check(fs.readFileSync(file),bytes);
      assert.equal(fs.readFileSync(backup,'utf8'),'id,name\n1,alpha\n2,beta\n');
      assert.equal(fs.readFileSync(path.join(dir,'rows.csv'),'utf8'),'id,name\n1,changed\n2,beta\n');
    }
  } finally { await client?.close(); if(dir) fs.rmSync(dir,{recursive:true,force:true}); }
});

test('V13 audit matrix matches all promised read operations exactly', () => {
  check(Object.keys(contracts).sort(), [...READ_METHODS].sort());
});
for (const method of READ_METHODS) {
  test(`actual Rust operation ${method}: concrete result and typed refusal`, {skip:!enabled}, async () => {
    const contract = contracts[method], args = contract.args(), session = sessions[contract.fixture];
    await contract.result(await q(method,{...args,session}));
    for (const [extra,code] of [[{session:'s999999'},'not_open'],[{session},'stale_source']] as const) {
      const rejected = {...args,...extra,...(code === 'stale_source'?{expected_revision:'999'}:{})};
      await assert.rejects(client.call(method,rejected),(e: unknown) => e instanceof NativeError && e.code === code,`${method}: ${code}`);
    }
    const argument = Object.keys(args)[0];
    if (argument) await assert.rejects(client.call(method,{...args,session,[argument]:{invalid:true}}),
      (e: unknown) => e instanceof NativeError && e.code === 'malformed_value',`${method}: invalid argument`);
    await assert.rejects(client.call(method,args),(e: unknown) => e instanceof NativeError && e.code === 'malformed_value',`${method}: missing session`);
  });
}
