import { coordinates, firstRegion, scalarText, uint64, type MatInfo, type MatItem, type MatPage, type MatSlice, type MatSparse } from './protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
let sequence = 0, busy = false;
function request<T = any>(command: string, args: unknown): Promise<T> {
  return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); vscode.postMessage({ id, command, args }); });
}
window.addEventListener('message', ({ data }) => {
  const p = pending.get(data?.id); if (!p) return;
  pending.delete(data.id);
  if (data.ok === true) p.resolve(data.result); else p.reject(new Error(`${data.error?.code ?? 'read_failed'}: ${data.error?.message ?? 'The MAT read failed.'}`));
});
const byId = (id: string) => document.getElementById(id)!;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element;
}
function button(label: string, action: () => Promise<void>, disabled = false) {
  const b = node('button', label); b.type = 'button'; b.disabled = busy || disabled; b.dataset.unavailable = String(disabled); b.onclick = () => void run(action); return b;
}
function updateBusy() {
  for (const element of Array.from(document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('button,input,select'))) {
    element.disabled = element.id === 'cancel' ? !busy : busy || element.dataset.unavailable === 'true';
  }
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true; byId('error').textContent = ''; byId('status').textContent = 'Reading…'; updateBusy();
  try { await action(); byId('status').textContent = 'Read-only. No source changes.'; }
  catch (e) { byId('error').textContent = e instanceof Error ? e.message : 'The MAT read failed.'; byId('status').textContent = 'Read stopped. Reopen the document if the worker stopped or the source changed.'; }
  finally { busy = false; updateBusy(); }
}
byId('cancel').onclick = () => { void request('cancel', {}).catch(e => { byId('error').textContent = String(e); }); };
let catalog: MatPage | undefined, children: MatPage | undefined;
let ancestors: MatItem[] = [];
let region: { start: string[]; count: string[] } = { start: [], count: [] };
const allocated = new Set<string>();
function track(page: MatPage) { for (const i of page.items) allocated.add(i.handle); return page; }
async function releaseUnused() {
  const keep = new Set([...(catalog?.items ?? []), ...(children?.items ?? []), ...ancestors].map(i => i.handle));
  const release = [...allocated].filter(h => !keep.has(h));
  if (release.length) { await request('release', { handles: release }); for (const h of release) allocated.delete(h); }
}
function pager(section: HTMLElement, offset: string, total: string, action: (offset: string) => Promise<void>, size = 100n) {
  const n = BigInt(offset), count = BigInt(total);
  section.append(node('p', count === 0n ? 'No entries.' : `Entries ${n + 1n}–${n + size < count ? n + size : count} of ${count}`),
    button('Previous page', () => action((n > size ? n - size : 0n).toString()), n === 0n),
    button('Next page', () => action((n + size).toString()), n + size >= count));
}
async function loadCatalog(offset = '0') {
  const next = track(await request<MatPage>('catalog', { offset }));
  catalog = next; children = undefined; ancestors = []; byId('value').replaceChildren(); renderBreadcrumbs(); renderCatalog(); await releaseUnused();
}
function renderCatalog() {
  const section = byId('catalog'); section.replaceChildren(node('h2', 'Variables'));
  for (const item of catalog!.items) section.append(button(`${item.info.name} — ${item.info.className} [${item.info.dims.length ? item.info.dims.join(' × ') : 'not recorded'}]${item.info.support.supported ? '' : ' (metadata only)'}`, async () => {
    ancestors = [item]; children = undefined; await releaseUnused(); await loadValue();
  }));
  pager(section, catalog!.offset, catalog!.total, loadCatalog);
}
function renderBreadcrumbs() {
  const nav = byId('breadcrumb'); nav.replaceChildren();
  nav.append(button('Variables', async () => { ancestors = []; children = undefined; byId('value').replaceChildren(); renderBreadcrumbs(); await releaseUnused(); }));
  ancestors.forEach((item, index) => nav.append(button(item.label ?? item.info.name, async () => {
    ancestors = ancestors.slice(0, index + 1); children = undefined; await releaseUnused(); await loadValue();
  })));
}
function table(headers: string[], rows: string[][]) {
  const t = node('table'), head = node('thead'), tr = node('tr');
  for (const h of headers) { const cell = node('th', h); cell.scope = 'col'; tr.append(cell); }
  head.append(tr); t.append(head); const body = node('tbody');
  for (const row of rows) { const r = node('tr'); for (const value of row) { const c = node('td', value); c.className = 'value'; r.append(c); } body.append(r); }
  t.append(body); return t;
}
async function loadValue() {
  const item = ancestors.at(-1)!;
  item.info = await request<MatInfo>('describe', { handle: item.handle });
  const info = item.info, section = byId('value');
  renderBreadcrumbs();
  section.replaceChildren(node('h2', item.label ?? info.name), node('p', `${info.className}; dimensions [${info.dims.length ? info.dims.join(' × ') : 'not recorded'}]${info.complex ? '; complex' : ''}${info.global ? '; global' : ''}`));
  if (!info.support.supported) { section.append(node('p', `Metadata only (${info.support.code ?? 'unsupported'}): ${info.support.reason}`)); return; }
  if (info.class === 'cell' || info.class === 'struct') {
    section.append(node('p', `${info.children ?? '?'} children${info.fields.length ? '; fields: ' + info.fields.join(', ') : ''}. Select a child to inspect it.`));
    const listing = node('section'); listing.id = 'children'; section.append(listing); await loadChildren('0'); return;
  }
  region = firstRegion(info.dims, info.sparse);
  const controls = node('fieldset'), legend = node('legend', 'One-based slice'); controls.append(legend);
  const inputs: { start: HTMLInputElement; count: HTMLInputElement }[] = [];
  info.dims.forEach((size, index) => {
    const row = node('div');
    const start = node('input'), count = node('input'); start.type = count.type = 'text'; start.inputMode = count.inputMode = 'numeric';
    start.value = region.start[index]; count.value = region.count[index];
    start.setAttribute('aria-label', `Dimension ${index + 1} start`); count.setAttribute('aria-label', `Dimension ${index + 1} count`);
    row.append(node('span', `Dimension ${index + 1} (size ${size}): `));
    const startLabel = node('label', 'Start '); startLabel.append(start); const countLabel = node('label', 'Count '); countLabel.append(count);
    row.append(startLabel, countLabel); controls.append(row); inputs.push({ start, count });
  });
  const setInputs = () => inputs.forEach((i, d) => { i.start.value = region.start[d]; i.count.value = region.count[d]; });
  const readInputs = () => {
    const start = inputs.map(i => i.start.value.trim()), count = inputs.map(i => i.count.value.trim());
    if (![...start, ...count].every(uint64)) throw new Error('Coordinates must be canonical decimal integers.');
    let cells = 1n;
    for (let d = 0; d < info.dims.length; d++) {
      const size = BigInt(info.dims[d]), s = BigInt(start[d]), c = BigInt(count[d]);
      if (s < 1n || (size === 0n ? s !== 1n || c !== 0n : c < 1n || s > size || c > size - s + 1n)) throw new Error(`Dimension ${d + 1} is outside its one-based bounds.`);
      cells *= c;
    }
    if (!info.sparse && cells > 10000n) throw new Error('A dense preview is limited to 10,000 cells. Reduce the slice counts.');
    region = { start, count };
  };
  controls.append(button('Read slice', async () => { readInputs(); await readRegion('0'); }));
  const dimension = node('select'); dimension.setAttribute('aria-label', 'Page dimension');
  info.dims.forEach((_, d) => { const o = node('option', `Dimension ${d + 1}`); o.value = String(d); dimension.append(o); });
  controls.append(node('label', 'Page along '), dimension);
  const shift = async (forward: boolean) => {
    readInputs(); const d = Number(dimension.value), s = BigInt(region.start[d]), c = BigInt(region.count[d]), size = BigInt(info.dims[d]);
    if (size === 0n) return;
    const max = size - c + 1n, next = forward ? s + c : s - c;
    region.start[d] = (next < 1n ? 1n : next > max ? max : next).toString(); setInputs(); await readRegion('0');
  };
  controls.append(button('Previous slice', () => shift(false)), button('Next slice', () => shift(true)));
  section.append(controls, node('section')); section.lastElementChild!.id = 'data';
  await readRegion('0');
}
async function loadChildren(offset: string) {
  const page = track(await request<MatPage>('children', { handle: ancestors.at(-1)!.handle, offset })); children = page;
  const section = byId('children'); section.replaceChildren();
  for (const item of page.items) section.append(button(`${item.label} — ${item.info.className} [${item.info.dims.length ? item.info.dims.join(' × ') : 'not recorded'}]`, async () => {
    ancestors.push(item); children = undefined; await releaseUnused(); await loadValue();
  }));
  pager(section, page.offset, page.total, loadChildren); await releaseUnused();
}
async function readRegion(offset: string) {
  const item = ancestors.at(-1)!, data = byId('data');
  if (region.count.some(c => c === '0')) { data.replaceChildren(node('p', `Empty ${item.info.sparse ? 'sparse ' : ''}slice; start [${region.start.join(', ')}], count [${region.count.join(', ')}]. No stored values.`)); return; }
  if (item.info.sparse) {
    const r = await request<MatSparse>('sparse', { handle: item.handle, ...region, offset });
    data.replaceChildren(node('p', `Sparse [${r.shape.join(' × ')}]; ${r.nnz} stored entries in source. Unlisted coordinates are implicit zero. Coordinate page only; no dense expansion.`),
      table(['Row', 'Column', 'Real', 'Imaginary'], r.entries.map(e => [e.row, e.col, scalarText(e.re), e.im == null ? '' : scalarText(e.im)])));
    const n = BigInt(offset);
    data.append(button('Previous sparse page', () => readRegion((n >= 100n ? n - 100n : 0n).toString()), n === 0n), button('Next sparse page', () => readRegion((n + BigInt(r.entries.length)).toString()), !r.has_more));
    return;
  }
  const r = await request<MatSlice>('slice', { handle: item.handle, ...region });
  data.replaceChildren(node('p', `Slice start [${r.start.join(', ')}], count [${r.count.join(', ')}]; MATLAB column-major order.`));
  if (r.data.kind === 'char') {
    data.append(table(['Text row', 'Text (whitespace preserved)'], r.data.rows!.map((text, i) => [(BigInt(r.start[0]) + BigInt(i)).toString(), text])));
    if (r.data.lossy) data.append(node('p', 'Text contains invalid UTF-16 replaced with U+FFFD; display is lossy.'));
  } else if (r.count.length === 2) {
    const rows = Number(r.count[0]), cols = Number(r.count[1]);
    const values = Array.from({ length: rows }, (_, row) => [
      (BigInt(r.start[0]) + BigInt(row)).toString(),
      ...Array.from({ length: cols }, (_, col) => {
        const index = row + col * rows, real = scalarText(r.data.re![index]);
        return r.data.im ? `${real}; ${scalarText(r.data.im[index])}i` : real;
      }),
    ]);
    if (r.data.im) data.append(node('p', 'Complex cells show Real; Imaginary i.'));
    data.append(table(['Row / Column', ...Array.from({ length: cols }, (_, col) => (BigInt(r.start[1]) + BigInt(col)).toString())], values));
  } else {
    data.append(table(['Coordinates', 'Real', ...(r.data.im ? ['Imaginary'] : [])], r.data.re!.map((v, i) => [`(${coordinates(i, r.start, r.count).join(', ')})`, scalarText(v), ...(r.data.im ? [scalarText(r.data.im[i])] : [])])));
  }
}
byId('refresh').onclick = () => void run(async () => {
  await request('refresh', {}); allocated.clear(); catalog = undefined; children = undefined; ancestors = [];
  byId('value').replaceChildren(); await loadCatalog();
});
void run(() => loadCatalog());
