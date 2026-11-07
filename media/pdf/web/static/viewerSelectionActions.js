/* An extra entry point to the existing selection actions, not a second editor. */
function selectionPopupPosition(anchor, width, height, viewportWidth, viewportHeight) {
  const margin = 8, gap = 8;
  const left = Math.max(margin, Math.min(anchor.left, viewportWidth - width - margin));
  const preferred = anchor.top - height - gap;
  const top = Math.max(margin, Math.min(preferred >= margin ? preferred : anchor.bottom + gap,
                                      viewportHeight - height - margin));
  return {left, top};
}
(() => {
  const popup = document.createElement('div'); popup.id = 'selection-actions'; popup.hidden = true;
  popup.setAttribute('role', 'toolbar'); popup.setAttribute('aria-label', 'Selected text actions');
  popup.innerHTML = '<button type="button" data-selection="copy">Copy</button><button type="button" data-selection="highlight" title="Highlight using the default configured colour">Highlight</button><button type="button" data-selection="underline">Underline</button><button type="button" data-selection="note">Note</button>';
  // Outside the workspace tools: selecting text works in every workspace (UI-01).
  document.body.append(popup);
  const buttons = [...popup.querySelectorAll('button')];
  let bound = null;
  function current() {
    return bound && S.doc?.doc === bound.doc && S.revision === bound.revision &&
      SEL.generation === bound.generation && SEL.page === bound.page &&
      SEL.chars?.geo === bound.geo && S.doc.pages[bound.page]?.geo === bound.geo &&
      SEL.range?.[0] === bound.first && SEL.range?.[1] === bound.last &&
      !SEL.dragging && !MARKUP.active && !MARKUP.busy && !document.getElementById('editor');
  }
  function hide() {
    const focused = popup.contains(document.activeElement);
    popup.hidden = true; bound = null;
    if (focused) document.getElementById('stage').focus({preventScroll:true});
  }
  function show(focus = false) {
    hide();
    if (!S.doc || !SEL.range || SEL.page === null || !SEL.chars) return;
    bound = {doc:S.doc.doc,revision:S.revision,generation:SEL.generation,page:SEL.page,
      geo:SEL.chars.geo,first:SEL.range[0],last:SEL.range[1]};
    if (!current()) { hide(); return; }
    const bands = document.querySelectorAll('.selband');
    const anchor = bands[bands.length - 1]?.getBoundingClientRect();
    if (!anchor || anchor.bottom <= 0 || anchor.top >= innerHeight) { hide(); return; }
    popup.hidden = false;
    const position = selectionPopupPosition(anchor,popup.offsetWidth,popup.offsetHeight,innerWidth,innerHeight);
    popup.style.left = `${position.left}px`; popup.style.top = `${position.top}px`;
    buttons.forEach((button,index)=>button.tabIndex=index===0?0:-1);
    if (focus) buttons[0].focus({preventScroll:true});
  }
  for (const button of buttons) button.onclick = () => {
    if (!current()) { hide(); return; }
    const action = button.dataset.selection;
    if (action === 'note') { openNote(); hide(); return; }
    hide();
    if (action === 'copy') void copySelection();
    else void applyMark(action === 'highlight' ? 'Highlight' : 'Underline', null);
  };
  popup.addEventListener('keydown',event=>{
    if(event.key === 'Escape') {event.preventDefault();event.stopPropagation();hide();return;}
    const index=buttons.indexOf(document.activeElement);
    if(index<0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();event.stopPropagation();
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:
      (index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    buttons.forEach((button,i)=>button.tabIndex=i===next?0:-1);buttons[next].focus();
  });
  document.addEventListener('keydown',event=>{
    if(!event.target.closest?.('#stage') || !((event.shiftKey && event.key==='F10') || event.key==='ContextMenu')) return;
    if(!SEL.range) return;
    event.preventDefault();show(true);
  });
  window.addEventListener('scroll',hide,true);
  window.addEventListener('resize',hide);
  document.addEventListener('pointerdown',event=>{if(!popup.contains(event.target)) hide();});
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
    if(note || !current()) return;
    const rects=selectionRects(SEL.chars,SEL.range);if(!rects.length)return;
    note={doc:bound.doc,page:bound.page,geo:bound.geo,revision:bound.revision,rects,
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
  PDFUI.revisionChanged=function(...args){hide();previous?.apply(this,args);syncNote();};
  globalThis.PDFSelectionActions={show,hide,sync:()=>{if(bound && !current())hide();}};
})();
