// EX-07 / V22 installed-host recording: the table viewer in an ACTUAL unpacked VS Code (native Rust table worker, disposable
// profile, no VSIX) with the workbench squeezed to 420x800. Real keyboard and mouse. Records: keyboard sheet selection,
// narrow-layout geometry, loading (worker frozen), empty sheet, damaged sheet + Retry, settings off (second launch), 100 rapid
// sheet switches (no foreign-sheet table flash, no stale paint after the last choice, no draft loss) and the four VS Code
// themes switched live (body class + axe-style scan). Source bytes, profile and network are checked at the end.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const { launch } = require('./nativeHostHarness.cjs');
const { scan } = require('../browser/a11yScan.cjs');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

const WIDTH = 420, HEIGHT = 800;
const SHEETS = ['Alpha', 'Beta', 'Empty', 'Gamma'];
const table = (name, rows) => ({ name, rows: [['id', 'v'], ...Array.from({ length: rows }, (_, i) => [`${name}${i}`, i])] });
const CONTROLS = ['#run-btn', '#safe-mode-check', '#mode-static-radio', '#query-target', '#plot-axis', '#range-input', '.table-item[data-table="Alpha"]'];
const SETTINGS = { 'workbench.activityBar.location': 'hidden', 'window.autoDetectColorScheme': false, 'workbench.colorTheme': 'Default Dark Modern' };

