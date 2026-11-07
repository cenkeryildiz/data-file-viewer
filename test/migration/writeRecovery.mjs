// Requires an explicit publication/test-mutations worker; never run against user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const binary = process.env.DFV_TEST_WORKER;
assert.ok(binary, 'Set DFV_TEST_WORKER to a test-mutations worker');
function worker(state, stage) {
  const child = spawn(binary, ['--stdio'], { env: { ...process.env,
    DFV_TABLE_STATE_DIR: state, DFV_TEST_PUBLICATION_FAULT: stage ? `pause:${stage}` : '',
    DFV_TEST_PUBLICATION_PAUSE_MS: '60000' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0, errors = '', paused;
  const waiting = new Map();
  const checkpoint = new Promise(resolve => { paused = resolve; });
  child.stderr.on('data', bytes => { errors += bytes; if (errors.includes(`PUB_TEST checkpoint ${stage}`)) paused(); });
  createInterface({ input: child.stdout }).on('line', line => {
    const frame = JSON.parse(line), pending = waiting.get(frame.id);
    if (pending) { waiting.delete(frame.id); frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(JSON.stringify(frame.error))); }
  });
  const request = (method, args) => new Promise((resolve, reject) => {
    const id = String(++next); waiting.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({protocol:'dfv-table',version:1,kind:'request',id,method,args})}\n`);
  });
  return { request, checkpoint, async stop() { if (child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGKILL'); await once(child, 'exit'); }, errors: () => errors };
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 20000); })]); }
  finally { clearTimeout(timer); }
}
for (const scenario of ['before_exchange', 'after_exchange', 'after_receipt', 'missing', 'corrupt', 'external-change']) {
  const stage = ['missing', 'corrupt', 'external-change'].includes(scenario) ? 'after_exchange' : scenario;
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dfv-kill-recovery-')));
  const state = path.join(root, 'state'), source = path.join(root, 'rows.csv');
  const old = 'id,name\n1,alpha\n2,beta\n';
  await writeFile(source, old);
  const interrupted = worker(state, stage);
  let restarted;
  try {
    const opened = await bounded(interrupted.request('open', {path:source}), 'open');
    const session = opened.session, mutation_id = `kill-${scenario}`;
    const backup = stage === 'after_receipt';
    if (!backup) await bounded(interrupted.request('setSafeMode', {session,enabled:false,expected_revision:'1'}), 'unlock');
    // Deliberately lose the mutation reply; restart only performs status lookup.
    interrupted.request(backup ? 'createBackup' : 'updateCell', { session, mutation_id,expected_revision:'1',
      table:'rows',column:'name',new_value:'changed',row_values:{id:{$t:'int64',v:'1'},name:'alpha'} }).catch(() => {});
    await bounded(interrupted.checkpoint, `fault ${stage}: ${interrupted.errors()}`);
    await interrupted.stop();
    if (scenario === 'missing' || scenario === 'corrupt') {
      const binding = JSON.parse(await readFile(path.join(state, 'mutations', `mutation-${mutation_id}.json`), 'utf8'));
      const record = path.join(state, 'publication', `${binding.receipt_id}.json`);
      if (scenario === 'missing') await rm(record); else await writeFile(record, 'corrupt receipt');
    }
    if (scenario === 'external-change') await writeFile(source, 'external independent generation\n');
    restarted = worker(state);
    const result = await bounded(restarted.request('queryMutationOutcome', {mutation_id}), 'recovery');
    if (['missing', 'corrupt', 'external-change'].includes(scenario)) {
      assert.equal(result.outcome, 'unknown');
      assert.equal(await readFile(source, 'utf8'), scenario === 'external-change' ? 'external independent generation\n' : old.replace('alpha', 'changed'));
    } else if (stage === 'before_exchange') {
      assert.equal(result.outcome, 'not-published');
      assert.equal(await readFile(source, 'utf8'), old);
    } else {
      assert.equal(result.outcome, 'published');
      assert.equal(result.receipt.reconciled, true);
      assert.equal(result.receipt.directory_sync, backup ? 'synced' : 'failed');
      if (backup) {
        assert.equal(await readFile(result.receipt.backup_path, 'utf8'), old);
        assert.equal(await readFile(source, 'utf8'), old);
        assert.equal(result.receipt.source_after, null);
      } else {
        assert.equal(await readFile(source, 'utf8'), old.replace('alpha', 'changed'));
        assert.equal(result.receipt.source_after.revision, '2');
      }
      assert.deepEqual(await bounded(restarted.request('queryMutationOutcome', {mutation_id}), 'repeat recovery'), result);
    }
    console.log(`PASS SIGKILL ${scenario}: ${result.outcome}`);
  } finally {
    if (interrupted && interrupted.errors) { try { await interrupted.stop(); } catch {} }
    if (restarted) await restarted.stop();
    await rm(root, {recursive:true,force:true});
  }
}
