// D1.8 drift gate: test/migration/table-operations.json must equal what the
// generator derives from source, and its operation set must equal the source's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { READ_METHODS } from '../src/queryProtocol';
import {
  DEFAULT_REUSE_PATH, OUTPUT_PATH, comparable, diffOperationIds, generate, readReuse, type Inventory,
} from './migration/tableOperations';

const root = process.cwd();
const committed = JSON.parse(readFileSync(join(root, OUTPUT_PATH), 'utf8')) as Inventory;
const generated = generate(root);
const ids = (inv: Inventory) => inv.operations.map(op => op.id);
const REGENERATE = 'Regenerate: npx tsc -p tsconfig.test.json && node out-test/test/migration/tableOperations.js --write';

test('D1.8: committed operation set equals the source-derived set', () => {
  const diff = diffOperationIds(ids(generated), ids(committed));
  assert.deepEqual(diff, { missing: [], extra: [] }, `table-operations.json drifted from source. ${REGENERATE}`);
  assert.equal(new Set(ids(committed)).size, committed.operations.length, 'duplicate operation ids');
});

test('D1.8: read operations equal the runtime READ_METHODS allowlist', () => {
  // Independent of the generator's AST parse: the module's actual export.
  const reads = committed.operations.filter(op => op.kind === 'read').map(op => op.name);
  assert.deepEqual(diffOperationIds([...READ_METHODS], reads), { missing: [], extra: [] });
});

test('D1.8: host range views have source-bound read-only contract without a fabricated worker method', () => {
  assert.deepEqual(committed.host_result_views.query_range.commands, ['queryRange', 'invalidateRange']);
  assert.equal(committed.host_result_views.query_range.mutability, 'read_only');
  assert.equal(committed.host_result_views.query_range.source, 'src/queryRange.ts::selectResultRange');
  assert.equal(committed.host_result_views.query_range.schema, 'query-range.v1.schema.json');
  assert.deepEqual(committed.host_result_views.manual_table.commands, ['useRangeAsTable']);
  assert.equal(committed.host_result_views.manual_table.mutability, 'in_memory');
  assert.equal(committed.host_result_views.manual_table.source, 'src/queryRange.ts::tableFromRange');
  assert.ok(!committed.operations.some(operation => operation.kind === 'read' && operation.name === 'queryRange'));
});

test('D1.8: operations that bypass the read worker are present', () => {
  for (const id of ['worker.open', 'worker.cancel', 'host.open', 'host.close', 'host.refreshInPlace', 'host.cancel',
    'mutation.createBackup', 'mutation.updateCell', 'write.flatFileWriteback', 'write.xlsxPatch', 'write.xlsxZipRewrite',
    'write.sqliteCell', 'write.duckdbTransaction', 'write.backupCopy']) {
    assert.ok(ids(committed).includes(id), `${id} missing`);
  }
  const update = committed.operations.find(op => op.id === 'mutation.updateCell')!;
  assert.equal(update.routes!['write.xlsxPatch'].at(-1), 'src/xlsxWrite.ts::patchCell');
  assert.ok(update.routes!['write.xlsxPatch'].includes('src/viewerFile.ts::ViewerFile.updateXlsxCell'), 'xlsx edits are patched by the host, not the worker');
  assert.ok(update.callers!.some(c => c.webview_command === 'updateCell'));
});

test('D1.8: committed inventory content equals the generator output', () => {
  assert.deepEqual(comparable(committed), comparable(generated), REGENERATE);
});

