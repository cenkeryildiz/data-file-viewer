import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { MAX_NATIVE_WORKERS, nativeWorkerUsage, spawnWorker, WorkerCapacityError, type NativeFeature } from '../src/native/supervisor';
import { NativeTableClient, NativeError } from '../src/backend/native';
import { MatClient } from '../src/features/mat/client';
import { createPdfHost, type PdfHost } from '../src/pdfHost';

const root = path.resolve(__dirname, '../..');
const fake = path.join(root, 'test/fakeNativeWorker.cjs');
const startFake = (mode = 'echo') => NativeTableClient.start({ executable: process.execPath, args: [fake, mode] });
const options = { stdio: ['pipe', 'pipe', 'pipe'] } as const;
const usage = () => nativeWorkerUsage().workers.length;
async function empty() {
  for (let i = 0; i < 100 && usage(); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(usage(), 0, 'all actual child exits reclaim their reservations');
}

test('supervisor reserves before spawn, shares eight slots across features and refuses the ninth before launch', async () => {
  const children: ChildProcess[] = [];
  try {
    for (let i = 0; i < MAX_NATIVE_WORKERS; i++) children.push(spawnWorker((['table', 'pdf', 'mat'] as NativeFeature[])[i % 3], process.execPath, ['-e', 'process.stdin.resume()'], { stdio: [...options.stdio] }));
    assert.equal(usage(), 8, 'starting children already own their slots');
    assert.throws(() => spawnWorker('pdf', '/must-not-be-launched', [], {}), WorkerCapacityError);
    await Promise.all(children.map(child => once(child, 'spawn')));
    const snapshot = nativeWorkerUsage();
    assert.equal(snapshot.limit, 8);
    assert.equal(snapshot.workers.filter(w => w.feature === 'pdf').length, 3);
    assert.ok(snapshot.workers.every(w => typeof w.pid === 'number'));
    snapshot.workers.length = 0;
    assert.equal(usage(), 8, 'diagnostics cannot mutate admission ownership');
  } finally {
    await Promise.all(children.map(async child => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }));
    await empty();
  }
});

test('close retains its slot until actual exit; refusal leaves existing workers usable and restart reuses one slot', async () => {
  const clients: NativeTableClient[] = [];
  try {
    for (let i = 0; i < 8; i++) clients.push(await startFake(i === 0 ? 'delayedExit' : 'echo'));
    const closing = clients[0].close();
    assert.equal(usage(), 8);
    await assert.rejects(startFake(), (e: unknown) => e instanceof NativeError && e.code === 'resource_limit' && e.category === 'resource');
    assert.ok(await clients[1].call('ping'));
    await closing;
    assert.equal(usage(), 7);
    await clients[1].restart();
    assert.equal(usage(), 7);
    clients.push(await startFake());
    assert.equal(usage(), 8);
    await clients[0].close();
    assert.equal(usage(), 8, 'repeated close cannot release another child reservation');
  } finally { await Promise.all(clients.map(client => client.close())); await empty(); }
});

test('failed spawn and synchronous spawn errors return their reservation exactly once', async () => {
  await assert.rejects(NativeTableClient.start({ executable: '/dfv-no-such-worker' }), (e: unknown) => e instanceof NativeError && e.code === 'worker_exited');
  await empty();
  assert.throws(() => spawnWorker('table', '', [], {}));
  assert.equal(usage(), 0);
  const client = await startFake();
  try { assert.equal(usage(), 1); assert.ok(await client.call('ping')); }
  finally { await client.close(); await empty(); }
});

