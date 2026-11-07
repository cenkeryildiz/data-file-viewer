// V14.3: native SECURITY refusals in an ACTUAL unpacked VS Code (native Rust table worker, disposable profile, no VSIX).
// Real keyboard/mouse. Cases: hostile SQL typed into the editor is refused with a typed message while the SAME worker stays alive
// and the next valid query works; a read-only-by-format source (Stata) opens but offers no edit path; a damaged workbook is
// refused without leaving a worker. Source trees stay byte-identical, no file escapes, the worker holds no network socket.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch } = require('./nativeHostHarness.cjs');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

const DTA = process.env.DFV_DTA_FIXTURE || '/Users/macc/dfv-xlsx-resume-20261103/native/crates/dta/tests/fixtures/v118-le.dta';

(async () => {
  await fs.access(DTA).catch(() => assert.fail(`DFV_DTA_FIXTURE does not name an existing Stata fixture: ${DTA}`));
  const host = await launch({ name: 'refuse', deadlineMs: 240000 });
  try {
    const book = path.join(host.sources, 'data.xlsx'), stata = path.join(host.sources, 'readonly.dta');
    await xlsxFile(book, [{ name: 'Data', rows: [['id', 'v'], [1, 10], [2, 20], [3, 30]] }]);
    await fs.copyFile(DTA, stata);
    await fs.chmod(stata, 0o444);
    const bookBytes = await fs.readFile(book);
    const broken = path.join(host.sources, 'broken.xlsx'), notZip = path.join(host.sources, 'notzip.xlsx');
    await fs.writeFile(broken, bookBytes.subarray(0, Math.floor(bookBytes.length / 2)));
    await fs.writeFile(notZip, 'this is not a workbook\n');
    const before = await host.tree(host.sources);
    const escape = path.join(host.root, 'escaped.csv'), escapeDb = path.join(host.root, 'escaped.db');

    await host.start(book);
    const frame = await host.frame('#run-btn', 'workbook editor');
    await frame.waitForFunction(() => document.querySelector('#query-target') && document.querySelector('#run-btn').textContent.includes('Run'));
    const [worker] = await host.wait('one table worker', () => { const w = host.workers(); return w.length === 1 && w; });
    const page = host.page;

    // 1. hostile SQL through the real editor: each is refused with a message, nothing runs, the worker is untouched.
    const hostile = [
      `DROP TABLE "Data";`,
      `UPDATE "Data" SET v = 99;`,
      `INSERT INTO "Data" VALUES (9, 9);`,
      `COPY (SELECT 1 AS x) TO '${escape}' (FORMAT CSV);`,
      `EXPORT DATABASE '${path.join(host.root, 'exported')}';`,
      `SELECT * FROM read_csv('/etc/hosts', header = false);`,
      `SELECT * FROM read_text('/etc/hosts');`,
      `SELECT * FROM glob('/*');`,
      `ATTACH '${escapeDb}' AS escaped;`,
      `INSTALL httpfs;`,
      `LOAD httpfs;`,
      `SET enable_external_access = true;`,
      `PRAGMA database_list;`,
      `SELECT * FROM duckdb_settings();`,
      `SELECT 1; DROP TABLE "Data";`,
      `CREATE TABLE evil AS SELECT 1;`,
      `SELECT * FROM 'https://example.com/a.csv';`,
      `SELECT * FROM read_parquet('file:///etc/hosts');`,
      `SELECT * FROM '/etc/hosts';`,
      `SELECT * FROM read_csv('../../../../etc/hosts');`,
      `SELECT * FROM read_csv('s3://bucket/key.csv');`,
    ];
    for (const sql of hostile) {
      await host.run(frame, sql);
      await frame.waitForFunction(() => document.querySelector('#results .error') && document.querySelector('#run-btn').textContent.includes('Run'), null, { timeout: 15000 })
        .catch(async error => { throw new Error(`${sql} was not refused: ${(await frame.locator('#results').innerText()).slice(0, 300)} | ${error.message}`); });
      const message = await frame.locator('#results .error').first().textContent();
      assert.ok(message.length > 10 && message.length < 400, `${sql}: a short typed message, got ${JSON.stringify(message)}`);
      assert.doesNotMatch(message, /\/etc\/hosts|escaped|httpfs|example\.com|bucket|Data"/, `${sql}: the message does not echo hostile input`);
      assert.equal(await frame.locator('#results td[data-r]').count(), 0, `${sql}: no result rows`);
      assert.deepEqual(host.workers().map(w => w.pid), [worker.pid], `${sql}: same single worker`);
    }
    await assert.rejects(fs.access(escape), { code: 'ENOENT' }); await assert.rejects(fs.access(escapeDb), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(host.root, 'exported')), { code: 'ENOENT' });
    // the document is intact and still answers a valid query on the same worker
    await host.run(frame, 'SELECT SUM(v) AS total FROM "Data · Table 1";');
    await frame.waitForFunction(() => document.querySelector('td[data-r="0"][data-c="0"]')?.textContent === '60' && document.body.textContent.includes('total'));
    assert.deepEqual(host.workers().map(w => w.pid), [worker.pid]);
    assert.deepEqual(await fs.readFile(book), bookBytes);
    console.log(`PASS actual host refused ${hostile.length} hostile statements typed by keyboard (typed message, no rows, no escaped file, same worker); valid query then returned 60.`);

    // 2. read-only-by-format source: opens, shows data, offers no edit path, bytes unchanged.
    host.open(stata);
    const dtaFrames = () => host.page.frames().filter(f => !f.isDetached());
    await host.wait('Stata grid painted', async () => { for (const f of dtaFrames()) if (f !== frame && await f.locator('td[data-r]').count().catch(() => 0)) return true; });
    const stataFrame = await host.wait('Stata frame', async () => { for (const f of dtaFrames()) if (f !== frame && await f.locator('#safe-mode-check').count().catch(() => 0)) return f; });
    await stataFrame.locator('.table-item').first().click().catch(() => {});
    await stataFrame.locator('#safe-mode-check').uncheck().catch(() => {});
    await page.waitForTimeout(500);
    const cell = stataFrame.locator('td[data-r="0"][data-c="0"]');
    await cell.waitFor();
    await cell.dblclick();
    const saves = await stataFrame.locator('.cell-inspector-footer button', { hasText: 'Save' }).count();
    assert.equal(saves, 0, 'a read-only Stata document offers no Save button even with Safe Mode off');
    assert.equal((await stataFrame.locator('#results').innerText()).length > 0, true);
    assert.equal(host.workers().length, 2, 'one worker per open document, no more');
    assert.deepEqual(await fs.readFile(stata), await fs.readFile(DTA));
    assert.equal((await fs.stat(stata)).mode & 0o222, 0, 'the read-only permission was not altered');
    console.log('PASS actual host Stata source read-only: shown, Safe Mode off still has no Save, bytes and 0444 mode unchanged.');

    // 3. damaged sources are refused: no editor grid, no leaked worker, bytes unchanged.
    for (const bad of [broken, notZip]) {
      const known = new Set(host.workers().map(w => w.pid));
      host.open(bad);
      await host.wait(`${path.basename(bad)} refused-open state`, async () => /could not be opened/.test((await page.locator('.monaco-editor-pane-placeholder, .notifications-toasts').allInnerTexts().catch(() => [])).join(' ')), 20000);
      assert.deepEqual(new Set(host.workers().map(w => w.pid)), known, `${path.basename(bad)}: the refused open leaves no new worker`);
      const shown = (await page.locator('.monaco-editor-pane-placeholder, .notifications-toasts').allInnerTexts().catch(() => [])).join(' | ');
      assert.match(shown, /could not be opened/, `${path.basename(bad)}: VS Code shows the refused-open state, got ${shown.slice(0, 200)}`);
    }
    // 4. network and integrity.
    for (const w of host.workers()) assert.equal(host.sockets(w.pid).trim(), '', 'no worker holds a network socket');
    const lock = path.join(host.sources, 'readonly.dta.dfv.lock');
    assert.match(await fs.readFile(lock, 'utf8'), /^\d+$/, 'the open Stata document holds only the PID lock sidecar');
    const now = await host.tree(host.sources); delete now['readonly.dta.dfv.lock'];
    assert.deepEqual(now, before, 'every source file (including refused and read-only ones) is byte-identical and nothing else was added');
    host.stop(); await host.allExited(); await host.profileIsolation();
    console.log('Actual unpacked VS Code native refusal gate passed: hostile SQL, read-only source, damaged sources, no sockets, sources intact, real profile untouched.');
  } finally { await host.cleanup(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
