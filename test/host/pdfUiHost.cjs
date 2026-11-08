// V22 installed-host check of the PDF editor chrome: the real dfv-pdf worker in an ACTUAL unpacked VS Code (disposable profile,
// no VSIX), workbench squeezed to 420x800. Real keyboard. Themes: the four VS Code themes switched live (body class) with an
// axe-style scan, no horizontal page scroll, toolbar controls inside the webview, Tab reaching the toolbar and zoom by keyboard.
// Physical trackpad zoom is a manual check (recorded in the plan), never replaced by synthetic events.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch } = require('./nativeHostHarness.cjs');
const { scan } = require('../browser/a11yScan.cjs');

(async () => {
  const { samplePdf } = await import('../vsix_smoke/helpers.mjs');
  const host = await launch({ name: 'pdfui', deadlineMs: 240000, settings: {
    'workbench.activityBar.location': 'hidden', 'window.autoDetectColorScheme': false, 'workbench.colorTheme': 'Default Dark Modern',
    'workbench.editorAssociations': { '*.pdf': 'dataFileViewer.pdf' } } });
  try {
    const pdf = path.join(host.sources, 'ui.pdf');
    samplePdf(pdf);
    const before = await fs.readFile(pdf);
    await host.start(pdf);
    const cdp = await host.page.context().newCDPSession(host.page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    for (const [part, keys] of [['.part.sidebar', `${host.MOD}+B`], ['.part.auxiliarybar', `${host.MOD}+Alt+B`]]) {
      const shown = async () => (await host.page.locator(part).first().boundingBox().catch(() => null))?.width > 0;
      if (await shown()) { await host.page.keyboard.press(keys); await host.wait(`${part} hidden`, async () => !(await shown()), 10000); }
    }
    const frame = await host.frame('#zoom-in', 'PDF editor');
    await frame.waitForFunction(() => document.querySelector('#pages .page img')?.complete && document.querySelector('#pages .page img').naturalWidth > 0, null, { timeout: 30000 });
    await host.wait('webview narrowed', async () => (await frame.evaluate(() => innerWidth)) <= 420);
    const width = await frame.evaluate(() => innerWidth);
    if (!await frame.locator('#sidebar').isVisible()) await frame.locator('#rail-toggle').click();
    await host.wait('narrow sidebar visible', async () => frame.locator('#sidebar').isVisible());
    assert.equal(Math.round((await frame.locator('#sidebar').boundingBox()).width), 144, 'Left drawer uses the compact default width');
    assert.equal(await frame.locator('#sidebar-resize').getAttribute('aria-valuemin'), '128');
    for (const selector of ['#sidebar-tab-pages', '#sidebar-tab-outline', '#sidebar-close']) {
      const box = await frame.locator(selector).boundingBox(), sidebar = await frame.locator('#sidebar').boundingBox();
      assert.ok(box && box.x >= sidebar.x && box.x + box.width <= sidebar.x + sidebar.width + 1, `${selector}: fits narrow sidebar`);
    }
    await frame.locator('#sidebar-close').click();
    for (const selector of ['#export', '#zoom-in', '[data-workspace-tab="read"]']) {
      const box = await frame.locator(selector).boundingBox();
      assert.ok(box && box.height >= 24 && box.height <= 30, `${selector}: compact usable control`);
    }
    const noScroll = () => frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
    const inside = selector => frame.evaluate(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return !!r && r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1; }, selector);
    const settingsFile = path.join(host.user, 'User', 'settings.json');
    const base = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    for (const [theme, cls] of [['Default Light Modern', 'vscode-light'], ['Default Dark Modern', 'vscode-dark'], ['Default High Contrast', 'vscode-high-contrast'], ['Default High Contrast Light', 'vscode-high-contrast-light']]) {
      await fs.writeFile(settingsFile, JSON.stringify({ ...base, 'workbench.colorTheme': theme }));
      await host.wait(`${theme} applied`, async () => frame.evaluate(c => document.body.classList.contains(c), cls), 20000);
      assert.ok(await noScroll(), `${theme}: horizontal page scroll at ${width}px`);
      for (const selector of ['#zoom-in', '#zoom-out', '#zoomlbl']) assert.ok(await inside(selector), `${theme}: ${selector} outside the ${width}px webview`);
      assert.deepEqual(await scan(frame), [], `${theme}: axe-style violations in the PDF editor`);
      console.log(`PASS PDF host ${theme}: ${width}px webview, toolbar inside, no page scroll, axe-style scan clean.`);
    }
    // keyboard: Tab reaches the zoom controls and Enter on Zoom in changes the zoom label
    await frame.evaluate(() => document.activeElement?.blur());
    const label = () => frame.locator('#zoomlbl').inputValue();
    const start = await label();
    await frame.locator('#zoom-in').focus();
    assert.ok(await frame.evaluate(() => document.activeElement?.id === 'zoom-in'));
    await host.page.keyboard.press('Enter');
    await host.wait('zoom label changed by keyboard', async () => (await label()) !== start, 10000);
    console.log(`PASS PDF host keyboard: Enter on Zoom in moved ${start} -> ${await label()}.`);
    for (const mode of ['read','annotate','edit','organize']) {
      const tab=frame.locator(`[data-workspace-tab="${mode}"]`);
      assert.equal((await tab.textContent()).trim(),'');
      assert.ok(await tab.getAttribute('aria-label'));
      await tab.click();
      await frame.waitForFunction(mode=>PDFUI.workspace()===mode,mode);
      for (const id of ['export-compact','recover-drafts']) {
        assert.equal(await frame.locator('#'+id).evaluate(el=>!!el.closest('#workspace-parking')),mode!=='organize');
      }
    }
    assert.equal(await frame.locator('#reading-toggle').count(),0);
    assert.equal(await frame.locator('#selection-actions').count(),0);
    const exportBox=await frame.locator('#export').boundingBox();
    const modesBox=await frame.locator('#workspace-tabs').boundingBox();
    assert.ok(exportBox && modesBox && Math.abs(exportBox.y-modesBox.y)<15 && exportBox.x>modesBox.x+modesBox.width);
    await frame.locator('[data-workspace-tab="annotate"]').click();
    await frame.locator('#markup-menu-toggle').click();
    assert.deepEqual(await frame.locator('#markup-menu button').allTextContents(),['Yellow','Green','Blue','Pink','Purple','Underline','Strikethrough']);
    await frame.getByRole('menuitemradio',{name:'Purple',exact:true}).click();
    assert.equal(await frame.locator('#markup-toggle').getAttribute('aria-pressed'),'false');
    await frame.locator('#markup-toggle').click();
    assert.equal(await frame.locator('#markup-toggle').getAttribute('aria-pressed'),'true');
    await frame.locator('#markup-toggle').click();
    assert.equal(await frame.locator('#markup-toggle').getAttribute('aria-pressed'),'false');
    console.log('PASS Preview host: icon modes, top-right Export, Organize-only utilities, no popup/Read text, marking palette and mode toggle.');
    assert.deepEqual(await fs.readFile(pdf), before, 'the PDF changed');
    host.stop(); await host.allExited(); await host.profileIsolation();
  } finally { await host.cleanup(); }
  console.log('PDF installed-host UI check passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
