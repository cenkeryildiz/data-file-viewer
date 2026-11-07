// EX-07 acceptance: the table viewer at a 420x800 viewport. Real provider + query
// worker + the bundled webview and media/main.css in Chrome; only the VS Code
// transport is substituted. Asserts element geometry (inside the viewport, not
// overlapping, no page-level horizontal overflow) and drives the required controls
// with real key presses only: Tab for focus, Enter/Space/arrows/typing to operate.
// Reproduced defect (audit 16 October 2026): the fixed 220px sidebar took over half
// the width and the toolbar/query controls were clipped.
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
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); };

// Test-only reads of state the webview already owns; no behaviour change.
const HOOKS = `
export function inspectEditor() { return editor.state.doc.toString(); }
export function inspectPaintedSheet() { return data.state.lastResult ? (data.state.lastResult.sheetPreview ?? null) : undefined; }
`;

// Every control EX-07 requires, by the id or selector it is operated through.
const CONTROLS = {
  sheetRaw: '.table-item[data-table="Raw_Data"]',
  sheetOther: '.table-item[data-table="ZOther"]',
  run: '#run-btn',
  safeMode: '#safe-mode-check',
  static: '#mode-static-radio',
  live: '#mode-live-radio',
  target: '#query-target',
  use: '#query-use',
  axis: '#plot-axis',
  range: '#range-input',
  rangeApply: '#range-apply',
};

