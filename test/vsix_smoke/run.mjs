#!/usr/bin/env node
// VSIX smoke test: installs a VSIX into a disposable VS Code profile and checks it in the real app.
//
// Usage (from the repo root):   node test/vsix_smoke/run.mjs <path-to.vsix> [--pdf file.pdf] [--keep]
//                                    [--require-pdf] [--worker-pattern <regex>]
// Env: DFV_VSCODE_EXECUTABLE (VS Code binary; macOS app auto-detected), DFV_CODE_CLI (default `code`),
//      DFV_SMOKE_PDF (same as --pdf), DFV_SMOKE_TIMEOUT_MS (default 90000).
//
// What it does: temp --user-data-dir/--extensions-dir/workspace (your real profile and installed
// extensions are never touched; trust prompts and Copilot are off), `code --install-extension`,
// launch with --remote-debugging-port and drive it via playwright over CDP (already a repo dependency).
// Checks:  1 installed   2 extension activates (its webview is hosted by cenker-local.data-file-viewer)
//          3 CSV opens in the table editor (grid cells + sample values rendered, file unchanged)
//          4 PDF opens in the dataFileViewer.pdf editor (editor association forces that viewType)
//          5 PDF worker spawns (a new non-Electron process under the VS Code tree, or one matching --worker-pattern)
// Checks 4-5 are SKIPPED (exit 0) if the VSIX declares no dataFileViewer.pdf editor, unless --require-pdf.
// Not automated: visual correctness of PDF pages, Save As dialogs (native OS dialogs), restart recovery.
// Exit code: 0 all run checks pass, 1 failure.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { activationLog, codeCli, descendants, isElectronHelper, samplePdf, vscodeExecutable, vsixManifest } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const vsix = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pdf' && args[i - 1] !== '--worker-pattern') ?? '');
const timeout = +(process.env.DFV_SMOKE_TIMEOUT_MS || 90000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const report = (name, status, note = '') => { results.push({ name, status, note }); console.log(`${status.padEnd(4)} ${name}${note ? ' - ' + note : ''}`); };
const EXT_ID = 'cenker-local.data-file-viewer';

async function main() {
  const manifest = vsixManifest(vsix);
  const hasPdf = (manifest.contributes?.customEditors ?? []).some(e => e.viewType === 'dataFileViewer.pdf');
  const extId = `${manifest.publisher}.${manifest.name}`;
  const exe = vscodeExecutable();
  const root = await fs.mkdtemp('/tmp/dfvs-'); // short path: macOS socket paths are length-limited
  const user = path.join(root, 'user'), exts = path.join(root, 'extensions'), ws = path.join(root, 'ws');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(ws);
  const csv = path.join(ws, 'sample.csv'), pdf = path.join(ws, 'sample.pdf');
  await fs.writeFile(csv, 'id,name,score\n1,alpha,10.5\n2,beta,20.25\n3,gamma,30\n');
  samplePdf(pdf, opt('--pdf'));
  const csvBefore = await fs.readFile(csv);
  await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false,
    'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    ...(hasPdf ? { 'workbench.editorAssociations': { '*.pdf': 'dataFileViewer.pdf' } } : {}),
  }));
  const profileArgs = ['--user-data-dir', user, '--extensions-dir', exts];
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child, browser;
  const stop = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const deadline = setTimeout(() => { stop(); console.error('Smoke test exceeded its deadline.'); process.exit(1); }, timeout + 60000);
  try {
    // 1 install
    execFileSync(codeCli(), [...profileArgs, '--install-extension', vsix, '--force'], { stdio: 'pipe', timeout: 60000 });
    const listed = execFileSync(codeCli(), [...profileArgs, '--list-extensions', '--show-versions']).toString();
    assert.ok(listed.toLowerCase().includes(`${extId}@${manifest.version}`.toLowerCase()), `installed ${extId}@${manifest.version}, got: ${listed.trim()}`);
    report('install', 'PASS', `${extId}@${manifest.version}`);

    const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    child = spawn(exe, [...profileArgs, `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-workspace-trust',
      '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry',
      '--new-window', ws], { env, detached: true, stdio: 'ignore' });
    for (let i = 0; i < 120 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); } catch { await sleep(250); }
    }
    assert.ok(browser, 'VS Code debugging endpoint');
    const page = () => browser.contexts()[0]?.pages().at(-1);
    // The webview content frame is nested: outer frame URL carries extensionId, inner frame holds our DOM.
    const webviewFrames = () => (page()?.frames() ?? []).filter(f => f.url().includes('vscode-webview'));
    const waitFor = async (what, fn) => { for (const end = Date.now() + timeout; Date.now() < end;) { const v = await fn().catch(() => undefined); if (v) return v; await sleep(250); } throw new Error(`timed out: ${what}`); };

    await waitFor('workbench', async () => page()?.locator('.monaco-workbench').count());
    await sleep(2000); // let the extension scan settle, then open like a user would (file launched with the window can fall back to text)
    execFileSync(codeCli(), [...profileArgs, '-r', csv], { stdio: 'pipe', timeout: 30000 });
    // 3 + 2 CSV in table editor (rendering proves activation: only the extension provides this editor)
    const grid = await waitFor('CSV grid', async () => {
      for (const f of webviewFrames()) if (await f.locator('td[data-r]').count() >= 3 && (await f.locator('body').innerText()).includes('gamma')) return f;
    });
    report('csv table editor', 'PASS', `${await grid.locator('td[data-r]').count()} cells rendered`);
    const outerUrls = page().frames().map(f => f.url()).filter(u => u.includes('extensionId='));
    assert.ok(outerUrls.some(u => decodeURIComponent(u).includes(`extensionId=${extId}`)), `a webview hosted by ${extId}; saw ${outerUrls.length} extensionId frames`);
    const act = activationLog(user, extId);
    assert.ok(act.activated, `exthost.log shows ${extId} activated${act.error ? ': ' + act.error : ''}`);
    report('extension activates', 'PASS', 'exthost.log activation + its custom-editor webview is live');
    assert.deepEqual(await fs.readFile(csv), csvBefore); // viewing must not modify the source

    if (!hasPdf) {
      const why = 'VSIX declares no dataFileViewer.pdf custom editor';
      if (flag('--require-pdf')) { report('pdf editor', 'FAIL', why); } else { report('pdf editor', 'SKIP', why); report('pdf worker', 'SKIP', why); }
    } else {
      const before = new Set(descendants(child.pid).map(p => p.pid));
      execFileSync(codeCli(), [...profileArgs, '-r', pdf], { stdio: 'pipe', timeout: 30000 });
      const known = new Set(webviewFrames().map(f => f.url()));
      const pdfFrame = await waitFor('PDF webview', async () => {
        for (const f of webviewFrames()) {
          if (known.has(f.url()) || f === grid) continue;
          if ((await f.locator('body *').count()) > 5) return f;
        }
      });
      const tab = await page().locator('.tab[aria-label*="sample.pdf"]').count();
      report('pdf editor', tab ? 'PASS' : 'FAIL', `sample.pdf tab ${tab ? 'open' : 'missing'}; webview has ${await pdfFrame.locator('canvas, img, svg').count()} canvas/img/svg`);
      const pattern = opt('--worker-pattern') ? new RegExp(opt('--worker-pattern')) : undefined;
      const worker = await waitFor('PDF worker process', async () =>
        descendants(child.pid).find(p => !before.has(p.pid) && (pattern ? pattern.test(p.command) : !isElectronHelper(p.command))));
      report('pdf worker', 'PASS', worker.command.slice(0, 120));
    }
  } catch (e) {
    const act = activationLog(user, extId);
    if (act.error) console.error(act.error.slice(0, 300));
    report('smoke', 'FAIL', String(e?.message ?? e).split('\n')[0]);
  } finally {
    stop(); await browser?.close().catch(() => {});
    if (flag('--keep')) console.log(`kept ${root}`); else await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
}
main();
