// EX-05 browser regression: real provider + read worker + webview bundle in Chromium.
// A repeated-header table (Name/Value, Alice/1, blank, Name/Value, Bob/2) must
// show exactly two logical rows in the grid overlay, keep its blank and
// repeated-header rows as sheet structure, refuse editing a sorted overlay cell,
// and route a sorted SQL-result edit to the original worksheet cell.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const vscode = require('../../out-test/test/stress/stubs/vscode').default;
const { DuckDBDocument, DuckDBEditorProvider } = require('../../out-test/src/duckdbEditorProvider');
const { ViewerFile } = require('../../out-test/src/viewerFile');
const { DuckDbFile } = require('../../out-test/src/duckdbConnection');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

async function rawSheet(file) {
  const reader = await DuckDbFile.open(file, undefined, { forceReadOnly: true });
  try { return (await reader.runQuery('select * from "Sheet"')).rows; } finally { await reader.dispose(); }
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-browser-ex05-'));
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  let document;
  const report = { checks: [] };
  const check = async (name, fn) => { await fn(); report.checks.push(name); };
  try {
    const source = path.join(dir, 'repeated.xlsx');
    await xlsxFile(source, [{ name: 'Sheet', rows: [['Name', 'Value'], ['Alice', 1], [], ['Name', 'Value'], ['Bob', 2]] }]);
    const file = await ViewerFile.open(source);
    document = new DuckDBDocument(vscode.Uri.file(source), file);
    const provider = new DuckDBEditorProvider({ extensionUri: vscode.Uri.file(process.cwd()) });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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
    const bundle = await esbuild.build({ stdin: {
      contents: await fs.readFile('src/webview.ts', 'utf8') + '\nexport function inspectEditor(){return editor.state.doc.toString()}\n',
      loader: 'ts', resolveDir: path.resolve('src'),
    }, bundle: true, write: false, format: 'iife', globalName: 'ex05Test', platform: 'browser' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const cell = (r, c) => page.locator(`td[data-r="${r}"][data-c="${c}"]`);

    await check('one detected table labelled with exactly 2 rows', async () => {
      await page.waitForFunction(() => document.querySelectorAll('.sheet-table-sql').length === 1);
      assert.match(await page.locator('.sheet-table-label').first().textContent(), /· 2 rows$/);
      const preview = responses.filter(m => m.command === 'queryResult').at(-1);
      const [table] = preview.sheetTables;
      assert.deepEqual(table.dataRows, [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
      assert.deepEqual(table.excludedRows, [{ row: 2, reason: 'blank' }, { row: 3, reason: 'header' }]);
    });

    await check('sorted overlay fills only data rows; blank and repeated header stay sheet structure', async () => {
      const sortValue = page.locator('.sheet-table-sort').nth(1);
      await sortValue.click(); // asc
      await page.waitForFunction(() => document.querySelector('.sheet-table-label')?.textContent.includes('2 match'));
      await page.locator('.sheet-table-sort').nth(1).click(); // desc
      await page.waitForFunction(() => document.querySelector('td[data-r="1"][data-c="0"]')?.textContent === 'Bob');
      const query = requests.filter(m => m.command === 'sheetTableQuery').at(-1);
      assert.equal(query.limit, 2, 'the overlay asked for one row per data slot');
      assert.equal(await cell(1, 1).textContent(), '2');
      assert.equal(await cell(2, 0).textContent(), 'NULL', 'the blank separator still shows the raw sheet');
      assert.equal(await cell(3, 0).textContent(), 'Name');
      assert.equal(await cell(3, 1).textContent(), 'Value');
      assert.equal(await cell(4, 0).textContent(), 'Alice');
      assert.equal(await cell(4, 1).textContent(), '1');
      assert.match(await page.locator('.sheet-table-label').first().textContent(), /2 shown · 2 match · 2 total/);
    });

    await check('Safe Mode turned off, as a user does before editing', async () => {
      // Sorted first: with the base code a detected-table query after the Safe
      // Mode backup fails in the read worker (pre-existing, not EX-05); the
      // painted overlay stays on screen without another query.
      await page.locator('#safe-mode-check').uncheck();
      const deadline = Date.now() + 10000;
      while (!responses.some(m => m.command === 'safeModeState') && Date.now() < deadline) await page.waitForTimeout(25);
      assert.equal(await page.locator('#safe-mode-check').isChecked(), false);
      assert.equal(await cell(1, 0).textContent(), 'Bob', 'the sorted overlay is still painted');
    });

    await check('an excluded structure row is not overlaid, so it stays editable (no false refusal)', async () => {
      await cell(3, 1).dblclick();
      await page.locator('.cell-inspector-panel').waitFor();
      assert.equal(await page.locator('.cell-inspector-body .cm-content').innerText(), 'Value');
      assert.equal(await page.locator('.cell-inspector-footer button', { hasText: 'Save' }).count(), 1);
      await page.locator('.cell-inspector-close').click();
    });

    await check('editing a sorted overlay cell is refused in the inspector even with Safe Mode off', async () => {
      await cell(1, 1).dblclick();
      await page.locator('.cell-inspector-panel').waitFor();
      assert.match(await page.locator('.cell-inspector-note').textContent(), /sorted or filtered/);
      assert.equal(await page.locator('.cell-inspector-footer button', { hasText: 'Save' }).count(), 0);
      assert.equal(await page.locator('.cell-inspector-body .cm-content').innerText(), '2', 'the inspector shows what the cell shows');
      await page.locator('.cell-inspector-close').click();
      assert.ok(!requests.some(m => m.command === 'updateCell'));
    });

    await check('SQL result sorted desc: editing Bob updates sheet B5 only', async () => {
      const editor = page.locator('.cm-content').first();
      await editor.fill('SELECT * FROM "Sheet · Table 1" ORDER BY "Value" DESC;');
      await page.locator('#run-btn').click();
      await page.waitForFunction(() => !document.querySelector('.sheet-table-sql') && document.querySelector('td[data-r="0"][data-c="0"]')?.textContent === 'Bob');
      const result = responses.filter(m => m.command === 'queryResult').at(-1);
      assert.equal(result.rows.length, 2);
      assert.equal(result.editable, true);
      await cell(0, 1).dblclick();
      await page.locator('.cell-inspector-panel').waitFor();
      const inspector = page.locator('.cell-inspector-body .cm-content');
      await inspector.fill('7');
      await page.locator('.cell-inspector-footer button', { hasText: 'Save' }).click();
      const deadline = Date.now() + 15000;
      while (!responses.some(m => m.command === 'cellUpdated' || m.command === 'editResult' || (m.command === 'queryResult' && m.rows?.some(r => Number(r[1]) === 7))) && Date.now() < deadline) await page.waitForTimeout(25);
      const sheet = await rawSheet(source);
      assert.deepEqual(sheet, [['Name', 'Value'], ['Alice', '1'], [null, null], ['Name', 'Value'], ['Bob', '7']]);
    });

    assert.deepEqual(outbound, []);
    assert.deepEqual(errors, []);
    report.result = 'pass';
    console.log(JSON.stringify(report));
    console.log('EX-05 browser workflow passed: exact 2-row label/map, sorted overlay on data slots only, overlay edit refused, sorted SQL edit hit B5.');
  } finally { document?.dispose(); await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