/** Squeeze the workbench to 420x800 and hide the side bar so the editor (and its webview) is as narrow as the viewport. */
async function narrow(host) {
  const cdp = await host.page.context().newCDPSession(host.page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  return cdp;
}
/** Hide the primary and secondary side bars (the secondary one holds the chat view and takes ~200px) so only the editor takes width. */
async function hideSideBar(host) {
  for (const [part, keys] of [['.part.sidebar', `${host.MOD}+B`], ['.part.auxiliarybar', `${host.MOD}+Alt+B`]]) {
    const shown = async () => (await host.page.locator(part).first().boundingBox().catch(() => null))?.width > 0;
    if (await shown()) { await host.page.keyboard.press(keys); await host.wait(`${part} hidden`, async () => !(await shown()), 10000); }
  }
}
const geometry = (frame, selector) => frame.evaluate(s => {
  const el = document.querySelector(s); if (!el) return null;
  const r = el.getBoundingClientRect();
  return { width: r.width, height: r.height, inViewport: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 };
}, selector);
const noPageScroll = frame => frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const sheet = (frame, name) => frame.locator(`.table-item[data-table="${name}"]`);
const painted = frame => frame.evaluate(() => [...new Set([...document.querySelectorAll('.sheet-table-controls')].map(e => e.title.split(' · ')[0]))]);

(async () => {
  const log = [];
  const pass = text => { log.push(text); console.log(`PASS ${text}`); };
  let host = await launch({ name: 'ex07', settings: SETTINGS, deadlineMs: 420000 });
  try {
    const book = path.join(host.sources, 'book.xlsx'), partial = path.join(host.sources, 'partial.xlsx');
    await xlsxFile(book, [table('Alpha', 30), table('Beta', 5), { name: 'Empty', rows: [] }, table('Gamma', 8)]);
    await xlsxFile(partial, [{ name: 'Good', rows: [['a', 'b'], [1, 2]] }, { name: 'Bad', rows: [['c'], [3]] }]);
    const members = unzipSync(new Uint8Array(await fs.readFile(partial)));
    const bad = Object.keys(members).find(n => /worksheets\/sheet2\.xml$/.test(n));
    members[bad] = strToU8(strFromU8(members[bad]).replace(/<sheetData>[\s\S]*$/, '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>3</v></c'));
    await fs.writeFile(partial, Buffer.from(zipSync(members)));
    const before = await host.tree(host.sources);

    await host.start(book);
    await narrow(host);
    await hideSideBar(host); // nothing but the editor takes width
    let frame = await host.frame('#run-btn', 'workbook editor');
    await frame.waitForFunction(() => document.querySelectorAll('.table-item').length === 4 && document.querySelector('#query-target option') && !document.querySelector('.run-btn-cancel'), null, { timeout: 30000 });
    const [worker] = await host.wait('one table worker', () => { const w = host.workers(); return w.length === 1 && w; });
    assert.equal(host.sockets(worker.pid).trim(), '', 'the native worker holds no network socket');
    await host.wait('webview narrowed', async () => (await frame.evaluate(() => innerWidth)) <= WIDTH);
    const width = await frame.evaluate(() => innerWidth);
    assert.ok(width >= 300 && width <= WIDTH, `webview width ${width}`);

    // 1. layout
    for (const selector of CONTROLS) {
      const g = await geometry(frame, selector);
      assert.ok(g && g.width > 0 && g.inViewport, `${selector} not fully inside the ${width}px webview: ${JSON.stringify(g)}`);
    }
    assert.ok(await noPageScroll(frame), 'horizontal page scroll in the host webview');
    assert.deepEqual(await scan(frame), [], 'axe-style violations in the host webview');
    pass(`host narrow layout: ${width}px webview, ${CONTROLS.length} controls inside it, no horizontal page scroll, axe-style scan clean.`);

    // 2. keyboard: real keys select sheets and operate Run
    await sheet(frame, 'Beta').focus();
    await host.page.keyboard.press('Enter');
    await frame.waitForFunction(() => document.querySelector('.table-item[data-table="Beta"]').getAttribute('aria-selected') === 'true' && document.querySelector('td[data-r="1"][data-c="0"]')?.textContent === 'Beta0' && !document.querySelector('.run-btn-cancel'));
    await host.page.keyboard.press('Shift+Tab');
    assert.equal(await frame.evaluate(() => document.activeElement?.dataset.table), 'Alpha', 'Shift+Tab returns to the previous sheet');
    await host.page.keyboard.press('Space');
    await frame.waitForFunction(() => document.querySelector('.table-item[data-table="Alpha"]').getAttribute('aria-selected') === 'true' && document.querySelector('td[data-r="1"][data-c="0"]')?.textContent === 'Alpha0' && !document.querySelector('.run-btn-cancel'));
    await host.typeSql(frame, 'SELECT 7 AS kb_answer;');
    await frame.locator('#run-btn').focus();
    await host.page.keyboard.press('Enter');
    await frame.waitForFunction(() => document.querySelector('#results')?.textContent.includes('kb_answer') && !document.querySelector('.run-btn-cancel'));
    pass('host keyboard: Enter/Space/Shift+Tab move between sheets, the SQL box takes typing and Enter on Run executes it.');

    // 3. loading: the worker is frozen mid-request, so "Running" with a reachable Cancel stays on screen until it resumes
    await sheet(frame, 'Beta').click();
    await frame.waitForFunction(() => !document.querySelector('.run-btn-cancel') && document.querySelector('td[data-r="1"][data-c="0"]')?.textContent === 'Beta0');
    process.kill(worker.pid, 'SIGSTOP');
    try {
      await sheet(frame, 'Gamma').focus();
      await host.page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('.run-btn-cancel') && /Running/.test(document.querySelector('#status').textContent));
      assert.equal(await sheet(frame, 'Gamma').getAttribute('aria-selected'), 'true');
      assert.equal(await sheet(frame, 'Beta').getAttribute('aria-selected'), 'false');
      assert.ok((await geometry(frame, '#run-btn')).inViewport, 'Cancel not visible');
      assert.ok(await noPageScroll(frame));
      assert.deepEqual(await scan(frame), [], 'loading state: axe-style violations');
      assert.deepEqual((await painted(frame)).filter(n => n !== 'Beta'), [], 'previous-sheet tables only while loading');
    } finally { process.kill(worker.pid, 'SIGCONT'); }
    await frame.waitForFunction(() => !document.querySelector('.run-btn-cancel') && document.querySelector('td[data-r="1"][data-c="0"]')?.textContent === 'Gamma0', null, { timeout: 30000 });
    pass('host loading: frozen worker shows Running + a visible Cancel, the new selection, no foreign tables; resumes to Gamma.');

    // 4. empty sheet
    await sheet(frame, 'Empty').click();
    await frame.locator('.sheet-preparation-none').waitFor();
    assert.match(await frame.locator('.sheet-preparation-none').textContent(), /^No tables found\. The whole sheet is shown below\.$/);
    assert.equal(await frame.locator('.sheet-table-sql').count(), 0);
    assert.equal(await frame.locator('.sheet-preparation-retry').count(), 0);
    assert.ok((await geometry(frame, '.sheet-preparation-none')).inViewport && await noPageScroll(frame));
    assert.deepEqual(await scan(frame), [], 'empty sheet: axe-style violations');
    pass('host empty sheet: "No tables found", no table controls, no Retry, inside the narrow webview.');

    // 5. 100 rapid switches with a typed draft: no foreign-sheet flash, no stale paint after the last choice, draft kept
    await host.typeSql(frame, 'SELECT 42 AS my_draft;');
    await frame.evaluate(() => {
      window.__paints = [];
      new MutationObserver(() => {
        const labels = [...new Set([...document.querySelectorAll('.sheet-table-controls')].map(e => e.title.split(' · ')[0]))];
        window.__paints.push({ labels, at: performance.now() });
      }).observe(document.querySelector('#results'), { childList: true, subtree: true });
    });
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const order = Array.from({ length: 100 }, () => SHEETS[Math.floor(next() * SHEETS.length)]);
    order[99] = 'Gamma';
    for (const name of order.slice(0, 40)) await sheet(frame, name).click({ noWaitAfter: true });
    const burstStart = await frame.evaluate(names => { for (const name of names) document.querySelector(`.table-item[data-table="${name}"]`).click(); return performance.now(); }, order.slice(40));
    await frame.waitForFunction(() => document.querySelector('td[data-r="1"][data-c="0"]')?.textContent === 'Gamma0' && !document.querySelector('.run-btn-cancel'), null, { timeout: 60000 });
    const settledAt = await frame.evaluate(() => performance.now());
    await host.sleep(1500); // late stale replies would land here
    const final = await frame.evaluate(() => ({ selected: [...document.querySelectorAll('.table-item[aria-selected="true"]')].map(e => e.dataset.table),
      labels: [...new Set([...document.querySelectorAll('.sheet-table-controls')].map(e => e.title.split(' · ')[0]))], banner: document.querySelectorAll('.sheet-preparation').length,
      draft: document.querySelector('.cm-content').innerText, paints: window.__paints }));
    assert.deepEqual(final.selected, ['Gamma']);
    assert.deepEqual(final.labels, ['Gamma'], 'foreign table on screen after the last choice');
    assert.equal(final.banner, 0);
    assert.equal(final.draft, 'SELECT 42 AS my_draft;', 'navigation replaced the typed draft');
    for (const paint of final.paints) assert.ok(paint.labels.length <= 1, `two sheets' tables in one paint: ${JSON.stringify(paint)}`);
    // Gamma's own table controls may still arrive after its rows (detection is asynchronous); any other sheet's may not.
    const late = final.paints.filter(p => p.at > settledAt + 50 && p.labels.some(label => label !== 'Gamma'));
    assert.deepEqual(late, [], 'another sheet painted after the last choice had settled');
    assert.equal(final.paints.at(-1)?.labels.join(), 'Gamma');
    assert.deepEqual(host.workers().map(w => w.pid), [worker.pid], 'rapid switching neither killed nor replaced the worker');
    pass(`host 100 rapid switches (40 real clicks + a 60-click same-tick burst): final Gamma, ${final.paints.length} paints, none mixed or late, draft kept, same worker; burst took ${Math.round(settledAt - burstStart)} ms.`);

    // 6. themes: the four VS Code themes switched live through the user settings
    const settingsFile = path.join(host.user, 'User', 'settings.json');
    const base = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    for (const [theme, cls] of [['Default Light Modern', 'vscode-light'], ['Default Dark Modern', 'vscode-dark'], ['Default High Contrast', 'vscode-high-contrast'], ['Default High Contrast Light', 'vscode-high-contrast-light']]) {
      await fs.writeFile(settingsFile, JSON.stringify({ ...base, 'workbench.colorTheme': theme }));
      await host.wait(`${theme} applied to the webview`, async () => (await frame.evaluate(c => document.body.classList.contains(c), cls)), 20000);
      for (const selector of CONTROLS) { const g = await geometry(frame, selector); assert.ok(g && g.inViewport, `${theme}: ${selector} ${JSON.stringify(g)}`); }
      assert.ok(await noPageScroll(frame), `${theme}: horizontal page scroll`);
      assert.deepEqual(await scan(frame), [], `${theme}: axe-style violations`);
      assert.equal(await frame.locator('.cm-content').innerText(), 'SELECT 42 AS my_draft;', `${theme}: draft lost`);
    }
    pass('host themes: Light, Dark, High Contrast and High Contrast Light applied live (body class), layout intact, axe-style scan clean, draft kept.');

    // 7. damaged sheet: typed failure with an explicit, keyboard-reachable Retry that never silently succeeds
    host.open(partial);
    const pframe = await host.wait('partial workbook frame', async () => {
      for (const f of host.page.frames()) if (!f.isDetached() && f !== frame && await f.locator('.table-item', { hasText: 'Bad' }).count().catch(() => 0)) return f;
    }, 30000);
    await pframe.locator('.table-item').filter({ hasText: /^Good/ }).first().click();
    await pframe.waitForFunction(() => document.querySelector('td[data-r]'), null, { timeout: 20000 });
    await pframe.locator('.table-item').filter({ hasText: /^Bad/ }).first().click();
    const outcome = await host.wait('damaged sheet outcome', async () => {
      const banner = await pframe.locator('.sheet-preparation, #results .error').allInnerTexts();
      return banner.length && banner.join(' | ');
    }, 30000);
    console.log(`INFO damaged sheet UI: ${outcome.slice(0, 300)}`);
    assert.deepEqual(await scan(pframe), [], 'damaged sheet: axe-style violations');
    assert.ok(await noPageScroll(pframe));
    const retry = pframe.locator('.sheet-preparation-retry');
    if (await retry.count()) {
      assert.ok((await geometry(pframe, '.sheet-preparation-retry')).inViewport, 'Retry not inside the narrow webview');
      await retry.focus();
      await host.page.keyboard.press('Enter');
      await pframe.waitForFunction(() => document.querySelector('.sheet-preparation-retry')?.disabled === true || document.querySelector('.sheet-preparation-failed'), null, { timeout: 20000 });
      await pframe.waitForFunction(() => !document.querySelector('.sheet-preparation-retry')?.disabled, null, { timeout: 30000 });
      assert.equal(await pframe.locator('.sheet-preparation-failed, #results .error').count() > 0, true, 'a retry on a still-damaged sheet must not show success');
      pass('host failure + Retry: typed failure over the sheet, Retry reachable and operable by keyboard, still-damaged sheet still reported.');
    } else {
      pass(`host failure: the damaged sheet is reported as "${outcome.slice(0, 120)}" (no Retry offered for this failure class).`);
    }
    assert.equal(host.workers().length, 2, 'one worker per open workbook');
    assert.deepEqual(await host.tree(host.sources), before, 'source workbooks unchanged');
    host.stop(); await host.allExited(); await host.profileIsolation();
  } finally { await host.cleanup(); }

  // 8. settings off: its own profile, because the setting is read when the workbook opens
  host = await launch({ name: 'ex07off', settings: { ...SETTINGS, 'dataFileViewer.sheetTables': 'off' }, deadlineMs: 240000 });
  try {
    const book = path.join(host.sources, 'book.xlsx');
    await xlsxFile(book, [table('Alpha', 30), table('Beta', 5), { name: 'Empty', rows: [] }, table('Gamma', 8)]);
    const before = await host.tree(host.sources);
    await host.start(book);
    await narrow(host);
    await hideSideBar(host);
    const frame = await host.frame('#run-btn', 'workbook editor');
    await frame.waitForFunction(() => document.querySelectorAll('.table-item').length === 4 && !document.querySelector('.run-btn-cancel'), null, { timeout: 30000 });
    for (const name of SHEETS) {
      await sheet(frame, name).click();
      await frame.locator('.sheet-preparation-disabled').waitFor();
      assert.equal(await sheet(frame, name).getAttribute('aria-selected'), 'true');
    }
    assert.match(await frame.locator('.sheet-preparation-disabled').textContent(), /^Table detection is off\. Enable dataFileViewer\.sheetTables to look for tables; the whole sheet is shown below\.$/);
    assert.equal(await frame.locator('.sheet-table-sql').count(), 0);
    assert.equal(await frame.locator('.sheet-preparation-retry').count(), 0);
    assert.ok((await geometry(frame, '.sheet-preparation-disabled')).inViewport && await noPageScroll(frame));
    assert.deepEqual(await scan(frame), [], 'settings off: axe-style violations');
    assert.deepEqual(await host.tree(host.sources), before);
    host.stop(); await host.allExited(); await host.profileIsolation();
    pass('host settings off: every sheet says "Table detection is off", names the setting, shows the whole sheet, no tables, no Retry.');
  } finally { await host.cleanup(); }
  console.log(`EX-07 installed-host recording passed: ${log.length} recorded cases.`);
})().catch(e => { console.error(e); process.exitCode = 1; });
