// Real Rust chart SQL -> provider -> ChartPanel -> actual ECharts canvas.
// Only VS Code webview transport is substituted; chart requests/results are forwarded unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const stub = require('../../out-test/test/stress/stubs/vscode');
const vscode = stub.default;
const { DuckDBDocument, DuckDBEditorProvider } = require('../../out-test/src/duckdbEditorProvider');
const { selectBackend } = require('../../out-test/src/backend/nativeSelect');
const { NativeError } = require('../../out-test/src/backend/native');
const { duckdbFile, xlsxFile } = require('../../out-test/test/stress/generators/_write');

(async () => {
  assert.equal(process.env.DFV_BACKEND, 'native');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-native-plot-'));
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  const originalCreate = vscode.window.createWebviewPanel;
  const panels = [], errors = [], outbound = [], gridReplies = [], requests = [], chartFailures = [];
  let document;
  const report = {checks:[], gridRenderMs:[]};
  const check = async (name, run) => { try { await run(); report.checks.push(name); } catch(error) { console.error(JSON.stringify({failed:name,chart:panels.at(-1)?.messages.at(-1),nativeErrors:chartFailures.map(e=>({code:e.code,message:e.message})),gridErrors:gridReplies.filter(m=>m.command==='error')})); throw error; } };
  try {
    const bundle = async (file, hooks, globalName) => (await esbuild.build({stdin:{contents:await fs.readFile(file,'utf8')+hooks,resolveDir:path.resolve('src'),loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser',globalName})).outputFiles[0].text;
    const gridBundle = await bundle('src/webview.ts','\nexport function inspectPaintedExecution(){return data.state.paintedExecution}\n','plotGrid');
    const chartBundle = await bundle('src/chartView.ts','\nexport function inspectChart(){return chart}\n','nativeChart');
    const observe = async page => {
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => { outbound.push(route.request().url()); return route.abort(); });
    };
    vscode.window.createWebviewPanel = () => {
      const view = {messages:[],receiver:undefined,page:undefined,disposers:[]};
      view.ready = (async () => {
        view.page = await browser.newPage({viewport:{width:1100,height:760},timezoneId:'Europe/Madrid'});
        await observe(view.page);
        await view.page.exposeFunction('chartHost', message => view.receiver?.(message));
        await view.page.setContent('<div id="chart-root" class="chart-root"></div>');
        await view.page.addStyleTag({path:'media/main.css'});
        await view.page.evaluate(() => {window.acquireVsCodeApi=()=>({postMessage:message=>void window.chartHost(message)});});
        await view.page.addScriptTag({content:chartBundle});
      })();
      const panel = {title:'',viewColumn:2,reveal(){},dispose(){for(const fn of view.disposers) fn();},onDidDispose(fn){view.disposers.push(fn);return{dispose(){}};},webview:{
        cspSource:'vscode-resource:',asWebviewUri:uri=>uri,html:'',
        onDidReceiveMessage(fn){view.receiver=fn;return{dispose(){}};},
        async postMessage(message){view.messages.push(message);await view.ready;if(!view.page.isClosed())await view.page.evaluate(value=>window.postMessage(value,'*'),message);return true;},
      }};
      view.panel=panel;panels.push(view);return panel;
    };
    const source = path.join(dir,'plot.duckdb');
    await duckdbFile(source,[
      {name:'nodate',columns:[{name:'id',type:'INTEGER'},{name:'Row',type:'DOUBLE'}],rows:[[1,10],[2,null],[3,30],[4,40]]},
      {name:'iso',columns:[{name:'seq',type:'INTEGER'},{name:'opened_at',type:'VARCHAR'},{name:'v',type:'DOUBLE'}],rows:[[1,'2024-01-03',3],[2,null,9],[3,'2024-01-01',1]]},
      {name:'bad_dates',columns:[{name:'opened_at',type:'VARCHAR'},{name:'v',type:'DOUBLE'}],rows:[['2024-01-01',1],['03/04/2024',2]]},
    ]);
    const original = await fs.readFile(source);
    const backend = selectBackend(process.cwd(),{...process.env,DFV_TABLE_STATE_DIR:path.join(dir,'state')});
    let file, provider, page, handler;
    const mount = async src => {
      if (document) { await document.session.close(); await page.close(); }
      file = await backend.open(src);assert.equal(file.constructor.name,'NativeDocument');
      const chartQuery = file.runChartQuery.bind(file);
      file.runChartQuery = (...args) => chartQuery(...args).catch(error=>{chartFailures.push(error);throw error;});
      document = new DuckDBDocument(vscode.Uri.file(src),file,undefined,undefined,backend);
      provider = new DuckDBEditorProvider({extensionUri:vscode.Uri.file(process.cwd())},backend);
      page = await browser.newPage({viewport:{width:1400,height:900}});await observe(page);
      const webview = {cspSource:'vscode-resource:',asWebviewUri:uri=>uri,onDidReceiveMessage(fn){handler=fn;return{dispose(){}};},
        async postMessage(message){
          gridReplies.push(message);
          if(!page.isClosed()) {
            const ms = await page.evaluate(value=>new Promise(resolve=>{
              const started=performance.now();window.postMessage(value,'*');
              if(value.command==='queryResult') requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-started)));
              else resolve(null);
            }),message);
            if(ms!==null) report.gridRenderMs.push(ms);
          }
          return true;
        }};
      await provider.resolveCustomEditor(document,{webview,onDidDispose:()=>({dispose(){}})});
      await page.exposeFunction('sendToHost',async message=>{requests.push(message);await handler(message);});
      await page.setContent('<div id="root"></div>');await page.addStyleTag({path:'media/main.css'});
      await page.evaluate(()=>{window.acquireVsCodeApi=()=>({postMessage:message=>void window.sendToHost(message)});});
      await page.addScriptTag({content:gridBundle});
      await page.waitForFunction(()=>plotGrid.inspectPaintedExecution()>0 && document.querySelector('#run-btn').textContent.includes('Run'));
    };
    await mount(source);
    const run = async sql => {
      const prior = await page.evaluate(()=>plotGrid.inspectPaintedExecution());
      await page.locator('.cm-content').fill(sql);await page.locator('#run-btn').click();
      await page.waitForFunction(previous=>plotGrid.inspectPaintedExecution()>previous && document.querySelector('#run-btn').textContent.includes('Run'),prior);
    };
    const plot = async column => {
      const count = panels.reduce((n,p)=>n+p.messages.length,0);
      await page.locator(`.th-plot-btn[title^="Plot ${column} against"]`).click();
      const deadline=Date.now()+10000;
      while(panels.reduce((n,p)=>n+p.messages.length,0)===count){assert.ok(Date.now()<deadline,'provider chart result');await new Promise(resolve=>setTimeout(resolve,10));}
      const view=panels.find(p=>p.messages.length && p.messages.at(-1)!==p.lastSeen);
      view.lastSeen=view.messages.at(-1);await view.ready;
      await view.page.waitForFunction(()=>document.querySelector('canvas') || document.querySelector('.chart-canvas')?.textContent);
      return {view,message:view.lastSeen};
    };
    const rendered = async view => {
      await view.page.waitForFunction(()=>nativeChart.inspectChart()?.getOption().series?.[0]?.data?.length>0);
      return view.page.evaluate(()=>{
        const chart=nativeChart.inspectChart();chart.getZr().flush();
        const option=chart.getOption();
        return {axis:option.xAxis[0].type,labels:option.xAxis[0].data,series:option.series[0].data,
          shapes:chart.getZr().storage.getDisplayList(true).filter(el=>['path','polyline','ec-polyline'].includes(el.type)).length,
          canvas:[...document.querySelectorAll('canvas')].some(canvas=>canvas.width>0&&canvas.height>0),title:document.querySelector('.chart-title').textContent};
      });
    };
    // Coloured (non-grey) pixels inside the plot rectangle, per quarter: gridlines and text are grey, the series is not.
    const ink = view => view.page.evaluate(() => {
      const chart = nativeChart.inspectChart(); chart.getZr().flush();
      const canvas = document.querySelector('canvas'), k = canvas.width / canvas.clientWidth;
      const r = chart.getModel().getComponent('grid').coordinateSystem.getRect();
      const x0 = Math.round(r.x * k), y0 = Math.round(r.y * k), w = Math.round(r.width * k), h = Math.round(r.height * k);
      const data = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
      const q = {tl: 0, tr: 0, bl: 0, br: 0};
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 128 || Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) < 60) continue;
        q[(y < h / 2 ? 't' : 'b') + (x < w / 2 ? 'l' : 'r')]++;
      }
      return q;
    });
    await check('native row axis renders query order, null gaps and collision-safe row labels',async()=>{
      await run('SELECT "Row" FROM nodate WHERE id < 4 ORDER BY id DESC LIMIT 3;');
      const {view,message}=await plot('Row');
      assert.equal(requests.filter(m=>m.command==='chartQuery').at(-1).xIsRow,true);
      assert.equal(message.command,'chart');assert.equal(message.xColumn,'Row (2)');assert.equal(message.truncated,false);
      assert.deepEqual(message.rows,[[1,30],[2,null],[3,10]]);
      const result=await rendered(view);assert.equal(result.axis,'category');assert.deepEqual(result.labels,['1','2','3']);assert.deepEqual(result.series,[30,null,10]);assert.ok(result.canvas&&result.shapes>0);
      const q=await ink(view);assert.ok(q.tl+q.tr+q.bl+q.br>0,'series pixels reached the canvas '+JSON.stringify(q));
    });
    await check('native explicit date override renders ordered dates and truthful missing-date note',async()=>{
      await run('SELECT * FROM iso ORDER BY seq DESC;');await page.selectOption('#plot-axis','date:opened_at');
      const {view,message}=await plot('v');
      assert.equal(requests.filter(m=>m.command==='chartQuery').at(-1).xDateColumn,'opened_at');
      assert.equal(message.xAxisMode,'time');assert.equal(message.note,'1 row with no date left out');assert.equal(message.truncated,false);
      const result=await rendered(view);assert.equal(result.axis,'time');assert.deepEqual(result.series,[[Date.UTC(2024,0,1),1],[Date.UTC(2024,0,3),3]]);assert.ok(result.canvas&&result.shapes>0);assert.match(result.title,/1 row with no date left out/);
      const q=await ink(view);assert.ok(q.tl+q.tr+q.bl+q.br>0,'series pixels reached the canvas '+JSON.stringify(q));
    });
    await check('150000-point ramp (above the old 100000 backend cap) is delivered whole and painted corner to corner',async()=>{
      await run('SELECT range::DOUBLE AS v FROM range(150000) ORDER BY 1;');await page.selectOption('#plot-axis','row');
      const {view,message}=await plot('v');
      assert.equal(message.command,'chart');assert.equal(message.truncated,false);assert.equal(message.rows.length,150000);
      assert.deepEqual(message.rows[149999],[150000,149999]);
      const result=await rendered(view);assert.equal(result.series.length,150000);
      const q=await ink(view);assert.ok(q.bl>20&&q.tr>20,'ramp ink in both ends '+JSON.stringify(q));
      assert.ok(q.tl+q.br<=0.05*(q.bl+q.tr),'ramp leaves the opposite corners empty '+JSON.stringify(q));
    });
    await check('native chart cap refuses drawing a silently truncated prefix',async()=>{
      stub.settings.set('dataFileViewer.chartMaxPoints',2);
      await run('SELECT "Row" FROM nodate WHERE id < 4 ORDER BY id DESC;');await page.selectOption('#plot-axis','row');
      const {view,message}=await plot('Row');assert.equal(message.command,'chart');assert.equal(message.truncated,true);assert.equal(message.maxPoints,2);
      await view.page.waitForFunction(()=>!nativeChart.inspectChart()&&document.querySelector('.chart-canvas').textContent.includes('Too many points'));
      assert.equal(await view.page.locator('canvas').count(),0);
      stub.settings.delete('dataFileViewer.chartMaxPoints');
    });
    await check('configured chart cap above 200k is refused explicitly without clamping',async()=>{
      stub.settings.set('dataFileViewer.chartMaxPoints',200001);
      await run('SELECT "Row" FROM nodate ORDER BY id;');await page.selectOption('#plot-axis','row');
      const {view,message}=await plot('Row');assert.equal(message.command,'chartError');
      assert.ok(chartFailures.at(-1) instanceof NativeError);assert.equal(chartFailures.at(-1).code,'resource_limit');assert.match(chartFailures.at(-1).message,/200,000 points/);
      await view.page.waitForFunction(()=>!nativeChart.inspectChart()&&document.querySelector('.chart-canvas').textContent.length>0);
      assert.equal(await view.page.locator('canvas').count(),0);
      stub.settings.delete('dataFileViewer.chartMaxPoints');
    });
    await check('native malformed date override returns a typed refusal and visible chart error',async()=>{
      await run('SELECT * FROM bad_dates;');await page.selectOption('#plot-axis','date:opened_at');
      const {view,message}=await plot('v');assert.equal(message.command,'chartError');assert.ok(message.message.length>0);
      assert.ok(chartFailures.at(-1) instanceof NativeError);assert.equal(chartFailures.at(-1).code,'malformed_value');
      await view.page.waitForFunction(()=>!nativeChart.inspectChart()&&document.querySelector('.chart-canvas').textContent.length>0);
      assert.equal(await view.page.locator('canvas').count(),0);
    });
    await check('inline detected worksheet table plots its real numeric column through the native worker onto the canvas',async()=>{
      const book = path.join(dir,'sheet.xlsx');
      await xlsxFile(book,[{name:'Raw_Data',rows:[['Series','Description'],['example','Synthetic'],[],[null,'Date','value'],
        ...Array.from({length:300},(_,i)=>[null,new Date(Date.UTC(1989,6,1+i)).toISOString().slice(0,10),i])]}]);
      const bookBytes = await fs.readFile(book);
      await mount(book);
      await page.waitForFunction(()=>document.querySelectorAll('.sheet-table-plot').length>0);
      const count = panels.reduce((n,p)=>n+p.messages.length,0);
      await page.locator('.sheet-table-plot[title="Plot the rows shown for value"]').click();
      const deadline=Date.now()+10000;
      while(panels.reduce((n,p)=>n+p.messages.length,0)===count){assert.ok(Date.now()<deadline,'provider sheet chart result');await new Promise(resolve=>setTimeout(resolve,10));}
      const view=panels.find(p=>p.messages.length && p.messages.at(-1)!==p.lastSeen);view.lastSeen=view.messages.at(-1);await view.ready;
      assert.equal(view.lastSeen.command,'chart');assert.equal(view.lastSeen.truncated,false);const shown=view.lastSeen.rows.length;assert.ok(shown>1&&shown<=300);
      assert.equal(view.lastSeen.xAxisMode,'time');
      const result=await rendered(view);assert.equal(result.axis,'time');assert.equal(result.series.length,shown);assert.equal(result.series[shown-1][1],shown-1);assert.ok(result.canvas&&result.shapes>0);
      const q=await ink(view);assert.ok(q.bl>20&&q.tr>20&&q.tl+q.br<=0.05*(q.bl+q.tr),'worksheet ramp painted '+JSON.stringify(q));
      assert.deepEqual(await fs.readFile(book),bookBytes);
    });
    assert.deepEqual(await fs.readFile(source),original);assert.deepEqual(outbound,[]);assert.deepEqual(errors,[]);
    assert.deepEqual(gridReplies.filter(message=>message.command==='error'),[]);
    report.result='pass';console.log(JSON.stringify(report));
  } finally {
    vscode.window.createWebviewPanel=originalCreate;stub.settings.delete('dataFileViewer.chartMaxPoints');
    await document?.session.close();await browser.close();await fs.rm(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
