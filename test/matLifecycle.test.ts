import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MatClient } from '../src/features/mat/client';
import { scalarText } from '../src/features/mat/protocol';
import { NativeTableClient, NativeError } from '../src/backend/native';
import { nativeWorkerUsage } from '../src/native/supervisor';
import { createPdfHost } from '../src/pdfHost';

// V18.3 child paging/mid-flight cancel and V17.2/V19 lifecycle: no skips. An unset input resolves to its documented default;
// a missing default fails loudly. Every wait is bounded and every worker is reaped even when an assertion fails.
const DEFAULTS: Record<string, string> = {
  DFV_PYTHON: '/Users/macc/miniforge3/envs/myproject/bin/python',
  DFV_MAT_WORKER: '/Users/macc/dfv-resume-20261103-target/debug/dfv-mat',
  DFV_TABLE_WORKER: '/Users/macc/dfv-resume-20261103-target/debug/dfv-table',
  DFV_MAT_FIXTURE: '/Users/macc/dfv-xlsx-resume-20261103/native/crates/mat/tests/fixtures/native_v7.mat',
};
const need = (key: string) => {
  const v = process.env[key] || DEFAULTS[key];
  assert.ok(v && fs.existsSync(v), `${key} must name an existing input (default ${DEFAULTS[key]})`);
  return v;
};
const root = path.resolve(__dirname, '../..');
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (label: string, ok: () => boolean, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (ok()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail(`timed out: ${label}`);
};
const samplePdf = async (file: string) => {
  const importEsm = new Function('f', 'return import(f)') as (f: string) => Promise<any>;
  (await importEsm(require('node:url').pathToFileURL(path.join(root, 'test/vsix_smoke/helpers.mjs')).href)).samplePdf(file);
};
const slots = (feature: string) => nativeWorkerUsage().workers.filter(w => w.feature === feature).length;

test('real MAT worker: 250 cell/struct children page by 100 with exact totals, distinct labels and source-bound handles', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-children-')), file = path.join(dir, 'children.mat');
  execFileSync(need('DFV_PYTHON'), ['-I', path.join(root, 'test/resources/createMatChildren.py'), file], { timeout: 60000 });
  const before = sha(file);
  let client = await MatClient.open({ executable: need('DFV_MAT_WORKER') }, file);
  try {
    const catalog = await client.catalog();
    for (const [name, last] of [['big_cell', '250'], ['big_struct', '250']] as const) {
      const parent = catalog.items.find(i => i.info.name === name); assert.ok(parent, name);
      assert.equal((await client.describe(parent.handle)).children, '250', name);
      const labels = new Set<string>(); let firstOfThird = '';
      for (const [offset, expected] of [['0', 100], ['100', 100], ['200', 50]] as const) {
        const page = await client.children(parent.handle, offset);
        assert.equal(page.total, '250'); assert.equal(page.offset, offset); assert.equal(page.items.length, expected, `${name}@${offset}`);
        for (const item of page.items) { assert.ok(item.label, 'each child is labelled'); assert.ok(!labels.has(item.label), `duplicate label ${item.label}`); labels.add(item.label); }
        if (offset === '200') {
          firstOfThird = page.items[0].label!;
          const tail = page.items.at(-1)!, meta = await client.describe(tail.handle);
          assert.equal(scalarText((await client.slice(tail.handle, meta.dims.map(() => '1'), meta.dims)).data.re![0]), last, `${name} child 250 exact`);
        }
      }
      assert.equal(labels.size, 250); assert.ok(firstOfThird);
      const empty = await client.children(parent.handle, '250');
      assert.equal(empty.items.length, 0); assert.equal(empty.total, '250');
    }
    const stale = (await client.children(catalog.items.find(i => i.info.name === 'big_cell')!.handle, '0')).items[0].handle;
    client = await client.reopen();
    await assert.rejects(client.describe(stale), /no longer open/);
    await assert.rejects(client.children(stale, '0'), /no longer open/);
  } finally { await client.close(); }
  assert.equal(sha(file), before, 'source bytes unchanged');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real MAT worker: cancel in flight settles once, a late reply is discarded and the same session stays usable', { timeout: 60000 }, async () => {
  const client = await MatClient.open({ executable: need('DFV_MAT_WORKER') }, need('DFV_MAT_FIXTURE'));
  const pid = client.pid!;
  try {
    const handle = (await client.catalog()).items[0].handle;
    for (let round = 0; round < 5; round++) {
      process.kill(pid, 'SIGSTOP');
      const control = new AbortController(), read = client.describe(handle, control.signal);
      control.abort(); process.kill(pid, 'SIGCONT'); // request frame, then cancel frame, are both queued before the worker resumes
      const [settled] = await Promise.allSettled([read]);
      if (settled.status === 'rejected') assert.ok(settled.reason instanceof NativeError && settled.reason.code === 'cancelled', String(settled.reason));
      assert.equal((client as any).worker.pending.size, 0); assert.equal((client as any).worker.waiting.length, 0);
      assert.ok((await client.describe(handle)).name, 'same session and handle are still valid after cancel');
    }
    assert.equal(client.pid, pid); assert.ok(alive(pid));
  } finally { try { process.kill(pid, 'SIGCONT'); } catch { /* already gone */ } await client.close(); }
  await until('MAT worker reaped', () => !alive(pid));
});

