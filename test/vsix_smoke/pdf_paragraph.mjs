#!/usr/bin/env node
// VSIX gate for multi-line paragraph editing: open a two-line own-font paragraph, retype it so it wraps onto more lines,
// Export, and read the copy back with PyMuPDF.
//
// Usage (repo root):  node test/vsix_smoke/pdf_paragraph.mjs <path-to.vsix> [--pdf file.pdf] [--keep] [--shots <dir>]
// Env: DFV_VSCODE_EXECUTABLE, DFV_CODE_CLI (default `code`), DFV_SMOKE_TIMEOUT_MS (default 90000),
//      DFV_PYTHON (python with PyMuPDF; default the `myproject` conda env).
//
// Disposable --user-data-dir/--extensions-dir (the real VS Code profile is never touched).
// Default fixture: the d4-11 unicode.pdf (two DejaVuSans lines "Own font ..." / "This source face stays exact." + a Helvetica footer).
//
// The qualified own-font profile must open the IN-PLACE editor (`#editor .iptext`).
// A missing paragraph box must fail this gate instead of silently testing the fallback panel.
// A refusal by the engine (toast with the reason, no edit applied) is reported as FAIL with the engine's message, not hidden.
//
// P1 open, Edit workspace, run boxes   P2 click first run -> editor kind   P3 retype paragraph so it wraps and apply
// P4 tab dirty   P5 Export   P6 PyMuPDF: new words in order, old second line gone, still DejaVuSans, more lines,
//    footer + page size unchanged, original sha256 unchanged.
// Exit code: 0 all steps pass, 1 any failure.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { codeCli, samplePdf, vscodeExecutable, vsixManifest } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const vsix = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pdf' && args[i - 1] !== '--shots') ?? '');
const timeout = +(process.env.DFV_SMOKE_TIMEOUT_MS || 90000);
const FIXTURE = fileURLToPath(new URL('./fixtures/unicode.pdf', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = async f => createHash('sha256').update(await fs.readFile(f)).digest('hex');
const results = [];
const report = (name, status, note = '') => { results.push({ name, status }); console.log(`${status.padEnd(4)} ${name}${note ? ' - ' + note : ''}`); };
let shoot = async () => {};
const step = async (name, fn) => { try { report(name, 'PASS', await fn() ?? ''); } catch (e) { report(name, 'FAIL', String(e?.message ?? e).split('\n')[0]); await shoot(name).catch(() => {}); throw Object.assign(e, { reported: true }); } };

const READER = `import sys,json,pymupdf
d=pymupdf.open(sys.argv[1]);p=d[0]
print(json.dumps({"pages":len(d),"rect":list(p.rect),"text":"".join(q.get_text() for q in d),
 "lines":[[round(l["bbox"][0],1),round(l["bbox"][1],1),"".join(s["text"] for s in l["spans"]),l["spans"][0]["font"]] for b in p.get_text("dict")["blocks"] for l in b.get("lines",[])]}))`;
const python = process.env.DFV_PYTHON || '/Users/macc/miniforge3/envs/myproject/bin/python3';
const readPdf = f => JSON.parse(execFileSync(python, ['-I', '-c', READER, f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());

const OLD2 = 'This source face stays exact.', FOOTER = 'Unrelated footer stays unchanged.';
const NEW = 'Own font İstanbul sigma σ café paragraph now carries a noticeably longer sentence that has to wrap onto several more lines than before.';

async function main() {
  const manifest = vsixManifest(vsix);
  assert.ok((manifest.contributes?.customEditors ?? []).some(e => e.viewType === 'dataFileViewer.pdf'), 'VSIX declares no dataFileViewer.pdf editor');
  const extId = `${manifest.publisher}.${manifest.name}`;
  const root = await fs.mkdtemp('/tmp/dfvpara-');
  const user = path.join(root, 'user'), exts = path.join(root, 'extensions'), ws = path.join(root, 'ws');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(ws);
  const src = path.join(ws, 'para.pdf'), out = path.join(ws, 'para_edited.pdf');
  samplePdf(src, opt('--pdf') ?? FIXTURE);
  const baseline = await sha(src), before = readPdf(src);
  assert.ok(before.lines.some(l => l[2] === OLD2), `fixture lacks the line ${JSON.stringify(OLD2)}; pass --pdf with a compatible fixture`);
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
    const waitFor = async (what, fn, ms = timeout) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn().catch(() => undefined); if (v) return v; await sleep(250); } throw new Error(`timed out: ${what}`); };
    await waitFor('workbench', async () => page()?.locator('.monaco-workbench').count());
    await sleep(2000);
    shoot = async n => { if (opt('--shots')) { await fs.mkdir(opt('--shots'), { recursive: true }); await page().screenshot({ path: path.join(opt('--shots'), n.split(' ')[0] + '.png') }); } };
    const tab = n => page().locator(`.tab[aria-label*="${n}"]`);
    const isDirty = async n => (await tab(n).first().getAttribute('class').catch(() => '') ?? '').split(/\s+/).includes('dirty');
    const toast = f => f.locator('#toast').innerText().catch(() => '').then(t => t.trim());

    let f;
    await step('P1 open PDF, Edit workspace, #text-toggle shows run boxes', async () => {
      execFileSync(codeCli(), [...profileArgs, '-r', src], { stdio: 'pipe', timeout: 30000 });
      await waitFor('tab', async () => tab('para.pdf').count());
      f = await waitFor('pdf frame', async () => {
        for (const fr of page().frames()) if (fr.url().includes('vscode-webview') && await fr.locator('#export').count() && await fr.locator('#pages').count()) return fr;
      });
      await waitFor('page image', async () => f.evaluate(() => { const i = document.querySelector('#pages .page img'); return i?.complete && i.naturalWidth; }));
      await f.locator('[data-workspace-tab="edit"]').click();
      await waitFor('edit mode on', async () => (await f.locator('#text-toggle').getAttribute('aria-pressed')) === 'true');
      return `${await waitFor('run boxes', async () => (await f.locator('.tspan').count()) || undefined)} run box(es)`;
    });

    await step('P2 click the first run -> in-place editor opens', async () => {
      await f.locator('.tspan').first().click();
      await waitFor('editor', async () => f.locator('#editor').count(), 15000).catch(async e => { throw new Error(`${e.message}; toast: ${await toast(f) || '(none)'}`); });
      const kind = (await f.locator('#editor .iptext').count()) ? 'in-place' : 'panel';
      assert.equal(kind, 'in-place', 'the qualified own-font paragraph must expose on-page editing geometry');
      const text = await f.locator('#editor .iptext').innerText();
      assert.ok(text.includes('Own font') && text.includes(OLD2), `paragraph text: ${JSON.stringify(text)}`);
      const family = await waitFor('document font loads inside the packaged webview', async () => f.evaluate(async () => {
        const area = document.querySelector('#editor .iptext');
        const family = area && getComputedStyle(area).fontFamily.split(',')[0].trim().replaceAll('"', '');
        if (!family?.startsWith('pdffont-')) return;
        const faces = [...document.fonts].filter(face => face.family.replaceAll('"', '') === family);
        if (!faces.length) return;
        await document.fonts.load(`14px "${family}"`, 'İstanbul σ café');
        if (faces.every(face => face.status === 'loaded')) return family;
      }), 15000);
      return `${kind} editor, loaded document font ${family}, ${text.split('\n').length}-line paragraph ${JSON.stringify(text)}`;
    });

    await step('P3 retype the paragraph so it wraps onto more lines, apply', async () => {
      await f.evaluate(() => {
        window.__pdfEditClicks = []; window.__pdfEditRefusals = [];
        document.addEventListener('click', event => window.__pdfEditClicks.push(event.target.closest?.('button')?.id || event.target.id || event.target.tagName), true);
        window.addEventListener('message', ({data}) => { if (data?.type === 'res' && data.error) window.__pdfEditRefusals.push(data.error); });
      });
      await waitFor('initial prepared text preview', async () => f.evaluate(() => S.draft?.token && S.draft.readyGen === S.draft.gen && !S.draft.refusal), 15000);
      const area = f.locator('#editor .iptext');
      await area.fill(NEW);
      await waitFor('typed source reaches its draft generation', async () => f.evaluate(expected => S.draft?.gen > 0 && S.draft.text() === expected, NEW), 15000);
      await waitFor('new preview or explicit refusal', async () => f.evaluate(() => S.draft?.refusal || (S.draft?.token && S.draft.readyGen === S.draft.gen)), 15000);
      if (await f.evaluate(() => S.draft?.refusal?.code === 'growth_needs_permission')) {
        assert(await f.locator('#ipsave').isDisabled(), 'Growth cannot be accepted silently');
        assert.notEqual(await f.locator('.ippreview').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'The original paragraph must stay covered while growth is refused');
        await f.locator('#ipgrowbox').check();
      }
      await waitFor('Apply enabled (prepared preview matches the draft)', async () => !(await f.locator('#ipsave').isDisabled()), 20000)
        .catch(async () => { const diagnostics = await f.evaluate(() => ({ draft: typeof S === 'undefined' ? null : S.draft && { mode:S.draft.mode, kind:S.draft.kind, gen:S.draft.gen, ready:S.draft.readyGen, refusal:S.draft.refusal, token:S.draft.token }, clicks:window.__pdfEditClicks, refusals:window.__pdfEditRefusals })); throw new Error(`Apply stayed disabled: ${JSON.stringify(diagnostics)}; status: ${await f.locator('.ipstatus').innerText().catch(() => '')}`); });
      assert.equal(await f.evaluate(() => S.draft.text()), NEW, 'the editable source must be the text typed into this paragraph');
      await shoot('P3-ready');
      await f.locator('#ipsave').click();
      await waitFor('editor closed', async () => !(await f.locator('#editor').count()), 20000);
      const state = await f.evaluate(() => ({ revision:S.revision, undo:UNDO.state, clicks:window.__pdfEditClicks, refusals:window.__pdfEditRefusals }));
      assert.equal(state.revision, 1, 'Apply must publish a real document edit');
      return `in-place Apply; revision ${state.revision}, dirty ${state.undo?.dirty}`;
    });

    await step('P4 paragraph edit marks the VS Code tab dirty', async () => { await waitFor('dirty tab', async () => isDirty('para.pdf')); });

    await step('P5 Export to a copy', async () => {
      await f.locator('#export').click();
      const box = page().locator('.quick-input-widget input.input').first();
      await waitFor('save dialog', async () => (await box.count()) && await box.isVisible());
      await box.fill(out); await page().keyboard.press('Enter');
      await waitFor('exported file', async () => (await fs.stat(out).catch(() => null))?.size > 0);
      await sleep(1000);
    });

    await step('P6 PyMuPDF: wrapped text kept in order, old line gone, own font kept, footer/geometry/original unchanged', async () => {
      const e = readPdf(out);
      assert.equal(await sha(src), baseline, 'original sha256 changed');
      const flat = s => s.replace(/\s+/g, ' ').trim();
      const body = e.lines.filter(l => l[2] !== FOOTER);
      assert.equal(flat(body.map(l => l[2]).join(' ')), NEW, `paragraph text differs: ${JSON.stringify(body.map(l => l[2]))}`);
      assert.ok(!e.text.includes(OLD2), 'old second line still present');
      assert.ok(body.length > before.lines.length - 1, `expected more lines than the ${before.lines.length - 1} source lines, got ${body.length}`);
      assert.ok(body.every(l => /DejaVu/.test(l[3])), `font changed: ${JSON.stringify(body.map(l => l[3]))}`);
      const [fo, fe] = [before.lines.find(l => l[2] === FOOTER), e.lines.find(l => l[2] === FOOTER)];
      assert.ok(fo && fe, 'footer missing');
      assert.deepEqual(fe, fo, 'footer moved or changed');
      assert.deepEqual(e.rect, before.rect, 'page size changed'); assert.equal(e.pages, before.pages, 'page count changed');
      return `in-place editor; ${body.length} lines now: ${JSON.stringify(body.map(l => l[2]))}`;
    });
    for (const separate of [false, true]) {
      const markerName = separate ? 'marker_separate.pdf' : 'markers.pdf';
      const expectedText = separate ? 'Separately positioned body.' : 'Numbered source item.';
      const markerSource = path.join(ws, markerName), markerOut = path.join(ws, markerName.replace('.pdf', '_edited.pdf'));
      samplePdf(markerSource, fileURLToPath(new URL('./fixtures/' + markerName, import.meta.url)));
      const markerHash = await sha(markerSource), markerBefore = readPdf(markerSource);
      await step(`P7 open ${separate ? 'separate' : 'inline'} list editing in the packaged viewer`, async () => {
        execFileSync(codeCli(), [...profileArgs, '-r', markerSource], { stdio: 'pipe', timeout: 30000 });
        await waitFor('marker tab', async () => tab(markerName).count());
        f = await waitFor('marker document frame', async () => {
          for (const fr of page().frames()) if (fr.url().includes('vscode-webview') && await fr.evaluate(name => typeof S !== 'undefined' && S.doc?.name === name, markerName).catch(() => false)) return fr;
        });
        await f.locator('[data-workspace-tab="edit"]').click();
        if ((await f.locator('#text-toggle').getAttribute('aria-pressed')) !== 'true') await f.locator('#text-toggle').click();
        await waitFor('marker text boxes', async () => f.locator('.tspan').count());
        await f.locator('.tspan').nth(separate ? 1 : 0).click();
        await waitFor('marker action and on-page editor', async () => (await f.locator('#edemark').count()) && (await f.locator('#editor .iptext').count()));
      });
      await step('P8 remove marker preserves a dirty draft and applies only after reverting it', async () => {
        const area = f.locator('#editor .iptext'), original = await area.innerText();
        await area.fill('Typed source must remain'); await f.locator('#edemark').click();
        await waitFor('draft preservation notice', async () => /Apply or discard your text changes/.test(await toast(f)));
        assert.equal(await area.innerText(), 'Typed source must remain');
        assert.equal(await f.evaluate(() => api('get_state', {}).then(s => s.revision)), 0);
        await area.fill(original); await f.locator('#edemark').click();
        await waitFor('marker removed and editor closed', async () => !(await f.locator('#editor').count()) && await f.evaluate(() => S.revision === 1));
        const text = await f.evaluate(() => api('get_page_text', { page: 0 }));
        assert.equal(text.spans[0].text, expectedText); assert.equal(await sha(markerSource), markerHash);
      });
      await step('P9 marker export preserves other rows, font, geometry and original bytes', async () => {
        await f.locator('#export').click();
        const box = page().locator('.quick-input-widget input.input').first();
        await waitFor('marker save dialog', async () => (await box.count()) && await box.isVisible());
        await box.fill(markerOut); await page().keyboard.press('Enter');
        await waitFor('marker copy', async () => (await fs.stat(markerOut).catch(() => null))?.size > 0);
        const after = readPdf(markerOut);assert.equal(after.lines[0][2], expectedText);
        if (separate) assert.deepEqual(after.lines, markerBefore.lines.slice(1));
        else { assert.deepEqual(after.lines.slice(1), markerBefore.lines.slice(1)); assert.equal(after.lines[0][3], markerBefore.lines[0][3]); }
        assert.deepEqual(after.rect, markerBefore.rect); assert.equal(after.pages, markerBefore.pages); assert.equal(await sha(markerSource), markerHash);
      });
    }
  } catch (e) {
    if (!e.reported && !results.some(r => r.status === 'FAIL')) report('gate', 'FAIL', String(e?.message ?? e).split('\n')[0]);
  } finally {
    stop(); await browser?.close().catch(() => {});
    if (args.includes('--keep')) console.log(`kept ${root}`); else await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
}
main();
