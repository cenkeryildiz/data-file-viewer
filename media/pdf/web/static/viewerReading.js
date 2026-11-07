/* Plain reading text follows engine order; never reconstruct order from boxes. */
function readingSegments(data, limit = 16000) {
  if (!Array.isArray(data?.lines) || data.lines.length > 20000) throw Error('This page exceeds the reading-view limit.');
  if (!Number.isInteger(limit) || limit < 2) throw Error('Invalid section limit.');
  let text = '', count = 0;
  for (const line of data.lines) {
    if (!Array.isArray(line.chars)) throw Error('Invalid reading text.');
    if (text) text += '\n';
    for (const char of line.chars) {
      if (++count > 200000) throw Error('This page exceeds the reading-view limit.');
      if (typeof char?.c !== 'string') throw Error('Invalid reading character.');
      text += char.c;
      if (text.length > 200000) throw Error('This page exceeds the reading-view limit.');
    }
  }
  const segments = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    // Do not split a supplementary Unicode character between sections.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    segments.push(text.slice(start, end)); start = end;
  }
  return segments;
}

(() => {
  const button = document.createElement('button');
  button.id = 'reading-toggle'; button.type = 'button'; button.className = 'tbtn wide';
  button.textContent = 'Read text'; button.setAttribute('aria-haspopup', 'dialog');
  document.getElementById('recover-drafts').after(button);
  const panel = document.createElement('dialog'); panel.id = 'reading-view';
  panel.setAttribute('aria-labelledby', 'reading-title');
  panel.innerHTML = `<form method="dialog"><h2 id="reading-title">Read page text</h2><button aria-label="Close reading view">×</button></form>
    <p>Extracted text in the engine's order. Images have no text here; formulas and complex layouts may need the visual page. Nothing is edited.</p>
    <nav aria-label="Reading pages"><button type="button" id="reading-prev">Previous page</button>
    <label>Page <input id="reading-page" type="number" min="1" value="1"></label>
    <button type="button" id="reading-next">Next page</button><button type="button" id="reading-refresh">Reload text</button></nav>
    <p id="reading-status" role="status"></p><p id="reading-error" role="alert"></p>
    <pre id="reading-text" tabindex="0" role="document" aria-label="Extracted page text"></pre>
    <nav aria-label="Text sections"><button type="button" id="reading-before">Previous section</button><button type="button" id="reading-after">Next section</button></nav>`;
  document.body.append(panel);
  // Modal keys belong to reading controls, not underlying edit/undo shortcuts.
  panel.addEventListener('keydown', event => event.stopPropagation());
  const get = id => panel.querySelector('#reading-' + id), content = get('text');
  let page = 0, section = 0, pieces = [], generation = 0, controller = null;
  function sections() {
    get('before').disabled = section === 0;
    get('after').disabled = section >= pieces.length - 1;
  }
  function paint() {
    content.textContent = pieces[section] || '';
    content.setAttribute('aria-label', `Page ${page+1}, text section ${section+1}`);
    get('status').textContent = pieces.length ? `Page ${page+1} of ${S.doc.pages.length} · section ${section+1} of ${pieces.length}` : `Page ${page+1}: no extractable text. No OCR was performed.`;
    sections(); content.scrollTop = 0;
  }
  function clear() {
    generation++; controller?.abort(); controller = null; pieces = []; section = 0;
    content.textContent = ''; content.removeAttribute('aria-busy'); sections();
  }
  async function read(index) {
    if (!S.doc || !Number.isInteger(index) || index < 0 || index >= S.doc.pages.length) {
      get('error').textContent = 'Choose a page number within this document.'; get('page').value = page + 1; return;
    }
    clear(); page = index; get('page').value = page + 1; get('page').max = S.doc.pages.length;
    get('prev').disabled = page === 0; get('next').disabled = page >= S.doc.pages.length - 1;
    get('error').textContent = ''; get('status').textContent = `Loading page ${page+1}…`; content.setAttribute('aria-busy', 'true');
    const ticket = generation, doc = S.doc.doc, revision = S.revision, geo = S.doc.pages[page].geo;
    controller = new AbortController();
    try {
      const data = await api('get_page_lines', {page, v:geo}, {priority:'visible', signal:controller.signal});
      if (ticket !== generation || !panel.open) return;
      if (S.doc?.doc !== doc || S.revision !== revision || S.doc.pages[page]?.geo !== geo || data.geo !== geo || data.page !== page) throw Error('The document changed. Reload text.');
      pieces = readingSegments(data); paint();
    } catch (error) {
      if (ticket === generation && panel.open) { get('status').textContent = 'Text unavailable.'; get('error').textContent = error.message || 'Could not read text. Reload to retry.'; }
    } finally { if (ticket === generation) { controller = null; content.removeAttribute('aria-busy'); } }
  }
  button.onclick = () => {
    if (!S.doc) return;
    panel.showModal();
    void read(Math.max(0, Math.min(S.doc.pages.length - 1, Number(document.getElementById('page-number').value) - 1)));
  };
  get('prev').onclick = () => void read(page - 1);
  get('next').onclick = () => void read(page + 1);
  get('page').onchange = () => void read(Number(get('page').value) - 1);
  get('refresh').onclick = () => void read(page);
  get('before').onclick = () => { if(section > 0) { section--; paint(); } };
  get('after').onclick = () => { if(section < pieces.length - 1) { section++; paint(); } };
  panel.addEventListener('close', () => { clear(); button.focus(); });
  const previous = PDFUI.revisionChanged;
  PDFUI.revisionChanged = function(...args) {
    previous?.apply(this, args);
    if(panel.open) { clear(); get('status').textContent = 'Document changed. Reload text from the current revision.'; get('error').textContent = ''; }
  };
})();
