// Portable evidence gate shared byte-for-byte with the viewer reference.
// Usage: node validate.cjs RESULTS.json PROJECT_ROOT
// Paths in reports are relative to PROJECT_ROOT; external logs must be copied in.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const schema = require('./task-results.schema.json');

function check(value, rule, where) {
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const valid = rule.type === 'integer' ? Number.isSafeInteger(value) : kind === rule.type;
  if (!valid) throw new Error(`${where}: expected ${rule.type}`);
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${where}: invalid value`);
  if (kind === 'string') {
    if (value.length < (rule.minLength || 0) || !value.trim()) throw new Error(`${where}: empty string`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) throw new Error(`${where}: invalid format`);
  }
  if (kind === 'array') {
    if (value.length < (rule.minItems || 0)) throw new Error(`${where}: missing entries`);
    value.forEach((item, i) => check(item, rule.items, `${where}[${i}]`));
  }
  if (kind === 'object') {
    for (const key of rule.required) {
      if (!Object.hasOwn(value, key)) throw new Error(`${where}.${key}: missing field`);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(rule.properties, key)) throw new Error(`${where}.${key}: unexpected field`);
      check(value[key], rule.properties[key], `${where}.${key}`);
    }
  }
}

function validate(report, projectRoot) {
  check(report, schema, 'report');
  const root = fs.realpathSync(projectRoot);
  function resolveFile(name) {
    if (path.isAbsolute(name)) throw new Error(`Evidence must be project-relative: ${name}`);
    const resolved = fs.realpathSync(path.resolve(root, name));
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Evidence escapes project root: ${name}`);
    }
    if (!fs.statSync(resolved).isFile()) throw new Error(`Evidence is not a file: ${name}`);
    return resolved;
  }
  const ids = new Set();
  for (const task of report.tasks) {
    if (ids.has(task.task_id)) throw new Error(`Duplicate task: ${task.task_id}`);
    ids.add(task.task_id);
    const hashes = new Map();
    for (const item of [...task.fixtures, ...task.artifacts]) {
      const file = resolveFile(item.path);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (actual !== item.sha256) throw new Error(`Hash mismatch: ${item.path}`);
      hashes.set(file, actual);
    }
    for (const name of [...task.evidence_paths, ...task.commands.map(c => c.log)]) {
      if (!hashes.has(resolveFile(name))) throw new Error(`Evidence missing hash: ${name}`);
    }
    for (const claimed of task.platform.claimed) {
      if (!task.platform.tested.includes(claimed)) throw new Error(`Untested platform claim: ${claimed}`);
    }
    if (task.status === 'passed') {
      if (!task.output_commits.length || !task.commands.length || !task.evidence_paths.length ||
          !task.platform.tested.length || !task.platform.tested.includes(task.platform.runner)) {
        throw new Error(`${task.task_id}: passed task lacks completion evidence`);
      }
      if (task.commands.some(c => c.exit_code !== 0) || task.failures.length || task.blockers.length) {
        throw new Error(`${task.task_id}: passed task contains failures or blockers`);
      }
    }
    if (task.status === 'blocked' && !task.blockers.length) throw new Error(`${task.task_id}: blocker required`);
  }
  return report.tasks.length;
}

module.exports = { validate };
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node validate.cjs RESULTS.json PROJECT_ROOT');
    const count = validate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]);
    console.log(`Validated ${count} task records (evidence integrity only; acceptance requires review).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
