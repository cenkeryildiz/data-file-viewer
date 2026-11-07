// D3.18 native adapter: real dfv-table worker (read and test-doc engines) plus a scripted fake for the failures
// a healthy worker never produces. The worker is built with:
//   cargo build -p dfv-table --features test-doc   (CARGO_TARGET_DIR=native/target-adapter, or set DFV_TABLE_WORKER)
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTableClient, NativeError, decodeValue, decodeRows, isUnconfirmed } from '../src/backend/native';

const root = path.resolve(__dirname, '..', '..');
const worker = process.env.DFV_TABLE_WORKER ?? path.join(root, 'native', 'target-adapter', 'debug', 'dfv-table');
const fake = path.join(root, 'test', 'fakeNativeWorker.cjs');
const real = { skip: fs.existsSync(worker) ? false : `worker not built: ${worker}` };
// The test document engine exists only in a `--features test-doc` build; a production worker ignores
// DFV_TABLE_TEST_DOC and serves real tables, so those tests would fail or wait forever against it.
const testDocWorker = process.env.DFV_TABLE_TESTDOC_WORKER ?? (process.env.DFV_TABLE_WORKER ? undefined : worker);
const testDoc = { skip: testDocWorker && fs.existsSync(testDocWorker) ? false : 'test-doc worker not named: set DFV_TABLE_TESTDOC_WORKER to a --features test-doc build', timeout: 60000 };
const startReal = (testDocEngine = false, extra = {}) => NativeTableClient.start({ executable: testDocEngine ? testDocWorker! : worker, env: testDocEngine ? { DFV_TABLE_TEST_DOC: '1' } : {}, ...extra });
const startFake = (mode: string, extra = {}) => NativeTableClient.start({ executable: process.execPath, args: [fake, mode], ...extra });
const rejects = async (p: Promise<unknown>, code: string): Promise<NativeError> => {
  const e: any = await p.then(() => assert.fail('expected a rejection'), x => x);
  assert.ok(e instanceof NativeError, String(e));
  assert.equal(e.code, code);
  return e;
};

test('production worker advertises only implemented read formats and refuses unknown methods locally', real, async () => {
  const c = await startReal();
  try {
    for (const method of ['ping', 'open', 'close', 'getQueryCatalog', 'getQueryColumns', 'runQuery', 'runSortedQuery', 'runChartQuery', 'countMatchingRows', 'getColumnTopValues', 'getColumnDescriptiveStats', 'readResource', 'releaseResource']) assert.ok(c.capabilities.methods.includes(method), method);
    for (const kind of ['csv', 'parquet', 'duckdb']) assert.ok(c.capabilities.formats.some((f: any) => f.file_kind === kind && f.read === true), kind);
    assert.ok(c.capabilities.formats.every((f: any) => f.read === true && typeof f.write === 'string'));
    assert.ok(c.capabilities.limits.max_frame_bytes > 0 && c.capabilities.limits.queued_requests > 0);
    assert.ok(await c.call('ping'));
    const e = await rejects(c.call('runSql'), 'unknown_method');
    assert.equal(e.host, true);
    assert.ok(c.alive, 'a local refusal does not disturb the worker');
  } finally { await c.close(); }
});

