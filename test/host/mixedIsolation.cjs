// Three real native features in one unpacked VS Code, disposable profile, no VSIX.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const { vscodeExecutable, descendants, samplePdf } = await import('../vsix_smoke/helpers.mjs');
  assert.equal(process.env.DFV_BACKEND, 'native');
  for (const key of ['DFV_EXTENSION_DEVELOPMENT_PATH', 'DFV_TABLE_WORKER', 'DFV_MAT_WORKER', 'DFV_MAT_FIXTURE']) assert.ok(process.env[key], key);
  const development = path.resolve(process.env.DFV_EXTENSION_DEVELOPMENT_PATH);
  const workers = { pdf: await fs.realpath(path.join(development, 'media/pdf/bin/dfv-pdf')), table: await fs.realpath(process.env.DFV_TABLE_WORKER), mat: await fs.realpath(process.env.DFV_MAT_WORKER) };
  const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'dfvh-mixed-'));
  const user = path.join(root, 'user'), extensions = path.join(root, 'extensions'), sources = path.join(root, 'sources');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executable = vscodeExecutable(), owned = new Set();
  let child, browser;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const stop = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  const deadline = setTimeout(() => { stop(); console.error('Three-feature host isolation exceeded 180seconds.'); process.exit(1); }, 180000);
  const wait = async (label, fn, timeout = 15000) => {
    for (const end = Date.now() + timeout; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`Timed out: ${label}`);
  };
  const children = feature => {
    const result = descendants(child.pid).filter(p => p.command.includes(workers[feature]));
    for (const p of result) owned.add(p.pid);
    return result;
  };
  try {
    await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(sources);
    await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false,
      'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'workbench.editorAssociations': { '*.pdf': 'dataFileViewer.pdf', '*.mat': 'dataFileViewer.mat', '*.csv': 'dataFileViewer.editor' } }));
    const pdf = path.join(sources, 'isolation.pdf'), csv = path.join(sources, 'data.csv'), mat = path.join(sources, 'native.mat');
    samplePdf(pdf); await fs.writeFile(csv, 'id,name\n1,alpha\n2,beta\n'); await fs.copyFile(process.env.DFV_MAT_FIXTURE, mat);
    const before = new Map(await Promise.all([pdf, csv, mat].map(async p => [p, await fs.readFile(p)])));
    const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
    child = spawn(executable, ['--user-data-dir', user, '--extensions-dir', extensions, `--extensionDevelopmentPath=${development}`, `--remote-debugging-port=${port}`,
      '--disable-gpu', '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', pdf], { env, detached: true, stdio: 'ignore' });
    child.on('error', e => console.error(e.message));
    await wait('Code CDP', async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 750 }); return true; } catch { return false; } }, 30000);
    const page = await wait('workbench page', () => browser.contexts()[0]?.pages().at(-1)); page.setDefaultTimeout(12000);
    const cli = process.platform === 'darwin' ? path.resolve(executable, '../../Resources/app/out/cli.js') : path.join(path.dirname(executable), 'resources/app/out/cli.js');
    const open = file => execFileSync(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--reuse-window', file], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, stdio: 'pipe' });
    const tab = async name => { await page.locator('.tab').filter({ hasText: name }).first().click(); };
    const frame = selector => wait(`frame ${selector}`, async () => { for (const f of page.frames()) if (await f.locator(selector).count().catch(() => 0)) return f; });
    const ink = f => f.evaluate(() => {
      const img = document.querySelector('#pages .page img'); if (!img?.complete || !img.naturalWidth) return null;
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const g = canvas.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) count++;
      return { width: img.naturalWidth, height: img.naturalHeight, ink: count };
    });
    const render = f => wait('PDF ink', async () => { const p = await ink(f); return p?.ink > 50 ? p : false; });
    let pdfFrame = await frame('#export'); await render(pdfFrame); assert.equal(children('pdf').length, 1);
    open(csv); let tableFrame = await frame('#run-btn'); await tableFrame.waitForFunction(() => !!document.querySelector('td[data-r]'));
    open(mat); let matFrame = await frame('#catalog');
    const matIdle = () => matFrame.waitForFunction(() => document.querySelector('#status')?.textContent === 'Read-only. No source changes.');
    const choose = async name => { await matFrame.locator('#catalog button').filter({ hasText: new RegExp('^' + name + ' —') }).click(); await matIdle(); };
    await matIdle(); await choose('unsigned'); assert.match(await matFrame.locator('#data').textContent(), /18446744073709551615/);
    assert.equal(children('mat').length, 1); assert.equal(children('table').length, 1);
    assert.equal(new Set(Object.keys(workers).flatMap(f => children(f).map(p => p.pid))).size, 3, 'three distinct owned feature workers');
    const query = async n => {
      await tab('data.csv'); tableFrame = await frame('#run-btn');
      const editor = tableFrame.locator('.cm-content'); await editor.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(`SELECT ${n} AS mixed_alive;`); await tableFrame.locator('#run-btn').click();
      await tableFrame.waitForFunction(expected => document.querySelector('td[data-r="0"][data-c="0"]')?.textContent === String(expected) && document.body.textContent.includes('mixed_alive'), n);
    };
    await query(41);
    await tab('isolation.pdf'); pdfFrame = await frame('#export');
    const pdfPid = children('pdf')[0].pid; process.kill(pdfPid, 'SIGSTOP');
    await pdfFrame.evaluate(() => {
      window.__mixedPdf = { settled: false };
      PDFStudioHost.createTransport(EditorTransport).request('get_document_info', {}).then(() => { window.__mixedPdf = { settled: true, unexpectedSuccess: true }; }, e => { window.__mixedPdf = { settled: true, code: e.code }; });
    });
    await sleep(200); assert.equal(await pdfFrame.evaluate(() => window.__mixedPdf.settled), false, 'actual PDF request waits while native worker is stopped');
    process.kill(pdfPid, 'SIGKILL');
    await pdfFrame.waitForFunction(() => window.__mixedPdf.settled); assert.equal(await pdfFrame.evaluate(() => window.__mixedPdf.code), 'WORKER_EXITED');
    await query(42);
    await tab('native.mat'); matFrame = await frame('#catalog'); await choose('signed'); assert.match(await matFrame.locator('#data').textContent(), /-9223372036854775808/);
    assert.ok(children('pdf').length <= 1, 'PDF failure can create at most one replacement');
    await tab('isolation.pdf'); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W');
    await wait('closed PDF worker', () => children('pdf').length === 0);
    open(pdf); pdfFrame = await frame('#export'); await render(pdfFrame); const replacement = children('pdf'); assert.equal(replacement.length, 1); assert.notEqual(replacement[0].pid, pdfPid);
    console.log('PASS PDF pending call settled on SIGKILL; table/MAT survived; explicit original reopen rendered.');

    await tab('data.csv'); tableFrame = await frame('#run-btn'); const tablePid = children('table')[0].pid; process.kill(tablePid, 'SIGSTOP');
    const editor = tableFrame.locator('.cm-content'); await editor.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText('SELECT 43 AS pending_table;'); await tableFrame.locator('#run-btn').click();
    await sleep(200); process.kill(tablePid, 'SIGKILL');
    await tableFrame.waitForFunction(() => document.querySelector('#run-btn')?.textContent.includes('Run'));
    await tab('isolation.pdf'); pdfFrame = await frame('#export'); const first = await render(pdfFrame); await pdfFrame.locator('#zoom-in').click();
    await wait('PDF zoom after table death', async () => { const p = await render(pdfFrame); return p.width !== first.width; });
    await tab('native.mat'); matFrame = await frame('#catalog'); await choose('unsigned');
    assert.match(await matFrame.locator('#data').textContent(), /18446744073709551615/); assert.equal(children('table').length, 0);
    await tab('data.csv'); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W'); open(csv); tableFrame = await frame('#run-btn'); await tableFrame.waitForFunction(() => !!document.querySelector('td[data-r]')); await query(44);
    console.log('PASS table pending query settled on SIGKILL; PDF rendered/zoomed and MAT exact reads survived.');

    await tab('native.mat'); matFrame = await frame('#catalog'); const matPid = children('mat')[0].pid; process.kill(matPid, 'SIGSTOP');
    await matFrame.locator('#catalog button').filter({ hasText: /^signed —/ }).click(); await sleep(200); process.kill(matPid, 'SIGKILL');
    await matFrame.waitForFunction(() => document.querySelector('#error')?.textContent.length > 0);
    await tab('isolation.pdf'); pdfFrame = await frame('#export'); const second = await render(pdfFrame); await pdfFrame.locator('#zoom-in').click();
    await wait('PDF zoom after MAT death', async () => { const p = await render(pdfFrame); return p.width !== second.width; }); await query(45);
    await tab('native.mat'); matFrame = await frame('#catalog'); await matFrame.getByRole('button', { name: 'Refresh source', exact: true }).click(); await matIdle(); await choose('unsigned');
    assert.match(await matFrame.locator('#data').textContent(), /18446744073709551615/); assert.equal(children('mat').length, 1); assert.notEqual(children('mat')[0].pid, matPid);
    console.log('PASS MAT pending request settled on SIGKILL; PDF/table survived; explicit MAT refresh recovered one worker.');
    for (const [file, bytes] of before) assert.deepEqual(await fs.readFile(file), bytes, path.basename(file));
    const lockPath = `${csv}.dfv.lock`;
    assert.deepEqual((await fs.readdir(sources)).sort(), ['data.csv', 'data.csv.dfv.lock', 'isolation.pdf', 'native.mat']);
    const lockOwner = Number((await fs.readFile(lockPath, 'utf8')).trim());
    assert.ok(descendants(child.pid).some(p => p.pid === lockOwner), 'existing flat-file advisory lock belongs to this profile');
    for (const feature of Object.keys(workers)) assert.equal(children(feature).length, 1, `${feature}: bounded one live child`);
    await tab('data.csv'); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W');
    await wait('flat-file lock released on normal close', async () => { try { await fs.access(lockPath); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } });
    assert.deepEqual((await fs.readdir(sources)).sort(), ['data.csv', 'isolation.pdf', 'native.mat']);
    stop(); await wait('all owned native workers exited', () => [...owned].every(pid => !alive(pid)));
    console.log('PASS three-feature source bytes unchanged, advisory lock released on close, no residual adjacent files or owned native workers after profile termination.');
  } finally {
    stop(); for (const pid of owned) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await browser?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); clearTimeout(deadline);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
