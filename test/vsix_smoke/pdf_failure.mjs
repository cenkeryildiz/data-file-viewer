#!/usr/bin/env node
// VSIX PDF failure gate: offline launch, worker SIGKILL recovery, original PDF untouched.
//
// Usage (from the repo root):   node test/vsix_smoke/pdf_failure.mjs <path-to.vsix> [--pdf file.pdf] [--keep]
// Env: DFV_VSCODE_EXECUTABLE, DFV_CODE_CLI (default `code`), DFV_SMOKE_PDF, DFV_SMOKE_TIMEOUT_MS (default 90000).
//
// Everything runs in a disposable --user-data-dir/--extensions-dir (the real VS Code profile is never touched).
// Steps:
//   a  offline launch  VS Code and its CLI run with HTTP(S)_PROXY and --proxy-server pointing at a dead port (127.0.0.1:9);
//                      an https fetch from the workbench must fail, yet the PDF editor must still render non-blank pixels.
//   b  worker kill     rotate a page, SIGKILL the dfv-pdf worker, interact again (zoom in), expect the
//                      "PDF worker problem" warning with a "Restore unsaved edits" button; clicking it brings the rotation back
//                      and a new dfv-pdf process serves the document.
//   c  original intact sha256 of the opened PDF is unchanged and nothing else was written beside it.
// Not automated: restart recovery after closing VS Code, the native macOS dialogs.
// Exit code: 0 all steps pass, 1 any failure.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { codeCli, descendants, isElectronHelper, samplePdf, vscodeExecutable, vsixManifest } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const vsix = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pdf') ?? '');
const timeout = +(process.env.DFV_SMOKE_TIMEOUT_MS || 90000);
const DEAD_PROXY = 'http://127.0.0.1:9'; // discard port: nothing listens, every proxied request fails
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = async f => createHash('sha256').update(await fs.readFile(f)).digest('hex');
const results = [];
const report = (name, status, note = '') => { results.push({ name, status }); console.log(`${status.padEnd(4)} ${name}${note ? ' - ' + note : ''}`); };
const step = async (name, fn) => { try { report(name, 'PASS', await fn() ?? ''); } catch (e) { report(name, 'FAIL', String(e?.message ?? e).split('\n').slice(0, 6).join(' | ')); throw e; } };

