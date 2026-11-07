// EX-02 regression: worksheet navigation must never replace or lose the
// user-authored SQL draft, and the explicit worksheet selection must decide
// what is painted. Real provider + query worker + the bundled webview in
// Chrome; only the VS Code transport is substituted.
//
// Reproduced defect (audit 16 October 2026): typed `SELECT 42 AS saved_draft;`
// was replaced by `SELECT * FROM "ZOther" LIMIT 100;` when a sheet was clicked.
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

const DRAFT = 'SELECT 42 AS saved_draft;';
const SHEETS = ['Raw_Data', 'ZOther'];
const report = { checks: [] };
const check = (name, fn) => { report.checks.push(name); return fn(); };

// Test-only hooks appended to the real webview source. They read state the
// webview already owns; they do not change behavior.
const HOOKS = `
export function inspectEditor() { return editor.state.doc.toString(); }
export function inspectPaintedSheet() { return data.state.lastResult ? (data.state.lastResult.sheetPreview ?? null) : undefined; }
export function clickSheet(name) { [...document.querySelectorAll('.table-item')].find(e => e.dataset.table === name).click(); }
export function inspectLive() { return data.state.liveEnabled; }
export function inspectResult() { return data.state.lastResult; }
export function inspectSelection() { return data.state.selection; }
export function inspectPaintedExecution() { return data.state.paintedExecution; }
`;

