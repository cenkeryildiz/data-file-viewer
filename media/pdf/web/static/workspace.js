// Strict one-based page syntax; failed parsing never changes the selection.
function parsePageSelection(value, count) {
  if (!Number.isInteger(count) || count < 1 || value.length > 2048 || !value.trim()) throw Error('Enter page numbers or ranges, for example 1, 3-5.');
  const chosen = new Set();
  for (const token of value.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(token);
    if (!match) throw Error('Use page numbers and ascending ranges, for example 1, 3-5.');
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > count) throw Error(`Choose pages between 1 and ${count}, with ranges in ascending order.`);
    for (let n = first; n <= last; n++) chosen.add(n - 1);
  }
  return chosen;
}

// Filter whole threads; a matching reply retains its parent, and drafts stay visible.
function commentColorKey(color) {
  return Array.isArray(color) && color.length === 3
    ? '#' + color.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('') : 'none';
}
function filterCommentThreads(top, all, drafts, filter) {
  const query = filter.query.trim().toLocaleLowerCase();
  const byId = new Map(all.map(a => [a.xref, a])), included = new Set();
  for (const a of all) {
    const matches = (!filter.kind || a.kind === filter.kind) && (!filter.author || a.author === filter.author)
      && (!filter.color || commentColorKey(a.color) === filter.color)
      && (!filter.pages || filter.pages.has(a.page))
      && (!query || [a.contents, a.quoted, a.author].some(v => String(v || '').toLocaleLowerCase().includes(query)));
    if (!matches && !drafts.has(a.xref)) continue;
    let record = a;
    while (record && !included.has(record.xref)) { included.add(record.xref); record = byId.get(record.reply_to); }
  }
  const result = top.filter(a => included.has(a.xref));
  // Stable ties retain document order. Canonical records are never reordered.
  if (filter.sort === 'newest') result.sort((a,b) => String(b.created || '').localeCompare(String(a.created || '')));
  if (filter.sort === 'author') result.sort((a,b) => String(a.author || '').localeCompare(String(b.author || '')));
  return result;
}

// Fenced literal blocks preserve Unicode, whitespace, LaTeX and Markdown punctuation.
function notesMarkdown(name, labels, records) {
  const literal = value => {
    const text = String(value ?? '');
    let width = 3;
    for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
    const fence = '`'.repeat(width);
    return `${fence}text\n${text}\n${fence}\n`;
  };
  let out = '# PDF notes\n\nSource filename:\n\n' + literal(name);
  out += '\nSaved annotations only; unapplied drafts are excluded. Locations use displayed PDF points and may change after editing. Quotations are extracted from PDF text under the marks.\n';
  for (const a of records) {
    out += `\n## Page ${a.page + 1} · annotation ${a.xref}\n\n`;
    if (labels[a.page]) out += 'Page label:\n\n' + literal(labels[a.page]) + '\n';
    out += 'Type:\n\n' + literal(a.kind);
    out += `\nLocation (x0, y0, x1, y1): ${JSON.stringify(a.rect)}\n`;
    if (a.reply_to) out += `\nReply to annotation: ${a.reply_to}\n`;
    for (const [title, value] of [['Author',a.author], ['Extracted quotation',a.quoted], ['Comment',a.contents]]) {
      if (value !== undefined && value !== null && value !== '') out += `\n${title}:\n\n` + literal(value);
    }
  }
  return out;
}

// A complete export must describe one revision. No partial download on failure.
async function collectNotesExport(info, request, isCurrent, progress = () => {}) {
  const check = data => {
    if (!isCurrent() || data.doc !== info.doc || data.layout !== info.layout || data.revision !== info.revision)
      throw Error('The document changed. Export notes again from the current revision.');
  };
  const records = [];
  let size = 0;
  for (let page = 0; page < info.pages.length; page++) {
    const data = await request('list_annotations', {pages:[page]});
    check(data);
    if (data.truncated) throw Error(`Page ${page + 1} has too many annotations for a complete export. No file was downloaded.`);
    size += JSON.stringify(data.annots).length;
    if (records.length + data.annots.length > 50000 || size > 16 * 1024 * 1024)
      throw Error('The notes exceed the export size limit. No partial file was downloaded.');
    records.push(...data.annots);
    progress(page + 1, info.pages.length);
  }
  const nav = await request('get_navigation', {});
  check(await request('get_document_info', {}));
  if (nav.layout !== info.layout) throw Error('The document layout changed. Export notes again.');
  return notesMarkdown(info.name, nav.labels, records);
}

// Search-only folding never changes the bookmark title stored in the PDF.
function foldNavigationText(value) {
  return String(value).normalize('NFC').replace(/[Iİı]/g, 'i').toLowerCase().replace(/ς/g, 'σ');
}
// Outline rows are engine entries {level, title, parent, dest}; a host may
// still send the older [level, title, 1-based page] triples.
function outlineEntry(row) {
  if (Array.isArray(row)) {
    const page = row[2];
    return {level: row[0], title: String(row[1] ?? ''), parent: null,
            dest: Number.isInteger(page) && page >= 1 ? {kind: 'page', page: page - 1, view: 'Fit', point: null, zoom: null} : {kind: 'none'}};
  }
  return {level: row?.level, title: String(row?.title ?? ''), parent: row?.parent ?? null, dest: row?.dest || {kind: 'none'}};
}
const outlineLevel = row => Array.isArray(row) ? row[0] : row.level;
const outlineTitle = row => Array.isArray(row) ? row[1] : row.title;
// A physical page of the current document, or null: broken, unsupported,
// external and heading-only destinations never move the view.
function destinationPage(dest, count) {
  return dest && dest.kind === 'page' && Number.isInteger(dest.page) && dest.page >= 0 && dest.page < count ? dest.page : null;
}
// The link under a displayed-space page point; nested rectangles resolve to the smallest.
function linkAt(links, x, y) {
  let best = null, area = Infinity;
  for (const link of links || []) {
    const [x0, y0, x1, y1] = link.rect;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const a = (x1 - x0) * (y1 - y0);
    if (a < area) { area = a; best = link; }
  }
  return best;
}
// Web and mail addresses only; anything else (javascript:, file:, data:) is never opened.
function externalUri(uri) {
  return typeof uri === 'string' && uri.length <= 4096 && uri === uri.trim() && /^(https?:\/\/|mailto:)/i.test(uri)
    && !/[\u0000-\u001f]/.test(uri) ? uri : null;
}
// Application back/forward over {document, layout, page, point, zoomMode, zoom}.
// Positions are physical pages under one layout; a structural change drops
// them explicitly rather than guessing where they moved.
function createNavigationHistory(limit = 100) {
  let back = [], forward = [];
  return {
    push(entry) { back.push(entry); if (back.length > limit) back.splice(0, back.length - limit); forward = []; },
    back(current) {
      const entry = back.pop();
      if (!entry) return null;
      forward.push(current); if (forward.length > limit) forward.shift();
      return entry;
    },
    forward(current) {
      const entry = forward.pop();
      if (!entry) return null;
      back.push(current); if (back.length > limit) back.shift();
      return entry;
    },
    invalidate(document, layout) {
      const keep = e => e.document === document && e.layout === layout;
      const before = back.length + forward.length;
      back = back.filter(keep); forward = forward.filter(keep);
      return before - back.length - forward.length;
    },
    size() { return {back: back.length, forward: forward.length}; },
  };
}
function filterOutline(rows, query) {
  const needle = foldNavigationText(query.trim());
  if (!needle) return rows;
  const parents = [], ancestry = [], included = new Set();
  rows.forEach((row, index) => {
    while (parents.length && outlineLevel(rows[parents[parents.length - 1]]) >= outlineLevel(row)) parents.pop();
    ancestry[index] = parents.length ? parents[parents.length - 1] : -1;
    parents.push(index);
    if (!foldNavigationText(outlineTitle(row)).includes(needle)) return;
    for (let i = index; i >= 0 && !included.has(i); i = ancestry[i]) included.add(i);
  });
  return rows.filter((_, index) => included.has(index));
}

