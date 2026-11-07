// PERF-X1 benchmark: workbook preparation cost by phase, per fixture, each fixture
// in its own Node process so peak RSS is isolated.
//
// usage: node test/perf/perfX1Bench.cjs --root <checkout> --out <result.json> [--fixtures <dir>] [--cold N] [--warm N]
//        (internal) node test/perf/perfX1Bench.cjs --child <fixture> --root <checkout> --fixtures <dir> --cold N --warm N
//
// <checkout> must hold a compiled out-test/ (npm run test's tsc step). The same
// harness runs against an older checkout for a before/after comparison: phase
// metrics are read when the checkout has getPreparationMetrics(); detector calls
// are always counted by wrapping backend/excel/detect.detectSheetGrid.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? acc.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]]) : acc), []));
const root = path.resolve(args.root ?? '.');
const fixturesDir = path.resolve(args.fixtures ?? path.join(os.tmpdir(), 'dfv-perfx1-fixtures'));
const COLD = Number(args.cold ?? 7);
const WARM = Number(args.warm ?? 20);
const NATIVE = args.backend === 'native';

const header = ['id', 'value'];
const active = () => [header, ...Array.from({ length: 100 }, (_, i) => [i, `active-${i}`])];
const filler = (tag, rows = 2000, cols = 5) => [Array.from({ length: cols }, (_, c) => `c${c}`),
  ...Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (c === 0 ? r : `${tag}-${r}-${c}`)))];

/** Every fixture's active sheet is the first sheet; only that one is ever queried. */
const FIXTURES = {
  'sheets-1': () => [{ name: 'Active', rows: active() }],
  'sheets-20': () => [{ name: 'Active', rows: active() }, ...Array.from({ length: 19 }, (_, i) => ({ name: `S${i}`, rows: filler(`s${i}`) }))],
  'sheets-100': () => [{ name: 'Active', rows: active() }, ...Array.from({ length: 99 }, (_, i) => ({ name: `S${i}`, rows: filler(`s${i}`) }))],
  tall: () => [{ name: 'Active', rows: [['id', 'a', 'b'], ...Array.from({ length: 200_000 }, (_, i) => [i, i * 0.5, `t${i % 97}`])] }],
  wide: () => [{ name: 'Active', rows: [Array.from({ length: 1000 }, (_, c) => `h${c}`), ...Array.from({ length: 200 }, (_, r) => Array.from({ length: 1000 }, (_, c) => r * 1000 + c))] }],
  sparse: () => {
    const rows = Array.from({ length: 5000 }, () => []);
    rows[0] = ['id', 'note'];
    for (let r = 1; r < 5000; r += 97) rows[r] = [r, `n${r}`];
    for (let r = 2500; r < 2510; r++) { rows[r] = []; rows[r][150] = `far-${r}`; }
    return [{ name: 'Active', rows }];
  },
  'table-40k': () => [{ name: 'Active', rows: [Array.from({ length: 10 }, (_, c) => `k${c}`), ...Array.from({ length: 40_000 }, (_, r) => Array.from({ length: 10 }, (_, c) => (c % 3 === 0 ? r + c : c % 3 === 1 ? (r * 0.25) + c : `v${(r * 7 + c) % 500}`)))] }],
  'sheets-10': () => [{ name: 'Active', rows: active() }, ...Array.from({ length: 9 }, (_, i) => ({ name: `Big${i}`, rows: [Array.from({ length: 10 }, (_, c) => `k${c}`), ...Array.from({ length: 40_000 }, (_, r) => Array.from({ length: 10 }, (_, c) => (c % 2 ? `b${i}-${r}-${c}` : r + c)))] }))],
  // Two populated cells but a 10,000,000-cell extent (the per-sheet limit): measures extent-driven dense materialisation.
  'sparse-extent': () => { const rows = Array.from({ length: 100_000 }, () => []); rows[0] = ['id']; rows[99_999][99] = 'far'; return [{ name: 'Active', rows }]; },
  dense: () => [{ name: 'Active', rows: [Array.from({ length: 25 }, (_, c) => `d${c}`), ...Array.from({ length: 20_000 }, (_, r) => Array.from({ length: 25 }, (_, c) => (c % 2 ? r + c : `v${(r * 31 + c) % 1000}`)))] }],
};

const pct = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const stats = values => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length ? Math.max(...values) : null });

