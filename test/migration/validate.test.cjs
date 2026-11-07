const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validate } = require('./validate.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'result.log'), 'terminal success\n');
  const report = { schema_version: 1, tasks: [{
    task_id: 'D0.5', status: 'passed', input_commits: ['a'.repeat(40)], output_commits: ['b'.repeat(40)],
    dirty_disposition: ['Unrelated files retained'],
    commands: [{ command: 'test', exit_code: 0, log: 'result.log' }], fixtures: [],
    artifacts: [{ path: 'result.log', sha256: crypto.createHash('sha256').update('terminal success\n').digest('hex') }],
    evidence_paths: ['result.log'], failures: [], skips: [], blockers: [],
    platform: { runner: 'darwin-arm64', tested: ['darwin-arm64'], claimed: ['darwin-arm64'] },
    rollback_ref: 'a'.repeat(40),
  }] };
  return { root, report };
}

test('accepts complete evidence repeatedly without modifying it', t => {
  const { root, report } = fixture(t);
  for (let i = 0; i < 100; i++) assert.equal(validate(report, root), 1);
  assert.equal(fs.readFileSync(path.join(root, 'result.log'), 'utf8'), 'terminal success\n');
});

const mutations = {
  'missing required field': r => { delete r.tasks[0].commands; },
  'invalid status': r => { r.tasks[0].status = 'done'; },
  'empty output commit': r => { r.tasks[0].output_commits = []; },
  'malformed commit': r => { r.tasks[0].output_commits = ['latest']; },
  'missing evidence': r => { r.tasks[0].evidence_paths = []; },
  'missing hash': r => { r.tasks[0].artifacts = []; },
  'wrong hash': r => { r.tasks[0].artifacts[0].sha256 = '0'.repeat(64); },
  'missing file': r => { r.tasks[0].artifacts[0].path = 'absent.log'; },
  'failed command': r => { r.tasks[0].commands[0].exit_code = 1; },
  'recorded failure': r => { r.tasks[0].failures = ['failed']; },
  'recorded blocker': r => { r.tasks[0].blockers = ['blocked']; },
  'unsupported platform': r => { r.tasks[0].platform.claimed.push('win32-x64'); },
  'runner not tested': r => { r.tasks[0].platform.runner = 'linux-x64'; },
  'duplicate task': r => { r.tasks.push(structuredClone(r.tasks[0])); },
  'unexplained block': r => { r.tasks[0].status = 'blocked'; },
  'unknown field': r => { r.tasks[0].success = true; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, t => {
    const { root, report } = fixture(t);
    mutate(report);
    assert.throws(() => validate(report, root));
  });
}

test('rejects changed evidence after an earlier successful run', t => {
  const { root, report } = fixture(t);
  validate(report, root);
  fs.appendFileSync(path.join(root, 'result.log'), 'changed');
  assert.throws(() => validate(report, root), /Hash mismatch/);
});

test('rejects traversal and symlinks escaping the evidence root', t => {
  const { root, report } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'result.log'), 'terminal success\n');
  report.tasks[0].artifacts[0].path = path.relative(root, path.join(outside, 'result.log'));
  assert.throws(() => validate(report, root), /escapes project root/);
  fs.symlinkSync(path.join(outside, 'result.log'), path.join(root, 'link.log'));
  report.tasks[0].artifacts[0].path = 'link.log';
  assert.throws(() => validate(report, root), /escapes project root/);
});
