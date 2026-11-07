#!/usr/bin/env node
// VSIX gate for the two MVP gaps pdf_workflow.mjs leaves open: VS Code save/close behaviour and a basic text edit.
//
// Usage (repo root):  node test/vsix_smoke/pdf_save_text.mjs <path-to.vsix> [--pdf file.pdf] [--keep]
// Env: DFV_VSCODE_EXECUTABLE, DFV_CODE_CLI (default `code`), DFV_SMOKE_TIMEOUT_MS (default 90000),
//      DFV_PYTHON (python with PyMuPDF; default the `myproject` conda env).
//
// Disposable --user-data-dir/--extensions-dir (the real VS Code profile is never touched). The profile sets
// files.simpleDialog.enable (save dialogs become in-window quick inputs) and window.dialogStyle=custom (the
// "Do you want to save" prompt becomes a DOM dialog) so both can be driven over CDP.
// Needs a PDF with editable uniform own-font text (default: the d4-11 base.pdf fixture, three Helvetica lines).
//
// A  Save/Close (sample A.pdf):  rotate -> tab dirty -> Ctrl+S (saveCustomDocument) -> dialog -> PyMuPDF /Rotate +90,
//    text kept, original sha256 unchanged, tab clean.   rotate again -> Save As (saveCustomDocumentAs) -> same checks.
//    rotate -> close -> "Do you want to save" dialog appears -> Cancel keeps tab open and dirty.
//    close again -> Don't Save -> tab closes, original sha256 unchanged.
// B  Text edit (c.pdf):  Edit workspace -> #text-toggle -> click a run -> panel editor -> replace that run -> Export ->
//    PyMuPDF: new text present, old text gone, other lines (incl. footer) and page geometry unchanged, original sha256 unchanged.
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
const vsix = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pdf' && args[i - 1] !== '--shots' && args[i - 1] !== '--only') ?? '');
const timeout = +(process.env.DFV_SMOKE_TIMEOUT_MS || 90000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = async f => createHash('sha256').update(await fs.readFile(f)).digest('hex');
const results = [];
const report = (name, status, note = '') => { results.push({ name, status }); console.log(`${status.padEnd(4)} ${name}${note ? ' - ' + note : ''}`); };
// A failed step aborts only its own scenario.
let shoot = async () => {}; // set once the window exists: --shots <dir> saves a screenshot of every failure
const step = async (name, fn, soft = false) => { try { report(name, 'PASS', await fn() ?? ''); } catch (e) { report(name, 'FAIL', String(e?.message ?? e).split('\n')[0]); await shoot(name).catch(() => {}); if (!soft) throw Object.assign(e, { reported: true }); } };

const READER = `import sys,json,pymupdf
d=pymupdf.open(sys.argv[1]);p=d[0]
print(json.dumps({"rotations":[q.rotation for q in d],"pages":len(d),"rect":list(p.rect),"text":"".join(q.get_text() for q in d).strip(),
 "lines":[[round(l["bbox"][0],1),round(l["bbox"][1],1),"".join(s["text"] for s in l["spans"])] for b in p.get_text("dict")["blocks"] for l in b.get("lines",[])]}))`;
const python = process.env.DFV_PYTHON || '/Users/macc/miniforge3/envs/myproject/bin/python3';
const readPdf = f => JSON.parse(execFileSync(python, ['-I', '-c', READER, f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());

async function main() {
  const manifest = vsixManifest(vsix);
  assert.ok((manifest.contributes?.customEditors ?? []).some(e => e.viewType === 'dataFileViewer.pdf'), 'VSIX declares no dataFileViewer.pdf editor');
  const extId = `${manifest.publisher}.${manifest.name}`;
  const root = await fs.mkdtemp('/tmp/dfvt-');
  const user = path.join(root, 'user'), exts = path.join(root, 'extensions'), ws = path.join(root, 'ws');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(ws);
  const files = n => path.join(ws, n);
  for (const n of ['a.pdf', 'b.pdf']) samplePdf(files(n), opt('--pdf'));
  const baseline = { 'a.pdf': await sha(files('a.pdf')), 'b.pdf': await sha(files('b.pdf')) };
  await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false,
    'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'window.confirmBeforeClose': 'never',
    'files.hotExit': 'off', 'workbench.editorAssociations': { '*.pdf': 'dataFileViewer.pdf' },
  }));
  const profileArgs = ['--user-data-dir', user, '--extensions-dir', exts];
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child, browser;
  const stop = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { execFileSync('pkill', ['-9', '-f', root]); } catch {} };
  const deadline = setTimeout(() => { stop(); console.error('Exceeded its deadline.'); process.exit(1); }, timeout * 6 + 60000);
  try {
    execFileSync(codeCli(), [...profileArgs, '--install-extension', vsix, '--force'], { stdio: 'pipe', timeout: 60000 });
    const listed = execFileSync(codeCli(), [...profileArgs, '--list-extensions', '--show-versions']).toString();
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
    const openPdf = async (n) => {
      const known = new Set(frames().map(f => f.url()));
      execFileSync(codeCli(), [...profileArgs, '-r', files(n)], { stdio: 'pipe', timeout: 30000 });
      await waitFor(`${n} tab`, async () => tab(n).count());
      const f = await pdfFrame(`${n} frame`, known);
      await waitFor(`${n} page image`, async () => f.evaluate(() => { const i = document.querySelector('#pages .page img'); return i?.complete && i.naturalWidth; }));
      return f;
    };
    const imageSize = f => f.evaluate(() => { const i = document.querySelector('#pages .page img'); return i?.complete && i.naturalWidth ? { w: i.naturalWidth, h: i.naturalHeight } : null; });
    const rotate = async (f) => {
      const before = await imageSize(f);
      await f.locator('[data-workspace-tab="organize"]').click();
      if (!await f.locator('#rail .thumb').first().isVisible()) await f.locator('#rail-toggle').click();
      await f.locator('#rail .thumb').first().click();
      await waitFor('rotate enabled', async () => !(await f.locator('#rot-r').isDisabled()));
      await f.locator('#rot-r').click();
      await waitFor('rotated image', async () => { const p = await imageSize(f); return p && (p.w > p.h) !== (before.w > before.h); });
    };
    // VS Code save dialog (files.simpleDialog): type the destination, Enter; a second Enter/overwrite prompt is not expected for new names.
    const answerDialog = async (dest) => {
      const box = page().locator('.quick-input-widget input.input').first();
      await waitFor('save dialog (quick input)', async () => (await box.count()) && await box.isVisible());
      await box.fill(dest); await page().keyboard.press('Enter');
    };
    const dialog = () => page().locator('.monaco-dialog-box');
    const clickEditorArea = async (f) => { await f.locator('#pages').click({ position: { x: 5, y: 5 }, force: true }).catch(() => {}); };
    // Webview keybindings are forwarded to the workbench; focus the document first.
    const key = async (f, combo) => { await clickEditorArea(f); await page().keyboard.press(combo); };
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

    // ---------- A: save / save as / close-while-dirty ----------
    const savedA = files('a_saved.pdf'), savedAs = files('a_saveas.pdf');
    let fa;
    if (!['B'].includes(opt('--only'))) try {
      await step('A1 open a.pdf, rotate, tab becomes dirty', async () => {
        fa = await openPdf('a.pdf');
        assert.equal(await isDirty('a.pdf'), false, 'tab dirty before any edit');
        await rotate(fa);
        await waitFor('dirty tab', async () => isDirty('a.pdf'));
        return 'tab dirty after rotate';
      });
      await step('A2 Ctrl+S -> save dialog -> file written', async () => {
        await key(fa, `${mod}+s`);
        await answerDialog(savedA);
        await waitFor('saved file', async () => (await fs.stat(savedA).catch(() => null))?.size > 0);
      });
      await step('A3 PyMuPDF: /Rotate +90, text kept, original unchanged', async () => {
        const [o, s] = [readPdf(files('a.pdf')), readPdf(savedA)];
        assert.equal(await sha(files('a.pdf')), baseline['a.pdf'], 'original sha256 changed');
        assert.equal(s.rotations[0], (o.rotations[0] + 90) % 360, `rotation ${o.rotations} -> ${s.rotations}`);
        assert.equal(s.text, o.text, 'text changed');
        return `rotation ${o.rotations} -> ${s.rotations}; sha256 ${baseline['a.pdf'].slice(0, 12)} unchanged`;
      });
      // Soft: the copy is already on disk, so the remaining steps still say something even if VS Code reports the save as failed.
      await step('A3b tab clean and no "Failed to save" notification after Ctrl+S', async () => {
        await waitFor('tab clean', async () => !(await isDirty('a.pdf')), 15000).catch(async () => {
          throw new Error(`tab still dirty; notification: ${(await page().locator('.notifications-toasts .notification-list-item-message').allInnerTexts()).join(' | ') || '(none)'}`);
        });
      }, true);
      await step('A4 rotate again, Save As -> second copy', async () => {
        await rotate(fa);
        await waitFor('dirty tab', async () => isDirty('a.pdf'));
        await key(fa, `${mod}+Shift+s`);
        await answerDialog(savedAs);
        await waitFor('save-as file', async () => (await fs.stat(savedAs).catch(() => null))?.size > 0);
        const [o, s] = [readPdf(files('a.pdf')), readPdf(savedAs)];
        assert.equal(await sha(files('a.pdf')), baseline['a.pdf'], 'original sha256 changed');
        // The second rotate is on top of the first (session state), so the copy is at least +90 from the original.
        assert.notEqual(s.rotations[0], o.rotations[0], 'save-as copy not rotated');
        assert.equal(s.text, o.text, 'text changed');
        return `rotation ${o.rotations} -> ${s.rotations}; original unchanged`;
      });
      await step('A5 tab clean after Save As', async () => {
        // Save As may retarget the editor to the new file; either tab being clean and none dirty is the contract.
        await sleep(1000);
        const dirty = await page().locator('.tab.dirty').count();
        assert.equal(dirty, 0, `${dirty} dirty tab(s) remain; notification: ${(await page().locator('.notifications-toasts .notification-list-item-message').allInnerTexts()).join(' | ') || '(none)'}`);
        return `tabs: ${(await page().locator('.tab').evaluateAll(t => t.map(x => x.getAttribute('aria-label')))).join(' | ')}`;
      }, true);
    } catch (e) { if (!e.reported) report('A', 'FAIL', String(e?.message ?? e).split('\n')[0]); }

    // Close-while-dirty on a fresh, never-saved document so no earlier Save As retargeting is involved.
    if (!opt('--only')) try {
      let fc;
      await step('A6 open b.pdf, rotate, tab dirty', async () => {
        fc = await openPdf('b.pdf');
        await rotate(fc);
        await waitFor('dirty tab', async () => isDirty('b.pdf'));
      });
      await step('A7 close dirty tab -> "Do you want to save" dialog', async () => {
        await key(fc, `${mod}+w`);
        await waitFor('save prompt', async () => dialog().first().isVisible());
        const text = (await dialog().first().innerText()).replace(/\s+/g, ' ');
        assert.match(text, /save the changes/i, `unexpected dialog: ${text}`);
        assert.match(text, /b\.pdf/, `dialog does not name b.pdf: ${text}`);
        return text.slice(0, 110);
      });
      await step('A8 Cancel keeps the tab open and dirty', async () => {
        await dialog().first().getByText('Cancel', { exact: true }).click();
        await waitFor('dialog gone', async () => !(await dialog().count()));
        assert.ok(await tab('b.pdf').count(), 'tab closed after Cancel');
        assert.equal(await isDirty('b.pdf'), true, 'tab not dirty after Cancel');
        assert.equal(await sha(files('b.pdf')), baseline['b.pdf'], 'original changed');
        return 'tab open + dirty, file untouched';
      });
      await step("A9 close again -> Don't Save closes tab, original unchanged", async () => {
        await key(fc, `${mod}+w`);
        await waitFor('save prompt', async () => dialog().first().isVisible());
        await dialog().first().getByText(/Don.t Save/).click();
        await waitFor('tab closed', async () => !(await tab('b.pdf').count()));
        assert.equal(await sha(files('b.pdf')), baseline['b.pdf'], 'original changed');
      });
    } catch (e) { if (!e.reported) report('A-close', 'FAIL', String(e?.message ?? e).split('\n')[0]); }

    // ---------- B: text edit ----------
    if (!['A'].includes(opt('--only'))) try {
      const OLD = 'Original paragraph with source words.', NEW = 'Changed paragraph with source words.' // similar width: no width shift allowed;
      const out = files('b_edited.pdf'), edited = files('c.pdf');
      await fs.copyFile(files('b.pdf'), edited); // fresh path: b.pdf's earlier editor/session is gone
      const shaC = await sha(edited);
      let fb, originalParagraph;
      await step('B1 open PDF, Edit workspace, #text-toggle shows run boxes', async () => {
        fb = await openPdf('c.pdf');
        await fb.locator('[data-workspace-tab="edit"]').click();
        await fb.locator('#text-toggle').click();
        await waitFor('edit mode on', async () => (await fb.locator('#text-toggle').getAttribute('aria-pressed')) === 'true');
        const n = await waitFor('run boxes', async () => { const c = await fb.locator('.tspan').count(); return c || undefined; });
        return `${n} run box(es)`;
      });
      await step('B2 click the first run -> text editor opens with that paragraph', async () => {
        await fb.locator(`.tspan[title^="${OLD}"]`).first().click();
        await waitFor('editor', async () => fb.locator('#editor').count(), 15000).catch(async e => { throw new Error(`${e.message}; toast: ${(await fb.locator('#toast').innerText().catch(() => '')).trim() || '(none)'}`); });
        const inPlace = await fb.locator('#editor .iptext').count();
        assert.ok(inPlace, 'the qualified paragraph must open its on-page editor');
        const text = originalParagraph = await fb.locator('#editor .iptext').innerText();
        assert.ok(text.includes(OLD), `paragraph text: ${text}`);
        return `in-place editor, paragraph ${JSON.stringify(text)}`;
      });
      await step('B3 change the on-page source while retaining the rest of the paragraph', async () => {
        const expected = originalParagraph.replace(OLD, NEW);
        await fb.locator('#editor .iptext').fill(expected);
        await waitFor('current preparation or refusal', async () => fb.evaluate(expected => S.draft?.gen > 0 && S.draft.text() === expected && (S.draft.refusal || (S.draft.token && S.draft.readyGen === S.draft.gen)), expected));
        if (await fb.evaluate(() => S.draft?.refusal?.code === 'growth_needs_permission')) await fb.locator('#ipgrowbox').check();
        await waitFor('Apply ready', async () => !(await fb.locator('#ipsave').isDisabled()));
        await fb.locator('#ipsave').click();
        await waitFor('editor closed', async () => !(await fb.locator('#editor').count()));
        assert.equal(await fb.evaluate(() => S.revision), 1, 'Apply must publish the changed paragraph');
        return 'prepared source applied once';
      });
      await step('B4 text edit marks the VS Code tab dirty', async () => {
        await waitFor('dirty tab', async () => isDirty('c.pdf'));
      });
      await step('B5 Export', async () => {
        await fb.locator('#export').click();
        await answerDialog(out);
        await waitFor('exported file', async () => (await fs.stat(out).catch(() => null))?.size > 0);
        await sleep(1000);
      });
      await step('B6 PyMuPDF: changed paragraph words, untouched footer/geometry and original', async () => {
        const [o, e] = [readPdf(edited), readPdf(out)];
        assert.equal(await sha(edited), shaC, 'original sha256 changed');
        const visible = e.text.replace(/\s+/g, ' ');
        assert.ok(visible.includes(NEW), `new text missing; got ${JSON.stringify(e.text)}`);
        assert.ok(!visible.includes(OLD), 'old text still present');
        const rest = 'More source words follow here.';
        assert.ok(e.text.replace(/\s+/g, ' ').includes(rest), 'remaining paragraph words changed');
        const footer = 'Unrelated footer stays unchanged.';
        const [fo, fe] = [o.lines.find(l => l[2] === footer), e.lines.find(l => l[2] === footer)];
        assert.ok(fo && fe, `footer missing: ${JSON.stringify(e.lines)}`);
        assert.deepEqual(fe, fo, 'footer moved or changed');
        assert.deepEqual(e.rect, o.rect, 'page size changed'); assert.equal(e.pages, o.pages, 'page count changed');
        return `lines now ${JSON.stringify(e.lines.map(l => l[2]))}`;
      });
    } catch (e) { if (!e.reported) report('B', 'FAIL', String(e?.message ?? e).split('\n')[0]); }
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