class Memento {
  constructor() { this.values = new Map(); }
  get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; }
  keys() { return [...this.values.keys()]; }
  update(key, value) { if (value === undefined) this.values.delete(key); else this.values.set(key, value); return Promise.resolve(); }
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-ex07-'));
  const backend = selectBackend(process.cwd(), { ...process.env, DFV_BACKEND: process.env.DFV_BACKEND ?? 'reference', DFV_TABLE_STATE_DIR: path.join(dir, 'state') });
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  let document;
  try {
    const source = path.join(dir, 'data.xlsx');
    await xlsxFile(source, [
      { name: 'Raw_Data', rows: [['Series', 'Value'], ...Array.from({ length: 60 }, (_, i) => [`s${i}`, i])] },
      { name: 'ZOther', rows: [['Name', 'Value'], ['other', 7]] },
    ]);
    const original = await fs.readFile(source);
    const file = await backend.open(source);
    document = new DuckDBDocument(vscode.Uri.file(source), file, undefined, undefined, backend);
    const provider = new DuckDBEditorProvider({ extensionUri: vscode.Uri.file(process.cwd()), workspaceState: new Memento() }, backend);
    const bundle = (await esbuild.build({
      stdin: { contents: await fs.readFile('src/webview.ts', 'utf8') + HOOKS, loader: 'ts', resolveDir: path.resolve('src') },
      bundle: true, write: false, format: 'iife', globalName: 'ex07', platform: 'browser',
    })).outputFiles[0].text;

    const page = await browser.newPage({ viewport: VIEWPORT });
    const errors = [];
    const outbound = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => { outbound.push(route.request().url()); return route.abort(); });
    let handler;
    const webview = {
      cspSource: 'vscode-resource:', asWebviewUri: uri => uri,
      onDidReceiveMessage: callback => { handler = callback; return { dispose() {} }; },
      postMessage: async message => {
        if (!page.isClosed()) await page.evaluate(m => window.postMessage(m, '*'), message).catch(() => undefined);
        return true;
      },
    };
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) });
    await page.exposeFunction('sendToHost', message => handler(message));
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ path: process.env.EX07_CSS ?? 'media/main.css' }); // override only to prove the test fails on the old CSS
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => void window.sendToHost(message) }); });
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => ex07.inspectPaintedSheet() === 'Raw_Data' && !document.querySelector('.run-btn-cancel'), undefined, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('#query-target option').length > 1, undefined, { timeout: 20000 });

    const active = () => page.evaluate(() => {
      const e = document.activeElement;
      return e && e !== document.body ? (e.id ? `#${e.id}` : e.dataset?.table ? `table:${e.dataset.table}` : e.tagName) : null;
    });
    // Tab forward until `selector` has focus; returns the focus order walked.
    async function tabTo(selector, limit = 40) {
      const seen = [];
      for (let i = 0; i < limit; i++) {
        if (await page.evaluate(s => document.activeElement?.matches(s), selector)) return seen;
        await page.keyboard.press('Tab');
        seen.push(await active());
      }
      assert.fail(`${selector} not reachable by Tab; walked ${JSON.stringify(seen)}`);
    }
    // Rect of `selector`, plus whether every clipping ancestor and the viewport contain it.
    const geometry = selector => page.evaluate(s => {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const o = getComputedStyle(p);
        if ((o.overflowX !== 'visible' || o.overflowY !== 'visible') && !inside(r, p.getBoundingClientRect())) clipped = true;
      }
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        inViewport: inside(r, { left: 0, right: innerWidth, top: 0, bottom: innerHeight }), clipped };
    }, selector);

    await check('viewport is 420x800 and the page does not scroll horizontally', async () => {
      assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [VIEWPORT.width, VIEWPORT.height]);
      const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(overflow.doc <= VIEWPORT.width && overflow.body <= VIEWPORT.width, `horizontal overflow ${JSON.stringify(overflow)}`);
    });

    await check('every required control is fully visible, unclipped and non-overlapping', async () => {
      const boxes = {};
      for (const [name, selector] of Object.entries(CONTROLS)) {
        const g = await geometry(selector);
        assert.ok(g.width > 0 && g.height > 0, `${name} has no box`);
        assert.ok(g.inViewport, `${name} outside the 420x800 viewport: ${JSON.stringify(g)}`);
        assert.ok(!g.clipped, `${name} clipped by a scroll container: ${JSON.stringify(g)}`);
        boxes[name] = g;
      }
      const names = Object.keys(boxes);
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const a = boxes[names[i]]; const b = boxes[names[j]];
        const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        assert.ok(!overlap, `${names[i]} overlaps ${names[j]}: ${JSON.stringify([a, b])}`);
      }
      // The SQL editor and the results grid keep a usable size.
      for (const [selector, minHeight] of [['#editor', 20], ['#results', 60]]) {
        const g = await geometry(selector);
        assert.ok(g.width >= 380 && g.height >= minHeight && g.inViewport, `${selector} too small: ${JSON.stringify(g)}`);
      }
    });

    await check('accessibility labels survive the narrow layout', async () => {
      const labelled = await page.evaluate(() => ['#query-target', '#plot-axis', '#range-input', '#safe-mode-check', '#mode-static-radio', '#mode-live-radio']
        .map(s => [s, document.querySelector(s).labels?.length ?? 0]));
      for (const [selector, count] of labelled) assert.ok(count > 0, `${selector} lost its <label>`);
      assert.equal(await page.locator('#table-list').getAttribute('role'), 'listbox');
      assert.equal(await page.locator(CONTROLS.sheetRaw).getAttribute('role'), 'option');
      assert.equal(await page.locator(CONTROLS.sheetRaw).getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#range-input').getAttribute('aria-describedby'), 'range-target');
    });

    await check('Tab reaches every required control, each one inside the viewport when focused', async () => {
      await page.evaluate(() => document.activeElement?.blur());
      const order = [];
      for (let i = 0; i < 60 && order.length < 40; i++) {
        await page.keyboard.press('Tab');
        order.push(await active());
        for (const selector of Object.values(CONTROLS)) {
          if (await page.evaluate(s => document.activeElement?.matches(s), selector)) {
            const g = await geometry(selector);
            assert.ok(g.inViewport && !g.clipped, `focused ${selector} not visible: ${JSON.stringify(g)}`);
          }
        }
      }
      for (const [name, selector] of Object.entries(CONTROLS)) {
        // A radio group has one tab stop (Live is reached by arrow key below); Use stays disabled until a table is picked.
        if (name === 'live' || name === 'use') continue;
        const id = selector.startsWith('#') ? selector : `table:${selector.match(/"(.+)"/)[1]}`;
        assert.ok(order.includes(id), `${name} (${id}) never received focus; order ${JSON.stringify(order)}`);
      }
    });

    await check('keyboard selects a sheet: Enter on a focused sheet previews it, Space returns', async () => {
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(CONTROLS.sheetOther);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => ex07.inspectPaintedSheet() === 'ZOther' && !document.querySelector('.run-btn-cancel'), undefined, { timeout: 15000 });
      assert.equal(await page.locator(CONTROLS.sheetOther).getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Shift+Tab');
      assert.ok(await page.evaluate(s => document.activeElement?.matches(s), CONTROLS.sheetRaw), `Shift+Tab did not return to the previous sheet; focus is ${await active()}`);
      await page.keyboard.press('Space');
      await page.waitForFunction(() => ex07.inspectPaintedSheet() === 'Raw_Data' && !document.querySelector('.run-btn-cancel'), undefined, { timeout: 15000 });
    });

    await check('keyboard writes and runs SQL, then picks a table and uses it', async () => {
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo('.cm-content');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('SELECT 7 AS kb_answer;');
      assert.equal(await page.evaluate(() => ex07.inspectEditor()), 'SELECT 7 AS kb_answer;');
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(CONTROLS.run);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#results')?.textContent.includes('kb_answer') && !document.querySelector('.run-btn-cancel'), undefined, { timeout: 15000 });
      assert.deepEqual(await page.locator('#results td').first().textContent(), '7');

      await tabTo(CONTROLS.target);
      const before = await page.locator(CONTROLS.target).inputValue();
      await page.keyboard.type('Raw'); // type-ahead: a closed <select> opens its popup on ArrowDown in Chrome
      assert.notEqual(await page.locator(CONTROLS.target).inputValue(), before, 'type-ahead did not change the picker');
      await page.keyboard.press('Tab'); // leaving the field commits the choice on every platform
      await page.waitForFunction(() => !document.querySelector('#query-use').disabled, undefined, { timeout: 10000 })
        .catch(async error => { throw new Error(`Use in SQL stayed disabled; picker=${await page.locator(CONTROLS.target).inputValue()}; ${error.message}`); });
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(CONTROLS.use);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /^SELECT \*\s+FROM /.test(ex07.inspectEditor()), undefined, { timeout: 10000 });
    });

    await check('keyboard drives the range form and the plot-axis picker', async () => {
      // The previous check left the generated SQL in the editor; running it gives the range a captured result.
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(CONTROLS.run);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#range-apply').disabled && !document.querySelector('.run-btn-cancel'), undefined, { timeout: 15000 });
      await tabTo(CONTROLS.axis);
      await page.keyboard.type('Row');
      assert.equal(await page.locator(CONTROLS.axis).inputValue(), 'row');
      await tabTo(CONTROLS.range);
      await page.keyboard.type('A1:B3');
      await page.waitForFunction(() => !document.querySelector('#range-apply').disabled, undefined, { timeout: 10000 });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#range-preview').hidden, undefined, { timeout: 15000 });
      const g = await geometry('#range-preview');
      assert.ok(g.inViewport && g.width <= VIEWPORT.width, `range preview not inside the viewport: ${JSON.stringify(g)}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'range preview caused page-level horizontal scrolling');
    });

    await check('Safe Mode and Live/Static radios are keyboard-operable without unlocking writes', async () => {
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(CONTROLS.safeMode);
      assert.equal(await page.locator(CONTROLS.safeMode).isChecked(), true);
      await tabTo(CONTROLS.static);
      assert.equal(await page.locator(CONTROLS.static).isChecked(), true);
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.activeElement?.id === 'mode-live-radio' && document.activeElement.checked);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Live mode caused horizontal page scroll');
      await page.keyboard.press('Shift+Tab'); // Live is a single tab stop of its group, so Shift+Tab leaves it...
      await page.keyboard.press('Tab'); // ...and Tab comes back to the checked radio
      await page.waitForFunction(() => document.activeElement?.id === 'mode-live-radio');
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => document.activeElement?.id === 'mode-static-radio' && document.activeElement.checked);
    });

    await check('error state: a failing statement shows its message in legible, announced text', async () => {
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo('.cm-content');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('SELEC nope;');
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(CONTROLS.run);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#results .error') && !document.querySelector('.run-btn-cancel'), undefined, { timeout: 15000 });
      assert.deepEqual(await scan(page), [], 'error state: axe-style violations');
    });

    // ---- V22: themes and accessibility, same mounted page (real provider/backend, bundled webview, media/main.css) ----
    // The table UI ships one fixed palette on purpose (see the top of main.css), so a theme must neither change the layout nor
    // break legibility: the matrix covers the OS colour scheme, the four VS Code theme body classes and forced-colors.
    const THEMES = [
      ['OS light + vscode-light', { colorScheme: 'light', forcedColors: 'none' }, 'vscode-light'],
      ['OS dark + vscode-dark', { colorScheme: 'dark', forcedColors: 'none' }, 'vscode-dark'],
      ['vscode-high-contrast', { colorScheme: 'dark', forcedColors: 'none' }, 'vscode-high-contrast'],
      ['vscode-high-contrast-light', { colorScheme: 'light', forcedColors: 'none' }, 'vscode-high-contrast-light'],
      ['forced-colors (dark)', { colorScheme: 'dark', forcedColors: 'active' }, 'vscode-high-contrast'],
      ['forced-colors (light)', { colorScheme: 'light', forcedColors: 'active' }, 'vscode-high-contrast-light'],
    ];
    await page.evaluate(() => document.activeElement?.blur());
    await check('themes: every theme and media mode keeps the layout inside 420x800 and the page free of axe-style violations', async () => {
      for (const [name, media, bodyClass] of THEMES) {
        await page.emulateMedia(media);
        await page.evaluate(c => { document.body.className = c; }, bodyClass);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
        for (const [control, selector] of Object.entries(CONTROLS)) {
          const g = await geometry(selector);
          assert.ok(g.inViewport && !g.clipped && g.width > 0, `${name}: ${control} not visible ${JSON.stringify(g)}`);
        }
        assert.deepEqual(await scan(page), [], `${name}: axe-style violations`);
      }
    });

    await check('themes: the selected sheet and every focused control stay distinguishable in each theme (no cue lost to forced colors)', async () => {
      const cue = selector => page.evaluate(s => {
        const el = document.querySelector(s), c = getComputedStyle(el);
        let bg = el; while (bg.parentElement && /, 0\)$/.test(getComputedStyle(bg).backgroundColor)) bg = bg.parentElement; // painted background: transparent shows the parent's
        return { bg: getComputedStyle(bg).backgroundColor, fg: c.color, shadow: c.boxShadow, border: c.borderLeftWidth + c.borderLeftStyle, outline: c.outlineStyle + c.outlineWidth, deco: c.textDecorationLine, weight: c.fontWeight };
      }, selector);
      for (const [name, media, bodyClass] of THEMES) {
        await page.emulateMedia(media);
        await page.evaluate(c => { document.body.className = c; }, bodyClass);
        // selected vs unselected sheet must differ in something forced colors keeps (colour, border, outline, decoration, weight)
        const [selected, other] = [await cue(CONTROLS.sheetRaw), await cue(CONTROLS.sheetOther)];
        const keeps = ({ bg, fg, border, outline, deco, weight, shadow }) => JSON.stringify([bg, fg, border, outline, deco, weight, name.startsWith('forced') ? '' : shadow]);
        assert.notEqual(keeps(selected), keeps(other), `${name}: the selected sheet looks identical to an unselected one ${JSON.stringify([selected, other])}`);
        // a focused control shows a ring: a real outline, or a changed border/shadow
        for (const [control, selector] of Object.entries(CONTROLS)) {
          if (await page.evaluate(sel => document.querySelector(sel).disabled === true, selector)) continue; // a disabled control takes no focus (Use / Apply wait for a table or result)
          await page.keyboard.press('Shift'); // keyboard modality, so the programmatic focus below matches :focus-visible
          await page.evaluate(s => { document.querySelector(s).focus(); }, selector);
          const focused = await page.evaluate(s => { const el = document.querySelector(s), c = getComputedStyle(el);
            return { visible: el.matches(':focus-visible'), outline: c.outlineStyle, width: parseFloat(c.outlineWidth), shadow: c.boxShadow }; }, selector);
          assert.ok(focused.visible, `${name}: ${control} not :focus-visible after keyboard focus`);
          assert.ok(focused.outline !== 'none' && focused.width > 0 || focused.shadow !== 'none', `${name}: ${control} shows no focus ring ${JSON.stringify(focused)}`);
        }
      }
      await page.emulateMedia({ colorScheme: null, forcedColors: null });
    });

    await check('reflow: at 320x568 (WCAG 1.4.10) nothing forces page-level horizontal scrolling and the controls stay reachable', async () => {
      await page.setViewportSize({ width: 320, height: 568 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px: horizontal page overflow');
      for (const [control, selector] of Object.entries(CONTROLS)) {
        const g = await geometry(selector);
        assert.ok(g.inViewport && !g.clipped && g.width > 0, `320px: ${control} not visible ${JSON.stringify(g)}`);
      }
      assert.deepEqual(await scan(page), []);
      await page.setViewportSize(VIEWPORT);
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(outbound, []);
    assert.deepEqual(await fs.readFile(source), original, 'the source workbook changed');
    console.log(`EX-07 narrow-layout browser acceptance passed: ${checks.length} checks.`);
  } finally {
    await document?.session.close();
    await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
