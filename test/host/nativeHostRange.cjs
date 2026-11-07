// V14.3: SQL-RANGE-01 and native plot in an ACTUAL unpacked VS Code (native Rust table worker, disposable profile, no VSIX).
// Real keyboard/mouse only. Covers result cases (exact raw-sheet and SQL-result pages, plot canvas pixels) and refusals
// (malformed/reversed/out-of-bounds range, worker never replaced), with source bytes, profile and network checks.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch } = require('./nativeHostHarness.cjs');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

(async () => {
  const host = await launch({ name: 'range', deadlineMs: 240000 });
  try {
    const book = path.join(host.sources, 'book.xlsx');
    const grid = Array.from({ length: 250 }, (_, r) => Array.from({ length: 28 }, (_, c) => `R${r + 1}C${c + 1}`));
    const series = [['Date', 'Value'], ...Array.from({ length: 300 }, (_, i) => [new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), i])];
    await xlsxFile(book, [{ name: 'Grid', rows: grid }, { name: 'Series', rows: series }]);
    const before = await host.tree(host.sources);
    await host.start(book);
    const frame = await host.frame('#range-apply', 'workbook editor');
    const [worker] = await host.wait('one table worker', () => { const w = host.workers(); return w.length === 1 && w; });
    assert.equal(host.sockets(worker.pid).trim(), '', 'the native worker holds no network socket');
    const page = host.page;
    const preview = frame.locator('#range-preview');
    const rangeCells = () => preview.locator('tbody tr td:nth-child(2)').first().textContent();
    const typeRange = async text => {
      await frame.locator('#range-input').click(); await page.keyboard.press(`${host.MOD}+A`); await page.keyboard.insertText(text);
      assert.equal(await frame.locator('#range-input').inputValue(), text);
    };
    const ready = async sheet => frame.waitForFunction(sheet => !document.querySelector('#range-apply').disabled && document.querySelector('#range-target').textContent.includes(`Worksheet ${sheet}`), sheet);
    const sheet = name => frame.locator('.table-item').filter({ hasText: new RegExp(`^${name}`) }).click();

    // 1. result: exact raw-worksheet rectangle, multi-letter columns, paged beyond the initial 100-row preview.
    await sheet('Grid'); await ready('Grid');
    await typeRange('Z2:AB205'); await frame.locator('#range-apply').click();
    await frame.waitForFunction(() => document.querySelector('#range-preview tbody tr'));
    assert.equal(await rangeCells(), 'R2C26');
    assert.equal(await preview.locator('tbody tr').count(), 100);
    assert.deepEqual(await preview.locator('tbody tr').first().locator('td').allTextContents(), ['2', 'R2C26', 'R2C27', 'R2C28']);
    assert.match(await preview.locator('p').first().textContent(), /Worksheet Grid.*Z2:AB205/);
    const next = preview.getByRole('button', { name: 'Next range page' });
    await next.click(); await frame.waitForFunction(() => document.querySelector('#range-preview tbody tr td:nth-child(2)')?.textContent === 'R102C26');
    await next.click(); await frame.waitForFunction(() => document.querySelector('#range-preview tbody tr td:nth-child(2)')?.textContent === 'R202C26');
    assert.equal(await preview.locator('tbody tr').count(), 4);
    assert.deepEqual(await preview.locator('tbody tr').last().locator('td').allTextContents(), ['205', 'R205C26', 'R205C27', 'R205C28']);
    assert.equal(await next.isDisabled(), true, 'no page past the last row');
    await preview.getByRole('button', { name: 'Previous range page' }).click();
    await frame.waitForFunction(() => document.querySelector('#range-preview tbody tr td:nth-child(2)')?.textContent === 'R102C26');
    console.log('PASS actual host raw-worksheet range Z2:AB205: exact 100/100/4 pages, boundaries R2C26..R205C28.');

    // 2. refusals: malformed, reversed and out-of-bounds rectangles show a typed message, never a partial table; same worker throughout.
    for (const bad of ['Z2:', 'B5:A1', 'A1:XFE1', 'A0:B2', 'A1:B99999999']) {
      await typeRange(bad); await frame.locator('#range-apply').click();
      await frame.waitForFunction(() => { const p = document.querySelector('#range-preview'); return !p.hidden && p.textContent.length > 0 && !p.querySelector('tbody tr'); }, null, { timeout: 15000 })
        .catch(async error => { throw new Error(`${bad}: ${await preview.textContent()} | ${error.message}`); });
      assert.equal(await preview.locator('tbody tr').count(), 0, `${bad}: no rows from a refused range`);
      assert.equal(await frame.locator('#range-input').inputValue(), bad);
    }
    assert.deepEqual(host.workers().map(w => w.pid), [worker.pid], 'refused ranges neither killed nor replaced the worker');
    console.log('PASS actual host refused 5 malformed/reversed/out-of-bounds ranges with no rows and the same worker.');

    // 3. result: SQL-result coordinates after an ORDER BY, checked against an independent JS oracle of the sorted column.
    await host.run(frame, 'SELECT * FROM "Grid" ORDER BY "A";');
    await frame.waitForFunction(() => document.querySelector('.results-footer') && document.querySelector('#run-btn').textContent.includes('Run'));
    await typeRange('A2:B205'); await frame.locator('#range-apply').click();
    await frame.waitForFunction(() => document.querySelector('#range-preview tbody tr') && document.querySelector('#range-preview p')?.textContent.includes('SQL result'));
    const sorted = grid.map(r => r.slice(0, 2)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    assert.deepEqual(await preview.locator('tbody tr').first().locator('td').allTextContents(), ['2', ...sorted[1]]);
    assert.equal(await preview.getByRole('button', { name: 'Use as table', exact: true }).count(), 0, 'SQL-result coordinates cannot correct a workbook table');
    assert.match(await preview.locator('textarea').inputValue(), /BETWEEN 2 AND 205/);
    await next.click(); await frame.waitForFunction(first => document.querySelector('#range-preview tbody tr td:nth-child(2)')?.textContent === first, sorted[101][0]);
    console.log('PASS actual host SQL-result range: ORDER BY snapshot rows 2..205 equal the independent sorted oracle; page two follows.');

    // 3b. stale refusal by real edits: typing invalidates the captured rectangle, a new ORDER BY run re-captures it, a header sort drops it.
    await host.typeSql(frame, 'SELECT * FROM "Grid" ORDER BY "A" DESC;');
    assert.equal(await frame.locator('#range-apply').isDisabled(), true, 'editing the SQL disables the old range');
    assert.equal(await preview.isHidden(), true, 'editing the SQL hides the old range preview');
    await frame.locator('#run-btn').click();
    await frame.waitForFunction(() => !document.querySelector('#range-apply').disabled && document.querySelector('#range-target').textContent.includes('captured rows'));
    await typeRange('A2:B3'); await frame.locator('#range-apply').click();
    await frame.waitForFunction(() => document.querySelector('#range-preview tbody tr') && document.querySelector('#range-preview p')?.textContent.includes('SQL result'));
    assert.deepEqual(await preview.locator('tbody tr').first().locator('td').allTextContents(), ['2', ...sorted[sorted.length - 2]], 'the DESC run captured its own order, not the previous ASC snapshot');
    await frame.locator('.th-sort-btn').first().click();
    await frame.waitForFunction(() => document.querySelector('#range-apply').disabled);
    console.log('PASS actual host stale refusal: edit invalidates, re-run recaptures DESC order exactly, header sort drops the range.');

    // 4. plot: real keyboard SQL, real click on the column plot button, then the actual ECharts canvas in the chart webview.
    await sheet('Series'); await ready('Series');
    await host.run(frame, 'SELECT "Date", "Value" FROM "Series · Table 1" ORDER BY "Date";');
    await frame.waitForFunction(() => document.querySelector('.th-plot-btn') && document.querySelector('#run-btn').textContent.includes('Run'));
    await frame.locator('.th-plot-btn[title^="Plot Value against"]').click();
    const chart = await host.frame('.chart-canvas canvas', 'native chart canvas');
    await chart.waitForFunction(() => { const c = document.querySelector('canvas'); return c && c.width > 0 && c.height > 0 && document.querySelector('.chart-title')?.textContent.includes('Value'); });
    const ink = await chart.evaluate(() => new Promise(resolve => setTimeout(() => {
      const c = document.querySelector('canvas'), g = c.getContext('2d'), w = c.width, h = c.height, d = g.getImageData(0, 0, w, h).data, q = { tl: 0, tr: 0, bl: 0, br: 0 };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 128 || Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 60) continue;
        q[(y < h / 2 ? 't' : 'b') + (x < w / 2 ? 'l' : 'r')]++;
      }
      resolve(q);
    }, 800)));
    assert.ok(ink.bl > 20 && ink.tr > 20, `rising series inked in both ends ${JSON.stringify(ink)}`);
    assert.ok(ink.tl + ink.br <= 0.1 * (ink.bl + ink.tr), `rising series leaves the opposite corners empty ${JSON.stringify(ink)}`);
    console.log(`PASS actual host native plot: 300-point series reached the ECharts canvas corner to corner ${JSON.stringify(ink)}.`);

    // 5. stale source: the workbook is replaced behind the open editor; a raw-sheet range is refused, never answered from the old bytes.
    await sheet('Grid'); await ready('Grid');
    await typeRange('A1:B2'); await frame.locator('#range-apply').click();
    await frame.waitForFunction(() => document.querySelector('#range-preview tbody tr'));
    assert.equal(await rangeCells(), 'R1C1');
    const foreign = path.join(host.root, 'foreign.xlsx');
    await xlsxFile(foreign, [{ name: 'Grid', rows: [['NEW1', 'NEW2'], ['NEW3', 'NEW4']] }, { name: 'Series', rows: [['d', 'v'], ['x', 1]] }]);
    const foreignBytes = await fs.readFile(foreign);
    await fs.rename(foreign, book);
    await typeRange('A1:B3'); await frame.locator('#range-apply').click();
    await frame.waitForFunction(() => { const p = document.querySelector('#range-preview'); return !p.hidden && p.textContent.length > 0 && !p.querySelector('tbody tr'); }, null, { timeout: 20000 })
      .catch(async e => { throw new Error(`${e.message} | ${await preview.textContent()}`); });
    console.log(`INFO stale-source range refusal text: ${(await preview.textContent()).slice(0, 200)}`);
    assert.doesNotMatch(await preview.textContent(), /R1C1|NEW1/, 'neither the old nor the replacement bytes were served');
    assert.deepEqual(await fs.readFile(book), foreignBytes, 'the replacement workbook is untouched by the refused range');
    console.log('PASS actual host stale source: range on a replaced workbook refused with no rows from either version.');

    // 6. integrity: sources, profile, worker and network.
    assert.deepEqual(await host.tree(host.sources), { ...before, 'book.xlsx': host.sha(foreignBytes) }, 'only the deliberately replaced workbook differs; nothing was written beside it');
    assert.deepEqual(host.workers().map(w => w.pid), [worker.pid], 'one worker for the whole session');
    assert.equal(host.sockets(worker.pid).trim(), '');
    host.stop(); await host.allExited(); await host.profileIsolation();
    console.log('Actual unpacked VS Code native range + plot gate passed: source tree unchanged, one worker, no sockets, real profile untouched.');
  } finally { await host.cleanup(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
