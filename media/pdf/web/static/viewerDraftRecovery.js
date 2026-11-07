/* Source checkpoints belong to the host, not to verified PDF history. */
(() => {
  const entries = new Map(), editors = new WeakMap(), notes = new Map(), legacy = new Map();
  let timer = 0, firstDirty = 0, running = null, failure = false, records = [];
  const status = document.createElement('span'); status.id = 'draft-recovery-status';
  // Checkpoint cadence is visual status, not a screen-reader announcement per keystroke.
  document.getElementById('statusbar').append(status);
  const error = document.createElement('p'); error.id = 'draft-recovery-error'; error.setAttribute('role','alert');
  document.getElementById('warnings').append(error);
  const button = document.createElement('button'); button.id='recover-drafts'; button.type='button';
  button.className='tbtn wide'; button.textContent='Recover drafts';
  document.getElementById('properties-toggle').after(button);
  const panel = document.createElement('dialog'); panel.id='draft-recovery'; panel.setAttribute('aria-label','Recover unapplied source');
  panel.innerHTML=`<form method="dialog"><strong>Recover drafts</strong><button aria-label="Close draft recovery">×</button></form>
    <p>These checkpoints contain unapplied source, not verified PDF edits. Select a record, copy its source, then select the intended text or comment again and prepare a fresh preview. Nothing is applied automatically.</p>
    <p id="draft-record-status" role="status"></p><div id="draft-records"></div>
    <label>Exact recovered source<textarea id="recovered-source" readonly rows="8"></textarea></label>
    <div><button type="button" id="draft-select-source">Select source</button>
    <button type="button" id="draft-discard" disabled>Discard selected checkpoint</button>
    <button type="button" id="draft-retry">Retry current checkpoint</button></div>`;
  document.body.append(panel);
  panel.addEventListener('close',()=>button.focus());
  let selected=null;
  const source = panel.querySelector('#recovered-source'), discard=panel.querySelector('#draft-discard');
  function failed() {
    if(!error.isConnected) document.getElementById('warnings').append(error);
    failure=true;status.textContent='Draft recovery not confirmed';
    error.textContent='Draft recovery could not be confirmed. Keep the editor open and copy your source before closing it. Use Recover drafts to retry or inspect earlier checkpoints.';
  }
  function entryFor(key, kind, page, original, objectId) {
    let entry=key instanceof Object ? editors.get(key) : notes.get(key);
    if (!entry) {
      entry={id:crypto.randomUUID().replaceAll('-',''),generation:0,doc:S.doc.doc,
        base_revision:S.revision,kind,page,original,object_id:objectId == null ? null : String(objectId),key:null,latest:null,ended:false,attempted:null};
      entries.set(entry.id,entry);
      if (key instanceof Object) editors.set(key,entry); else notes.set(key,entry);
    }
    return entry;
  }
  function capture() {
    const ed=S.draft;
    if(ed && !ed.closed && !ed.composing && (draftDirty(ed) || editors.get(ed)?.generation>0)) {
      const entry=entryFor(ed,ed.kind==='formula'?'formula':'paragraph',ed.page,ed.original,ed.block);
      const ta=document.querySelector('#properties .ipsource');
      queue(entry,{source:ed.text(),mode:ed.mode,options:{width:ed.width,grow:!!ed.grow},
        caret:ed.mode==='latex' && ta ? [ta.selectionStart,ta.selectionEnd] : null});
    }
    for(const [ta,entry] of legacy) {
      if(ta.isConnected && (ta.value!==entry.original || entry.generation>0)) queue(entry,{source:ta.value,mode:'text',
        options:{width:null,grow:!!document.getElementById('egrow')?.checked},caret:[ta.selectionStart,ta.selectionEnd]});
    }
    const newNote=globalThis.PDFNoteDraft;
    if(newNote && (newNote.contents || editors.get(newNote)?.generation>0)) {
      queue(entryFor(newNote,'comment',newNote.page,'',null),{source:newNote.contents,mode:'text',
        options:{width:null,grow:false},caret:null});
    }
    for(const [xref,text] of NOTES.drafts) {
      const rec=NOTES.byXref.get(xref);
      if(!rec) continue;
      if(text===(rec.contents || '') && !(notes.get(`${S.doc.doc}:${xref}`)?.generation>0)) continue;
      const key=`${S.doc.doc}:${xref}`,entry=entryFor(key,'comment',rec.page,rec.contents || '',xref);
      queue(entry,{source:text,mode:'text',options:{width:null,grow:false},caret:null});
    }
  }
  function queue(entry, current) {
    if(entry.ended || entry.doc!==S.doc?.doc) return;
    const key=JSON.stringify(current);
    if(entry.key===key) return;
    if(entries.size>64) {failed();return;}
    entry.key=key;
    entry.latest={id:entry.id,generation:++entry.generation,kind:entry.kind,page:entry.page,
      original:entry.original,base_revision:entry.base_revision,object_id:entry.object_id,...current};
  }
  async function drain() {
    if(running) return running;
    running=(async()=>{
      for (;;) {
        const entry=[...entries.values()].find(e=>e.latest || e.ended);
        if(!entry) break;
        const draft=entry.latest;entry.latest=null;
        if(draft && !entry.ended) {
          entry.attempted=draft.generation;
          try {
            const ack=await api('checkpoint_draft',{doc:entry.doc,draft},{priority:'adjacent'});
            if(ack.id!==entry.id || ack.generation!==draft.generation) throw Error('Checkpoint acknowledgement mismatch');
            entry.confirmed=draft.generation;entry.confirmedSource=draft.source;
          } catch {entry.key=null;failed();}
        }
        if(entry.ended) {
          // Ordered after a possibly uncertain write. A failed discard retains
          // the checkpoint; it never turns into an automatic PDF replay.
          if(entry.attempted!==null) {
            try {await api('discard_draft',{doc:entry.doc,id:entry.id,generation:entry.attempted},{priority:'adjacent'});}
            catch {failed();}
          }
          entries.delete(entry.id);
        }
      }
      if(!failure && !timer) status.textContent=S.draft?.composing ? 'Draft recovery pending composition' :
        [...entries.values()].some(e=>e.attempted!==null) ? 'Draft recovery updated' : '';
    })();
    try {await running;} finally {running=null;}
    if([...entries.values()].some(e=>e.latest || e.ended)) await drain();
  }
  function changed() {
    const now=Date.now(); if(!firstDirty) firstDirty=now;
    clearTimeout(timer);status.textContent='Draft recovery pending';
    timer=setTimeout(flush,Math.min(500,Math.max(0,2000-(now-firstDirty))));
  }
  async function flush() {
    clearTimeout(timer);timer=0;firstDirty=0;
    if(!S.doc) return;
    capture(); await drain();
  }
  function ended(entry) {
    if(!entry) return;
    entry.ended=true;void drain();
  }
  globalThis.PDFDraftRecovery={changed,flush,
    legacyOpened: (box,page)=>{for(const ta of box.querySelectorAll('textarea')) legacy.set(ta,entryFor(ta,'paragraph',page,ta.value,'legacy:'+ta.id));},
    legacyDirty: ()=>[...legacy].some(([ta,entry])=>ta.isConnected && ta.value!==entry.original),
    legacyClosed: ()=>{for(const entry of legacy.values()) ended(entry);legacy.clear();},
    opened: ed=>entryFor(ed,ed.kind==='formula'?'formula':'paragraph',ed.page,ed.original,ed.block),
    closed: ed=>ended(editors.get(ed)),
    newNoteOpened: draft=>entryFor(draft,'comment',draft.page,'',null),
    newNoteClosed: draft=>ended(editors.get(draft)),
    newNoteRetain: async draft=>{await flush();const entry=editors.get(draft);
      if((entry?.generation || draft.contents) && (!entry || entry.doc!==S.doc?.doc ||
          entry.confirmed!==entry.generation || entry.confirmedSource!==draft.contents))return false;
      if(entry)entries.delete(entry.id);editors.delete(draft);return true;},
    noteOpened: rec=>entryFor(`${S.doc.doc}:${rec.xref}`,'comment',rec.page,rec.contents || '',rec.xref),
    noteClosed: xref=>{const key=`${S.doc.doc}:${xref}`;ended(notes.get(key));notes.delete(key);},
  };
  async function refresh() {
    const doc=S.doc?.doc;
    panel.querySelector('#draft-record-status').textContent='Loading checkpoints…';
    try {
      const result=await api('list_drafts',{}, {priority:'adjacent'});
      if(doc!==S.doc?.doc) return;
      records=result.records;selected=null;source.value='';discard.disabled=true;
      const list=panel.querySelector('#draft-records');list.replaceChildren();
      for(const rec of records) {
        const b=document.createElement('button');b.type='button';
        b.textContent=`${rec.draft.kind} · page ${rec.draft.page+1} · ${new Date(rec.updated*1000).toLocaleString()}${rec.source_matches?'':' · source file differs'}`;
        b.onclick=()=>{selected=rec;source.value=rec.draft.source;discard.disabled=entries.has(rec.draft.id);source.focus();};
        list.append(b);
      }
      panel.querySelector('#draft-record-status').textContent=`${records.length} checkpoint(s).${result.unreadable?' Unreadable checkpoints were retained.':''}${result.truncated?' Listing is incomplete.':''}`;
    } catch {panel.querySelector('#draft-record-status').textContent='Checkpoints could not be read. Existing records were retained.';failed();}
  }
  button.onclick=()=>{if(!panel.open) panel.showModal();void refresh();};
  panel.querySelector('#draft-select-source').onclick=()=>{source.focus();source.select();};
  panel.querySelector('#draft-retry').onclick=async()=>{failure=false;error.textContent='';await flush();await refresh();};
  discard.onclick=async()=>{
    if(!selected || entries.has(selected.draft.id) || !confirm('Discard this recovered source checkpoint?')) return;
    discard.disabled=true;
    try {await api('discard_draft',{doc:S.doc.doc,id:selected.draft.id,generation:selected.draft.generation},{priority:'adjacent'});await refresh();}
    catch {failed();discard.disabled=false;}
  };
  document.addEventListener('input',ev=>{if(ev.target.closest?.('.nedit,#editor')) changed();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden) void flush();});
  // A new page load advertises surviving checkpoints without applying them.
  let checked=false;
  const previous=PDFUI.documentChanged;
  PDFUI.documentChanged=function(){previous.call(this);if(failure && !error.isConnected) document.getElementById('warnings').append(error);if(!checked && S.doc){checked=true;void api('list_drafts',{}, {priority:'adjacent'}).then(r=>{
    if(r.records.length || r.unreadable || r.truncated) button.textContent=`Recover drafts (${r.records.length}${r.unreadable || r.truncated?'+':''})`;
  }).catch(failed);}};
  if(S.doc) PDFUI.documentChanged();
})();
