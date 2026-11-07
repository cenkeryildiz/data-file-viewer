// V20 early feasibility over real native workers. This is not fresh-source/package acceptance.
// Budgets come from policy.rs/resource.rs, docs/sql-filtering-plan.md and resources/resources.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { NativeTableClient, NativeError, decodeRows } from '../src/backend/native';
import { MatClient } from '../src/features/mat/client';
import { createPdfHost, type PdfHost } from '../src/pdfHost';
import { NativeDocument } from '../src/backend/nativeDocument';
import { nativeWorkerUsage } from '../src/native/supervisor';
import { createHash } from 'node:crypto';
import { scalarText, type MatItem } from '../src/features/mat/protocol';

const root = path.resolve(__dirname, '../..');
const tableBinary = process.env.DFV_TABLE_WORKER;
const matBinary = process.env.DFV_MAT_WORKER;
const matFixture = process.env.DFV_MAT_FIXTURE;
const enabled = process.env.DFV_NATIVE_RESOURCES === '1';
const baselineOnly = process.env.DFV_NATIVE_RESOURCE_PHASE === 'three-feature';
const sevenDocument = process.env.DFV_NATIVE_RESOURCE_PHASE === 'seven-document';
const soak = process.env.DFV_NATIVE_RESOURCE_PHASE === 'soak';
const soakSeconds = Number(process.env.DFV_SOAK_SECONDS ?? 1800);
const miB = 1024 * 1024;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rss = (pid: number) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const report = (phase: string, data: Record<string, unknown>) => console.log(`NATIVE_RESOURCE ${JSON.stringify({ phase, ...data })}`);
async function waitFor(label: string, condition: () => boolean, ms = 6000) { for (const end = Date.now() + ms; Date.now() < end;) { if (condition()) return; await sleep(50); } assert.fail(label); }
function disk(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const d = disk(p); files += d.files; bytes += d.bytes; } else { files++; bytes += fs.statSync(p).size; } }
  return { files, bytes };
}
function childPids(executable: string) {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && +m[2] === process.pid && m[3].includes(executable) ? [+m[1]] : [];
  });
}
async function rejected(promise: Promise<unknown>, codes: string[]) {
  const error = await promise.then(() => assert.fail('expected a bounded refusal'), e => e);
  assert.ok(error instanceof NativeError, String(error)); assert.ok(codes.includes(error.code), error.code); return error;
}