async function child(name) {
  if (NATIVE) assert.ok(process.env.DFV_TABLE_WORKER && fs.existsSync(process.env.DFV_TABLE_WORKER),'DFV_TABLE_WORKER must name the actual native worker');
  const req = m => require(path.join(root, 'out-test', m));
  const { DuckDbFile } = NATIVE ? {} : req('src/duckdbConnection');
  const { NativeDocument } = NATIVE ? req('src/backend/nativeDocument') : {};
  const detect = NATIVE ? undefined : req('src/backend/excel/detect');
  const { xlsxFile } = req('test/stress/generators/_write');
  let detectorCalls = 0;
  const original = detect?.detectSheetGrid;
  if (detect) detect.detectSheetGrid = (...a) => { detectorCalls++; return original(...a); };
  const file = path.join(fixturesDir, `${name}.xlsx`);
  if (!fs.existsSync(file)) { fs.mkdirSync(fixturesDir, { recursive: true }); await xlsxFile(file, FIXTURES[name]()); }
  const bytes = fs.statSync(file).size;
  const sourceSha = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originalSha = sourceSha();
  const sampleRss = () => process.memoryUsage().rss;
  let peakRss = sampleRss();
  let nativePid, nativePeakRss = 0;
  const nativePids = [];
  const sampleNative = () => {
    if (!nativePid) return;
    try { const rss = Number(execFileSync('ps',['-o','rss=','-p',String(nativePid)],{encoding:'utf8'}).trim())*1024;
      if (Number.isFinite(rss)) nativePeakRss = Math.max(nativePeakRss,rss);
    } catch { /* The owned worker can exit between sampling ticks. */ }
  };
  if (NATIVE) {
    const { NativeTableClient } = req('src/backend/native');
    const start = NativeTableClient.start;
    NativeTableClient.start = async (...a) => { const client = await start.apply(NativeTableClient,a); nativePid=client.pid;nativePids.push(nativePid);sampleNative();return client; };
  }
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, sampleRss()); sampleNative(); }, NATIVE ? 100 : 5);
  sampler.unref();
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  const open = [], first = [], warm = [], catalog = [], derivedFirst = [], phases = {};
  let lastMetrics, detectorPerOpen = []; const visitSamples = [];
  for (let i = 0; i < COLD; i++) {
    const before = detectorCalls;
    let t = performance.now();
    const doc = NATIVE ? await NativeDocument.open({executable:process.env.DFV_TABLE_WORKER},file) : await DuckDbFile.open(file);
    open.push(performance.now() - t);
    try {
      t = performance.now(); const firstResult = await doc.runQuery('select * from "Active" limit 100',0,NATIVE?'Active':undefined); first.push(performance.now() - t);
      if (name.startsWith('sheets-')) { assert.equal(firstResult.rows.length,100);assert.deepEqual(firstResult.rows[0],['id','value']); }
      t = performance.now(); await doc.getQueryCatalog(0); catalog.push(performance.now() - t);
      if (i === COLD - 1) for (let w = 0; w < WARM; w++) { t = performance.now(); await doc.runQuery('select * from "Active" limit 100',0,NATIVE?'Active':undefined); warm.push(performance.now() - t); }
      const table = doc.getDetectedSheetTables('Active')[0]?.name;
      if (table) { t = performance.now(); await doc.runQuery(`select * from "${table}" limit 100`); derivedFirst.push(performance.now() - t); }
      if (args.visit && NATIVE) {
        // Visit every other worksheet once: the cache must stay inside its byte budget and the worker's RSS bounded.
        const visits = [];
        for (const sheet of (await doc.listTables()).filter(n => n !== 'Active' && doc.isWorksheet(n))) {
          t = performance.now(); await doc.runQuery(`select * from "${sheet}" limit 100`, 0, sheet); visits.push(performance.now() - t);
          const m = doc.getPreparationMetrics();
          visitSamples.push({ sheet, ms: visits.at(-1), cachedObjects: m.cachedObjects, cacheEstimatedBytes: m.cacheEstimatedBytes, cacheEvictions: m.cacheEvictions, cacheRestores: m.cacheRestores, detectorCalls: m.detectorCalls });
          sampleNative();
        }
      }
      if (!NATIVE) detectorPerOpen.push(detectorCalls - before);
      if (typeof doc.getPreparationMetrics === 'function') {
        lastMetrics = doc.getPreparationMetrics();
        if (NATIVE) detectorPerOpen.push(lastMetrics.detectorCalls);
        for (const [phase, v] of Object.entries(lastMetrics.phases)) (phases[phase] ??= []).push(v.totalMs);
      }
    } finally { sampleNative(); if (NATIVE) {await doc.close();nativePid=undefined;} else doc.dispose(); }
  }
  clearInterval(sampler); loop.disable();
  assert.equal(sourceSha(),originalSha,'benchmark never changes source');
  for (const pid of nativePids) assert.throws(() => process.kill(pid,0),e => e.code === 'ESRCH','owned worker closed');
  const usage = process.resourceUsage();
  const metricsAvailable = lastMetrics !== undefined && Object.keys(lastMetrics.phases).length>0;
  return {
    fixture: name, fixtureBytes: bytes,
    coldRuns: COLD, warmRuns: WARM,
    openMs: stats(open), firstActiveQueryMs: stats(first), warmActiveQueryMs: stats(warm),
    catalogMs: stats(catalog), derivedFirstUseMs: stats(derivedFirst),
    phaseTotalMsPerOpen: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, stats(v)])),
    detectorCallsPerOpen: detectorPerOpen,
    ...(NATIVE ? { lastOpenPhases: lastMetrics?.phases, lastOpenCache: lastMetrics && { evictions: lastMetrics.cacheEvictions, restores: lastMetrics.cacheRestores, maxBytes: lastMetrics.cacheMaxBytes } } : {}),
    ...(visitSamples.length ? { visitSamples } : {}),
    gridCells: metricsAvailable ? lastMetrics.gridCells : null, gridDecodedBytes: metricsAvailable ? lastMetrics.gridDecodedBytes : null,
    cachedCells: metricsAvailable ? lastMetrics.cachedCells : null, cachedObjects: metricsAvailable ? lastMetrics.cachedObjects : null,
    cacheEstimatedBytes: metricsAvailable ? lastMetrics.cacheEstimatedBytes : null, cacheMaxCells: metricsAvailable ? lastMetrics.cacheMaxCells : null,
    peakRssSampledBytes: peakRss, maxRssBytes: usage.maxRSS * 1024,
    eventLoopMaxDelayMs: loop.max / 1e6,
    metricsAvailable,
    ...(NATIVE ? {backend:'native',worker:process.env.DFV_TABLE_WORKER,nativePeakRssSampledBytes:nativePeakRss,rssSampleIntervalMs:100,nativePids,
      metricLimitation:Object.keys(lastMetrics?.phases??{}).length ? null : 'Worker phase/cache metrics are not implemented; existing adapter zeros are unavailable evidence.'} : {}),
  };
}

