// Run under the shared owned lock. Each attempt directory must be new.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const dir = path.resolve(process.argv[2]);
fs.mkdirSync(dir, { recursive: false });
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceFiles = execFileSync('git', ['ls-files', 'src', 'test', 'package.json', 'package-lock.json', 'media', 'esbuild.js', 'tsconfig.json', 'tsconfig.test.json'], { encoding: 'utf8' }).trim().split('\n').filter(f => !f.startsWith('test/_evidence/'));
const source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha256: Object.fromEntries(sourceFiles.map(f => [f, sha(f)])) };
fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify(source, null, 2));
const steps = [
  ['typecheck', 'npm', ['run', 'typecheck']],
  ['unit', 'npm', ['test']],
  ['browser', 'npm', ['run', 'test:browser']],
  ['build', 'npm', ['run', 'build']],
  ['package', 'npx', ['vsce', 'package', '--allow-missing-repository']],
  ['host', 'npm', ['run', 'test:host']],
];
const runs = [];
for (const [name, command, args] of steps) {
  const fd = fs.openSync(path.join(dir, `${name}.log`), 'wx');
  const start = Date.now();
  const env = { ...process.env, EX02_REPORT: path.join(dir, `${name}-ex02.json`) };
  if (name === 'host') env.DFV_HOST_ROOT = path.join(dir, 'host-profile');
  const result = spawnSync(command, args, { stdio: ['ignore', fd, fd], env });
  fs.closeSync(fd);
  runs.push({ name, command: [command, ...args], exit_code: result.status, signal: result.signal, seconds: (Date.now() - start) / 1000 });
  fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify(runs, null, 2));
  console.log(name, result.status);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const [file, hash] of Object.entries(source.sha256)) {
  if (sha(file) !== hash) throw new Error(`Source changed during verification: ${file}`);
}
console.log('All gates complete; source hashes unchanged.');
