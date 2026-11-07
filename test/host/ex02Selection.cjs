// EX-02 installed-host regression: the packaged VSIX in a real VS Code, with a
// disposable --user-data-dir and --extensions-dir (never the user's profile).
//
// Reproduced defect (audit 16 October 2026, installed-probe.json): typed
// `SELECT 42 AS saved_draft;` became `SELECT * FROM "ZOther" LIMIT 100;` after
// a sheet click. This drives the same click, then A→B→A switches, generic SQL
// and a close/reopen of the editor, asserting the exact draft each time.
//
// DFV_HOST_ROOT places the disposable profile under a run directory so the
// evidence is retained; otherwise a temporary directory is used and removed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

const DRAFT = 'SELECT 42 AS saved_draft;';
const MARKER = { Raw_Data: 'Synthetic', ZOther: 'other' };

(async () => {
  const executable = process.env.DFV_VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const vsix = process.env.DFV_VSIX || path.resolve(`data-file-viewer-${require('../../package.json').version}.vsix`);
  const developmentPath = process.env.DFV_EXTENSION_DEVELOPMENT_PATH && path.resolve(process.env.DFV_EXTENSION_DEVELOPMENT_PATH);
  const cli = process.platform === 'darwin'
    ? path.resolve(executable, '../../Resources/app/out/cli.js')
    : path.join(path.dirname(executable), 'resources/app/out/cli.js');
  const keepRoot = !!process.env.DFV_HOST_ROOT;
  const root = keepRoot
    ? (await fs.mkdir(process.env.DFV_HOST_ROOT, { recursive: true }), process.env.DFV_HOST_ROOT)
    : await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'dfvh-ex02-'));
  const report = { root, checks: [] };
  const check = async (name, fn) => { report.checks.push(name); await fn(); };
  let browser, child, page, frame;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const stop = () => {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  };
  const deadline = setTimeout(() => { stop(); console.error('Installed-host test exceeded its deadline.'); process.exit(1); }, 180000);
  // VS Code keeps IPC sockets inside --user-data-dir; macOS limits a socket
  // path to ~104 bytes, so a long run directory is reached through a short
  // temporary symlink. The profile's bytes still live under the run directory.
  let alias;
  if (keepRoot && root.length > 40) {
    alias = path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `dfvx-${process.pid}`);
    await fs.rm(alias, { force: true });
    await fs.symlink(root, alias, 'dir');
  }
  const profileBase = alias ?? root;
  const user = path.join(profileBase, 'user'), extensions = path.join(profileBase, 'extensions');
  report.profile = { userDataDir: path.join(root, 'user'), extensionsDir: path.join(root, 'extensions'), alias };
  const cliArgs = ['--user-data-dir', user, '--extensions-dir', extensions];
  try {
    await fs.mkdir(path.join(user, 'User'), { recursive: true });
    await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
      'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
      'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true, 'update.mode': 'none',
      'workbench.editorAssociations': { '*.xlsx': 'dataFileViewer.editor' },
      'window.restoreWindows': 'none', 'files.hotExit': 'off',
    }));
    const source = path.join(root, 'data.xlsx');
    await xlsxFile(source, [{ name: 'Raw_Data', rows: [
      ['Series', 'Description'], ['example', 'Synthetic'], [], [null, 'Date', 'value'],
      ...Array.from({ length: 300 }, (_, i) => [null, new Date(Date.UTC(1989, 6, 1 + i)).toISOString().slice(0, 10), i]),
    ] }, { name: 'ZOther', rows: [['Name', 'Value'], ['other', 7]] }]);
    const original = await fs.readFile(source);
    if (!developmentPath) execFileSync(executable, [cli, ...cliArgs, '--install-extension', vsix, '--force'],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 30000 });
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    child = spawn(executable, [...cliArgs, `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-extension', 'GitHub.copilot-chat',
      ...(developmentPath ? [`--extensionDevelopmentPath=${developmentPath}`] : []),
      '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', source],
      { env, detached: process.platform !== 'win32', stdio: 'ignore' });
    child.on('error', error => { console.error(error.message); });
    for (let i = 0; i < 80 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(browser, 'VS Code debugging endpoint');

    async function findFrame() {
      frame = undefined;
      for (let i = 0; i < 160 && !frame; i++) {
        page = browser.contexts()[0]?.pages().at(-1);
        if (page) for (const candidate of page.frames()) {
          if (candidate.isDetached()) continue;
          if (await candidate.locator('.table-item').count().catch(() => 0) >= 2) frame = candidate;
        }
        if (!frame) await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(frame, 'workbook editor rendered its sheet list');
      page.setDefaultTimeout(15000);
      return frame;
    }
    const editor = () => frame.locator('.cm-content');
    const editorText = () => frame.evaluate(() => document.querySelector('.cm-content').innerText);
    // Painted = the worksheet grid (row numbers) shows this sheet's cells and
    // the picker lists only this sheet, with nothing running.
    const waitPainted = sheet => frame.waitForFunction(({ sheet, marker, foreign }) => {
      const cells = [...document.querySelectorAll('#results td')].map(td => td.textContent);
      const options = [...document.querySelectorAll('#query-target option')].map(o => o.textContent);
      return !document.querySelector('.run-btn-cancel') && document.querySelector('.row-num') &&
        cells.includes(marker) && !cells.includes(foreign) &&
        options.some(o => o.startsWith(`${sheet} — whole sheet`)) && !options.some(o => o.includes(foreign === 'other' ? 'ZOther' : 'Raw_Data'));
    }, { sheet, marker: MARKER[sheet], foreign: MARKER[sheet === 'Raw_Data' ? 'ZOther' : 'Raw_Data'] }, { timeout: 15000 });
    // Cmd+W closes the editor; when VS Code treats the window as empty it
    // closes the window instead, and the page goes away during the key press.
    // Either way the editor is closed, which is what the draft must survive.
    const closeEditor = () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W')
      .catch(error => { if (!page.isClosed()) throw error; });
    const clickSheet = sheet => frame.locator('.table-item').filter({ hasText: new RegExp(`^${sheet}`) }).click();
    const typeSql = async text => {
      await editor().click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.insertText(text);
      assert.equal(await editorText(), text, 'the editor holds exactly the typed SQL before the next action');
    };

    await findFrame();
    if (process.env.DFV_BACKEND !== 'reference') {
      assert.ok(process.env.DFV_TABLE_WORKER, 'native host qualification names its exact worker');
      const { descendants } = await import('../vsix_smoke/helpers.mjs');
      const worker = await fs.realpath(process.env.DFV_TABLE_WORKER);
      assert.ok(descendants(child.pid).some(p => p.command.includes(worker)), 'the native table worker is running under this VS Code instance');
    }
    await page.bringToFront();
    await clickSheet('Raw_Data');
    await waitPainted('Raw_Data');
    console.log(`${developmentPath ? 'Unpacked development' : 'Packaged'} VS Code workbook rendered.`);

    await check('sheet click keeps the exact SQL draft (reproduced loss)', async () => {
      await typeSql(DRAFT);
      await clickSheet('ZOther');
      await waitPainted('ZOther');
      report.draftAfterSwitch = await editorText();
      assert.equal(report.draftAfterSwitch, DRAFT);
    });
    await check('A→B→A switches paint the latest sheet and keep the draft', async () => {
      for (const sheet of ['Raw_Data', 'ZOther', 'Raw_Data']) await clickSheet(sheet);
      await waitPainted('Raw_Data');
      await page.waitForTimeout(500);
      await waitPainted('Raw_Data');
      assert.equal(await editorText(), DRAFT);
    });
    await check('generic SQL has no worksheet coordinates and keeps its text', async () => {
      await typeSql('SELECT 42 AS answer;');
      await frame.locator('#run-btn').click();
      await frame.waitForFunction(() => document.querySelector('.results-footer')?.textContent.includes('1 row'));
      assert.equal(await frame.locator('.row-num').count(), 0);
      assert.equal(await frame.locator('.sheet-table-sql').count(), 0);
      await clickSheet('ZOther');
      await waitPainted('ZOther');
      assert.equal(await editorText(), 'SELECT 42 AS answer;');
      await typeSql(DRAFT);
    });
    await check('a query error keeps the draft, and navigation after it keeps it too', async () => {
      const broken = 'SELECT * FROM "ex02_missing_table";';
      await typeSql(broken);
      await frame.locator('#run-btn').click();
      await frame.locator('.error').waitFor();
      assert.equal(await editorText(), broken);
      await clickSheet('Raw_Data');
      await waitPainted('Raw_Data');
      assert.equal(await editorText(), broken);
      await typeSql(DRAFT);
    });
    await check('a delayed reply for an older selection is not painted', async () => {
      // Record the host's replies inside the packaged webview, then replay
      // the older choice's preview after a newer choice has been painted.
      await frame.evaluate(() => {
        window.__ex02Replies = [];
        window.addEventListener('message', e => { if (e.data?.command === 'queryResult' && e.data.sheetPreview) window.__ex02Replies.push(e.data); }, true);
      });
      await clickSheet('ZOther');
      await waitPainted('ZOther');
      await clickSheet('Raw_Data');
      await waitPainted('Raw_Data');
      const replayed = await frame.evaluate(() => {
        const stale = window.__ex02Replies.filter(m => m.sheetPreview === 'ZOther').at(-1);
        if (stale) window.postMessage(stale, '*');
        return !!stale;
      });
      assert.ok(replayed, 'captured the older preview reply');
      await page.waitForTimeout(500);
      await waitPainted('Raw_Data');
      assert.equal(await editorText(), DRAFT);
    });
    await check('closing and reopening the editor restores the exact draft', async () => {
      await page.waitForTimeout(500);
      await closeEditor();
      await page.waitForFunction(() => !document.querySelector('iframe.webview'), undefined, { timeout: 10000 }).catch(() => undefined);
      execFileSync(executable, [cli, ...cliArgs, '--reuse-window', source],
        { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 30000 });
      await findFrame();
      await frame.locator('.table-item').first().waitFor();
      await frame.waitForFunction(() => !document.querySelector('.run-btn-cancel') && document.querySelector('#results td'));
      report.draftAfterReopen = await editorText();
      assert.equal(report.draftAfterReopen, DRAFT);
    });
    const closeAndReopen = async () => {
      await closeEditor();
      await page.waitForFunction(() => !document.querySelector('iframe.webview'), undefined, { timeout: 10000 }).catch(() => undefined);
      execFileSync(executable, [cli, ...cliArgs, '--reuse-window', source],
        { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 30000 });
      await findFrame();
      await frame.locator('.table-item').first().waitFor();
      await frame.waitForFunction(() => !document.querySelector('.run-btn-cancel') && document.querySelector('#results td'));
    };
    await check('closing immediately after typing restores the exact draft', async () => {
      const quick = 'SELECT 7 AS typed_just_before_close;';
      // Select-all through CodeMirror's own keymap, then insert: Playwright's
      // fill() on a contenteditable can insert before CodeMirror has read the
      // DOM selection, prepending to the old draft (seen: quick + DRAFT).
      await typeSql(quick);
      await closeAndReopen(); // no pause: nothing may depend on a save timer
      report.draftAfterQuickClose = await editorText();
      assert.equal(report.draftAfterQuickClose, quick);
    });
    report.sourceUnchanged = Buffer.compare(await fs.readFile(source), original) === 0;
    assert.ok(report.sourceUnchanged);
    report.passed = true;
    console.log(`EX-02 ${developmentPath ? 'unpacked development' : 'installed'}-host regression passed: ${report.checks.length} checks.`);
  } catch (error) {
    report.passed = false;
    report.failedAt = report.checks.at(-1);
    report.error = String(error?.stack ?? error);
    if (page && process.env.EX02_REPORT) await page.screenshot({ path: process.env.EX02_REPORT.replace(/\.json$/, '.png') }).catch(() => undefined);
    throw error;
  } finally {
    if (process.env.EX02_REPORT) await fs.writeFile(process.env.EX02_REPORT, JSON.stringify(report, null, 2));
    stop();
    await browser?.close().catch(() => undefined);
    // A retained run directory keeps the fixture but drops the bulky profile.
    if (keepRoot) await Promise.all(['user', 'extensions'].map(dir => fs.rm(path.join(root, dir), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
    if (alias) await fs.rm(alias, { force: true });
    else await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
