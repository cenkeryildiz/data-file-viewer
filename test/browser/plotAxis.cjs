// PLOT-02/03 in the real grid webview: the "X axis" choice decides what a plot
// button asks the host for. Uses installed Chrome. From the repository root:
// npm ci && npx tsc -p tsconfig.test.json && node test/browser/plotAxis.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const vscode = require('../../out-test/test/stress/stubs/vscode').default;
const { DuckDBDocument, DuckDBEditorProvider } = require('../../out-test/src/duckdbEditorProvider');
const { rawReferenceBackend } = require('../../out-test/src/backend/reference');
const { selectBackend } = require('../../out-test/src/backend/nativeSelect');
const { duckdbFile } = require('../../out-test/test/stress/generators/_write');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-browser-axis-'));
  const backend = process.env.DFV_BACKEND === 'native'
    ? selectBackend(process.cwd(), { ...process.env, DFV_TABLE_STATE_DIR: path.join(dir, 'state') }) : rawReferenceBackend;
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  let document;
  try {
    const source = path.join(dir, 'axis.duckdb');
    await duckdbFile(source, [
      { name: 'nodate', columns: [{ name: 'v', type: 'DOUBLE' }], rows: [[3], [null], [5]] },
      { name: 'pair', columns: [{ name: 'sven', type: 'DOUBLE' }, { name: 'beta', type: 'DOUBLE' }], rows: [[2, 20], [1, 10], [3, null]] },
      { name: 'iso', columns: [{ name: 'opened_at', type: 'VARCHAR' }, { name: 'v', type: 'DOUBLE' }],
        rows: [['2024-01-01', 1], ['2024-01-02', 2]] },
      { name: 'dated', columns: [{ name: 'Date', type: 'DATE' }, { name: 'v', type: 'DOUBLE' }],
        rows: [['2024-01-01', 1], ['2024-01-02', 2]] },
    ]);
    const original = await fs.readFile(source);
    const file = await backend.open(source);
    if (process.env.DFV_BACKEND === 'native') assert.equal(file.constructor.name, 'NativeDocument');
    document = new DuckDBDocument(vscode.Uri.file(source), file, undefined, undefined, backend);
    const provider = new DuckDBEditorProvider({ extensionUri: vscode.Uri.file(process.cwd()) }, backend);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [], chartRequests = [], outbound = [], responses = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => { outbound.push(route.request().url()); return route.abort(); });
    let handler;
    const webview = {
      cspSource: 'vscode-resource:', asWebviewUri: uri => uri,
      onDidReceiveMessage: callback => { handler = callback; return { dispose() {} }; },
      postMessage: async message => { responses.push(message); if (!page.isClosed()) await page.evaluate(message => window.postMessage(message, '*'), message); return true; },
    };
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) });
    // Chart requests are recorded, not forwarded: the stub has no chart panel to draw in.
    await page.exposeFunction('sendToHost', async message => {
      if (message.command === 'chartQuery') { const { requestId, generation, ...rest } = JSON.parse(JSON.stringify(message)); chartRequests.push(rest); } // as the host receives it; the request id is transport
      else await handler(message);
    });
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ path: 'media/main.css' });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => void window.sendToHost(message) }); });
    const bundle = await esbuild.build({ stdin: {
      contents: await fs.readFile('src/webview.ts', 'utf8') + '\nexport function inspectPaintedExecution(){return data.state.paintedExecution}\n', loader: 'ts', resolveDir: path.resolve('src'),
    }, bundle: true, write: false, format: 'iife', globalName: 'axisTest', platform: 'browser' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => axisTest.inspectPaintedExecution() > 0 && document.querySelector('#run-btn').textContent.includes('Run'));

    const options = () => page.locator('#plot-axis option').evaluateAll(list => list.map(o => o.textContent));
    const run = async sql => {
      const before = await page.evaluate(() => axisTest.inspectPaintedExecution());
      await page.locator('.cm-content').fill(sql);
      await page.locator('#run-btn').click();
      await page.waitForFunction(previous => axisTest.inspectPaintedExecution() > previous && document.querySelector('#run-btn').textContent.includes('Run') && document.querySelector('th'), before).catch(error => {
        console.error(JSON.stringify({ backend: process.env.DFV_BACKEND ?? 'reference', commands: responses.slice(-8).map(m => m.command), errors: responses.filter(m => m.command === 'error').slice(-2) }));
        throw error;
      });
    };

    // No date column: Automatic already offers the plot, against row numbers.
    await run('SELECT * FROM nodate;');
    assert.deepEqual(await options(), ['Automatic', 'v']);
    assert.match(await page.locator('.th-plot-btn').first().getAttribute('title'), /against row numbers/);
    await page.locator('.th-plot-btn').first().click();
    await page.waitForTimeout(50);
    assert.deepEqual(chartRequests.at(-1), { command: 'chartQuery', xColumn: 'Row', xIsText: false, xIsCategory: false, xIsRow: true, xIsValue: false, yColumns: ['v'] });

    // Any column can be the x axis: a number column is a number line, whatever it is called.
    await run('SELECT * FROM pair;');
    assert.deepEqual(await options(), ['Automatic', 'sven', 'beta']);
    await page.selectOption('#plot-axis', 'col:sven');
    assert.match(await page.locator('.th-plot-btn').first().getAttribute('title'), /against sven/);
    assert.equal(await page.locator('.th-plot-btn').count(), 1, 'the x column is not offered as its own series');
    await page.locator('.th-plot-btn').first().click();
    await page.waitForTimeout(50);
    assert.deepEqual(chartRequests.at(-1), { command: 'chartQuery', xColumn: 'sven', xIsText: false, xIsCategory: false, xIsRow: false, xIsValue: true, yColumns: ['beta'] });

    // The chart follows the grid: changing the x axis, or running another query, redraws the open chart.
    await page.selectOption('#plot-axis', 'auto');
    await page.waitForTimeout(50);
    assert.deepEqual(chartRequests.at(-1), { command: 'chartQuery', refresh: true, xColumn: 'Row', xIsText: false, xIsCategory: false, xIsRow: true, xIsValue: false, yColumns: ['beta'] });
    await run('SELECT * FROM pair WHERE sven < 3;');
    await page.waitForTimeout(50);
    assert.deepEqual(chartRequests.at(-1), { command: 'chartQuery', refresh: true, xColumn: 'Row', xIsText: false, xIsCategory: false, xIsRow: true, xIsValue: false, yColumns: ['beta'] });
    const asked = chartRequests.length;
    await run('SELECT sven FROM pair;');
    await page.waitForTimeout(50);
    assert.equal(chartRequests.length, asked, 'a result without the plotted column asks for no chart');
    await page.selectOption('#plot-axis', 'auto');

    // A text column is probed for dates by the host, as the automatic text axis is.
    await run('SELECT * FROM iso;');
    assert.equal(await page.locator('#plot-axis').inputValue(), 'auto', 'a choice naming a column the new result lacks resets to Automatic');
    await page.selectOption('#plot-axis', 'col:opened_at');
    await page.locator('.th-plot-btn').first().click();
    await page.waitForTimeout(50);
    assert.deepEqual(chartRequests.at(-1), { command: 'chartQuery', xColumn: 'opened_at', xIsText: true, xIsCategory: false, xIsRow: false, xIsValue: false, yColumns: ['v'] });

    // Automatic uses the date column; the column choice can override it with a number column.
    await page.selectOption('#plot-axis', 'auto');
    await run('SELECT * FROM dated;');
    assert.match(await page.locator('.th-plot-btn').first().getAttribute('title'), /against Date/);
    await page.locator('.th-plot-btn').first().click();
    await page.waitForTimeout(50);
    assert.deepEqual(chartRequests.at(-1), { command: 'chartQuery', xColumn: 'Date', xIsText: false, xIsCategory: false, xIsRow: false, xIsValue: false, yColumns: ['v'] });

    assert.deepEqual(outbound, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(responses.filter(message => message.command === 'error'), [], 'every requested query completed without cancellation or a stale result');
    assert.deepEqual(await fs.readFile(source), original, 'the plot choice never touches the source');
    console.log('Plot axis browser workflow passed: Automatic row fallback, a number column as x, a text column probed for dates, and reset when the column is gone.');
  } finally { await document?.session.close(); await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