async function cancellation() {
  // Cancel the production read path while a cold tall sheet is preparing.
  const req = m => require(path.join(root, 'out-test', m));
  const { ViewerFile } = NATIVE ? {} : req('src/viewerFile');
  const { NativeDocument } = NATIVE ? req('src/backend/nativeDocument') : {};
  if (NATIVE) assert.ok(process.env.DFV_TABLE_WORKER && fs.existsSync(process.env.DFV_TABLE_WORKER), 'DFV_TABLE_WORKER must name the actual native worker');
  const file = path.join(fixturesDir, 'tall.xlsx');
  const original = fs.readFileSync(file);
  const out = [];
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  for (let i = 0; i < 5; i++) {
    const doc = NATIVE ? await NativeDocument.open({ executable: process.env.DFV_TABLE_WORKER }, file) : await ViewerFile.open(file);
    try {
      const pending = doc.runQuery('select * from "Active" limit 100', 0, NATIVE ? 'Active' : undefined).then(() => 'resolved', e => String(e?.code ?? e?.message ?? e));
      await new Promise(r => setTimeout(r, 150));
      const t = performance.now();
      doc.interruptCurrentQuery();
      const outcome = await pending;
      out.push({ ackMs: performance.now() - t, outcome });
    } finally { if (NATIVE) await doc.close(); else doc.dispose(); }
  }
  loop.disable();
  assert.deepEqual(fs.readFileSync(file), original, 'cancellation never changes source');
  assert.ok(out.every(run => /cancel|interrupt/i.test(run.outcome)), 'every interrupted cold read must report cancellation');
  assert.ok(out.every(run => run.ackMs < 250), 'cold-sheet cancellation acknowledgement exceeds the 250 ms target');
  return { fixture: 'tall', runs: out, ackMs: stats(out.map(o => o.ackMs)), hostEventLoopMaxDelayMs: loop.max / 1e6 };
}

(async () => {
  if (args.child) { process.stdout.write(JSON.stringify(await child(args.child))); return; }
  if (args.cancel) { process.stdout.write(JSON.stringify(await cancellation())); return; }
  const result = {
    harness: path.relative(root, __filename), root,
    head: (() => { try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    started: new Date().toISOString(),
    hardware: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemBytes: os.totalmem(), node: process.version },
    cold: COLD, warm: WARM, fixtures: [],
  };
  const only = args.only ? String(args.only).split(',') : Object.keys(FIXTURES);
  for (const name of only) {
    const run = spawnSync(process.execPath, [__filename, '--child', name, '--root', root, '--fixtures', fixturesDir, '--cold', String(COLD), '--warm', String(WARM), ...(NATIVE?['--backend','native']:[]), ...(args.visit?['--visit','1']:[])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: root });
    if (run.status !== 0) { result.fixtures.push({ fixture: name, error: run.stderr.slice(-4000), exit: run.status }); continue; }
    result.fixtures.push(JSON.parse(run.stdout));
    process.stderr.write(`${name} done\n`);
  }
  if (!args['no-cancel'] && fs.existsSync(path.join(fixturesDir, 'tall.xlsx'))) {
    const run = spawnSync(process.execPath, [__filename, '--cancel', 'true', '--root', root, '--fixtures', fixturesDir, ...(NATIVE ? ['--backend', 'native'] : [])], { encoding: 'utf8', cwd: root });
    result.cancellation = run.status === 0 ? JSON.parse(run.stdout) : { error: run.stderr.slice(-4000), exit: run.status };
  }
  result.finished = new Date().toISOString();
  fs.writeFileSync(path.resolve(args.out ?? 'perfx1.json'), JSON.stringify(result, null, 2) + '\n');
  assert.ok(result.fixtures.every(fixture => !fixture.error), 'a benchmark fixture failed; inspect the result file');
  assert.ok(!result.cancellation?.error, 'cancellation benchmark failed; inspect the result file');
})().catch(e => { console.error(e); process.exitCode = 1; });
