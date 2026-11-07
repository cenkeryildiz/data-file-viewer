import * as vscode from 'vscode';
import { join } from 'node:path';
import { DuckDBEditorProvider } from './duckdbEditorProvider';
import { PdfEditorProvider } from './pdfEditorProvider';
import { QueryWorker } from './queryWorker';
import { MatEditorProvider } from './features/mat/provider';
import { selectBackend } from './backend/nativeSelect';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(DuckDBEditorProvider.register(context, selectBackend(context.extensionPath, {
    ...process.env, DFV_TABLE_STATE_DIR: join(context.globalStorageUri.fsPath, 'table'),
  })));
  context.subscriptions.push(PdfEditorProvider.register(context));
  context.subscriptions.push(MatEditorProvider.register(context));
}

export function deactivate(): void { QueryWorker.releaseSpare(); }
