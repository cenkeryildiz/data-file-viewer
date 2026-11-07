// Real production host client/document over a publication/test-mutations Rust worker.
// Opt in explicitly: DFV_TEST_MUTATION_RECOVERY=1 DFV_TABLE_WORKER=... node --test ...
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeDocument } from '../src/backend/nativeDocument';
import { NativeError } from '../src/backend/native';

const enabled = process.env.DFV_TEST_MUTATION_RECOVERY === '1';
const worker = process.env.DFV_TABLE_WORKER;
const scenarios = ['before_exchange', 'after_exchange', 'after_receipt', 'missing', 'corrupt', 'external-change'] as const;
for (const scenario of scenarios) {
  test(`actual host: SIGKILL ${scenario} restarts and looks up one mutation without replay`, { skip: !enabled, timeout: 25000 }, async () => {
    assert.ok(worker && fs.existsSync(worker), 'Set DFV_TABLE_WORKER to an explicit test-mutations build');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-host-mutation-')));
    const source = path.join(dir, 'rows.csv'), state = path.join(dir, 'state');
    const original = 'id,name\n1,alpha\n2,beta\n';
    const stage = ['missing', 'corrupt', 'external-change'].includes(scenario) ? 'after_exchange' : scenario;
    fs.writeFileSync(source, original);
    let doc: NativeDocument | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      doc = await NativeDocument.open({ executable: worker, env: {
        ...process.env, DFV_TABLE_STATE_DIR: state,
        DFV_TEST_PUBLICATION_FAULT: `pause:${stage}`, DFV_TEST_PUBLICATION_PAUSE_MS: '60000',
      } }, source);
      const client = (doc as any).client;
      const calls: { method: string; args: Record<string, any> }[] = [];
      const call = client.call.bind(client);
      // Observe/delegate only; no response, failure or reconciliation logic is substituted.
      client.call = (method: string, args: Record<string, any> = {}, options: unknown) => {
        calls.push({ method, args: { ...args } });
        return call(method, args, options);
      };
      const pid = client.pid;
      const child = client.worker.child;
      const checkpoint = new Promise<void>((resolve, reject) => {
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          if (stderr.includes(`PUB_TEST checkpoint ${stage}`)) resolve();
        });
        timer = setTimeout(() => reject(new Error(`Native checkpoint ${stage} not reached`)), 15000);
      });
      const backup = scenario === 'after_receipt';
      const pending = (backup ? doc.createBackup() : doc.updateCell('rows', 'name', 'changed', { id: 1, name: 'alpha' }))
        .then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      await checkpoint;
      clearTimeout(timer);
      const mutation = calls.find(c => c.method === (backup ? 'createBackup' : 'updateCell'))!;
      assert.ok(mutation?.args.mutation_id);
      if (scenario === 'missing' || scenario === 'corrupt') {
        const binding = JSON.parse(fs.readFileSync(path.join(state, 'mutations', `mutation-${mutation.args.mutation_id}.json`), 'utf8'));
        const receipt = path.join(state, 'publication', `${binding.receipt_id}.json`);
        if (scenario === 'missing') fs.unlinkSync(receipt); else fs.writeFileSync(receipt, 'corrupt receipt');
      }
      if (scenario === 'external-change') fs.writeFileSync(source, 'id,name\n1,external\n2,beta\n');
      process.kill(pid, 'SIGKILL');
      const result = await pending;
      assert.notEqual(client.pid, pid, 'host started a replacement worker');
      assert.equal(client.alive, true);
      const lookups = calls.filter(c => c.method === 'queryMutationOutcome');
      assert.equal(lookups.length, 1);
      assert.equal(lookups[0].args.mutation_id, mutation.args.mutation_id);
      assert.equal(calls.filter(c => c.method === mutation.method).length, 1, 'host never resubmitted the mutation');
      assert.equal(calls.filter(c => c.method === 'open').length, 1, 'replacement worker reopened once');
      assert.equal(fs.readdirSync(path.join(state, 'mutations')).filter(n => n.startsWith('mutation-')).length, 1);
      if (scenario === 'before_exchange') {
        assert.ok(result.error instanceof NativeError);
        assert.equal(result.error.mutationOutcome, 'not-published');
        assert.equal(result.error.code, 'mutation_not_published');
        assert.equal(fs.readFileSync(source, 'utf8'), original);
      } else if (['missing', 'corrupt', 'external-change'].includes(scenario)) {
        assert.ok(result.error instanceof NativeError);
        assert.equal(result.error.mutationOutcome, 'unknown');
        assert.equal(fs.readFileSync(source, 'utf8'), scenario === 'external-change' ? 'id,name\n1,external\n2,beta\n' : original.replace('alpha', 'changed'));
      } else if (backup) {
        assert.equal(result.error, undefined);
        assert.equal(typeof result.value, 'string');
        assert.equal(fs.readFileSync(result.value as string, 'utf8'), original);
        assert.equal(fs.readFileSync(source, 'utf8'), original);
      } else {
        assert.equal(result.error, undefined);
        assert.equal(result.value, 1);
        assert.equal(fs.readFileSync(source, 'utf8'), original.replace('alpha', 'changed'));
        assert.equal((await doc.runQuery('select name from rows where id=1')).rows[0][0], 'changed');
      }
    } finally {
      clearTimeout(timer);
      await doc?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
