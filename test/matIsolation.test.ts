import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MatClient } from '../src/features/mat/client';
import { NativeDocument } from '../src/backend/nativeDocument';
import { NativeError } from '../src/backend/nativeWorker';
const matWorker = process.env.DFV_MAT_WORKER, tableWorker = process.env.DFV_TABLE_WORKER, fixture = process.env.DFV_MAT_FIXTURE;
const actual = { skip: !matWorker || !tableWorker || !fixture ? 'name actual MAT/table workers and genuine MAT fixture' : false };
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('real MAT/table isolation: child death settles pending reads, leaves the other feature usable and explicit refresh discards old handles', actual, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-isolation-')), csv = path.join(dir, 'rows.csv');
  const original = 'id,name\n1,alpha\n2,beta\n'; fs.writeFileSync(csv, original);
  let mat = await MatClient.open({ executable: matWorker! }, fixture!);
  const table = await NativeDocument.open({ executable: tableWorker! }, csv);
  const matPid = mat.pid!, tablePid = (table as any).client.pid as number;
  const pids = [matPid, tablePid];
  try {
    const page = await mat.catalog(), oldHandle = page.items[0].handle;
    const pending = Array.from({ length: 8 }, () => mat.catalog());
    process.kill(matPid, 'SIGKILL');
    const outcomes = await Promise.allSettled(pending);
    assert.ok(outcomes.some(o => o.status === 'rejected'), 'actual child death interrupts outstanding reads');
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof NativeError && outcome.reason.code === 'worker_exited');
    assert.equal((mat as any).worker.pending.size, 0); assert.equal((mat as any).worker.waiting.length, 0);
    await assert.rejects(mat.catalog(), (e: any) => e.code === 'worker_exited');
    assert.deepEqual((await table.runQuery('select id, name from rows order by id')).rows, [['1', 'alpha'], ['2', 'beta']]);
    mat = await mat.reopen(); pids.push(mat.pid!); assert.notEqual(mat.pid, matPid);
    await assert.rejects(mat.describe(oldHandle), /no longer open/);
    const refreshed = await mat.catalog(), unsigned = refreshed.items.find(i => i.info.name === 'unsigned'); assert.ok(unsigned);
    const tableRead = table.runQuery('select sum(i) from range(1000000000) t(i)');
    process.kill(tablePid, 'SIGKILL');
    await assert.rejects(tableRead, (e: any) => e instanceof NativeError && e.code === 'worker_exited');
    assert.equal((await mat.slice(unsigned.handle, ['1', '1'], ['1', '3'])).data.re!.length, 3);
    assert.equal(running(tablePid), false); assert.equal(running(matPid), false);
    assert.equal(fs.readFileSync(csv, 'utf8'), original);
  } finally { await table.close(); await mat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  for (const pid of pids) assert.equal(running(pid), false, `owned worker ${pid} was reaped`);
});

test('real MAT lifecycle: cancelled/close requests settle and repeated open/close leaves no owned processes', actual, async () => {
  const pids: number[] = [];
  for (let cycle = 0; cycle < 10; cycle++) {
    const mat = await MatClient.open({ executable: matWorker! }, fixture!); pids.push(mat.pid!);
    const control = new AbortController();
    const read = mat.catalog('0', control.signal); control.abort();
    const result = await Promise.allSettled([read]);
    if (result[0].status === 'rejected') assert.ok(result[0].reason instanceof NativeError && result[0].reason.code === 'cancelled');
    const closingReads = [mat.catalog(), mat.catalog()];
    const closing = mat.close();
    await Promise.allSettled(closingReads); await closing;
    assert.equal((mat as any).worker.pending.size, 0); assert.equal((mat as any).worker.waiting.length, 0);
  }
  for (const pid of pids) assert.equal(running(pid), false, `owned worker ${pid} was reaped`);
});
