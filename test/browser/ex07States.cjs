// EX-07 acceptance, state half (the layout and keyboard half is ex07Narrow.cjs): loading, empty sheet,
// settings off, detection-pending and failed/retry states, Live-interval geometry, and 100 rapid sheet
// switches. Real provider + the selected backend + the bundled webview and media/main.css in Chrome at
// 420x800; only the VS Code transport is substituted. The failed/pending banners are fed from a real
// reply with only sheetPreparation replaced (the fault-injecting native build is SAFE-X1's job); the
// Retry click itself reaches the real provider and backend.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const vscode = require('../../out-test/test/stress/stubs/vscode').default;
const { DuckDBDocument, DuckDBEditorProvider } = require('../../out-test/src/duckdbEditorProvider');
const { selectBackend } = require('../../out-test/src/backend/nativeSelect');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');
const { scan } = require('./a11yScan.cjs');

const VIEWPORT = { width: 420, height: 800 };
const SHEETS = ['Alpha', 'Beta', 'Empty', 'Gamma'];
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); };
const HOOKS = `
export function inspectPainted() { return data.state.lastResult ? (data.state.lastResult.sheetPreview ?? null) : undefined; }
export function inspectSelection() { return data.state.selection.sheet; }
export function inspectEditor() { return editor.state.doc.toString(); }
export function setEditor(text) { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }); }
`;
const table = (name, rows) => ({ name, rows: [['id', 'v'], ...Array.from({ length: rows }, (_, i) => [`${name}${i}`, i])] });

