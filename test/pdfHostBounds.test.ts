import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createPdfHost } from '../src/pdfHost';
import { NativeTableClient } from '../src/backend/native';
import { nativeWorkerUsage } from '../src/native/supervisor';

const root = path.resolve(__dirname, '../..');
const settle = (p: Promise<unknown>) => p.then(value => ({ value }), (error: any) => ({ error }));
async function until(condition: () => boolean, label: string) {
  for (const end = performance.now() + 4000; performance.now() < end;) {
    if (condition()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail(label);
}
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-pdf-bounds-'));
  const executable = path.join(dir, 'media/pdf/bin/dfv-pdf'), source = path.join(dir, 'original.pdf'), log = path.join(dir, 'calls');
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(source, 'private fixture source');
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.env.DFV_FAKE_PDF_LOG=${JSON.stringify(log)};\n${fs.readFileSync(path.join(root, 'test/fakePdfWorker.cjs'), 'utf8')}`, { mode: 0o700 });
  const host = await createPdfHost({ extensionPath: dir, globalStorageUri: { fsPath: path.join(dir, 'state') } } as any, { fsPath: source } as any);
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { host, calls, close: async () => {
    host.dispose(); await until(() => nativeWorkerUsage().workers.every(w => w.feature !== 'pdf'), 'PDF child did not exit');
    assert.equal(fs.readFileSync(source, 'utf8'), 'private fixture source'); fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test('PDF host bounds pending reads and preserves control capacity when its request queue is full', async () => {
  const f = await fixture();
  const held: Promise<any>[] = [];
  try {
    for (let i = 0; i < 61; i++) held.push(settle(f.host.request('get_state', { fault: 'hang' })));
    const overflow: any = await settle(f.host.request('get_state', { fault: 'hang' }));
    assert.equal(overflow.error.code, 'RESOURCE_LIMIT');
    assert.deepEqual(await f.host.request('cancel_search', { search_id: 'test-job' }), { cancelled: true });
    await until(() => f.calls().filter(c => c.method === 'get_state').length === 61, 'expected exactly 61 wire reads');
    f.host.dispose();
    const outcomes = await Promise.all(held); assert.ok(outcomes.every(o => o.error.code === 'WORKER_EXITED'));
  } finally { await f.close(); }
});

test('PDF frame and pending serialized-byte limits refuse before send, including multibyte payloads', async () => {
  const f = await fixture(); const held: Promise<any>[] = [];
  try {
    const tooLarge: any = await settle(f.host.request('get_state', { pad: 'é'.repeat(4 * 1024 * 1024) }));
    assert.equal(tooLarge.error.code, 'RESOURCE_LIMIT');
    const pad = 'x'.repeat(8 * 1024 * 1024 - 1024);
    for (let i = 0; i < 3; i++) held.push(settle(f.host.request('get_state', { fault: 'hang', pad })));
    const overflow: any = await settle(f.host.request('get_state', { fault: 'hang', pad }));
    assert.equal(overflow.error.code, 'RESOURCE_LIMIT');
    assert.deepEqual(await f.host.request('cancel_search', { search_id: 'test-job' }), { cancelled: true });
    assert.equal(f.calls().filter(c => c.method === 'get_state').length, 3);
    f.host.dispose(); await Promise.all(held);
  } finally { await f.close(); }
});

test('PDF outer mutation queue is bounded before dispatch and close settles every accepted operation without replay', async () => {
  const f = await fixture(); const held: Promise<any>[] = [];
  try {
    for (let i = 0; i < 61; i++) held.push(settle(f.host.request('page.rotate', { pages: [0], degrees: 90, fault: 'hang' })));
    const overflow: any = await settle(f.host.request('page.rotate', { pages: [0], degrees: 90 }));
    assert.equal(overflow.error.code, 'RESOURCE_LIMIT');
    await until(() => f.calls().some(c => c.method === 'apply_edit'), 'first mutation was not sent');
    f.host.dispose(); const outcomes = await Promise.all(held);
    assert.ok(outcomes.every(o => o.error));
    assert.equal(f.calls().filter(c => c.method === 'apply_edit').length, 1);
  } finally { await f.close(); }
});

test('oversized partial/complete and malformed PDF frames stop only the offending child; invalid resource chunks cannot loop', async () => {
  const table = await NativeTableClient.start({ executable: process.execPath, args: [path.join(root, 'test/fakeNativeWorker.cjs'), 'echo'] });
  try {
    for (const fault of ['oversized-partial', 'oversized-line', 'malformed-frame', 'resource', 'resource-base64']) {
      const f = await fixture();
      try {
        const outcome: any = await settle(f.host.request('get_state', { fault }));
        assert.equal(outcome.error.code, fault.startsWith('resource') ? 'protocol_error' : 'WORKER_EXITED');
        if (fault.startsWith('resource')) assert.equal(f.calls().filter(c => c.method === 'read_resource').length, 1);
        assert.ok(await table.call('ping'), 'unrelated feature remains usable');
      } finally { await f.close(); }
    }
  } finally { await table.close(); }
});

test('hung PDF reads stop after native deadline plus host grace; a pending mutation has no invented execution timeout', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hung = settle(f.host.request('get_state', { fault: 'hang' }));
    t.mock.timers.tick(34999); let done = false; void hung.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
    t.mock.timers.tick(1); const result: any = await hung;
    assert.equal(result.error.code, 'WORKER_EXITED'); assert.match(result.error.message, /30-second deadline.*5-second/);
    t.mock.timers.reset();
  } finally { t.mock.timers.reset(); await f.close(); }
  const m = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let mutationDone = false, readDone = false;
    const mutation = settle(m.host.request('page.rotate', { pages: [0], degrees: 90, fault: 'hold-mutation' })).then(o => { mutationDone = true; return o; });
    await until(() => m.calls().some(c => c.method === 'apply_edit'), 'pending mutation was not sent');
    const read = settle(m.host.request('get_state', { fault: 'hang' })).then(o => { readDone = true; return o; });
    t.mock.timers.tick(70000); await Promise.resolve(); assert.equal(mutationDone, false); assert.equal(readDone, false);
    await m.host.request('cancel_search', { search_id: 'test-job', resume: true });
    const completed: any = await mutation; assert.equal(completed.error, undefined);
    t.mock.timers.tick(34999); await Promise.resolve(); assert.equal(readDone, false);
    t.mock.timers.tick(1); const timedOut: any = await read; assert.equal(timedOut.error.code, 'WORKER_EXITED');
    t.mock.timers.reset();
    assert.equal(m.calls().filter(c => c.method === 'apply_edit').length, 1);
  } finally { t.mock.timers.reset(); await m.close(); }
});