// Saved identity comes only from the engine; operation counts are not evidence.
function exportStatus(model, live) {
  if (model.busy === 'export') return 'Exporting verified copy…';
  if (model.busy === 'ack') return 'Confirming exported checkpoint…';
  if (live.uncertain) return 'Checking whether the edit was applied…';
  if (model.pending) return 'Copy exported; checkpoint acknowledgement not confirmed';
  if (live.applying) return 'Applying and verifying…';
  if (live.draft) return 'Draft not applied';
  if (model.error) return model.error;
  const state=live.state;
  if (!state || state.document_id!==live.doc || state.revision!==live.revision) return 'Checking export state…';
  if (state.recovery_warning) return state.recovery_warning;
  if (state.dirty) return 'Unexported changes';
  if (model.last?.receipt?.state_id===state.current_state_id) return 'Exported copy up to date';
  return model.last ? 'Saved checkpoint; latest export is a different state' : 'Saved checkpoint; no export confirmed in this view';
}

// UI-01: the four workspaces; the viewer holds exactly one of them.
const WORKSPACES = ['read', 'annotate', 'edit', 'organize'];
// How many tool units stay in the bar, in order, before the rest move into
// More. Everything fits: all of them, and no More button. Otherwise More's own
// width is reserved first; a unit that does not fit and every unit after it
// move, so the order of tools never changes between the bar and the menu.
function planToolOverflow(widths, available, moreWidth, gap = 0) {
  if (!Number.isFinite(available) || available <= 0) return 0;
  const total = widths.reduce((sum, w, i) => sum + w + (i ? gap : 0), 0);
  if (total <= available + 0.5) return widths.length;
  const room = available - moreWidth - gap;
  let used = 0, fit = 0;
  for (const w of widths) {
    const next = used + (fit ? gap : 0) + w;
    if (next > room + 0.5) break;
    used = next; fit++;
  }
  return fit;
}

// UI-03: accept physical positions only, independently of PDF page labels.
function parsePageNumber(value, count) {
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= count ? n - 1 : null;
}
function calculateFitZoom(page, width, height, mode) {
  if (![width, height, page?.width, page?.height].every(n => Number.isFinite(n) && n > 0)
      || width <= 48 || height <= 48) return null;
  const w = (width - 48) / (page.width * 96 / 72);
  const h = (height - 48) / (page.height * 96 / 72);
  const z = mode === 'actual-size' ? 1 : mode === 'fit-width' ? w : mode === 'fit-page' ? Math.min(w, h) : null;
  return z === null ? null : Math.max(.1, Math.min(8, z));
}
function visiblePageChoice(viewport, candidates, fallback) {
  let best = -1, distance = Infinity, chosen = fallback;
  const cx = (viewport.left + viewport.right) / 2, cy = (viewport.top + viewport.bottom) / 2;
  for (const [index, box] of candidates) {
    const area = Math.max(0, Math.min(box.bottom, viewport.bottom) - Math.max(box.top, viewport.top))
      * Math.max(0, Math.min(box.right, viewport.right) - Math.max(box.left, viewport.left));
    const d = Math.hypot((box.left + box.right) / 2 - cx, (box.top + box.bottom) / 2 - cy);
    if (area > 0 && (area > best || (area === best && d < distance))) {
      best = area; distance = d; chosen = index;
    }
  }
  return chosen;
}

