/* Notes use the current selection; no floating selection toolbar. */
(() => {
  const dialog=document.createElement('dialog');dialog.id='selection-note';
  dialog.setAttribute('aria-label','Add note to selected text');
  dialog.innerHTML=`<h2>Add note</h2><label for="selection-note-source">Comment</label>
    <textarea id="selection-note-source" rows="7" maxlength="65536"></textarea>
    <p id="selection-note-status" role="status"></p>
    <div><button type="button" id="selection-note-apply">Apply</button>
    <button type="button" id="selection-note-keep">Keep draft</button>
    <button type="button" id="selection-note-discard">Discard</button></div>`;
  document.body.append(dialog);
  const source=dialog.querySelector('textarea'),status=dialog.querySelector('p');
  const apply=dialog.querySelector('#selection-note-apply'),keep=dialog.querySelector('#selection-note-keep'),discard=dialog.querySelector('#selection-note-discard');
  let note=null;
  function freshNote() {return note && note.doc===S.doc?.doc && note.revision===S.revision && note.geo===S.doc.pages[note.page]?.geo;}
  function syncNote() {
    const size=new TextEncoder().encode(source.value).length;
    apply.disabled=!note || note.busy || note.attempted || !freshNote() || !size || size>65536;
    source.disabled=keep.disabled=discard.disabled=!!note?.busy;
    if(note && !note.busy && !note.attempted) status.textContent=!freshNote()?
      'The selection changed. Keep this draft, then select the intended text again.':
      `${size.toLocaleString()} / 65,536 bytes`;
  }
  function openNote() {
    if(note || !S.doc || SEL.page === null || !SEL.range || !SEL.chars ||
       SEL.chars.geo !== S.doc.pages[SEL.page]?.geo || MARKUP.busy || editorOpen()) return;
    const rects=selectionRects(SEL.chars,SEL.range);if(!rects.length)return;
    note={doc:S.doc.doc,page:SEL.page,geo:SEL.chars.geo,revision:S.revision,rects,
      contents:'',busy:false,attempted:false};
    globalThis.PDFNoteDraft=note;source.value='';
    PDFDraftRecovery.newNoteOpened(note);clearSelection();syncNote();dialog.showModal();source.focus();
  }
  function closeNote() {note=null;globalThis.PDFNoteDraft=null;dialog.close();document.getElementById('stage').focus({preventScroll:true});}
  source.addEventListener('input',()=>{if(!note)return;note.contents=source.value;PDFDraftRecovery.changed();syncNote();});
  async function retainNote() {
    if(!note || note.busy)return;
    note.busy=true;syncNote();
    let retained=false;
    try {retained=await PDFDraftRecovery.newNoteRetain(note);} catch { /* Keep source open on unexpected host failure. */ }
    if(retained) closeNote();
    else {note.busy=false;syncNote();status.textContent='Draft recovery is not confirmed. Keep this window open and copy your comment.';}
  }
  keep.onclick=()=>void retainNote();
  discard.onclick=()=>{if(!note || note.busy)return;PDFDraftRecovery.newNoteClosed(note);closeNote();};
  dialog.addEventListener('cancel',event=>{event.preventDefault();void retainNote();});
  dialog.addEventListener('keydown',event=>event.stopPropagation());
  apply.onclick=async()=>{
    if(apply.disabled || !note || note.busy || note.attempted || !freshNote()){syncNote();return;}
    const draft=note;draft.busy=true;draft.attempted=true;syncNote();status.textContent='Applying and verifying…';
    let result=null;
    try {
      await PDFDraftRecovery.flush();
      result=await mutate('annot.note',{page:draft.page,doc:draft.doc,geo:draft.geo,
        selection_kind:'text',rects:draft.rects,contents:draft.contents,expected_revision:draft.revision},r=>r.reason);
    } catch { /* Preserve source and do not replay an ambiguous submission. */ }
    if(result) {PDFDraftRecovery.newNoteClosed(draft);closeNote();}
    else {draft.busy=false;syncNote();status.textContent='The note was refused or its outcome could not be confirmed. Your source is retained. Keep the draft and inspect comments before selecting text again; this submission will not be retried.';}
  };
  const previous=PDFUI.revisionChanged;
  PDFUI.revisionChanged=function(...args){previous?.apply(this,args);syncNote();};
  globalThis.PDFSelectionActions={openNote,sync:syncNote};
})();
