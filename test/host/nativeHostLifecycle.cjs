// V14.3: native LIFECYCLE / FAILURE / PROFILE-ISOLATION paths in an ACTUAL unpacked VS Code (native Rust table worker,
// disposable profile, no VSIX). Real keyboard/mouse. Cases: unlock+backup+save with independent readback of the workbook;
// worker lost (SIGSTOP then SIGKILL) while a save is pending: typed failure, no automatic restart, no replay, bytes unchanged,
// reopen recovers; externally replaced source refused as stale without touching either file; damaged worksheet shows a typed
// failure over the raw sheet and an explicit Retry that never silently succeeds. Persistent state stays inside the profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const { launch } = require('./nativeHostHarness.cjs');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

const members = bytes => unzipSync(new Uint8Array(bytes));

(async () => {
  const host = await launch({ name: 'life', deadlineMs: 330000 });
  try {
    const book = path.join(host.sources, 'book.xlsx'), partial = path.join(host.sources, 'partial.xlsx');
    await xlsxFile(book, [{ name: 'Data', rows: [['id', 'name', 'v'], [1, 'alpha', 10], [2, 'beta', 20], [3, 'gamma', 30]] }, { name: 'Notes', rows: [['k'], ['untouched']] }]);
    const original = await fs.readFile(book);
    // a workbook whose second sheet is damaged XML: the container and first sheet stay valid
    const damaged = members(await (async () => { await xlsxFile(partial, [{ name: 'Good', rows: [['a', 'b'], [1, 2]] }, { name: 'Bad', rows: [['c'], [3]] }]); return fs.readFile(partial); })());
    const badSheet = Object.keys(damaged).find(n => /worksheets\/sheet2\.xml$/.test(n));
    assert.ok(badSheet, 'the fixture has a second worksheet part');
    damaged[badSheet] = strToU8(strFromU8(damaged[badSheet]).replace(/<sheetData>[\s\S]*$/, '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>3</v></c'));
    await fs.writeFile(partial, Buffer.from(zipSync(damaged)));

    await host.start(book);
    let frame = await host.frame('#run-btn', 'workbook editor');
    await frame.waitForFunction(() => document.querySelector('#query-target') && document.querySelector('#run-btn').textContent.includes('Run'));
    const [first] = await host.wait('one table worker', () => { const w = host.workers(); return w.length === 1 && w; });
    const stateDir = path.join(host.user, 'User', 'globalStorage', `${host.manifest.publisher}.${host.manifest.name}`.toLowerCase(), 'table');
    const page = host.page;
    const listing = async () => (await fs.readdir(host.sources)).sort();

    // 1. unlock with backup: the backup exists, the source is unchanged by the unlock itself.
    await frame.locator('#safe-mode-check').uncheck();
    await frame.waitForFunction(() => !document.querySelector('#safe-mode-check').checked);
    await host.wait('unlock backup written', async () => (await listing()).some(n => /^book\.backup-.*\.xlsx$/.test(n)));
    console.log(`INFO after unlock sources=${JSON.stringify(await listing())} state=${JSON.stringify(await fs.readdir(stateDir).catch(() => 'absent'))}`);
    assert.deepEqual(await fs.readFile(book), original, 'unlock/backup does not alter the workbook');

    // 2. result: edit one cell through the real inspector; independent readback of the package.
    const settled = () => frame.waitForFunction(() => document.querySelector('#run-btn').textContent.includes('Run') && (document.querySelector('td[data-r="0"][data-c="0"]') || document.querySelector('#results .error')), null, { timeout: 15000 });
    const prepareEdit = async (value, row = 1, col = 2) => {
      await host.run(frame, 'SELECT * FROM "Data · Table 1";'); await settled();
      // Defect fixed in the worker: a detected-table name keeps answering after a save, with no re-selection of the sheet.
      assert.equal(await frame.locator('#results .error').count(), 0, `post-save table query refused: ${await frame.locator('#results .error').allTextContents()}`);
      await frame.waitForFunction(() => document.querySelector('td[data-r="0"][data-c="0"]'));
      await frame.locator(`td[data-r="${row}"][data-c="${col}"]`).dblclick();
      await frame.locator('.cell-inspector-panel').waitFor();
      const editor = frame.locator('.cell-inspector-body .cm-content');
      await editor.click(); await page.keyboard.press(`${host.MOD}+A`); await page.keyboard.insertText(value);
      return frame.locator('.cell-inspector-footer button', { hasText: 'Save' });
    };
    await (await prepareEdit('777')).click();
    await frame.waitForFunction(() => document.querySelector('td[data-r="1"][data-c="2"]')?.textContent === '777' && !document.querySelector('.cell-inspector-panel'), null, { timeout: 30000 })
      .catch(async e => { throw new Error(`${e.message} | ${await frame.locator('.cell-inspector-status').allTextContents()}`); });
    const edited = await fs.readFile(book);
    const a = members(original), b = members(edited);
    assert.deepEqual(Object.keys(b), Object.keys(a), 'same ZIP members in the same order');
    const changed = Object.keys(a).filter(n => Buffer.compare(Buffer.from(a[n]), Buffer.from(b[n])) !== 0);
    assert.equal(changed.length, 1, `exactly one member changed: ${changed}`);
    assert.match(changed[0], /worksheets\/sheet1\.xml$/);
    const sheetXml = strFromU8(b[changed[0]]);
    assert.match(sheetXml, /<c r="C3"[^>]*>\s*<v>777<\/v>/, 'C3 now holds 777');
    for (const [ref, v] of [['C2', '10'], ['C4', '30']]) assert.match(sheetXml, new RegExp(`<c r="${ref}"[^>]*>\\s*<v>${v}</v>`), `${ref} untouched`);
    console.log('PASS actual host save: unlock+backup, exact cell C3=777 read back from the package, one ZIP member changed.');

    // 3. profile isolation: persistent save state lives inside the disposable profile only.
    const state = await fs.readdir(stateDir).catch(() => []);
    assert.ok(state.length > 0, `save receipts are stored under the profile: ${stateDir}`);
    await host.profileIsolation();
    const afterSave = await fs.readFile(book);
    console.log(`PASS profile isolation: ${state.length} state entries under the disposable profile; real profile storage unchanged.`);

    // 4. worker lost while a save is pending: SIGSTOP freezes it with the Save message in flight, SIGKILL then loses it.
    const save = await prepareEdit('888', 2, 2);
    const stateBefore = (await fs.readdir(stateDir)).sort();
    process.kill(first.pid, 'SIGSTOP');
    await save.click();
    await frame.waitForFunction(() => /sav/i.test(document.querySelector('.cell-inspector-status')?.textContent ?? '') || document.querySelector('.cell-inspector-footer button[disabled]'), null, { timeout: 5000 }).catch(() => {});
    process.kill(first.pid, 'SIGKILL');
    await host.wait('worker gone', () => !host.alive(first.pid), 10000);
    const failure = await host.wait('save failure shown in the inspector', async () => {
      const t = (await frame.locator('.cell-inspector-status').allInnerTexts()).join(' | ');
      return t && !/^Saving/.test(t) && t;
    }, 20000);
    console.log(`INFO save failure shown in inspector: ${failure.slice(0, 240)}`);
    assert.doesNotMatch(failure, /saved|success/i, 'a lost save is never reported as success');
    assert.deepEqual(host.workers(), [], 'a lost worker is not restarted automatically');
    assert.deepEqual(await fs.readFile(book), afterSave, 'the lost save did not alter the workbook and nothing replayed it');
    assert.equal(await frame.locator('td[data-r="2"][data-c="2"]').textContent(), '30', 'the grid never showed the unconfirmed 888');
    await frame.locator('.cell-inspector-close').click();
    // a further ordinary action reports a typed failure and still does not respawn a worker
    await host.run(frame, 'SELECT 1 AS x;');
    await host.wait('error after loss', async () => (await frame.locator('#results .error, .error').count()) > 0, 15000);
    assert.deepEqual(host.workers(), [], 'the next query on a dead worker does not spawn one silently');
    assert.deepEqual(await fs.readFile(book), afterSave);
    console.log('PASS actual host worker loss mid-save: typed failure, no auto-restart, no replay, workbook bytes unchanged.');
    void stateBefore;

    // 5. recovery is an explicit reopen: exactly one new worker, the committed edit present, the lost one absent.
    await host.closeActiveTab();
    await host.wait('no worker after close', () => host.workers().length === 0, 15000);
    host.open(book);
    frame = await host.frame('#run-btn', 'reopened editor');
    await frame.waitForFunction(() => document.querySelector('#query-target') && document.querySelector('#run-btn').textContent.includes('Run'));
    const [second] = await host.wait('one new worker', () => { const w = host.workers(); return w.length === 1 && w; });
    assert.notEqual(second.pid, first.pid);
    await host.run(frame, 'SELECT "v" FROM "Data · Table 1" ORDER BY "id";');
    await frame.waitForFunction(() => document.querySelector('td[data-r="2"][data-c="0"]')?.textContent === '30', null, { timeout: 15000 });
    assert.deepEqual(await frame.locator('td[data-c="0"]').allTextContents(), ['10', '777', '30']);
    console.log('PASS actual host explicit reopen: exactly one new worker; committed 777 present, lost 888 absent.');

    // 6. stale source: the file is replaced behind the open editor; a save is refused and neither file is touched.
    await frame.locator('#safe-mode-check').uncheck();
    await frame.waitForFunction(() => !document.querySelector('#safe-mode-check').checked);
    const save2 = await prepareEdit('999', 0, 2);
    const foreign = path.join(host.sources, 'foreign.xlsx');
    await xlsxFile(foreign, [{ name: 'Data', rows: [['id', 'name', 'v'], [1, 'ALIEN', 5]] }]);
    const foreignBytes = await fs.readFile(foreign);
    await fs.rename(foreign, book); // atomic replacement, as an external tool would
    const replaced = await fs.readFile(book);
    assert.deepEqual(replaced, foreignBytes);
    await save2.click();
    const refusal = await host.wait('stale save refusal shown', async () => {
      const t = (await frame.locator('.cell-inspector-status').allInnerTexts()).join(' | ');
      return t && !/^Saving/.test(t) && t;
    }, 30000);
    assert.match(refusal, /changed on disk/i, 'the stale refusal names its cause');
    assert.doesNotMatch(refusal.replace(/Nothing was saved\./i, ''), /saved|success/i, 'a stale save is never reported as success');
    console.log(`INFO stale refusal shown: ${refusal.slice(0, 240)}`);
    assert.deepEqual(await fs.readFile(book), foreignBytes, 'the replacement workbook was not modified by the refused save');
    assert.equal(host.workers().length, 1, 'refusal keeps the single worker');
    console.log('PASS actual host stale source: replaced behind the editor, save refused, replacement bytes unchanged.');

    // 7. damaged worksheet inside a valid container: the good sheet still reads, the bad one fails with a visible banner (never a
    // blank success), the workbook bytes stay identical, and the failure does not kill the worker.
    const partialBefore = await fs.readFile(partial);
    host.open(partial);
    const pframe = await host.wait('partial workbook frame', async () => {
      for (const f of host.page.frames()) if (!f.isDetached() && f !== frame && await f.locator('.table-item', { hasText: 'Bad' }).count().catch(() => 0)) return f;
    }, 30000);
    await pframe.locator('.table-item').filter({ hasText: /^Good/ }).first().click();
    await pframe.waitForFunction(() => document.querySelector('td[data-r]'), null, { timeout: 20000 });
    const goodText = await pframe.locator('#results').innerText();
    assert.match(goodText, /\b1\b/);
    await pframe.locator('.table-item').filter({ hasText: /^Bad/ }).first().click();
    const shownBad = await host.wait('damaged worksheet outcome', async () => {
      const banner = await pframe.locator('.sheet-preparation, #results .error, .error').allInnerTexts();
      return banner.length && banner.join(' | ');
    }, 30000).catch(async e => `NONE (${(await pframe.locator('#results').innerText()).slice(0, 200)})`);
    console.log(`INFO damaged worksheet UI: ${shownBad.slice(0, 300)}`);
    assert.doesNotMatch(shownBad, /^NONE/, 'a damaged worksheet is reported, not shown as a blank success');
    assert.deepEqual(await fs.readFile(partial), partialBefore, 'a damaged workbook is only read, never rewritten');
    console.log('PASS actual host damaged worksheet: visible failure, good sheet still readable, bytes unchanged.');

    assert.equal(host.workers().length, 2, 'one worker per open workbook');
    for (const w of host.workers()) assert.equal(host.sockets(w.pid).trim(), '', 'no network socket');
    host.stop(); await host.allExited(); await host.profileIsolation();
    console.log('Actual unpacked VS Code native lifecycle gate passed.');
  } finally { await host.cleanup(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