test('production worker CSV queries preserve exact values through paged resources and release them', real, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-backend-csv-'));
  const file = path.join(dir, 'rows.csv'), source = 'id,name\n1,alpha\n2,beta\n3,gamma\n';
  fs.writeFileSync(file, source);
  const c = await startReal();
  try {
    const open: any = await c.call('open', { path: file, force_read_only: true });
    assert.equal(open.file_kind, 'csv'); assert.equal(open.read_only, true); assert.equal(open.source_revision, '1');
    const catalog: any = await c.call('getQueryCatalog', { session: open.session });
    assert.equal(catalog.relations[0].name, 'rows');
    const columns: any = await c.call('getQueryColumns', { session: open.session, ...catalog.relations[0] });
    assert.deepEqual(columns.columns.map((column: any) => column.name), ['id', 'name']);
    const sorted: any = await c.call('runSortedQuery', { session: open.session, sql: 'select * from rows limit 2', column: 'id', direction: 'desc' });
    assert.deepEqual(decodeRows(sorted.rows).map(row => row[1]), ['gamma', 'beta']);
    await c.call('releaseResource', { resource: sorted.resource.id });
    assert.deepEqual(await c.call('countMatchingRows', { session: open.session, sql: 'select * from rows limit 1' }), { count: '3' });
    const top: any = await c.call('getColumnTopValues', { session: open.session, sql: 'select 9007199254740993::bigint as exact from rows', column: 'exact' });
    assert.equal(decodeValue(top.top_values[0].value), 9007199254740993n);
    assert.equal(top.top_values[0].frequency, '3');
    const stats: any = await c.call('getColumnDescriptiveStats', { session: open.session, sql: 'select 9007199254740993::bigint as exact from rows', column: 'exact', stats_kind: 'numeric' });
    assert.equal(decodeValue(stats.min), 9007199254740993n);
    const chart: any = await c.call('runChartQuery', { session: open.session, sql: 'select * from rows limit 2', x_column: 'id', y_columns: ['id'] });
    assert.equal(chart.x_axis_mode, 'time');
    assert.equal(decodeRows(chart.result.rows).length, 2);
    await c.call('releaseResource', { resource: chart.result.resource.id });
    const page: any = await c.call('runQuery', { session: open.session, sql: 'select id, name, 9007199254740993::BIGINT as exact, 12345678901234567890.1234::DECIMAL(24,4) as dec, 0.1::FLOAT as single from rows order by id', page_size: 1, max_rows: 3, expected_revision: open.source_revision });
    const first = decodeRows(page.rows)[0]; assert.equal(first[1], 'alpha'); assert.equal(first[2], 9007199254740993n);
    assert.deepEqual(first[3], { kind: 'decimal', text: '12345678901234567890.1234', precision: 24, scale: 4 }); assert.equal(first[4], Math.fround(.1));
    assert.equal(page.page.next_offset, '1'); assert.equal(page.page.total_rows, '3'); assert.equal(page.page.truncated, false);
    const next: any = await c.call('readResource', { resource: page.resource.id, offset: page.page.next_offset, page_size: 2 });
    assert.deepEqual(decodeRows(next.rows).map(row => row[1]), ['beta', 'gamma']); assert.equal(next.page.next_offset, null);
    assert.deepEqual(await c.call('releaseResource', { resource: page.resource.id }), { released: true });
    await rejects(c.call('readResource', { resource: page.resource.id }), 'not_open');
    await rejects(c.call('runQuery', { session: open.session, sql: "select * from read_csv('/not-authorized.csv')" }), 'policy_refused');
    const closed: any = await c.call('close', { session: open.session }); assert.equal(closed.closed, true);
    await rejects(c.call('getQueryCatalog', { session: open.session }), 'not_open');
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('production CSV locale and marker options and exact nested Parquet reads preserve their sources', real, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-format-reads-'));
  const file = path.join(dir, 'rows.csv');
  const client = await startReal();
  try {
    fs.writeFileSync(file, 'amount\n1.234\n2.345\n');
    const original = fs.readFileSync(file);
    for (const options of [{ number_locale: 'other' }, { number_locale: null }, { null_text: [1] }, { null_text: ['x'.repeat(257)] }, { null_text: Array(257).fill('NA') }]) {
      await rejects(client.call('open', { path: file, ...options }), 'malformed_value');
    }
    let opened: any = await client.call('open', { path: file, number_locale: 'eu', force_read_only: true });
    assert.equal(opened.read_only, true); assert.equal(opened.schema_provenance, 'inferred');
    assert.equal(opened.number_locale.locale, 'eu'); assert.equal(opened.number_locale.forced, true);
    let result: any = await client.call('runQuery', { session: opened.session, sql: 'select cast(amount as varchar) from rows' });
    assert.deepEqual(decodeRows(result.rows), [['1234'], ['2345']]);
    await client.call('close', { session: opened.session }); assert.deepEqual(fs.readFileSync(file), original);
    fs.writeFileSync(file, 'amount\n1.5\nNA\n2.5\n');
    const markers = fs.readFileSync(file);
    for (const literal of [false, true]) {
      opened = await client.call('open', { path: file, ...(literal ? { null_text: [] } : {}) });
      result = await client.call('runQuery', { session: opened.session, sql: 'select cast(amount as varchar) from rows' });
      assert.deepEqual(decodeRows(result.rows), [['1.5'], [literal ? 'NA' : null], ['2.5']]);
      assert.equal(opened.open_warnings.length > 0, !literal);
      await client.call('close', { session: opened.session });
      assert.deepEqual(fs.readFileSync(file), markers);
    }
    const fixtures = path.join(root, 'native/crates/duckdb-query/tests/fixtures/parquet');
    const nested = path.join(dir, 'nested.parquet'); fs.copyFileSync(path.join(fixtures, 'nested.parquet'), nested);
    const before = fs.readFileSync(nested);
    opened = await client.call('open', { path: nested, force_read_only: true });
    assert.equal(opened.schema_provenance, 'declared'); assert.equal(opened.number_locale, null);
    assert.equal(opened.read_only, true);
    result = await client.call('runQuery', { session: opened.session, sql: 'select lst, lst_null_item, st, mp, ld from nested' });
    const list = (items: unknown[]) => ({ kind: 'list', items });
    assert.deepEqual(decodeRows(result.rows), [
      [list([1, 2, 3]), list([1n, null]), { kind: 'struct', fields: [['a', 1n], ['b', 'x']] }, { kind: 'map', entries: [['k', 1]] }, list([{ kind: 'decimal', text: '1.50', precision: 5, scale: 2 }, null])],
      [list([]), null, { kind: 'struct', fields: [['a', null], ['b', null]] }, { kind: 'map', entries: [] }, null],
      [null, list([null]), null, null, list([])],
    ]);
    await client.call('close', { session: opened.session }); assert.deepEqual(fs.readFileSync(nested), before);
    const wide = path.join(dir, 'wide.parquet'); fs.copyFileSync(path.join(fixtures, 'decimal_beyond_38.parquet'), wide);
    const wideBefore = fs.readFileSync(wide);
    await rejects(client.call('open', { path: wide }), 'unsupported');
    assert.deepEqual(fs.readFileSync(wide), wideBefore);
    opened = await client.call('open', { path: nested });
    await client.call('close', { session: opened.session });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['nested.parquet', 'rows.csv', 'wide.parquet']);
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real worker: reading through the test document engine, release and close', testDoc, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-backend-'));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.from('0123456789abcdef'));
  const c = await startReal(true);
  try {
    const open: any = await c.call('testOpen', { path: file });
    const read: any = await c.call('testRead', { session: open.session });
    const page: any = await c.call('testPage', { resource: read.resource, offset: 0, len: 4 });
    assert.equal(page.hex, '30313233');
    assert.deepEqual(await c.call('testRelease', { resource: read.resource }), { released: true });
    await rejects(c.call('testPage', { resource: read.resource }), 'not_open'); // a stale handle is refused, not answered
    await c.call('testClose', { session: open.session });
  } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real worker: cancelling an active read and a worker-enforced deadline each end with their typed error', testDoc, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-backend-'));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, 'x');
  const c = await startReal(true);
  try {
    const open: any = await c.call('testOpen', { path: file });
    const ac = new AbortController();
    const pending = c.call('testRead', { session: open.session, hold_ms: 5000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await rejects(pending, 'cancelled');
    const late = await rejects(c.call('testRead', { session: open.session, hold_ms: 5000 }, { deadlineMs: 80 }), 'deadline_exceeded');
    assert.equal(late.host, false, 'the worker answered; it was not lost');
    assert.ok(c.alive);
  } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('killing the worker mid-call settles every pending call with a typed error and restart() recovers', testDoc, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-backend-'));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, 'x');
  const c = await startReal(true);
  try {
    const open: any = await c.call('testOpen', { path: file });
    const read = c.call('testRead', { session: open.session, hold_ms: 5000 });
    const write = c.call('testRead', { session: open.session, hold_ms: 5000 }, { mutation: true });
    const queued = c.call('testStatus');
    await new Promise(r => setTimeout(r, 100));
    process.kill(c.pid!, 'SIGKILL');
    const r = await rejects(read, 'worker_exited');
    assert.equal(r.host, true);
    assert.equal(r.mutationOutcome, null);
    const w = await rejects(write, 'worker_exited');
    assert.equal(w.mutationOutcome, 'unknown');
    assert.ok(isUnconfirmed(w), 'a lost write is its own outcome');
    await rejects(queued, 'worker_exited');
    await rejects(c.call('testStatus'), 'worker_exited'); // dead until restart; nothing resubmitted
    await c.restart();
    assert.ok(c.alive);
    assert.deepEqual(await c.call('testStatus'), { sessions: 0, resources: 0, held_bytes: 0 }); // the old process's state is gone
  } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent restarts share one new worker and close waits for that replacement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-backend-restart-')), log = path.join(dir, 'starts');
  const c = await startFake('echo', { env: { DFV_FAKE_START_LOG: log } });
  try {
    await Promise.all([c.restart(), c.restart()]);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
    assert.deepEqual(await c.call('work', { fresh: true }), { echo: { fresh: true } });
    const restart = c.restart(), close = c.close();
    await Promise.all([restart, close]);
    assert.equal(c.alive, false);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 3);
  } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a hung worker is stopped after deadline + grace and everything pending is settled', async () => {
  const c = await startFake('hang', { graceMs: 100 });
  const a = c.call('work', {}, { deadlineMs: 100 });
  const b = c.call('work', {}, { deadlineMs: 5000, mutation: true });
  await rejects(a, 'worker_timeout');
  const e = await rejects(b, 'worker_timeout');
  assert.equal(e.mutationOutcome, 'unknown');
  assert.equal(c.alive, false);
  await c.close();
});

