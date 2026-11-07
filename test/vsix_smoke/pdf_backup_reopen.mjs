#!/usr/bin/env node
// VSIX PDF backup-reopen gate: a DIRTY PDF tab is reopened by VS Code itself from its hot-exit backup (backupCustomDocument ->
// backupId) after the window is killed, WITHOUT the script opening the file again; the content must be the edited state.
//
// Usage (from the repo root):   node test/vsix_smoke/pdf_backup_reopen.mjs <path-to.vsix> [--pdf file.pdf] [--keep]
// Env: DFV_VSCODE_EXECUTABLE, DFV_CODE_CLI (default `code`), DFV_SMOKE_PDF, DFV_SMOKE_TIMEOUT_MS (default 90000).
//
// Everything runs in a disposable --user-data-dir/--extensions-dir (the real VS Code profile is never touched).
// Steps: a  open the PDF, rotate one page (unsaved); remember the exact page pixels
//        b  SIGTERM VS Code so it shuts down in order and writes its hot-exit backups, then kill stragglers (with --kill: SIGKILL only;
//           observed: VS Code then does NOT reopen the tab on its own, so step c fails by design - use pdf_restart.mjs for that path)
//        c  relaunch the SAME profile and do NOT open the PDF: VS Code must reopen the dirty tab on its own
//        d  the reopened tab shows the edited page (same size and pixels as before the kill) and is marked dirty, and no
//           "Restore unsaved edits" prompt is left for the user to click (no duplicate offer)
//        e  original PDF sha256 unchanged, nothing written beside it
// Exit code: 0 all steps pass, 1 any failure.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { codeCli, samplePdf, vscodeExecutable, vsixManifest } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const vsix = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pdf') ?? '');
const timeout = +(process.env.DFV_SMOKE_TIMEOUT_MS || 90000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = async f => createHash('sha256').update(await fs.readFile(f)).digest('hex');
const results = [];
const report = (name, status, note = '') => { results.push({ name, status }); console.log(`${status.padEnd(4)} ${name}${note ? ' - ' + note : ''}`); };
const step = async (name, fn) => { try { report(name, 'PASS', await fn() ?? ''); } catch (e) { report(name, 'FAIL', String(e?.message ?? e).split('\n').slice(0, 6).join(' | ')); throw e; } };

async function main() {
  const manifest = vsixManifest(vsix);
  assert.ok((manifest.contributes?.customEditors ?? []).some(e => e.viewType === 'dataFileViewer.pdf'), 'VSIX declares no dataFileViewer.pdf editor');
  const extId = `${manifest.publisher}.${manifest.name}`;
  const root = await fs.mkdtemp('/tmp/dfvb-'); // short path: macOS socket paths are length-limited
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
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child, browser;
  // VS Code re-parents helpers, so kill by profile path too (the process group alone leaves some behind).
  const stop = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { execFileSync('pkill', ['-9', '-f', root]); } catch {} };
  const deadline = setTimeout(() => { stop(); console.error('PDF restart gate exceeded its deadline.'); process.exit(1); }, timeout * 6 + 60000);
  const waitFor = async (what, fn) => { for (const end = Date.now() + timeout; Date.now() < end;) { const v = await fn().catch(() => undefined); if (v) return v; await sleep(250); } throw new Error(`timed out: ${what}`); };
  const page = () => browser.contexts()[0]?.pages().at(-1);
  const frames = () => (page()?.frames() ?? []).filter(f => f.url().includes('vscode-webview'));
  const pixels = f => f.evaluate(() => {
    const img = document.querySelector('#pages .page img');
    if (!img || !img.complete || !img.naturalWidth) return null;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) ink++;
    let hash = 2166136261; for (let i = 0; i < d.length; i += 4) hash = Math.imul(hash ^ d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16), 16777619) >>> 0;
    return { w: img.naturalWidth, h: img.naturalHeight, ink, hash };
  });
  const nonBlank = (f, what, want) => waitFor(what, async () => { const p = await pixels(f); return p && p.ink > 50 && (!want || want(p)) ? p : undefined; });
  const pdfFrame = what => waitFor(what, async () => {
    for (const f of frames()) if (await f.locator('#export').count() && await f.locator('#pages').count()) return f;
  });
  const launch = async () => {
    const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    child = spawn(vscodeExecutable(), [...profileArgs, `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-workspace-trust',
      '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry',
      '--new-window', ws], { env, detached: true, stdio: 'ignore' });
    browser = undefined;
    for (let i = 0; i < 120 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); } catch { await sleep(250); }
    }
    assert.ok(browser, 'VS Code debugging endpoint');
    await waitFor('workbench', async () => page()?.locator('.monaco-workbench').count());
    await sleep(2000);
  };

  try {
    execFileSync(codeCli(), [...profileArgs, '--install-extension', vsix, '--force'], { stdio: 'pipe', timeout: 60000, env });
    const listed = execFileSync(codeCli(), [...profileArgs, '--list-extensions', '--show-versions'], { env }).toString();
    assert.ok(listed.toLowerCase().includes(`${extId}@${manifest.version}`.toLowerCase()), `installed ${extId}@${manifest.version}, got: ${listed.trim()}`);

    let rotated, first;
    await step('a. open PDF and rotate a page (unsaved)', async () => {
      await launch();
      execFileSync(codeCli(), [...profileArgs, '-r', pdf], { stdio: 'pipe', timeout: 30000, env });
      const frame = await pdfFrame('PDF editor frame');
      first = await nonBlank(frame, 'non-blank page image');
      await frame.locator('[data-workspace-tab="organize"]').click();
      if (!await frame.locator('#rail .thumb').first().isVisible()) await frame.locator('#rail-toggle').click();
      await frame.locator('#rail .thumb').first().click();
      await waitFor('rotate enabled', async () => !(await frame.locator('#rot-r').isDisabled()));
      await frame.locator('#rot-r').click();
      rotated = await nonBlank(frame, 'rotated page image', p => p.w > p.h === first.w < first.h);
      await waitFor('tab marked dirty', async () => page().locator('.tab.dirty').count());
      await sleep(6000); // past VS Code's own debounced hot-exit backup call, then pull the plug
      return `${first.w}x${first.h} -> ${rotated.w}x${rotated.h}, tab dirty`;
    });

    await step('b. quit VS Code (hot exit), then end every process', async () => {
      await browser.close().catch(() => {});
      if (!args.includes('--kill')) { process.kill(child.pid, 'SIGTERM'); await sleep(8000); }
      stop();
      await waitFor('every process gone', async () => { try { execFileSync('pgrep', ['-f', root]); return false; } catch { return true; } });
      return 'no process with the profile path remains';
    });

    await step('c. relaunch same profile WITHOUT opening the file: VS Code reopens the dirty tab itself', async () => {
      await launch();
      await pdfFrame('PDF editor frame restored by VS Code');
      return 'editor frame appeared without a CLI open';
    });

    await step('d. reopened tab is dirty and shows the edited page; no extra restore prompt', async () => {
      const frame = await pdfFrame('PDF editor frame');
      const p = await nonBlank(frame, 'non-blank page image after reopen');
      await sleep(4000); // time for the provider's own offer (or an automatic restore) to settle
      const dirty = await page().locator('.tab.dirty').count();
      const offers = await page().locator('.notification-toast', { hasText: 'Restore unsaved edits' }).count();
      const q = await pixels(await pdfFrame('PDF editor frame after settle'));
      assert.ok(dirty > 0, 'the reopened tab is not marked dirty');
      assert.equal(offers, 0, `${offers} "Restore unsaved edits" prompt(s) still waiting: the tab was reopened but not restored`);
      assert.equal(`${q.w}x${q.h}`, `${rotated.w}x${rotated.h}`, `reopened page is ${q.w}x${q.h}, not the edited ${rotated.w}x${rotated.h} (original was ${first.w}x${first.h})`);
      assert.equal(q.hash, rotated.hash, 'reopened page pixels differ from the edited page before the kill');
      return `${q.w}x${q.h} identical pixels to the edited page, tab dirty, no prompt`;
    });

    await step('e. original PDF sha256 unchanged, nothing written beside it', async () => {
      assert.equal(await sha(pdf), shaBefore, 'original sha256 changed');
      assert.deepEqual((await fs.readdir(ws)).sort(), filesBefore, 'files appeared beside the original');
      return `sha256 ${shaBefore.slice(0, 12)}... identical`;
    });
  } catch (e) {
    if (!results.some(r => r.status === 'FAIL')) report('gate', 'FAIL', String(e?.message ?? e).split('\n')[0]);
  } finally {
    stop(); await browser?.close().catch(() => {});
    if (args.includes('--keep')) console.log(`kept ${root}`); else await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
}
main();
