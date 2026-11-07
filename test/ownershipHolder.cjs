// Child process for matLifecycle.test.ts: holds one PDF, one table and one MAT worker, reports their pids, then idles until killed.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { MatClient } = require(path.join(root, 'out-test/src/features/mat/client'));
const { NativeTableClient } = require(path.join(root, 'out-test/src/backend/native'));
const { createPdfHost } = require(path.join(root, 'out-test/src/pdfHost'));
const { nativeWorkerUsage } = require(path.join(root, 'out-test/src/native/supervisor'));

(async () => {
  const [pdf, mat, scratch] = process.argv.slice(2);
  const context = { extensionPath: root, globalStorageUri: { fsPath: path.join(scratch, 'state') } };
  const host = await createPdfHost(context, { fsPath: pdf });
  await host.request('get_document_info', {});
  const matClient = await MatClient.open({ executable: process.env.DFV_MAT_WORKER }, mat);
  const table = await NativeTableClient.start({ executable: process.env.DFV_TABLE_WORKER });
  await table.call('ping');
  const pids = {};
  for (const w of nativeWorkerUsage().workers) pids[w.feature] = w.pid;
  process.stdout.write(JSON.stringify({ holder: process.pid, pids }) + '\n');
  setInterval(() => { void matClient; void table; void host; }, 1 << 30);
})().catch(e => { console.error(e); process.exit(1); });
