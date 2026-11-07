// Run with the existing playwright dependency; no worker, build or VS Code process needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { scan } = require('./browser/a11yScan.cjs');

async function main() {
  const staticDir = process.argv[2];
  assert(staticDir, 'Usage: node test/pdfTheme.cjs <packaged media/pdf/web/static> [evidence directory]');
  const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');
  const base = fs.readFileSync(path.join(staticDir, 'style.css'), 'utf8');
  const layerDir = path.join(__dirname, '../media/pdf-vscode');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    await page.setContent(html);
    await page.addStyleTag({ content: base });
    const baseline = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return Object.fromEntries(['--paper', '--paper-ink', '--overlay-rgb', '--search-fill'].map(k => [k, s.getPropertyValue(k)]));
    });
    for (const file of fs.readdirSync(layerDir).filter(file => file.endsWith('.css')).sort()) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(layerDir, file), 'utf8') });
    }
    const themes = [
      ['vscode-light', '#f3f3f3', '#202020', '#ffffff', '#0066b8'],
      ['vscode-dark', '#252526', '#cccccc', '#1e1e1e', '#007fd4'],
      ['vscode-high-contrast', '#000000', '#ffffff', '#000000', '#ffff00'],
      ['vscode-high-contrast-light', '#ffffff', '#000000', '#ffffff', '#0000ff'],
    ];
    for (const [theme, chrome, ink, well, focus] of themes) {
      await page.evaluate(({ theme, chrome, ink, well, focus }) => {
        document.body.className = theme;
        // Opposite standalone theme must not override the host's tokens.
        document.documentElement.dataset.theme = theme.includes('light') ? 'dark' : 'light';
        for (const [name, value] of Object.entries({
          'sideBar-background': chrome, foreground: ink, 'editor-background': well,
          'editorWidget-background': chrome, 'editorGroupHeader-tabsBackground': chrome,
          'toolbar-hoverBackground': chrome, 'toolbar-activeBackground': chrome,
          'list-inactiveSelectionBackground': chrome, descriptionForeground: ink,
          // real Dark Modern pairs (white on #04395e / #0e639c); the other rows keep focus-on-well pairs, which already pass
          'list-activeSelectionBackground': theme === 'vscode-dark' ? '#04395e' : focus, 'list-activeSelectionForeground': theme === 'vscode-dark' ? '#ffffff' : well,
          'button-background': theme === 'vscode-dark' ? '#0e639c' : focus, 'button-hoverBackground': theme === 'vscode-dark' ? '#1177bb' : focus, 'button-foreground': theme === 'vscode-dark' ? '#ffffff' : well,
          'panel-border': focus, 'widget-border': focus, 'input-border': focus,
          'input-background': chrome, 'input-foreground': ink,
          focusBorder: focus, contrastBorder: theme.includes('contrast') ? focus : 'transparent',
        })) document.documentElement.style.setProperty(`--vscode-${name}`, value);
        if (!document.querySelector('#theme')) {
          const select = document.createElement('select'); select.id = 'theme'; document.querySelector('.brandpad').append(select);
        }
      }, { theme, chrome, ink, well, focus });
      await page.evaluate(() => {
        getComputedStyle(document.querySelector('#zoom-in')).borderTopColor;
        for (const animation of document.getAnimations()) animation.finish();
      });
      const state = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return {
          chrome: s.getPropertyValue('--chrome').trim(), ink: s.getPropertyValue('--ink').trim(),
          well: s.getPropertyValue('--well').trim(), focus: s.getPropertyValue('--focus').trim(),
          field: s.getPropertyValue('--field-paper').trim(), fieldInk: s.getPropertyValue('--field-ink').trim(),
          ok: s.getPropertyValue('--ok').trim(), warning: s.getPropertyValue('--warn').trim(), error: s.getPropertyValue('--danger').trim(),
          warningSurface: s.getPropertyValue('--warn-soft').trim(), errorSurface: s.getPropertyValue('--danger-soft').trim(),
          paper: Object.fromEntries(['--paper', '--paper-ink', '--overlay-rgb', '--search-fill'].map(k => [k, s.getPropertyValue(k)])),
          picker: getComputedStyle(document.querySelector('#theme')).display,
        };
      });
      assert.equal(state.chrome, chrome); assert.equal(state.ink, ink);
      assert.equal(state.well, well); assert.equal(state.focus, focus);
      assert.deepEqual(state.paper, baseline, 'PDF/overlay colours must stay unchanged');
      assert.equal(state.picker, 'none');
      assert.equal(state.field, chrome); assert.equal(state.fieldInk, ink);
      assert.equal(state.warning, ink); assert.equal(state.error, ink); assert.equal(state.ok, ink);
      assert.equal(state.warningSurface, chrome); assert.equal(state.errorSurface, chrome);
      await page.locator('#zoom-in').focus();
      assert.equal(await page.locator('#zoom-in').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      // #navigation-error is created by workspace.js at runtime; this harness strips scripts.
      assert.deepEqual((await scan(page)).filter(v => !v.endsWith('missing #navigation-error on input#zoomlbl')), [], `${theme}: axe-style violations in the static PDF chrome`);
      if (theme.includes('contrast')) {
        assert.notEqual(await page.locator('#zoom-in').evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)');
      }
      if (process.argv[3]) {
        fs.mkdirSync(process.argv[3], { recursive: true });
        await page.screenshot({ path: path.join(process.argv[3], `${theme}.png`) });
      }
      console.log(`PASS ${theme}: live theme switch, host priority, focus, invariant PDF colours`);
    }
    for (const theme of ['vscode-light', 'vscode-dark']) {
      const pair = await page.evaluate(theme => {
        document.body.className = theme;
        const light = theme.endsWith('light');
        document.documentElement.style.setProperty('--vscode-foreground', light ? '#202020' : '#cccccc');
        document.documentElement.style.setProperty('--vscode-sideBar-background', light ? '#f3f3f3' : '#252526');
        for (const name of ['toolbar-hoverBackground', 'toolbar-activeBackground', 'editorGroupHeader-tabsBackground']) document.documentElement.style.removeProperty('--vscode-' + name);
        const probe = document.createElement('button'); probe.className = 'ebtn ghost'; document.body.append(probe);
        const style = getComputedStyle(probe), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const rgb = color => { ctx.fillStyle = color; ctx.fillRect(0,0,1,1); return Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3); };
        const pair = [rgb(style.color), rgb(style.backgroundColor)]; probe.remove(); return pair;
      }, theme);
      const luminance = rgb => rgb.map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum,n,i) => sum+n*[.2126,.7152,.0722][i],0);
      const [a,b] = pair.map(luminance);
      assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5, theme + ' fallback secondary button text must remain readable');
    }
    console.log('PASS optional host colors: light/dark fallback secondary buttons keep readable text');
    await page.evaluate(() => { document.body.className = ''; document.documentElement.dataset.theme = 'light'; });
    assert.notEqual(await page.locator('#theme').evaluate(el => getComputedStyle(el).display), 'none');
    console.log('PASS standalone viewer remains outside the theme layer');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
