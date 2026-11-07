import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { MatClient, matWorkerPath } from './client';
import { uint64 } from './protocol';

export class MatDocument implements vscode.CustomDocument {
  private control?: AbortController;
  private closed = false;
  constructor(readonly uri: vscode.Uri, public client: MatClient) {}
  async request(command: unknown, args: unknown): Promise<unknown> {
    if (this.closed) throw new Error('This MAT document is closed.');
    if (command === 'cancel') { this.control?.abort(); return { cancelled: true }; }
    if (this.control) throw new Error('A MAT read is still running. Cancel it or wait for it to finish.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid MAT request.');
    const a = args as Record<string, unknown>;
    const keys: Record<string, string[]> = { refresh: [], catalog: ['offset'], describe: ['handle'], children: ['handle', 'offset'], slice: ['handle', 'start', 'count'], sparse: ['handle', 'start', 'count', 'offset'], release: ['handles'] };
    if (typeof command !== 'string' || !Object.hasOwn(keys, command) || Object.keys(a).length !== keys[command].length || !keys[command].every(k => Object.hasOwn(a, k))) throw new Error('Unsupported MAT request.');
    if ('offset' in a && !uint64(a.offset) || 'handle' in a && (typeof a.handle !== 'string' || a.handle.length > 256)) throw new Error('Invalid MAT page or value.');
    for (const key of ['start', 'count']) if (key in a && (!Array.isArray(a[key]) || (a[key] as unknown[]).length < 2 || (a[key] as unknown[]).length > 32 || !(a[key] as unknown[]).every(uint64))) throw new Error('Use one-based decimal coordinates.');
    if ('handles' in a && (!Array.isArray(a.handles) || a.handles.length > 1000 || !a.handles.every(h => typeof h === 'string' && h.length <= 256))) throw new Error('Invalid MAT value list.');
    const control = new AbortController(); this.control = control;
    try {
      switch (command) {
        case 'refresh': {
          const client = await this.client.reopen();
          if (this.closed) { await client.close(); throw new Error('This MAT document is closed.'); }
          this.client = client; return { refreshed: true };
        }
        case 'catalog': return await this.client.catalog(a.offset as string, control.signal);
        case 'describe': return await this.client.describe(a.handle as string, control.signal);
        case 'children': return await this.client.children(a.handle as string, a.offset as string, control.signal);
        case 'slice': return await this.client.slice(a.handle as string, a.start as string[], a.count as string[], control.signal);
        case 'sparse': return await this.client.sparse(a.handle as string, a.start as string[], a.count as string[], a.offset as string, control.signal);
        case 'release': await this.client.release(a.handles as string[]); return { released: true };
      }
    } finally { this.control = undefined; }
  }
  async close() { if (this.closed) return; this.closed = true; this.control?.abort(); await this.client.close(); }
  dispose() { void this.close().catch(() => {}); }
}

export class MatEditorProvider implements vscode.CustomReadonlyEditorProvider<MatDocument> {
  static readonly viewType = 'dataFileViewer.mat';
  constructor(private readonly context: vscode.ExtensionContext) {}
  static register(context: vscode.ExtensionContext) {
    return vscode.window.registerCustomEditorProvider(this.viewType, new MatEditorProvider(context), { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } });
  }
  async openCustomDocument(uri: vscode.Uri, _context: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<MatDocument> {
    if (!vscode.workspace.isTrusted || uri.scheme !== 'file') throw new Error('MAT viewing requires a trusted local file.');
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const control = new AbortController();
    const cancellation = token.onCancellationRequested(() => control.abort());
    try {
      const client = await MatClient.open({ executable: matWorkerPath(this.context.extensionPath) }, uri.fsPath, control.signal);
      if (token.isCancellationRequested) { await client.close(); throw new vscode.CancellationError(); }
      return new MatDocument(uri, client);
    } finally { cancellation.dispose(); }
  }
  async resolveCustomEditor(document: MatDocument, panel: vscode.WebviewPanel): Promise<void> {
    const nonce = randomBytes(18).toString('hex');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'matView.js'));
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';"><title>MAT Viewer</title><style nonce="${nonce}">
body{font:var(--vscode-font-size,13px) var(--vscode-font-family,sans-serif);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);margin:16px}button,input,select{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,#888);padding:5px;margin:3px}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}input{width:8em}table{border-collapse:collapse;margin:8px 0}td,th{padding:5px 10px;border:1px solid var(--vscode-panel-border,#888);text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}#status{white-space:pre-wrap}#error{color:var(--vscode-errorForeground,#c33);white-space:pre-wrap}nav{display:flex;gap:8px;flex-wrap:wrap}fieldset{margin:8px 0}a:focus,button:focus,input:focus,select:focus{outline:2px solid var(--vscode-focusBorder,#08f)}.value{font-family:var(--vscode-editor-font-family,monospace)}
</style></head><body><h1>MAT Viewer <small>Read-only</small></h1><p>One-based MATLAB coordinates. Values remain exact; the source is never changed.</p><button id="refresh" type="button">Refresh source</button><button id="cancel" type="button">Cancel read</button><p id="status" role="status" aria-live="polite"></p><p id="error" role="alert"></p><nav id="breadcrumb" aria-label="Value navigation"></nav><section id="catalog" aria-label="Variables"></section><section id="value" aria-label="Selected value"></section><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const listener = panel.webview.onDidReceiveMessage(async message => {
      if (!message || !Number.isSafeInteger(message.id) || message.id < 1) return;
      try {
        const result = await document.request(message.command, message.args);
        await panel.webview.postMessage({ id: message.id, ok: true, result });
      } catch (e) {
        await panel.webview.postMessage({ id: message.id, ok: false, error: { code: typeof (e as any)?.code === 'string' ? (e as any).code : 'read_failed', message: e instanceof Error ? e.message : 'The MAT read failed.' } });
      }
    });
    panel.onDidDispose(() => listener.dispose());
  }
}