class Memento {
  constructor() { this.values = new Map(); }
  get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; }
  keys() { return [...this.values.keys()]; }
  update(key, value) { if (value === undefined) this.values.delete(key); else this.values.set(key, value); return Promise.resolve(); }
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-ex02-'));
  const backend = selectBackend(process.cwd(), { ...process.env, DFV_BACKEND: process.env.DFV_BACKEND ?? 'reference', DFV_TABLE_STATE_DIR: path.join(dir, 'state') });
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  const views = new Set();
  const workspaceState = new Memento();
  const provider = new DuckDBEditorProvider({ extensionUri: vscode.Uri.file(process.cwd()), workspaceState }, backend);
  const bundle = (await esbuild.build({ stdin: {
    contents: await fs.readFile('src/webview.ts', 'utf8') + HOOKS, loader: 'ts', resolveDir: path.resolve('src'),
  }, bundle: true, write: false, format: 'iife', globalName: 'ex02', platform: 'browser' })).outputFiles[0].text;

  async function openView(source) {
    const file = await backend.open(source);
    if (process.env.DFV_BACKEND === 'native') assert.equal(file.constructor.name, 'NativeDocument');
    const document = new DuckDBDocument(vscode.Uri.file(source), file, undefined, undefined, backend);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const view = { page, document, errors: [], requests: [], responses: [], outbound: [], disposeCallbacks: [], holdPickerReplies: false, heldPickerReplies: [] };
    page.on('pageerror', error => view.errors.push(String(error)));
    await page.route('**/*', route => { view.outbound.push(route.request().url()); return route.abort(); });
    let handler;
    const webview = {
      cspSource: 'vscode-resource:', asWebviewUri: uri => uri,
      onDidReceiveMessage: callback => { handler = callback; return { dispose() {} }; },
      postMessage: async message => {
        view.responses.push(message);
        if (view.holdPickerReplies && ['queryTargetDetails', 'querySqlDraft'].includes(message.command)) {
          view.heldPickerReplies.push(message); return true;
        }
        if (!page.isClosed()) await page.evaluate(m => window.postMessage(m, '*'), message).catch(() => undefined);
        return true;
      },
    };
    await provider.resolveCustomEditor(document, { webview, onDidDispose: cb => { view.disposeCallbacks.push(cb); return { dispose() {} }; } });
    view.handler = message => handler(message);
    await page.exposeFunction('sendToHost', async message => { view.requests.push(message); await handler(message); });
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ path: 'media/main.css' });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => void window.sendToHost(message) }); });
    await page.addScriptTag({ content: bundle });
    // Every paint is checked, synchronously in the page, against the latest
    // sheet the user clicked before it: a worksheet preview of any other sheet
    // is a foreign paint. (Checked in-page: a round trip to Node would compare
    // against clicks made after the paint.)
    await page.evaluate(() => {
      window.__badPaints = [];
      document.addEventListener('click', event => {
        const item = event.target.closest?.('.table-item');
        if (item) window.__wanted = item.dataset.table;
      }, true);
      new MutationObserver(() => {
        const painted = ex02.inspectPaintedSheet();
        if (painted && window.__wanted && painted !== window.__wanted) window.__badPaints.push({ painted, wanted: window.__wanted });
      }).observe(document.getElementById('results'), { childList: true, subtree: true });
    });
    views.add(view);
    return view;
  }
  async function closeView(view) {
    assert.deepEqual(await view.page.evaluate(() => window.__badPaints), [], 'a foreign worksheet preview was painted');
    for (const cb of view.disposeCallbacks) cb();
    await view.document.session.close();
    await view.page.close();
    views.delete(view);
  }
  const editorText = view => view.page.evaluate(() => ex02.inspectEditor());
  const painted = view => view.page.evaluate(() => ex02.inspectPaintedSheet());
  const labels = view => view.page.locator('#query-target option').evaluateAll(o => o.map(x => x.textContent));
  const selectedItems = view => view.page.locator('.table-item[aria-selected="true"]').evaluateAll(e => e.map(x => x.dataset.table));
  const waitPainted = (view, sheet) => view.page.waitForFunction(s => ex02.inspectPaintedSheet() === s && !document.querySelector('.run-btn-cancel'), sheet, { timeout: 15000 });
  const badPaints = view => view.page.evaluate(() => window.__badPaints);
  const clickSheet = async (view, sheet) => { await view.page.locator('.table-item').filter({ hasText: new RegExp(`^${sheet}`) }).click(); };
  const typeDraft = async (view, text) => { await view.page.locator('.cm-content').fill(text); assert.equal(await editorText(view), text); };
  async function assertScoped(view, sheet) {
    const other = SHEETS.find(s => s !== sheet);
    const current = await labels(view);
    assert.ok(current.some(l => l.startsWith(`${sheet} — whole sheet`)), `picker lists ${sheet}: ${JSON.stringify(current)}`);
    assert.ok(!current.some(l => l.includes(other)), `picker must not list ${other}: ${JSON.stringify(current)}`);
  }

  try {
    const sheets = [
      { name: 'Raw_Data', rows: [['Series', 'Description'], ['example', 'Synthetic'], [], [null, 'Date', 'value'],
        ...Array.from({ length: 300 }, (_, i) => [null, new Date(Date.UTC(1989, 6, 1 + i)).toISOString().slice(0, 10), i])] },
      { name: 'ZOther', rows: [['Name', 'Value'], ['other', 7]] },
    ];
    const source = path.join(dir, 'data.xlsx');
    const second = path.join(dir, 'second.xlsx');
    await xlsxFile(source, sheets);
    await xlsxFile(second, sheets);
    const originals = [await fs.readFile(source), await fs.readFile(second)];

    let view = await openView(source);
    await waitPainted(view, 'Raw_Data');
    await view.page.waitForFunction(() => document.querySelectorAll('.sheet-table-sql').length === 2);

    await check('delayed picker details and SQL drafts cannot restore an older worksheet choice', async () => {
      const waitHeld = async count => {
        const deadline = Date.now() + 10000;
        while (view.heldPickerReplies.length < count && Date.now() < deadline) await view.page.waitForTimeout(20);
        assert.ok(view.heldPickerReplies.length >= count, `expected ${count} held picker replies`);
      };
      const release = async () => {
        view.holdPickerReplies = false;
        await view.page.evaluate(messages => { for (const message of messages) window.postMessage(message, '*'); }, view.heldPickerReplies.splice(0));
        await view.page.waitForTimeout(50);
      };
      const firstTable = async () => view.page.locator('#query-target optgroup[label="Tables"] option').first().getAttribute('value');
      await typeDraft(view, DRAFT);
      view.holdPickerReplies = true;
      await view.page.selectOption('#query-target', await firstTable());
      await waitHeld(1);
      await clickSheet(view, 'ZOther');
      await waitPainted(view, 'ZOther');
      await release();
      assert.equal(await view.page.locator('#query-target').inputValue(), '');
      assert.equal(await view.page.locator('#query-use').isDisabled(), true);
      assert.equal(await editorText(view), DRAFT);

      await clickSheet(view, 'Raw_Data');
      await waitPainted(view, 'Raw_Data');
      await assertScoped(view, 'Raw_Data');
      await view.page.selectOption('#query-target', await firstTable());
      await view.page.waitForFunction(() => !document.querySelector('#query-use').disabled);
      view.holdPickerReplies = true;
      await view.page.locator('#query-use').click();
      await waitHeld(2);
      await clickSheet(view, 'ZOther');
      await waitPainted(view, 'ZOther');
      await clickSheet(view, 'Raw_Data');
      await waitPainted(view, 'Raw_Data');
      await release();
      assert.equal(await view.page.locator('#query-target').inputValue(), '');
      assert.equal(await view.page.locator('#query-use').isDisabled(), true);
      assert.equal(await view.page.locator('#query-restore').isHidden(), true);
      assert.equal(await editorText(view), DRAFT);
      assert.equal(await view.page.locator('td[data-r][data-c]').evaluateAll(cells => cells.some(cell => cell.style.boxShadow.includes('inset'))), false);
    });

    await check('sheet click keeps the exact SQL draft (reproduced loss)', async () => {
      await typeDraft(view, DRAFT);
      await clickSheet(view, 'ZOther');
      await waitPainted(view, 'ZOther');
      assert.equal(await editorText(view), DRAFT);
      await clickSheet(view, 'Raw_Data');
      await waitPainted(view, 'Raw_Data');
      assert.equal(await editorText(view), DRAFT);
    });

    await check('selection is explicit and immediate, separate from the result', async () => {
      await clickSheet(view, 'ZOther');
      assert.deepEqual(await selectedItems(view), ['ZOther']);
      await waitPainted(view, 'ZOther');
      await assertScoped(view, 'ZOther');
    });

    await check('A→B→A awaited clicks and a 100-click synchronous burst paint only the latest selection', async () => {
      for (const sheet of ['Raw_Data', 'ZOther', 'Raw_Data', 'ZOther', 'Raw_Data']) await clickSheet(view, sheet);
      await waitPainted(view, 'Raw_Data');
      await view.page.waitForTimeout(300);
      assert.equal(await painted(view), 'Raw_Data');
      const burst = Array.from({ length: 100 }, (_, i) => SHEETS[i % 2 ? 0 : 1]);
      await view.page.evaluate(list => { for (const s of list) ex02.clickSheet(s); }, burst);
      await waitPainted(view, 'Raw_Data');
      await view.page.waitForTimeout(500);
      assert.equal(await painted(view), 'Raw_Data');
      assert.deepEqual(await selectedItems(view), ['Raw_Data']);
      await assertScoped(view, 'Raw_Data');
      assert.equal(await editorText(view), DRAFT);
    });

    await check('a delayed reply for an older selection is not painted', async () => {
      await clickSheet(view, 'ZOther');
      await waitPainted(view, 'ZOther');
      const stale = view.responses.filter(m => m.command === 'queryResult' && m.sheetPreview === 'ZOther').at(-1);
      await clickSheet(view, 'Raw_Data');
      await waitPainted(view, 'Raw_Data');
      await view.page.evaluate(m => window.postMessage(m, '*'), stale);
      await view.page.waitForTimeout(200);
      assert.equal(await painted(view), 'Raw_Data');
      await assertScoped(view, 'Raw_Data');
      assert.equal(await editorText(view), DRAFT);
    });

    await check('generic SQL keeps the draft and has no worksheet association or coordinates', async () => {
      const generic = 'SELECT 42 AS answer;';
      await typeDraft(view, generic);
      await view.page.locator('#run-btn').click();
      await view.page.waitForFunction(() => document.querySelector('.results-footer')?.textContent.includes('1 row'));
      assert.equal(await painted(view), null);
      const result = view.responses.filter(m => m.command === 'queryResult').at(-1);
      assert.equal(result.sheetPreview, undefined);
      assert.equal(result.sheetTables, undefined);
      assert.equal(result.editable, false);
      assert.equal(await view.page.locator('.row-num').count(), 0);
      assert.equal(await view.page.locator('.sheet-table-sql').count(), 0);
      assert.equal(await editorText(view), generic);
      await clickSheet(view, 'ZOther');
      await waitPainted(view, 'ZOther');
      assert.equal(await editorText(view), generic);
    });

    await check('empty results keep selection scoped and the draft intact', async () => {
      const empty = 'SELECT * FROM "ZOther" WHERE false;';
      await typeDraft(view, empty);
      await view.page.locator('#run-btn').click();
      await view.page.waitForFunction(() => !document.querySelector('.run-btn-cancel') && ex02.inspectPaintedSheet() === null);
      assert.deepEqual(await selectedItems(view), ['ZOther']);
      await assertScoped(view, 'ZOther');
      assert.equal(await editorText(view), empty);
    });

    await check('query errors keep the draft, and navigation after an error keeps it too', async () => {
      const broken = 'SELECT * FROM "ex02_missing_table";';
      await typeDraft(view, broken);
      await view.page.locator('#run-btn').click();
      await view.page.locator('.error').waitFor();
      assert.equal(await editorText(view), broken);
      await clickSheet(view, 'Raw_Data');
      await waitPainted(view, 'Raw_Data');
      assert.equal(await editorText(view), broken);
      await typeDraft(view, DRAFT);
    });

    await check('close and reopen restores the exact draft', async () => {
      const multiline = `-- keep me\n${DRAFT}\n  /* trailing spaces */   `;
      await typeDraft(view, multiline);
      await view.page.waitForTimeout(400);
      await closeView(view);
      view = await openView(source);
      await waitPainted(view, 'Raw_Data');
      assert.equal(await editorText(view), multiline);
      await clickSheet(view, 'ZOther');
      await waitPainted(view, 'ZOther');
      assert.equal(await editorText(view), multiline);
      await typeDraft(view, DRAFT);
    });

    await check('closing immediately after typing keeps the exact draft, and close clears the selection', async () => {
      // ZOther is selected; the reopened editor must start from no choice
      // (auto-preview of the first sheet), not from the closed one's.
      assert.deepEqual(await selectedItems(view), ['ZOther']);
      const quick = 'SELECT 7 AS typed_just_before_close;';
      await typeDraft(view, quick);
      await closeView(view); // no pause: nothing may depend on a save timer
      view = await openView(source);
      await waitPainted(view, 'Raw_Data');
      assert.deepEqual(await selectedItems(view), ['Raw_Data']);
      assert.equal(await editorText(view), quick);
      await typeDraft(view, DRAFT);
    });

    await check('two windows keep independent selections and drafts', async () => {
      const other = await openView(second);
      await waitPainted(other, 'Raw_Data');
      await typeDraft(other, 'SELECT 2 AS second_window;');
      await Promise.all([clickSheet(view, 'ZOther'), clickSheet(other, 'Raw_Data')]);
      await Promise.all([clickSheet(view, 'Raw_Data'), clickSheet(other, 'ZOther')]);
      await Promise.all([clickSheet(view, 'ZOther'), clickSheet(other, 'Raw_Data')]);
      await Promise.all([waitPainted(view, 'ZOther'), waitPainted(other, 'Raw_Data')]);
      await assertScoped(view, 'ZOther');
      await assertScoped(other, 'Raw_Data');
      assert.equal(await editorText(view), DRAFT);
      assert.equal(await editorText(other), 'SELECT 2 AS second_window;');
      assert.deepEqual(await badPaints(other), []);
      assert.deepEqual(other.errors, []);
      await closeView(other);
    });

    // Live mode on its own workbook, rewritten underneath the open editor.
    const liveSource = path.join(dir, 'live.xlsx');
    const writeLive = async (version, withOther = true) => {
      const staged = path.join(dir, `live-${version}.tmp.xlsx`);
      await xlsxFile(staged, [
        { name: 'Raw_Data', rows: [['Series', 'Description'], ['example', `Synthetic-${version}`], [], [null, 'Date', 'value'],
          ...Array.from({ length: 20 }, (_, i) => [null, new Date(Date.UTC(1989, 6, 1 + i)).toISOString().slice(0, 10), i + version])] },
        ...(withOther ? [{ name: 'ZOther', rows: [['Name', 'Value'], [`other-${version}`, 7 + version]] }] : [{ name: 'Fresh', rows: [['Only'], ['fresh']] }]),
      ]);
      await fs.rename(staged, liveSource); // atomic, as a writer process would publish it
    };
    const cells = view => view.page.locator('#results td').evaluateAll(t => t.map(x => x.textContent));
    const waitCell = (view, sheet, text) => view.page.waitForFunction(({ sheet, text }) =>
      ex02.inspectPaintedSheet() === sheet && !document.querySelector('.run-btn-cancel') &&
      [...document.querySelectorAll('#results td')].some(td => td.textContent === text), { sheet, text }, { timeout: 20000 }).catch(async error => {
        console.error(JSON.stringify({ waiting: { sheet, text }, painted: await painted(view),
          selection: await view.page.evaluate(() => ex02.inspectSelection()),
          cells: await cells(view), messages: view.responses.filter(m => m.command !== 'liveStatus' && !(m.command === 'liveTick' && m.unchanged)).slice(-40).map(m => ({
            command: m.command, requestId: m.requestId, unchanged: m.unchanged,
            message: m.message,
            sheet: m.sheetPreview ?? m.result?.sheetPreview,
            selectionSeq: m.selectionSeq ?? m.result?.selectionSeq,
            executionSeq: m.executionSeq ?? m.result?.executionSeq,
            rows: (m.rows ?? m.result?.rows)?.slice(0, 2),
          })) }, null, 2));
        throw error;
      });
    await writeLive(0);
    const live = await openView(liveSource);
    await waitPainted(live, 'Raw_Data');
    // Foreign rows painted under the latest click, even without a worksheet
    // label (a tick for the old sheet stripped of its association is still
    // the old sheet's rows). Only sidebar navigation runs in this view.
    await live.page.evaluate(() => {
      window.__foreignCells = [];
      const foreign = { Raw_Data: /^other-/, ZOther: /^Synthetic-/ };
      let seen = ex02.inspectResult();
      // The last host messages, kept bounded, so a foreign paint names its source.
      const recent = [];
      window.addEventListener('message', ({ data: m }) => {
        if (m?.command === 'liveStatus' || (m?.command === 'liveTick' && m.unchanged)) return;
        recent.push({ command: m?.command, requestId: m?.requestId, sheet: m?.sheetPreview ?? m?.result?.sheetPreview,
          selectionSeq: m?.selectionSeq ?? m?.result?.selectionSeq, executionSeq: m?.executionSeq ?? m?.result?.executionSeq });
        if (recent.length > 12) recent.shift();
      }, true);
      new MutationObserver(() => {
        // Only a new paint counts: rows already on screen when the click
        // happened are not a paint for the new choice.
        const current = ex02.inspectResult();
        if (current === seen) return;
        seen = current;
        const re = foreign[window.__wanted];
        const hit = re && [...document.querySelectorAll('#results td')].find(td => re.test(td.textContent));
        if (hit) window.__foreignCells.push({ wanted: window.__wanted, cell: hit.textContent, selection: ex02.inspectSelection(), recent: [...recent],
          result: { sheet: current?.sheetPreview, totalRows: current?.totalRows, rows: current?.rows.slice(0, 2), paintedExecution: ex02.inspectPaintedExecution() } });
      }).observe(document.getElementById('results'), { childList: true, subtree: true, characterData: true });
    });

    await check('live ticks repaint only the current selection; a late tick for an older selection is not painted', async () => {
      await typeDraft(live, DRAFT);
      await live.page.locator('#mode-live-radio').check();
      await live.page.waitForFunction(() => ex02.inspectLive() === true);
      await live.page.locator('#live-interval-input').fill('0.25');
      await live.page.locator('#live-interval-input').dispatchEvent('change');
      await writeLive(1);
      await waitCell(live, 'Raw_Data', 'Synthetic-1');
      for (let version = 2; version <= 5; version++) {
        await clickSheet(live, 'ZOther');
        await writeLive(version);
        await clickSheet(live, 'Raw_Data');
        await clickSheet(live, 'ZOther');
        await waitCell(live, 'ZOther', `other-${version}`);
      }
      const ticks = live.responses.filter(m => m.command === 'liveTick' && m.result?.sheetPreview === 'Raw_Data');
      assert.ok(ticks.length > 0, 'live ticks for the worksheet preview were delivered');
      await live.page.evaluate(m => window.postMessage(m, '*'), ticks.at(-1));
      await live.page.waitForTimeout(300);
      assert.equal(await painted(live), 'ZOther');
      assert.ok(!(await cells(live)).some(c => c.startsWith('Synthetic-')));
      assert.deepEqual(await selectedItems(live), ['ZOther']);
      await assertScoped(live, 'ZOther');
      assert.equal(await editorText(live), DRAFT);
    });

    await check('a replaced source without the selected sheet clears the selection and its coordinates', async () => {
      assert.deepEqual(await selectedItems(live), ['ZOther']);
      await writeLive(6, false);
      // The host lists tables by name (listTables: `order by table_name`), not
      // in workbook order, so the replacement's sidebar is Fresh, Raw_Data.
      await live.page.waitForFunction(() =>
        [...document.querySelectorAll('.table-item')].map(e => e.dataset.table).join() === 'Fresh,Raw_Data', undefined, { timeout: 20000 })
        .catch(async error => {
          console.error(JSON.stringify({ waiting: 'sidebar Fresh,Raw_Data',
            sidebar: await live.page.locator('.table-item').evaluateAll(e => e.map(x => x.dataset.table)),
            selection: await live.page.evaluate(() => ex02.inspectSelection()),
            messages: live.responses.filter(m => m.command !== 'liveStatus' && !(m.command === 'liveTick' && m.unchanged)).slice(-20)
              .map(m => ({ command: m.command, message: m.message, tables: m.tables, sheet: m.sheetPreview ?? m.result?.sheetPreview })) }, null, 2));
          throw error;
        });
      await live.page.waitForFunction(() => !document.querySelector('.table-item[aria-selected="true"]') && !ex02.inspectPaintedSheet() &&
        !document.querySelector('.row-num'), undefined, { timeout: 20000 });
      assert.equal(await live.page.locator('.sheet-table-sql').count(), 0);
      // The picker is rebuilt from the catalog the view requests after the
      // sidebar refresh, so it follows one round trip later. (A target picked
      // from the old catalog meanwhile is refused by the host's generation check.)
      await live.page.waitForFunction(() => [...document.querySelectorAll('#query-target option')].length > 1 &&
        ![...document.querySelectorAll('#query-target option')].some(o => o.textContent.includes('ZOther')), undefined, { timeout: 20000 });
      assert.equal(await editorText(live), DRAFT);
      await clickSheet(live, 'Fresh');
      await waitCell(live, 'Fresh', 'fresh');
      assert.equal(await editorText(live), DRAFT);
      await live.page.locator('#mode-static-radio').check();
      await live.page.waitForFunction(() => ex02.inspectLive() === false);
    });
    assert.deepEqual(await live.page.evaluate(() => window.__foreignCells), [], 'another sheet\'s rows were painted during live ticks');
    assert.deepEqual(live.errors, []);
    await closeView(live);

    assert.deepEqual(await badPaints(view), [], 'a worksheet preview was painted for a sheet other than the latest selection');
    assert.deepEqual(view.errors, []);
    assert.deepEqual(view.outbound, []);
    assert.deepEqual(await fs.readFile(source), originals[0]);
    assert.deepEqual(await fs.readFile(second), originals[1]);
    report.passed = true;
    console.log(`EX-02 browser regression passed: ${report.checks.length} checks.`);
  } catch (error) {
    report.passed = false;
    report.failedAt = report.checks.at(-1);
    report.error = String(error?.stack ?? error);
    throw error;
  } finally {
    if (process.env.EX02_REPORT) await fs.writeFile(process.env.EX02_REPORT, JSON.stringify(report, null, 2));
    await Promise.all([...views].map(view => view.document.session.close()));
    await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
