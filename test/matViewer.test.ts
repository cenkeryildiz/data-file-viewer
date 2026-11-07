import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NativeWorker } from '../src/backend/nativeWorker';
import { createHash } from 'node:crypto';
import vscode from './stress/stubs/vscode';
import { MatDocument, MatEditorProvider } from '../src/features/mat/provider';
import { MatClient } from '../src/features/mat/client';
import { coordinates, firstRegion, scalarText, uint64 } from '../src/features/mat/protocol';

const worker = process.env.DFV_MAT_WORKER;
const fixture = process.env.DFV_MAT_FIXTURE;
const real = { skip: !worker || !fixture ? 'set DFV_MAT_WORKER and DFV_MAT_FIXTURE for actual MAT worker qualification' : false };

test('MAT view coordinates retain MATLAB column-major ND order and exact wide dimensions', () => {
  assert.deepEqual(coordinates(5, ['1', '1', '9007199254740993'], ['2', '2', '2']), ['2', '1', '9007199254740994']);
  assert.deepEqual(firstRegion(['0', '9007199254740993']), { start: ['1', '1'], count: ['0', '1000'] });
  assert.deepEqual(firstRegion(['1000000', '1000000'], true).count, ['1000000', '1000000']);
  assert.equal(scalarText({ $t: 'uint64', v: '18446744073709551615' }), '18446744073709551615');
  for (const v of ['-0', 'NaN', 'Infinity', '-Infinity']) assert.equal(scalarText({ $t: 'float64', v }), v);
  assert.equal(scalarText(true), 'true');
  assert.equal(uint64('18446744073709551616'), false);
  assert.equal(uint64('01'), false);
  assert.throws(() => scalarText({ $t: 'uint64', v: '18446744073709551616' }));
  assert.throws(() => scalarText({ $t: 'int64', v: 'NaN' }));
});

test('real MAT worker: stdio exact values, source integrity and owned handle release', real, async () => {
  const before = createHash('sha256').update(fs.readFileSync(fixture!)).digest('hex');
  const client = await MatClient.open({ executable: worker! }, fixture!);
  try {
    assert.ok(client.pid);
    const page = await client.catalog();
    const find = (name: string) => { const i = page.items.find(i => i.info.name === name); assert.ok(i, name); return i; };
    const oracle = JSON.parse(fs.readFileSync(fixture!.replace(/\.mat$/, '.oracle.json'), 'utf8'));
    for (const name of ['matrix', 'unsigned', 'signed', 'tensor']) {
      const item = find(name), meta = await client.describe(item.handle);
      const value = await client.slice(item.handle, meta.dims.map(() => '1'), meta.dims);
      assert.deepEqual(value.data.re!.map(scalarText), oracle[name].dec, name);
    }
    const special = find('special');
    assert.equal(scalarText((await client.slice(special.handle, ['1', '1'], ['1', '5'])).data.re![1]), '-0');
    const complex = await client.slice(find('complex_values').handle, ['1', '1'], ['1', '2']);
    assert.equal(scalarText(complex.data.im![1]), '-4');
    assert.deepEqual((await client.slice(find('text').handle, ['1', '1'], ['1', '6'])).data.rows, [' İş😀 ']);
    const sparse = await client.sparse(find('sparse_values').handle, ['1', '1'], ['1000000', '1000000']);
    assert.equal(sparse.entries.length, 2); assert.equal(sparse.entries[1].row, '1000000');
    const old = page.items[0].handle;
    await client.release(page.items.map(i => i.handle));
    await assert.rejects(client.describe(old), /no longer open/);
  } finally { await client.close(); }
  assert.equal(createHash('sha256').update(fs.readFileSync(fixture!)).digest('hex'), before);
});


test('MAT read-only provider rejects writes, foreign sessions and malformed page coordinates before dispatch', async () => {
  const doc = new MatDocument(vscode.Uri.file('/data/read-only.mat') as any, {} as MatClient);
  for (const [command, args] of [['updateCell', {}], ['save', {}], ['slice', { handle: 'x', start: ['0'], count: ['1'], session: 'foreign' }], ['catalog', { offset: '01' }], ['catalog', { offset: '18446744073709551616' }], ['slice', { handle: 'x', start: Array(33).fill('1'), count: Array(33).fill('1') }], ['release', { handles: Array(1001).fill('x') }]]) {
    await assert.rejects(doc.request(command, args));
  }
  assert.equal('saveCustomDocument' in MatEditorProvider.prototype, false);
  assert.equal('onDidChangeCustomDocument' in MatEditorProvider.prototype, false);
});


test('real MAT worker: table namespace refuses MAT and cancelled reads stay source bound', real, async () => {
  await assert.rejects(NativeWorker.start({ executable: worker! }), (e: any) => e.code === 'protocol_violation');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-viewer-')), file = path.join(dir, 'copy.mat');
  fs.copyFileSync(fixture!, file);
  let client = await MatClient.open({ executable: worker! }, file);
  try {
    const page = await client.catalog(), handle = page.items[0].handle;
    const control = new AbortController(); control.abort();
    await assert.rejects(client.describe(handle, control.signal), (e: any) => e.code === 'cancelled');
    const replacement = path.join(dir, 'replacement.mat'); fs.copyFileSync(fixture!, replacement); fs.renameSync(replacement, file);
    await assert.rejects(client.describe(handle), (e: any) => e.code === 'stale_source');
    client = await client.reopen();
    await assert.rejects(client.describe(handle), /no longer open/);
    assert.ok((await client.catalog()).items.length > 0);
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real MAT worker: select among 1000 genuine variables and page catalog without retained old handles', real, async () => {
  const file = path.join(path.dirname(fixture!), 'many_v7.mat');
  const client = await MatClient.open({ executable: worker! }, file);
  try {
    assert.equal(client.variables, '1000');
    let found = false;
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await client.catalog(String(offset));
      assert.equal(page.items.length, 100);
      const last = page.items.find(i => i.info.name === 'v1000');
      if (last) { const r = await client.slice(last.handle, ['1', '1'], ['1', '1']); assert.equal(scalarText(r.data.re![0]), '1000000007000'); found = true; }
      await client.release(page.items.map(i => i.handle));
      await assert.rejects(client.describe(page.items[0].handle), /no longer open/);
    }
    assert.equal(found, true);
  } finally { await client.close(); }
});


test('real MAT worker: unsupported objects remain explicit metadata and nested structures retain owned children', real, async () => {
  const file = path.join(path.dirname(fixture!), 'refusals_v7.mat');
  const client = await MatClient.open({ executable: worker! }, file);
  try {
    const page = await client.catalog();
    const object = page.items.find(i => i.info.name === 'string_obj'); assert.ok(object);
    const meta = await client.describe(object.handle); assert.equal(meta.support.supported, false); assert.ok(meta.support.reason);
    await assert.rejects(client.slice(object.handle, meta.dims.map(() => '1'), meta.dims), (e: any) => e.code === 'unsupported');
    const root = page.items.find(i => i.info.name === 'nested'); assert.ok(root);
    const children = await client.children(root.handle), inner = children.items.find(i => i.label?.includes('inner')); assert.ok(inner);
    const nested = await client.children(inner.handle); assert.ok(nested.items.some(i => i.label?.includes('x')));
    await client.release([...page.items, ...children.items, ...nested.items].map(i => i.handle));
  } finally { await client.close(); }
});
