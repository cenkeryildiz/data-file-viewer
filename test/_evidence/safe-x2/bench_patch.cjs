// Median patchCell wall time on one synthetic workbook. Usage:
//   node bench_patch.cjs <T-or-baseline-root> <outjson>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const root = path.resolve(process.argv[2]);
const { patchCell } = require(root + '/out-test/src/xlsxWrite');
const { xlsxFile } = require(root + '/out-test/test/stress/generators/_write');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-bench-')), file = path.join(dir, 'b.xlsx');
  const rows = [['Name', 'Value']]; for (let i = 0; i < 200000; i++) rows.push(['row' + i, i]);
  await xlsxFile(file, [{ name: 'A', rows }, { name: 'B', rows: rows.slice(0, 50000) }]);
  const runs = []; let prev = 'row0';
  for (let i = 0; i < 7; i++) {
    const bytes = fs.readFileSync(file), next = 'v' + i;
    const t = performance.now();
    await patchCell({ filePath: file, sheetPath: 'xl/worksheets/sheet1.xml', columnName: 'A', columnNames: ['A', 'B'], rowOrdinal: 2, verbatim: true, expectedCurrent: prev, newValue: next, expectedSha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    runs.push(performance.now() - t); prev = next;
  }
  const sorted = [...runs].sort((a, b) => a - b);
  fs.writeFileSync(process.argv[3], JSON.stringify({ root, fileBytes: fs.statSync(file).size, runsMs: runs, medianMs: sorted[3] }, null, 2) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exitCode = 1; });