test('garbage, an over-long frame, an unattributable reply and a bad first frame are protocol violations', async () => {
  for (const mode of ['garbage', 'unattributed']) {
    const c = await startFake(mode);
    await rejects(c.call('work'), 'protocol_violation');
    assert.equal(c.alive, false, mode);
  }
  const big = await startFake('oversize', { maxFrameBytes: 4096 });
  // The advertised limit is 1 MiB but the client ceiling is 4 KiB: the 2 MiB line must not be buffered.
  await rejects(big.call('work'), 'protocol_violation');
  assert.equal(big.alive, false);
  for (const mode of ['badcaps', 'badlimits', 'badengine', 'badmethods']) await rejects(startFake(mode), 'protocol_violation');
  await rejects(startFake('nocaps', { startTimeoutMs: 200 }), 'worker_timeout');
});

test('a malformed response settles its own caller and all other pending requests', { timeout: 3000 }, async () => {
  for (const mode of ['invalidresponse', 'invaliderror', 'bothresponse']) {
    const c = await startFake(mode);
    try {
      const answers = await Promise.allSettled([c.call('work'), c.call('work', {}, { mutation: true })]);
      for (const answer of answers) {
        assert.equal(answer.status, 'rejected');
        if (answer.status === 'rejected') assert.equal(answer.reason.code, 'protocol_violation');
      }
      assert.equal(c.alive, false);
    } finally { await c.close(); }
  }
});

