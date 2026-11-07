import * as vscode from 'vscode';
import * as fs from 'fs';
import { createPdfHost, PdfHost } from './pdfHost';

// Operations that change the document: each success marks the VS Code document dirty.
const CHANGES = new Set(['commit_edit', 'text.replace', 'text.style', 'text.reflow', 'list.remove_marker',
  'annot.note', 'annot.mark', 'annot.update', 'annot.delete', 'page.rotate', 'page.delete', 'page.reorder',
  'undo', 'redo']);

// Replaces the localhost fetch of editorTransport.js: the viewer's own EditorTransport contract,
// carried over vscode postMessage as {type:'req',id,op,params,requestId} -> {type:'res',id,value|error}.
const SHIM = `(()=>{const vs=acquireVsCodeApi();let seq=0;const pending=new Map(),listeners=new Set();
addEventListener('message',({data:m})=>{
 if(m.type==='res'){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Object.assign(new Error(m.error.message),m.error)):p.resolve(m.value);}
 else if(m.type==='event'){for(const f of listeners)f(m.event);}
 else if(m.type==='cmd'){document.getElementById(m.name)?.click();}});
// VS Code offers recoverable sessions itself (notify() asks the host's own list_recoveries); the viewer's duplicate banner goes stale after a restore, so its call sees none.
const channel={request(op,params,options={}){if(op==='list_recoveries')return Promise.resolve({recoveries:[]});return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});vs.postMessage({type:'req',id,op,params,requestId:options.requestId});});},
 subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
// Paragraph editing uses the viewer's PANEL editor (#epara -> text.reflow) because of the engine, not this host: openInPlace() returns
// false unless probe_text's paragraph.box is set, and the native engine (crates/engine/src/reflow.rs) sends no box/align. Once it does, in-place opens by itself.
// Controls the engine cannot honour are blocked and say why. Edit kinds come from get_capabilities, formulas from get_math_capabilities;
// the viewer's own gating (mathOff, search options) still applies on top.
const KINDS={'page.rotate':'#rot-l,#rot-r','page.delete':'#del','text.replace':'#text-toggle','text.style':'#stylegroup','annot.mark':'#markgroup'};
const block=(sel,why)=>document.querySelectorAll(sel).forEach(e=>{e.dataset.unsupported=why;e.title=why;});
addEventListener('click',e=>{const u=e.target.closest&&e.target.closest('[data-unsupported]');if(u){e.preventDefault();e.stopImmediatePropagation();globalThis.toast&&globalThis.toast(u.dataset.unsupported,'err');}},true);
addEventListener('DOMContentLoaded',async()=>{
 try{const c=await channel.request('get_capabilities',{});for(const[k,sel]of Object.entries(KINDS))if(!(c.edit_kinds||[]).includes(k))block(sel,'Not supported by this PDF engine: '+k+'.');}catch{}
 try{const m=await channel.request('get_math_capabilities',{});if(!m.available)block('#formula-toggle',m.reason||'Formula editing is not supported yet.');}catch{block('#formula-toggle','Formula editing is not supported yet.');}});
// Webviews are sandboxed without allow-modals, so the built-in confirm dialog silently answers no. This asks the host for a real modal; any failure means "no".
globalThis.dfvConfirm=(label,message)=>channel.request('ui.confirm',{label,message}).then(v=>v===true,()=>false);
globalThis.PDFStudioHost={createTransport(contract){return PDFStudioNativeTransport.create(channel,contract);}};})();`;

