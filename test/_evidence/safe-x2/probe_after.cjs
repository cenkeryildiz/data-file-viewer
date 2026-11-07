// SAFE-X2 after-fix probe. From T after `tsc -p tsconfig.test.json`:
//   node test/_evidence/safe-x2/probe_after.cjs <outdir>
// Re-runs the audit writer scenarios against the fixed writer and leaves the
// resulting workbooks in <outdir>/fixtures for the independent openpyxl check
// (verify_openpyxl.py). Synthetic fixtures only. Not a power-loss test.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const T = path.resolve(__dirname, '../../..');
const { patchCell } = require(T + '/out-test/src/xlsxWrite');
const { xlsxFile } = require(T + '/out-test/test/stress/generators/_write');
const F = require(T + '/out-test/test/safeX2/faults');
const out = path.resolve(process.argv[2]), fixtures = path.join(out, 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });
const make = (file) => xlsxFile(file, [{ name: 'A', rows: [['Name', 'Value'], ['old', 1]] }, { name: 'B', rows: [['Name', 'Value'], ['untouched', 9]] }]);
const req = (file, bytes, col = 'A', value = 'edited', expected = 'old') => ({ filePath: file, sheetPath: 'xl/worksheets/sheet1.xml', columnName: col, columnNames: ['A', 'B'], rowOrdinal: 2, verbatim: true, expectedCurrent: expected, newValue: value, expectedSha256: F.sha256(bytes) });
const debris = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + '.'));
const settle = (p) => p.then((receipt) => ({ receipt }), (e) => ({ error: e.message, outcome: e.outcome }));
const child = (mode, file, col, expected, value, sha) => {
  const c = cp.fork(T + '/out-test/test/safeX2/writerChild.js', [mode, file, col, expected, value, sha], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const msgs = []; c.on('message', (m) => msgs.push(m));
  return { c, msgs, exit: new Promise((r) => c.on('exit', r)) };
};
(async () => {
  const report = { runtime: process.version, platform: process.platform, tests: {} };
  for (const mode of ['disk-full', 'rename-refused', 'external-replacement', 'corrupt-stage', 'rename-then-error']) {
    const file = path.join(fixtures, mode + '.xlsx'); await make(file); const before = fs.readFileSync(file);
    const other = path.join(fixtures, mode + '-external-source.xlsx'); await xlsxFile(other, [{ name: 'A', rows: [['Name', 'Value'], ['external', 7]] }]); const external = fs.readFileSync(other);
    const restores = [];
    if (mode === 'disk-full') restores.push(F.injectStageFault(async (_s, d) => ({ write: d.subarray(0, 20), error: Object.assign(Error('injected disk full'), { code: 'ENOSPC' }) })));
    if (mode === 'corrupt-stage') restores.push(F.injectStageFault(async (_s, d) => ({ write: d.subarray(0, 20) })));
    if (mode === 'external-replacement') restores.push(F.injectStageFault(async (_s, d) => { fs.writeFileSync(file, external); return { write: d }; }));
    if (mode === 'rename-refused') restores.push(F.injectRename(async () => { throw Object.assign(Error('injected refusal'), { code: 'EACCES' }); }));
    if (mode === 'rename-then-error') restores.push(F.injectRename(async (real, a, b) => { await real(a, b); throw Error('injected after publication'); }));
    let r; try { r = await settle(patchCell(req(file, before))); } finally { restores.forEach((f) => f()); }
    const after = fs.readFileSync(file);
    report.tests[mode] = { ...r, oldPreserved: before.equals(after), externalPreserved: external.equals(after), cells: F.readCells(file, ['A2', 'B2']), debris: debris(file) };
  }
  for (const mode of ['exit-before', 'exit-after']) {
    const file = path.join(fixtures, 'crash-' + mode + '.xlsx'); await make(file); const before = fs.readFileSync(file);
    const k = child(mode, file, 'A', 'old', 'edited', F.sha256(before)); const code = await k.exit;
    const afterCrash = { exitCode: code, oldPreserved: before.equals(fs.readFileSync(file)), cells: F.readCells(file, ['A2', 'B2']), debris: debris(file) };
    const now = fs.readFileSync(file);
    const next = await settle(patchCell(req(file, now, 'B', 5, '1')));
    report.tests['process-' + mode] = { afterCrash, nextSave: next, cells: F.readCells(file, ['A2', 'B2']), debris: debris(file) };
  }
  {
    const file = path.join(fixtures, 'concurrent.xlsx'); await make(file); const sha = F.sha256(fs.readFileSync(file));
    const a = child('pause', file, 'A', 'old', 'new-A', sha);
    while (!a.msgs.some((m) => m.state === 'staged')) await new Promise((r) => setTimeout(r, 10));
    const b = child('pause', file, 'B', '1', '99', sha);
    await new Promise((r) => setTimeout(r, 1500));
    a.c.send('publish'); await a.exit;
    if (b.msgs.some((m) => m.state === 'staged')) b.c.send('publish');
    await b.exit;
    report.tests.concurrent = { events: [...a.msgs.map((m) => ({ writer: 'A', state: m.state, outcome: m.outcome, message: m.message })), ...b.msgs.map((m) => ({ writer: 'B', state: m.state, outcome: m.outcome, message: m.message }))], cells: F.readCells(file, ['A2', 'B2']), debris: debris(file) };
  }
  fs.writeFileSync(path.join(out, 'probe_after.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('SAFE-X2 after-fix probes completed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