test('a lost worker distinguishes sent writes from writes still waiting locally', async () => {
  const c = await startFake('hang');
  const calls = Array.from({ length: 9 }, () => c.call('work'));
  calls.push(c.call('work', {}, { mutation: true }));
  const settled = Promise.allSettled(calls);
  process.kill(c.pid!, 'SIGKILL');
  const answers = await settled, queued = answers.at(-1)!;
  assert.equal(queued.status, 'rejected');
  if (queued.status === 'rejected') {
    assert.equal(queued.reason.code, 'worker_exited');
    assert.equal(queued.reason.mutationOutcome, 'not-published');
    assert.equal(isUnconfirmed(queued.reason), false);
  }
  const unsent = await rejects(c.call('work', {}, { mutation: true }), 'worker_exited');
  assert.equal(unsent.mutationOutcome, 'not-published');
  await c.close();
});

test('closing rejects new writes before sending them', async () => {
  const c = await startFake('echo');
  const closed = c.close();
  const error = await rejects(c.call('work', {}, { mutation: true }), 'client_closed');
  assert.equal(error.mutationOutcome, 'not-published');
  await closed;
});

test('invalid local deadlines refuse without killing the healthy worker', async () => {
  const c = await startFake('echo');
  try {
    for (const deadlineMs of [NaN, Infinity, -1, 0, .5, 2_147_483_648]) {
      const error = await rejects(c.call('work', {}, { deadlineMs, mutation: true }), 'malformed_value');
      assert.equal(error.mutationOutcome, 'not-published');
    }
    assert.deepEqual(await c.call('work', { healthy: true }), { echo: { healthy: true } });
  } finally { await c.close(); }
});

