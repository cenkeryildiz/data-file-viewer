import vscodeStub, { recorded, resetVscodeStub, settings } from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import ts from 'typescript';
import { DuckDbFile } from '../src/duckdbConnection';
import { DuckDBDocument, DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { referenceBackend, rawReferenceBackend, referenceBackendFor } from '../src/backend/reference';
import type { BackendFactory, DocumentFile } from '../src/backend/types';
import { READ_METHODS } from '../src/queryProtocol';
import { ViewerFile } from '../src/viewerFile';

// Compilation checks every old public member/signature in both directions.
// The optional notice sink is the only deliberate addition to the raw shape.
type Assert<T extends true> = T;
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type PreservedMembers = Assert<Same<keyof Omit<DocumentFile, 'onSaveNotice'>, keyof DuckDbFile>>;
type PublicReference = Pick<DuckDbFile, keyof DuckDbFile>;
type PreservedToReference = Assert<DocumentFile extends PublicReference ? true : false>;
type PreservedFromReference = Assert<PublicReference extends DocumentFile ? true : false>;
type ReadSurface = Assert<Exclude<typeof READ_METHODS[number], keyof DocumentFile> extends never ? true : false>;

async function host(document: DuckDBDocument) {
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any);
  const posted: Record<string, unknown>[] = [];
  let handler!: (message: unknown) => Promise<void>;
  const webview = {
    cspSource: 'vscode-resource:', html: '', options: {}, asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: (callback: typeof handler) => { handler = callback; return { dispose() {} }; },
    postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; },
  };
  await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) } as any);
  let requestId = 0;
  return { posted, send: (message: Record<string, unknown>) => handler({ ...message, requestId: ++requestId }) };
}

function fakeFile(extra: Partial<DocumentFile> = {}): DocumentFile {
  return { interruptCurrentQuery() {}, dispose() {}, isReadOnly: () => false, ...extra } as DocumentFile;
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('reference contract and adapter dependency graphs exclude host/PDF imports', async () => {
  const sourceRoot = resolve('src');
  async function graph(entry: string): Promise<Set<string>> {
    const seen = new Set<string>();
    async function visit(file: string): Promise<void> {
      if (seen.has(file)) return;
      seen.add(file);
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const dependencies: string[] = [];
      function walk(node: ts.Node): void {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) dependencies.push(node.arguments[0].text);
        ts.forEachChild(node, walk);
      }
      walk(source);
      for (const specifier of dependencies) {
        assert.ok(!/(^vscode(?:\/|$)|pdf)/i.test(specifier), `${file} imports ${specifier}`);
        if (specifier.startsWith('.')) await visit(resolve(dirname(file), `${specifier}.ts`));
      }
    }
    await visit(join(sourceRoot, entry));
    return seen;
  }
  const contract = await graph('backend/types.ts');
  assert.ok(![...contract].some(file => /(?:duckdbConnection|viewerFile)\.ts$/.test(file)), 'contract must not derive its types from a reference implementation');
  const adapter = await graph('backend/reference.ts');
  assert.ok(adapter.has(join(sourceRoot, 'viewerFile.ts')) && adapter.has(join(sourceRoot, 'duckdbConnection.ts')));
  const session = await graph('backend/session.ts');
  assert.ok(![...session].some(file => /(?:duckdbConnection|viewerFile)\.ts$/.test(file)), 'session must not import a reference implementation');
});