// Every confirm() call site in the viewer bundle, patched in the served script text (the bundle on disk is generated and never edited).
// Each `from` must occur exactly once, otherwise the editor refuses to open: a changed bundle must not silently lose a prompt.
// `!confirm(` becomes `!await dfvConfirm(label, ` so the prompt stays a refusal-by-default question; the host shows the modal.
const CONFIRM_PATCHES: Record<string, [from: string, to: string][]> = {
  'viewer.js': [
    ['!confirm(`Delete ${pages.length}', "!await dfvConfirm('Delete', `Delete ${pages.length}"],
    ['!confirm(`Delete this ${', "!await dfvConfirm('Delete', `Delete this ${"],
    ['$("#notes").addEventListener("click", (ev) => {', '$("#notes").addEventListener("click", async (ev) => {'], // the annotation prompt above now awaits
  ],
  'workspace.js': [
    ["!confirm('Unapplied text and comment drafts", "!await dfvConfirm('Export anyway', 'Unapplied text and comment drafts"],
    ["!confirm('Unapplied comment drafts", "!await dfvConfirm('Export anyway', 'Unapplied comment drafts"],
    ["!confirm('Restore this earlier session", "!await dfvConfirm('Restore session', 'Restore this earlier session"],
  ],
  'viewerDraftRecovery.js': [
    ["!confirm('Discard this recovered", "!await dfvConfirm('Discard', 'Discard this recovered"],
  ],
};
const BARE_CONFIRM = /(?<![\w$.])confirm\s*\(|\b(?:window|globalThis|self)\.confirm\s*\(/;

/** The script text to inline for a bundle script, or undefined when it can be served untouched. Throws if a patch no longer applies. */
export function patchedScript(staticDir: string, file: string): string | undefined {
  let text: string;
  try { text = fs.readFileSync(`${staticDir}/${file}`, 'utf8'); } catch (e: any) { if (e?.code === 'ENOENT') return undefined; throw e; }
  const rules = CONFIRM_PATCHES[file];
  for (const [from, to] of rules ?? []) {
    if (text.split(from).length !== 2) throw new Error(`PDF viewer bundle changed: ${file} no longer has exactly one ${JSON.stringify(from)}; update CONFIRM_PATCHES in pdfEditorProvider.ts.`);
    text = text.replace(from, () => to);
  }
  if (BARE_CONFIRM.test(text)) throw new Error(`PDF viewer bundle changed: ${file} has a confirm() call that is not in CONFIRM_PATCHES; the sandboxed webview would silently answer "no".`);
  if (!rules) return undefined;
  if (/<\/script/i.test(text)) throw new Error(`PDF viewer bundle changed: ${file} contains "</script" and cannot be inlined.`);
  return text;
}

/** Real modal for a viewer prompt. Anything but an explicit click on the action button (cancel, Esc, bad request) is "no". */
export async function confirmModal(params: any): Promise<boolean> {
  const label = typeof params?.label === 'string' && params.label ? params.label.slice(0, 40) : 'OK';
  if (typeof params?.message !== 'string' || !params.message) return false;
  try { return (await vscode.window.showWarningMessage(params.message.slice(0, 1000), { modal: true }, label)) === label; } catch { return false; }
}

// The worker's list order is not a contract; `created` (epoch seconds) is the age. Ties or missing stamps: later in the list wins.
export const newestRecovery = (recoveries: any[]): any =>
  recoveries.reduce((a, b) => (Number(b.created) || 0) >= (Number(a.created) || 0) ? b : a);

class PdfDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri, readonly host: PdfHost, readonly fromBackup = false) {}
  readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
  panel?: vscode.WebviewPanel;
  notifying = false;
  dispose(): void { this.changed.dispose(); this.host.dispose(); }
}