test('an oversized request is refused before anything is sent', async () => {
  const c = await startFake('echo');
  try {
    await rejects(c.call('work', { blob: 'x'.repeat(2 * 1048576) }), 'frame_too_large');
    assert.deepEqual(await c.call('work', { n: 1 }), { echo: { n: 1 } });
  } finally { await c.close(); }
});

test('the client keeps within the worker queue, and queue_full is surfaced as retryable but never retried', async () => {
  const slow = await startFake('slow');
  try {
    const requests = Array.from({ length: 11 }, () => slow.call('work'));
    const over = await rejects(slow.call('work'), 'queue_full');
    assert.equal(over.host, true); assert.equal(over.retryable, true);
    const all: any[] = await Promise.all(requests);
    assert.ok(Math.max(...all.map(r => r.peak)) <= 3, 'at most queued_requests + 1 in flight');
  } finally { await slow.close(); }
  const full = await startFake('queue_full');
  try {
    const e = await rejects(full.call('work'), 'queue_full');
    assert.equal(e.retryable, true);
    assert.equal(e.host, false);
    assert.ok(full.alive);
  } finally { await full.close(); }
});

test('a write the worker reports as unknown is surfaced as unconfirmed, and the dead worker is not retried against', async () => {
  const c = await startFake('mutation_unknown');
  try {
    const e = await rejects(c.call('work', {}, { mutation: true }), 'mutation_unknown');
    assert.ok(isUnconfirmed(e));
  } finally { await c.close(); }
  const dying = await startFake('die');
  const e = await rejects(dying.call('work', {}, { mutation: true }), 'worker_exited');
  assert.ok(isUnconfirmed(e));
  await rejects(dying.call('work'), 'worker_exited');
  await dying.close();
});

