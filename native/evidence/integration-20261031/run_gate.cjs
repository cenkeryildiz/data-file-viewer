#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../../..');
const attempt = process.argv[2];
assert.match(attempt ?? '', /^attempt-\d{2,}$/);
const dir = path.join(__dirname, attempt);
fs.mkdirSync(dir); // Historical attempts are immutable.
const toolchain = '/Users/macc/.rustup/toolchains/1.99.1-aarch64-apple-darwin/bin';
const cargo = path.join(toolchain, 'cargo');
const lock = '/Users/macc/Desktop/Kod/.codex-work/pdf-resume-20261016/lock.sh';
const tag = `${attempt}-table-integrated`;
const worker = path.join(root, 'native/target-duck/debug/dfv-table');
const env = { ...process.env, PATH: `${toolchain}:${process.env.PATH}`, CARGO_TARGET_DIR: path.join(root, 'native/target-duck'), DFV_TABLE_WORKER: worker };
delete env.DFV_TABLE_TEST_DOC;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const json = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n');
const files = [];
function collect(relative) {
  const full = path.join(root, relative);
  if (fs.statSync(full).isDirectory()) {
    for (const entry of fs.readdirSync(full).sort()) collect(path.join(relative, entry));
  } else files.push(relative);
}
for (const relative of ['native/crates', 'src', 'test', 'native/Cargo.toml', 'native/Cargo.lock', 'native/rust-toolchain.toml', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.test.json', path.relative(root, __filename)]) {
  if (relative === 'test') {
    // Test evidence and generated outputs are not inputs to the TypeScript suite.
    const walk = relative => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '_evidence' || entry.name === '_work') continue;
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) files.push(child);
      }
    };
    walk(relative);
  } else collect(relative);
}
const snapshot = () => Object.fromEntries(files.map(file => [file, fs.existsSync(path.join(root, file)) ? sha(fs.readFileSync(path.join(root, file))) : null]));
const before = snapshot();
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
assert.equal(head.status, 0, head.stderr);
json('source.json', { head: head.stdout.trim(), sha256: before });
const runs = [];
let acquired = false;
let exitCode = 0;
let problem;
function step(name, cmd, args, cwd = '.', extraEnv = {}) {
  const log = `${name}.log`;
  const fd = fs.openSync(path.join(dir, log), 'wx');
  const start = Date.now();
  let result;
  try { result = spawnSync(cmd, args, { cwd: path.join(root, cwd), env: { ...env, ...extraEnv }, stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 }); }
  finally { fs.closeSync(fd); }
  const code = result.status ?? 1;
  runs.push({ name, cmd, args, cwd, exit_code: code, seconds: (Date.now() - start) / 1000, log, sha256: sha(fs.readFileSync(path.join(dir, log))), ...(result.error ? { error: result.error.message } : {}) });
  json('runs.json', runs);
  console.log(`${name}: ${code === 0 ? 'passed' : 'FAILED'} (${runs.at(-1).seconds}s)`);
  if (code !== 0) throw new Error(`${name} failed (${code})`);
}
try {
  const held = spawnSync(lock, ['acquire', tag, 'integrated native tables and provider qualification'], { stdio: 'inherit' });
  assert.equal(held.status, 0, 'heavy-test lock acquisition failed');
  acquired = true;
  step('fmt', cargo, ['fmt', '--all', '--check'], 'native');
  step('tests', cargo, ['test', '--workspace', '--all-features', '--offline', '--locked', '-j2'], 'native');
  step('clippy', cargo, ['clippy', '--workspace', '--all-features', '--all-targets', '--offline', '--locked', '-j2', '--', '-D', 'warnings'], 'native');
  step('build', cargo, ['build', '--offline', '--locked', '-p', 'dfv-table', '--features', 'test-doc', '-j2'], 'native');
  const testWorker = sha(fs.readFileSync(worker));
  json('workers.json', { test_doc: testWorker });
  step('typecheck', path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.test.json']);
  step('client', process.execPath, ['--test', 'out-test/test/nativeBackend.test.js', 'out-test/test/nativeProvider.test.js', 'out-test/test/hostProtocol.test.js', 'out-test/test/previewControls.test.js']);
  step('suite', process.execPath, ['--test', 'out-test/test/*.test.js']);
  step('production-build', cargo, ['build', '--offline', '--locked', '-p', 'dfv-table', '-j2'], 'native');
  json('workers.json', { test_doc: testWorker, production: sha(fs.readFileSync(worker)) });
  step('production-client', process.execPath, ['--test', '--test-name-pattern=production worker|native values reach|native CSV factory|real native CSV provider', 'out-test/test/nativeBackend.test.js', 'out-test/test/nativeProvider.test.js'], '.', { DFV_TABLE_TEST_DOC: '1' });
} catch (error) {
  exitCode = 1;
  problem = error.message;
  console.error(problem);
} finally {
  try {
    const after = snapshot();
    const changed = files.filter(file => before[file] !== after[file]);
    if (changed.length) exitCode = 1;
    json('terminal.json', { status: exitCode === 0 ? 'passed' : 'failed', exit_code: exitCode, changed_sources: changed, steps: runs.length, ...(problem ? { error: problem } : {}), worker: fs.existsSync(worker) ? sha(fs.readFileSync(worker)) : null });
  } finally {
    if (acquired) {
      const released = spawnSync(lock, ['release', tag], { stdio: 'inherit' });
      if (released.status !== 0) process.exitCode = 1;
    }
  }
}
process.exitCode = process.exitCode || exitCode;
