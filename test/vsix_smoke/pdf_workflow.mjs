#!/usr/bin/env node
// VSIX PDF workflow gate: one real PDF open -> render -> rotate -> Export -> independent verify -> reopen.
//
// Usage (from the repo root):   node test/vsix_smoke/pdf_workflow.mjs <path-to.vsix> [--pdf file.pdf] [--keep]
// Env: DFV_VSCODE_EXECUTABLE, DFV_CODE_CLI (default `code`), DFV_SMOKE_PDF, DFV_SMOKE_TIMEOUT_MS (default 90000),
//      DFV_PYTHON (python with PyMuPDF; default the `myproject` conda env).
//
// Everything runs in a disposable --user-data-dir/--extensions-dir (the real VS Code profile is never touched).
// Save dialog: the host calls vscode.window.showSaveDialog, which is a native OS dialog that CDP cannot drive.
// The harness sets `files.simpleDialog.enable` in the disposable profile, so VS Code shows its own in-window
// quick-input dialog instead; the harness types the destination there and presses Enter. The webview's own
// Export button is used (the provider intercepts export_verified and asks for the destination), no stubs.
// Steps: 1 install  2 PDF opens in the editor  3 page image has non-blank pixels  4 rotate via the UI
//        5 Export through the dialog  6 PyMuPDF: /Rotate changed, text kept, original sha256 unchanged
//        7 exported PDF reopens in the editor and renders non-blank.
// Not automated: the native macOS save dialog itself (replaced by VS Code's simple dialog), Ctrl+S / Save As
// from the VS Code menu, close-while-dirty prompts, restart recovery.
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
const step = async (name, fn) => { try { report(name, 'PASS', await fn() ?? ''); } catch (e) { report(name, 'FAIL', String(e?.message ?? e).split('\n')[0]); throw e; } };

