// EX-05 installed-host regression: the packaged VSIX in a real VS Code, with a
// disposable --user-data-dir and --extensions-dir (never the user's profile).
// Repeated-header workbook (Name/Value, Alice/1, blank, Name/Value, Bob/2):
// exactly two logical rows, sorted overlay on data rows only, overlay edit
// refused, and a sorted SQL-result edit lands on the original cell B5.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');
const { DuckDbFile } = require('../../out-test/src/duckdbConnection');

async function rawSheet(file) {
  const reader = await DuckDbFile.open(file, undefined, { forceReadOnly: true });
  try { return (await reader.runQuery('select * from "Sheet"')).rows; } finally { await reader.dispose(); }
}

(async () => {
  const executable = process.env.DFV_VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const vsix = process.env.DFV_VSIX || path.resolve(`data-file-viewer-${require('../../package.json').version}.vsix`);
  const cli = process.platform === 'darwin'
    ? path.resolve(executable, '../../Resources/app/out/cli.js')
    : path.join(path.dirname(executable), 'resources/app/out/cli.js');
  const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'dfvh-ex05-'));
  const report = { checks: [] };
  const check = async (name, fn) => { await fn(); report.checks.push(name); };
  let browser, child;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const stop = () => {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  };
  const deadline = setTimeout(() => { stop(); console.error('Installed-host test exceeded its deadline.'); process.exit(1); }, 180000);
  try {
    const user = path.join(root, 'user'), extensions = path.join(root, 'extensions');
    const cliArgs = ['--user-data-dir', user, '--extensions-dir', extensions];
    await fs.mkdir(path.join(user, 'User'), { recursive: true });
    await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
      'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
      'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true, 'update.mode': 'none',
      'workbench.editorAssociations': { '*.xlsx': 'dataFileViewer.editor' },
      'window.restoreWindows': 'none', 'files.hotExit': 'off',
    }));
    const source = path.join(root, 'repeated.xlsx');
    await xlsxFile(source, [{ name: 'Sheet', rows: [['Name', 'Value'], ['Alice', 1], [], ['Name', 'Value'], ['Bob', 2]] }]);
    execFileSync(executable, [cli, ...cliArgs, '--install-extension', vsix, '--force'],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 30000 });
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    child = spawn(executable, [...cliArgs, `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-extension', 'GitHub.copilot-chat',
      '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', source],
      { env, detached: process.platform !== 'win32', stdio: 'ignore' });
    child.on('error', error => { console.error(error.message); });
    for (let i = 0; i < 80 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(browser, 'VS Code debugging endpoint');
    let page, frame;
    for (let i = 0; i < 160 && !frame; i++) {
      page = browser.contexts()[0]?.pages().at(-1);
      if (page) for (const candidate of page.frames()) {
        if (candidate.isDetached()) continue;
        if (await candidate.locator('.sheet-table-sql').count().catch(() => 0) === 1) frame = candidate;
      }
      if (!frame) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(frame, 'packaged workbook editor rendered one detected table');
    page.setDefaultTimeout(15000);
    await page.bringToFront();
    const cell = (r, c) => frame.locator(`td[data-r="${r}"][data-c="${c}"]`);
    console.log('Packaged VS Code workbook rendered.');

    await check('one detected table labelled with exactly 2 rows', async () => {
      assert.match(await frame.locator('.sheet-table-label').first().textContent(), /· 2 rows$/);
    });
    await check('sorted overlay fills only data rows; blank and repeated header stay sheet structure', async () => {
      await frame.locator('.sheet-table-sort').nth(1).click();
      await frame.waitForFunction(() => document.querySelector('.sheet-table-label')?.textContent.includes('2 match'));
      await frame.locator('.sheet-table-sort').nth(1).click();
      await frame.waitForFunction(() => document.querySelector('td[data-r="1"][data-c="0"]')?.textContent === 'Bob');
      assert.deepEqual(
        await Promise.all([[1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1]].map(([r, c]) => cell(r, c).textContent())),
        ['2', 'NULL', 'Name', 'Value', 'Alice', '1']
      );
      assert.match(await frame.locator('.sheet-table-label').first().textContent(), /2 shown · 2 match · 2 total/);
    });
    await check('Safe Mode off; a sorted overlay cell is still refused, an excluded row is not', async () => {
      await frame.locator('#safe-mode-check').uncheck();
      await page.waitForTimeout(500);
      assert.equal(await frame.locator('#safe-mode-check').isChecked(), false);
      await cell(1, 1).dblclick();
      await frame.locator('.cell-inspector-panel').waitFor();
      assert.match(await frame.locator('.cell-inspector-note').textContent(), /sorted or filtered/);
      assert.equal(await frame.locator('.cell-inspector-footer button', { hasText: 'Save' }).count(), 0);
      await frame.locator('.cell-inspector-close').click();
      await cell(3, 1).dblclick();
      await frame.locator('.cell-inspector-panel').waitFor();
      assert.equal(await frame.locator('.cell-inspector-footer button', { hasText: 'Save' }).count(), 1);
      await frame.locator('.cell-inspector-close').click();
    });
    await check('SQL result sorted desc: editing Bob updates sheet B5 only', async () => {
      await frame.locator('.cm-content').first().fill('SELECT * FROM "Sheet · Table 1" ORDER BY "Value" DESC;');
      await frame.locator('#run-btn').click();
      await frame.waitForFunction(() => !document.querySelector('.sheet-table-sql') && document.querySelector('td[data-r="0"][data-c="0"]')?.textContent === 'Bob');
      await cell(0, 1).dblclick();
      await frame.locator('.cell-inspector-panel').waitFor();
      await frame.locator('.cell-inspector-body .cm-content').fill('7');
      await frame.locator('.cell-inspector-footer button', { hasText: 'Save' }).click();
      let sheet;
      for (let i = 0; i < 60; i++) {
        sheet = await rawSheet(source).catch(() => undefined);
        if (sheet?.[4]?.[1] === '7') break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.deepEqual(sheet, [['Name', 'Value'], ['Alice', '1'], [null, null], ['Name', 'Value'], ['Bob', '7']]);
    });
    report.result = 'pass';
    console.log(JSON.stringify(report));
    console.log('Installed-host EX-05 workflow passed: exact 2-row table, sorted overlay on data slots, overlay edit refused with Safe Mode off, sorted SQL edit hit B5.');
  } finally {
    stop();
    await browser?.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