test(`native resource feasibility: ${baselineOnly ? 'three-feature baseline only' : 'limits, cancellation, queues, close cycles and three-feature baseline'}`, { skip: !enabled || sevenDocument || soak, timeout: 120000 }, async () => {
  assert.ok(tableBinary && matBinary && matFixture, 'explicit real native workers and genuine MAT fixture required');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-native-resources-')));
  const input = path.join(dir, 'inputs'), scratch = path.join(dir, 'scratch'), state = path.join(dir, 'state');
  for (const p of [input, scratch, state]) fs.mkdirSync(p, { mode: 0o700 });
  const csv = path.join(input, 'rows50000.csv'), matPath = path.join(input, 'native.mat'), pdfPath = path.join(input, 'simple.pdf');
  const lines = ['id,region,amount']; for (let i = 0; i < 50000; i++) lines.push(`${i},${['n','s','e','w'][i % 4]},${i * 7919 % 100000}`);
  fs.writeFileSync(csv, lines.join('\n') + '\n'); fs.copyFileSync(matFixture, matPath);
  const importEsm = new Function('file', 'return import(file)') as (file: string) => Promise<any>;
  const { samplePdf } = await importEsm(pathToFileURL(path.join(root, 'test/vsix_smoke/helpers.mjs')).href); samplePdf(pdfPath);
  const originals = [csv, matPath, pdfPath].map(file => [file, fs.readFileSync(file)] as const);
  const owned = new Set<number>(); let c: NativeTableClient | undefined, mat: MatClient | undefined, pdf: PdfHost | undefined;
  let pdfWorkerPid: number | undefined;
  const sampledPeak = { table: 0, mat: 0, pdf: 0, host: 0, nativeTotal: 0, simultaneousTotal: 0 };
  let sampleCount = 0;
  const sample = () => {
    const pids = { table: c?.pid, mat: mat?.pid, pdf: pdfWorkerPid, host: process.pid };
    const rows = execFileSync('ps', ['-o', 'pid=,rss=', '-p', Object.values(pids).filter(Boolean).join(',')], { encoding: 'utf8' });
    const current = new Map(rows.trim().split('\n').map(row => { const [pid, kib] = row.trim().split(/\s+/).map(Number); return [pid, kib / 1024]; }));
    const values = Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, current.get(pid!) ?? 0])) as Record<keyof typeof pids, number>;
    for (const name of Object.keys(pids) as (keyof typeof pids)[]) sampledPeak[name] = Math.max(sampledPeak[name], values[name]);
    sampledPeak.nativeTotal = Math.max(sampledPeak.nativeTotal, values.table + values.mat + values.pdf);
    sampledPeak.simultaneousTotal = Math.max(sampledPeak.simultaneousTotal, values.table + values.mat + values.pdf + values.host);
    sampleCount++;
  };
  const sampler = setInterval(sample, 100);
  const env = { TMPDIR: scratch, DFV_TABLE_STATE_DIR: state };
  const start = async () => { c = await NativeTableClient.start({ executable: tableBinary, env }); owned.add(c.pid!); return c; };
  const open = async () => c!.call('open', { path: csv, force_read_only: true }) as Promise<any>;
  const release = async (r: any) => { if (r.resource) await c!.call('releaseResource', { resource: r.resource.id }); };
  const query = async (session: string, sql: string, extra: Record<string, unknown> = {}) => c!.call('runQuery', { session, sql, max_rows: 100000, page_size: 1000, ...extra }) as Promise<any>;
  try {
    const started = performance.now(); await start(); let opened = await open();
    report('machine-and-caps', { platform: `${process.platform}/${process.arch}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, totalMemoryMiB: os.totalmem() / miB, coldOpenMs: performance.now() - started, caps: c!.capabilities.limits,
      managedEngineMemory: '512MB per connection, not process RSS', spill: '0B', aggregateRssBudget: null, defaultDeadlineMs: c!.capabilities.limits.deadline_ms, defaultHostGraceMs: 5000 });
    assert.equal(c!.capabilities.limits.max_frame_bytes, 32 * miB); assert.equal(c!.capabilities.limits.queued_requests, 8);
    if (!baselineOnly) {
    for (const sql of ["select rpad('', 5 * 1024 * 1024, 'x') as big", "select rpad('', 3 * 1024 * 1024, 'é') as big", "select rpad('', 1024 * 1024, 'x') as v from range(40)"]) {
      await rejected(query(opened.session, sql), ['resource_limit']);
    }
    const within = await query(opened.session, "select rpad('', 3 * 1024 * 1024, 'x') as ok");
    assert.equal(String(decodeRows(within.rows)[0][0]).length, 3 * miB); await release(within);
    assert.ok(c!.alive, 'budget refusals retain a usable reader');

    const warm: number[] = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); const r = await query(opened.session, `select * from rows50000 where region='n' and amount>=${i * 1000} limit 1000`); assert.ok(r.rows.length); await release(r); warm.push(performance.now() - t); }
    report('csv50000-warm', { p50Ms: percentile(warm, .5), p95Ms: percentile(warm, .95), rssMiB: rss(c!.pid!) });
    assert.ok(percentile(warm, .95) < 2000, 'existing PERF-01 warm p95 target; smaller50k feasibility workload');
    const handles: string[] = [];
    for (let i = 0; i < 64; i++) handles.push((await query(opened.session, 'select 1')).resource.id);
    await rejected(query(opened.session, 'select 1'), ['resource_limit']);
    await c!.call('releaseResource', { resource: handles.shift()! }); const freed = await query(opened.session, 'select 1'); handles.push(freed.resource.id);
    for (const resource of handles) await c!.call('releaseResource', { resource });
    report('held-resource-quota', { accepted: 64, refused: 1, reusableAfterRelease: true });

    for (const sql of ['select count(*) from range(1000000000) a, range(1000000000) b', 'select count(*) from range(100000000000) t(i) where hash(i)%7=0', 'with recursive r(n) as (select 1 union all select n+1 from r) select count(*) from r', "select length(string_agg(rpad('',1000,'x'),'')) from range(10000000)"]) {
      const t = performance.now(); const e = await rejected(c!.call('runQuery', { session: opened.session, sql }, { deadlineMs: 2500 }), ['deadline_exceeded', 'resource_limit', 'query_failed', 'worker_timeout', 'worker_exited']);
      const elapsed = performance.now() - t; assert.ok(elapsed < 6000, 'existing DOS-01 wall-clock gate');
      if (!c!.alive) { const old = c!.pid!; await c!.restart(); owned.add(c!.pid!); assert.equal(alive(old), false); opened = await open(); }
      const answer: any = await c!.call('runQuery', { session: opened.session, sql: 'select count(*) from rows50000', page_size: 1 }, { deadlineMs: 2000 });
      assert.equal(String(decodeRows(answer.rows)[0][0]), '50000'); await release(answer);
      report('deadline', { sql: sql.slice(0, 70), error: e.code, elapsedMs: elapsed, alive: c!.alive });
    }
    const ac = new AbortController(); const running = c!.call('runQuery', { session: opened.session, sql: 'select count(*) from range(100000000000) t(i) where hash(i)%7=0' }, { signal: ac.signal, deadlineMs: 2500 });
    await sleep(50); const cancelledAt = performance.now(); ac.abort(); await rejected(running, ['cancelled']); const cancellationMs = performance.now() - cancelledAt;
    assert.ok(cancellationMs < 250, 'published suggested cancellation acknowledgement target, measured on this machine');
    const continued = await query(opened.session, 'select 1'); await release(continued);
    report('cancel', { acknowledgementMs: cancellationMs });

    // Read-only observation of the production queue, not a substituted dispatcher.
    const transport = (c as unknown as { worker: { pending: Map<string, unknown>; waiting: unknown[] } }).worker;
    const stop = new AbortController(); const first = c!.call('runQuery', { session: opened.session, sql: 'select count(*) from range(100000000000) t(i) where hash(i)%7=0' }, { signal: stop.signal, deadlineMs: 2500 });
    const burst = Array.from({ length: 64 }, () => c!.call('ping').then(value => ({ ok: true, value }), error => ({ ok: false, error })));
    assert.ok(transport.pending.size <= 9); assert.ok(transport.waiting.length <= 32); stop.abort(); await rejected(first, ['cancelled']);
    const outcomes = await Promise.all(burst); assert.ok(outcomes.some(r => !r.ok && (r as any).error.code === 'queue_full')); assert.ok(outcomes.some(r => r.ok));
    assert.equal(transport.pending.size, 0); assert.equal(transport.waiting.length, 0);
    report('queue', { requests: 65, maxInFlight: 9, maxWaiting: 32, refused: outcomes.filter(r => !r.ok).length });
    await c!.call('close', { session: opened.session });
    const plateau: number[] = [];
    for (let i = 0; i < 50; i++) { const s = await open(); const r = await query(s.session, 'select * from rows50000 limit 1000'); await release(r); await c!.call('close', { session: s.session }); if (i % 10 === 9) plateau.push(rss(c!.pid!)); }
    assert.ok(plateau.at(-1)! - plateau[0] < 64, 'existing PERF-02/03 fifty-cycle retained RSS delta');
    report('open-close50', { rssMiB: plateau, retainedDeltaMiB: plateau.at(-1)! - plateau[0], scratch: disk(scratch) });
    assert.deepEqual(disk(scratch), { files: 0, bytes: 0 }, 'CSV engine spill disabled and owned scratch empty');

    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
    } else { await c!.call('close', { session: opened.session }); }
    opened = await open(); const matStarted = performance.now(); mat = await MatClient.open({ executable: matBinary, env }, matPath); owned.add(mat.pid!);
    const items = (await mat.catalog()).items; const find = (name: string) => { const item = items.find(i => i.info.name === name); assert.ok(item); return item; };
    const nd = await mat.slice(find('tensor').handle, ['1','1','1'], ['2','3','4']); assert.equal(nd.data.re!.length, 24);
    const sparse = await mat.sparse(find('sparse_values').handle, ['1','1'], ['1000000','1000000']); assert.equal(sparse.entries.length, 2);
    const matMs = performance.now() - matStarted;
    const pdfStarted = performance.now(); pdf = await createPdfHost({ extensionPath: root, globalStorageUri: { fsPath: path.join(state, 'pdf') } } as any, { scheme: 'file', fsPath: pdfPath } as any);
    const pdfPid = childPids(path.join(root, 'media/pdf/bin/dfv-pdf')); assert.equal(pdfPid.length, 1); owned.add(pdfPid[0]); pdfWorkerPid = pdfPid[0];
    const image: any = await pdf.request('render_page', { page: 0, dpi: 72 }); assert.equal(image.mime, 'image/png'); assert.ok(image.length > 0 && image.length <= 32 * miB);
    const samples = { table: rss(c!.pid!), mat: rss(mat.pid!), pdf: rss(pdfPid[0]), host: rss(process.pid) };
    report('three-feature-baseline', { rssMiB: samples, totalRssMiB: Object.values(samples).reduce((a,b)=>a+b,0), matOpenNdSparseMs: matMs, pdfOpenRenderMs: performance.now() - pdfStarted, scratch: disk(scratch), aggregatePassThreshold: null });
    sample();
    report('sampled-rss-peaks', { intervalMs: 100, samples: sampleCount, rssMiB: sampledPeak, scope: 'Node test host and its three native children; excludes VSCode/Chromium, sampling can miss shorter peaks', aggregatePassThreshold: null });
    clearInterval(sampler);
    const limitsBudget = JSON.parse(fs.readFileSync(path.join(root, 'native/resource-policy.json'), 'utf8')).budgets.rss_mib;
    assert.ok(sampledPeak.table <= limitsBudget.table_worker_each.value, `hostile-limits table worker RSS ${sampledPeak.table.toFixed(1)} MiB exceeds ${limitsBudget.table_worker_each.value} MiB`);
    assert.ok(sampledPeak.nativeTotal <= limitsBudget.aggregate_native.value, `hostile-limits native aggregate ${sampledPeak.nativeTotal.toFixed(1)} MiB exceeds ${limitsBudget.aggregate_native.value} MiB`);
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readdirSync(input).sort(), ['native.mat', 'rows50000.csv', 'simple.pdf']);
    await c!.close(); await mat.close(); pdf.dispose();
    await waitFor('all owned native workers reclaimed', () => [...owned].every(pid => !alive(pid)));
    assert.deepEqual(disk(scratch), { files: 0, bytes: 0 });
  } finally {
    clearInterval(sampler);
    await c?.close().catch(() => {}); await mat?.close().catch(() => {}); pdf?.dispose();
    for (const pid of owned) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native seven-document representative resource gate against the frozen native/resource-policy.json budgets', { skip: !enabled || !sevenDocument, timeout: 180000 }, async () => {
  assert.ok(tableBinary && matBinary && matFixture, 'pinned real native binaries and MAT fixture directory required');
  const python = process.env.DFV_FIXTURE_PYTHON;
  assert.ok(python, 'explicit myproject fixture writer runtime required; it is not used by any worker');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-native-seven-')));
  const input = path.join(dir, 'inputs'), scratch = path.join(dir, 'scratch'), state = path.join(dir, 'state');
  for (const p of [input, scratch, state]) fs.mkdirSync(p, { mode: 0o700 });
  const manifest = JSON.parse(execFileSync(python, [path.join(root, 'test/resources/createNativeMixedFixtures.py'), input, path.dirname(matFixture)], { encoding: 'utf8', timeout: 45000 }));
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sourceHashes = Object.fromEntries(Object.entries(manifest.files).map(([name, entry]: [string, any]) => {
    assert.equal(hash(path.join(input, name)), entry.sha256); return [name, entry.sha256];
  }));
  report('seven-fixtures', { ...manifest, tableWorkerSha256: hash(tableBinary), matWorkerSha256: hash(matBinary), pdfWorkerSha256: hash(path.join(root, 'media/pdf/bin/dfv-pdf')) });
  const documents: NativeDocument[] = [], pdfs: PdfHost[] = [];
  let mat: MatClient | undefined;
  const owned = new Set<number>(), cpuFirst = new Map<number, number>(), cpuLast = new Map<number, number>();
  const budgets = JSON.parse(fs.readFileSync(path.join(root, 'native/resource-policy.json'), 'utf8')).budgets;
  const peaks: Record<string, number> = {}, fdPeaks: Record<string, number> = {}, timings = new Map<string, number[]>();
  const startedAt = performance.now();
  let sampledNativePeak = 0, sampledTotalPeak = 0, observedTableMatIpcPeak = 0, samples = 0, peakScratch = 0, peakPdfWork = 0, peakRecovery = 0;
  const pids = new Map<number, string>([[process.pid, 'node-test-host']]);
  const seconds = (time: string) => time.split(':').reduce((n, part) => n * 60 + Number(part), 0);
  const sample = () => {
    for (const worker of nativeWorkerUsage().workers) if (worker.pid !== undefined && !pids.has(worker.pid)) { pids.set(worker.pid, `${worker.feature}-${worker.pid}`); owned.add(worker.pid); }
    const output = execFileSync('ps', ['-o', 'pid=,rss=,time=', '-p', [...pids.keys()].join(',')], { encoding: 'utf8' });
    let native = 0, total = 0;
    for (const row of output.trim().split('\n')) {
      const [pidText, kibText, time] = row.trim().split(/\s+/), pid = Number(pidText), label = pids.get(pid)!;
      const memory = Number(kibText) / 1024, cpu = seconds(time);
      peaks[label] = Math.max(peaks[label] ?? 0, memory); total += memory; if (pid !== process.pid) native += memory;
      if (!cpuFirst.has(pid)) cpuFirst.set(pid, cpu); cpuLast.set(pid, cpu);
    }
    let ipc = 0;
    for (const worker of [...documents.map(d => (d as any).client.worker), ...(mat ? [(mat as any).worker] : [])]) {
      for (const request of [...worker.pending.values(), ...worker.waiting]) ipc += request.frame.length;
      ipc += worker.buffered;
    }
    observedTableMatIpcPeak = Math.max(observedTableMatIpcPeak, ipc);
    sampledNativePeak = Math.max(sampledNativePeak, native); sampledTotalPeak = Math.max(sampledTotalPeak, total);
    peakScratch = Math.max(peakScratch, disk(scratch).bytes);
    if (fs.existsSync(path.join(state, 'pdf-work'))) peakPdfWork = Math.max(peakPdfWork, disk(path.join(state, 'pdf-work')).bytes);
    if (fs.existsSync(path.join(state, 'pdf-recovery'))) peakRecovery = Math.max(peakRecovery, disk(path.join(state, 'pdf-recovery')).bytes);
    samples++;
  };
  // Only numeric FD rows count; txt/cwd/mem rows are mapped libraries, not handles the worker can exhaust.
  const sampleFds = () => {
    const workers = [...pids.keys()].filter(pid => pid !== process.pid);
    if (!workers.length) return;
    const out = execFileSync('lsof', ['-n', '-p', workers.join(',')], { encoding: 'utf8', maxBuffer: 64 * miB });
    const counts = new Map<number, number>();
    for (const line of out.split('\n').slice(1)) { const c = line.trim().split(/\s+/); if (/^\d+[a-zA-Z]?$/.test(c[3] ?? '')) counts.set(Number(c[1]), (counts.get(Number(c[1])) ?? 0) + 1); }
    for (const [pid, n] of counts) { const label = pids.get(pid)!; fdPeaks[label] = Math.max(fdPeaks[label] ?? 0, n); }
  };
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const first = !timings.has(name);
    if (first) report('seven-operation-start', { operation: name });
    const start = performance.now(); try { return await run(); }
    finally { const values = timings.get(name) ?? []; values.push(performance.now() - start); timings.set(name, values); if (first) report('seven-operation-end', { operation: name, elapsedMs: values[0] }); }
  };
  const own = (pid: number, label: string) => {
    const previous = pids.get(pid);
    if (previous && previous !== label) { peaks[label] = Math.max(peaks[label] ?? 0, peaks[previous] ?? 0); delete peaks[previous]; }
    owned.add(pid); pids.set(pid, label);
  };
  let sampler: NodeJS.Timeout | undefined;
  try {
    sample(); sampler = setInterval(sample, 100);
    for (const name of ['simple.pdf', 'image-heavy.pdf']) {
      const host = await timed(`open-${name}`, () => createPdfHost({ extensionPath: root, globalStorageUri: { fsPath: state } } as any, { scheme: 'file', fsPath: path.join(input, name) } as any));
      pdfs.push(host);
      const worker = nativeWorkerUsage().workers.filter(w => w.feature === 'pdf').at(-1); assert.ok(worker?.pid); own(worker.pid, name);
    }
    for (const name of ['rows200000.csv', 'rows200000.parquet', 'rows200000.sqlite', 'sheets50.xlsx']) {
      const document = await timed(`open-${name}`, () => NativeDocument.open({ executable: tableBinary, env: { TMPDIR: scratch, DFV_TABLE_STATE_DIR: path.join(state, name) } }, path.join(input, name), undefined, name.endsWith('.csv') ? {} : { forceReadOnly: true }));
      documents.push(document); own((document as any).client.pid, name);
    }
    mat = await timed('open-combined.mat', () => MatClient.open({ executable: matBinary, env: { TMPDIR: scratch } }, path.join(input, 'combined.mat'))); own(mat.pid!, 'combined.mat');
    assert.equal(nativeWorkerUsage().workers.length, 7);
    const catalog: MatItem[] = [];
    for (let offset = 0; offset < 1003; offset += 100) catalog.push(...(await mat.catalog(String(offset))).items);
    assert.equal(catalog.length, 1003);
    const value = (name: string) => { const item = catalog.find(item => item.info.name === name); assert.ok(item, name); return item; };
    assert.equal(scalarText((await mat.slice(value('v1000').handle, ['1', '1'], ['1', '1'])).data.re![0]), '1000000007000');
    const tables = await Promise.all(documents.map(d => d.listTables()));
    const regular = tables.slice(0, 3).map(names => { assert.equal(names.length, 1); return `select id, amount from "${names[0].replace(/"/g, '""')}"`; });
    for (let i = 0; i < 3; i++) assert.equal(await documents[i].countMatchingRows(regular[i]), 200000);
    await documents[3].runQuery('select * from "Sheet0" limit 1000', 1000, 'Sheet0');
    const detected = documents[3].getDetectedSheetTables('Sheet0'); assert.equal(detected.length, 10);
    const xlsxSql = await documents[3].buildDetectedTableQuery(detected[0].name);
    const backup = await timed('csv-backup', () => documents[0].createBackup());
    const retained = await timed('csv-retain100000', () => documents[0].runQuery(`${regular[0]} order by id limit 100000`, 100000));
    assert.equal(retained.rows.length, 100000);
    const unchanged = await timed('csv-diff100000', () => documents[0].diffQueryAgainstBackup(`${regular[0]} order by id limit 100000`, retained.columns, retained.rows));
    assert.ok(unchanged, 'an available backup returns a positional diff, including unchanged cells');
    assert.equal(unchanged.cellChanged.length, 100000);
    assert.equal(unchanged.cellChanged.every(row => row.length === 2 && row.every(changed => !changed)), true);
    assert.equal(unchanged.rowIsNew.length, 100000); assert.equal(unchanged.rowIsNew.some(Boolean), false);
    assert.deepEqual(unchanged.renamedColumns, {});
    sample(); report('seven-retained100000', { hostRssMiB: rss(process.pid), sourceBackupBytes: fs.statSync(backup).size, rows: retained.rows.length, weakWireSnapshotRetained: true });
    for (let round = 0; round < 20; round++) {
      await Promise.all([
        ...documents.slice(0, 3).map((document, i) => timed(`query-${i}`, async () => {
          const answer = await document.runQuery(`${regular[i]} where amount>=${round * 1000} limit 1000`, 1000); assert.equal(answer.rows.length, 1000);
        })),
        timed('xlsx-detected', async () => { const answer = await documents[3].runQuery(xlsxSql, 1000); assert.equal(answer.rows.length, 4); }),
        ...pdfs.map((pdf, i) => timed(`render-pdf${i}`, async () => { const image: any = await pdf.request('render_page', { page: round % (i ? 5 : 12), dpi: 100 }); assert.equal(image.mime, 'image/png'); assert.ok(image.length > 0 && image.length <= 32 * miB); })),
        timed('mat-ND', async () => assert.equal((await mat!.slice(value('tensor').handle, ['1', '1', '1'], ['2', '3', '4'])).data.re!.length, 24)),
        timed('mat-sparse', async () => assert.equal((await mat!.sparse(value('sparse_values').handle, ['1', '1'], ['1000000', '1000000'])).entries.length, 2)),
      ]);
      await Promise.all(documents.slice(0, 3).map((document, i) => timed(`sort-stats-chart-${i}`, async () => {
        assert.equal((await document.runSortedQuery(regular[i], 'amount', 'desc', 1000)).rows.length, 1000);
        assert.equal((await document.getColumnDescriptiveStats(regular[i], 'amount', 'numeric')).totalRows, 200000);
        assert.equal((await document.runChartQuery(`${regular[i]} limit 3000`, 'id', ['amount'], false, 3000)).rows.length, 3000);
      })));
      if (round % 5 === 0) {
        const info: any = await pdfs[0].request('get_state', {});
        const search: any = await timed('pdf-search', () => pdfs[0].request('start_search', { query: 'baseline', revision: info.revision }));
        assert.equal(typeof search.search_id, 'string');
        await pdfs[0].request('read_search', { search_id: search.search_id, cursor: 0, limit: 100 });
        await pdfs[0].request('cancel_search', { search_id: search.search_id });
      }
      if (round % 5 === 4) { sample(); sampleFds(); report('seven-progress', { rounds: round + 1, sampledNativePeakMiB: sampledNativePeak, sampledTotalPeakMiB: sampledTotalPeak }); }
    }
    assert.equal(retained.rows.length, 100000, 'table and exact-wire snapshot remain retained for the measured workload');
    for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hash(path.join(input, name)), expected);
    sample(); sampleFds();
    const wallSeconds = (performance.now() - startedAt) / 1000, cpuSeconds = Object.fromEntries([...pids].map(([pid, label]) => [label, (cpuLast.get(pid) ?? 0) - (cpuFirst.get(pid) ?? 0)]));
    report('seven-document-measurement', { wallSeconds, fdPeaksPerWorker: fdPeaks, rounds: 20, samplingMs: 100, samples, perProcessSampledPeakRssMiB: peaks,
      simultaneousSampledNativePeakRssMiB: sampledNativePeak, simultaneousSampledNativeAndNodePeakRssMiB: sampledTotalPeak,
      cpuSecondsFromFirstObservation: Object.fromEntries([...pids].map(([pid, label]) => [label, (cpuLast.get(pid) ?? 0) - (cpuFirst.get(pid) ?? 0)])),
      tableMatSampledEncodedIpcPeakBytes: observedTableMatIpcPeak, aggregateIpcPeakBytes: null, pdfHostIpcPeakBytes: null,
      temporaryPeakBytes: { sharedNativeScratch: peakScratch, pdfPrivateWork: peakPdfWork, pdfRecovery: peakRecovery },
      timingsMs: Object.fromEntries([...timings].map(([name, values]) => [name, { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95) }])),
      acceptance: 'asserted against native/resource-policy.json budgets frozen before this run; excludes Code/Chromium; 100ms sampling can miss shorter peaks; CPU begins at first observation; independent process peaks are summed only for the aggregate row' });
    // Budgets frozen in native/resource-policy.json before measurement; the justification for every number lives there.
    const classes = (label: string) => label.endsWith('.pdf') ? 'pdf' : label.endsWith('.mat') ? 'mat' : 'table';
    const rssCeiling = { table: budgets.rss_mib.table_worker_each.value, pdf: budgets.rss_mib.pdf_worker_each.value, mat: budgets.rss_mib.mat_worker.value };
    const threads = Math.max(1, Math.floor(os.cpus().length / 2));
    const cpuCeiling = { table: threads + 1, pdf: budgets.cpu.pdf_and_mat_cpu_per_wall_second, mat: budgets.cpu.pdf_and_mat_cpu_per_wall_second };
    for (const [label, peak] of Object.entries(peaks)) {
      if (label === 'node-test-host') continue;
      const kind = classes(label);
      assert.ok(peak <= rssCeiling[kind], `${label} RSS ${peak.toFixed(1)} MiB exceeds ${rssCeiling[kind]} MiB`);
      assert.ok(cpuSeconds[label] <= cpuCeiling[kind] * wallSeconds, `${label} CPU ${cpuSeconds[label].toFixed(1)}s exceeds ${cpuCeiling[kind]} x ${wallSeconds.toFixed(1)}s`);
      assert.ok((fdPeaks[label] ?? 0) <= budgets.handles.open_file_descriptors_per_worker, `${label} holds ${fdPeaks[label]} descriptors`);
    }
    assert.ok(sampledNativePeak <= budgets.rss_mib.aggregate_native.value, `native aggregate ${sampledNativePeak.toFixed(1)} MiB exceeds ${budgets.rss_mib.aggregate_native.value} MiB`);
    assert.ok(observedTableMatIpcPeak <= 5 * budgets.ipc_bytes.per_worker_pending, 'sampled table/MAT pending IPC exceeds five worker budgets');
    const pdfBytes = ['simple.pdf', 'image-heavy.pdf'].reduce((n, name) => n + fs.statSync(path.join(input, name)).size, 0);
    assert.ok(peakScratch <= fs.statSync(path.join(input, 'rows200000.csv')).size, 'native scratch exceeds one CSV backup copy');
    assert.ok(peakPdfWork <= 2 * pdfBytes && peakRecovery <= 2 * pdfBytes, 'PDF private work or recovery exceeds twice the PDF sources');
  } finally {
    if (sampler) clearInterval(sampler);
    await Promise.all(documents.map(document => document.close().catch(() => {}))); await mat?.close().catch(() => {}); for (const pdf of pdfs) pdf.dispose();
    await waitFor('seven-document workers reclaimed', () => [...owned].every(pid => !alive(pid)));
    assert.deepEqual(disk(scratch), { files: 0, bytes: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// V21: two PDFs, four datasets and MAT under the frozen budgets, repeating open/close, refresh, edit and worker kills.
// DFV_SOAK_SECONDS defaults to 1800 (the required 30 minutes); a shorter value is a smoke run and earns no credit.
test(`mixed-feature soak ${soakSeconds}s: repeated open/close, refresh, edit and worker kills under the frozen budgets`, { skip: !enabled || !soak, timeout: (soakSeconds + 300) * 1000 }, async () => {
  assert.ok(tableBinary && matBinary && matFixture && process.env.DFV_FIXTURE_PYTHON, 'pinned workers, MAT fixture directory and fixture writer runtime required');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-native-soak-')));
  const input = path.join(dir, 'inputs'), scratch = path.join(dir, 'scratch'), state = path.join(dir, 'state');
  for (const p of [input, scratch, state]) fs.mkdirSync(p, { mode: 0o700 });
  const manifest = JSON.parse(execFileSync(process.env.DFV_FIXTURE_PYTHON, [path.join(root, 'test/resources/createNativeMixedFixtures.py'), input, path.dirname(matFixture)], { encoding: 'utf8', timeout: 60000 }));
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const budgets = JSON.parse(fs.readFileSync(path.join(root, 'native/resource-policy.json'), 'utf8')).budgets;
  const names = ['rows200000.csv', 'rows200000.parquet', 'rows200000.sqlite', 'sheets50.xlsx'], pdfNames = ['simple.pdf', 'image-heavy.pdf'];
  const readOnlyHashes = Object.fromEntries(Object.keys(manifest.files).filter(n => n !== names[0]).map(n => [n, hash(path.join(input, n))]));
  const csvPath = path.join(input, names[0]);
  const csvText = fs.readFileSync(csvPath, 'utf8'), eol = csvText.includes('\r\n') ? '\r\n' : '\n';
  const csvLines = csvText.split(eol); assert.equal(csvLines.pop(), ''); assert.equal(csvLines.length, 200001);
  const csvBytes = fs.statSync(csvPath).size;
  const docs: NativeDocument[] = [], pdfs: PdfHost[] = [], pdfPids: (number | undefined)[] = [];
  let mat!: MatClient, tensor!: MatItem, sparse!: MatItem, xlsxSql = '';
  const seen = new Set<number>(), sql: string[] = [];
  const series: { t: number; table: number; pdf: number; mat: number; workers: number; scratch: number }[] = [];
  const counts = { cycles: 0, edits: 0, reopens: 0, kills: { table: 0, pdf: 0, mat: 0 } };
  const cycleMs: number[] = [];
  const t0 = performance.now();
  const livePdfPids = () => nativeWorkerUsage().workers.filter(w => w.feature === 'pdf' && w.pid !== undefined).map(w => w.pid!);
  const sampleNow = () => {
    const usage = nativeWorkerUsage(), live = usage.workers.filter(w => w.pid !== undefined);
    assert.ok(usage.workers.length <= usage.limit, 'worker admission cap exceeded');
    const wanted = live.map(w => w.pid!); for (const pid of wanted) seen.add(pid);
    let rows = '';
    if (wanted.length) { try { rows = execFileSync('ps', ['-o', 'pid=,rss=', '-p', wanted.join(',')], { encoding: 'utf8' }); } catch (e: any) { rows = String(e.stdout ?? ''); } }
    const rssOf = new Map(rows.trim().split('\n').filter(Boolean).map(r => { const [pid, kib] = r.trim().split(/\s+/).map(Number); return [pid, kib / 1024] as const; }));
    const sum = (feature: string) => live.filter(w => w.feature === feature).reduce((n, w) => n + (rssOf.get(w.pid!) ?? 0), 0);
    series.push({ t: (performance.now() - t0) / 1000, table: sum('table'), pdf: sum('pdf'), mat: sum('mat'), workers: usage.workers.length, scratch: disk(scratch).bytes });
  };
  const openDoc = async (i: number) => {
    docs[i] = await NativeDocument.open({ executable: tableBinary, env: { TMPDIR: scratch, DFV_TABLE_STATE_DIR: path.join(state, names[i]) } }, path.join(input, names[i]), undefined, i === 0 ? {} : { forceReadOnly: true });
    seen.add((docs[i] as any).client.pid);
    if (i === 3) { await docs[3].runQuery('select * from "Sheet0" limit 10', 10, 'Sheet0'); xlsxSql = await docs[3].buildDetectedTableQuery(docs[3].getDetectedSheetTables('Sheet0')[0].name); }
    else { const tables = await docs[i].listTables(); assert.equal(tables.length, 1); sql[i] = `select id, amount from "${tables[0].replace(/"/g, '""')}"`; }
  };
  const openPdf = async (i: number) => {
    const before = new Set(livePdfPids());
    pdfs[i] = await createPdfHost({ extensionPath: root, globalStorageUri: { fsPath: state } } as any, { scheme: 'file', fsPath: path.join(input, pdfNames[i]) } as any);
    pdfPids[i] = livePdfPids().find(pid => !before.has(pid)); assert.ok(pdfPids[i]);
  };
  const openMat = async () => {
    mat = await MatClient.open({ executable: matBinary, env: { TMPDIR: scratch } }, path.join(input, 'combined.mat')); seen.add(mat.pid!);
    const found: MatItem[] = [];
    for (let offset = 0; offset < 1003 && found.length < 2; offset += 100) found.push(...(await mat.catalog(String(offset))).items.filter(item => item.info.name === 'tensor' || item.info.name === 'sparse_values'));
    tensor = found.find(i => i.info.name === 'tensor')!; sparse = found.find(i => i.info.name === 'sparse_values')!; assert.ok(tensor && sparse);
  };
  const work = async (cycle: number) => {
    const i = cycle % 3;
    await Promise.all([
      ...[0, 1, 2].map(k => docs[k].runQuery(`${sql[k]} where amount>=${(cycle % 50) * 1000} limit 1000`, 1000).then(a => assert.equal(a.rows.length, 1000))),
      docs[3].runQuery(xlsxSql, 1000).then(a => assert.equal(a.rows.length, 4)),
      ...pdfs.map((pdf, k) => pdf.request('render_page', { page: cycle % (k ? 5 : 12), dpi: 100 }).then((img: any) => assert.equal(img.mime, 'image/png'))),
      mat.slice(tensor.handle, ['1', '1', '1'], ['2', '3', '4']).then(r => assert.equal(r.data.re!.length, 24)),
      mat.sparse(sparse.handle, ['1', '1'], ['1000000', '1000000']).then(r => assert.equal(r.entries.length, 2)),
    ]);
    assert.equal((await docs[i].runSortedQuery(sql[i], 'amount', 'desc', 1000)).rows.length, 1000);
    assert.equal((await docs[i].getColumnDescriptiveStats(sql[i], 'amount', 'numeric')).totalRows, 200000);
  };
  const editCsv = async (cycle: number) => {
    const id = (cycle * 7919) % 200000, row = csvLines[id + 1].split(','), value = String(100000 + cycle % 1000);
    const table = (await docs[0].listTables())[0];
    await docs[0].createBackup();
    assert.equal(await docs[0].updateCell(table, 'amount', value, { id: row[0], region: row[1], amount: row[2], day: row[3] }), 1);
    csvLines[id + 1] = [row[0], row[1], value, row[3]].join(',');
    assert.equal(fs.readFileSync(csvPath, 'utf8'), csvLines.join(eol) + eol, 'only the intended CSV cell changed');
    await docs[0].close(); await openDoc(0); counts.edits++;           // reopening drops the backup copy and proves the saved value
    const answer = await docs[0].runQuery(`select amount from "${table}" where id=${id}`, 1);
    assert.equal(String(decodeRows(answer.rows)[0][0]), value);
  };
  const killOrder = ['table:1', 'pdf:0', 'mat', 'table:2', 'pdf:1', 'table:3', 'table:0'];
  const kill = async (target: string) => {
    const [kind, index] = target.split(':'), i = Number(index);
    if (kind === 'mat') {
      const pid = mat.pid!; process.kill(pid, 'SIGKILL'); await waitFor('MAT worker reaped', () => !alive(pid));
      await assert.rejects(mat.catalog()); await mat.close().catch(() => {}); await openMat(); counts.kills.mat++;
    } else if (kind === 'pdf') {
      const pid = pdfPids[i]!; process.kill(pid, 'SIGKILL'); await waitFor('PDF worker reaped', () => !alive(pid));
      await assert.rejects(pdfs[i].request('get_state', {}), /WORKER_RESTARTED|restarted|stopped/i);   // the host restarts it once; edits are not replayed
      await pdfs[i].request('get_state', {});
      pdfPids[i] = livePdfPids().find(p => p !== pdfPids[1 - i] && p !== pid); assert.ok(pdfPids[i]); seen.add(pdfPids[i]!); counts.kills.pdf++;
    } else {
      const pid = (docs[i] as any).client.pid as number; process.kill(pid, 'SIGKILL'); await waitFor('table worker reaped', () => !alive(pid));
      await assert.rejects(docs[i].runQuery('select 1')); await docs[i].close().catch(() => {}); await openDoc(i); counts.kills.table++;
    }
    assert.ok(nativeWorkerUsage().workers.length <= 7, 'a replacement must not leave the killed worker\'s slot occupied');
  };
  const sampler = setInterval(() => { try { sampleNow(); } catch {} }, 1000);
  try {
    for (let i = 0; i < 2; i++) await openPdf(i);
    for (let i = 0; i < 4; i++) await openDoc(i);
    await openMat(); assert.equal(nativeWorkerUsage().workers.length, 7);
    const killEvery = Math.max(15, soakSeconds / 14) * 1000; let nextKill = performance.now() + killEvery;
    report('soak-start', { seconds: soakSeconds, killEverySeconds: killEvery / 1000, tableWorkerSha256: hash(tableBinary), matWorkerSha256: hash(matBinary) });
    for (let cycle = 0; performance.now() - t0 < soakSeconds * 1000; cycle++) {
      const started = performance.now();
      await work(cycle);
      if (cycle % 4 === 3) { const i = (cycle >> 2) % 4; await docs[i].close(); await openDoc(i); counts.reopens++; }
      if (cycle % 6 === 5) await editCsv(cycle);
      if (performance.now() >= nextKill) { await kill(killOrder[(counts.kills.table + counts.kills.pdf + counts.kills.mat) % killOrder.length]); nextKill = performance.now() + killEvery; }
      assert.equal(nativeWorkerUsage().workers.length, 7, 'exactly the seven expected workers after every cycle');
      if (cycle % 20 === 19) for (const [name, expected] of Object.entries(readOnlyHashes)) assert.equal(hash(path.join(input, name)), expected, `${name} source changed`);
      counts.cycles++; cycleMs.push(performance.now() - started);
      if (cycle % 25 === 24) { sampleNow(); report('soak-progress', { cycle: cycle + 1, elapsedSeconds: (performance.now() - t0) / 1000, counts, latest: series.at(-1) }); }
    }
    sampleNow(); clearInterval(sampler);
    for (const [name, expected] of Object.entries(readOnlyHashes)) assert.equal(hash(path.join(input, name)), expected, `${name} source changed`);
    assert.equal(fs.readFileSync(csvPath, 'utf8'), csvLines.join(eol) + eol);
    assert.ok(counts.kills.table >= 1 && counts.kills.pdf >= 1 && counts.kills.mat >= 1, `every worker class must have been killed: ${JSON.stringify(counts.kills)}`);
    // Plateau: ignore the first third as warm-up, then the last third's maximum may not exceed the middle third's by more than the retained-delta budget.
    const total = series.at(-1)!.t, third = (lo: number, hi: number, key: 'table' | 'pdf' | 'mat') => Math.max(...series.filter(x => x.t >= total * lo && x.t < total * hi + (hi === 1 ? 1 : 0)).map(x => x[key]));
    const workersIn = { table: 4, pdf: 2, mat: 1 };
    const drift = Object.fromEntries((['table', 'pdf', 'mat'] as const).map(k => [k, third(2 / 3, 1, k) - third(1 / 3, 2 / 3, k)]));
    const peakTotal = Math.max(...series.map(x => x.table + x.pdf + x.mat)), peakScratch = Math.max(...series.map(x => x.scratch));
    report('soak-measurement', { seconds: (performance.now() - t0) / 1000, counts, samples: series.length, peakNativeMiB: peakTotal, driftMiB: drift,
      peakByClassMiB: { table: Math.max(...series.map(x => x.table)), pdf: Math.max(...series.map(x => x.pdf)), mat: Math.max(...series.map(x => x.mat)) },
      scratchPeakBytes: peakScratch, cycleMs: { p50: percentile(cycleMs, .5), p95: percentile(cycleMs, .95) }, distinctWorkersSeen: seen.size });
    assert.ok(peakTotal <= budgets.rss_mib.aggregate_native.value, `aggregate native ${peakTotal.toFixed(1)} MiB exceeds budget`);
    for (const k of ['table', 'pdf', 'mat'] as const) assert.ok(drift[k] <= budgets.rss_mib.retained_delta_per_worker.value * workersIn[k], `${k} RSS did not plateau: +${drift[k].toFixed(1)} MiB`);
    assert.ok(peakScratch <= csvBytes, 'scratch exceeded one CSV backup copy');
    assert.ok(series.every(x => x.workers <= 8));
  } finally {
    clearInterval(sampler);
    await Promise.all(docs.map(d => d.close().catch(() => {}))); await mat?.close().catch(() => {}); for (const pdf of pdfs) pdf.dispose();
    await waitFor('no orphan workers after the soak', () => [...seen].every(pid => !alive(pid)), 20000);
    assert.deepEqual(disk(scratch), { files: 0, bytes: 0 }, 'native scratch empty after shutdown');
    assert.deepEqual(childPids('dfv-table').concat(childPids('dfv-mat'), childPids('dfv-pdf')), [], 'no worker children remain');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
