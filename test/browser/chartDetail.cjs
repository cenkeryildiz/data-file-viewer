// Uses installed Chrome. From the repository root:
// npm ci && node test/browser/chartDetail.cjs
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const bundle = await esbuild.build({
    stdin: { contents: fs.readFileSync('src/chartView.ts', 'utf8') + '\nexport function testChart() { return chart; }\nexport * from "./chartSpec";', resolveDir: require('node:path').resolve('src'), loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: 'viewerTest', platform: 'browser',
  });
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    await page.setContent('<style>.chart-canvas{width:950px;height:550px}</style><div id="chart-root"></div>');
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const pause = () => new Promise(resolve => setTimeout(resolve, 60));
      const start = Date.UTC(2020, 0, 1);
      const rows = Array.from({ length: 200000 }, (_, i) => [new Date(start + i * 1000).toISOString(), i === 100 ? 1.23456789012345 : i % 100]);
      window.postMessage({ command: 'chart', xColumn: 'time', yColumns: ['value'], columns: ['time', 'value'], rows, xAxisMode: 'time', truncated: false, maxPoints: 200000 }, '*');
      await pause();
      const chart = viewerTest.testChart();
      const state = () => {
        const option = chart.getOption();
        return { tooltip: option.tooltip[0].showContent, symbols: option.series[0].showSymbol, large: option.series[0].large, type: option.series[0].type };
      };
      const inspectCross = async () => {
        const labelsBefore = chart.getZr().storage.getDisplayList().filter(el => el.type === 'tspan').length;
        chart.dispatchAction({ type: 'updateAxisPointer', x: 413, y: 213 });
        await pause();
        chart.getZr().flush();
        const display = chart.getZr().storage.getDisplayList(true);
        const lines = display.filter(el => el.type.toLowerCase() === 'line').map(el => el.shape);
        const option = chart.getOption().tooltip[0];
        return {
          vertical: lines.some(s => Math.abs(s.x1 - 413) <= 1 && s.x1 === s.x2 && Math.abs(s.y2 - s.y1) > 100),
          horizontal: lines.some(s => Math.abs(s.y1 - 213) <= 1 && s.y1 === s.y2 && Math.abs(s.x2 - s.x1) > 100),
          extraLabels: display.filter(el => el.type === 'tspan').length - labelsBefore,
          popup: option.showContent,
          trigger: option.trigger,
        };
      };
      const initial = state();
      const denseCross = await inspectCross();
      chart.dispatchAction({ type: 'dataZoom', startValue: start, endValue: start + 2999 * 1000 });
      await pause();
      const boundary = state();
      const renderedSymbols = chart.getZr().storage.getDisplayList().filter(el => el.type === 'path').length;
      chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 100 });
      await pause();
      const text = document.body.textContent;
      const readoutEl = document.querySelector('.chart-readout');
      const readout = { shown: !readoutEl.hidden, text: readoutEl.textContent };
      chart.dispatchAction({ type: 'dataZoom', startValue: start, endValue: start + 3000 * 1000 });
      await pause();
      const over = state();
      chart.dispatchAction({ type: 'dataZoom', batch: [{ start: 0, end: 0.1 }] });
      await pause();
      const wheel = state();
      document.querySelector('.chart-mode').click();
      await pause();
      const scatter = state();
      document.querySelector('.chart-reset').click();
      await pause();
      const reset = state();
      const resetCross = await inspectCross();
      document.querySelector('.chart-mode').click();
      await pause();
      const lineReset = state();
      // Category axes, gaps and hidden series share the same detail gate.
      window.postMessage({ command: 'chart', xColumn: 'label', yColumns: ['a', 'b'], columns: ['label', 'a', 'b'], rows: Array.from({ length: 4000 }, (_, i) => ['row' + i, i, i < 2000 ? null : i]), xAxisMode: 'category', truncated: false, maxPoints: 200000 }, '*');
      await pause();
      const categoryChart = viewerTest.testChart();
      categoryChart.dispatchAction({ type: 'dataZoom', startValue: 0, endValue: 1999 });
      await pause();
      const category = categoryChart.getOption().tooltip[0].showContent;
      categoryChart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
      categoryChart.dispatchAction({ type: 'legendUnSelect', name: 'a' });
      // legendUnSelect emits legendunselected, whereas a click emits legendselectchanged.
      categoryChart.dispatchAction({ type: 'legendToggleSelect', name: 'a' });
      categoryChart.dispatchAction({ type: 'legendToggleSelect', name: 'a' });
      await pause();
      const hidden = categoryChart.getOption().tooltip[0].showContent;
      return { readout, initial, boundary, over, wheel, scatter, reset, lineReset, renderedSymbols, text, category, hidden, denseCross, resetCross };
    });
    for (const cross of [result.denseCross, result.resetCross]) {
      assert.equal(cross.vertical, true, JSON.stringify(cross));
      assert.equal(cross.horizontal, true, JSON.stringify(cross));
      assert.equal(cross.extraLabels, 0);
      assert.equal(cross.popup, false);
      assert.equal(cross.trigger, 'none');
    }
    assert.equal(result.initial.tooltip, false);
    assert.equal(result.initial.symbols, false);
    assert.equal(result.boundary.tooltip, true);
    assert.equal(result.boundary.symbols, true);
    assert.ok(result.renderedSymbols >= 3000, JSON.stringify(result));
    assert.ok(result.text.includes('1.23456789012345'));
    assert.ok(result.text.includes('2020-01-01T00:01:40.000Z'));
    // The exact value and timestamp live in the corner readout; the hover popup is rounded and short.
    assert.equal(result.readout.shown, true);
    assert.ok(result.readout.text.includes('1.23456789012345') && result.readout.text.includes('2020-01-01T00:01:40.000Z'), result.readout.text);
    const popupOnly = result.text.replace(result.readout.text, '');
    assert.ok(!popupOnly.includes('1.23456789012345') && !popupOnly.includes('2020-01-01T00:01:40.000Z'), 'popup must not repeat exact values');
    assert.ok(popupOnly.includes('1.235'), 'popup shows four significant digits');
    assert.equal(result.over.tooltip, false);
    assert.equal(result.wheel.tooltip, true);
    assert.equal(result.scatter.type, 'scatter');
    assert.equal(result.scatter.large, false);
    assert.equal(result.reset.tooltip, false);
    assert.equal(result.reset.large, true);
    assert.equal(result.lineReset.symbols, false);
    assert.equal(result.category, true);
    assert.equal(result.hidden, true);
    const drag = await page.evaluate(() => {
      const chart = viewerTest.testChart();
      chart.dispatchAction({ type: 'legendToggleSelect', name: 'a' });
      chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
      const rect = document.querySelector('.chart-canvas').getBoundingClientRect();
      return [500, 700].map(x => {
        const point = chart.convertToPixel({ gridIndex: 0 }, [x, 1000]);
        return { x: rect.left + point[0], y: rect.top + point[1] };
      });
    });
    await page.mouse.move(drag[0].x, drag[0].y);
    await page.mouse.down();
    await page.mouse.move(drag[1].x, drag[1].y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => viewerTest.testChart().getOption().tooltip[0].showContent), true);
    await page.locator('.chart-reset').click();
    assert.equal(await page.evaluate(() => viewerTest.testChart().getOption().tooltip[0].showContent), false);
    const box = await page.locator('.chart-canvas').boundingBox();
    await page.mouse.move(box.x + 413, box.y + 213);
    await page.waitForTimeout(100);
    const mouseCross = await page.evaluate(() => {
      const chart = viewerTest.testChart();
      const lines = chart.getZr().storage.getDisplayList(true)
        .filter(el => el.type.toLowerCase() === 'line').map(el => el.shape);
      const popups = [...document.querySelectorAll('div')].filter(el =>
        el.style.position === 'absolute' && el.textContent.includes('row') &&
        getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none');
      return {
        vertical: lines.some(s => Math.abs(s.x1 - 413) <= 1 && s.x1 === s.x2 && Math.abs(s.y2 - s.y1) > 100),
        horizontal: lines.some(s => Math.abs(s.y1 - 213) <= 1 && s.y1 === s.y2 && Math.abs(s.x2 - s.x1) > 100),
        popups: popups.length,
        emphasis: chart.getOption().axisPointer[0].triggerEmphasis,
      };
    });
    assert.deepEqual(mouseCross, { vertical: true, horizontal: true, popups: 0, emphasis: false });

    // PLOT-01: R-reference styling, theme, zoom/reset, hover and escaping on the live chart.
    await page.addStyleTag({ path: 'media/main.css' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => {
      document.body.style.background = '#1e1e1e';
      document.getElementById('chart-root').className = 'chart-root';
    });
    const r = await page.evaluate(async () => {
      const pause = () => new Promise(resolve => setTimeout(resolve, 80));
      const day = 86400000, t0 = Date.UTC(2010, 0, 1);
      const rows = Array.from({ length: 40 }, (_, i) => [new Date(t0 + i * day).toISOString(), i === 3 ? null : i * 0.25 - 2, 10 + (i % 7)]);
      window.postMessage({ command: 'chart', xColumn: 'd', yColumns: ['a', 'b'], columns: ['d', 'a', 'b'], rows, xAxisMode: 'time', truncated: false, maxPoints: 1000 }, '*');
      await pause();
      const two = viewerTest.testChart();
      const t = two.getOption();
      const all = rows.flatMap(r => [r[1], r[2]]).filter(v => v !== null);
      const ext = viewerTest.finiteExtent(all);
      const want = viewerTest.padValueRange(ext);
      const wantTicks = viewerTest.evenBreaks(ext.lo, ext.hi, 8);
      const xwant = viewerTest.padTimeRange(viewerTest.finiteExtent(rows.map(r => Date.parse(r[0]))));
      const detail = {
        series: t.series.map(s => ({ colour: s.lineStyle.color, width: s.lineStyle.width, symbol: s.showSymbol, connect: s.connectNulls })),
        y: { min: t.yAxis[0].min, max: t.yAxis[0].max, ticks: t.yAxis[0].axisLabel.customValues, want, wantTicks },
        x: { min: t.xAxis[0].min, max: t.xAxis[0].max, want: xwant },
        chrome: {
          background: t.backgroundColor,
          axisFont: [t.yAxis[0].axisLabel.fontFamily, t.yAxis[0].axisLabel.fontSize],
          axisLine: [t.yAxis[0].axisLine.lineStyle.width, t.yAxis[0].axisLine.lineStyle.color, t.xAxis[0].axisLine.onZero],
          split: [t.yAxis[0].splitLine.lineStyle.color, t.yAxis[0].splitLine.lineStyle.width],
          legend: [t.legend[0].textStyle.fontSize, t.legend[0].bottom],
          grid: [t.grid[0].left, t.grid[0].right, t.grid[0].containLabel],
          tooltip: [t.tooltip[0].transitionDuration, t.tooltip[0].borderColor, t.tooltip[0].textStyle.fontSize, t.tooltip[0].axisPointer.snap, t.tooltip[0].axisPointer.crossStyle.color],
          zoomType: t.dataZoom.map(z => z.type), brush: t.brush[0].brushType,
        },
        rootBackground: getComputedStyle(document.getElementById('chart-root')).backgroundColor,
        titleFont: getComputedStyle(document.querySelector('.chart-title')).fontFamily + '|' + getComputedStyle(document.querySelector('.chart-title')).fontWeight,
      };
      // Hover: the detail popup shows exact values and escapes a hostile series name.
      window.postMessage({ command: 'chart', xColumn: 'd', yColumns: ['<img src=x onerror=window.__pwned=1>'], columns: ['d', '<img src=x onerror=window.__pwned=1>'], rows: rows.map(r => [r[0], r[2]]), xAxisMode: 'time', truncated: false, maxPoints: 1000 }, '*');
      await pause();
      const hostile = viewerTest.testChart();
      hostile.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 5 });
      await pause();
      detail.hover = { images: document.querySelectorAll('img').length, text: document.body.textContent.includes('<img src=x onerror=window.__pwned=1>'), pwned: window.__pwned === 1, single: hostile.getOption().series[0].lineStyle.color, legend: hostile.getOption().legend[0] };
      return detail;
    });
    assert.deepEqual(r.series.map(s => s.colour), ['#F8766D', '#00BFC4']);
    assert.deepEqual(r.series.map(s => [s.width, s.symbol, s.connect]), [[1.4, true, true], [1.4, true, true]]);
    assert.equal(r.y.min, r.y.want.min); assert.equal(r.y.max, r.y.want.max);
    assert.deepEqual(r.y.ticks, r.y.wantTicks);
    assert.equal(r.y.ticks.length, 8);
    assert.equal(r.x.min, r.x.want.min); assert.equal(r.x.max, r.x.want.max);
    assert.deepEqual(r.chrome, {
      background: '#ffffff', axisFont: ['serif', 10], axisLine: [1.5, '#000000', false],
      split: ['#e5e5e5', 0.5], legend: [11, 0], grid: [10, 10, true],
      tooltip: [0, '#000000', 11, true, '#000000'], zoomType: ['inside'], brush: 'lineX',
    });
    // The page stays white and serif under a dark editor theme: the chart is a figure.
    assert.equal(r.rootBackground, 'rgb(255, 255, 255)');
    assert.match(r.titleFont, /serif\|(700|bold)/);
    assert.deepEqual(r.hover.images, 0);
    assert.equal(r.hover.text, true);
    assert.equal(r.hover.pwned, false);
    assert.equal(r.hover.single, '#F8766D', 'a lone series takes the first hue_pal colour, not navy');
    assert.equal(r.hover.legend, undefined, 'a lone series has no legend');

    // The corner readout sits where the data is not: a rising ramp fills bottom-left to top-right, so no point may lie under it.
    await page.evaluate(() => {
      window.postMessage({ command: 'chart', xColumn: 'd', yColumns: ['a'], columns: ['d', 'a'], rows: Array.from({ length: 40 }, (_, i) => [new Date(Date.UTC(2010, 0, 1) + i * 86400000).toISOString(), i]), xAxisMode: 'time', truncated: false, maxPoints: 1000 }, '*');
    });
    await page.waitForTimeout(150);
    const corner = await page.evaluate(async () => {
      const chart = viewerTest.testChart();
      chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 20 });
      await new Promise((r) => setTimeout(r, 100));
      const el = document.querySelector('.chart-readout');
      const box = el.getBoundingClientRect();
      const origin = chart.getDom().getBoundingClientRect();
      const under = Array.from({ length: 40 }, (_, i) => chart.convertToPixel({ gridIndex: 0 }, [Date.UTC(2010, 0, 1) + i * 86400000, i]))
        .filter((p) => origin.left + p[0] >= box.left && origin.left + p[0] <= box.right && origin.top + p[1] >= box.top && origin.top + p[1] <= box.bottom).length;
      return { hidden: el.hidden, under, width: box.width };
    });
    assert.equal(corner.hidden, false);
    assert.ok(corner.width > 0);
    assert.equal(corner.under, 0, 'corner readout covers data points');
    // Zoom/reset with real input: a double-click on the plot resets, one on the legend does not.
    await page.evaluate(() => {
      window.postMessage({ command: 'chart', xColumn: 'd', yColumns: ['a', 'b'], columns: ['d', 'a', 'b'], rows: Array.from({ length: 40 }, (_, i) => [new Date(Date.UTC(2010, 0, 1) + i * 86400000).toISOString(), i, 40 - i]), xAxisMode: 'time', truncated: false, maxPoints: 1000 }, '*');
    });
    await page.waitForTimeout(150);
    const range = () => page.evaluate(() => { const z = viewerTest.testChart().getOption().dataZoom[0]; return [Math.round(z.start), Math.round(z.end)]; });
    const zoomIn = () => page.evaluate(() => viewerTest.testChart().dispatchAction({ type: 'dataZoom', start: 20, end: 60 }));
    const canvasBox = await page.locator('.chart-canvas').boundingBox();
    const inPlot = await page.evaluate(() => { const p = viewerTest.testChart().convertToPixel({ gridIndex: 0 }, [Date.UTC(2010, 0, 20), 20]); return { x: p[0], y: p[1] }; });
    await zoomIn(); await page.waitForTimeout(100);
    assert.deepEqual(await range(), [20, 60]);
    await page.mouse.dblclick(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height - 12);
    await page.waitForTimeout(150);
    assert.deepEqual(await range(), [20, 60], 'a double-click on the legend must not reset the zoom');
    await page.mouse.dblclick(canvasBox.x + inPlot.x, canvasBox.y + inPlot.y);
    await page.waitForTimeout(150);
    assert.deepEqual(await range(), [0, 100], 'a double-click inside the plot resets the zoom');
    await zoomIn(); await page.waitForTimeout(100);
    await page.locator('.chart-reset').click();
    await page.waitForTimeout(100);
    assert.deepEqual(await range(), [0, 100]);
    // Snap is on while the detail popup is, as in helpers_echarts.R.
    assert.equal(await page.evaluate(() => viewerTest.testChart().getOption().tooltip[0].axisPointer.snap), true);
    // Styled page: the corner readout must never take the pointer from the chart.
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.chart-readout')).pointerEvents), 'none');
    assert.deepEqual(errors, []);
    console.log('Chrome chart checks passed: 200,000 points, exact tooltip, markers, threshold, wheel/brush/reset, scatter, categories, gaps and legend.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