async function mount(browser, dir, { sheetTables, gate } = {}) {
  const backend = selectBackend(process.cwd(), { ...process.env, DFV_BACKEND: process.env.DFV_BACKEND ?? 'reference', DFV_TABLE_STATE_DIR: path.join(dir, `state-${Math.random().toString(36).slice(2)}`) });
  const source = path.join(dir, `book-${Math.random().toString(36).slice(2)}.xlsx`);
  await xlsxFile(source, [table('Alpha', 30), table('Beta', 5), { name: 'Empty', rows: [] }, table('Gamma', 8)]);
  const file = await backend.open(source, undefined, sheetTables ? { sheetTables } : undefined);
  const runs = [];
  const realRun = file.runQuery.bind(file);
  file.runQuery = async (sql, max, sheet) => { runs.push(sheet); if (gate) await gate(sheet); return realRun(sql, max, sheet); };
  const document = new DuckDBDocument(vscode.Uri.file(source), file, undefined, undefined, backend);
  const provider = new DuckDBEditorProvider({ extensionUri: vscode.Uri.file(process.cwd()), workspaceState: { get: (k, d) => d, keys: () => [], update: async () => undefined } }, backend);
  const bundle = (await esbuild.build({ stdin: { contents: await fs.readFile('src/webview.ts', 'utf8') + HOOKS, loader: 'ts', resolveDir: path.resolve('src') },
    bundle: true, write: false, format: 'iife', globalName: 'ex07s', platform: 'browser' })).outputFiles[0].text;
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [], outbound = [], requests = [], replies = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => { outbound.push(route.request().url()); return route.abort(); });
  let handler;
  const webview = { cspSource: 'vscode-resource:', asWebviewUri: uri => uri,
    onDidReceiveMessage: callback => { handler = callback; return { dispose() {} }; },
    postMessage: async message => { replies.push(message); if (!page.isClosed()) await page.evaluate(m => window.postMessage(m, '*'), message).catch(() => undefined); return true; } };
  await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) });
  await page.exposeFunction('sendToHost', message => { requests.push(message); return handler(message); });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ path: 'media/main.css' });
  await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => void window.sendToHost(message) }); });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => document.querySelectorAll('.table-item').length === 4, undefined, { timeout: 20000 });
  const settled = () => page.waitForFunction(() => !document.querySelector('.run-btn-cancel'), undefined, { timeout: 20000 });
  const geometry = selector => page.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
      inViewport: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 };
  }, selector);
  const noPageScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
  const sidebar = name => page.locator(`.table-item[data-table="${name}"]`);
  return { page, document, source, errors, outbound, requests, replies, runs, settled, geometry, noPageScroll, sidebar,
    async close() { await document.session.close(); await page.close(); } };
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-ex07s-'));
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  const mounts = [];
  try {
    // ---- detection on: loading, empty sheet, pending, failed + Retry ----
    const hold = { sheet: undefined, reached: () => {}, released: Promise.resolve() };
    const gate = async sheet => { if (sheet === hold.sheet) { hold.reached(); await hold.released; } };
    const m = await mount(browser, dir, { gate });
    mounts.push(m);
    const { page } = m;
    await m.settled();

    await check('loading: a slow sheet shows Running with a reachable Cancel, the new selection and no previous-sheet tables', async () => {
      await sidebar_click(m, 'Alpha'); await m.settled();
      assert.equal(await page.evaluate(() => ex07s.inspectPainted()), 'Alpha');
      hold.sheet = 'Beta';
      const hit = new Promise(resolve => { hold.reached = resolve; });
      const release = (() => { let open; hold.released = new Promise(resolve => { open = resolve; }); return open; })();
      await m.sidebar('Beta').focus();
      await page.keyboard.press('Enter');
      await hit;
      assert.equal(await page.locator('.run-btn-cancel').count(), 1);
      assert.match(await page.locator('#status').textContent(), /Running/);
      const loadingViolations = await scan(page);
      assert.equal(await m.sidebar('Beta').getAttribute('aria-selected'), 'true');
      assert.equal(await m.sidebar('Alpha').getAttribute('aria-selected'), 'false');
      assert.ok((await m.geometry('#run-btn')).inViewport, 'Cancel button not visible at 420x800');
      assert.ok(await m.noPageScroll(), 'loading state caused horizontal page scroll');
      assert.equal(await page.evaluate(() => ex07s.inspectSelection()), 'Beta');
      release(); hold.sheet = undefined;
      assert.deepEqual(loadingViolations, [], 'loading state: axe-style violations');
      await page.waitForFunction(() => ex07s.inspectPainted() === 'Beta' && !document.querySelector('.run-btn-cancel'), undefined, { timeout: 20000 });
      assert.equal(await page.locator('#status').textContent(), '');
    });

    await check('empty sheet: "No tables found" status over a readable result, no table controls, no Retry', async () => {
      await sidebar_click(m, 'Empty'); await m.settled();
      await page.waitForFunction(() => ex07s.inspectPainted() === 'Empty');
      const banner = page.locator('.sheet-preparation-none');
      assert.equal(await banner.count(), 1);
      assert.equal(await banner.getAttribute('role'), 'status');
      assert.match(await banner.textContent(), /^No tables found\. The whole sheet is shown below\.$/);
      assert.equal(await page.locator('.sheet-table-sql').count(), 0);
      assert.equal(await page.locator('.sheet-preparation-retry').count(), 0);
      assert.ok((await m.geometry('.sheet-preparation-none')).inViewport);
      assert.deepEqual(await scan(page), [], 'empty-sheet state: axe-style violations');
      assert.ok(await m.noPageScroll());
    });

    await check('a sheet with tables shows no status banner and leaves the empty-sheet banner behind', async () => {
      await sidebar_click(m, 'Gamma'); await m.settled();
      await page.waitForFunction(() => ex07s.inspectPainted() === 'Gamma');
      assert.equal(await page.locator('.sheet-preparation').count(), 0);
      assert.equal(await page.locator('.sheet-table-sql').count(), 1);
      assert.equal(await page.locator('.sheet-table-controls').first().getAttribute('title'), 'Gamma · Table 1');
    });

    const lastQueryResult = () => m.replies.filter(r => r.command === 'queryResult').at(-1);
    const feedPreparation = status => page.evaluate(message => window.postMessage(message, '*'), { ...lastQueryResult(), sheetPreparation: status });

    await check('pending: "Detecting tables…" status with no table controls and no Retry', async () => {
      await feedPreparation({ sheet: 'Gamma', state: 'pending', generation: 0, tables: 0, skipped: 0, retryable: false });
      await page.locator('.sheet-preparation-pending').waitFor();
      assert.equal(await page.locator('.sheet-preparation-pending').textContent(), 'Detecting tables…');
      assert.equal(await page.locator('.sheet-preparation-retry').count(), 0);
      assert.ok((await m.geometry('.sheet-preparation-pending')).inViewport);
      assert.deepEqual(await scan(page), [], 'pending state: axe-style violations');
    });

    await check('failed + limited: typed status with Retry reachable by keyboard; Retry reaches the host and restores the real result', async () => {
      await feedPreparation({ sheet: 'Gamma', state: 'bounded', generation: 0, tables: 0, skipped: 0, retryable: true, message: 'Only the first 100 columns were scanned.' });
      await page.locator('.sheet-preparation-bounded').waitFor();
      assert.match(await page.locator('.sheet-preparation-bounded').textContent(), /^Detection limited\. Only the first 100 columns were scanned\.Retry detection$/);
      await feedPreparation({ sheet: 'Gamma', state: 'failed', generation: 0, tables: 0, skipped: 0, retryable: true, message: 'injected fault' });
      await page.locator('.sheet-preparation-failed').waitFor();
      assert.equal(await page.locator('.sheet-preparation-bounded').count(), 0);
      assert.ok((await m.geometry('.sheet-preparation-retry')).inViewport);
      assert.deepEqual(await scan(page), [], 'failed state: axe-style violations');
      await page.emulateMedia({ forcedColors: 'active' });
      assert.deepEqual(await scan(page), [], 'failed state under forced colors: axe-style violations');
      assert.ok((await m.geometry('.sheet-preparation-retry')).inViewport);
      await page.emulateMedia({ forcedColors: null });
      await page.evaluate(() => document.activeElement?.blur());
      for (let i = 0; i < 60 && !(await page.evaluate(() => document.activeElement?.matches('.sheet-preparation-retry'))); i++) await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.activeElement?.matches('.sheet-preparation-retry')), 'Retry not reachable by Tab');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.sheet-preparation-retry')?.disabled === true);
      assert.equal(await page.locator('.sheet-preparation-retry').textContent(), 'Detecting…');
      await page.waitForFunction(() => !document.querySelector('.sheet-preparation') && document.querySelectorAll('.sheet-table-sql').length === 1, undefined, { timeout: 20000 });
      const retries = m.requests.filter(r => r.command === 'retrySheetPreparation');
      assert.deepEqual(retries.map(r => r.sheet), ['Gamma']);
      assert.equal(m.replies.filter(r => r.command === 'sheetPreparationRetried').at(-1).sheet, 'Gamma');
      assert.equal(await page.evaluate(() => ex07s.inspectPainted()), 'Gamma');
    });

    await check('Live: interval input, status and mode radios stay inside 420px and do not overlap', async () => {
      await page.locator('#mode-live-radio').focus();
      await page.locator('#mode-live-radio').check();
      await page.waitForFunction(() => !document.querySelector('#live-options').hidden, undefined, { timeout: 15000 });
      await page.locator('#live-interval-input').fill('0.25');
      await page.keyboard.press('Tab'); // change event
      await page.waitForFunction(() => document.querySelector('#live-status').textContent.length > 0, undefined, { timeout: 15000 });
      const boxes = {};
      for (const selector of ['#mode-static-radio', '#mode-live-radio', '#live-interval-input', '#live-status']) {
        boxes[selector] = await m.geometry(selector);
        assert.ok(boxes[selector].width > 0 && boxes[selector].inViewport, `${selector} outside viewport: ${JSON.stringify(boxes[selector])}`);
      }
      const names = Object.keys(boxes);
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const a = boxes[names[i]], b = boxes[names[j]];
        assert.ok(!(a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1), `${names[i]} overlaps ${names[j]}`);
      }
      assert.ok(await m.noPageScroll(), 'Live controls caused horizontal page scroll');
      assert.equal(await page.locator('#live-interval-input').getAttribute('title'), 'Refresh interval, seconds');
      await page.locator('#mode-static-radio').check();
    });

    assert.deepEqual(m.errors, []);
    assert.deepEqual(m.outbound, []);

    // ---- settings off ----
    const off = await mount(browser, dir, { sheetTables: 'off' });
    mounts.push(off);
    const originalOff = await fs.readFile(off.source);
    await check('settings off: "Table detection is off" status names the setting, shows the whole sheet, offers no Retry or tables', async () => {
      await off.settled();
      await sidebar_click(off, 'Alpha'); await off.settled();
      await off.page.waitForFunction(() => ex07s.inspectPainted() === 'Alpha');
      const banner = off.page.locator('.sheet-preparation-disabled');
      assert.equal(await banner.count(), 1);
      assert.match(await banner.textContent(), /^Table detection is off\. Enable dataFileViewer\.sheetTables to look for tables; the whole sheet is shown below\.$/);
      assert.equal(await off.page.locator('.sheet-table-sql').count(), 0);
      assert.equal(await off.page.locator('.sheet-preparation-retry').count(), 0);
      assert.equal(await off.page.locator('td[data-r="1"][data-c="0"]').textContent(), 'Alpha0');
      assert.ok((await off.geometry('.sheet-preparation-disabled')).inViewport);
      assert.deepEqual(await scan(off.page), [], 'settings-off state: axe-style violations');
      for (const name of SHEETS) { await sidebar_click(off, name); await off.settled(); assert.equal(await off.page.locator('.sheet-preparation-disabled').count(), 1, `${name}: no off status`); }
      assert.ok(await off.noPageScroll());
    });
    assert.deepEqual(off.errors, []);
    assert.deepEqual(off.outbound, []);
    assert.deepEqual(await fs.readFile(off.source), originalOff);

    // ---- 100 rapid switches ----
    const original = await fs.readFile(m.source);
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const rapid = await mount(browser, dir, { gate: async () => { await new Promise(resolve => setTimeout(resolve, Math.floor(next() * 20))); } });
    mounts.push(rapid);
    await check('100 rapid switches (real clicks, then a same-tick burst): final sheet, selection and editor draft are right; nothing stale or foreign paints after the last choice', async () => {
      const { page: p } = rapid;
      await rapid.settled();
      await p.evaluate(() => {
        window.__paints = [];
        new MutationObserver(() => {
          const sheet = ex07s.inspectPainted();
          const labels = [...new Set([...document.querySelectorAll('.sheet-table-controls')].map(e => e.title))];
          window.__paints.push({ sheet, labels, selected: document.querySelector('.table-item.selected')?.dataset.table });
        }).observe(document.querySelector('#results'), { childList: true, subtree: true });
        ex07s.setEditor('SELECT 42 AS my_draft;');
      });
      const order = Array.from({ length: 100 }, () => SHEETS[Math.floor(next() * SHEETS.length)]);
      order[99] = 'Gamma';
      for (const name of order.slice(0, 50)) await rapid.sidebar(name).click({ noWaitAfter: true });
      await p.evaluate(names => { for (const name of names) document.querySelector(`.table-item[data-table="${name}"]`).click(); }, order.slice(50));
      await p.waitForFunction(() => ex07s.inspectPainted() === 'Gamma' && !document.querySelector('.run-btn-cancel'), undefined, { timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 500)); // late stale replies would land here
      const lastRun = rapid.runs.length;
      await new Promise(resolve => setTimeout(resolve, 500));
      const final = await p.evaluate(() => ({ painted: ex07s.inspectPainted(), selection: ex07s.inspectSelection(), editor: ex07s.inspectEditor(),
        selected: [...document.querySelectorAll('.table-item.selected')].map(e => e.dataset.table), aria: [...document.querySelectorAll('.table-item[aria-selected="true"]')].map(e => e.dataset.table),
        labels: [...new Set([...document.querySelectorAll('.sheet-table-controls')].map(e => e.title))], banner: document.querySelectorAll('.sheet-preparation').length }));
      assert.deepEqual([final.painted, final.selection, final.selected, final.aria], ['Gamma', 'Gamma', ['Gamma'], ['Gamma']]);
      assert.equal(final.editor, 'SELECT 42 AS my_draft;', 'the typed draft was replaced by navigation');
      assert.ok(final.labels.length === 1 && final.labels[0].startsWith('Gamma'), `foreign table on screen: ${JSON.stringify(final.labels)}`);
      assert.equal(final.banner, 0);
      assert.equal(rapid.runs.at(-1), 'Gamma', 'the last query the host ran was not for the last choice');
      assert.ok(rapid.runs.length >= 1 && rapid.runs.length <= 101, `unexpected query count ${rapid.runs.length}`);
      assert.equal(rapid.runs.length, lastRun, 'a query started after the last choice settled');
      const paints = await p.evaluate(() => window.__paints);
      assert.ok(paints.length > 0);
      for (const paint of paints) {
        for (const label of paint.labels) assert.ok(paint.sheet !== null && label.startsWith(paint.sheet), `foreign table flashed: ${JSON.stringify(paint)}`);
      }
      assert.equal(paints.at(-1).sheet, 'Gamma');
      console.log(`rapid switches: 100 choices -> ${rapid.runs.length} host queries, ${paints.length} paints, final ${paints.at(-1).sheet}`);
      assert.deepEqual(rapid.errors, []);
      assert.deepEqual(rapid.outbound, []);
    });
    assert.deepEqual(await fs.readFile(m.source), original, 'the source workbook changed');
    console.log(`EX-07 state acceptance passed: ${checks.length} checks.`);
  } finally {
    for (const mount of mounts) await mount.close().catch(() => undefined);
    await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function sidebar_click(m, name) { await m.sidebar(name).click(); }
