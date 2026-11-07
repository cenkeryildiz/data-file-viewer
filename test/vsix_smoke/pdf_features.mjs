#!/usr/bin/env node
// PDF feature smoke: drives the PDF editor's webview DOM inside a disposable VS Code profile.
//
// Usage (repo root):  node test/vsix_smoke/pdf_features.mjs [path-to.vsix] [--keep] [--shots <dir>]
// Default VSIX: ./data-file-viewer-<package.json version>.vsix (read only, never overwritten).
// Env: DFV_VSCODE_EXECUTABLE, DFV_CODE_CLI, DFV_SMOKE_TIMEOUT_MS (per wait, default 60000), as in run.mjs.
//
// Opens a generated 4-page PDF (page N holds one unique word) and exercises, via the DOM selectors of
// media/pdf/web/static/index.html: page navigation, zoom, search, highlight + comment, page reorder,
// page delete, Undo/Redo. Prints PASS/FAIL per feature with evidence; exit 1 if any FAIL.
// Not automated: visual correctness of rendered pixels, Save As (native dialog), restart recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { codeCli, vscodeExecutable, vsixManifest } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const version = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version;
const vsix = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--shots') ?? path.join(repo, `data-file-viewer-${version}.vsix`));
const timeout = +(process.env.DFV_SMOKE_TIMEOUT_MS || 60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const WORDS = ['Alphaone', 'Betatwo', 'Zebraquartz', 'Deltafour']; // page N (1-based) carries WORDS[N-1]
const PW = 612, PH = 792;

/** 4-page text PDF: page N has "<word> sample text" in 28pt Helvetica at x=72, baseline y=700. */
function makePdf() {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', `<</Type/Pages/Kids[${WORDS.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}]/Count ${WORDS.length}>>`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>', null];
  objs[3] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>';
  WORDS.forEach((w, i) => {
    const s = `BT /F1 28 Tf 72 700 Td (${w} sample text) Tj ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PW} ${PH}]/Contents ${6 + 2 * i} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`);
    objs.push(`<</Length ${s.length}>>\nstream\n${s}\nendstream`);
  });
  let body = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function main() {
  const manifest = vsixManifest(vsix);
  const extId = `${manifest.publisher}.${manifest.name}`;
  const root = await fs.mkdtemp('/tmp/dfvp-');
  const shots = opt('--shots') ? path.resolve(opt('--shots')) : '/tmp/dfvp-shots'; // outside the profile dir, which is deleted at the end
  await fs.mkdir(shots, { recursive: true });
  const user = path.join(root, 'user'), exts = path.join(root, 'extensions'), ws = path.join(root, 'ws');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(ws);
  const pdf = path.join(ws, 'features.pdf');
  const pdfBytes = makePdf(); await fs.writeFile(pdf, pdfBytes);
  await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false,
    'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'workbench.editorAssociations': { '*.pdf': 'dataFileViewer.pdf' },
    'window.dialogStyle': 'custom', // modal prompts become workbench DOM the harness can click (native macOS dialogs cannot be driven)
  }));
  const profileArgs = ['--user-data-dir', user, '--extensions-dir', exts];
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child, browser; const consoleLog = [];
  const stop = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const deadline = setTimeout(() => { stop(); console.error('pdf_features exceeded its deadline.'); process.exit(1); }, 15 * 60000);
  try {
    execFileSync(codeCli(), [...profileArgs, '--install-extension', vsix, '--force'], { stdio: 'pipe', timeout: 90000 });
    console.log(`profile ${root}\nvsix ${path.basename(vsix)} (${extId}@${manifest.version})`);
    const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    child = spawn(vscodeExecutable(), [...profileArgs, `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-workspace-trust',
      '--disable-extension', 'GitHub.copilot-chat', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', ws],
    { env, detached: true, stdio: 'ignore' });
    for (let i = 0; i < 120 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); } catch { await sleep(250); } }
    assert.ok(browser, 'VS Code debugging endpoint');
    const page = () => browser.contexts()[0]?.pages().at(-1);
    const waitFor = async (what, fn, ms = timeout) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn().catch(() => undefined); if (v) return v; await sleep(200); } throw new Error(`timed out: ${what}`); };
    await waitFor('workbench', async () => page()?.locator('.monaco-workbench').count());
    page().on('console', m => { if (/confirm|sandbox|modal|Error/i.test(m.text())) consoleLog.push(m.text().slice(0, 300)); });
    page().on('dialog', d => { consoleLog.push(`native dialog ${d.type()}: ${d.message().slice(0, 120)}`); d.accept().catch(() => {}); });
    await sleep(2000);
    execFileSync(codeCli(), [...profileArgs, '-r', pdf], { stdio: 'pipe', timeout: 30000 });
    const F = await waitFor('PDF webview (#toolbar + #undo)', async () => {
      for (const f of page().frames().filter(f => f.url().includes('vscode-webview'))) if (await f.locator('#undo').count() && await f.locator('#toolbar').count()) return f;
    });
    const $ = s => F.locator(s);
    const text = async s => (await $(s).first().textContent().catch(() => '')) ?? '';
    const val = async s => $(s).first().inputValue();
    const snap = () => F.evaluate(() => {
      const g = id => document.getElementById(id);
      const st = g('stage').getBoundingClientRect();
      const pages = [...document.querySelectorAll('#pages .page')];
      const top = pages.map(p => ({ id: p.id, d: Math.abs(p.getBoundingClientRect().top - st.top) })).sort((a, b) => a.d - b.d)[0];
      return { pages: pages.length, thumbs: document.querySelectorAll('#rail .thumb').length, pageNo: g('page-number')?.value, count: g('page-count')?.textContent,
        zoom: g('zoomlbl').value, topPage: top?.id, page0w: pages[0]?.style.width, edits: g('editinfo').textContent, undo: !g('undo').disabled, redo: !g('redo').disabled,
        undoTitle: g('undo').title, notes: document.querySelectorAll('#notes .note').length, toast: g('toast').textContent, build: g('build').textContent };
    });
    const shot = async name => { const p = path.join(shots, `${name}.png`); await page().screenshot({ path: p }).catch(() => {}); return p; };
    // Each feature starts from a clean surface: a failed step must not leave a modal dialog or panel over the next one.
    const reset = () => F.evaluate(() => {
      document.querySelectorAll('dialog[open]').forEach(d => d.close());
      const n = document.getElementById('notes-toggle'); if (n.getAttribute('aria-expanded') === 'true') n.click();
    }).catch(() => {});
    const run = async (name, fn) => {
      await reset();
      try { const note = await fn(); results.push({ name, status: 'PASS' }); console.log(`PASS ${name}${note ? ' - ' + note : ''}`); }
      catch (e) {
        const s = { ...(await snap().catch(() => ({}))), apiErrs: await apiErrs(), worker: workerAlive() };
        results.push({ name, status: e.notAutomatable ? 'N/A' : 'FAIL' });
        console.log(`${e.notAutomatable ? 'N/A ' : 'FAIL'} ${name} - ${String(e.message).split('\n')[0]}\n     state ${JSON.stringify(s)}\n     screenshot ${await shot(name.replace(/\W+/g, '_'))}`);
      }
    };
    const until = (what, fn, ms) => waitFor(what, async () => (await fn()) || undefined, ms);
    const tab = name => $(`[data-workspace-tab="${name}"]`).click();
    const openFinder = async () => { if (!(await F.evaluate(() => document.getElementById('document-finder').open))) await $('#find-toggle').click(); };
    const closeFinder = async () => { if (await F.evaluate(() => document.getElementById('document-finder').open)) await $('#document-finder form button').click(); };
    /** Search `word`; returns the pages (1-based) of the result rows once the status settles on this word. */
    const search = async word => {
      await openFinder(); await $('#find-query').fill(''); await $('#find-query').fill(word); await $('#find-start').click();
      return until(`search results for ${word}`, () => F.evaluate(w => {
        if (!/searched \d+ of \d+|no match|0 match/i.test(document.getElementById('find-status').textContent)) return null;
        const rows = [...document.querySelectorAll('#search-results button')];
        if (rows.some(r => !r.textContent.toLowerCase().includes(w.toLowerCase()))) return null; // stale rows of the previous word
        return { pages: rows.map(r => +r.querySelector('.search-where').textContent.match(/Page (\d+)/)[1]) };
      }, word)).then(r => r.pages);
    };
    // The page-thumbnail rail is a drawer in a narrow editor; open it when hidden. Tools that did not fit live under More.
    const thumb = async i => { if (!(await $('#rail .thumb').first().isVisible())) await $('#rail-toggle').click(); await $(`#rail .thumb[data-page="${i}"]`).click(); if (await $('#sidebar-close').isVisible()) await $('#sidebar-close').click(); };
    // run() closes the Comments panel between features, and a closed panel is redrawn from list_annotations only when it is next opened.
    const openNotes = async () => { if (await F.evaluate(() => document.getElementById('notes').classList.contains('hidden'))) await $('#notes-toggle').click(); await until('comments panel', () => F.evaluate(() => !document.getElementById('notes').classList.contains('hidden'))); };
    const clickTool = async id => { if (!(await $(id).isVisible())) { await $('#tools-more').click(); } await $(id).click(); };
    /** Double-click the word at (xpt,yFromTop) of 0-based page `i`, scrolled into view first. */
    const dblWord = async (i, xpt, ypt) => {
      await closeFinder(); // the finder floats over the page
      await $(`#page-${i}`).scrollIntoViewIfNeeded();
      await until('page image mounted', () => F.evaluate(n => !!document.querySelector(`#page-${n} img, #page-${n} canvas`), i));
      const b = await $(`#page-${i}`).boundingBox();
      await page().mouse.dblclick(b.x + xpt * b.width / PW, b.y + ypt * b.height / PH);
    };

    // Diagnostics only: record every failed viewer request (op + error shape) so a "connection lost" toast has a cause.
    await F.evaluate(() => {
      window.__apiErrs = []; const orig = api;
      api = async function (op, params, opts) {
        try { return await orig.call(this, op, params, opts); }
        catch (e) { window.__apiErrs.push({ op, name: e?.name, code: e?.code, engineCode: e?.engineCode, status: e?.status, msg: String(e?.message).slice(0, 60), cause: e?.cause && { name: e.cause.name, code: e.cause.code, engine: e.cause.engineCode, msg: String(e.cause.message).slice(0, 300) } }); throw e; }
      };
    });
    const apiErrs = () => F.evaluate(() => window.__apiErrs).catch(() => ['frame gone']);
    const workerAlive = () => { try { return execFileSync('pgrep', ['-fl', 'dfv-pdf'], { stdio: 'pipe' }).toString().trim().split('\n').length + ' dfv-pdf process(es)'; } catch { return 'no dfv-pdf process'; } };
    // ---- load ----
    await until('4 pages loaded', async () => (await snap()).pages === 4 && /4/.test((await snap()).count ?? ''));
    await until('page 1 image', () => F.evaluate(() => !!document.querySelector('#page-0 img, #page-0 canvas')));
    console.log(`loaded ${JSON.stringify(await snap())}`);

    await run('page navigation', async () => {
      await $('#next-page').click(); await until('next -> 2', async () => (await val('#page-number')) === '2');
      await until('page 2 at top', async () => (await snap()).topPage === 'page-1');
      await $('#page-number').fill('4'); await $('#page-number').press('Enter');
      await until('typed 4', async () => (await snap()).topPage === 'page-3' && (await val('#page-number')) === '4');
      assert.equal(await $('#next-page').isDisabled(), true, 'Next disabled on last page');
      await $('#previous-page').click(); await until('prev -> 3', async () => (await val('#page-number')) === '3');
      await thumb(0); await until('thumbnail -> 1', async () => (await snap()).topPage === 'page-0' && (await val('#page-number')) === '1');
      await $('#page-number').fill('99'); await $('#page-number').press('Enter');
      await until('invalid page rejected', async () => /from 1 to 4/.test(await text('#navigation-error')));
      await $('#page-number').fill('1'); await $('#page-number').press('Enter');
      return 'next/prev, typed page, thumbnail click, out-of-range message';
    });

    await run('zoom', async () => {
      const w0 = (await snap()).page0w, z0 = await val('#zoomlbl');
      await $('#zoom-in').click(); await until('zoom-in grows', async () => parseFloat((await snap()).page0w) > parseFloat(w0));
      const z1 = await val('#zoomlbl'); assert.ok(parseInt(z1) > parseInt(z0), `label ${z0} -> ${z1}`);
      await $('#zoom-out').click(); await $('#zoom-out').click(); await until('zoom-out shrinks', async () => parseInt(await val('#zoomlbl')) < parseInt(z0));
      await $('#zoomlbl').fill('200'); await $('#zoomlbl').press('Enter');
      await until('200%', async () => (await val('#zoomlbl')) === '200%');
      const w = parseFloat((await snap()).page0w); assert.ok(Math.abs(w - PW / 72 * 96 * 2) < 2, `200% page width ${w}px, expected ${PW / 72 * 96 * 2}`);
      await $('#zoomlbl').fill('5000'); await $('#zoomlbl').press('Enter');
      await until('invalid zoom rejected', async () => /10% to 800%/.test(await text('#navigation-error')));
      await $('#page-fit').selectOption('fit-width'); await until('fit-width', async () => (await F.evaluate(() => document.getElementById('page-fit').value)) === 'fit-width');
      await $('#page-fit').selectOption('fit-page'); await sleep(300);
      return `${z0} -> ${z1}; typed 200% = ${w}px wide; invalid rejected; fit modes`;
    });

    await run('search', async () => {
      const hit = await search(WORDS[2]);
      assert.deepEqual(hit, [3], `"${WORDS[2]}" should be only on page 3, rows say ${JSON.stringify(hit)}`);
      const auto = await val('#page-number'); // observation: a new search does not jump to its first hit until Next or a row is used
      await $('#search-results button').first().click();
      await until('result row navigates to page 3', async () => (await val('#page-number')) === '3');
      await until('match overlay drawn', () => F.evaluate(() => document.querySelectorAll('#page-2 .search-layer polygon').length));
      assert.match(await text('#find-position'), /1 \/ 1/);
      const none = await (async () => { await $('#find-query').fill('qqqnotthere'); await $('#find-start').click(); await sleep(600); return text('#find-status'); })();
      await closeFinder();
      return `found on page 3 (page box showed "${auto}" right after Search; row click navigated; overlay polygon painted); no-match status: "${none.trim()}"`;
    });

    // ---- annotate ----
    await run('highlight annotation', async () => {
      await tab('annotate'); await $('#page-number').fill('1'); await $('#page-number').press('Enter'); await sleep(400);
      await dblWord(0, 72 + 40, PH - 700 - 9); // inside "Alphaone"
      await until('selection enables highlight swatch', async () => !(await $('#markgroup [data-color="0"]').isDisabled()), 15000);
      await $('#markgroup [data-color="0"]').click();
      await until('1 verified edit', async () => /1 verified edit/.test(await text('#editinfo')), 20000);
      await $('#notes-toggle').click(); await until('comments panel', () => F.evaluate(() => !document.getElementById('notes').classList.contains('hidden')));
      await until('highlight listed', async () => (await $('#notes .note').count()) === 1);
      const row = (await $('#notes .note').first().innerText()).replace(/\s+/g, ' ');
      assert.match(row, /Highlight/i, row); assert.match(row, /Alphaone/, `quoted text: ${row}`);
      return `listed: "${row.slice(0, 80)}"`;
    });

    await run('comment annotation', async () => {
      await $('#page-number').fill('2'); await $('#page-number').press('Enter'); await sleep(400);
      await dblWord(1, 72 + 40, PH - 700 - 9); // inside "Betatwo"
      await until('selection popup', async () => !(await F.evaluate(() => document.getElementById('selection-actions').hidden)), 15000);
      await $('#selection-actions [data-selection="note"]').click();
      await until('note dialog', () => F.evaluate(() => document.getElementById('selection-note').open));
      await $('#selection-note-source').fill('smoke comment 42');
      await $('#selection-note-apply').click();
      await until('2 verified edits', async () => /2 verified edits/.test(await text('#editinfo')), 20000);
      await openNotes();
      await until('comment listed', async () => (await $('#notes .note').count()) === 2);
      const body = (await $('#notes').innerText());
      assert.match(body, /smoke comment 42/, body.replace(/\s+/g, ' ').slice(0, 200));
      return 'note dialog -> Apply -> row with body text in Comments panel';
    });

    await run('undo/redo annotations', async () => {
      assert.equal(await $('#undo').isDisabled(), false, 'Undo enabled after edits');
      await openNotes();
      await $('#undo').click(); await until('undo comment', async () => (await $('#notes .note').count()) === 1 && /1 verified edit/.test(await text('#editinfo')));
      await $('#undo').click(); await until('undo highlight', async () => (await $('#notes .note').count()) === 0 && /No edits/.test(await text('#editinfo')));
      assert.equal(await $('#undo').isDisabled(), true, 'Undo disabled at the start of history');
      await $('#redo').click(); await until('redo highlight', async () => (await $('#notes .note').count()) === 1);
      await $('#redo').click(); await until('redo comment', async () => (await $('#notes .note').count()) === 2 && /smoke comment 42/.test(await $('#notes').innerText()));
      assert.equal(await $('#redo').isDisabled(), true, 'Redo disabled at the end');
      return '2 edits undone to "No edits", redone to both annotations';
    });

    // ---- organize ----
    await run('page reorder (+ undo/redo)', async () => {
      await tab('organize');
      assert.deepEqual(await search(WORDS[1]), [2], 'before: Betatwo on page 2'); await closeFinder();
      await thumb(1);
      await clickTool('#move-earlier');
      await until('Betatwo moved to page 1', async () => { const r = await search(WORDS[1]); await closeFinder(); return r[0] === 1; }, 20000);
      assert.deepEqual(await search(WORDS[0]), [2], 'Alphaone now page 2'); await closeFinder();
      await $('#undo').click(); await until('undo reorder', async () => { const r = await search(WORDS[1]); await closeFinder(); return r[0] === 2; }, 20000);
      await $('#redo').click(); await until('redo reorder', async () => { const r = await search(WORDS[1]); await closeFinder(); return r[0] === 1; }, 20000);
      await $('#undo').click(); await until('undo again', async () => { const r = await search(WORDS[1]); await closeFinder(); return r[0] === 2; }, 20000);
      return 'Move earlier swapped pages 1/2 (verified by searching their unique words); undo and redo restored order';
    });

    // The viewer's Delete prompt is a host modal now (the webview sandbox cannot show confirm()): answer it like a user.
    const answerModal = async (button) => {
      const dialog = page().locator('.monaco-dialog-box');
      await until('host modal dialog', async () => (await dialog.count()) > 0, 8000);
      const msg = (await dialog.innerText()).replace(/\s+/g, ' ');
      await dialog.getByRole('button', { name: button }).click();
      return msg;
    };
    const del = async (button = 'Delete') => {
      await tab('organize'); await thumb(3);
      await clickTool('#del');
      await answerModal(button);
      return until('4 -> 3 pages', async () => (await snap()).pages === 3, 8000);
    };
    let deleteWorked = false;
    await run('page delete (+ undo/redo)', async () => {
      // Cancel must keep the page: a prompt that is not answered "yes" never deletes.
      await tab('organize'); await thumb(3); await clickTool('#del');
      const asked = await answerModal('Cancel'); assert.match(asked, /Delete 1 selected page/, asked);
      await sleep(1500); assert.equal((await snap()).pages, 4, 'Cancel kept all 4 pages');
      try { await del(); } catch (e) {
        const c = consoleLog.filter(l => /confirm|modal|dialog/i.test(l));
        throw new Error(`Delete selected pages did nothing: page count stayed 4. Webview console: ${JSON.stringify(c)}`);
      }
      deleteWorked = true;
      await until('thumbs 3', async () => (await snap()).thumbs === 3); assert.match(await text('#page-count'), /3/);
      assert.deepEqual(await search(WORDS[3]), [], 'Deltafour gone'); await closeFinder();
      await $('#undo').click(); await until('undo -> 4 pages', async () => (await snap()).pages === 4 && (await snap()).thumbs === 4, 20000);
      await $('#redo').click(); await until('redo -> 3 pages', async () => (await snap()).pages === 3, 20000);
      await $('#undo').click(); await until('undo -> 4 pages', async () => (await snap()).pages === 4, 20000);
      return 'page 4 deleted, undo restored 4 pages, redo removed again';
    });
    if (!deleteWorked) {
      // Diagnostic only: isolates the confirm() call. A stub in the page stands in for a dialog the sandbox hides.
      await run('page delete with confirm() stubbed (diagnostic)', async () => {
        await F.evaluate(() => { window.confirm = () => true; });
        await del();
        await $('#undo').click(); await until('undo -> 4 pages', async () => (await snap()).pages === 4 && (await snap()).thumbs === 4, 20000);
        await $('#redo').click(); await until('redo -> 3 pages', async () => (await snap()).pages === 3, 20000);
        await $('#undo').click(); await until('undo -> 4 pages', async () => (await snap()).pages === 4, 20000);
        return 'delete/undo/redo work once confirm() returns true; the failure above is the unanswerable confirm()';
      });
    }
    console.log(`webview console of interest: ${JSON.stringify(consoleLog.slice(0, 6))}`);
    console.log(`final ${JSON.stringify(await snap())}`);
    assert.deepEqual(await fs.readFile(pdf), pdfBytes, 'source PDF unchanged on disk');
    console.log('PASS source PDF untouched (byte-identical)');
  } catch (e) {
    results.push({ name: 'harness', status: 'FAIL' }); console.log(`FAIL harness - ${String(e?.message ?? e).split('\n')[0]}`);
  } finally {
    stop(); await browser?.close().catch(() => {});
    if (args.includes('--keep')) console.log(`kept ${root}`); else await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
}
main();