test('real MAT worker: cancel against a hung worker is bounded by the watchdog, which kills it and reclaims the slot', { timeout: 60000 }, async () => {
  const client = await MatClient.open({ executable: need('DFV_MAT_WORKER') }, need('DFV_MAT_FIXTURE'));
  const pid = client.pid!, handle = (await client.catalog()).items[0].handle;
  try {
    process.kill(pid, 'SIGSTOP');
    const control = new AbortController(), started = Date.now(), read = client.describe(handle, control.signal);
    control.abort();
    const [settled] = await Promise.allSettled([read]);
    assert.equal(settled.status, 'rejected');
    const error = (settled as PromiseRejectedResult).reason as NativeError;
    assert.ok(error instanceof NativeError); assert.equal(error.code, 'worker_timeout');
    console.log(`measured: hung-worker cancel settled as worker_timeout after ${Date.now() - started} ms`);
    await until('hung MAT worker killed and slot reclaimed', () => !alive(pid) && slots('mat') === 0);
    await assert.rejects(client.catalog(), (e: any) => ['worker_timeout', 'worker_exited'].includes(e.code), 'dead client stays dead');
    assert.equal(slots('mat'), 0);
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } await client.close(); }
});

test('restart is bounded: MAT and table never restart themselves, PDF replaces exactly one worker per death, every slot is reclaimed', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-restart-')), pdfPath = path.join(dir, 'source.pdf'), csv = path.join(dir, 'rows.csv');
  await samplePdf(pdfPath); fs.writeFileSync(csv, 'id,name\n1,alpha\n');
  const originals = [pdfPath, csv].map(f => [f, fs.readFileSync(f)] as const);
  const matWorker = need('DFV_MAT_WORKER'), matFixture = need('DFV_MAT_FIXTURE'), tableWorker = need('DFV_TABLE_WORKER');
  const context = { extensionPath: root, globalStorageUri: { fsPath: path.join(dir, 'state') } } as any;
  let host: Awaited<ReturnType<typeof createPdfHost>> | undefined, mat: MatClient | undefined, table: NativeTableClient | undefined;
  try {
    host = await createPdfHost(context, { fsPath: pdfPath } as any);
    mat = await MatClient.open({ executable: matWorker }, matFixture);
    table = await NativeTableClient.start({ executable: tableWorker });
    assert.deepEqual([slots('pdf'), slots('mat'), slots('table')], [1, 1, 1]);
    const seen = new Set<number>();
    for (let death = 0; death < 3; death++) {
      const pdfPid = nativeWorkerUsage().workers.find(w => w.feature === 'pdf')!.pid!; seen.add(pdfPid);
      process.kill(pdfPid, 'SIGKILL');
      await until('PDF slot reclaimed', () => !alive(pdfPid) && slots('pdf') === 0);
      await assert.rejects(host.request('get_document_info', {}), (e: any) => e.code === 'WORKER_RESTARTED');
      assert.equal(slots('pdf'), 1, 'exactly one replacement');
      assert.ok(await host.request('get_document_info', {}));
      assert.equal(slots('pdf'), 1);
    }
    assert.equal(seen.size, 3, 'each death produced a distinct replacement');
    const matPid = mat.pid!, tablePid = nativeWorkerUsage().workers.find(w => w.feature === 'table')!.pid!;
    process.kill(matPid, 'SIGKILL'); process.kill(tablePid, 'SIGKILL');
    await until('MAT and table slots reclaimed', () => slots('mat') === 0 && slots('table') === 0);
    await assert.rejects(mat.catalog(), (e: any) => e.code === 'worker_exited');
    await assert.rejects(table.call('ping'), (e: any) => e.code === 'worker_exited');
    assert.deepEqual([slots('pdf'), slots('mat'), slots('table')], [1, 0, 0], 'no automatic MAT/table restart, and PDF is unaffected');
    await table.restart();
    assert.deepEqual([slots('pdf'), slots('mat'), slots('table')], [1, 0, 1], 'explicit table restart creates exactly one worker');
    assert.ok(await table.call('ping'));
  } finally {
    await table?.close(); await mat?.close(); host?.dispose();
    await until('all slots empty', () => nativeWorkerUsage().workers.length === 0);
  }
  for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aggregate ownership: killing the owner process leaves no orphan PDF, table or MAT worker', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-owner-')), pdf = path.join(dir, 'source.pdf'), mat = path.join(dir, 'source.mat');
  await samplePdf(pdf); fs.copyFileSync(need('DFV_MAT_FIXTURE'), mat);
  const env = { ...process.env, DFV_MAT_WORKER: need('DFV_MAT_WORKER'), DFV_TABLE_WORKER: need('DFV_TABLE_WORKER') };
  const before = [pdf, mat].map(f => sha(f));
  const holder = spawn(process.execPath, [path.join(root, 'test/ownershipHolder.cjs'), pdf, mat, dir], { stdio: ['ignore', 'pipe', 'inherit'], env });
  let pids: number[] = [];
  try {
    const line: string = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('holder reported no workers within 30 s')), 30000);
      holder.stdout!.on('data', d => { text += d; if (text.includes('\n')) { clearTimeout(timer); resolve(text); } });
      holder.once('exit', code => { clearTimeout(timer); reject(new Error(`holder exited early (${code})`)); });
    });
    const report = JSON.parse(line);
    assert.equal(report.holder, holder.pid);
    assert.deepEqual(Object.keys(report.pids).sort(), ['mat', 'pdf', 'table']);
    pids = Object.values(report.pids) as number[];
    assert.equal(new Set(pids).size, 3, 'three distinct workers');
    for (const pid of pids) {
      assert.ok(alive(pid));
      assert.equal(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim()), holder.pid, 'worker is a direct child of the owner');
    }
    process.kill(holder.pid!, 'SIGKILL');
    await until('all three workers exit after owner death', () => pids.every(pid => !alive(pid)));
  } finally {
    if (holder.pid && alive(holder.pid)) process.kill(holder.pid, 'SIGKILL');
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
  assert.deepEqual([pdf, mat].map(f => sha(f)), before);
  fs.rmSync(dir, { recursive: true, force: true });
});