test('provider opens and reopens through captured production adapter with fresh settings', async () => {
  resetVscodeStub();
  const dir = await mkdtemp(join(tmpdir(), 'dfv-adapter-host-'));
  const path = join(dir, 'data.csv');
  await writeFile(path, 'id,value\n1,10\n2,20\n');
  const original = await readFile(path);
  const originalOpen = referenceBackend.open;
  const calls: Parameters<BackendFactory['open']>[] = [];
  referenceBackend.open = (...args) => { calls.push(args); return originalOpen(...args); };
  let document: DuckDBDocument | undefined;
  const closed = latch();
  try {
    const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any);
    document = await provider.openCustomDocument(vscodeStub.Uri.file(path) as any);
    assert.equal(calls.length, 1);
    assert.equal(document.backend, referenceBackend);
    assert.ok(document.file instanceof ViewerFile, 'production still uses the restricted worker/trusted writer wrapper');
    for (const method of READ_METHODS) assert.equal(typeof document.file[method], 'function', method);
    const client = await host(document);
    await client.send({ command: 'runQuery', sql: 'select * from data order by id' });
    assert.equal(client.posted.filter(m => m.command === 'queryResult').length, 1);
    const before = document.file;
    settings.set('dataFileViewer.numberLocale', 'eu');
    settings.set('dataFileViewer.sheetTables', 'off');
    await client.send({ command: 'toggleLiveRefresh', enabled: false });
    assert.equal(calls.length, 2, 'reconnect traverses the captured adapter exactly once');
    assert.equal(calls[1][0], path);
    assert.equal(calls[1][2]?.numberLocale, 'eu');
    assert.equal(calls[1][2]?.sheetTables, 'off');
    assert.equal(calls[1][2]?.forceReadOnly, false);
    assert.notEqual(document.file, before);
    assert.equal(document.queryCatalogGeneration, 1);
    assert.deepEqual((await document.file.runQuery('select * from data order by id')).rows.map(r => r.map(Number)), [[1, 10], [2, 20]]);
    const dispose = document.file.dispose.bind(document.file);
    document.file.dispose = () => { dispose(); closed.release(); };
    document.dispose();
    await closed.promise;
    assert.deepEqual(await readFile(path), original);
  } finally {
    referenceBackend.open = originalOpen;
    document?.dispose();
    settings.clear();
    await rm(dir, { recursive: true, force: true });
  }
});

test('raw reference injection captures its own reopen strategy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-adapter-raw-'));
  let document: DuckDBDocument | undefined;
  try {
    const path = join(dir, 'raw.csv');
    await writeFile(path, 'id,value\n1,10\n');
    const raw = await rawReferenceBackend.open(path);
    assert.ok(raw instanceof DuckDbFile);
    assert.equal(referenceBackendFor(raw), rawReferenceBackend);
    document = new DuckDBDocument(vscodeStub.Uri.file(path) as any, raw);
    const client = await host(document);
    await client.send({ command: 'toggleLiveRefresh', enabled: false });
    assert.ok(document.file instanceof DuckDbFile, 'raw oracle fixture remains raw on reconnect');
    assert.notEqual(document.file, raw);
    assert.deepEqual((await document.file.runQuery('select * from raw')).rows.map(r => r.map(Number)), [[1, 10]]);
  } finally { document?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('failed reopen retains old file and never retries; late successful reopen closes its new handle', async () => {
  const old = fakeFile();
  let disposed = 0, attempts = 0;
  const entered = latch(), proceed = latch();
  const replacement = fakeFile({ dispose: () => { disposed++; } });
  const factory: BackendFactory = { open: async () => { attempts++; if (attempts === 1) throw new Error('typed reconnect failure'); entered.release(); await proceed.promise; return replacement; } };
  const document = new DuckDBDocument(vscodeStub.Uri.file('/synthetic.csv') as any, old, undefined, undefined, factory);
  const client = await host(document);
  await client.send({ command: 'toggleLiveRefresh', enabled: false });
  assert.equal(attempts, 1);
  assert.equal(document.file, old);
  assert.equal(client.posted.at(-1)?.readOnly, true);
  const reconnect = client.send({ command: 'toggleLiveRefresh', enabled: false });
  await entered.promise;
  document.dispose();
  proceed.release();
  await reconnect;
  assert.equal(attempts, 2);
  assert.equal(document.file, old);
  assert.equal(disposed, 1, 'new handle is closed if open completes after document closure');
});

test('save outcome sink survives document closure and backend replacements without implementation checks', () => {
  resetVscodeStub();
  const first = fakeFile({ onSaveNotice: undefined });
  const document = new DuckDBDocument(vscodeStub.Uri.file('/notice.csv') as any, first);
  const second = fakeFile({ onSaveNotice: undefined });
  document.file = second;
  document.dispose();
  first.onSaveNotice?.('first save reconciled after closure');
  second.onSaveNotice?.('second save needs directory sync');
  assert.deepEqual(recorded.messages.map(m => [m.level, m.text]), [
    ['warning', 'notice.csv: first save reconciled after closure'],
    ['warning', 'notice.csv: second save needs directory sync'],
  ]);
});


test('unknown injected files preserve raw-reference fallback and unsupported notice sinks are untouched', () => {
  const custom = Object.freeze(fakeFile());
  const document = new DuckDBDocument(vscodeStub.Uri.file('/synthetic.csv') as any, custom);
  assert.equal(document.backend, rawReferenceBackend, 'legacy non-ViewerFile fallback remains raw');
  assert.equal('onSaveNotice' in custom, false, 'optional notice support must not add properties to raw/custom objects');
  document.dispose();
});