// Reads the PDF with PyMuPDF in a separate process: prints {rotations:[...], pages, text}.
const READER = `import sys,json,pymupdf
d=pymupdf.open(sys.argv[1]);print(json.dumps({"rotations":[p.rotation for p in d],"pages":len(d),"text":"".join(p.get_text() for p in d).strip()}))`;
const python = process.env.DFV_PYTHON || '/Users/macc/miniforge3/envs/myproject/bin/python3';
const readPdf = f => JSON.parse(execFileSync(python, ['-I', '-c', READER, f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());

async function main() {
  const manifest = vsixManifest(vsix);
  assert.ok((manifest.contributes?.customEditors ?? []).some(e => e.viewType === 'dataFileViewer.pdf'), 'VSIX declares no dataFileViewer.pdf editor');
  const extId = `${manifest.publisher}.${manifest.name}`;
  const root = await fs.mkdtemp('/tmp/dfvp-'); // short path: macOS socket paths are length-limited
  const user = path.join(root, 'user'), exts = path.join(root, 'extensions'), ws = path.join(root, 'ws');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(ws);
  const pdf = path.join(ws, 'sample.pdf'), out = path.join(ws, 'exported_rotated.pdf');
  samplePdf(pdf, opt('--pdf'));
  const shaBefore = await sha(pdf);
  await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false,
    'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'files.simpleDialog.enable': true, // in-window save dialog the harness can type into
    'workbench.editorAssociations': { '*.pdf': 'dataFileViewer.pdf' },
  }));
  const profileArgs = ['--user-data-dir', user, '--extensions-dir', exts];
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child, browser;
  // VS Code re-parents helpers, so also kill by profile path (the process group alone leaves some behind).
  const stop = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { execFileSync('pkill', ['-9', '-f', root]); } catch {} };
  const deadline = setTimeout(() => { stop(); console.error('PDF workflow exceeded its deadline.'); process.exit(1); }, timeout * 4 + 60000);
  try {
    await step('install', async () => {
      execFileSync(codeCli(), [...profileArgs, '--install-extension', vsix, '--force'], { stdio: 'pipe', timeout: 60000 });
      const listed = execFileSync(codeCli(), [...profileArgs, '--list-extensions', '--show-versions']).toString();
      assert.ok(listed.toLowerCase().includes(`${extId}@${manifest.version}`.toLowerCase()), `installed ${extId}@${manifest.version}, got: ${listed.trim()}`);
      return `${extId}@${manifest.version}`;
    });

    const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    child = spawn(vscodeExecutable(), [...profileArgs, `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-workspace-trust',
      '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry',
      '--new-window', ws], { env, detached: true, stdio: 'ignore' });
    for (let i = 0; i < 120 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); } catch { await sleep(250); }
    }
    assert.ok(browser, 'VS Code debugging endpoint');
    const page = () => browser.contexts()[0]?.pages().at(-1);
    const frames = () => (page()?.frames() ?? []).filter(f => f.url().includes('vscode-webview'));
    const waitFor = async (what, fn) => { for (const end = Date.now() + timeout; Date.now() < end;) { const v = await fn().catch(() => undefined); if (v) return v; await sleep(250); } throw new Error(`timed out: ${what}`); };
    await waitFor('workbench', async () => page()?.locator('.monaco-workbench').count());
    await sleep(2000);

    // Non-blank = the first page <img> (raster from the worker) has decoded and contains non-white, non-transparent pixels.
    const pixels = f => f.evaluate(() => {
      const img = document.querySelector('#pages .page img');
      if (!img || !img.complete || !img.naturalWidth) return null;
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) ink++;
      return { w: img.naturalWidth, h: img.naturalHeight, ink, total: d.length / 4 };
    });
    const nonBlank = (f, what) => waitFor(what, async () => { const p = await pixels(f); return p && p.ink > 50 ? p : undefined; });
    // The PDF UI frame is the (not yet known) webview frame holding #pages and the Export button.
    const pdfFrame = (what, known = new Set()) => waitFor(what, async () => {
      for (const f of frames()) if (!known.has(f.url()) && await f.locator('#export').count() && await f.locator('#pages').count()) return f;
    });

    let frame, first;
    await step('pdf opens in editor', async () => {
      execFileSync(codeCli(), [...profileArgs, '-r', pdf], { stdio: 'pipe', timeout: 30000 });
      frame = await pdfFrame('PDF editor frame');
      assert.ok(await page().locator('.tab[aria-label*="sample.pdf"]').count(), 'sample.pdf tab missing');
      return 'sample.pdf tab + PDF toolbar rendered';
    });
    await step('page renders non-blank pixels', async () => {
      first = await nonBlank(frame, 'non-blank page image');
      return `${first.w}x${first.h} page image, ${first.ink} ink pixels (${(100 * first.ink / first.total).toFixed(2)}%)`;
    });

    await step('rotate page via UI', async () => {
      await frame.locator('[data-workspace-tab="organize"]').click();
      if (!await frame.locator('#rail .thumb').first().isVisible()) await frame.locator('#rail-toggle').click(); // narrow window collapses the page rail
      await frame.locator('#rail .thumb').first().click();
      await waitFor('rotate enabled', async () => !(await frame.locator('#rot-r').isDisabled()));
      await frame.locator('#rot-r').click();
      // The worker owns the result: wait until the page image flips orientation (render scale may change) and still has ink.
      const rotated = await waitFor('rotated page image', async () => { const p = await pixels(frame); return p && p.ink > 50 && (p.w > p.h) !== (first.w > first.h) ? p : undefined; });
      return `page image ${first.w}x${first.h} -> ${rotated.w}x${rotated.h}`;
    });

    await step('cancel Export is quiet and retains the edit', async () => {
      const before = await frame.evaluate(() => ({ revision: S.revision, dirty: UNDO.state.dirty, failures: S.failures?.length ?? 0 }));
      assert.equal(await frame.locator('#export-compact').textContent(), 'Reduce file size…');
      for (const selector of ['#export', '#export-compact']) {
        if (!await frame.locator(selector).isVisible()) await frame.locator('#tools-more').click();
        await frame.locator(selector).click();
        const box = page().locator('.quick-input-widget input.input').first();
        await waitFor('save dialog before cancel', async () => (await box.count()) && await box.isVisible());
        await page().keyboard.press('Escape');
        await waitFor('export available after cancel', async () => frame.locator('#export').isEnabled());
        assert.deepEqual(await frame.evaluate(() => ({ revision: S.revision, dirty: UNDO.state.dirty, failures: S.failures?.length ?? 0 })), before);
        assert.doesNotMatch(await frame.locator('#toast').innerText(), /server refused|export failed/i);
      }
      assert.equal(await sha(pdf), shaBefore);
      assert.equal(await fs.stat(out).catch(() => null), null);
    });

    await step('export via Export button + save dialog', async () => {
      await frame.locator('#export').click();
      const box = page().locator('.quick-input-widget input.input').first();
      await waitFor('save dialog (quick input)', async () => (await box.count()) && await box.isVisible());
      await box.fill(out);
      await page().keyboard.press('Enter');
      await waitFor('exported file', async () => (await fs.stat(out).catch(() => null))?.size > 0);
      await sleep(1500); // let the webview acknowledge the receipt before the process is torn down
      const toast = (await frame.locator('#toast').innerText().catch(() => '')).trim();
      return `wrote ${(await fs.stat(out)).size} bytes; toast: ${toast || '(gone)'}`;
    });

    await step('independent reader (PyMuPDF): /Rotate changed, original untouched', async () => {
      const [orig, edited] = [readPdf(pdf), readPdf(out)];
      assert.equal(await sha(pdf), shaBefore, 'original sha256 changed');
      assert.equal(edited.rotations[0], (orig.rotations[0] + 90) % 360, `expected rotation +90 from ${orig.rotations}, got ${edited.rotations}`);
      assert.equal(edited.pages, orig.pages, 'page count changed');
      assert.equal(edited.text, orig.text, 'text content changed');
      return `rotation ${orig.rotations} -> ${edited.rotations}; ${edited.pages} page(s), text identical; original sha256 ${shaBefore.slice(0, 12)} unchanged`;
    });

    await step('reopen exported PDF in editor', async () => {
      const known = new Set(frames().map(f => f.url()));
      execFileSync(codeCli(), [...profileArgs, '-r', out], { stdio: 'pipe', timeout: 30000 });
      await waitFor('exported tab', async () => page().locator('.tab[aria-label*="exported_rotated.pdf"]').count());
      const p = await nonBlank(await pdfFrame('reopened PDF frame', known), 'non-blank reopened page');
      assert.ok((p.w > p.h) !== (first.w > first.h), `reopened page orientation should be rotated, got ${p.w}x${p.h}`);
      return `${p.w}x${p.h} rotated page image, ${p.ink} ink pixels`;
    });
  } catch (e) {
    if (!results.some(r => r.status === 'FAIL')) report('workflow', 'FAIL', String(e?.message ?? e).split('\n')[0]);
  } finally {
    stop(); await browser?.close().catch(() => {});
    if (args.includes('--keep')) console.log(`kept ${root}`); else await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
}
main();
