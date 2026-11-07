// SAFE-X1: real provider + selected reference/native backend + webview bundle in Chromium.
// Native runs require dfv-table-xlsx-ops/test-detection-failure, with its per-workbook Rust fault.
// An injected detector fault on first preparation must show the raw sheet WITH a
// "Table detection failed" status and an explicit Retry (never a blank success),
// must not re-run detection on later previews, and Retry must start a fresh
// generation that brings the detected table back. Source bytes stay unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const vscode = require('../../out-test/test/stress/stubs/vscode').default;
const { DuckDBDocument, DuckDBEditorProvider } = require('../../out-test/src/duckdbEditorProvider');
const { rawReferenceBackend } = require('../../out-test/src/backend/reference');
const { selectBackend } = require('../../out-test/src/backend/nativeSelect');
const detect = require('../../out-test/src/backend/excel/detect');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

(async () => {
  const native = process.env.DFV_BACKEND === 'native';
  if (native) assert.equal(process.env.DFV_TEST_XLSX_FAIL_ONCE_SHEET, 'Data', 'Use the test-only native detector failure build');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-browser-safex1-'));
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  const original = detect.detectSheetGrid;
  let detectorCalls = 0;
  if (!native) detect.detectSheetGrid = (...args) => { detectorCalls++; if (detectorCalls === 1) throw new Error('injected detector fault'); return original(...args); };
  const backend = native ? selectBackend(process.cwd(), { ...process.env, DFV_TABLE_STATE_DIR: path.join(dir, 'state') }) : rawReferenceBackend;
  let document;
  const report = { checks: [] };
  const check = async (name, fn) => { await fn(); report.checks.push(name); };
  try {
    const source = path.join(dir, 'book.xlsx');
    await xlsxFile(source, [{ name: 'Data', rows: [['id', 'v'], [1, 2], [3, 4]] }, { name: 'Other', rows: [['k'], ['x']] }]);
    const before = await sha(source);
    const file = await backend.open(source);
    if (native) assert.equal(file.constructor.name, 'NativeDocument');
    document = new DuckDBDocument(vscode.Uri.file(source), file, undefined, undefined, backend);
    const provider = new DuckDBEditorProvider({ extensionUri: vscode.Uri.file(process.cwd()) }, native ? backend : undefined);
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [], requests = [], responses = [], outbound = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => { outbound.push(route.request().url()); return route.abort(); });
    let handler;
    const webview = {
      cspSource: 'vscode-resource:', asWebviewUri: uri => uri,
      onDidReceiveMessage: callback => { handler = callback; return { dispose() {} }; },
      postMessage: async message => { responses.push(message); if (!page.isClosed()) await page.evaluate(message => window.postMessage(message, '*'), message); return true; },
    };
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) });
    await page.exposeFunction('sendToHost', async message => { requests.push(message); await handler(message); });
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ path: 'media/main.css' });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => void window.sendToHost(message) }); });
    const bundle = await esbuild.build({ stdin: { contents: await fs.readFile('src/webview.ts', 'utf8'), loader: 'ts', resolveDir: path.resolve('src') },
      bundle: true, write: false, format: 'iife', platform: 'browser' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const sidebar = name => page.locator('.table-item', { hasText: name }).first();

    await check('failed detection shows the raw sheet with a typed failure and Retry, not a blank success', async () => {
      await sidebar('Data').click();
      await page.locator('.sheet-preparation-failed').waitFor();
      assert.match(await page.locator('.sheet-preparation-failed').textContent(), native ? /Table detection failed\. injected native detector fault/ : /Table detection failed\. injected detector fault/);
      assert.equal(await page.locator('.sheet-preparation-retry').count(), 1);
      assert.equal(await page.locator('td[data-r="1"][data-c="0"]').textContent(), '1', 'raw sheet rows are painted');
      assert.equal(await page.locator('.sheet-table-sql').count(), 0);
    });

    await check('later previews do not re-run detection automatically', async () => {
      await sidebar('Other').click();
      await page.waitForFunction(() => document.querySelector('td[data-r="1"][data-c="0"]')?.textContent === 'x');
      await sidebar('Data').click();
      await page.locator('.sheet-preparation-failed').waitFor();
      if (!native) assert.equal(detectorCalls, 2, 'one failed Data attempt + one Other attempt');
    });

    await check('Retry starts a fresh generation and the detected table appears', async () => {
      await page.locator('.sheet-preparation-retry').click();
      await page.waitForFunction(() => document.querySelectorAll('.sheet-table-sql').length === 1);
      assert.equal(await page.locator('.sheet-preparation').count(), 0);
      const retried = responses.filter(m => m.command === 'sheetPreparationRetried').at(-1);
      assert.equal(retried.status.state, 'ready');
      assert.equal(retried.status.generation, 1);
      assert.equal(requests.filter(m => m.command === 'retrySheetPreparation').length, 1);
      if (!native) assert.equal(detectorCalls, 3);
    });

    assert.equal(await sha(source), before, 'source bytes unchanged');
    assert.deepEqual(outbound, []);
    assert.deepEqual(errors, []);
    report.result = 'pass';
    console.log(JSON.stringify(report));
    console.log('SAFE-X1 browser workflow passed: typed failure banner over readable raw sheet, no automatic re-detection, explicit retry restored the table.');
  } finally {
    detect.detectSheetGrid = original;
    if (document) await document.session.close();
    document?.dispose(); await browser.close(); await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
