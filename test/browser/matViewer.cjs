// Actual Rust MAT worker + read-only provider + browser UI; no TypeScript data backend.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const vscode = require('../../out-test/test/stress/stubs/vscode').default;
const { MatClient } = require('../../out-test/src/features/mat/client');
const { MatDocument, MatEditorProvider } = require('../../out-test/src/features/mat/provider');

(async () => {
  assert.ok(process.env.DFV_MAT_WORKER && process.env.DFV_MAT_FIXTURE, 'set actual MAT worker and genuine fixture');
  const fixture = process.env.DFV_MAT_FIXTURE;
  const before = createHash('sha256').update(await fs.readFile(fixture)).digest('hex');
  const client = await MatClient.open({ executable: process.env.DFV_MAT_WORKER }, fixture);
  const document = new MatDocument(vscode.Uri.file(fixture), client);
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [], outbound = [], replies = [], requests = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', r => { outbound.push(r.request().url()); return r.abort(); });
    let handler;
    const webview = { options: {}, cspSource: 'vscode-resource:', asWebviewUri: u => u,
      onDidReceiveMessage: h => { handler = h; return { dispose() {} }; },
      postMessage: async m => { replies.push(m); if (!page.isClosed()) await page.evaluate(m => window.postMessage(m, '*'), m); return true; },
    };
    const provider = new MatEditorProvider({ extensionPath: process.cwd(), extensionUri: vscode.Uri.file(process.cwd()) });
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) });
    assert.match(webview.html, /Content-Security-Policy/);
    // Browser fixture uses the exact host DOM; actual VS Code owns CSP enforcement.
    await page.setContent(webview.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<script[^>]*src=[^>]*><\/script>/, ''));
    await page.exposeFunction('sendToHost', async m => { requests.push(m); await handler(m); });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: m => void window.sendToHost(m) }); });
    const bundle = await esbuild.build({ entryPoints: ['src/features/mat/view.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const idle = () => page.waitForFunction(() => document.querySelector('#status').textContent === 'Read-only. No source changes.');
    const choose = async name => { await page.locator('#catalog button').filter({ hasText: new RegExp('^' + name + ' —') }).click(); await idle(); };
    await idle();
    await choose('unsigned');
    assert.match(await page.locator('#data').textContent(), /18446744073709551615/);
    await choose('tensor');
    assert.equal(await page.locator('#value fieldset input').count(), 6);
    assert.equal(await page.locator('#data tbody tr').count(), 24);
    assert.equal(await page.locator('#data tbody tr').nth(1).locator('td').first().textContent(), '(2, 1, 1)');
    await page.getByRole('textbox', { name: 'Dimension 3 start', exact: true }).fill('4');
    await page.getByRole('textbox', { name: 'Dimension 3 count', exact: true }).fill('1');
    await page.getByRole('button', { name: 'Read slice', exact: true }).click(); await idle();
    assert.equal(await page.locator('#data tbody tr').count(), 6);
    assert.equal(await page.locator('#data tbody tr').first().locator('td').first().textContent(), '(1, 1, 4)');
    await page.getByRole('textbox', { name: 'Dimension 1 start', exact: true }).fill('0');
    const reads = requests.filter(m => m.command === 'slice').length;
    await page.getByRole('button', { name: 'Read slice', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('one-based bounds'));
    assert.equal(requests.filter(m => m.command === 'slice').length, reads, 'invalid bounds refused before worker read');
    await choose('sparse_values');
    assert.equal(await page.locator('#data tbody tr').count(), 2);
    assert.match(await page.locator('#data').textContent(), /implicit zero/);
    assert.match(await page.locator('#data').textContent(), /1000000/);
    await choose('text'); assert.match(await page.locator('#data').textContent(), /İş😀/);
    await choose('complex_values'); assert.match(await page.locator('#data').textContent(), /Imaginary/); assert.match(await page.locator('#data').textContent(), /-4/);
    await choose('empty_rows'); assert.equal(await page.locator('#data tbody tr').count(), 0); assert.match(await page.locator('#data').textContent(), /Empty slice/);
    await choose('cells'); assert.equal(await page.locator('#children button').count(), 6);
    await page.locator('#children button').first().click(); await idle();
    assert.ok(await page.locator('#breadcrumb button').count() >= 3);
    await choose('record'); assert.match(await page.locator('#value').textContent(), /fields:/);
    await page.locator('#children button').first().click(); await idle();
    assert.equal(await page.getByRole('button', { name: /save|edit/i }).count(), 0);
    assert.equal(typeof provider.saveCustomDocument, 'undefined');
    assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
    assert.ok(replies.every(m => m.ok === true), JSON.stringify(replies.filter(m => !m.ok)));
    assert.equal(createHash('sha256').update(await fs.readFile(fixture)).digest('hex'), before);
    console.log('Actual native MAT browser passed: exact uint64, ND bounds/order/slice, sparse coordinates, Unicode, complex/empty, cell/struct navigation, no editing/network/source changes.');
  } finally { await document.close(); await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
