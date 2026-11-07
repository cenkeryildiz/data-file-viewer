// One permutation, computed against the layout captured when an action starts.
function organizePermutation(count, selected, target, after = false) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(target) || target < 0 || target >= count) return null;
  const chosen = new Set(selected);
  if (!chosen.size || chosen.has(target) || [...chosen].some(i => !Number.isInteger(i) || i < 0 || i >= count)) return null;
  const order = Array.from({length:count}, (_,i) => i), moving = order.filter(i => chosen.has(i));
  const remaining = order.filter(i => !chosen.has(i));
  const at = remaining.indexOf(target) + (after ? 1 : 0);
  const result = remaining.slice(0,at).concat(moving,remaining.slice(at));
  return result.every((p,i) => p === i) ? null : result;
}

/* Organizer presentation: image payloads exist only near the visible rows. */
(() => {
  const open = document.createElement('button');
  open.id = 'organize-pages'; open.type = 'button'; open.className = 'tbtn wide';
  open.dataset.workspace = 'organize'; open.textContent = 'Organize pages';
  document.getElementById('workspace-parking').prepend(open);
  const dialog = document.createElement('dialog'); dialog.id = 'page-organizer';
  dialog.setAttribute('aria-label', 'Organize pages');
  dialog.innerHTML = `<form method="dialog"><strong>Organize pages</strong><button aria-label="Close organizer">×</button></form>
    <div class="organize-controls"><button id="organize-all" type="button">Select all</button><button id="organize-none" type="button">Select none</button>
    <label>Page <input id="organize-target" type="text" inputmode="numeric" value="1" maxlength="16" aria-describedby="organize-status"></label>
    <button id="organize-before" type="button">Move before</button><button id="organize-after" type="button">Move after</button></div>
    <p id="organize-status" role="status"></p>
    <div id="organize-grid" role="listbox" aria-label="Pages" aria-multiselectable="true"></div>`;
  document.body.append(dialog);
  const grid = dialog.querySelector('#organize-grid'), status = dialog.querySelector('#organize-status');
  let seen = null, cards = [], mounted = new Set(), identity = '', drag = null;
  const currentIdentity = () => `${S.doc?.doc}:${S.doc?.layout}`;
  function dispose() {
    seen?.disconnect(); seen = null;
    for (const card of mounted) dropImage(card.firstChild);
    mounted.clear(); drag = null;
  }
  function sync() {
    for (const [i, card] of cards.entries()) {
      card.classList.toggle('sel', S.selected.has(i));
      card.setAttribute('aria-selected', String(S.selected.has(i)));
      card.tabIndex = i === S.selectionFocus ? 0 : -1;
    }
    for (const id of ['organize-before','organize-after']) {
      dialog.querySelector('#'+id).disabled = !S.selected.size || pageOpsBlocked();
    }
    status.textContent = `${S.selected.size} of ${S.doc?.pages.length || 0} pages selected. Drag a selected page, or choose a destination page and Move before/after.`;
  }
  function build() {
    if (!dialog.open || !S.doc) return;
    dispose(); identity = currentIdentity();
    cards = S.doc.pages.map(p => {
      const card = document.createElement('div'); card.className = 'thumb organize-page';
      card.dataset.page = p.index; card.draggable = true; card.setAttribute('role','option');
      card.setAttribute('aria-label', `Page ${p.index+1}`);
      const shot = document.createElement('div'); shot.className = 'shot'; shot.dataset.alt = `Page ${p.index+1}`;
      shot.style.aspectRatio = `${p.width}/${p.height}`;
      const number = document.createElement('span'); number.className = 'no'; number.textContent = p.index+1;
      card.append(shot,number); return card;
    });
    grid.replaceChildren(fragmentOf(cards)); sync();
    seen = new IntersectionObserver(entries => {
      for (const e of entries) {
        const card = e.target, index = Number(card.dataset.page);
        if (identity !== currentIdentity() || cards[index] !== card || !dialog.open) continue;
        if (e.isIntersecting) {
          mounted.add(card); showImage(card.firstChild, thumbKey(index), S.doc.pages[index].look, undefined, 'thumb');
        } else { mounted.delete(card); dropImage(card.firstChild); }
      }
    }, {root:grid,rootMargin:'100% 0px'});
    for (const card of cards) seen.observe(card);
  }
  function select(index, ev = {}) {
    const additive = ev.ctrlKey || ev.metaKey;
    if (!additive) S.selected.clear();
    if (ev.shiftKey && Number.isInteger(S.selectionAnchor)) {
      for (let i=Math.min(index,S.selectionAnchor);i<=Math.max(index,S.selectionAnchor);i++) S.selected.add(i);
    } else {
      if (additive && S.selected.has(index)) S.selected.delete(index); else S.selected.add(index);
      S.selectionAnchor = index;
    }
    S.selectionFocus = index; syncRailSelection();
  }
  function snapshot() {
    return {doc:S.doc.doc,layout:S.doc.layout,count:S.doc.pages.length,selected:selectedPages()};
  }
  async function move(held, target, after) {
    return pageOp(async () => {
      const valid = () => held.doc === S.doc?.doc && held.layout === S.doc?.layout;
      if (!valid()) { status.textContent = 'Page layout changed. Start the move again.'; return; }
      const order = organizePermutation(held.count, held.selected, target, after);
      if (!order) { status.textContent = 'Choose an unselected destination that changes the order.'; return; }
      if (!(await requestEditorTransition('reorder'))) return;
      if (!valid()) { status.textContent = 'Page layout changed. Start the move again.'; return; }
      const result = await mutate('page.reorder', {order,layout:held.layout}, () => `Moved ${held.selected.length} page(s).`);
      if (pageReceiptCurrent(result, held.doc)) {
        const chosen = new Set(held.selected);
        S.selected = new Set(order.flatMap((old,index) => chosen.has(old) ? [index] : []));
        S.selectionAnchor = S.selected.values().next().value; S.selectionFocus = S.selectionAnchor; syncRailSelection();
        cards[S.selectionFocus]?.focus();
      }
    });
  }
  open.onclick = () => { if (!S.doc) return; dialog.showModal(); build(); cards[S.selectionFocus]?.focus(); };
  dialog.addEventListener('close', () => { dispose(); open.focus(); });
  grid.addEventListener('click', ev => {
    const card = ev.target.closest('.organize-page'); if (!card) return;
    select(Number(card.dataset.page), ev); card.focus();
  });
  grid.addEventListener('keydown', ev => {
    const card = ev.target.closest('.organize-page'); if (!card) return;
    const index = Number(card.dataset.page);
    if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault(); select(index, {ctrlKey:ev.key === ' ' || ev.ctrlKey,metaKey:ev.metaKey,shiftKey:ev.shiftKey}); return;
    }
    const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    const delta = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns}[ev.key];
    if (delta === undefined && !['Home','End'].includes(ev.key)) return;
    ev.preventDefault();
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? cards.length-1 : Math.max(0,Math.min(cards.length-1,index+delta));
    if (ev.shiftKey) {
      if (!Number.isInteger(S.selectionAnchor)) S.selectionAnchor = index;
      select(next, ev);
    }
    S.selectionFocus = next; sync(); cards[next].focus();
  });
  grid.addEventListener('dragstart', ev => {
    const card = ev.target.closest('.organize-page'); if (!card || pageOpsBlocked()) {ev.preventDefault();return;}
    const index = Number(card.dataset.page); if (!S.selected.has(index)) select(index);
    drag = snapshot(); ev.dataTransfer.setData('text/plain', String(index)); ev.dataTransfer.effectAllowed = 'move';
  });
  grid.addEventListener('dragover', ev => { if (drag && ev.target.closest('.organize-page')) {ev.preventDefault();ev.dataTransfer.dropEffect='move';} });
  grid.addEventListener('drop', ev => {
    const card = ev.target.closest('.organize-page'), held = drag; drag = null;
    if (!held || !card) return; ev.preventDefault();
    const rect = card.getBoundingClientRect();
    void move(held, Number(card.dataset.page), ev.clientX > (rect.left+rect.right)/2);
  });
  grid.addEventListener('dragend', () => {drag=null;});
  for (const [id,after] of [['organize-before',false],['organize-after',true]]) dialog.querySelector('#'+id).onclick = () => {
    const input = dialog.querySelector('#organize-target'), target = parsePageNumber(input.value,S.doc.pages.length);
    if (target === null) {input.setAttribute('aria-invalid','true');status.textContent=`Enter a page from 1 to ${S.doc.pages.length}.`;return;}
    input.removeAttribute('aria-invalid'); void move(snapshot(),target,after);
  };
  dialog.querySelector('#organize-all').onclick = () => {S.selected=new Set(S.doc.pages.map(p=>p.index));syncRailSelection();};
  dialog.querySelector('#organize-none').onclick = () => {S.selected.clear();S.selectionAnchor=null;syncRailSelection();};
  globalThis.PDFOrganize = {sync,documentChanged() {if (dialog.open && identity!==currentIdentity()) build();}};
})();
