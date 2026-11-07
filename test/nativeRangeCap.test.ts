import vscodeStub, { resetVscodeStub } from './stress/stubs/vscode';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { nativeBackend } from '../src/backend/nativeDocument';
import { RANGE_READ_CELLS } from '../src/queryRange';
import { xlsxFile } from './stress/generators/_write';

const worker = process.env.DFV_TABLE_WORKER ?? join(process.cwd(), 'native/target-duck/debug/dfv-table');
const COLUMNS = 1200;

// Wide raw-worksheet range read with maxResultRows=0 (uncapped rows): the provider must refuse by total
// cells with a typed message, before any read, and must still serve a range that is within the cap.
test('real native provider refuses a wide raw-worksheet range read beyond the cell cap and serves one within it', { timeout: 60000 }, async () => {
  assert.ok(existsSync(worker), `native worker missing: ${worker}`);
  resetVscodeStub();
  assert.equal(vscodeStub.workspace.getConfiguration('dataFileViewer').get('maxResultRows', 0), 0);
  const dir = await mkdtemp(join(tmpdir(), 'dfv-native-range-cap-'));
  const rows = Array.from({ length: 4 }, (_, r) => Array.from({ length: COLUMNS }, (_, c) => `r${r + 1}c${c + 1}`));
  const source = await xlsxFile(join(dir, 'wide.xlsx'), [{ name: 'Wide', rows }]);
  const original = await readFile(source);
  const backend = nativeBackend({ executable: worker, env: { ...process.env, DFV_TABLE_STATE_DIR: join(dir, 'state') } });
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any, backend);
  const document = await provider.openCustomDocument(vscodeStub.Uri.file(source) as any);
  const messages: Record<string, any>[] = [];
  let receive!: (message: unknown) => Promise<void>;
  const webview = { cspSource: 'vscode-resource:', html: '', options: {}, asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage(fn: typeof receive) { receive = fn; return { dispose() {} }; },
    async postMessage(message: Record<string, any>) { messages.push(message); return true; } };
  let requestId = 0;
  const send = (message: Record<string, unknown>) => receive({ ...message, requestId: ++requestId });
  const last = (command: string) => messages.filter(message => message.command === command).at(-1)!;
  try {
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) } as any);
    await send({ command: 'runQuery', sql: 'SELECT * FROM "Wide" LIMIT 100;', sheetPreview: 'Wide', selectionSeq: 1 });
    const result = last('queryResult');
    assert.equal(result.columns.length, COLUMNS);
    assert.equal(result.rows.length, 4);
    const token = result.rangeContext.token;
    const reads = () => messages.filter(message => message.command === 'queryResult').length;
    const beforeReads = reads();

    // 2000 rows x 1200 columns = 2.4M cells > 2M: typed refusal naming the limit and a row that fits; nothing truncated or painted.
    await send({ command: 'queryRange', token, range: 'A1:B2000' });
    let reply = last('queryRangeResult');
    assert.equal(reply.rows, undefined);
    assert.match(reply.error, /would load 2400000 cells; the cell limit is 2000000\. Choose a range that ends at row 1666 or earlier\./);
    assert.equal(RANGE_READ_CELLS, 2_000_000);
    assert.equal(reads(), beforeReads);

    // The refusal does not invalidate the captured result: a range inside the captured rows still pages exactly.
    await send({ command: 'queryRange', token, range: 'B2:D3' });
    reply = last('queryRangeResult');
    assert.equal(reply.error, undefined);
    assert.deepEqual(reply.rows, [['r2c2', 'r2c3', 'r2c4'], ['r3c2', 'r3c3', 'r3c4']]);

    // 1600 rows x 1200 columns = 1.92M cells is within the cap: the bounded read happens and the row count is then refused
    // against the real sheet height, not by the cell cap.
    await send({ command: 'queryRange', token, range: 'A1:B1600' });
    reply = last('queryRangeResult');
    assert.doesNotMatch(reply.error, /cell limit/);
    assert.match(reply.error, /exceeds this captured result/);

    assert.deepEqual(await readFile(source), original, 'the source workbook changed');
  } finally {
    const file = document.file;
    document.dispose();
    await (file as any).close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