async function main() {
  const manifest = vsixManifest(vsix);
  assert.ok((manifest.contributes?.customEditors ?? []).some(e => e.viewType === 'dataFileViewer.pdf'), 'VSIX declares no dataFileViewer.pdf editor');
  const extId = `${manifest.publisher}.${manifest.name}`;
  const root = await fs.mkdtemp('/tmp/dfvf-'); // short path: macOS socket paths are length-limited
  const user = path.join(root, 'user'), exts = path.join(root, 'extensions'), ws = path.join(root, 'ws');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(ws);
  const pdf = path.join(ws, 'sample.pdf');
  samplePdf(pdf, opt('--pdf'));
  const shaBefore = await sha(pdf);
  const filesBefore = (await fs.readdir(ws)).sort();
  await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false,
    'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'workbench.editorAssociations': { '*.pdf': 'dataFileViewer.pdf' },
  }));
  const profileArgs = ['--user-data-dir', user, '--extensions-dir', exts];
  const env = { ...process.env, HTTP_PROXY: DEAD_PROXY, HTTPS_PROXY: DEAD_PROXY, http_proxy: DEAD_PROXY, https_proxy: DEAD_PROXY, ALL_PROXY: DEAD_PROXY, NO_PROXY: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  let child, browser, shot;
  const stop = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const deadline = setTimeout(() => { stop(); console.error('PDF failure gate exceeded its deadline.'); process.exit(1); }, timeout * 4 + 60000);
  try {
    execFileSync(codeCli(), [...profileArgs, '--install-extension', vsix, '--force'], { stdio: 'pipe', timeout: 60000, env });
    const listed = execFileSync(codeCli(), [...profileArgs, '--list-extensions', '--show-versions'], { env }).toString();
    assert.ok(listed.toLowerCase().includes(`${extId}@${manifest.version}`.toLowerCase()), `installed ${extId}@${manifest.version}, got: ${listed.trim()}`);

    const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    child = spawn(vscodeExecutable(), [...profileArgs, `--remote-debugging-port=${port}`, `--proxy-server=${DEAD_PROXY}`, '--disable-gpu',
      '--disable-workspace-trust', '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry',
      '--new-window', ws], { env, detached: true, stdio: 'ignore' });
    for (let i = 0; i < 120 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); } catch { await sleep(250); }
    }
    assert.ok(browser, 'VS Code debugging endpoint');
    const page = shot = () => browser.contexts()[0]?.pages().at(-1);
    const frames = () => (page()?.frames() ?? []).filter(f => f.url().includes('vscode-webview'));
    const waitFor = async (what, fn) => { for (const end = Date.now() + timeout; Date.now() < end;) { const v = await fn().catch(() => undefined); if (v) return v; await sleep(250); } throw new Error(`timed out: ${what}`); };
    await waitFor('workbench', async () => page()?.locator('.monaco-workbench').count());
    await sleep(2000);

    const pixels = f => f.evaluate(() => {
      const img = document.querySelector('#pages .page img');
      if (!img || !img.complete || !img.naturalWidth) return null;
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) ink++;
      return { w: img.naturalWidth, h: img.naturalHeight, ink };
    });
    const nonBlank = (f, what, want) => waitFor(what, async () => { const p = await pixels(f); return p && p.ink > 50 && (!want || want(p)) ? p : undefined; });
    const pdfFrame = what => waitFor(what, async () => {
      for (const f of frames()) if (await f.locator('#export').count() && await f.locator('#pages').count()) return f;
    });
    const workers = () => descendants(child.pid).filter(r => /\/dfv-pdf(\s|$)/.test(r.command) && !isElectronHelper(r.command));

    let frame, first;
    await step('a. offline launch: network blocked, PDF editor still renders', async () => {
      const online = await page().evaluate(() => fetch('https://example.com/', { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false));
      assert.equal(online, false, 'https fetch succeeded: the network is not blocked, the offline claim would be void');
      execFileSync(codeCli(), [...profileArgs, '-r', pdf], { stdio: 'pipe', timeout: 30000, env });
      frame = await pdfFrame('PDF editor frame');
      first = await nonBlank(frame, 'non-blank page image');
      return `https fetch refused via ${DEAD_PROXY}; ${first.w}x${first.h} page image, ${first.ink} ink pixels`;
    });

    await step('b. worker SIGKILL: warning appears, Restore brings the edit back', async () => {
      await frame.locator('[data-workspace-tab="organize"]').click();
      if (!await frame.locator('#rail .thumb').first().isVisible()) await frame.locator('#rail-toggle').click(); // narrow window collapses the page rail
      await frame.locator('#rail .thumb').first().click();
      await waitFor('rotate enabled', async () => !(await frame.locator('#rot-r').isDisabled()));
      await frame.locator('#rot-r').click();
      const rotated = await nonBlank(frame, 'rotated page image', p => p.w > p.h === first.w < first.h); // orientation flips; exact size also changes with fit-page zoom
      const before = workers();
      assert.equal(before.length, 1, `expected exactly one dfv-pdf worker, found ${before.length}`);
      process.kill(before[0].pid, 'SIGKILL');
      await waitFor('worker gone', async () => !workers().some(w => w.pid === before[0].pid));
      await frame.locator('#zoom-in').click(); // any request hits the dead worker -> restart + warning
      const warning = page().locator('.notification-toast', { hasText: 'PDF worker problem' });
      await waitFor('worker warning', async () => (await warning.count()) > 0);
      const text = (await warning.first().innerText()).replace(/\s+/g, ' ').trim();
      const button = warning.first().getByRole('button', { name: 'Restore unsaved edits' });
      assert.ok(await button.count(), `warning has no "Restore unsaved edits" button: ${text}`);
      await frame.evaluate(() => { window.__dfvPreRestore = true; }); // restore replaces the webview html: the marker must vanish
      await button.click();
      // the webview html is replaced on restore, so look the frame up again on every poll
      const restored = await waitFor('restored rotated page image', async () => {
        for (const f of frames()) { if (await f.evaluate(() => window.__dfvPreRestore).catch(() => true)) continue; const p = await pixels(f).catch(() => null); if (p && p.ink > 50 && p.w > p.h === rotated.w > rotated.h) return p; }
      });
      await new Promise(r => setTimeout(r, 2500)); // the viewer checks for recoveries once the document renders
      for (const f of frames()) assert.doesNotMatch(await f.evaluate(() => document.getElementById('warnings')?.textContent ?? '').catch(() => ''), /recoverable changes/, 'the viewer shows no duplicate recovery banner');
      const after = workers();
      assert.equal(after.length, 1, `expected one replacement dfv-pdf worker, found ${after.length}`);
      assert.notEqual(after[0].pid, before[0].pid, 'worker pid unchanged: it was not restarted');
      return `killed pid ${before[0].pid}, new worker pid ${after[0].pid}; warning "${text.slice(0, 110)}"; restored ${restored.w}x${restored.h} (rotated, was ${first.w}x${first.h})`;
    });

    await step('c. original PDF sha256 unchanged, nothing written beside it', async () => {
      assert.equal(await sha(pdf), shaBefore, 'original sha256 changed');
      assert.deepEqual((await fs.readdir(ws)).sort(), filesBefore, 'files appeared beside the original');
      return `sha256 ${shaBefore.slice(0, 12)}... identical, ${filesBefore.length} file(s) in the folder`;
    });
  } catch (e) {
    if (process.env.DFV_SMOKE_SHOT) await shot?.()?.screenshot({ path: process.env.DFV_SMOKE_SHOT }).catch(() => {}); // failure evidence
    if (!results.some(r => r.status === 'FAIL')) report('gate', 'FAIL', String(e?.message ?? e).split('\n')[0]);
  } finally {
    stop(); await browser?.close().catch(() => {});
    if (args.includes('--keep')) console.log(`kept ${root}`); else await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
}
main();