export class PdfEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
  static readonly viewType = 'dataFileViewer.pdf';
  private readonly emitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
  readonly onDidChangeCustomDocument = this.emitter.event;

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, new PdfEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false });
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  private get root(): vscode.Uri { return vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdf'); }
  // Committed VS Code layer (theme, toolbar, comments), separate from the generated media/pdf bundle.
  private get layer(): vscode.Uri { return vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdf-vscode'); }

  // A backupId means VS Code itself reopened this tab from its hot-exit backup and already shows it dirty.
  async openCustomDocument(uri: vscode.Uri, openContext?: vscode.CustomDocumentOpenContext): Promise<PdfDocument> {
    return new PdfDocument(uri, await createPdfHost(this.context, uri), !!openContext?.backupId);
  }

  async resolveCustomEditor(doc: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
    // The user's own hot-exit tab holds unsaved edits VS Code already announced as dirty: bring them back before the page loads
    // (no second prompt). Without a matching record the normal path below warns by name.
    let lost = '';
    if (doc.fromBackup) {
      const record = await this.newestFor(doc);
      if (record) { if (!await this.restore(doc, record)) lost = 'The unsaved edits VS Code kept for this tab could not be restored.'; }
      else lost = 'VS Code reopened this tab with unsaved edits, but the PDF engine has no record of them; they cannot be restored.';
    }
    doc.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.root, this.layer] };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m) => this.onMessage(doc, panel.webview, m));
    void this.notify(doc, lost || undefined); // leftover unsaved edits from an earlier session are offered, never restored silently
  }

  // One non-modal notification per document at a time; the restore button is shown only when the worker lists recoveries for this PDF.
  async notify(doc: PdfDocument, problem?: string): Promise<void> {
    if (doc.notifying) return;
    doc.notifying = true;
    try {
      const recoveries = await this.recoveries(doc);
      if (!problem && !recoveries.length) return;
      const name = doc.uri.path.replace(/^.*\//, '');
      const text = [problem, recoveries.length ? `${recoveries.length} unsaved edit session(s) for ${name} can be restored.` : '']
        .filter(Boolean).join(' ');
      const restore = 'Restore unsaved edits';
      const pick = await vscode.window.showWarningMessage(text, ...(recoveries.length ? [restore] : []));
      if (pick === restore) await this.restore(doc, newestRecovery(recoveries));
    } finally { doc.notifying = false; }
  }

  // The first call after a crash only restarts the worker (WORKER_RESTARTED), so ask twice; a worker that stays down lists nothing.
  private async recoveries(doc: PdfDocument): Promise<any[]> {
    for (let i = 0; i < 2; i++) {
      try { return ((await doc.host.request('list_recoveries', {})) as any).recoveries ?? []; } catch { /* worker down */ }
    }
    return [];
  }

  private async newestFor(doc: PdfDocument): Promise<any | undefined> {
    const all = await this.recoveries(doc);
    return all.length ? newestRecovery(all) : undefined;
  }

  private async restore(doc: PdfDocument, record: any): Promise<boolean> {
    try {
      const state = await doc.host.request('get_state', {}) as any;
      await doc.host.request('restore_recovery', { backup_id: record.backup_id, revision: state.revision });
      this.markEdited(doc);
      if (doc.panel) doc.panel.webview.html = this.html(doc.panel.webview);
      return true;
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not restore the unsaved edits: ${String(e?.message ?? e)}`);
      return false;
    }
  }

  private async onMessage(doc: PdfDocument, webview: vscode.Webview, m: any): Promise<void> {
    if (!m || m.type !== 'req' || !Number.isSafeInteger(m.id) || typeof m.op !== 'string') return;
    if (m.op === 'ui.confirm') { void webview.postMessage({ type: 'res', id: m.id, value: await confirmModal(m.params) }); return; }
    let reply: unknown;
    try {
      let params = m.params ?? {};
      if (m.op === 'export_verified') params = { ...params, path: await this.pickExport(doc.uri, params.path) };
      const value = await doc.host.request(m.op, params);
      if (CHANGES.has(m.op)) this.markEdited(doc);
      reply = { type: 'res', id: m.id, value };
    } catch (e: any) {
      if (/^WORKER_(RESTARTED|EXITED|UNAVAILABLE)$/.test(e?.code)) void this.notify(doc, `PDF worker problem (${e.code}): ${String(e.message)}`);
      reply = { type: 'res', id: m.id, error: { message: String(e?.message ?? e), refused: e?.refused, status: e?.status, code: e?.code, body: e?.body, requestId: e?.requestId ?? m.requestId } };
    }
    void webview.postMessage(reply);
  }

  // Original is never overwritten: export always asks for a destination (default: edited_<name> beside it).
  private async pickExport(source: vscode.Uri, given?: string): Promise<string> {
    if (given) return given;
    const base = source.path.replace(/^.*\//, '');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(source, '..', `edited_${base}`), filters: { PDF: ['pdf'] } });
    if (!target) throw Object.assign(new Error('Export cancelled.'), { refused: true, status: 409, code: 'CANCELLED' });
    return target.fsPath;
  }

  private markEdited(doc: PdfDocument): void {
    const post = (name: string) => void doc.panel?.webview.postMessage({ type: 'cmd', name });
    this.emitter.fire({ document: doc, label: 'PDF edit', undo: () => post('undo'), redo: () => post('redo') });
  }

  async saveCustomDocument(doc: PdfDocument): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(doc.uri, '..', `edited_${doc.uri.path.replace(/^.*\//, '')}`), filters: { PDF: ['pdf'] } });
    if (!target) throw new vscode.CancellationError();
    await doc.host.exportTo(target);
  }

  async saveCustomDocumentAs(doc: PdfDocument, destination: vscode.Uri): Promise<void> { await doc.host.exportTo(destination); }

  async revertCustomDocument(doc: PdfDocument): Promise<void> {
    await doc.host.request('revert_to_saved', {});
    if (doc.panel) doc.panel.webview.html = this.html(doc.panel.webview);
  }

  // The worker keeps an "edit" recovery record in extension storage (rewritten after every publication, kept on kill or quit); the
  // restart offer in notify() reads it. It is not listed while its own worker lives, so the engine's `recovery` flag is the proof
  // VS Code needs: a dirty document whose record is not "ok" is a failed backup, never a silent one.
  // delete() stays a no-op: VS Code also deletes superseded backups, and the record must live until restored, exported or reverted.
  async backupCustomDocument(doc: PdfDocument, ctx: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    const state = await doc.host.request('get_state', {}) as any;
    if (state.dirty && state.recovery !== 'ok') throw new Error(`The PDF engine could not record the unsaved edits for recovery (${state.recovery ?? 'unknown'}); export a copy now.`);
    return { id: ctx.destination.toString(), delete: () => {} };
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.root, ...p)).toString();
    const csp = `default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource} blob:; connect-src 'none'; object-src 'none'; base-uri 'none'`;
    // Every *.css / *.js in media/pdf-vscode, by name; scripts run after the viewer's own.
    const layerFiles = (ext: string) => { try { return fs.readdirSync(this.layer.fsPath).filter((f) => f.endsWith(ext)).sort(); } catch { return []; } };
    const layerUri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.layer, f)).toString();
    const links = layerFiles('.css').map((f) => `<link rel="stylesheet" href="${layerUri(f)}">`).join('\n');
    const scripts = layerFiles('.js').map((f) => `<script nonce="${nonce}" src="${layerUri(f)}"></script>`).join('\n');
    const staticDir = vscode.Uri.joinPath(this.root, 'web', 'static').fsPath;
    const inline = new Map<string, string>();
    // Patched scripts become placeholders first so the /static/ rewrite below never touches their text.
    const page = fs.readFileSync(`${staticDir}/index.html`, 'utf8').replace(/<script src="\/static\/([^"]+\.js)"><\/script>/g, (tag, f) => {
      const text = patchedScript(staticDir, f);
      if (text === undefined) return tag;
      inline.set(f, text);
      return `<!--dfv-inline:${f}-->`;
    });
    return page
      .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
      .replace('<script src="/static/editorTransport.js">',
        `<script nonce="${nonce}">${SHIM}</script>\n<script src="${uri('ui', 'nativeTransport.js')}"></script>\n<script src="/static/editorTransport.js">`)
      .replace(/(href|src)="\/static\/([^"]+)"/g, (_s, a, f) => `${a}="${uri('web', 'static', f)}"`)
      .replace('</head>', () => `${links}\n</head>`)
      .replace('</body>', () => `${scripts}\n</body>`)
      .replace(/<!--dfv-inline:([^>]+)-->/g, (_t, f) => `<script nonce="${nonce}">${inline.get(f)}</script>`);
  }
}
