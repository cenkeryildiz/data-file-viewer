// MAT editor qualification in actual VS Code, disposable profiles only; DFV_VSIX selects an installed package.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const { vscodeExecutable, descendants, vsixManifest } = await import('../vsix_smoke/helpers.mjs');
  const executable = vscodeExecutable();
  const cli = process.platform === 'darwin' ? path.resolve(executable, '../../Resources/app/out/cli.js') : path.join(path.dirname(executable), 'resources/app/out/cli.js');
  const vsix = process.env.DFV_VSIX;
  assert.ok(vsix || process.env.DFV_EXTENSION_DEVELOPMENT_PATH, 'name a VSIX or an unpacked extension checkout');
  assert.ok((vsix || process.env.DFV_MAT_WORKER) && process.env.DFV_MAT_FIXTURE, 'name a native MAT worker/package and genuine fixture');
  const development = vsix ? undefined : path.resolve(process.env.DFV_EXTENSION_DEVELOPMENT_PATH);
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'dfvh-mat-')));
  const user = path.join(root, 'user'), extensions = path.join(root, 'extensions');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (vsix) {
    for (const key of Object.keys(env)) if (key.startsWith('DFV_')) delete env[key];
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) env[key] = 'http://127.0.0.1:9';
    env.NO_PROXY = '127.0.0.1,localhost';
  }
  let browser, child;
  const stop = () => { if (!child?.pid) return; if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {} } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  const deadline = setTimeout(() => { stop(); console.error('MAT development-host gate exceeded 120 seconds.'); process.exit(1); }, 120000);
  try {
    await fs.mkdir(path.join(user, 'User'), { recursive: true });
    await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
      'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'workbench.editorAssociations': { '*.mat': 'dataFileViewer.mat', '*.csv': 'dataFileViewer.editor' } }));
    let installed;
    if (vsix) {
      execFileSync(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', path.resolve(vsix), '--force'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 60000 });
      const manifest = vsixManifest(vsix), matches = [];
      for (const entry of await fs.readdir(extensions, { withFileTypes: true })) if (entry.isDirectory()) {
        const folder = path.join(extensions, entry.name);
        const pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
        if (pkg.name === manifest.name && pkg.publisher === manifest.publisher && pkg.version === manifest.version) matches.push(folder);
      }
      assert.equal(matches.length, 1, 'exactly the requested installed extension/version');
      installed = matches[0];
    }
    const source = path.join(root, 'native.mat'), many = path.join(root, 'many.mat');
    await fs.copyFile(process.env.DFV_MAT_FIXTURE, source);
    await fs.copyFile(path.join(path.dirname(process.env.DFV_MAT_FIXTURE), 'many_v7.mat'), many);
    const before = await fs.readFile(source), beforeMany = await fs.readFile(many);
    const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
    child = spawn(executable, ['--user-data-dir', user, '--extensions-dir', extensions, ...(development ? [`--extensionDevelopmentPath=${development}`] : []), `--remote-debugging-port=${port}`,
      '--disable-gpu', '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', source],
      { env, detached: process.platform !== 'win32', stdio: 'ignore' });
    child.on('error', e => console.error(e.message));
    for (let i = 0; i < 80 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); } catch { await new Promise(r => setTimeout(r, 250)); } }
    assert.ok(browser, 'VS Code CDP endpoint');
    let page, frame;
    for (let i = 0; i < 160 && !frame; i++) {
      page = browser.contexts()[0]?.pages().at(-1);
      if (page) for (const candidate of page.frames()) if (await candidate.locator('#catalog').count() && await candidate.locator('#catalog button').count() > 2) frame = candidate;
      if (!frame) await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(frame, 'actual MAT custom editor rendered with packaged development JS and CSP');
    const worker = await fs.realpath(installed ? path.join(installed, 'bin', 'dfv-mat') : process.env.DFV_MAT_WORKER);
    assert.ok(descendants(child.pid).some(p => p.command.includes(worker)), 'actual Rust MAT child belongs to this VS Code');
    page.setDefaultTimeout(10000);
    const idle = () => frame.waitForFunction(() => document.querySelector('#status')?.textContent === 'Read-only. No source changes.');
    const choose = async name => { await frame.locator('#catalog button').filter({ hasText: new RegExp('^' + name + ' —') }).click(); await idle(); };
    await idle(); await choose('unsigned'); assert.match(await frame.locator('#data').textContent(), /18446744073709551615/);
    await choose('sparse_values'); assert.equal(await frame.locator('#data tbody tr').count(), 2); assert.match(await frame.locator('#data').textContent(), /implicit zero/);
    await choose('cells'); await frame.locator('#children button').first().click(); await idle();
    assert.equal(await frame.getByRole('button', { name: /save|edit/i }).count(), 0);
    const oldMat = descendants(child.pid).filter(p => p.command.includes(worker)).map(p => p.pid);
    await frame.getByRole('button', { name: 'Refresh source', exact: true }).click(); await idle();
    assert.ok(descendants(child.pid).some(p => p.command.includes(worker) && !oldMat.includes(p.pid)), 'explicit refresh replaces old MAT worker');
    execFileSync(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--reuse-window', many], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 15000 });
    frame = undefined;
    for (let i = 0; i < 120 && !frame; i++) {
      for (const candidate of page.frames()) if (await candidate.locator('#catalog').count() && (await candidate.locator('#catalog').textContent()).includes('v0001')) frame = candidate;
      if (!frame) await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(frame, '1000-variable MAT editor rendered'); await idle();
    for (let i = 0; i < 9; i++) { await frame.locator('#catalog').getByRole('button', { name: 'Next page', exact: true }).click(); await idle(); }
    await choose('v1000'); assert.match(await frame.locator('#data').textContent(), /1000000007000/);
    assert.deepEqual(await fs.readFile(source), before); assert.deepEqual(await fs.readFile(many), beforeMany);
    assert.equal(await frame.locator('#error').textContent(), '');
    if (process.env.DFV_MAT_ISOLATION === '1') {
      if (!vsix) { assert.equal(process.env.DFV_BACKEND, 'native'); assert.ok(process.env.DFV_TABLE_WORKER); }
      const tableWorker = await fs.realpath(installed ? path.join(installed, 'bin', 'dfv-table') : process.env.DFV_TABLE_WORKER), csv = path.join(root, 'rows.csv');
      await fs.writeFile(csv, 'id,name\n1,alpha\n2,beta\n'); const csvBefore = await fs.readFile(csv);
      const openFile = file => execFileSync(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--reuse-window', file], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 15000 });
      const findFrame = async (selector, contains) => {
        let found;
        for (let i = 0; i < 120 && !found; i++) { for (const candidate of page.frames()) if (await candidate.locator(selector).count() && (!contains || (await candidate.locator(selector).textContent()).includes(contains))) found = candidate; if (!found) await new Promise(r => setTimeout(r, 250)); }
        assert.ok(found, selector); return found;
      };
      // Open as a custom editor within this exact disposable Code instance.
      openFile(csv);
      const tableFrame = await findFrame('#run-btn');
      await tableFrame.waitForFunction(() => document.querySelector('#run-btn')?.textContent.includes('Run') && document.querySelector('td[data-r]'));
      assert.ok(descendants(child.pid).some(p => p.command.includes(tableWorker)), 'actual native table worker is separate');
      const matChildren = descendants(child.pid).filter(p => p.command.includes(worker)); assert.ok(matChildren.length >= 1);
      for (const p of matChildren) process.kill(p.pid, 'SIGKILL');
      const editor = tableFrame.locator('.cm-content'); await editor.click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText('SELECT 42 AS isolated_table;');
      await tableFrame.locator('#run-btn').click();
      await tableFrame.waitForFunction(() => document.body.textContent.includes('isolated_table') && document.querySelector('td[data-r="0"][data-c="0"]')?.textContent === '42');
      assert.equal(descendants(child.pid).filter(p => p.command.includes(worker)).length, 0, 'MAT workers do not restart automatically after death');
      await page.locator('.tab').filter({ hasText: 'many.mat' }).first().click();
      frame = await findFrame('#catalog', 'v0901');
      await frame.getByRole('button', { name: 'Refresh source', exact: true }).click(); await idle();
      const restarted = descendants(child.pid).filter(p => p.command.includes(worker)); assert.equal(restarted.length, 1, 'only explicit refresh restarts one MAT worker');
      for (const p of descendants(child.pid).filter(p => p.command.includes(tableWorker))) process.kill(p.pid, 'SIGKILL');
      await choose('v0001'); assert.match(await frame.locator('#data').textContent(), /1000000007/);
      assert.equal(descendants(child.pid).filter(p => p.command.includes(tableWorker)).length, 0, 'table worker is not restarted by MAT reads');
      assert.deepEqual(await fs.readFile(csv), csvBefore);
      console.log('Actual host isolation passed: killing MAT keeps table query usable; explicit MAT refresh creates one worker; killing table keeps MAT reads usable, no restart storm/source changes.');
    }
    console.log(`Actual ${vsix ? 'installed' : 'unpacked'} VS Code MAT gate passed: native child/CSP, exact values, sparse/cell navigation, explicit refresh, selection among1000variables and unchanged sources.`);
  } finally { stop(); await browser?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); clearTimeout(deadline); }
})().catch(e => { console.error(e); process.exitCode = 1; });
