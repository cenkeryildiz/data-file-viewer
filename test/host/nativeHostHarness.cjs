// Shared launcher: one unpacked extension or DFV_VSIX in a disposable profile, never the real profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** name/size/mtime fingerprint of a directory tree (or 'absent'); stat-only, never writes. */
function fingerprint(dir) {
  if (!fss.existsSync(dir)) return 'absent';
  const out = [];
  (function walk(d) {
    for (const e of fss.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), s = fss.lstatSync(p);
      out.push(`${path.relative(dir, p)}|${s.size}|${s.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  })(dir);
  return out.sort().join('\n');
}

/** Every file below dir as {relative path: sha256}. */
async function tree(dir) {
  const out = {};
  const walk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out[path.relative(dir, p)] = sha(await fs.readFile(p)); } };
  await walk(dir);
  return out;
}

async function launch({ name, settings = {}, deadlineMs = 240000, first }) {
  const { vscodeExecutable, descendants, vsixManifest } = await import('../vsix_smoke/helpers.mjs');
  const vsix = process.env.DFV_VSIX;
  assert.ok(!process.env.DFV_HOST_ROOT, 'no shared host-root mode');
  if (!vsix) {
    assert.equal(process.env.DFV_BACKEND, 'native', 'native backend only');
    assert.ok(process.env.DFV_EXTENSION_DEVELOPMENT_PATH, 'name the unpacked extension under test');
    assert.ok(process.env.DFV_TABLE_WORKER, 'name the exact worker under test');
  }
  const development = vsix ? undefined : path.resolve(process.env.DFV_EXTENSION_DEVELOPMENT_PATH);
  const manifest = vsix ? vsixManifest(vsix) : JSON.parse(await fs.readFile(path.join(development, 'package.json'), 'utf8'));
  let worker = vsix ? undefined : await fs.realpath(process.env.DFV_TABLE_WORKER);
  const executable = vscodeExecutable();
  const cli = process.platform === 'darwin' ? path.resolve(executable, '../../Resources/app/out/cli.js') : path.join(path.dirname(executable), 'resources/app/out/cli.js');
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `dfvh-${name}-`)));
  assert.ok(root.length < 40, 'profile path stays short for unix sockets');
  const user = path.join(root, 'user'), extensions = path.join(root, 'extensions'), sources = path.join(root, 'sources');
  const realStorage = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage', `${manifest.publisher}.${manifest.name}`.toLowerCase());
  const realBefore = fingerprint(realStorage);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (vsix) {
    for (const key of Object.keys(env)) if (key.startsWith('DFV_')) delete env[key];
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) env[key] = 'http://127.0.0.1:9';
    env.NO_PROXY = '127.0.0.1,localhost';
  }
  const owned = new Set();
  const host = { root, user, extensions, sources, worker, realStorage, realBefore, development, manifest, page: undefined, browser: undefined, child: undefined, sha, tree, sleep, alive, MOD };
  const stop = () => { if (host.child?.pid) { try { process.kill(-host.child.pid, 'SIGKILL'); } catch {} } };
  const deadline = setTimeout(() => { stop(); console.error(`${name} exceeded ${deadlineMs / 1000} seconds.`); process.exit(1); }, deadlineMs);
  host.workers = () => { const r = descendants(host.child.pid).filter(p => p.command.includes(worker)); for (const p of r) owned.add(p.pid); return r; };
  host.wait = async (label, fn, timeout = 20000) => {
    for (const end = Date.now() + timeout; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(50); }
    throw new Error(`Timed out: ${label}`);
  };
  host.stop = stop;
  host.cleanup = async () => {
    stop();
    for (const pid of owned) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await host.browser?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  };
  host.allExited = () => host.wait('all owned table workers exited', () => [...owned].every(pid => !alive(pid)), 15000);
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(sources);
  if (vsix) {
    try {
      execFileSync(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', path.resolve(vsix), '--force'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 60000 });
      const matches = [];
      for (const entry of await fs.readdir(extensions, { withFileTypes: true })) if (entry.isDirectory()) {
        const folder = path.join(extensions, entry.name);
        const pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
        if (pkg.name === manifest.name && pkg.publisher === manifest.publisher && pkg.version === manifest.version) matches.push(folder);
      }
      assert.equal(matches.length, 1, 'exactly the requested installed extension/version');
      worker = await fs.realpath(path.join(matches[0], 'bin', 'dfv-table'));
      host.worker = worker;
      assert.ok(!fss.existsSync(path.join(matches[0], 'node_modules', '@duckdb')), 'no Node reference backend in the installed package');
    } catch (error) { await host.cleanup(); throw error; }
  }
  await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true,
    'update.mode': 'none', 'window.restoreWindows': 'none', 'files.hotExit': 'off',
    'workbench.editorAssociations': { '*.xlsx': 'dataFileViewer.editor', '*.csv': 'dataFileViewer.editor', '*.dta': 'dataFileViewer.editor' }, ...settings }));
  host.prepare = first; // callers create their sources, then call start(file)
  host.start = async file => {
    const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
    host.child = spawn(executable, ['--user-data-dir', user, '--extensions-dir', extensions, ...(development ? [`--extensionDevelopmentPath=${development}`] : []), `--remote-debugging-port=${port}`,
      '--disable-gpu', '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', file], { env, detached: true, stdio: 'ignore' });
    host.child.on('error', e => console.error(e.message));
    await host.wait('Code CDP', async () => { try { host.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 750 }); return true; } catch { return false; } }, 30000);
    host.page = await host.wait('workbench page', () => host.browser.contexts()[0]?.pages().at(-1)); host.page.setDefaultTimeout(12000);
    await host.page.bringToFront();
    host.open = file => execFileSync(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--reuse-window', file], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, stdio: 'pipe' });
  };
  host.tab = name => host.page.locator('.tab').filter({ hasText: name }).first().click();
  host.closeActiveTab = () => host.page.keyboard.press(`${MOD}+W`);
  /** The webview frame that contains `selector` (optionally also `text`), waiting for it. */
  host.frame = (selector, label, text) => host.wait(`frame ${label ?? selector}`, async () => {
    for (const f of host.page.frames()) {
      if (f.isDetached() || !await f.locator(selector).count().catch(() => 0)) continue;
      if (text === undefined || (await f.locator(selector).first().textContent().catch(() => '')).includes(text)) return f;
    }
  }, 30000);
  /** Real keyboard: focus the CodeMirror editor, select all through its keymap, insert the text, assert it landed exactly. */
  host.typeSql = async (frame, text) => {
    const editor = frame.locator('.cm-content').first();
    await editor.click({ position: { x: 4, y: 4 } }); await host.page.keyboard.press(`${MOD}+A`); await host.page.keyboard.insertText(text); // corner click: beside an open chart the centre can be covered by the scroller
    assert.equal(await editor.innerText(), text, 'exact SQL before the next action');
  };
  host.run = async (frame, sql) => {
    await host.typeSql(frame, sql);
    await frame.locator('#run-btn').click();
  };
  /** Network proof for the worker: no internet socket is open in this process. */
  host.sockets = pid => { try { return execFileSync('lsof', ['-a', '-p', String(pid), '-i'], { encoding: 'utf8' }); } catch { return ''; } };
  host.profileIsolation = async () => {
    assert.equal(fingerprint(realStorage), realBefore, 'the real VS Code profile storage for this extension is unchanged');
  };
  return host;
}

module.exports = { launch, fingerprint, tree, sha, sleep, alive, MOD };
