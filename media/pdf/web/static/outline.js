/* PdfOutline.mount(container, ctx) owns one document's tree and analysis.
 * PdfOutline.unmount(container) releases timers/listeners and retained rows.
 * The panel owns visibility; hiding never cancels an analysis or loses state.
 * No document text is persisted. Pure logic also runs under Node.
 */
(function (root) {
  'use strict';
  const SOURCE_LABELS = {bookmarks: 'PDF bookmarks', contents: 'Detected contents', inferred: 'Inferred headings'};
  const fold = text => String(text).replace(/[Iİı]/g, 'i').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');
  function fromBookmarks(outline, count) {
    const parents = [];
    return outline.map((raw, n) => {
      const legacy = Array.isArray(raw), level = Math.max(1, legacy ? raw[0] : raw.level);
      let dest = legacy ? {kind: 'page', page: raw[2] - 1} : raw.dest;
      let reason = '';
      if (!dest || dest.kind === 'none') { dest = null; reason = 'No destination'; }
      else if (dest.kind === 'broken' || (dest.kind === 'page' && (!Number.isInteger(dest.page) || dest.page < 0 || dest.page >= count))) {
        dest = null; reason = 'Target is missing from this document';
      } else if (dest.kind === 'unsupported') { dest = null; reason = 'Unsupported PDF action'; }
      const parent_id = !legacy && Number.isInteger(raw.parent) ? `b${raw.parent}` : parents[level - 1] || null;
      parents[level] = `b${n}`; parents.length = level + 1;
      return {id: `b${n}`, parent_id, level, title: String(legacy ? raw[1] : raw.title), source: 'bookmarks',
        confidence: 'embedded', group: 'main', dest, reason, original_kind: legacy ? 'page' : raw.dest?.kind || 'none'};
    });
  }
  function visibleRows(items, {expanded = new Set(), filter = ''} = {}) {
    const byId = new Map(items.map(i => [i.id, i])), children = new Set(items.map(i => i.parent_id));
    const needle = fold(filter.trim()), matches = new Set(), keep = new Set();
    if (needle) for (const item of items) if (fold(item.title).includes(needle)) {
      matches.add(item.id);
      let at = item;
      while (at && !keep.has(at.id)) { keep.add(at.id); at = byId.get(at.parent_id); }
    }
    const shown = new Set(), rows = [];
    for (const item of items) {
      if (needle ? !keep.has(item.id) : byId.has(item.parent_id) && (!shown.has(item.parent_id) || !expanded.has(item.parent_id))) continue;
      shown.add(item.id);
      rows.push({item, depth: Math.max(1, item.level || 1), hasChildren: children.has(item.id),
        expanded: needle ? children.has(item.id) : expanded.has(item.id), match: matches.has(item.id)});
    }
    return rows;
  }
  function keyAction(rows, focus, key, expanded) {
    if (!rows.length) return null;
    const n = Math.max(0, rows.findIndex(r => r.item.id === focus)), row = rows[n], id = row.item.id;
    if (key === 'ArrowDown') return {focus: rows[Math.min(n + 1, rows.length - 1)].item.id};
    if (key === 'ArrowUp') return {focus: rows[Math.max(n - 1, 0)].item.id};
    if (key === 'Home') return {focus: rows[0].item.id};
    if (key === 'End') return {focus: rows.at(-1).item.id};
    if (key === 'Enter' || key === ' ') return {focus: id, activate: id};
    if (key === 'ArrowRight') return row.hasChildren && !expanded.has(id) ? {focus: id, expand: id}
      : {focus: row.hasChildren ? rows[Math.min(n + 1, rows.length - 1)].item.id : id};
    if (key === 'ArrowLeft') return row.hasChildren && expanded.has(id) ? {focus: id, collapse: id}
      : {focus: rows.some(r => r.item.id === row.item.parent_id) ? row.item.parent_id : id};
    return null;
  }
  function activeId(items, at) {
    if (!at) return null;
    let best = null, key = [-1, -Infinity];
    for (const i of items) {
      const d = i.dest, y = d?.point?.[1] ?? 0;
      if (!d || !Number.isInteger(d.page) || d.page > at.page || (d.page === at.page && y > (at.point?.[1] ?? 0))) continue;
      if (d.page > key[0] || (d.page === key[0] && y >= key[1])) { best = i.id; key = [d.page, y]; }
    }
    return best;
  }
  function staleReason(dest, doc) {
    if (!dest) return 'No destination';
    if (dest.kind === 'uri') return null;
    if (!doc || !Number.isInteger(dest.page) || !doc.pages?.[dest.page]) return 'Target is not in this document';
    return dest.geo && dest.geo !== doc.pages[dest.page].geo ? 'Document geometry changed. Retry analysis.' : null;
  }
  function statusText(r) {
    if (!r) return 'Choose a source or detect headings.';
    const progress = `${r.pages_scanned || 0} of ${r.pages_total || 0} pages`;
    if (r.status === 'running') return `Detecting headings: ${progress}…`;
    if (r.status === 'stale') return 'Document changed. Retry analysis.';
    if (r.status === 'failed') return 'Heading analysis failed. Retry analysis.';
    if (r.status === 'cancelled') return `Cancelled at ${progress}. Retained results may be incomplete.`;
    if (r.status === 'partial') return `Partial results: ${progress} (${r.reason || 'analysis limit'}).`;
    if (r.reason === 'text_recognition_required') return 'This document needs text recognition before headings can be detected.';
    return r.counts?.main ? `${r.counts.main} headings; ${r.counts.review || 0} uncertain candidates for review.` : 'No headings found.';
  }
  function rowWindow(rows, focus, limit = 300) {
    const start = Math.max(0, Math.min(rows.length - limit, Math.max(0, focus) - Math.floor(limit / 2)));
    return {start, end: Math.min(rows.length, start + limit)};
  }
  function createStore() {
    const states = new Map();
    return {get(id) {
      if (!states.has(id)) states.set(id, {open: false, source: 'bookmarks', analysisId: null, generation: null,
        filter: '', expandedIds: new Set(), focusedId: null, activeId: null});
      return states.get(id);
    }, release(id) { states.delete(id); }};
  }
  function generationChanged(error) {
    return error?.code === 'generation_changed' || (error?.code === 'VERSION_GONE'
      && [error.reason, error.details?.reason, error.body?.reason].includes('generation_changed'));
  }
  const logic = {SOURCE_LABELS, fromBookmarks, visibleRows, keyAction, activeId, staleReason, statusText, rowWindow, createStore, generationChanged};
  const mounted = new WeakMap();
  function unmount(container) { mounted.get(container)?.destroy(); mounted.delete(container); }
  function mount(container, ctx) {
    if (mounted.has(container)) return mounted.get(container);
    const document = container.ownerDocument, store = createStore();
    let docId = null, stamp = '', state, items = [], bookmarks = [], report = null, epoch = 0, pending = false, dead = false;
    let timer = null, frame = null, rows = [], bookmarkLoaded = false;
    const element = (tag, text, attrs = {}) => {
      const e = document.createElement(tag); if (text) e.textContent = text;
      for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
      return e;
    };
    const source = element('select', '', {'aria-label': 'Outline source', id: 'outline-source'});
    for (const [key, label] of Object.entries(SOURCE_LABELS)) { const opt = element('option', label, {value: key}); source.append(opt); }
    const filter = element('input', '', {type: 'search', 'aria-label': 'Filter headings', placeholder: 'Filter headings', maxlength: 256, id: 'outline-filter'});
    const retry = element('button', 'Detect headings', {type: 'button', id: 'outline-detect'});
    const cancel = element('button', 'Cancel analysis', {type: 'button', id: 'outline-cancel'});
    const status = element('p', '', {role: 'status', class: 'outline-status', id: 'outline-status-live'});
    const review = element('input', '', {type: 'checkbox', id: 'outline-review'});
    const reviewLabel = element('label', 'Include uncertain candidates '); reviewLabel.prepend(review);
    const tree = element('div', '', {role: 'tree', 'aria-label': 'Document headings', id: 'outline-tree'});
    const previous = element('button', 'Previous headings', {type: 'button', id: 'outline-previous-window'}), next = element('button', 'Next headings', {type: 'button', id: 'outline-next-window'});
    const range = element('p', '', {class: 'outline-status', id: 'outline-range'}), paging = element('div', '', {class: 'outline-paging'});
    paging.append(previous, next);
    container.replaceChildren(source, filter, retry, cancel, status, reviewLabel, tree, range, paging);
    const signature = d => d ? `${d.doc}|${d.layout}|${d.revision ?? ''}` : '';
    const current = token => !dead && token === epoch && ctx.getDocument()?.doc === docId;
    function syncDocument() {
      const d = ctx.getDocument(), nextStamp = signature(d);
      if (nextStamp === stamp) return;
      epoch++; pending = false; clearTimeout(timer); timer = null;
      if (docId !== d?.doc) {
        store.release(docId); docId = d?.doc || null; state = store.get(docId);
        items = []; bookmarks = []; report = null; bookmarkLoaded = false;
        filter.value = ''; source.value = state.source;
      } else {
        items = []; bookmarks = []; bookmarkLoaded = false;
        state.analysisId = null; state.generation = null;
        report = {status: 'stale'};
      }
      stamp = nextStamp;
      if (state) state.open = ctx.isVisible();
      paint();
    }
    function chosenItems() {
      if (state.source === 'bookmarks') return bookmarks;
      const available = items.filter(i => review.checked || i.group !== 'review');
      const byId = new Map(available.map(i => [i.id, i])), included = new Set();
      for (const item of available) if (item.source === state.source) {
        let at = item;
        while (at && !included.has(at.id)) { included.add(at.id); at = byId.get(at.parent_id); }
      }
      return available.filter(i => included.has(i.id));
    }
    function updateActive() {
      if (!state) return;
      const a = ctx.readingAnchor();
      state.activeId = activeId(chosenItems(), a && {page: a.index ?? a.page, point: a.point || [a.x, a.y]});
      for (const el of tree.children) {
        const active = el.dataset.id === state.activeId;
        el.classList.toggle('outline-active', active);
        if (active) el.setAttribute('aria-current', 'location'); else el.removeAttribute('aria-current');
      }
    }
    function activate(item) {
      const why = staleReason(item.dest, ctx.getDocument());
      if (why || signature(ctx.getDocument()) !== stamp) { status.textContent = why || 'Document changed. Retry analysis.'; return; }
      if (ctx.activateDestination) ctx.activateDestination(item.dest.kind ? item.dest : {...item.dest, kind: 'page'});
      else if (item.dest.kind !== 'uri') ctx.navigate(item.dest.page, item.dest.point && {x: item.dest.point[0], y: item.dest.point[1]});
      updateActive();
    }
    function paint(focus = false) {
      if (!state || dead) return;
      const hadTreeFocus = tree.contains(document.activeElement);
      state.open = ctx.isVisible();
      rows = visibleRows(chosenItems(), {expanded: state.expandedIds, filter: state.filter});
      if (!rows.some(r => r.item.id === state.focusedId)) state.focusedId = rows[0]?.item.id || null;
      const at = Math.max(0, rows.findIndex(r => r.item.id === state.focusedId)), window = rowWindow(rows, at);
      tree.replaceChildren();
      for (const row of rows.slice(window.start, window.end)) {
        const i = row.item, node = element('div', '', {role: 'treeitem', tabindex: i.id === state.focusedId ? 0 : -1,
          'aria-level': Math.min(100, row.depth), 'data-id': i.id, 'data-title': i.title});
        node.style.paddingLeft = `${Math.min(10, row.depth - 1) * 12}px`;
        if (row.hasChildren) node.setAttribute('aria-expanded', String(row.expanded));
        const twist = element('span', row.hasChildren ? row.expanded ? '▾ ' : '▸ ' : '', {'aria-hidden': 'true'});
        node.append(twist, element('span', i.title));
        const p = i.dest?.page, label = ctx.getDocument()?.labels?.[p];
        const annotation = i.group === 'review' ? ' · uncertain' : '';
        node.append(element('span', Number.isInteger(p) ? ` · ${label && label !== String(p + 1) ? `${label} (p. ${p + 1})` : `p. ${p + 1}`}${annotation}` : annotation, {class: 'outline-page'}));
        const why = staleReason(i.dest, ctx.getDocument());
        node.dataset.kind = i.original_kind || 'page';
        if (why) node.setAttribute('aria-disabled', 'true');
        node.title = [SOURCE_LABELS[i.source], i.confidence, i.reason || why || ''].filter(Boolean).join(' · ');
        node.onclick = event => {
          state.focusedId = i.id;
          if (event.target === twist && row.hasChildren) {
            state.expandedIds.has(i.id) ? state.expandedIds.delete(i.id) : state.expandedIds.add(i.id); paint(true);
          } else { node.focus({preventScroll: true}); activate(i); }
        };
        node.onfocus = () => { state.focusedId = i.id; for (const other of tree.children) other.tabIndex = other === node ? 0 : -1; };
        tree.append(node);
      }
      range.textContent = rows.length ? `${window.start + 1}–${window.end} of ${rows.length}` : 'No matching headings.';
      previous.disabled = window.start === 0; next.disabled = window.end >= rows.length;
      status.textContent = state.source === 'bookmarks' ? `${bookmarks.length} PDF bookmarks.` : statusText(report);
      retry.textContent = report?.status === 'running' ? 'Detecting…' : state.analysisId || report ? 'Retry analysis' : 'Detect headings';
      retry.disabled = pending || report?.status === 'running'; cancel.disabled = report?.status !== 'running';
      updateActive();
      if (focus || hadTreeFocus) {
        const el = [...tree.children].find(n => n.dataset.id === state.focusedId);
        el?.focus({preventScroll: true});
        if (focus) el?.scrollIntoView({block: 'nearest'});
      }
    }
    async function loadBookmarks() {
      if (!docId || bookmarkLoaded) return;
      bookmarkLoaded = true; const token = epoch;
      try {
        const nav = await ctx.request('get_navigation');
        if (!current(token)) return;
        if (nav.layout !== ctx.getDocument().layout) { bookmarkLoaded = false; return; }
        bookmarks = fromBookmarks(nav.outline || [], ctx.getDocument().pages.length); paint();
        if (!bookmarks.length && !state.analysisId && !report) { state.source = 'inferred'; source.value = state.source; await start(); }
      } catch (e) { if (current(token)) { bookmarkLoaded = false; status.textContent = `Bookmarks unavailable: ${e.message}`; } }
    }
    function later() { clearTimeout(timer); if (!dead && report?.status === 'running') timer = setTimeout(read, 250); }
    async function read() {
      syncDocument(); if (!state.analysisId || pending || dead) return;
      const token = epoch, aid = state.analysisId; pending = true;
      try {
        let cursor = 0, generation = null, batch = [], answer;
        do {
          answer = await ctx.request('read_outline_analysis', {analysis_id: aid, cursor, limit: 200,
            ...(generation === null ? {} : {generation})});
          if (!current(token) || state.analysisId !== aid) return;
          if (answer.layout !== ctx.getDocument().layout || answer.revision !== ctx.getDocument().revision) { report = {status: 'stale'}; items = []; return; }
          generation = answer.generation; batch.push(...answer.items);
          if (batch.length > 10000) throw Error('Outline item limit exceeded');
          if (answer.next_cursor !== null && answer.next_cursor !== undefined && answer.next_cursor <= cursor) throw Error('Invalid outline cursor');
          cursor = answer.next_cursor;
        } while (cursor !== null && cursor !== undefined);
        items = batch; report = answer; state.generation = generation;
      } catch (e) {
        if (!current(token)) return;
        if (generationChanged(e)) { report = {...report, status: 'running'}; }
        else report = {status: 'failed', reason: e.message};
      } finally {
        if (current(token)) { pending = false; paint(); later(); }
      }
    }
    async function start() {
      syncDocument(); if (!docId || pending || report?.status === 'running') return;
      const token = epoch; pending = true; retry.disabled = true;
      try {
        const answer = await ctx.request('start_outline_analysis', {expected_revision: ctx.getDocument().revision});
        if (!current(token)) return;
        state.analysisId = answer.analysis_id; report = answer; items = [];
      } catch (e) { if (current(token)) report = {status: 'failed', reason: e.message}; }
      finally { if (current(token)) { pending = false; paint(); if (state.analysisId) read(); } }
    }
    cancel.onclick = async () => {
      const aid = state.analysisId; if (!aid) return;
      const token = ++epoch; pending = false; clearTimeout(timer);
      cancel.disabled = true;
      try { const answer = await ctx.request('cancel_outline_analysis', {analysis_id: aid}); if (current(token)) { report = answer; clearTimeout(timer); paint(); } }
      catch (e) { if (current(token)) status.textContent = `Cancellation failed: ${e.message}`; }
    };
    retry.onclick = () => { if (state.source === 'bookmarks') { state.source = 'inferred'; source.value = 'inferred'; } start(); };
    source.onchange = () => { state.source = source.value; paint(); if (state.source !== 'bookmarks' && !state.analysisId) start(); };
    filter.oninput = () => { state.filter = filter.value; paint(); };
    review.onchange = () => paint();
    tree.onkeydown = e => {
      const action = keyAction(rows, state.focusedId, e.key, state.expandedIds); if (!action) return;
      e.preventDefault(); state.focusedId = action.focus;
      if (action.expand) state.expandedIds.add(action.expand);
      if (action.collapse) state.expandedIds.delete(action.collapse);
      if (action.activate) activate(rows.find(r => r.item.id === action.activate).item);
      paint(true);
    };
    const pageRows = direction => { const at = Math.max(0, rows.findIndex(r => r.item.id === state.focusedId)); state.focusedId = rows[Math.max(0, Math.min(rows.length - 1, at + direction * 250))]?.item.id; paint(true); };
    previous.onclick = () => pageRows(-1); next.onclick = () => pageRows(1);
    const visibility = () => { syncDocument(); state.open = ctx.isVisible(); if (state.open) { loadBookmarks(); paint(); } };
    const stage = document.getElementById('stage');
    const scroll = () => { if (frame === null) frame = requestAnimationFrame(() => { frame = null; updateActive(); }); };
    container.addEventListener('pdfpanels:visibility', visibility); stage?.addEventListener('scroll', scroll, {passive: true});
    // Document/revision changes can happen with the sidebar closed. Poll only
    // identity metadata; no native extraction is initiated by this timer.
    const identityTimer = setInterval(() => { const old = stamp; syncDocument(); if (old !== stamp && ctx.isVisible()) loadBookmarks(); }, 250);
    const leaving = () => unmount(container);
    root.addEventListener('pagehide', leaving);
    const api = {destroy() { dead = true; epoch++; clearTimeout(timer); clearInterval(identityTimer);
      if (frame !== null) cancelAnimationFrame(frame); stage?.removeEventListener('scroll', scroll);
      root.removeEventListener('pagehide', leaving);
      container.removeEventListener('pdfpanels:visibility', visibility); store.release(docId); items = bookmarks = []; container.replaceChildren(); }};
    mounted.set(container, api); syncDocument(); loadBookmarks(); return api;
  }
  const api = {mount, unmount, logic};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root?.document) { root.PdfOutline = api; root.PDFPanels?.attachOutline(); }
})(typeof globalThis === 'undefined' ? this : globalThis);
