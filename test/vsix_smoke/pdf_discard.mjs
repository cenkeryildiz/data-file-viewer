#!/usr/bin/env node
// VSIX gate for the recovery record's life cycle in a live window (no kill involved):
//   D  closing a DIRTY tab with "Don't Save" is an explicit discard: no record may remain, and the next open must not offer
//      "Restore unsaved edits" and must show the original page.
//   S  after Ctrl+S, Save As, and several edit-save cycles the record is clean (dirty:false) and never offered on the next open.
//
// Usage (repo root):  node test/vsix_smoke/pdf_discard.mjs <path-to.vsix> [--pdf file.pdf] [--keep] [--shots dir]
// Env: DFV_VSCODE_EXECUTABLE, DFV_CODE_CLI (default `code`), DFV_SMOKE_PDF, DFV_SMOKE_TIMEOUT_MS (default 90000).
//
// Disposable --user-data-dir/--extensions-dir (the real VS Code profile is never touched). The profile sets
// files.simpleDialog.enable and window.dialogStyle=custom so the save dialogs and the "Do you want to save" prompt can be driven
// over CDP. The recovery record is read straight from the extension's globalStorage/pdf-recovery/*/manifest.json
// (kind, dirty, source.name); a record only counts when it is dirty, as only dirty records are ever offered.
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
const vsix = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pdf' && args[i - 1] !== '--shots') ?? '');
const timeout = +(process.env.DFV_SMOKE_TIMEOUT_MS || 90000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = async f => createHash('sha256').update(await fs.readFile(f)).digest('hex');
const results = [];
const report = (name, status, note = '') => { results.push({ name, status }); console.log(`${status.padEnd(4)} ${name}${note ? ' - ' + note : ''}`); };
let shoot = async () => {};
const step = async (name, fn) => { try { report(name, 'PASS', await fn() ?? ''); } catch (e) { report(name, 'FAIL', String(e?.message ?? e).split('\n').slice(0, 4).join(' | ')); await shoot(name).catch(() => {}); throw Object.assign(e, { reported: true }); } };

async function main() {
  const manifest = vsixManifest(vsix);
  assert.ok((manifest.contributes?.customEditors ?? []).some(e => e.viewType === 'dataFileViewer.pdf'), 'VSIX declares no dataFileViewer.pdf editor');
  const extId = `${manifest.publisher}.${manifest.name}`;
  const root = await fs.mkdtemp('/tmp/dfvd-');
  const user = path.join(root, 'user'), exts = path.join(root, 'extensions'), ws = path.join(root, 'ws');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(ws);
  const files = n => path.join(ws, n);
  for (const n of ['d.pdf', 's.pdf']) samplePdf(files(n), opt('--pdf'));
  const baseline = { 'd.pdf': await sha(files('d.pdf')), 's.pdf': await sha(files('s.pdf')) };
  await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false,
    'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'window.confirmBeforeClose': 'never',
    'workbench.editorAssociations': { '*.pdf': 'dataFileViewer.pdf' },
  }));
  const profileArgs = ['--user-data-dir', user, '--extensions-dir', exts];
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child, browser;
  const stop = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { execFileSync('pkill', ['-9', '-f', root]); } catch {} };
  const deadline = setTimeout(() => { stop(); console.error('Exceeded its deadline.'); process.exit(1); }, timeout * 8 + 60000);
  try {
    execFileSync(codeCli(), [...profileArgs, '--install-extension', vsix, '--force'], { stdio: 'pipe', timeout: 60000, env });
    const listed = execFileSync(codeCli(), [...profileArgs, '--list-extensions', '--show-versions'], { env }).toString();
    assert.ok(listed.toLowerCase().includes(`${extId}@${manifest.version}`.toLowerCase()), `installed ${extId}@${manifest.version}, got: ${listed.trim()}`);
    report('install', 'PASS', `${extId}@${manifest.version}`);

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
    const waitFor = async (what, fn, ms = timeout) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn().catch(() => undefined); if (v) return v; await sleep(250); } throw new Error(`timed out: ${what}`); };
    await waitFor('workbench', async () => page()?.locator('.monaco-workbench').count());
    await sleep(2000);
    shoot = async n => { if (opt('--shots')) { await fs.mkdir(opt('--shots'), { recursive: true }); await page().screenshot({ path: path.join(opt('--shots'), n.split(' ')[0] + '.png') }); } };

    const tab = n => page().locator(`.tab[aria-label*="${n}"]`);
    const isDirty = async n => (await tab(n).first().getAttribute('class').catch(() => '') ?? '').split(/\s+/).includes('dirty');
    const pdfFrame = (what, known = new Set()) => waitFor(what, async () => {
      for (const f of frames()) if (!known.has(f.url()) && await f.locator('#export').count() && await f.locator('#pages').count()) return f;
    });
    const imageSize = f => f.evaluate(() => { const i = document.querySelector('#pages .page img'); return i?.complete && i.naturalWidth ? { w: i.naturalWidth, h: i.naturalHeight } : null; });
    const openPdf = async (n) => {
      const known = new Set(frames().map(f => f.url()));
      execFileSync(codeCli(), [...profileArgs, '-r', files(n)], { stdio: 'pipe', timeout: 30000, env });
      await waitFor(`${n} tab`, async () => tab(n).count());
      const f = await pdfFrame(`${n} frame`, known);
      await waitFor(`${n} page image`, async () => imageSize(f));
      return f;
    };
    const rotate = async (f) => {
      const before = await imageSize(f);
      await f.locator('[data-workspace-tab="organize"]').click();
      if (!await f.locator('#rail .thumb').first().isVisible()) await f.locator('#rail-toggle').click();
      await f.locator('#rail .thumb').first().click();
      await waitFor('rotate enabled', async () => !(await f.locator('#rot-r').isDisabled()));
      await f.locator('#rot-r').click();
      await waitFor('rotated image', async () => { const p = await imageSize(f); return p && (p.w > p.h) !== (before.w > before.h); });
    };
    const answerDialog = async (dest) => {
      const box = page().locator('.quick-input-widget input.input').first();
      await waitFor('save dialog (quick input)', async () => (await box.count()) && await box.isVisible());
      await box.fill(dest); await page().keyboard.press('Enter');
    };
    const dialog = () => page().locator('.monaco-dialog-box');
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    const key = async (f, combo) => { await f.locator('#pages').click({ position: { x: 5, y: 5 }, force: true }).catch(() => {}); await page().keyboard.press(combo); };
    const toasts = async () => (await page().locator('.notifications-toasts .notification-list-item-message').allInnerTexts()).join(' | ') || '(none)';
    const offers = () => page().locator('.notification-toast', { hasText: 'Restore unsaved edits' }).count();
    // Every recovery manifest in the extension's storage: [{name, kind, dirty, cause}].
    const records = async () => {
      const out = [];
      const base = path.join(user, 'User', 'globalStorage');
      for (const ext of await fs.readdir(base).catch(() => [])) {
        const dir = path.join(base, ext, 'pdf-recovery');
        for (const e of await fs.readdir(dir).catch(() => [])) {
          try { const b = JSON.parse(await fs.readFile(path.join(dir, e, 'manifest.json'), 'utf8')); out.push({ name: b.source?.name, kind: b.kind, dirty: b.dirty, cause: b.cause }); } catch { /* partial or foreign entry */ }
        }
      }
      return out;
    };
    const dirtyFor = async n => (await records()).filter(r => r.kind === 'recovery' && r.dirty === true && r.name === n);
    const workerGone = () => { try { execFileSync('pgrep', ['-f', `${root}.*dfv-pdf`], { stdio: 'pipe' }); return false; } catch { return true; } };
    const settle = async () => { await waitFor('worker stopped after the tab closed', async () => workerGone(), 20000); await sleep(500); };

    // ---------- D: "Don't Save" is a discard ----------
    try {
      let f, orig;
      await step('D1 open d.pdf, rotate: tab dirty and the engine holds a dirty record', async () => {
        f = await openPdf('d.pdf');
        orig = await imageSize(f);
        await rotate(f);
        await waitFor('dirty tab', async () => isDirty('d.pdf'));
        await waitFor('dirty record', async () => (await dirtyFor('d.pdf')).length, 15000);
        return `${(await dirtyFor('d.pdf')).length} dirty record(s) while editing`;
      });
      await step("D2 close tab -> Don't Save: tab closes, original unchanged", async () => {
        await key(f, `${mod}+w`);
        await waitFor('save prompt', async () => dialog().first().isVisible());
        await dialog().first().getByText(/Don.t Save/).click();
        await waitFor('tab closed', async () => !(await tab('d.pdf').count()));
        await settle();
        assert.equal(await sha(files('d.pdf')), baseline['d.pdf'], 'original changed');
      });
      await step("D3 no dirty record is left after an explicit Don't Save", async () => {
        const left = await dirtyFor('d.pdf');
        assert.equal(left.length, 0, `${left.length} dirty record(s) survive the discard: ${JSON.stringify(left)}`);
        return `records: ${JSON.stringify(await records())}`;
      });
      await step('D4 reopen d.pdf: original page, clean tab, no "Restore unsaved edits" offer', async () => {
        f = await openPdf('d.pdf');
        const first = await imageSize(f);
        await sleep(5000); // the provider's own offer would be shown by now
        assert.equal(await offers(), 0, `"Restore unsaved edits" offered after the user discarded the edits; toasts: ${await toasts()}`);
        assert.equal(await isDirty('d.pdf'), false, 'reopened tab is dirty');
        assert.deepEqual(first, orig, `reopened page is ${first.w}x${first.h}, original was ${orig.w}x${orig.h}`);
        return `${first.w}x${first.h} (original), no offer`;
      });
      await key(f, `${mod}+w`);
      await waitFor('tab closed', async () => !(await tab('d.pdf').count()));
      await settle();
    } catch (e) { if (!e.reported) report('D', 'FAIL', String(e?.message ?? e).split('\n')[0]); }

    // ---------- S: Save / Save As / repeated cycles leave the record clean ----------
    try {
      let f;
      await step('S1 open s.pdf', async () => { f = await openPdf('s.pdf'); });
      for (let i = 1; i <= 3; i++) {
        const dest = files(`s_save${i}.pdf`);
        await step(`S2.${i} cycle ${i}: rotate (dirty record), Ctrl+S, tab clean, record dirty:false`, async () => {
          await rotate(f);
          await waitFor('dirty tab', async () => isDirty('s.pdf'));
          await waitFor('dirty record', async () => (await dirtyFor('s.pdf')).length, 15000);
          await key(f, `${mod}+s`);
          await answerDialog(dest);
          await waitFor('saved file', async () => (await fs.stat(dest).catch(() => null))?.size > 0);
          await waitFor('tab clean', async () => !(await isDirty('s.pdf')), 15000).catch(async () => { throw new Error(`tab still dirty; toasts: ${await toasts()}`); });
          await sleep(500);
          const stale = await dirtyFor('s.pdf');
          assert.equal(stale.length, 0, `${stale.length} record(s) still dirty after Save: ${JSON.stringify(stale)}`);
          return JSON.stringify(await records());
        });
      }
      await step('S3 close the clean tab (no prompt), reopen: no offer, clean', async () => {
        await key(f, `${mod}+w`);
        await waitFor('tab closed', async () => !(await tab('s.pdf').count()), 15000).catch(async () => { throw new Error(`tab did not close; dialog: ${await dialog().count()}`); });
        await settle();
        assert.equal((await dirtyFor('s.pdf')).length, 0, 'a dirty record survives closing a saved document');
        f = await openPdf('s.pdf');
        await sleep(5000);
        assert.equal(await offers(), 0, `stale "Restore unsaved edits" offer after saving; toasts: ${await toasts()}`);
        assert.equal(await isDirty('s.pdf'), false, 'reopened tab is dirty');
      });
      await step('S4 rotate, Save As: record dirty:false, reopening s.pdf offers nothing', async () => {
        await rotate(f);
        await waitFor('dirty record', async () => (await dirtyFor('s.pdf')).length, 15000);
        await key(f, `${mod}+Shift+s`);
        await answerDialog(files('s_as.pdf'));
        await waitFor('save-as file', async () => (await fs.stat(files('s_as.pdf')).catch(() => null))?.size > 0);
        await sleep(2000);
        const stale = await dirtyFor('s.pdf');
        assert.equal(stale.length, 0, `${stale.length} record(s) still dirty after Save As: ${JSON.stringify(stale)}`);
        // Save As retargets the editor to the copy; close every tab so the old document is disposed, then reopen the source.
        await page().keyboard.press(`${mod}+k`); await page().keyboard.press('w');
        await waitFor('no tabs', async () => !(await page().locator('.tab').count()), 15000).catch(() => {});
        await settle().catch(() => {});
        assert.equal((await dirtyFor('s.pdf')).length, 0, 'a dirty record survives closing');
        f = await openPdf('s.pdf');
        await sleep(5000);
        assert.equal(await offers(), 0, `stale "Restore unsaved edits" offer after Save As; toasts: ${await toasts()}`);
        assert.equal(await sha(files('s.pdf')), baseline['s.pdf'], 'original changed');
        return JSON.stringify(await records());
      });
      await step('S5 rotate, Export button: record dirty:false, a crash-time listing would offer nothing', async () => {
        await rotate(f);
        await waitFor('dirty record', async () => (await dirtyFor('s.pdf')).length, 15000);
        await f.locator('#export').click();
        await answerDialog(files('s_export.pdf'));
        await waitFor('exported file', async () => (await fs.stat(files('s_export.pdf')).catch(() => null))?.size > 0);
        await sleep(3000); // the webview acknowledges the receipt (mark_saved) after the file is written
        const stale = await dirtyFor('s.pdf');
        assert.equal(stale.length, 0, `${stale.length} record(s) still dirty after Export: ${JSON.stringify(stale)}`);
        return JSON.stringify(await records());
      });
    } catch (e) { if (!e.reported) report('S', 'FAIL', String(e?.message ?? e).split('\n')[0]); }
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
