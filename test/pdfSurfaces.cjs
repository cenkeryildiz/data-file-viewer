// Exercise the original search/transition controllers with fixture engine replies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const staticDir = process.argv[2], shots = process.argv[3];
assert(staticDir, 'Usage: node test/pdfSurfaces.cjs <media/pdf/web/static> [screenshots directory]');
const read = file => fs.readFileSync(path.join(staticDir, file), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Upstream surface changed: ${start}`);
  return source.slice(a,b);
}
(async () => {
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage({viewport:{width:1200,height:850}}), errors=[];
    await page.emulateMedia({reducedMotion:'reduce'});
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent(read('index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
    await page.addStyleTag({content:read('style.css')});
    const layer=path.join(__dirname,'../media/pdf-vscode');
    for(const file of fs.readdirSync(layer).filter(f=>f.endsWith('.css')).sort()) await page.addStyleTag({content:fs.readFileSync(path.join(layer,file),'utf8')});
    await page.evaluate(() => {
      document.body.className='vscode-light';
      const vars={'sideBar-background':'#f8f9fb','editorWidget-background':'#ffffff','editor-background':'#e7e9ee',foreground:'#252a34',descriptionForeground:'#5d6675','input-background':'#ffffff','input-foreground':'#252a34','input-border':'#9aa4b3',focusBorder:'#2458c5','button-background':'#2458c5','button-foreground':'#ffffff','button-hoverBackground':'#1d47a3'};
      for(const [k,v] of Object.entries(vars)) document.documentElement.style.setProperty('--vscode-'+k,v);
      document.getElementById('docname').textContent='UI preview · sample search and editing surfaces';
      document.getElementById('sidebar').classList.add('hidden'); document.getElementById('sidebar-resize').classList.add('panel-collapsed');
      document.getElementById('pages').innerHTML='<article class="page" style="width:600px;height:720px;padding:56px;color:#252a34;font:17px/1.8 Georgia,serif"><p style="font:11px system-ui;letter-spacing:2px">SAMPLE DOCUMENT · UI PREVIEW</p><h1 style="font-size:36px;line-height:1.2;font-weight:500">Space to think.<br>Room to read.</h1><p>Good design gives the important things room to breathe.</p><p>Find an idea, keep a note, or make a considered change without losing your place.</p></article>';
    });
    const lightStyle=await page.locator('html').getAttribute('style');
    await page.addScriptTag({content:`(() => {
      ${section(read('workspace.js'),"  const finder = document.createElement('dialog');",'  finder.querySelector(\'#find-outline-open\').onclick')}
      finder.style.top='110px';
    })();`});
    await page.addScriptTag({content:read('viewerSearch.js')});
    await page.addScriptTag({content:`const TRANSITION = {}; ${section(read('viewer.js'),'function transitionDialog()','\n/* Where the user was typing')}`});
    await page.evaluate(() => {
      window.navigations=[]; window.calls=[];
      const finder=document.getElementById('document-finder');
      window.search=PDFSearch.mountPanel({finder,
        doc:()=>({doc:'fixture',revision:0,pages:3,pageGeo:()=> 'geo'}),
        request:async (op,params)=>{
          calls.push({op,params});
          if(op==='get_capabilities') return {search:{scopes:['text'],case_sensitive:false,whole_word:false}};
          if(op==='start_search') return {doc:'fixture',revision:0,search_id:'search',pages_total:3};
          if(op==='read_search') return {matches:[0,1].map(page=>({page,geo:'geo',snippet:{text:'Good design gives ideas room to breathe.',start:5,end:11},quads:[]})),next_cursor:null,pages_scanned:3,pages_total:3};
          if(op==='cancel_search') return {};
          throw Error('Unexpected operation '+op);
        },navigate:page=>navigations.push(page),shell:()=>null,page:()=>null,mounted:()=>false,mountedPages:()=>[]});
      finder.show(); search.opened();
    });
    await page.locator('#find-query').fill('design');
    await page.locator('#find-start').click();
    await page.waitForFunction(()=>document.querySelectorAll('#search-results button').length===2);
    assert(await page.locator('#find-case').isDisabled()); assert(await page.locator('#find-word').isDisabled());
    await page.locator('#search-results button').nth(1).click();
    assert.deepEqual(await page.evaluate(()=>navigations),[1]);
    assert.equal(await page.locator('#search-results button[aria-current="true"]').count(),1);
    assert.equal(await page.locator('#find-query').inputValue(),'design');
    if(shots) {fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,'search-light.png')});}
    for(const [width,height] of [[1200,850],[640,560],[320,640]]) {
      await page.setViewportSize({width,height});
      for(const selector of ['#find-query','#find-start','#find-next','#search-results button']) {
        const el=page.locator(selector).first(); await el.focus();
        const box=await el.boundingBox(); assert(box && box.x>=0 && box.x+box.width<=width+1 && box.y>=0 && box.y+box.height<=height+1,`${selector} outside ${width}×${height}`);
      }
    }
    console.log('PASS original search: retained query, disabled options, result selection and reachable controls to 320px');
    await page.setViewportSize({width:1200,height:850});
    await page.evaluate(()=>{
      document.body.className='vscode-dark';
      for(const [k,v] of Object.entries({'sideBar-background':'#1c1c1e','editorWidget-background':'#2c2c2e','editor-background':'#18181b',foreground:'#f2f2f7',descriptionForeground:'#a1a1aa','input-background':'#1c1c1e','input-foreground':'#f2f2f7','input-border':'#77777e'})) document.documentElement.style.setProperty('--vscode-'+k,v);
    });
    if(shots) {
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({path:path.join(shots,'search-dark.png')});
    }
    await page.evaluate(()=>document.getElementById('document-finder').close());
    await page.evaluate(()=>{
      document.body.className='vscode-light';
      for(const [k,v] of Object.entries({'sideBar-background':'#f8f9fb','editorWidget-background':'#ffffff','editor-background':'#e7e9ee',foreground:'#252a34',descriptionForeground:'#5d6675','input-background':'#ffffff','input-foreground':'#252a34','input-border':'#9aa4b3'})) document.documentElement.style.setProperty('--vscode-'+k,v);
    });
    await page.setViewportSize({width:1000,height:750});
    await page.evaluate(()=>{
      window.choice=null;
      transitionDialog().ask({message:'Apply this prepared change, discard it, or return to your source.',apply:true}).then(value=>window.choice=value);
    });
    assert.equal(await page.evaluate(()=>document.activeElement.id),'editor-transition-keep');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>choice==='keep');
    assert.equal(await page.evaluate(()=>choice),'keep');
    await page.evaluate(()=>{transitionDialog().close();transitionDialog().ask({message:'Preview is being prepared. Your source is still here.',apply:false});});
    assert(await page.locator('#editor-transition-apply').isDisabled());
    await page.locator('#editor-transition-keep').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'editor-transition-discard');
    if(shots) await page.screenshot({path:path.join(shots,'confirmation-light.png')});
    await page.setViewportSize({width:320,height:640});
    await page.evaluate(()=>{
      document.documentElement.style.fontSize='32px';
      transitionDialog().show({message:'Your source is retained. '.repeat(80),apply:false});
    });
    await page.locator('#editor-transition-keep').focus();
    const keep=await page.locator('#editor-transition-keep').boundingBox();
    assert(keep && keep.x>=0 && keep.x+keep.width<=321 && keep.y>=0 && keep.y+keep.height<=641,'Long confirmation must keep its safe action reachable');
    await page.evaluate(()=>{transitionDialog().close();document.documentElement.style.fontSize='16px';});
    await page.setViewportSize({width:1000,height:750});
    console.log('PASS original transition: Keep editing focus, safe Escape, disabled Apply and keyboard containment');
    await page.addScriptTag({content:`(() => {
      const probe={font_name:'Sample document font',font_size:12,text:'A considered change.'};
      const cls='ok',note='Original font',para=null,pageIndex=0,escapeHtml=s=>String(s);
      ${section(read('viewer.js'),'  const box = document.createElement("div");\n  box.id = "editor";','  globalThis.PDFDraftRecovery?.legacyOpened(box,pageIndex);')}
      box.style.top='70px';box.style.left='16px';
    })();`});
    await page.locator('#espan').fill('Keep my exact source: α + β');
    for(const [width,height] of [[1000,750],[640,480],[320,640]]) {
      await page.setViewportSize({width,height});
      await page.locator('#ereplace').focus();
      const box=await page.locator('#ereplace').boundingBox(); assert(box && box.x>=0 && box.x+box.width<=width+1 && box.y+box.height<=height+1,'Fallback action must stay reachable');
      assert.equal(await page.locator('#espan').inputValue(),'Keep my exact source: α + β');
    }
    await page.setViewportSize({width:1000,height:750});
    if(shots) {
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({path:path.join(shots,'editing-fallback-light.png')});
    }
    await page.evaluate(()=>{
      document.body.className='vscode-high-contrast';
      for(const [k,v] of Object.entries({'sideBar-background':'#000000','editorWidget-background':'#000000',foreground:'#ffffff',contrastBorder:'#ffff00',focusBorder:'#ffff00','input-background':'#000000','input-foreground':'#ffffff'})) document.documentElement.style.setProperty('--vscode-'+k,v);
    });
    assert.equal(await page.locator('#editor').evaluate(e=>getComputedStyle(e).boxShadow),'none');
    assert.notEqual(await page.locator('#editor').evaluate(e=>getComputedStyle(e).borderTopColor),'rgba(0, 0, 0, 0)');
    console.log('PASS fallback editor: preserved source, scrolling actions and explicit high-contrast edges');
    await page.evaluate(style=>{
      document.documentElement.setAttribute('style',style);document.body.className='vscode-light';
      document.getElementById('editor').remove();
      window.scheduleMaintain=()=>{}; window.PDFUI={documentChanged(){},revisionChanged(){}};
      window.S={doc:{doc:'fixture',pages:Array.from({length:3},(_,index)=>({index,geo:'geo'}))},revision:0};
      window.NOTES={drafts:new Map(),byXref:new Map()};
      window.exactSource='Source stays exact: α + β\n  Indentation stays too.\nDo not apply this checkpoint automatically.';
      window.recoveryCalls=[];
      window.api=async(op,params)=>{
        recoveryCalls.push(op);
        if(op==='list_drafts')return {records:[{updated:1793354400,source_matches:true,draft:{id:'sample',generation:1,kind:'paragraph',page:0,source:exactSource}}]};
        if(op==='get_page_lines')return {page:params.page,geo:'geo',lines:[{chars:[...'Read in engine order.'].map(c=>({c}))},{chars:[...'Keep α and β.'].map(c=>({c}))}]};
        throw Error('Unexpected engine write '+op);
      };
      const input=document.createElement('input');input.id='page-number';input.value='1';input.type='hidden';document.body.append(input);
    },lightStyle);
    await page.addScriptTag({content:read('viewerInspector.js')});
    await page.addScriptTag({content:read('viewerDraftRecovery.js')});
    await page.locator('#recover-drafts').click();
    await page.waitForFunction(()=>document.querySelector('#draft-records button'));
    assert(await page.locator('#draft-discard').isDisabled());
    await page.locator('#draft-records button').click();
    assert.equal(await page.locator('#recovered-source').inputValue(),await page.evaluate(()=>exactSource));
    assert.equal(await page.locator('#recovered-source').getAttribute('readonly'),'');
    await page.locator('#draft-select-source').click();
    assert(await page.locator('#recovered-source').evaluate(el=>el.selectionStart===0 && el.selectionEnd===el.value.length));
    assert((await page.evaluate(()=>recoveryCalls)).every(op=>op==='list_drafts'));
    for(const [width,height] of [[1000,750],[320,640]]) {
      await page.setViewportSize({width,height});
      await page.locator('#draft-select-source').focus();
      const b=await page.locator('#draft-select-source').boundingBox();assert(b && b.x>=0 && b.x+b.width<=width+1 && b.y+b.height<=height+1);
    }
    await page.setViewportSize({width:1000,height:750});
    if(shots){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:path.join(shots,'recovery-light.png')});}
    await page.locator('#draft-recovery button[aria-label="Close draft recovery"]').click();
    console.log('PASS original recovery: exact readonly source, select/copy preparation, reachable controls and no engine writes');
    assert(!read('index.html').includes('src="/static/viewerReading.js"'), 'Read text is not loaded');
    assert.equal(await page.locator('#reading-toggle').count(),0);
    await page.evaluate(()=>{
      window.SEL={generation:1,page:0,chars:[],range:[0,1],dragging:false};SEL.chars.geo='geo';
      window.MARKUP={active:null,busy:false};
      window.editorOpen=()=>false;
      window.selectionRects=()=>[[10,10,40,20]];window.clearSelection=()=>{SEL.range=null;};
      window.copySelection=async()=>{};window.applyMark=async()=>{};
      window.attempts=0;window.mutate=async()=>{attempts++;return null;};
      window.PDFDraftRecovery={newNoteOpened(){},changed(){},flush:async()=>{},newNoteClosed(){},newNoteRetain:async()=>false};
      const band=document.createElement('div');band.className='selband';band.style.cssText='position:absolute;left:60px;top:230px;width:180px;height:22px;background:#ffd76e88';
      document.querySelector('#pages .page').append(band);
    });
    await page.addScriptTag({content:read('viewerSelectionActions.js')});
    assert.equal(await page.locator('#selection-actions').count(),0);
    await page.evaluate(()=>PDFSelectionActions.openNote());
    assert(await page.locator('#selection-note').isVisible());
    assert(await page.locator('#selection-note-apply').isDisabled());
    assert(await page.locator('#selection-note-apply').evaluate(el=>{
      const style=getComputedStyle(el), probe=document.createElement('span');
      probe.style.background='var(--disabled-bg)';document.body.append(probe);
      const matches=style.backgroundColor===getComputedStyle(probe).backgroundColor;probe.remove();return matches;
    }), 'Disabled note Apply must use disabled colors');
    await page.locator('#selection-note-source').fill('Keep my note exactly: α + β');
    await page.locator('#selection-note-apply').click();
    await page.waitForFunction(()=>document.getElementById('selection-note-status').textContent.includes('retained'));
    assert(await page.locator('#selection-note-apply').isDisabled());
    assert.equal(await page.locator('#selection-note-source').inputValue(),'Keep my note exactly: α + β');
    await page.locator('#selection-note-keep').click();
    await page.waitForFunction(()=>document.getElementById('selection-note-status').textContent.includes('recovery is not confirmed'));
    assert(await page.locator('#selection-note').isVisible());assert.equal(await page.evaluate(()=>attempts),1);
    await page.setViewportSize({width:320,height:640});await page.locator('#selection-note-keep').focus();
    const noteButton=await page.locator('#selection-note-keep').boundingBox();assert(noteButton && noteButton.x>=0 && noteButton.x+noteButton.width<=321 && noteButton.y+noteButton.height<=641);
    await page.setViewportSize({width:1000,height:750});
    if(shots){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:path.join(shots,'selection-note-retained-light.png')});}
    assert.deepEqual(errors,[]);
    console.log('PASS toolbar notes: no selection popup, empty-note guard, retained source after refusal and failed recovery, one attempt');
    await page.locator('#selection-note-discard').click();
    await page.evaluate(()=>{
      document.getElementById('sidebar').classList.remove('hidden');document.getElementById('sidebar-resize').classList.remove('panel-collapsed');
      document.getElementById('pages-panel').hidden=true;document.getElementById('outline-panel').hidden=false;
      document.getElementById('sidebar-tab-pages').setAttribute('aria-selected','false');document.getElementById('sidebar-tab-pages').tabIndex=-1;
      document.getElementById('sidebar-tab-outline').setAttribute('aria-selected','true');document.getElementById('sidebar-tab-outline').tabIndex=0;
      window.outlineDestinations=[];window.outlineRequests=[];
    });
    await page.addScriptTag({content:read('outline.js')});
    await page.evaluate(()=>PdfOutline.mount(document.getElementById('outline-panel'),{
      getDocument:()=>({...S.doc,revision:0,layout:'layout',labels:['i','1','2']}),isVisible:()=>true,readingAnchor:()=>({page:0,x:0,y:0}),
      navigate:page=>outlineDestinations.push(page),request:async op=>{
        outlineRequests.push(op);if(op==='get_navigation')return{layout:'layout',outline:[[1,'Design & attention',1],[2,'A considered reading experience with a long heading',2],[1,'Notes for later — α + β',3]]};
        throw Error('Unexpected analysis '+op);
      }
    }));
    await page.waitForFunction(()=>document.querySelectorAll('#outline-tree [role="treeitem"]').length>=2);
    await page.locator('#outline-tree [role="treeitem"]').first().focus();await page.keyboard.press('ArrowRight');
    await page.waitForFunction(()=>document.querySelectorAll('#outline-tree [role="treeitem"]').length===3);
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(()=>outlineDestinations),[1]);
    await page.locator('#outline-filter').fill('α');
    assert.equal(await page.locator('#outline-tree [role="treeitem"]').count(),1);
    assert((await page.locator('#outline-tree').textContent()).includes('α + β'));
    await page.locator('#outline-filter').fill('');
    for(const sidebarWidth of [128,144,192,300]) {
      await page.evaluate(width=>document.documentElement.style.setProperty('--left-panel-w',width+'px'),sidebarWidth);
      assert.equal(Math.round((await page.locator('#sidebar').boundingBox()).width),sidebarWidth);
      assert(await page.locator('#outline-panel').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'Outline controls must wrap within the sidebar');
    }
    await page.evaluate(()=>document.documentElement.style.setProperty('--left-panel-w','144px'));
    if(shots){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:path.join(shots,'outline-live-light.png')});}
    assert.deepEqual(await page.evaluate(()=>outlineRequests),['get_navigation']);
    assert.deepEqual(errors,[]);
    console.log('PASS original outline: nested keyboard navigation, Unicode filter and 128–300px sidebar without analysis calls');
    await page.evaluate(()=>{
      document.getElementById('sidebar').classList.add('hidden');document.getElementById('sidebar-resize').classList.add('panel-collapsed');
      const panel=document.getElementById('notes');panel.classList.remove('hidden');
      panel.innerHTML='<div class="nhead">Comments</div><article class="note sel"><div class="nrow"><span class="nkind">Note</span><span class="npage">Page 1</span></div><div class="nbody"></div><div class="nwho"></div><div class="nacts"><button class="nact">Edit note</button><button class="nact">Reply</button><button class="nact danger">Delete</button></div></article>';
      panel.querySelector('.nbody').textContent='https://example.invalid/'+ 'unbroken-reference'.repeat(50);
      panel.querySelector('.nwho').textContent='A-very-long-author-name'.repeat(20);
    });
    for(const width of [260,304,420]) {
      await page.evaluate(width=>document.documentElement.style.setProperty('--right-panel-w',width+'px'),width);
      assert.equal(Math.round((await page.locator('#notes').boundingBox()).width),width);
      assert(await page.locator('#notes').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Long comment text must wrap within the panel');
      await page.locator('#notes .nact').first().focus();
      const box=await page.locator('#notes .nact').first().boundingBox();assert(box && box.x>=0 && box.x+box.width<=1001 && box.y+box.height<=751);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS comments: long unbroken references, authors and actions wrap at 260–420px without changing text');
    const marks = await browser.newPage({viewport:{width:1000,height:750}});
    await marks.setContent(read('index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
    await marks.addStyleTag({content:read('style.css')});
    await marks.addStyleTag({content:fs.readFileSync(path.join(layer,'interface.css'),'utf8')});
    await marks.evaluate(()=>{
      window.$=selector=>document.querySelector(selector);
      window.S={doc:{doc:'mark-doc',pages:[{geo:'mark-geo'}],palette:[[1,.86,.24],[.55,.86,.45],[.45,.74,.98],[.98,.62,.78],[.76,.62,.95]]},editOn:false};
      window.SEL={page:0,range:[0,1],chars:[]};SEL.chars.geo='mark-geo';
      window.rgb=c=>'rgb('+c.map(x=>Math.round(x*255)).join(',')+')';
      window.hasEditor=false;window.editorOpen=()=>hasEditor;window.requestEditorTransition=async()=>false;
      window.formulaMode=()=>{};window.applyStyle=()=>{};window.annotateStyleButtons=()=>{};window.toast=()=>{};
      window.markCalls=[];window.refuse=false;
      window.mutate=async(op,body)=>{markCalls.push({op,body});return refuse?null:{};};
      window.selectionRects=()=>[[10,10,40,20]];window.clearSelection=()=>{SEL.range=null;};
      window.selectionText=()=> 'Selected text';
      document.body.append(document.getElementById('markgroup'));
    });
    const source=read('viewer.js');
    await marks.addScriptTag({content:'const TEXT_COLORS=[]; '+section(source,'const MARKUP =','/* A selection has settled')+
      section(source,'function finishSelection()','async function copySelection()')+
      section(source,"document.addEventListener('copy'",'/* Text colours offered')+
      section(source,'async function applyMark(','/* ----------------------------- text editing')});
    await marks.evaluate(()=>buildMarkGroup());
    await marks.locator('#markup-menu-toggle').click();
    assert.deepEqual(await marks.locator('#markup-menu button').allTextContents(),['Yellow','Green','Blue','Pink','Purple','Underline','Strikethrough']);
    await marks.getByRole('menuitemradio',{name:'Green',exact:true}).click();
    await marks.waitForFunction(()=>markCalls.length===1 && !MARKUP.busy);
    assert.equal(await marks.evaluate(()=>MARKUP.active),null,'One-shot choice does not arm repeated markup');
    assert.deepEqual(await marks.evaluate(()=>markCalls[0].body.color),[.55,.86,.45]);
    await marks.locator('#markup-toggle').click();
    await marks.evaluate(()=>{SEL.range=[0,1];finishSelection();finishSelection();});
    await marks.waitForFunction(()=>markCalls.length===2 && !MARKUP.busy);
    await marks.locator('#markup-menu-toggle').click();
    await marks.getByRole('menuitemradio',{name:'Strikethrough',exact:true}).click();
    await marks.evaluate(()=>{SEL.range=[0,1];finishSelection();});
    await marks.waitForFunction(()=>markCalls.length===3 && !MARKUP.busy);
    assert.equal(await marks.evaluate(()=>markCalls[2].body.kind),'StrikeOut');
    await marks.locator('#markup-toggle').click();
    await marks.evaluate(()=>{SEL.range=[0,1];finishSelection();});
    assert.equal(await marks.evaluate(()=>markCalls.length),3,'Neutral selection never marks text');
    assert.equal(await marks.locator('#selection-actions').count(),0);
    await marks.locator('#markup-menu-toggle').click();
    await marks.keyboard.press('Home');assert.equal(await marks.evaluate(()=>document.activeElement.textContent),'Yellow');
    await marks.keyboard.press('End');assert.equal(await marks.evaluate(()=>document.activeElement.textContent),'Strikethrough');
    await marks.keyboard.press('Escape');assert.equal(await marks.locator('#markup-menu-toggle').getAttribute('aria-expanded'),'false');
    assert.equal(await marks.evaluate(()=>document.activeElement.id),'markup-menu-toggle');
    await marks.locator('#markup-menu-toggle').click();
    await marks.setViewportSize({width:320,height:750});
    await marks.waitForFunction(()=>document.getElementById('markup-menu').hidden);
    await marks.setViewportSize({width:1000,height:750});
    await marks.evaluate(()=>{const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:new DataTransfer()});document.getElementById('stage').dispatchEvent(event);window.copied=event.clipboardData.getData('text/plain');});
    assert.equal(await marks.evaluate(()=>copied),'Selected text');
    assert.equal(await marks.evaluate(()=>{
      const input=document.createElement('textarea');document.body.append(input);
      const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:new DataTransfer()});
      input.dispatchEvent(event);input.remove();return event.defaultPrevented;
    }),false,'Copying an editor/input keeps its native clipboard behavior');
    await marks.locator('#markup-toggle').click();
    await marks.evaluate(()=>{refuse=true;finishSelection();});
    await marks.waitForFunction(()=>markCalls.length===4 && !MARKUP.busy);
    assert.equal(await marks.evaluate(()=>MARKUP.active),null,'Refused/uncertain annotations disarm repeat mode');
    await marks.evaluate(()=>{hasEditor=true;SEL.range=[0,1];});
    await marks.locator('#markup-toggle').click();
    assert.equal(await marks.evaluate(()=>MARKUP.active),null,'Cancelled editor transition keeps marking off');
    await marks.close();
    console.log('PASS Preview marking: seven choices, one-shot/repeat, neutral selection, no duplicates, copy, menu keyboard, refusal and draft guard');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
