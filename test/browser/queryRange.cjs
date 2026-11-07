const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const vscode = require('../../out-test/test/stress/stubs/vscode').default;
const { recorded } = require('../../out-test/test/stress/stubs/vscode');
const { DuckDBDocument, DuckDBEditorProvider } = require('../../out-test/src/duckdbEditorProvider');
const { selectBackend } = require('../../out-test/src/backend/nativeSelect');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-range-browser-'));
  const backend = selectBackend(process.cwd(), { ...process.env, DFV_TABLE_STATE_DIR: path.join(dir, 'state') });
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  let document;
  try {
    const source = path.join(dir, 'grid.xlsx');
    await xlsxFile(source, [{ name: 'Grid', rows: Array.from({ length: 250 }, (_, r) => Array.from({ length: 28 }, (_, c) => `R${r + 1}C${c + 1}`)) }]);
    const original = await fs.readFile(source);
    const file = await backend.open(source);
    if (process.env.DFV_BACKEND === 'native') assert.equal(file.constructor.name, 'NativeDocument');
    document = new DuckDBDocument(vscode.Uri.file(source), file, undefined, undefined, backend);
    const provider = new DuckDBEditorProvider({ extensionUri: vscode.Uri.file(process.cwd()) }, backend);
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [], outbound = [], requests = [], responses = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => { outbound.push(route.request().url()); return route.abort(); });
    let receive;
    let holdRange = false;
    const heldRangeReplies = [];
    const webview = { cspSource: 'vscode-resource:', asWebviewUri: uri => uri,
      onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; },
      async postMessage(message) {
        responses.push(message);
        if (holdRange && message.command === 'queryRangeResult') {
          heldRangeReplies.push(message);
          await page.evaluate(() => { window.__rangeReplyHeld = true; });
        } else if (!page.isClosed()) await page.evaluate(message => window.postMessage(message, '*'), message);
        return true;
      } };
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) });
    await page.exposeFunction('sendToHost', async message => { requests.push(message); await receive(message); });
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ path: 'media/main.css' });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => void window.sendToHost(message) }); });
    const bundle = await esbuild.build({ stdin: { contents: await fs.readFile('src/webview.ts', 'utf8') + '\nexport function painted(){return data.state.paintedExecution}\n', loader: 'ts', resolveDir: path.resolve('src') }, bundle: true, write: false, format: 'iife', globalName: 'rangeTest', platform: 'browser' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => !document.querySelector('#range-apply').disabled && document.querySelector('#range-target').textContent.includes('Worksheet Grid')).catch(error => {
      console.error(JSON.stringify({ errors, requests: requests.map(message => ({ command: message.command, sheet: message.sheetPreview })), replies: responses.map(message => ({ command: message.command, execution: message.executionSeq, range: message.rangeContext, error: message.message })) }));
      throw error;
    });
    const preview = page.locator('#range-preview');
    await page.locator('#range-input').fill('Z2:AB205');
    await page.locator('#range-apply').click();
    await page.waitForFunction(() => document.querySelector('#range-preview').textContent.length > 0);
    assert.equal(await preview.locator('tbody tr td:nth-child(2)').first().textContent({ timeout: 3000 }).catch(() => preview.textContent()), 'R2C26', JSON.stringify(responses.filter(message => message.command === 'queryRangeResult')));
    assert.equal(await preview.locator('tbody tr').count(), 100);
    assert.deepEqual(await preview.locator('tbody tr').first().locator('td').allTextContents(), ['2', 'R2C26', 'R2C27', 'R2C28']);
    assert.match(await preview.locator('p').textContent(), /Worksheet Grid.*Z2:AB205/);
    await preview.getByRole('button', { name: 'Next range page' }).click();
    await page.waitForFunction(() => document.querySelector('#range-preview tbody tr td:nth-child(2)')?.textContent === 'R102C26');
    await preview.getByRole('button', { name: 'Next range page' }).click();
    await page.waitForFunction(() => document.querySelector('#range-preview tbody tr td:nth-child(2)')?.textContent === 'R202C26');
    assert.equal(await preview.locator('tbody tr').count(), 4);
    assert.deepEqual(await preview.locator('tbody tr').last().locator('td').allTextContents(), ['205', 'R205C26', 'R205C27', 'R205C28']);
    assert.equal(await preview.getByRole('button', { name: 'Next range page' }).isDisabled(), true);
    await preview.getByRole('button', { name: 'Previous range page' }).click();
    await page.waitForFunction(() => document.querySelector('#range-preview tbody tr td:nth-child(2)')?.textContent === 'R102C26');

    // A late reply from an earlier request of the same result (older requestId) cannot replace the page now shown.
    const shown = responses.filter(message => message.command === 'queryRangeResult');
    await page.evaluate(stale => { window.postMessage(stale, '*'); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, { ...shown[0], requestId: shown.at(-1).requestId - 1 });
    assert.equal(await preview.locator('tbody tr td:nth-child(2)').first().textContent(), 'R102C26', 'older range reply was ignored');

    if (process.env.DFV_BACKEND === 'native') {
      const token = responses.filter(message => message.command === 'queryRangeResult').at(-1).token;
      await preview.locator('input[type="number"]').fill('3');
      await preview.getByRole('button', { name: 'Use as table', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#range-preview').hidden);
      const manual = file.getDetectedSheetTables('Grid').filter(table => table.provenance === 'manual');
      assert.equal(manual.length, 1);
      assert.deepEqual([manual[0].top, manual[0].bottom, manual[0].left, manual[0].right, manual[0].headerRow], [1, 205, 25, 28, 2]);
      assert.equal(manual[0].rowCount, 202);
      const beforeStale = JSON.stringify(file.getDetectedSheetTables('Grid'));
      await receive({ command: 'useRangeAsTable', token, range: 'A1:A2', headerRow: null });
      assert.equal(JSON.stringify(file.getDetectedSheetTables('Grid')), beforeStale, 'a stale correction cannot replace current tables');
      assert.deepEqual(await fs.readFile(source), original);
      const waitReply = async (command, after) => {
        const end = Date.now() + 15000;
        while (Date.now() < end) {
          if (responses.slice(after).some(message => message.command === command)) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.fail(`missing ${command}: ${JSON.stringify(responses.slice(after))}`);
      };
      let before = responses.length;
      await page.locator('#mode-live-radio').check();
      await waitReply('liveTick', before);
      assert.equal(document.file.getDetectedSheetTables('Grid').filter(table => table.provenance === 'manual').length, 1, 'same-source live reconnect retains the correction');
      before = responses.length;
      await page.locator('#mode-static-radio').check();
      await waitReply('liveRefreshStopped', before);
      // A selected-sheet read prepares only that sheet after the new reader opens.
      await document.runExclusive(() => document.file.runQuery('SELECT * FROM "Grid" LIMIT 10', 10, 'Grid'));
      assert.equal(document.file.getDetectedSheetTables('Grid').filter(table => table.provenance === 'manual').length, 1, 'returning to Static retains the correction');
      const warningsBefore = recorded.messages.length;
      const now = new Date(Date.now() + 1000);
      await fs.utimes(source, now, now); // Synthetic source-generation change without altering any input bytes.
      before = responses.length;
      await page.locator('#mode-live-radio').check();
      await waitReply('liveTick', before);
      assert.equal(document.manualSheetTables.size, 0, 'source changes invalidate remembered rectangles');
      assert.equal(document.file.getDetectedSheetTables('Grid').filter(table => table.provenance === 'manual').length, 0);
      assert.ok(recorded.messages.slice(warningsBefore).some(message => /Manual table selections were cleared/.test(message.text)), 'the user is told to select the range again');
      before = responses.length;
      await page.locator('#mode-static-radio').check();
      await waitReply('liveRefreshStopped', before);
      assert.deepEqual(await fs.readFile(source), original);
    }

    const editor = page.locator('.cm-content');
    const run = async sql => {
      const before = await page.evaluate(() => rangeTest.painted());
      await editor.fill(sql); await page.locator('#run-btn').click();
      await page.waitForFunction(before => rangeTest.painted() > before && document.querySelector('#run-btn').textContent.includes('Run'), before);
    };
    await run('SELECT * FROM "Grid" ORDER BY "A";');
    const base = responses.filter(message => message.command === 'queryResult').at(-1);
    await page.locator('#range-input').fill('A2:B205'); await page.locator('#range-apply').click();
    await page.waitForFunction(() => document.querySelector('#range-preview tbody tr') && document.querySelector('#range-preview p')?.textContent.includes('SQL result'));
    assert.equal(await preview.getByRole('button', { name: 'Use as table', exact: true }).count(), 0, 'SQL result coordinates cannot correct a workbook table');
    assert.deepEqual(await preview.locator('tbody tr').first().locator('td').allTextContents(), ['2', ...base.rows[1].slice(0, 2)]);
    assert.match(await preview.locator('textarea').inputValue(), /BETWEEN 2 AND 205/);
    const orderedRange = responses.filter(message => message.command === 'queryRangeResult').at(-1);
    const reproduced = await document.file.runQuery(orderedRange.sql, 300);
    assert.deepEqual(reproduced.rows, base.rows.slice(1, 205).map(row => row.slice(0, 2)));

    // A reply that was already produced before an editor/query change cannot restore the old rectangle.
    holdRange = true;
    await page.locator('#range-input').fill('A1:B2'); await page.locator('#range-apply').click();
    await page.waitForFunction(() => window.__rangeReplyHeld === true);
    await run('SELECT * FROM "Grid" ORDER BY "A" DESC;');
    holdRange = false;
    await page.evaluate(messages => { for (const message of messages) window.dispatchEvent(new MessageEvent('message', { data: message })); }, heldRangeReplies.splice(0));
    assert.equal(await preview.isHidden(), true);
    assert.equal(await page.locator('#range-apply').isEnabled(), true);

    // Editing the SQL without running it also invalidates the previous selection.
    await editor.fill('SELECT * FROM "Grid" ORDER BY "A" ASC;');
    assert.equal(await page.locator('#range-apply').isDisabled(), true);

    await run('SELECT * FROM "Grid";');
    await page.locator('#range-apply').click(); await page.waitForFunction(() => document.querySelector('#range-preview').textContent.includes('ORDER BY'));
    await run('SELECT * FROM "Grid" ORDER BY "A";');
    await page.locator('#range-input').fill('A1:AC2'); await page.locator('#range-apply').click();
    await page.waitForFunction(() => document.querySelector('#range-preview').textContent.includes('exceeds'));
    await page.locator('#range-input').fill('A0:B2'); await page.locator('#range-apply').click();
    await page.waitForFunction(() => document.querySelector('#range-preview').textContent.includes('one-based'));
    await page.locator('.th-sort-btn').first().click();
    assert.equal(await page.locator('#range-apply').isDisabled(), true);
    assert.ok(!requests.some(message => message.command === 'updateCell'));
    assert.deepEqual(await fs.readFile(source), original);
    assert.deepEqual(outbound, []); assert.deepEqual(errors, []);
    console.log('Range browser workflow passed: raw worksheet coordinates, exact pages, native manual range/header correction and same-source reconnect, stable SQL result/readback, invalid bounds and stale/sort refusal; no source writes.');
  } finally { await document?.session.close(); await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
