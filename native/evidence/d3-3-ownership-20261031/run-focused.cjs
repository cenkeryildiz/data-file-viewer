const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const out = path.join('native/evidence/d3-3-ownership-20261031', process.argv[2]);
fs.mkdirSync(out);
const lock = '/Users/macc/Desktop/Kod/.codex-work/pdf-resume-20261016/lock.sh';
const tag = 'd33-owned-results-focused';
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sources = ['native/Cargo.lock', 'native/crates/dfv-table/Cargo.toml', 'native/crates/dfv-table/tests/stdio.rs', 'native/crates/table/src/lib.rs', 'native/crates/table/src/testdoc.rs', 'native/crates/protocol/src/sched.rs'];
const before = Object.fromEntries(sources.map(p => [p, hash(p)]));
fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify(before, null, 2));
const cargo = '/Users/macc/.rustup/toolchains/1.99.1-aarch64-apple-darwin/bin/cargo';
const env = { ...process.env, PATH: path.dirname(cargo) + ':' + process.env.PATH };
if (!env.CARGO_TARGET_DIR) throw Error('Set CARGO_TARGET_DIR to the existing shared table cache.');
const runs = [];
function run(name, args, executable = cargo) {
  const log = path.join(out, name + '.log');
  const fd = fs.openSync(log, 'wx');
  const result = cp.spawnSync(executable, args, { cwd: 'native', env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  runs.push({ name, exit_code: result.status, executable, executable_sha256: hash(executable), args, log_sha256: hash(log) });
  fs.writeFileSync(path.join(out, 'runs.json'), JSON.stringify(runs, null, 2));
  console.log(name + ' exit ' + result.status);
  if (result.status !== 0) throw Error(name + ' failed');
}
if (cp.spawnSync(lock, ['acquire', tag, 'real table ownership, hard-death and lint regressions'], { stdio: 'inherit' }).status !== 0) process.exit(1);
let passed = false;
try {
  run('ownership', ['test', '--workspace', '--all-features', '--offline', '--locked', '-j2', 'late_results']);
  const artifact = fs.readFileSync(path.join(out, 'ownership.log'), 'utf8').match(/Running tests\/stdio\.rs \(([^\n]+)\)/)?.[1];
  if (!artifact) throw Error('The workspace build did not identify its stdio test executable.');
  run('production-stdio', [], artifact);
  run('clippy', ['clippy', '--workspace', '--all-features', '--all-targets', '--offline', '--locked', '-j2', '--', '-D', 'warnings']);
  passed = true;
} catch (error) { console.log(String(error)); }
finally {
  const changed = sources.filter(p => hash(p) !== before[p]);
  fs.writeFileSync(path.join(out, 'terminal.json'), JSON.stringify({ passed, changed_sources: changed, runs: runs.length }, null, 2));
  cp.spawnSync(lock, ['release', tag], { stdio: 'inherit' });
}
if (!passed) process.exitCode = 1;