test('D1.8: every operation records arguments, result, errors, cancellation, identity and mutability', () => {
  for (const op of committed.operations) {
    assert.ok(Array.isArray(op.arguments), op.id);
    for (const arg of op.arguments) assert.ok(arg.name && arg.type && typeof arg.optional === 'boolean' && typeof arg.serializable === 'boolean', op.id);
    assert.ok(op.result.type && op.result.envelope, op.id);
    assert.ok(Array.isArray(op.errors), op.id);
    assert.ok(op.cancellation.length > 10 && op.identity.length > 3, op.id);
    assert.ok(['read_only', 'in_memory', 'process_state', 'creates_sibling_file', 'mutates_source'].includes(op.mutability), op.id);
    for (const where of [...Object.values(op.source), ...op.evidence]) assert.match(where, /^src\/[^:]+\.ts::\S/, `${op.id}: symbol locator, no line numbers`);
    if (op.kind === 'read') assert.equal(op.mutability, 'read_only', op.id);
  }
  // Host callbacks cannot cross a process boundary; D1.9 must not pretend they can.
  const onStatus = committed.operations.find(op => op.id === 'mutation.updateCell')!.arguments.find(a => a.name === 'onStatus');
  assert.equal(onStatus?.serializable, false);
});

test('D1.8: cross-check against the D0.4 gridcraft reuse inventory', t => {
  const reads = committed.operations.filter(op => op.kind === 'read');
  assert.ok(reads.every(op => op.reuse), 'every read method carries its D0.4 reuse record');
  const check = committed.reuse_cross_check as Exclude<Inventory['reuse_cross_check'], { status: 'not_available' }>;
  assert.equal(check.read_methods_equal, true);
  if (!existsSync(DEFAULT_REUSE_PATH)) { t.skip(`D0.4 inventory absent at ${DEFAULT_REUSE_PATH}; embedded copy checked only`); return; }
  const live = readReuse(DEFAULT_REUSE_PATH, READ_METHODS, check.query_protocol_sha256)!;
  // The D0.4 file is live evidence another agent keeps extending, so its hash is
  // provenance only; the per-method reuse records and method set must agree.
  assert.equal(live.read_methods_equal, true, 'D0.4 read_methods differ from READ_METHODS');
  for (const op of reads) assert.deepEqual(op.reuse, live.methods[op.name], op.id);
});

/** A private copy of src/ (node_modules linked) for mutation experiments. */
function sandbox(edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'dfv-d18-'));
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  edit(dir);
  return dir;
}

test('D1.8: a read method added to READ_METHODS without an implementation fails generation', () => {
  const dir = sandbox(d => {
    const p = join(d, 'src/queryProtocol.ts');
    writeFileSync(p, readFileSync(p, 'utf8').replace("'locateXlsxEdit',", "'locateXlsxEdit', 'exportEverything',"));
  });
  try { assert.throws(() => generate(dir, '/nonexistent'), /exportEverything/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D1.8: discovery is by symbol, so moving READ_METHODS to src/backend/ keeps the inventory', () => {
  const dir = sandbox(d => {
    const p = join(d, 'src/queryProtocol.ts');
    const text = readFileSync(p, 'utf8');
    const start = text.indexOf('export const READ_METHODS');
    const end = text.indexOf('] as const;', start) + '] as const;'.length;
    // Simulate a D1.7-style move: declaration in src/backend/types.ts, re-exported.
    const moved = text.slice(start, end);
    mkdirSync(join(d, 'src/backend'), { recursive: true });
    const backendTypes = join(d, 'src/backend/types.ts');
    writeFileSync(backendTypes, `${readFileSync(backendTypes, 'utf8')}\n${moved}\n`);
    writeFileSync(p, `import { READ_METHODS } from './backend/types';\nexport { READ_METHODS };\n${text.slice(0, start)}${text.slice(end)}`);
  });
  try {
    const moved = generate(dir, '/nonexistent');
    assert.deepEqual(diffOperationIds(ids(generated), ids(moved)), { missing: [], extra: [] });
    const read = moved.operations.find(op => op.id === 'read.runQuery')!;
    assert.equal(read.source.allowlist, 'src/backend/types.ts::READ_METHODS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D1.8: set-equality helper reports both missing and extra operations', () => {
  assert.deepEqual(diffOperationIds(['a', 'b'], ['b', 'c']), { missing: ['a'], extra: ['c'] });
});
