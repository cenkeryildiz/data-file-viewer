const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const staticDir = process.argv[2], shots = process.argv[3];
  assert(staticDir, 'Usage: node test/pdfInterface.cjs <media/pdf/web/static> [screenshots directory]');
  const read = file => fs.readFileSync(path.join(staticDir, file), 'utf8');
  const html = read('index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  const workspace = read('workspace.js');
  // Exercise the original controllers, with only their engine dependencies stubbed.
  const section = (start, end) => {
    const a = workspace.indexOf(start), b = end ? workspace.indexOf(end, a) : workspace.length;
    assert(a >= 0 && b > a, `Upstream workspace section changed: ${start}`);
    return workspace.slice(a, b);
  };
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    await page.addStyleTag({ content: read('style.css') });
    for (const file of fs.readdirSync(path.join(__dirname, '../media/pdf-vscode')).filter(file => file.endsWith('.css')).sort()) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../media/pdf-vscode', file), 'utf8') });
    }
    await page.evaluate(() => {
      document.body.className = 'vscode-light';
      document.documentElement.dataset.theme = 'light';
      const vars = {
        'sideBar-background': '#f8f9fb', 'editorWidget-background': '#ffffff',
        'editorGroupHeader-tabsBackground': '#f8f9fb', foreground: '#252a34',
        descriptionForeground: '#5d6675', 'editor-background': '#e7e9ee',
        'panel-border': '#d2d7e0', 'widget-border': '#d2d7e0', 'input-border': '#9aa4b3',
        'toolbar-hoverBackground': '#e9edf4', 'toolbar-activeBackground': '#dce3ee',
        'list-inactiveSelectionBackground': '#e9edf4', 'list-activeSelectionBackground': '#e7efff',
        'list-activeSelectionForeground': '#214f9f', focusBorder: '#2458c5',
        'button-background': '#2458c5', 'button-hoverBackground': '#1d47a3',
        'button-foreground': '#ffffff', contrastBorder: 'transparent',
      };
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(`--vscode-${name}`, value);
      window.scheduleMaintain = () => {};
      window.toast = () => {};
      window.clampWidth = (_ed, width) => width;
      window.draftChanged = () => {};
      window.S = { editOn: false };
      window.PDFUI = { documentChanged() {} };
      window.testDraftOpen = false; window.testMayLeave = false;
      window.editorOpen = () => window.testDraftOpen;
      window.requestEditorTransition = async () => window.testMayLeave;
      window.formulaMode = () => {};
      window.setActiveMarkup = () => {};
      document.getElementById('formula-toggle').disabled = true;
      document.getElementById('formula-toggle').title = 'Native math is not available';
      document.getElementById('docname').textContent = 'Editing interface preview · sample document';
    });
    await page.addScriptTag({ content: `(() => { const toolbar = document.getElementById('toolbar'); ${section("  const controls = document.createElement('div');", '  const navigationError =')} })();` });
    await page.addScriptTag({ content: read('viewerInspector.js') });
    const layer = fs.readFileSync(path.join(__dirname, '../media/pdf-vscode/interface.js'), 'utf8');
    await page.addScriptTag({ content: layer });
    await page.addScriptTag({ content: layer }); // Repeated loading must not duplicate the helper.
    await page.addScriptTag({ content: section("const WORKSPACES =", '// UI-03: accept physical positions') });
    await page.addScriptTag({ content: section('/* UI-01: one workspace state, fixed actions, and a measured More menu.') });
    await page.evaluate(() => PDFUI.setWorkspace('edit'));
    await page.evaluate(() => {
      document.getElementById('sidebar').classList.add('hidden');
      document.getElementById('sidebar-resize').classList.add('panel-collapsed');
      const paper = document.createElement('article');
      paper.style.cssText = 'width:620px;max-width:100%;margin:24px auto;padding:54px;background:white;color:#252a34;box-shadow:0 4px 18px #0002;font:16px/1.7 Georgia,serif';
      paper.innerHTML = '<p style="font:12px system-ui;letter-spacing:2px;color:#697386">SAMPLE DOCUMENT · UI PREVIEW</p><h1 style="font-size:30px;line-height:1.2">A clearer space<br>for your ideas.</h1><p>Edit the selected paragraph on the page. The settings and actions stay alongside it, so the document remains the centre of your work.</p><div id="sample-host" class="inplace" style="position:relative;padding:12px;background:white"><div id="sample-text" class="iptext" contenteditable="plaintext-only">Good tools let you focus on the document. Make your change here, review the preview, and apply it when you are ready.</div><div class="ipgrip"></div></div><p style="color:#697386">This page is a visual fixture. It is not rendered PDF output.</p>';
      document.getElementById('pages').append(paper);
      const host = document.getElementById('sample-host'), area = document.getElementById('sample-text');
      const bar = document.createElement('div'); bar.className = 'ipbar';
      bar.innerHTML = '<span class="ipwas">Helvetica · 12pt</span><span class="ipmode" role="group" aria-label="Editing mode"><button id="ipmode-text" class="ebtn on">Text</button><button id="ipmode-latex" class="ebtn" disabled title="Native math is not available">LaTeX</button></span><span class="iplines">3 lines</span><span class="ipstatus">Preview ready. Review the change on the page before applying.</span><label class="ipgrow hidden"><input type="checkbox">Allow taller content</label><button id="ipcancel">Cancel</button><button id="ipsave" disabled>Apply</button>';
      const source = { ta: document.createElement('textarea') };
      window.originalApply = bar.querySelector('#ipsave');
      window.applies = 0; window.originalApply.onclick = () => window.applies++;
      window.testDraft = { kind: 'text', page: 0, mode: 'text', width: 320, render() {} };
      PDFInspector.attach({ host, bar, ed: window.testDraft, area, source, initialWidth: 320 });
      window.testDraftOpen = true;
    });
    assert.equal(await page.locator('#editing-help').count(), 1);
    assert.equal(await page.locator('#properties').getAttribute('aria-describedby'), 'editing-help');
    assert.equal(await page.locator('#editing-kicker').count(), 1);
    assert.equal(await page.locator('#properties-title').textContent(), 'Edit selection');
    assert(await page.locator('#ipsave').isDisabled(), 'UI must preserve Apply readiness');
    assert(await page.locator('#ipmode-latex').isDisabled(), 'UI must preserve unsupported-tool state');
    await page.locator('.ipgrip').focus();
    await page.keyboard.press('ArrowRight');
    await page.evaluate(()=>PDFInspector.sync());
    assert.equal(await page.locator('.ipgrip').getAttribute('aria-valuenow'),'321');
    assert.equal(await page.locator('.ipgrip').evaluate(el=>getComputedStyle(el).outlineStyle),'solid');
    await page.keyboard.press('Shift+ArrowLeft');
    assert.equal(await page.evaluate(()=>testDraft.width),311);
    await page.evaluate(()=>{document.getElementById('sample-host').dataset.sending='true';PDFInspector.sync();});
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>testDraft.width),311,'Busy drafts must keep their width');
    assert.equal(await page.locator('.ipgrip').getAttribute('aria-disabled'),'true');
    await page.evaluate(()=>{delete document.getElementById('sample-host').dataset.sending;testDraft.composing=true;PDFInspector.sync();});
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>testDraft.width),311,'IME composition must keep its width');
    await page.evaluate(()=>{testDraft.width=320;testDraft.composing=false;PDFInspector.sync();});
    assert.equal(await page.evaluate(() => PDFUI.setWorkspace('read')), false, 'Workspace change must preserve the draft guard');
    assert.equal(await page.locator('[data-workspace-tab="edit"]').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { originalApply.disabled = false; });
    await page.locator('#ipsave').click();
    assert.equal(await page.evaluate(() => applies), 1, 'The existing Apply handler must run once');
    await page.locator('#properties-hide').click();
    await page.locator('#properties-toggle').click();
    assert.equal(await page.locator('#sample-text').textContent(), 'Good tools let you focus on the document. Make your change here, review the preview, and apply it when you are ready.');
    assert(await page.evaluate(() => document.querySelector('#ipsave') === originalApply));
    await page.evaluate(() => { testDraft.composing = true; });
    await page.locator('#properties-hide').click();
    assert(await page.locator('#properties').isVisible(), 'Hiding must retain an active IME composition');
    await page.evaluate(() => { testDraft.composing = false; });
    console.log('PASS original inspector: readiness, unsupported tools, draft guard, action identity and hide/reopen');
    const footprint = await page.locator('#properties').evaluate(el => {
      const s = getComputedStyle(el);
      return el.getBoundingClientRect().width + parseFloat(s.marginLeft) + parseFloat(s.marginRight);
    });
    assert.equal(footprint, 350, 'Inset inspector must retain the layout controller\'s 350px reservation');
    const lightStyle = await page.locator('html').getAttribute('style');
    for (const [theme, bg, raised, ink] of [
      ['vscode-dark', '#1c1c1e', '#2c2c2e', '#f2f2f7'],
      ['vscode-high-contrast', '#000000', '#000000', '#ffffff'],
      ['vscode-high-contrast-light', '#ffffff', '#ffffff', '#000000'],
    ]) {
      await page.evaluate(({ theme, bg, raised, ink }) => {
        document.body.className = theme;
        const contrast = theme.includes('contrast');
        const focus = contrast ? (theme.includes('light') ? '#0000ff' : '#ffff00') : '#0a84ff';
        for (const [name, value] of Object.entries({
          'sideBar-background': bg, 'editorWidget-background': raised, 'editor-background': bg,
          'editorGroupHeader-tabsBackground': bg, foreground: ink, descriptionForeground: ink,
          'panel-border': ink, 'input-border': ink, focusBorder: focus,
          contrastBorder: contrast ? focus : 'transparent',
        })) document.documentElement.style.setProperty(`--vscode-${name}`, value);
      }, { theme, bg, raised, ink });
      if (theme.includes('contrast')) {
        assert.equal(await page.locator('#properties').evaluate(el => getComputedStyle(el).boxShadow), 'none');
      }
      await page.locator('#ipsave').click({ trial: true });
      assert(await page.locator('#ipmode-latex').isDisabled());
      assert.equal(await page.locator('#pages article h1').evaluate(el => getComputedStyle(el).color), 'rgb(37, 42, 52)', 'Host theme must not recolour document text');
      if (shots) {
        // Capture the document separately too: this Chromium build can omit its raster in the first whole-page capture after a theme switch.
        await page.locator('#stage').screenshot({ path: path.join(shots, `document-${theme}.png`), animations: 'disabled' });
        await page.screenshot({ path: path.join(shots, `editing-${theme}.png`), animations: 'disabled' });
      }
    }
    await page.evaluate(style => {
      document.documentElement.setAttribute('style', style);
      document.body.className = 'vscode-light';
    }, lightStyle);
    console.log('PASS editing inspector: dark and both high-contrast themes');

    for (const width of [1440, 1024, 800, 640, 480, 320]) {
      await page.setViewportSize({ width, height: 950 });
      // Emulate the existing panel controller's docked/drawer decision, without an engine.
      await page.evaluate(width => document.getElementById('properties').classList.toggle('panel-drawer', width <= 800), width);
      await page.waitForFunction(() => document.getElementById('toolbar').scrollWidth <= innerWidth);
      for (const selector of ['#export', '#properties-toggle', '#zoom-in', '#page-fit', '#ipsave', '#ipcancel']) {
        const box = await page.locator(selector).boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 950, `${selector} outside ${width}px viewport`);
        await page.locator(selector).click({ trial: true });
      }
      assert(await page.locator('#ipsave').isVisible());
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `editing-${width}.png`) });
      }
      console.log(`PASS ${width}px: wrapped toolbar and reachable editing actions`);
    }
    await page.setViewportSize({ width: 640, height: 950 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
      document.querySelector('.ipstatus').textContent = 'Preview refused: '.repeat(150);
    });
    const stickyBox = await page.locator('#ipsave').boundingBox();
    assert(stickyBox && stickyBox.y >= 0 && stickyBox.y + stickyBox.height <= 950, 'Apply must stay visible while a long refusal scrolls');
    await page.locator('#ipsave').scrollIntoViewIfNeeded();
    await page.locator('#ipcancel').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ipsave');
    assert.equal(await page.locator('#ipsave').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    assert(await page.locator('#ipsave').isVisible());
    const actionBox = await page.locator('#ipsave').boundingBox();
    assert(actionBox.x >= 0 && actionBox.x + actionBox.width <= 641 && actionBox.y + actionBox.height <= 950, 'Apply must remain inside the enlarged-text viewport');
    await page.locator('#ipsave').click({ trial: true });
    assert.deepEqual(errors, []);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#zoom-in').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await page.setViewportSize({ width: 320, height: 700 });
    await page.locator('#stage').focus();
    for (const selector of ['#ipsave', '#properties-hide', '#ipcancel']) {
      await page.locator(selector).focus();
      const box = await page.locator(selector).boundingBox();
      const panel = await page.locator('#properties').boundingBox();
      assert(box && panel && box.x >= panel.x && box.x + box.width <= panel.x + panel.width + 1 && box.y >= panel.y && box.y + box.height <= panel.y + panel.height + 1, selector + ' must remain reachable inside the enlarged-text inspector: ' + JSON.stringify({box,panel}));
    }
    if (shots) await page.screenshot({ path: path.join(shots, 'editing-enlarged-narrow.png') });
    console.log('PASS enlarged text and long refusal: keyboard reaches header and actions down to 320px');

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(style => {
      document.documentElement.setAttribute('style', style);
      document.documentElement.style.fontSize = '16px';
      document.body.className = 'vscode-light';
      PDFInspector.close(); testDraftOpen = false; testMayLeave = true;
      document.getElementById('sidebar').classList.remove('hidden');
      document.getElementById('sidebar-resize').classList.remove('panel-collapsed');
      document.getElementById('docname').textContent = 'Field Notes — Design & Attention.pdf · UI preview';
      document.getElementById('page-count').textContent = 'of 3';
      const paper = document.querySelector('#pages article');
      paper.style.cssText = 'width:620px;min-height:760px;margin:0;padding:58px;background:white;color:#252a34;font:15px/1.75 Georgia,serif';
      paper.innerHTML = '<p style="font:11px system-ui;letter-spacing:2px;color:#697386">FIELD NOTES &nbsp; / &nbsp; DESIGN & ATTENTION</p><h1 style="font-size:40px;line-height:1.12;font-weight:500;margin:38px 0 24px">Space to think.<br>Room to read.</h1><p style="font-size:19px;line-height:1.6;color:#59616e">A quiet workspace for the ideas<br>that deserve your full attention.</p><hr style="border:0;border-top:1px solid #dddfe5;margin:32px 0"><p>Good design gives the important things room to breathe. The page stays at the centre, while navigation and notes sit close enough to help, and far enough away to let you focus.</p><h2 style="font-size:20px;font-weight:500;margin-top:30px">01 &nbsp; A considered reading experience</h2><p>Move through a document at your own pace. Keep an outline nearby, mark a passage worth returning to, or collect a thought without losing your place.</p><p style="font-size:12px;color:#697386;margin-top:44px">SAMPLE DOCUMENT · VISUAL PREVIEW &nbsp; / &nbsp; 01</p>';
    }, lightStyle);
    await page.evaluate(() => PDFUI.setWorkspace('read'));
    const image = await page.locator('#pages article').screenshot({ animations: 'disabled' });
    await page.evaluate(src => {
      const shell = document.createElement('div'); shell.className = 'page'; shell.id = 'reading-page';
      shell.style.cssText = 'width:620px;height:760px';
      const image = document.createElement('img'); image.src = src; image.alt = 'Sample document for the reading interface preview';
      shell.append(image); document.getElementById('pages').replaceChildren(shell);
      const rail = document.getElementById('rail');
      for (let i = 1; i <= 3; i++) {
        const thumb = document.createElement('div'); thumb.className = `thumb${i === 1 ? ' sel' : ''}`;
        thumb.tabIndex = i === 1 ? 0 : -1; thumb.setAttribute('role', 'option');
        thumb.setAttribute('aria-selected', String(i === 1)); thumb.setAttribute('aria-label', `Page ${i}`);
        thumb.innerHTML = `<div class="shot" style="aspect-ratio:620/760"><img alt="" src="${src}"></div><span class="no">${i}</span>`;
        rail.append(thumb);
      }
      document.getElementById('pageinfo').textContent = 'Page 1 of 3';
    }, `data:image/png;base64,${image.toString('base64')}`);
    assert.equal(await page.locator('#properties-toggle').isVisible(), false, 'Reading mode must not show an unavailable editing panel');
    assert.equal(await page.locator('#reading-page img').evaluate(el => el.complete), true);
    await page.locator('#docname').click();
    for (const width of [1440, 1024, 640, 480, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(width => {
        document.getElementById('sidebar').classList.toggle('hidden', width <= 800);
        document.getElementById('sidebar-resize').classList.toggle('panel-collapsed', width <= 800);
        document.getElementById('rail-toggle').classList.toggle('on', width > 800);
        document.getElementById('rail-toggle').setAttribute('aria-expanded', String(width > 800));
        const paper = document.getElementById('reading-page'), size = Math.min(620, document.getElementById('stage').clientWidth - 48);
        paper.style.width = `${size}px`; paper.style.height = `${size * 760 / 620}px`;
      }, width);
      for (const selector of ['#export', '#zoom-in', '#page-fit', '#notes-toggle', '#rail-toggle']) {
        await page.locator(selector).click({ trial: true });
      }
      assert(await page.evaluate(() => document.getElementById('toolbar').scrollWidth <= innerWidth));
      if (shots) await page.screenshot({ path: path.join(shots, `reading-${width}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      document.getElementById('sidebar').classList.remove('hidden');
      document.getElementById('sidebar-resize').classList.remove('panel-collapsed');
      document.getElementById('rail-toggle').classList.add('on');
      document.getElementById('rail-toggle').setAttribute('aria-expanded', 'true');
      document.getElementById('reading-page').style.cssText = 'width:620px;height:760px';
      const notes = document.getElementById('notes'); notes.classList.remove('hidden');
      document.getElementById('notes-resize').classList.remove('panel-collapsed');
      document.getElementById('notes-toggle').classList.add('on');
      document.getElementById('notes-toggle').setAttribute('aria-expanded', 'true');
      notes.innerHTML = '<div class="nhead">Comments <span class="ncount">2</span></div><article class="note"><div class="nrow"><span class="ndot" style="background:#e4b84c"></span><span class="nkind">Highlight</span><span class="npage">Page 1</span></div><div class="nquote">Good design gives the important things room to breathe.</div><p class="nbody">Keep this thought for the introduction.</p><div class="nwho">Sample comment · Just now</div></article><article class="note"><div class="nrow"><span class="ndot" style="background:#7aa3d9"></span><span class="nkind">Note</span><span class="npage">Page 2</span></div><div class="nbody">A useful reference for our next discussion.</div><div class="nwho">Sample comment · Today</div></article>';
    });
    assert(await page.locator('#notes .note').first().isVisible());
    if (shots) await page.screenshot({ path: path.join(shots, 'reading-comments.png'), animations: 'disabled' });
    await page.evaluate(() => {
      document.getElementById('notes').classList.add('hidden');
      document.getElementById('notes-resize').classList.add('panel-collapsed');
      document.getElementById('notes-toggle').classList.remove('on');
      document.getElementById('notes-toggle').setAttribute('aria-expanded', 'false');
      document.body.className = 'vscode-dark';
      for (const [name, value] of Object.entries({
        'sideBar-background': '#1c1c1e', 'editorWidget-background': '#2c2c2e', 'editor-background': '#18181b',
        'editorGroupHeader-tabsBackground': '#1c1c1e', foreground: '#f2f2f7', descriptionForeground: '#a1a1aa',
        'panel-border': '#45454a', 'widget-border': '#45454a', 'input-border': '#77777e',
        'list-inactiveSelectionBackground': '#34343a', 'toolbar-hoverBackground': '#34343a',
      })) document.documentElement.style.setProperty(`--vscode-${name}`, value);
    });
    if (shots) {
      await page.locator('#stage').screenshot({ path: path.join(shots, 'reading-document-dark.png'), animations: 'disabled' });
      await page.locator('#sidebar').screenshot({ path: path.join(shots, 'reading-sidebar-dark.png'), animations: 'disabled' });
      await page.screenshot({ path: path.join(shots, 'reading-dark.png'), animations: 'disabled' });
    }
    await page.evaluate(style => {
      document.documentElement.setAttribute('style', style); document.body.className = 'vscode-light';
      document.getElementById('pages-panel').hidden = true;
      document.getElementById('outline-panel').hidden = false;
      document.getElementById('sidebar-tab-pages').setAttribute('aria-selected', 'false');
      document.getElementById('sidebar-tab-pages').tabIndex = -1;
      document.getElementById('sidebar-tab-outline').setAttribute('aria-selected', 'true');
      document.getElementById('sidebar-tab-outline').tabIndex = 0;
      document.getElementById('outline-panel').innerHTML = '<label><span class="sr-only">Find section</span><input type="search" placeholder="Find a section"></label><p class="outline-status">Document outline · 3 sections</p><div class="outline-rows"><button><span class="outline-title">Design & attention</span><span class="outline-page">1</span></button><button><span class="outline-title">A considered reading experience</span><span class="outline-page">1</span></button><button><span class="outline-title">Notes for later</span><span class="outline-page">2</span></button></div>';
    }, lightStyle);
    assert(await page.locator('#outline-panel input').isVisible());
    await page.locator('#outline-panel input').fill('reading');
    assert.equal(await page.locator('#outline-panel input').inputValue(), 'reading');
    await page.locator('#outline-panel input').fill('');
    await page.locator('#docname').click();
    if (shots) await page.screenshot({ path: path.join(shots, 'reading-outline.png'), animations: 'disabled' });
    assert.deepEqual(errors, []);
    console.log('PASS reading view: editor closed, thumbnails, comments, dark theme and reachable controls down to 320px');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
