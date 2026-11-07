// EX-05 evidence runner (same as EX-02's): node test/_evidence/ex-05/run_step.cjs <attemptDir> <name> -- <command...>
// Runs one step from the repository root, keeps its log, and appends
// {name, command, started, finished, exitCode, log} to <attemptDir>/runs.json.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const [dir, name, sep, ...command] = process.argv.slice(2);
if (!dir || !name || sep !== '--' || command.length === 0) {
  console.error('usage: run_step.cjs <attemptDir> <name> -- <command...>');
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });
const log = path.join(dir, `${name}.log`);
const started = new Date().toISOString();
const out = fs.openSync(log, 'w');
const result = spawnSync(command.join(' '), { shell: '/bin/zsh', stdio: ['ignore', out, out], env: process.env });
fs.closeSync(out);
const entry = {
  name, command: command.join(' '), started, finished: new Date().toISOString(),
  exitCode: result.status ?? (result.signal ? `signal ${result.signal}` : 'unknown'), log: `${name}.log`,
};
const runsFile = path.join(dir, 'runs.json');
const runs = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, 'utf8')) : { steps: [] };
runs.steps.push(entry);
fs.writeFileSync(`${runsFile}.tmp`, JSON.stringify(runs, null, 2) + '\n');
fs.renameSync(`${runsFile}.tmp`, runsFile);
console.log(`${name}: exit ${entry.exitCode}`);
process.exit(typeof entry.exitCode === 'number' ? entry.exitCode : 1);