test('wire values decode exactly: wide integers stay bigint, NULL differs from empty text, malformed values are refused', () => {
  assert.equal(decodeValue(null), null);
  assert.equal(decodeValue(''), '');
  assert.equal(decodeValue({ $t: 'int64', v: '9007199254740993' }), 9007199254740993n);
  assert.equal(decodeValue({ $t: 'uint64', v: '18446744073709551615' }), 18446744073709551615n);
  assert.equal(decodeValue({ $t: 'int32', v: '-2147483648' }), -2147483648);
  assert.equal(String(decodeValue({ $t: 'float64', v: 'NaN' })), 'NaN');
  assert.equal(decodeValue({ $t: 'float64', v: '-Infinity' }), -Infinity);
  assert.equal(decodeValue({ $t: 'float32', v: '0.1' }), Math.fround(0.1));
  assert.ok(Object.is(decodeValue({ $t: 'float32', v: '-0' }), -0));
  assert.deepEqual(decodeValue({ $t: 'decimal', v: '12345678901234567890.1234', precision: 24, scale: 4 }), { kind: 'decimal', text: '12345678901234567890.1234', precision: 24, scale: 4 });
  assert.deepEqual([...decodeValue({ $t: 'binary', encoding: 'base64', v: 'AAH/' }) as Buffer], [0, 1, 255]);
  assert.deepEqual(decodeValue({ $t: 'timestamp', v: '1', unit: 'ns', tz: null }), { kind: 'timestamp', value: 1n, unit: 'ns', tz: null });
  assert.deepEqual(decodeValue({ $t: 'struct', v: [['a', null], ['b', { $t: 'int8', v: '-1' }]] }), { kind: 'struct', fields: [['a', null], ['b', -1]] });
  assert.deepEqual(decodeRows([[null, ''], [{ $t: 'int64', v: '1' }, true]]), [[null, ''], [1n, true]]);
  for (const bad of [5, [1], {}, { $t: 'nope', v: '1' }, { $t: 'toString', v: '1' }, { $t: 'constructor', v: '1' }, { $t: {}, v: '1' }, { $t: 'int8', v: '128' }, { $t: 'int64', v: '01' }, { $t: 'uint8', v: '-1' }, { $t: 'int64', v: 5 },
    { $t: 'float64', v: '1e5' }, { $t: 'float64', v: '1e+999' }, { $t: 'float32', v: '1e+39' }, { $t: 'decimal', v: '0', precision: 0, scale: 0 }, { $t: 'decimal', v: '0', precision: 39, scale: 0 }, { $t: 'decimal', v: '0.00', precision: 1, scale: 2 }, { $t: 'decimal', v: '1.5', precision: 5, scale: 2 }, { $t: 'decimal', v: '-0', precision: 1, scale: 0 }, { $t: 'binary', encoding: 'base64', v: 'AA' },
    { $t: 'timestamp', v: '1', unit: 'h', tz: null }, { $t: 'uuid', v: 'XYZ' }, { $t: 'struct', v: [['a', null], ['a', null]] }, { $t: 'date', v: '2147483648' }])
    assert.throws(() => decodeValue(bad), (e: any) => e instanceof NativeError && e.code === 'malformed_value', JSON.stringify(bad));
  assert.throws(() => decodeRows([[1]]), NativeError); // one bad cell fails the page
});

test('a duplicate response is a protocol violation: the first answer stands, the worker is stopped, later calls fail typed', async () => {
  const c = await startFake('duplicate');
  const exited = new Promise(resolve => c.onExit(() => resolve(undefined))); // before the call: the stop can land before its reply is delivered
  assert.deepEqual(await c.call('work'), { n: 1 });
  await exited;
  assert.equal(c.alive, false);
  await rejects(c.call('work'), 'protocol_violation'); // the dead handle reports its cause and is not resubmitted against
  await c.close();
});

test('EOF in the middle of a frame settles every pending call; the half frame is never parsed', async () => {
  const c = await startFake('eofmid');
  const answers = await Promise.allSettled([c.call('work'), c.call('work', {}, { mutation: true })]);
  assert.deepEqual(answers.map(a => a.status === 'rejected' && a.reason.code), ['worker_exited', 'worker_exited']);
  assert.equal(answers[1].status === 'rejected' && answers[1].reason.mutationOutcome, 'unknown');
  assert.equal(c.alive, false);
  await c.close();
});

test('cancellation races: before send, while held, after the answer, and a worker that ignores the cancel', async () => {
  const c = await startFake('hold');
  try {
    const early = new AbortController(); early.abort();
    await rejects(c.call('work', {}, { signal: early.signal }), 'cancelled');
    const held = new AbortController();
    const p = c.call('work', { ms: 5000 }, { signal: held.signal });
    setTimeout(() => held.abort(), 30);
    await rejects(p, 'cancelled'); // the worker answered the cancel frame
    const done = new AbortController();
    assert.deepEqual(await c.call('work', { ms: 1 }, { signal: done.signal }), { held: true });
    done.abort(); // after settling: the listener is gone, no frame is written, nothing throws
    assert.ok(c.alive);
    assert.deepEqual(await c.call('work', { ms: 1 }), { held: true });
  } finally { await c.close(); }
  const stubborn = await startFake('hold', { env: { DFV_FAKE_IGNORE_CANCEL: '1' } });
  try {
    const ac = new AbortController();
    const p = stubborn.call('work', { ms: 50 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    assert.deepEqual(await p, { held: true }); // the worker's answer wins; settled exactly once
    assert.ok(stubborn.alive);
  } finally { await stubborn.close(); }
});