/* Workspace controls share the viewer's revision, selection and draft state. */
(() => {
  const toolbar = document.getElementById('toolbar');
  const stage = document.getElementById('stage');
  const rail = document.getElementById('rail');
  let frame = 0;
  const controls = document.createElement('div');
  controls.id = 'navigation';
  controls.className = 'tgroup';
  controls.innerHTML = `<button type="button" class="tbtn" id="previous-page" aria-label="Previous page">‹</button>
    <label>Page <input id="page-number" type="text" inputmode="numeric" value="1" maxlength="16" aria-label="Page number" aria-describedby="navigation-error"></label>
    <span id="page-count"></span><span id="page-label"></span><span id="navigation-status" class="sr-only" role="status"></span>
    <button type="button" class="tbtn" id="next-page" aria-label="Next page">›</button>
    <select id="page-fit" aria-label="Page zoom"><option value="fit-page">Fit page</option><option value="fit-width">Fit width</option><option value="actual-size">100%</option><option value="custom">Custom</option></select>`;
  toolbar.insertBefore(controls, toolbar.querySelector('.zoom'));
  const fitControl = controls.querySelector('#page-fit');
  fitControl.hidden = true;
  fitControl.disabled = true;
  const navigationError = document.createElement('span');
  navigationError.id = 'navigation-error'; navigationError.setAttribute('role', 'status');
  document.getElementById('statusbar').append(navigationError);
  const status = document.createElement('span');
  const exportSize = document.createElement('span');
  exportSize.id = 'export-size'; exportSize.setAttribute('role','status');
  document.getElementById('statusbar').append(exportSize);
  status.id = 'save-state'; status.setAttribute('role', 'status');
  document.getElementById('statusbar').insertBefore(status, document.getElementById('editinfo'));
  const theme = document.createElement('select');
  theme.id = 'theme'; theme.setAttribute('aria-label', 'Interface theme');
  theme.innerHTML = '<option value="system">System theme</option><option value="light">Light</option><option value="dark">Dark</option>';
  document.querySelector('.brandpad').append(theme);
  const media = matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme.value === 'system' ? (media.matches ? 'dark' : 'light') : theme.value;
  };
  try { theme.value = ['system','light','dark'].includes(localStorage.getItem('pdfstudio.theme')) ? localStorage.getItem('pdfstudio.theme') : 'system'; } catch {}
  theme.onchange = () => { applyTheme(); try { localStorage.setItem('pdfstudio.theme', theme.value); } catch {} };
  media.addEventListener('change', applyTheme); applyTheme();
  const number = document.getElementById('page-number');
  const navHistory = createNavigationHistory(100);
  const navStatus = document.getElementById('navigation-status');
  function position() {
    const rect = stage.getBoundingClientRect(), at = anchorPoint({x:rect.left,y:rect.top});
    return {document:S.doc.doc,layout:S.doc.layout,page:at ? at.index : S.currentPage,
      point:at ? [at.x,at.y] : null,zoomMode:S.viewMode,zoom:S.zoom};
  }
  function navigate(index, point = null, remember = true, refit = true) {
    if (!S.doc || !Number.isInteger(index) || index < 0 || index >= S.doc.pages.length) return false;
    const wrap = VIEW.shells[index], page = S.doc.pages[index];
    if (!wrap || !page) return false;
    if (remember) navHistory.push(position());
    S.currentPage = index;
    if (refit && S.viewMode !== 'custom') fit(true);
    const rect = stage.getBoundingClientRect(), r = wrap.getBoundingClientRect(), k = r.width/page.width;
    stage.scrollTop += r.top + (point ? point[1] : 0)*k - rect.top;
    if (point && stage.scrollWidth > stage.clientWidth) stage.scrollLeft += r.left + point[0]*k - rect.left;
    number.removeAttribute('aria-invalid'); navigationError.textContent=''; updateNavigation(); return true;
  }
  function restore(entry) {
    if (!entry || entry.document !== S.doc?.doc || entry.layout !== S.doc?.layout) return false;
    setZoom(entry.zoom, undefined, false, entry.zoomMode);
    return navigate(entry.page, entry.point, false, false);
  }
  function travel(direction) {
    if (!S.doc) return;
    const entry = direction < 0 ? navHistory.back(position()) : navHistory.forward(position());
    if (!entry) {navStatus.textContent=direction<0?'No earlier position.':'No later position.';return;}
    restore(entry); navStatus.textContent=`Page ${entry.page+1}.`;
  }
  function updateNavigation() {
    if (!S.doc) return;
    if (document.activeElement !== number) number.value = S.currentPage + 1;
    document.getElementById('page-count').textContent = `/ ${S.doc.pages.length}`;
    const label = S.doc.labels?.[S.currentPage];
    document.getElementById('page-label').textContent = label && label !== String(S.currentPage + 1) ? `Label: ${label}` : '';
    document.getElementById('previous-page').disabled = S.currentPage === 0;
    document.getElementById('next-page').disabled = S.currentPage >= S.doc.pages.length - 1;
  }
  function enterPage() {
    const index = parsePageNumber(number.value, S.doc?.pages.length || 0);
    if (index === null) {
      number.setAttribute('aria-invalid', 'true');
      navigationError.textContent = `Enter a page from 1 to ${S.doc?.pages.length || 0}.`;
    } else { navigate(index); number.value = index + 1; }
  }
  number.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); enterPage(); } };
  number.onchange = enterPage;
  document.getElementById('previous-page').onclick = () => navigate(S.currentPage - 1);
  document.getElementById('next-page').onclick = () => navigate(S.currentPage + 1);
  function fit(apply = false, mode = S.viewMode) {
    if (mode === 'custom') return;
    const zoom = calculateFitZoom(S.doc?.pages[S.currentPage], stage.clientWidth, stage.clientHeight, mode);
    if (zoom === null) return;
    if (apply) setZoom(zoom, undefined, false, mode);
    else { S.zoom = zoom; zoomChanged(); }
  }
  function zoomChanged() {
    document.getElementById('page-fit').value = S.viewMode;
    document.getElementById('zoomlbl').removeAttribute('aria-invalid');
    navigationError.textContent = '';
    document.getElementById('zoomlbl').value = `${Math.round(S.zoom * 100)}%`;
  }
  document.getElementById('page-fit').onchange = ev => {
    const mode = ev.target.value;
    if (mode === 'custom') S.viewMode = mode;
    else fit(true, mode);
    zoomChanged();
  };
  const zoomInput = document.getElementById('zoomlbl');
  function enterZoom() {
    const text = zoomInput.value.trim(), n = Number(text.replace(/%$/, ''));
    if (!/^\d+(?:\.\d+)?%?$/.test(text) || !Number.isFinite(n) || n < 10 || n > 800) {
      zoomInput.setAttribute('aria-invalid', 'true'); navigationError.textContent = 'Enter a zoom from 10% to 800%.'; return;
    }
    zoomInput.removeAttribute('aria-invalid'); navigationError.textContent = ''; setZoom(n / 100);
  }
  zoomInput.onchange = enterZoom;
  zoomInput.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); enterZoom(); } };
  document.addEventListener('keydown', ev => {
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || !['ArrowLeft','ArrowRight'].includes(ev.key)
        || ev.target.closest?.('input,textarea,select,[contenteditable],dialog,[role="textbox"]')) return;
    ev.preventDefault(); travel(ev.key === 'ArrowLeft' ? -1 : 1);
  });
  stage.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const viewport = stage.getBoundingClientRect();
      // Inspect only the visible shells after a logarithmic lookup.
      let lo = 0, hi = VIEW.shells.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (VIEW.shells[mid].getBoundingClientRect().bottom <= viewport.top) lo = mid + 1;
        else hi = mid;
      }
      const candidates = [];
      for (let i = lo; i < VIEW.shells.length; i++) {
        const box = VIEW.shells[i].getBoundingClientRect();
        if (box.top >= viewport.bottom) break;
        candidates.push([i, box]);
      }
      S.currentPage = visiblePageChoice(viewport, candidates, S.currentPage);
      updateNavigation(); // Scrolling never changes zoom or creates history entries.
    });
  }, {passive:true});
  let resizeFrame = 0;
  new ResizeObserver(() => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      // The stage can resize without changing docked-panel state (window
      // height, toolbar wrapping or width within the same panel breakpoint).
      if (S.doc && !editorOpen() && S.viewMode !== 'custom') fit(true);
    });
  }).observe(stage);
  rail.setAttribute('role', 'listbox'); rail.setAttribute('aria-multiselectable', 'true');
  rail.addEventListener('keydown', ev => {
    const item = ev.target.closest('.thumb');
    if (!item || !S.doc) return;
    const index = Number(item.dataset.page);
    const next = ev.key === 'ArrowDown' ? index + 1 : ev.key === 'ArrowUp' ? index - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? S.doc.pages.length - 1 : index;
    if (['ArrowDown','ArrowUp','Home','End'].includes(ev.key)) {
      ev.preventDefault();
      const target = rail.querySelector(`[data-page="${Math.max(0, Math.min(S.doc.pages.length - 1, next))}"]`);
      item.tabIndex = -1; target.tabIndex = 0; target.focus(); S.selectionFocus = Number(target.dataset.page);
      if (ev.shiftKey && !Number.isInteger(S.selectionAnchor)) S.selectionAnchor = index;
      if (ev.shiftKey) target.dispatchEvent(new MouseEvent('click', {bubbles:true,shiftKey:true,ctrlKey:ev.ctrlKey,metaKey:ev.metaKey}));
    } else if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault(); item.dispatchEvent(new MouseEvent('click', {bubbles:true,ctrlKey:ev.key === ' ' || ev.ctrlKey,metaKey:ev.metaKey,shiftKey:ev.shiftKey}));
    }
  });
  function unsentDraft() {
    return !!globalThis.PDFNoteDraft?.contents || !!globalThis.PDFNoteDraft?.busy || !!(S.draft && draftDirty(S.draft)) || !!globalThis.PDFDraftRecovery?.legacyDirty() || NOTES.drafts.size > 0;
  }
  let saved = {doc:null,last:null,compact:null,pending:null,error:'',busy:null};
  const exportDetails=document.createElement('details');exportDetails.id='export-details';
  exportDetails.innerHTML='<summary>Export details</summary><p id="last-export">No export confirmed in this view.</p><p id="last-compact-export"></p><p id="export-outcome"></p><button id="export-reconcile" type="button" hidden>Confirm exported checkpoint</button>';
  document.getElementById('statusbar').append(exportDetails);
  function syncSaveStatus() {
    if(saved.doc!==S.doc?.doc) {saved={doc:S.doc?.doc,last:null,compact:null,pending:null,error:'',busy:null};exportSize.textContent='';}
    const text=exportStatus(saved,{doc:S.doc?.doc,revision:S.revision,state:UNDO.state,draft:unsentDraft(),applying:NET.changes>0,uncertain:!!S.unverified});
    if(status.textContent!==text)status.textContent=text;
    status.classList.toggle('recovery-warning',!!UNDO.state?.recovery_warning);
    const detail=record=>`${record.path} · confirmed ${record.time}`;
    exportDetails.querySelector('#last-export').textContent=saved.last?detail(saved.last):'No export confirmed in this view.';
    exportDetails.querySelector('#last-compact-export').textContent=saved.compact?'Smaller copy: '+detail(saved.compact):'';
    exportDetails.querySelector('#export-outcome').textContent=saved.pending ? `Written copy: ${saved.pending.path}. Checkpoint not confirmed.${saved.error?' '+saved.error:''}` : saved.error;
    const retry=exportDetails.querySelector('#export-reconcile');retry.hidden=!saved.pending;retry.disabled=!!saved.busy;
    for(const id of ['export','export-compact']){const button=document.getElementById(id);if(button)button.disabled=!!saved.busy || !!saved.pending;}
  }
  function savedState() {syncSaveStatus();}
  function confirmExport(owner, st) {
    const pending=owner.pending;
    if(!pending || st.session_id!==pending.receipt.session_id || st.document_id!==owner.doc || st.saved_state_id!==pending.receipt.state_id)throw Error('Export checkpoint identity was not confirmed.');
    owner.last={...pending,time:new Date().toISOString()};owner.pending=null;owner.error='';takeUndo(st);
  }
  async function acknowledgeExport(owner, reconcile=false) {
    owner.busy='ack';syncSaveStatus();
    try {
      let st=reconcile?await api('get_state',{}, {priority:'edit'}):null;
      if(saved!==owner || S.doc?.doc!==owner.doc)return;
      if(!st || st.saved_state_id!==owner.pending.receipt.state_id || st.session_id!==owner.pending.receipt.session_id)
        st=await post('mark_saved',{receipt:owner.pending.receipt});
      if(saved!==owner || S.doc?.doc!==owner.doc)return;
      confirmExport(owner,st);
    } catch(e) {owner.error=e.unanswered?'The acknowledgement reply was lost. Confirm the exported checkpoint to check its saved state.':explain(e);}
    finally {owner.busy=null;syncSaveStatus();}
  }
  exportDetails.querySelector('#export-reconcile').onclick=()=>{if(saved.pending && !saved.busy)void acknowledgeExport(saved,true);};
  async function exportDocument(compact=false) {
    syncSaveStatus();if(!S.doc || saved.busy || saved.pending)return;
    if(unsentDraft() && !confirm('Unapplied text and comment drafts are not included. Export the verified document anyway?'))return;
    const owner=saved;owner.busy='export';owner.error='';syncSaveStatus();
    // PERF-01: pressed -> verified copy written -> its receipt acknowledged.
    const timing=globalThis.PDFPerf?.begin(compact?'export_compact':'export');
    try {
      const result=await post('export_verified',compact?{compact:true}:{},timing);
      globalThis.PDFPerf?.mark(timing,'written');
      if(saved!==owner || S.doc?.doc!==owner.doc)return;
      PDFUI.exported(result);
      if(compact)owner.compact={path:result.path,time:new Date().toISOString()};
      else {
        if(!result.receipt){owner.error=`Copy exported to ${result.path}, but no checkpoint receipt was returned.`;toast(owner.error,'warn');return;}
        owner.pending={path:result.path,receipt:result.receipt};
        await acknowledgeExport(owner);
      }
      globalThis.PDFPerf?.end(timing,owner.pending?'unacknowledged':'ok');
      if(compact){toast(`Smaller copy exported to ${result.path} · ${(Math.max(0,result.verified_length-result.length)/1024).toFixed(1)} KiB removed.${result.note?' '+result.note:''}`,'ok');return;}
      if(owner.pending){toast('Copy exported; confirm its checkpoint in Export details.','warn');return;}
      toast(result.note?`${result.note} Exported to ${result.path}`:`Exported to ${result.path}`,'ok');
    } catch(e) {
      if (e?.name === 'AbortError') {
        globalThis.PDFPerf?.end(timing,'cancelled');
        return;
      }
      globalThis.PDFPerf?.end(timing,e.unanswered?'no_answer':'refused');
      owner.error=e.unanswered?'Export outcome unconfirmed; inspect the destination before exporting again.':'Export failed: '+explain(e);
      toast(owner.error,'err');
    } finally {owner.busy=null;syncSaveStatus();}
  }
  const previousWatch=NET.watch;
  NET.watch=()=>{previousWatch?.();syncSaveStatus();};
  document.addEventListener('input',syncSaveStatus);
  document.addEventListener('click',()=>queueMicrotask(syncSaveStatus));
  globalThis.PDFUI = {
    fit, navigate, zoomChanged,
    documentChanged() {
      S.currentPage = Math.min(S.currentPage, Math.max(0, S.doc.pages.length - 1));
      updateNavigation(); this.selectionChanged(); syncSaveStatus(); globalThis.PDFOrganize?.documentChanged();
    },
    selectionChanged() {
      globalThis.PDFOrganize?.sync();
      for (const id of ['rot-l','rot-r','del','move-earlier','move-later']) {
        const button = document.getElementById(id);
        if (button) button.disabled = S.selected.size === 0 || pageOpsBlocked();
      }
    },
    savedState, syncSaveStatus, exportDocument,
    exported(result) {
      const bytes = result?.receipt?.length ?? result?.length, source = S.doc?.source_bytes;
      if (Number.isFinite(bytes)) {
        const kb = n => `${(n / 1024).toFixed(1)} KiB`;
        exportSize.textContent = `${result?.compact ? 'Smaller copy' : 'Export'}: ${kb(bytes)}${Number.isFinite(source) ? ` · opened: ${kb(source)} · change: ${bytes >= source ? '+' : '−'}${kb(Math.abs(bytes-source))}` : ''}`;
        exportSize.title = 'Verified export size. Incremental PDF saves retain earlier revisions, so shortening text may not shrink the file.';
      }
    },
  };
  window.addEventListener('beforeunload', ev => {
    if (unsentDraft() || UNDO.state?.dirty || (S.doc && (!UNDO.state || UNDO.state.document_id !== S.doc.doc || UNDO.state.revision !== S.revision)) || saved.pending || NET.changes || S.unverified) { ev.preventDefault(); ev.returnValue = ''; }
  });
  // Buttons with icon-only content need accessible names, too.
  for (const button of toolbar.querySelectorAll('button[title]')) {
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title);
  }
  const compactExport = document.createElement('button');
  compactExport.id = 'export-compact'; compactExport.className = 'tbtn wide'; compactExport.type = 'button';
  compactExport.textContent = 'Reduce file size…';
  compactExport.title = 'Save a separate PDF without lowering image quality. The file may stay the same size; the original is unchanged.';
  compactExport.dataset.workspace = 'all';
  document.getElementById('workspace-parking').append(compactExport);
  compactExport.onclick = () => exportDocument(true);
  const finder = document.createElement('dialog');
  finder.id = 'document-finder';
  finder.setAttribute('aria-label', 'Find text and navigate');
  finder.innerHTML = `<form method="dialog"><strong>Find & navigate</strong><button aria-label="Close navigation">×</button></form>
    <label>Find text <input id="find-query" maxlength="256" type="search"></label>
    <button id="find-start" type="button">Search</button><button id="find-stop" type="button">Stop</button>
    <p id="find-status" role="status"></p><div id="find-results"></div>
    <button id="find-outline-open" type="button" hidden>Open Outline sidebar</button>
    <details id="legacy-outline"><summary>Document outline</summary>
    <label>Find bookmark <input id="outline-query" type="search" maxlength="256"></label>
    <button id="outline-clear" type="button">Clear</button>
    <p id="outline-status" role="status"></p><div id="document-outline"></div>
    <button id="outline-previous" type="button">Previous bookmarks</button>
    <button id="outline-next" type="button">Next bookmarks</button></details>`;
  document.body.append(finder);
  finder.querySelector('#find-outline-open').onclick = () => {
    finder.close(); globalThis.PDFPanels?.open('left', 'outline', document.getElementById('outline-toggle'));
  };
  function placeFinder() {
    const top = Math.max(8, Math.min(toolbar.getBoundingClientRect().bottom + 8, innerHeight - 200));
    finder.style.top = `${top}px`;
    finder.style.maxHeight = `${Math.max(160, innerHeight-top-70)}px`;
  }
  new ResizeObserver(placeFinder).observe(toolbar);
  const findButton = document.createElement('button');
  findButton.id = 'find-toggle';
  findButton.hidden = true; // Command-F still invokes this button's handler.
  findButton.className = 'tbtn wide'; findButton.textContent = 'Find';
  let outline = [], outlinePage = 0, outlineGeneration = 0, outlineDoc = null, outlineLayout = null;
  const outlineQuery = finder.querySelector('#outline-query');
  function paintOutline() {
    if (outlineDoc !== S.doc?.doc || outlineLayout !== S.doc?.layout) outline = [];
    const rows = filterOutline(outline, outlineQuery.value), limit = 200;
    outlinePage = Math.max(0, Math.min(outlinePage, Math.ceil(rows.length / limit) - 1));
    const start = outlinePage * limit, list = finder.querySelector('#document-outline');
    list.replaceChildren();
    for (const row of rows.slice(start, start + limit)) {
      const {level, title, dest} = outlineEntry(row);
      const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
      button.dataset.title = title; button.dataset.kind = dest.kind;
      button.style.paddingLeft = `${Math.max(1, Math.min(level, 10)) * 12}px`;
      const page = destinationPage(dest, S.doc.pages.length);
      button.disabled = page === null && !(dest.kind === 'uri' && externalUri(dest.uri));
      const why = {none:'Heading without a destination', broken:'Its target is missing from this document',
                   unsupported:`Unsupported PDF action (${dest.action}); it is not run`}[dest.kind];
      if (why) button.title = why;
      else if (page !== null) button.title = `Page ${page + 1}${S.doc.labels?.[page] ? ` (label ${S.doc.labels[page]})` : ''}`;
      if (dest.kind === 'broken' || dest.kind === 'unsupported') {
        const note = document.createElement('span'); note.className = 'outline-note';
        note.textContent = dest.kind === 'broken' ? ' · missing target' : ' · unsupported';
        button.append(note);
      }
      button.onclick = () => {
        if (outlineDoc !== S.doc?.doc || outlineLayout !== S.doc?.layout) { paintOutline(); return; }
        activateDestination(dest);
      };
      list.append(button);
    }
    finder.querySelector('#outline-status').textContent = !outline.length ? 'This document has no outline.' :
      !rows.length ? 'No matching bookmarks.' : `${start + 1}–${Math.min(start + limit, rows.length)} of ${rows.length} bookmarks${outlineQuery.value.trim() ? ' (including parent headings)' : ''}.`;
    finder.querySelector('#outline-previous').disabled = outlinePage === 0;
    finder.querySelector('#outline-next').disabled = start + limit >= rows.length;
  }
  outlineQuery.oninput = () => { outlinePage = 0; paintOutline(); };
  finder.querySelector('#outline-clear').onclick = () => { outlineQuery.value = ''; outlinePage = 0; paintOutline(); outlineQuery.focus(); };
  finder.querySelector('#outline-previous').onclick = () => { outlinePage--; paintOutline(); };
  finder.querySelector('#outline-next').onclick = () => { outlinePage++; paintOutline(); };
  findButton.onclick = async () => {
    if (!finder.open) finder.show(); placeFinder(); docSearch.opened(); finder.querySelector('input').focus();
    const sharedOutline = !!globalThis.PdfOutline && !!globalThis.PDFPanels;
    finder.querySelector('#legacy-outline').hidden = sharedOutline;
    finder.querySelector('#find-outline-open').hidden = !sharedOutline;
    if (sharedOutline) return;
    const held = S.doc?.doc, layout = S.doc?.layout, generation = ++outlineGeneration;
    outline = []; outlinePage = 0; paintOutline();
    finder.querySelector('#outline-status').textContent = 'Loading bookmarks…';
    try {
      const nav = await api('get_navigation', {}, {priority:'adjacent'});
      if (generation !== outlineGeneration || S.doc?.doc !== held || S.doc?.layout !== layout) return;
      outlineDoc = held; outlineLayout = layout; outline = nav.outline; paintOutline();
    } catch (e) {
      if (generation === outlineGeneration) finder.querySelector('#outline-status').textContent = explain(e);
    }
  };
  document.getElementById('document-actions').prepend(findButton);
  // Document search (viewerSearch.js; SEARCH_PROTOCOL.md).
  const docSearch = PDFSearch.mountPanel({
    finder, navigate,
    request: (op, params, opts = {}) => api(op, params, opts),
    doc: () => S.doc ? {doc:S.doc.doc, revision:S.revision, pages:S.doc.pages.length,
                        pageGeo: i => S.doc.pages[i]?.geo} : null,
    page: i => S.doc?.pages[i], shell: i => VIEW.shells[i],
    mounted: i => VIEW.mounted.has(i), mountedPages: () => [...VIEW.mounted],
    ensureVisible: () => maintain(),
    perf: globalThis.PDFPerf, explain,
  });
  PDFUI.paintSearch = index => docSearch.paint(index);
  PDFUI.search = docSearch;
  PDFUI.revisionChanged = () => {
    if (outline.length && (outlineDoc !== S.doc?.doc || outlineLayout !== S.doc?.layout)) {
      outlineGeneration++; outline = []; paintOutline();
      finder.querySelector('#outline-status').textContent = 'Document changed. Reopen Find to reload bookmarks.';
    }
    docSearch.revisionChanged();
    // No verified page mapping comes with a structural change, so positions
    // recorded under the old layout are dropped, and said to be.
    if (S.doc && navHistory.invalidate(S.doc.doc, S.doc.layout)) {
      navStatus.textContent = 'Navigation history cleared: the page layout changed.';
      toast(navStatus.textContent, 'warn');
    }
    requestAnimationFrame(() => { for (const index of VIEW.mounted) paintLinks(index); });
  };
  PDFUI.navigationHistory = navHistory;

  // ---- links: read lazily for mounted pages that have any, by geo token.
  const linkCache = new Map(), linkPending = new Set();
  function drawLinks(index, geo, links) {
    const wrap = VIEW.shells[index], page = S.doc.pages[index];
    wrap.querySelector(':scope > .link-layer')?.remove();
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.classList.add('link-layer');
    svg.dataset.geo = geo;
    svg.setAttribute('viewBox', `0 0 ${page.width} ${page.height}`);
    svg.setAttribute('preserveAspectRatio','none'); svg.setAttribute('aria-hidden','true');
    for (const link of links) {
      const [x0, y0, x1, y1] = link.rect, rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', x0); rect.setAttribute('y', y0);
      rect.setAttribute('width', Math.max(0, x1 - x0)); rect.setAttribute('height', Math.max(0, y1 - y0));
      rect.dataset.kind = link.dest.kind; svg.append(rect);
    }
    wrap.append(svg);
  }
  function paintLinks(index) {
    // A layer outlives neither its page's mount nor its version.
    for (const layer of document.querySelectorAll('#pages .link-layer')) {
      const i = Number(layer.parentElement?.id?.slice(5));
      if (!VIEW.mounted.has(i) || S.doc?.pages[i]?.geo !== layer.dataset.geo) layer.remove();
    }
    const wrap = VIEW.shells[index], page = S.doc?.pages[index];
    if (!wrap || !page || !page.links || !VIEW.mounted.has(index)) return;
    const geo = page.geo;
    if (wrap.querySelector(':scope > .link-layer')?.dataset.geo === geo) return;
    if (linkCache.has(geo)) { drawLinks(index, geo, linkCache.get(geo)); return; }
    if (linkPending.has(geo)) return;
    linkPending.add(geo);
    api('get_page_links', {page:index, v:geo}, {priority:'adjacent'}).then(r => {
      if (r.geo !== geo) return;
      linkCache.set(geo, r.links);
      while (linkCache.size > 64) linkCache.delete(linkCache.keys().next().value);
      if (S.doc?.pages[index]?.geo === geo) paintLinks(index);
    }).catch(() => {}).finally(() => linkPending.delete(geo));
  }
  function linkUnder(ev) {
    const wrap = ev.target.closest?.('#pages > .page');
    if (!wrap || !S.doc) return null;
    const index = Number(wrap.id.slice(5)), page = S.doc.pages[index];
    const links = page && linkCache.get(page.geo);
    if (!links || wrap.querySelector(':scope > .link-layer')?.dataset.geo !== page.geo) return null;
    const r = wrap.getBoundingClientRect(), k = r.width / page.width;
    return linkAt(links, (ev.clientX - r.left) / k, (ev.clientY - r.top) / k);
  }
  // Links follow only a plain click in reading: never while editing text or
  // formulas, arming a mark, or at the end of a text-selection drag.
  const linksActive = () => !S.editOn && !FX.on && !MARKUP.active && !S.draft;
  let pressedAt = null;
  document.addEventListener('pointerdown', ev => { pressedAt = [ev.clientX, ev.clientY]; }, true);
  document.addEventListener('click', ev => {
    if (ev.button !== 0 || ev.defaultPrevented || !linksActive() || !pressedAt) return;
    if (Math.hypot(ev.clientX - pressedAt[0], ev.clientY - pressedAt[1]) > 4 || !getSelection().isCollapsed) return;
    if (ev.target.closest('#editor,button,a,input,textarea,select,[contenteditable="true"]')) return;
    const link = linkUnder(ev);
    if (!link) return;
    ev.preventDefault(); ev.stopPropagation();
    activateDestination(link.dest);
  });
  let hoverFrame = 0;
  stage.addEventListener('mousemove', ev => {
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; stage.classList.toggle('over-link', linksActive() && !!linkUnder(ev)); });
  }, {passive:true});

  const external = document.createElement('dialog');
  external.id = 'external-link'; external.setAttribute('aria-label', 'Open external link');
  external.innerHTML = `<p>This link leaves the PDF and opens in a new browser tab:</p><p><code id="external-link-uri"></code></p>
    <button id="external-link-open" type="button">Open link</button> <button id="external-link-cancel" type="button">Cancel</button>`;
  document.body.append(external);
  let externalTarget = null;
  external.querySelector('#external-link-cancel').onclick = () => { externalTarget = null; external.close(); };
  external.querySelector('#external-link-open').onclick = () => {
    const uri = externalUri(externalTarget); externalTarget = null; external.close();
    if (uri) window.open(uri, '_blank', 'noopener,noreferrer');
  };
  function activateDestination(dest) {
    if (dest?.kind === 'uri') {
      const uri = externalUri(dest.uri);
      if (!uri) { toast('This link’s address is not a web or mail address; it was not opened.', 'warn'); return; }
      externalTarget = uri; external.querySelector('#external-link-uri').textContent = uri;
      external.showModal(); external.querySelector('#external-link-cancel').focus(); return;
    }
    if (dest?.kind === 'unsupported') { toast(`This link uses a PDF action the viewer does not support (${dest.action}); it was not run.`, 'warn'); return; }
    if (dest?.kind === 'broken') { toast('This link’s target is missing from the document.', 'warn'); return; }
    const page = destinationPage(dest, S.doc?.pages.length || 0);
    if (page !== null) navigate(page, dest.point, true);
  }
  PDFUI.activateDestination = activateDestination;

  PDFUI.paintSearch = index => { paintLinks(index); docSearch.paint(index);
  };
  document.addEventListener('keydown', ev => {
    const editing = ev.target.closest?.('input,textarea,[contenteditable="true"]');
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f' && !editing) { ev.preventDefault(); findButton.click(); }
    else if (ev.key === 'F3' && !editing) { ev.preventDefault(); if (!finder.open) findButton.click(); if (docSearch.hasMatches()) (ev.shiftKey ? docSearch.previous() : docSearch.next()); }
    else if (ev.key === 'Escape' && finder.open && !document.getElementById('editor-transition')?.open && (finder.contains(ev.target) || (!editing && !S.draft))) { ev.preventDefault(); ev.stopPropagation(); finder.close(); }
  }, true);
  const pageActions = document.getElementById('workspace-parking');
  for (const [label, delta] of [['Move earlier', -1], ['Move later', 1]]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tbtn wide'; button.textContent = label;
    button.id = delta < 0 ? 'move-earlier' : 'move-later'; button.dataset.workspace = 'organize';
    button.onclick = () => pageOp(async () => {
      const selected = selectedPages(), layout = S.doc.layout, doc = S.doc.doc;
      if (!selected.length || !(await requestEditorTransition('reorder'))) return;
      if (layout !== S.doc.layout || doc !== S.doc.doc) return toast('Page layout changed. Select pages again.', 'warn');
      const order = S.doc.pages.map(p => p.index), chosen = new Set(selected);
      if (delta < 0) {
        for (let i = 1; i < order.length; i++) if (chosen.has(order[i]) && !chosen.has(order[i-1])) [order[i-1],order[i]] = [order[i],order[i-1]];
      } else {
        for (let i = order.length - 2; i >= 0; i--) if (chosen.has(order[i]) && !chosen.has(order[i+1])) [order[i],order[i+1]] = [order[i+1],order[i]];
      }
      if (order.every((p,i) => p === i)) return;
      const result = await mutate('page.reorder', {order,layout}, () => 'Selected pages moved.');
      if (pageReceiptCurrent(result, doc)) { S.selected = new Set(order.flatMap((p,i) => chosen.has(p) ? [i] : [])); syncRailSelection(); }
    });
    pageActions.append(button);
  }
  const selectPages = document.createElement('button');
  selectPages.id = 'select-pages'; selectPages.className = 'tbtn wide'; selectPages.type = 'button';
  selectPages.textContent = 'Select pages'; selectPages.dataset.workspace = 'organize'; pageActions.prepend(selectPages);
  const selectionDialog = document.createElement('dialog');
  selectionDialog.id = 'page-selection'; selectionDialog.setAttribute('aria-label', 'Select pages');
  selectionDialog.innerHTML = `<form method="dialog"><strong>Select pages</strong><button aria-label="Close page selection">×</button></form>
    <label>Pages <input id="page-range" maxlength="2048" placeholder="1, 3-5" aria-describedby="page-range-help"></label>
    <button id="page-range-apply" type="button">Select range</button>
    <p id="page-range-help">Use page positions, starting at 1. Selection replaces the current selection.</p>
    <div class="selection-presets">${['All','None','Odd','Even','Invert'].map(v => `<button type="button" data-select="${v.toLowerCase()}">${v}</button>`).join('')}</div>
    <p id="page-selection-status" role="status"></p>`;
  document.body.append(selectionDialog);
  const range = document.getElementById('page-range'), rangeStatus = document.getElementById('page-selection-status');
  function selectPageSet(chosen) {
    S.selected = chosen; S.selectionAnchor = chosen.size ? chosen.values().next().value : null;
    syncRailSelection(); range.removeAttribute('aria-invalid');
    rangeStatus.textContent = `${chosen.size} of ${S.doc.pages.length} pages selected. No document changes made.`;
  }
  selectPages.onclick = () => {
    if (!S.doc) return;
    range.value = ''; range.removeAttribute('aria-invalid');
    rangeStatus.textContent = `${S.selected.size} of ${S.doc.pages.length} pages selected.`;
    selectionDialog.showModal(); range.focus();
  };
  document.getElementById('page-range-apply').onclick = () => {
    try { selectPageSet(parsePageSelection(range.value, S.doc.pages.length)); }
    catch (e) { range.setAttribute('aria-invalid','true'); rangeStatus.textContent = e.message; }
  };
  range.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); document.getElementById('page-range-apply').click(); } };
  selectionDialog.querySelectorAll('[data-select]').forEach(button => {
    button.onclick = () => {
      const kind = button.dataset.select;
      selectPageSet(new Set(S.doc.pages.map(p => p.index).filter(i => kind === 'all' || (kind === 'odd' && i % 2 === 0) || (kind === 'even' && i % 2 === 1) || (kind === 'invert' && !S.selected.has(i)))));
    };
  });

  const noteFilters = document.createElement('div');
  noteFilters.id = 'comment-filters';
  noteFilters.innerHTML = `<input id="comment-query" type="search" maxlength="256" placeholder="Search comments" aria-label="Search comments and quoted text">
    <select id="comment-kind" aria-label="Comment type"><option value="">All types</option></select>
    <select id="comment-author" aria-label="Comment author"><option value="">All authors</option></select>
    <select id="comment-color" aria-label="Comment color"><option value="">All colors</option></select>
    <input id="comment-pages" aria-label="Comment page range" placeholder="Pages: 1, 3-5" maxlength="2048" aria-describedby="comment-page-error">
    <span id="comment-page-error" role="status"></span>
    <select id="comment-sort" aria-label="Sort comments"><option value="document">Document order</option><option value="newest">Newest first</option><option value="author">Author</option></select>
    <button id="comment-previous" type="button">Previous result</button><button id="comment-next" type="button">Next result</button>
    <button id="comment-clear" type="button">Clear filters</button><button id="notes-export" type="button">Export all notes</button><span id="comment-filter-count" role="status"></span>`;
  const notesExport = noteFilters.querySelector('#notes-export');
  notesExport.onclick = async () => {
    if (!S.doc || notesExport.disabled) return;
    if (NOTES.drafts.size && !confirm('Unapplied comment drafts are excluded. Export all saved notes anyway?')) return;
    const info = {...S.doc, revision:S.revision};
    notesExport.disabled = true;
    try {
      const markdown = await collectNotesExport(info,
        (op, args) => api(op, args, {priority:'adjacent'}),
        () => S.doc?.doc === info.doc && S.revision === info.revision,
        (page, total) => { notesExport.textContent = `Reading notes ${page}/${total}…`; });
      const blob = new Blob([markdown], {type:'text/markdown;charset=utf-8'});
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${info.name.replace(/\.pdf$/i, '')}-notes.md`;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
      toast('All saved notes downloaded. PDF and drafts are unchanged.', 'ok');
    } catch (e) { toast(explain(e), 'err'); }
    finally { notesExport.disabled = false; notesExport.textContent = 'Export all notes'; }
  };
  const commentQuery = noteFilters.querySelector('#comment-query');
  const commentKind = noteFilters.querySelector('#comment-kind');
  const commentAuthor = noteFilters.querySelector('#comment-author');
  const commentColor = noteFilters.querySelector('#comment-color');
  const commentPages = noteFilters.querySelector('#comment-pages');
  const commentSort = noteFilters.querySelector('#comment-sort');
  let pageFilter = null;
  let noteTimer = 0, noteFocus = null, noteFilterDoc = null;
  const refreshFilter = () => { clearTimeout(noteTimer); renderNotes(); };
  commentQuery.oninput = () => { clearTimeout(noteTimer); noteTimer = setTimeout(refreshFilter, 120); };
  commentKind.onchange = commentAuthor.onchange = commentColor.onchange = commentSort.onchange = refreshFilter;
  commentPages.oninput = () => {
    try {
      pageFilter = commentPages.value.trim() ? parsePageSelection(commentPages.value, S.doc.pages.length) : null;
      commentPages.removeAttribute('aria-invalid');noteFilters.querySelector('#comment-page-error').textContent='';refreshFilter();
    } catch(e) {commentPages.setAttribute('aria-invalid','true');noteFilters.querySelector('#comment-page-error').textContent=e.message+' Previous valid range retained.';}
  };
  noteFilters.querySelector('#comment-clear').onclick = () => { commentQuery.value = commentKind.value = commentAuthor.value = commentColor.value = commentPages.value = '';pageFilter=null;commentSort.value='document';commentPages.removeAttribute('aria-invalid');noteFilters.querySelector('#comment-page-error').textContent='';refreshFilter();commentQuery.focus(); };
  for(const [id,delta] of [['comment-previous',-1],['comment-next',1]]) noteFilters.querySelector('#'+id).onclick=()=>{
    const i=NOTES.filteredTop.findIndex(a=>a.xref===NOTES.sel);
    focusNoteResult(i<0?(delta>0?0:NOTES.filteredTop.length-1):i+delta);
  };
  PDFUI.beforeNotesRender = () => { noteFocus = noteFilters.contains(document.activeElement) ? document.activeElement : null; };
  PDFUI.filterNotes = top => {
    if (noteFilterDoc !== NOTES.doc) { commentQuery.value = commentKind.value = commentAuthor.value = commentColor.value = commentPages.value = '';pageFilter=null;commentSort.value='document';commentPages.removeAttribute('aria-invalid');noteFilters.querySelector('#comment-page-error').textContent='';noteFilterDoc = NOTES.doc; }
    return filterCommentThreads(top, NOTES.all, NOTES.drafts, {query:commentQuery.value,kind:commentKind.value,author:commentAuthor.value,color:commentColor.value,pages:pageFilter,sort:commentSort.value});
  };
  function noteOptions(select, field, title) {
    const values = [...new Set(NOTES.all.map(a => field==='color'?commentColorKey(a.color):a[field]).filter(Boolean))].sort();
    const held = select.value;
    if (held && !values.includes(held)) values.push(held);
    const key = JSON.stringify(values);
    if (select.dataset.options === key) return;
    select.replaceChildren(new Option(title, ''));
    for (const value of values) select.add(new Option(field === 'kind' ? (KIND_LABEL[value] || value) : value, value));
    select.value = held; select.dataset.options = key;
  }
  PDFUI.notesRendered = (panel, total) => {
    noteOptions(commentKind, 'kind', 'All types'); noteOptions(commentAuthor, 'author', 'All authors');
    noteOptions(commentColor, 'color', 'All colors');
    const count=NOTES.filteredTop.length,index=NOTES.filteredTop.findIndex(a=>a.xref===NOTES.sel);
    noteFilters.querySelector('#comment-filter-count').textContent = `${count} / ${total} ${NOTES.complete ? 'threads' : 'loaded threads (incomplete)'}${index>=0?' · result '+(index+1):''}${NOTES.drafts.size ? ' · drafts kept visible' : ''}`;
    for(const id of ['comment-previous','comment-next'])noteFilters.querySelector('#'+id).disabled=!count;
    if(noteFilters.parentElement!==panel.querySelector('.nhead'))panel.querySelector('.nhead').append(noteFilters);
    noteFocus?.focus({preventScroll:true}); noteFocus = null;
  };

  let checkedRecovery = false;
  async function offerRecovery() {
    if (!S.doc || checkedRecovery) return;
    checkedRecovery = true;
    try {
      const result = await api('list_recoveries', {}, {priority:'adjacent'});
      if (!result.recoveries.length) return;
      const warning = document.createElement('div'); warning.className = 'warn';
      const label = document.createElement('span'); label.textContent = 'An earlier session has recoverable changes. ';
      warning.append(label);
      for (const rec of result.recoveries) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `Restore session ${rec.created}`;
        button.onclick = async () => {
          if (unsentDraft()) { toast('Apply or cancel your drafts before restoring a session.', 'warn'); return; }
          if (!confirm('Restore this earlier session, including its verified edits and undo history?')) return;
          button.disabled = true;
          try {
            await post('restore_recovery', {backup_id:rec.backup_id, revision:S.revision});
            disposeEditor('restore'); await load(); await refreshUndo(); warning.remove();
            toast('Verified session recovered. Export a copy to keep the recovered changes.', 'ok');
          } catch (e) { button.disabled = false; toast(explain(e), 'err'); }
        };
        warning.append(button);
      }
      document.getElementById('warnings').append(warning);
    } catch (e) { toast(`Recovery check failed: ${explain(e)}`, 'warn'); }
  }
  const changed = globalThis.PDFUI.documentChanged;
  globalThis.PDFUI.documentChanged = function() { changed.call(this); queueMicrotask(offerRecovery); };
  if (S.doc) globalThis.PDFUI.documentChanged();
})();

/* UI-01: one workspace state, fixed actions, and a measured More menu.
 *
 * The workspace is one value. Changing it goes through the SAFE-01 editor
 * transition first, then turns off what the old workspace armed (Edit Text,
 * formula boxing, repeated markup) through the tools' own functions. Tools of
 * the current workspace sit in #workspace-tools in a fixed order; whatever does
 * not fit -- measured after every size or text-size change -- moves into the
 * More menu in that same order, so no action depends on toolbar scrolling. */
(() => {
  const toolbar = document.getElementById('toolbar');
  const container = document.getElementById('workspace-tools');
  const bar = document.getElementById('workspace-tools-bar');
  const parking = document.getElementById('workspace-parking');
  const more = document.getElementById('tools-more');
  const list = document.getElementById('tools-more-list');
  const tabs = [...document.querySelectorAll('[data-workspace-tab]')];
  // The order tools appear in, bar first then More. Units added later by other
  // scripts are found by id when the page has loaded.
  const ORDER = [
    ['markgroup', 'annotate'],
    ['text-toggle', 'edit'], ['formula-toggle', 'edit'], ['stylegroup', 'edit'],
    ['organize-pages', 'organize'], ['select-pages', 'organize'], ['rot-l', 'organize'], ['rot-r', 'organize'], ['del', 'organize'],
    ['move-earlier', 'organize'], ['move-later', 'organize'],
    ['export-compact', 'organize'], ['recover-drafts', 'organize'],
  ];
  const extra = [];
  let current = 'read', switching = false, signature = '', frame = 0;
  const units = () => [...ORDER, ...extra].map(([id, ws]) => {
    const el = document.getElementById(id);
    if (el) el.dataset.workspace = ws;
    return el;
  }).filter(Boolean);
  const activeIn = el => el.dataset.workspace === 'all' || el.dataset.workspace === current;

  function closeMore(focus = false) {
    if (list.hidden) return;
    list.hidden = true; more.setAttribute('aria-expanded', 'false');
    if (focus) more.focus();
  }
  function placeMore() {
    const r = more.getBoundingClientRect();
    const top = Math.min(r.bottom + 4, innerHeight - 80);
    list.style.top = `${Math.max(4, top)}px`;
    list.style.maxHeight = `${Math.max(80, innerHeight - top - 8)}px`;
    // Below More, starting at its left edge, moved left only as far as it must to stay on screen.
    const width = list.getBoundingClientRect().width;
    list.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  }
  more.onclick = () => {
    if (!list.hidden) return closeMore(true);
    list.hidden = false; more.setAttribute('aria-expanded', 'true'); placeMore();
    list.querySelector('button:not(:disabled), select:not(:disabled), input:not(:disabled), summary')?.focus();
  };
  list.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMore(true); }
  });
  more.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !list.hidden) { ev.preventDefault(); ev.stopPropagation(); closeMore(true); }
  });
  document.addEventListener('pointerdown', ev => {
    if (!list.hidden && !list.contains(ev.target) && !more.contains(ev.target)) closeMore();
  }, true);

  // Bar first; then, if they do not all fit, the overflow moves into More.
  function layout(force = false) {
    frame = 0;
    const width = container.clientWidth;
    const sig = [width, getComputedStyle(document.documentElement).fontSize, devicePixelRatio, current, units().length,
                 bar.scrollWidth, bar.clientWidth].join('|');
    if (!force && sig === signature) return;
    signature = sig;
    const active = [], idle = [];
    for (const el of units()) (activeIn(el) ? active : idle).push(el);
    if (idle.length) parking.append(...idle);
    const wasOpen = !list.hidden;
    more.hidden = true;
    bar.append(...active);
    if (!active.length) { list.replaceChildren(); closeMore(); return; }
    const style = getComputedStyle(bar);
    const gap = parseFloat(style.columnGap) || 0;
    const pad = parseFloat(getComputedStyle(container).paddingLeft) + parseFloat(getComputedStyle(container).paddingRight);
    const available = width - (pad || 0);
    const widths = active.map(el => el.getBoundingClientRect().width);
    let keep = planToolOverflow(widths, available, 0, gap);
    if (keep < active.length) {
      more.hidden = false;
      const outer = parseFloat(getComputedStyle(container).columnGap) || 0;
      keep = planToolOverflow(widths, available, more.getBoundingClientRect().width + outer, gap);
      list.append(...active.slice(keep));
      more.textContent = `More (${active.length - keep}) ▾`;
      if (wasOpen) placeMore(); else closeMore();
    } else { list.replaceChildren(); closeMore(); }
    toolbar.dataset.toolsInMore = String(active.length - keep);
  }
  function schedule(force = false) {
    if (force) signature = '';
    if (!frame) frame = requestAnimationFrame(() => layout());
  }
  const observer = new ResizeObserver(() => schedule());
  observer.observe(container); observer.observe(toolbar); observer.observe(bar); observer.observe(document.documentElement);

  function apply(next) {
    switching = true;
    try {
      current = next;
      if (next !== 'annotate') setActiveMarkup(null);
      if (next !== 'edit') {
        if (S.editOn) document.getElementById('text-toggle').click();
        formulaMode(false);
      } else if (!S.editOn) {
        document.getElementById('text-toggle').click();
      }
      for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.workspaceTab === next));
      toolbar.dataset.workspace = next;
      layout(true);
      scheduleMaintain();
      globalThis.PDFUI?.workspaceChanged?.(next);
    } finally { switching = false; }
  }
  // Leaving a workspace with an open editor asks first (SAFE-01); Keep editing
  // leaves the workspace and the editor exactly as they were.
  async function setWorkspace(next) {
    if (!WORKSPACES.includes(next) || switching) return false;
    if (next === current) return true;
    if (editorOpen() && !(await requestEditorTransition('workspace'))) return false;
    apply(next);
    return true;
  }
  for (const tab of tabs) tab.onclick = () => { void setWorkspace(tab.dataset.workspaceTab); };
  globalThis.PDFUI.workspace = () => current;
  globalThis.PDFUI.setWorkspace = setWorkspace;
  globalThis.PDFUI.toolsChanged = () => schedule(true);
  // A later controller (UI-04's Organize grid) adds its own tool unit here.
  globalThis.PDFUI.addTool = (id, ws, beforeId = 'export-compact') => {
    const at = ORDER.findIndex(([name]) => name === beforeId);
    if (at >= 0) ORDER.splice(at, 0, [id, ws]); else extra.push([id, ws]);
    schedule(true);
  };
  const changed = globalThis.PDFUI.documentChanged;
  globalThis.PDFUI.documentChanged = function() { changed.call(this); schedule(true); };
  function start() {
    for (const el of units()) if (!activeIn(el)) parking.append(el);
    apply(current);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