test('worker admission manifest agrees with the operational bound and freezes a justified budget for every resource class', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'native/resource-policy.json'), 'utf8'));
  assert.equal(manifest.worker_admission.maximum_processes, MAX_NATIVE_WORKERS);
  const { rss_mib: rss, cpu, ipc_bytes: ipc, temporary_bytes: temp, handles } = manifest.budgets;
  for (const budget of [rss.table_worker_each, rss.pdf_worker_each, rss.mat_worker, rss.aggregate_native, rss.retained_delta_per_worker]) {
    assert.ok(Number.isFinite(budget.value) && budget.value > 0 && ['contract', 'operational'].includes(budget.kind) && budget.basis.length > 20);
  }
  assert.ok(rss.aggregate_native.value < 4 * rss.table_worker_each.value + 2 * rss.pdf_worker_each.value + rss.mat_worker.value, 'aggregate is a real bound, not the sum of ceilings');
  assert.ok(cpu.table_worker_cpu_per_wall_second && cpu.pdf_and_mat_cpu_per_wall_second > 0 && ipc.per_worker_pending > 0 && handles.open_file_descriptors_per_worker > 0);
  for (const key of ['native_scratch', 'pdf_private_work', 'pdf_recovery', 'after_shutdown']) assert.equal(typeof temp[key], 'string');
});

test('actual PDF/table/MAT workers survive admission refusals with unchanged sources', {
  skip: !process.env.DFV_TABLE_WORKER || !process.env.DFV_MAT_WORKER || !process.env.DFV_MAT_FIXTURE,
  timeout: 30000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-supervisor-'));
  const csv = path.join(dir, 'rows.csv'), pdfPath = path.join(dir, 'source.pdf'), matPath = path.join(dir, 'source.mat');
  fs.writeFileSync(csv, 'id,name\n1,alpha\n'); fs.copyFileSync(process.env.DFV_MAT_FIXTURE!, matPath);
  const importEsm = new Function('file', 'return import(file)') as (file: string) => Promise<any>;
  const { samplePdf } = await importEsm(require('node:url').pathToFileURL(path.join(root, 'test/vsix_smoke/helpers.mjs')).href);
  samplePdf(pdfPath);
  const originals = [csv, pdfPath, matPath].map(file => [file, fs.readFileSync(file)] as const);
  const clients: NativeTableClient[] = []; let pdf: PdfHost | undefined, mat: MatClient | undefined;
  const context = { extensionPath: root, globalStorageUri: { fsPath: path.join(dir, 'state') } } as any;
  try {
    pdf = await createPdfHost(context, { fsPath: pdfPath } as any);
    const capabilities: any = await pdf.request('get_capabilities', {});
    assert.equal(capabilities.limits.max_queued, 64);
    assert.equal(capabilities.limits.max_session_reads, 4);
    assert.equal(capabilities.limits.mutations_per_session, 1);
    assert.equal(capabilities.engine.execution.read_deadline_ms, 30000);
    mat = await MatClient.open({ executable: process.env.DFV_MAT_WORKER! }, matPath);
    for (let i = 0; i < 6; i++) clients.push(await NativeTableClient.start({ executable: process.env.DFV_TABLE_WORKER! }));
    assert.equal(usage(), 8);
    const page = await mat.catalog(); assert.ok(page.items.length);
    await assert.rejects(MatClient.open({ executable: process.env.DFV_MAT_WORKER! }, matPath), (e: any) => e.code === 'resource_limit');
    await assert.rejects(createPdfHost(context, { fsPath: pdfPath } as any), (e: any) => e.code === 'RESOURCE_LIMIT');
    const opened: any = await clients[0].call('open', { path: csv, force_read_only: true });
    const result: any = await clients[0].call('runQuery', { session: opened.session, sql: 'select name from rows' });
    assert.deepEqual(result.rows, [['alpha']]);
    assert.ok(await pdf.request('get_document_info', {}));
    assert.ok((await mat.catalog()).items.length);
    await clients[0].restart(); assert.equal(usage(), 8);
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['rows.csv', 'source.mat', 'source.pdf', 'state']);
  } finally {
    await Promise.all(clients.map(client => client.close())); await mat?.close(); pdf?.dispose();
    await empty(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
