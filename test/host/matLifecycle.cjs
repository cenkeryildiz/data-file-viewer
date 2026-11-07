// Unpacked MAT editor lifecycle in actual VS Code (disposable profile, DFV_EXTENSION_DEVELOPMENT_PATH, never a VSIX or the real profile):
// mid-flight cancel, child paging past 100, replaced source (stale) then explicit refresh, tab close reclaiming workers, hung-worker close.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const { vscodeExecutable, descendants } = await import('../vsix_smoke/helpers.mjs');
  const executable = vscodeExecutable();
  // An unset input resolves to its documented default; a missing default fails loudly.
  const defaults = { DFV_PYTHON: '/Users/macc/miniforge3/envs/myproject/bin/python', DFV_MAT_WORKER: '/Users/macc/dfv-resume-20261103-target/debug/dfv-mat',
    DFV_MAT_FIXTURE: '/Users/macc/dfv-xlsx-resume-20261103/native/crates/mat/tests/fixtures/native_v7.mat' };
  for (const [key, value] of Object.entries(defaults)) { process.env[key] ||= value; await fs.access(process.env[key]).catch(() => assert.fail(`${key} does not name an existing input: ${process.env[key]}`)); }
  assert.ok(process.env.DFV_EXTENSION_DEVELOPMENT_PATH, 'DFV_EXTENSION_DEVELOPMENT_PATH is required (the unpacked extension under test)');
  assert.ok(!process.env.DFV_VSIX, 'no VSIX mode');
  const development = path.resolve(process.env.DFV_EXTENSION_DEVELOPMENT_PATH);
  const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'dfvh-matlife-'));
  const user = path.join(root, 'user'), extensions = path.join(root, 'extensions'), sources = path.join(root, 'sources');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const worker = await fs.realpath(process.env.DFV_MAT_WORKER), owned = new Set();
  let browser, child;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const stop = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  const deadline = setTimeout(() => { stop(); console.error('MAT lifecycle host gate exceeded 240 seconds.'); process.exit(1); }, 240000);
  const wait = async (label, fn, timeout = 20000) => {
    for (const end = Date.now() + timeout; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(50); }
    throw new Error(`Timed out: ${label}`);
  };
  const matPids = () => { const pids = descendants(child.pid).filter(p => p.command.includes(worker)).map(p => p.pid); for (const p of pids) owned.add(p); return pids; };
  try {
    await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(sources);
    await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
      'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'workbench.editorAssociations': { '*.mat': 'dataFileViewer.mat' } }));
    const native = path.join(sources, 'native.mat'), children = path.join(sources, 'children.mat'), replacement = path.join(root, 'replacement.mat');
    await fs.copyFile(process.env.DFV_MAT_FIXTURE, native);
    execFileSync(process.env.DFV_PYTHON, ['-I', path.resolve(__dirname, '../resources/createMatChildren.py'), children], { timeout: 60000 });
    await fs.copyFile(children, replacement);
    const nativeBefore = await fs.readFile(native), childrenBefore = await fs.readFile(children), replacementBytes = await fs.readFile(replacement);
    const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
    child = spawn(executable, ['--user-data-dir', user, '--extensions-dir', extensions, `--extensionDevelopmentPath=${development}`, `--remote-debugging-port=${port}`,
      '--disable-gpu', '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', native], { env, detached: true, stdio: 'ignore' });
    child.on('error', e => console.error(e.message));
    await wait('Code CDP', async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 750 }); return true; } catch { return false; } }, 30000);
    const page = await wait('workbench page', () => browser.contexts()[0]?.pages().at(-1)); page.setDefaultTimeout(12000);
    const cli = process.platform === 'darwin' ? path.resolve(executable, '../../Resources/app/out/cli.js') : path.join(path.dirname(executable), 'resources/app/out/cli.js');
    const open = file => execFileSync(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--reuse-window', file], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, stdio: 'pipe' });
    const tab = name => page.locator('.tab').filter({ hasText: name }).first().click();
    const closeTab = async name => { await tab(name); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W'); };
    const frame = (contains, label) => wait(`MAT frame ${label}`, async () => {
      for (const f of page.frames()) if (await f.locator('#catalog').count().catch(() => 0) && (await f.locator('#catalog').textContent().catch(() => '')).includes(contains)) return f;
    });
    const idle = f => f.waitForFunction(() => document.querySelector('#status')?.textContent === 'Read-only. No source changes.');
    const choose = async (f, name) => { await f.locator('#catalog button').filter({ hasText: new RegExp('^' + name + ' —') }).click(); await idle(f); };

    // 1. startup: exactly one actual Rust child owned by this Code instance.
    let nativeFrame = await frame('unsigned', 'native'); await idle(nativeFrame);
    const [nativePid] = await wait('one MAT worker', () => { const p = matPids(); return p.length === 1 && p; });

    // 2. mid-flight Cancel: request frame then cancel frame reach the worker together; the read settles, the same worker serves the next read.
    for (let round = 0; round < 3; round++) {
      process.kill(nativePid, 'SIGSTOP');
      await nativeFrame.locator('#catalog button').filter({ hasText: /^unsigned —/ }).click();
      await nativeFrame.waitForFunction(() => document.querySelector('#status')?.textContent === 'Reading…' && !document.querySelector('#cancel').disabled);
      await nativeFrame.locator('#cancel').click();
      await sleep(150); // let the cancel frame reach the pipe behind the request before the worker resumes
      process.kill(nativePid, 'SIGCONT');
      await nativeFrame.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Reading…');
      const error = await nativeFrame.locator('#error').textContent();
      assert.ok(error === '' || /cancel/i.test(error), `settled by value or cancel, got: ${error}`);
    }
    await choose(nativeFrame, 'signed'); assert.match(await nativeFrame.locator('#data').textContent(), /-9223372036854775808/);
    assert.deepEqual(matPids(), [nativePid], 'cancel keeps the same single worker');
    console.log('PASS actual mid-flight Cancel x3 settled the pending read; same worker served the next exact read.');

    // 3. child paging beyond the 100-entry page for a cell and a struct.
    open(children); let childFrame = await frame('big_cell', 'children'); await idle(childFrame);
    await wait('two MAT workers', () => matPids().length === 2);
    const childButtons = () => childFrame.locator('#children button').filter({ hasText: / — / });
    for (const [name, label] of [['big_cell', /250/], ['big_struct', /f250/]]) {
      await choose(childFrame, name);
      assert.equal(await childButtons().count(), 100); assert.match(await childFrame.locator('#children').textContent(), /Entries 1–100 of 250/);
      await childFrame.locator('#children').getByRole('button', { name: 'Next page', exact: true }).click(); await idle(childFrame);
      assert.match(await childFrame.locator('#children').textContent(), /Entries 101–200 of 250/);
      await childFrame.locator('#children').getByRole('button', { name: 'Next page', exact: true }).click(); await idle(childFrame);
      assert.equal(await childButtons().count(), 50); assert.match(await childFrame.locator('#children').textContent(), /Entries 201–250 of 250/);
      assert.equal(await childFrame.locator('#children').getByRole('button', { name: 'Next page', exact: true }).isDisabled(), true);
      await childButtons().last().click(); await idle(childFrame);
      assert.match(await childFrame.locator('#value').textContent(), label); assert.equal((await childFrame.locator('#data tbody td').allTextContents()).at(-1), '250', 'last child value is exact');
      await childFrame.locator('#breadcrumb').getByRole('button', { name: 'Variables', exact: true }).click(); await idle(childFrame);
    }
    console.log('PASS actual host paged 250 cell children and 250 struct fields 100/100/50 and read the last child exactly.');

    // 4. replaced source: reads refuse as stale, explicit refresh replaces exactly that worker and reclaims the old one.
    const staleBefore = matPids(); await fs.rename(replacement, children);
    await childFrame.locator('#catalog button').filter({ hasText: /^big_cell —/ }).click();
    await childFrame.waitForFunction(() => /stale_source/.test(document.querySelector('#error')?.textContent ?? ''));
    await childFrame.getByRole('button', { name: 'Refresh source', exact: true }).click(); await idle(childFrame);
    const afterRefresh = matPids(); assert.equal(afterRefresh.length, 2, 'refresh neither leaks nor drops a worker');
    const gone = staleBefore.filter(p => !afterRefresh.includes(p)); assert.equal(gone.length, 1, 'exactly one old worker replaced');
    await wait('old worker reaped', () => !alive(gone[0]));
    assert.ok(afterRefresh.includes(nativePid), 'the other document keeps its worker');
    await choose(childFrame, 'big_cell'); assert.equal(await childButtons().count(), 100);
    assert.deepEqual(await fs.readFile(children), replacementBytes);
    console.log('PASS actual source replacement was refused as stale; explicit refresh replaced one worker, reaped the old one and recovered.');

    // 5. closing a tab reclaims that document's worker only.
    await closeTab('children.mat'); await wait('children worker reclaimed', () => { const p = matPids(); return p.length === 1 && p[0] === nativePid; });
    // 6. close with a read pending on a hung worker still reaps the worker.
    await tab('native.mat'); nativeFrame = await frame('unsigned', 'native again');
    process.kill(nativePid, 'SIGSTOP');
    await nativeFrame.locator('#catalog button').filter({ hasText: /^unsigned —/ }).click();
    await nativeFrame.waitForFunction(() => document.querySelector('#status')?.textContent === 'Reading…');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W');
    await wait('hung worker reaped by tab close', () => !alive(nativePid) && matPids().length === 0, 30000);
    console.log('PASS tab close reclaimed the worker (also with a read pending on a stopped worker); no MAT child remains.');

    // 7. reopening makes exactly one new worker; sources are untouched.
    open(native); nativeFrame = await frame('unsigned', 'reopen'); await idle(nativeFrame);
    const reopened = await wait('one reopened worker', () => { const p = matPids(); return p.length === 1 && p; }); assert.notEqual(reopened[0], nativePid);
    assert.deepEqual(await fs.readFile(native), nativeBefore);
    assert.equal(childrenBefore.length > 0, true);
    assert.equal(await nativeFrame.locator('#error').textContent(), '');
    stop(); await wait('all owned MAT workers exited with the profile', () => [...owned].every(pid => !alive(pid)));
    console.log('Actual unpacked VS Code MAT lifecycle gate passed: cancel, child paging, stale/refresh, close reclamation, hung close, reopen, no orphans, sources intact.');
  } finally {
    stop(); for (const pid of owned) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await browser?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); clearTimeout(deadline);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
