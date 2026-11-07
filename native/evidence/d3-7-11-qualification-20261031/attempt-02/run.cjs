// Run from any directory. Receipts bind the sources, command output and both worker builds.
'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..'), out = __dirname;
process.chdir(root);
assert(!fs.existsSync(path.join(out, 'terminal.json')), 'Use a new attempt directory; retain prior evidence.');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = file => digest(fs.readFileSync(file));
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const files = [...cp.execFileSync('git', ['ls-files', 'native', 'src', 'test/nativeBackend.test.ts', 'test/nativeProvider.test.ts', 'test/migrationTableSchema.test.ts', 'test/hostProtocol.test.ts', 'package-lock.json', 'tsconfig.test.json'], { encoding: 'utf8' }).trim().split('\n').filter(file => fs.existsSync(file) && !file.startsWith('native/evidence/')),
  'native/crates/dfv-table/tests/reference_reads.rs', 'native/crates/duckdb-query/tests/reference/gen_reference.cjs', 'native/crates/duckdb-query/tests/reference/d35-reference.json', path.relative(root, __filename)];
const snapshot = () => Object.fromEntries([...new Set(files)].sort().map(file => [file, hash(file)]));
const sources = snapshot(), runs = [];
assert.equal(hash('native/Cargo.lock'), digest(cp.execFileSync('git', ['show', 'HEAD:native/Cargo.lock'])));
write('source.json', { head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dependency_lock_unchanged_from_head: true, sha256: sources });
const env = { ...process.env, CARGO_TARGET_DIR: path.join(root, 'native/target-d37'), DFV_REF_PYTHON: '/Users/macc/miniforge3/envs/myproject/bin/python', DFV_D36_REPORT: path.join(out, 'csv-report.json'), TZ: 'UTC', NODE_PATH: path.join(root, 'node_modules') };
const lock = '/Users/macc/Desktop/Kod/.codex-work/pdf-resume-20261016/lock.sh';
function step(name, command, cwd = root, extra = {}) {
  const start = Date.now(), log = path.join(out, name + '.log'), fd = fs.openSync(log, 'w');
  const result = cp.spawnSync(command[0], command.slice(1), { cwd, env: { ...env, ...extra }, stdio: ['ignore', fd, fd], timeout: 180000 });
  fs.closeSync(fd);
  runs.push({ name, command, cwd, exit_code: result.status, error: result.error?.message, seconds: (Date.now() - start) / 1000, log: path.basename(log), sha256: hash(log) });
  write('runs.json', runs);
  console.log(`${name}: ${result.status}`);
  assert.equal(result.status, 0, fs.readFileSync(log, 'utf8').slice(-5000));
}
assert.equal(cp.spawnSync(lock, ['acquire', 'CODEX-D37-11-FINAL', 'D3.7 and D3.11 final source-bound qualification'], { stdio: 'inherit' }).status, 0);
let status = 'failed';
try {
  const native = path.join(root, 'native');
  step('fmt', ['cargo', 'fmt', '--all', '--check'], native);
  step('rust-workspace', ['cargo', 'test', '--workspace', '--all-features', '--offline', '--locked', '-j2'], native);
  step('clippy', ['cargo', 'clippy', '--workspace', '--all-features', '--all-targets', '--offline', '--locked', '-j2', '--', '-D', 'warnings'], native);
  step('typescript', ['./node_modules/.bin/tsc', '-p', 'tsconfig.test.json']);
  const feature = path.join(env.CARGO_TARGET_DIR, 'debug/d37-feature-worker');
  fs.copyFileSync(path.join(env.CARGO_TARGET_DIR, 'debug/dfv-table'), feature);
  step('default-build-and-reference', ['cargo', 'test', '--offline', '--locked', '-p', 'dfv-table', '--test', 'default_build', '--test', 'reference_reads', '-j2', '--', '--nocapture'], native);
  const production = path.join(env.CARGO_TARGET_DIR, 'debug/dfv-table');
  step('host-client-provider-framing', ['node', '--test', 'out-test/test/nativeBackend.test.js', 'out-test/test/nativeProvider.test.js', 'out-test/test/migrationTableSchema.test.js', 'out-test/test/hostProtocol.test.js'], root, { DFV_TABLE_WORKER: feature, DFV_TABLE_PRODUCTION_WORKER: production });
  step('reference-regeneration', ['node', 'native/crates/duckdb-query/tests/reference/gen_reference.cjs', path.join(root, 'out-test'), path.join(out, 'reference-regenerated.json')]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'reference-regenerated.json'))).cases, JSON.parse(fs.readFileSync('native/crates/duckdb-query/tests/reference/d35-reference.json')).cases);

  step('sqlite-reference-version', ['/Users/macc/miniforge3/envs/myproject/bin/python', '-I', '-c', 'import sqlite3; print(sqlite3.sqlite_version)']);
  const qout = path.join(out, 'q-reference');
  step('q-reference', ['/Users/macc/miniforge3/envs/myproject/bin/python', '-I', 'native/crates/kdb/tests/corpus/generate_corpus.py', qout]);
  const frozen = 'native/crates/kdb/tests/corpus';
  const manifest = JSON.parse(fs.readFileSync(path.join(frozen, 'manifest.json')));
  assert.equal(Object.keys(manifest.files).length, 18);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(qout, 'manifest.json'))), manifest);
  assert.deepEqual(fs.readFileSync(path.join(qout, 'expected.tsv')), fs.readFileSync(path.join(frozen, 'expected.tsv')));
  for (const [file, meta] of Object.entries(manifest.files)) {
    assert.equal(hash(path.join(frozen, file)), meta.sha256);
    assert.equal(hash(path.join(qout, file)), meta.sha256);
    assert.equal(fs.statSync(path.join(qout, file)).size, meta.bytes);
  }
  assert.deepEqual(snapshot(), sources, 'Sources changed during qualification');
  write('workers.json', { feature: { path: feature, sha256: hash(feature) }, production: { path: production, sha256: hash(production) } });
  status = 'passed';
} finally {
  write('terminal.json', { status, steps: runs.length, source_unchanged: JSON.stringify(snapshot()) === JSON.stringify(sources), runs_sha256: hash(path.join(out, 'runs.json')) });
  cp.spawnSync(lock, ['release', 'CODEX-D37-11-FINAL'], { stdio: 'inherit' });
}
