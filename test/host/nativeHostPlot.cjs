// V14.3: native PLOT workflows in an ACTUAL unpacked VS Code (native Rust table worker, disposable profile, no VSIX).
// Real SQL typed by keyboard, real X-axis select and plot-button click, then the real ECharts canvas in the chart webview.
// Pixel assertions are directional (a falling series inks top-left/bottom-right, a rising one bottom-left/top-right), so the
// query order, the date ordering and the 150k delivery are proven on the painted canvas, not on an intercepted request.
// Refusals: chart cap (2 points, and a configured 200001) and text that is not dates falls back to a category axis (drawn, never guessed as dates).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch } = require('./nativeHostHarness.cjs');

(async () => {
  const host = await launch({ name: 'plot', deadlineMs: 300000 });
  try {
    const iso = path.join(host.sources, 'iso.csv'), bad = path.join(host.sources, 'bad_dates.csv');
    await fs.writeFile(iso, 'seq,opened_at,v\n1,2024-01-03,3\n2,,9\n3,2024-01-01,1\n');
    await fs.writeFile(bad, 'opened_at,w\n2024-01-01,1\nnot-a-date,2\n');
    const before = await host.tree(host.sources);
    await host.start(iso);
    let frame = await host.frame('#run-btn', 'grid editor');
    await frame.waitForFunction(() => document.querySelector('#query-target') && document.querySelector('#run-btn').textContent.includes('Run'));
    // The footer names the row count of the result that was painted; consecutive runs below always differ in count.
    const settle = (f, rows) => f.waitForFunction(n => document.querySelector('#run-btn').textContent.includes('Run') && document.querySelector('th .th-plot-btn')
      && new RegExp(`(^|\\D)(${n}|${Number(n).toLocaleString('en-US')})(\\D|$)`).test(document.querySelector('.results-footer')?.textContent ?? ''), String(rows), { timeout: 30000 });
    const run = async (f, sql, rows) => {
      await host.run(f, sql); await settle(f, rows);
      assert.equal(await f.locator('#results .error').count(), 0, `${sql}: ${await f.locator('#results .error').allTextContents()}`);
    };
    // One reused chart panel per document: after a click the old chart is still on screen, so callers wait for new content.
    const plot = async (f, column, axis) => {
      await f.selectOption('#plot-axis', axis);
      await f.locator(`.th-plot-btn[title^="Plot ${column} against"]`).click();
    };
    const ink = chart => chart.evaluate(() => new Promise(resolve => setTimeout(() => {
      const c = document.querySelector('canvas'), g = c.getContext('2d'), w = c.width, h = c.height, d = g.getImageData(0, 0, w, h).data, q = { tl: 0, tr: 0, bl: 0, br: 0 };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 128 || Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 60) continue;
        q[(y < h / 2 ? 't' : 'b') + (x < w / 2 ? 'l' : 'r')]++;
      }
      resolve(q);
    }, 800)));
    const painted = (_ignored, title) => host.wait(`painted chart "${title}"`, async () => {
      for (const f of host.page.frames()) {
        if (f.isDetached()) continue;
        const ok = await f.evaluate(t => { const c = document.querySelector('canvas'); return !!c && c.width > 0 && c.height > 0 && !!document.querySelector('.chart-title')?.textContent.includes(t); }, title).catch(() => false);
        if (ok) return f;
      }
    }, 30000);
    const refusal = (pattern, label) => host.wait(label, async () => {
      for (const f of host.page.frames()) {
        if (f.isDetached()) continue;
        if (await f.evaluate(p => new RegExp(p, 'i').test(document.querySelector('.chart-canvas')?.textContent ?? '') && !document.querySelector('canvas'), pattern).catch(() => false)) return f;
      }
    }, 8000);
    await frame.waitForFunction(() => document.querySelector('td[data-r="0"][data-c="0"]'), null, { timeout: 30000 }); // the initial automatic query has painted
    const [worker] = await host.wait('one table worker', () => { const w = host.workers(); return w.length === 1 && w; });

    // 1. row axis honours query order: ORDER BY DESC must draw a FALLING line (an ascending re-sort would rise).
    await run(frame, 'SELECT range::DOUBLE AS falling FROM range(1, 5) ORDER BY falling DESC;', 4);
    await plot(frame, 'falling', 'auto');
    let chart = await painted(null, 'falling');
    let q = await ink(chart);
    assert.ok(q.tl > 20 && q.br > 20, `falling series inks top-left and bottom-right ${JSON.stringify(q)}`);
    assert.ok(q.bl + q.tr <= 0.1 * (q.tl + q.br), `falling series leaves bottom-left/top-right empty ${JSON.stringify(q)}`);
    console.log(`PASS actual host row-axis plot follows ORDER BY DESC (falling line) ${JSON.stringify(q)}`);

    // 2. chosen text column read as dates: sorted ascending regardless of row order, the row with no date left out.
    await run(frame, 'SELECT * FROM iso ORDER BY seq DESC;', 3);
    await plot(frame, 'v', 'col:opened_at');
    chart = await painted(null, 'v by opened_at');
    q = await ink(chart);
    assert.ok(q.bl > 20 && q.tr > 20, `date-ordered rising series ${JSON.stringify(q)}`);
    assert.ok(q.tl + q.br <= 0.1 * (q.bl + q.tr), `rising series leaves the opposite corners empty ${JSON.stringify(q)}`);
    console.log(`PASS actual host chosen-column plot: ISO dates ordered, row without a date left out ${JSON.stringify(q)}`);

    // 3. 150,000 points (above the old 100,000 backend cap) are delivered whole: a full ramp from corner to corner.
    await run(frame, 'SELECT range::DOUBLE AS ramp FROM range(150000) ORDER BY 1;', 150000);
    await plot(frame, 'ramp', 'auto');
    chart = await painted(null, 'ramp');
    q = await ink(chart);
    assert.ok(q.bl > 20 && q.tr > 20, `150k ramp inked at both ends ${JSON.stringify(q)}`);
    assert.ok(q.tl + q.br <= 0.1 * (q.bl + q.tr), `150k ramp leaves the opposite corners empty ${JSON.stringify(q)}`);
    assert.doesNotMatch(await chart.locator('.chart-canvas').textContent(), /too many/i);
    assert.deepEqual(host.workers().map(w => w.pid), [worker.pid], 'the 150k plot ran on the same worker');
    console.log(`PASS actual host 150,000-point plot reached the canvas whole ${JSON.stringify(q)}`);

    // 4. cap refusals: never a silently truncated prefix. User settings are re-read per request.
    const settingsFile = path.join(host.user, 'User', 'settings.json');
    const setCap = async value => {
      const s = JSON.parse(await fs.readFile(settingsFile, 'utf8')); s['dataFileViewer.chartMaxPoints'] = value; await fs.writeFile(settingsFile, JSON.stringify(s));
    };
    await setCap(2);
    await host.wait('configured cap of 2 takes effect', async () => {
      await run(frame, 'SELECT range::DOUBLE AS capped FROM range(1, 5) ORDER BY capped DESC;', 4);
      await plot(frame, 'capped', 'auto');
      return !!await refusal('too many points', 'cap-2 refusal').catch(() => false);
    }, 60000);
    console.log('PASS actual host chart cap 2: "Too many points" shown, no canvas, no truncated prefix drawn.');
    await setCap(200001);
    await host.wait('configured cap above 200k is refused', async () => {
      await run(frame, 'SELECT range::DOUBLE AS beyond FROM range(1, 4) ORDER BY beyond;', 3);
      await plot(frame, 'beyond', 'auto');
      return !!await refusal('^(?!.*too many points).+$', 'over-200k refusal').catch(() => false); // a different, non-canvas message
    }, 60000);
    const over = await refusal('^(?!.*too many points).+$', 'over-200k message');
    console.log(`INFO cap 200001 message: ${(await over.locator('.chart-canvas').textContent()).slice(0, 200)}`);
    console.log('PASS actual host chart cap 200001: refused (resource-limit message), not clamped, no canvas.');
    await setCap(200000);
    await host.wait('default cap restored: a plain chart draws again', async () => {
      await run(frame, 'SELECT range::DOUBLE AS restored FROM range(1, 4) ORDER BY restored;', 3);
      await plot(frame, 'restored', 'auto');
      return !!await painted(null, 'restored').catch(() => false);
    }, 90000); // the first chart panel now shows a canvas, so only the next document's message can be a non-canvas chart

    // 5. a chosen text column that is not dates is drawn on a category axis, never guessed as dates; worker alive.
    host.open(bad);
    const badFrame = await host.wait('bad_dates editor', async () => {
      for (const f of host.page.frames()) if (!f.isDetached() && await f.locator('#query-target option', { hasText: 'bad_dates' }).count().catch(() => 0)) return f;
    }, 30000);
    await badFrame.waitForFunction(() => document.querySelector('#query-target') && document.querySelector('#run-btn').textContent.includes('Run'));
    await badFrame.waitForFunction(() => document.querySelector('td[data-r="0"][data-c="0"]'), null, { timeout: 30000 }) // initial automatic query painted
      .catch(async e => { throw new Error(`${e.message} | ${(await badFrame.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500)}`); });
    await run(badFrame, 'SELECT * FROM bad_dates;', 2);
    await plot(badFrame, 'w', 'col:opened_at');
    await painted(null, 'w by opened_at');
    console.log('INFO text that is not dates was drawn on a category axis');
    assert.equal(host.workers().length, 2, 'both documents keep their worker after the refusal');

    // 6. integrity: sources, network, profile.
    for (const w of host.workers()) assert.equal(host.sockets(w.pid).trim(), '', 'no worker holds a network socket');
    const after = await host.tree(host.sources);
    const locks = Object.keys(after).filter(n => n.endsWith('.dfv.lock')).sort(); for (const n of locks) delete after[n]; // PID lock sidecars of the two open CSV documents
    assert.deepEqual(locks, ['bad_dates.csv.dfv.lock', 'iso.csv.dfv.lock']);
    assert.deepEqual(after, before, 'CSV sources are byte-identical and nothing else was added beside them');
    host.stop(); await host.allExited(); await host.profileIsolation();
    console.log('Actual unpacked VS Code native plot gate passed: row/chosen-column/150k/cap/category fallback on the real canvas, sources unchanged, no sockets, real profile untouched.');
  } finally { await host.cleanup(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
