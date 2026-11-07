// D3.17: source -> portable inventory -> actual native advertised dispatch. Missing routes block acceptance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const names = (body, quote) => body.split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const match = s.match(quote);
  assert.ok(match, `Method list contains an unrecognized expression: ${s}`);
  return match[1];
});
const unique = list => {
  assert.equal(new Set(list).size, list.length, 'Duplicate operation name');
  return [...list].sort();
};

export function inspectCoverage({ manifest, queryProtocol, nativeSource }) {
  const body = queryProtocol.match(/export const READ_METHODS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(body, 'Cannot locate source READ_METHODS');
  const reads = unique(names(body[1].replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''), /^['"]([A-Za-z][A-Za-z0-9]*)['"]$/));
  const inventory = unique(manifest.operations.filter(op => op.channel === 'read_worker' && op.kind === 'read').map(op => op.name));
  assert.deepEqual(inventory, reads, 'Regenerate D1.8: source read methods and inventory differ');
  const capabilities = nativeSource.match(/fn capabilities\b[\s\S]*?methods:\s*vec!\[([\s\S]*?)\]/);
  assert.ok(capabilities, 'Cannot locate native advertised methods');
  const advertised = unique(names(capabilities[1], /^"([A-Za-z][A-Za-z0-9]*)"$/));
  const call = nativeSource.match(/\n    fn call\b([\s\S]*?)\n    fn discard\b/);
  assert.ok(call, 'Cannot locate native call dispatch');
  // rustfmt fixes outer method-arm indentation; nested argument matches must not count as dispatch.
  const arms = [...call[1].matchAll(/^ {12}("[A-Za-z][A-Za-z0-9]*"(?:\s*\|\s*"[A-Za-z][A-Za-z0-9]*")*)\s*=>/gm)];
  const dispatch = unique(arms.flatMap(m => [...m[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(n => n[1])));
  assert.deepEqual(dispatch, advertised, 'Native capabilities and real outer dispatch arms differ');
  return { expectedReads: reads.length, coveredReads: reads.filter(name => advertised.includes(name)), missingReads: reads.filter(name => !advertised.includes(name)) };
}

export function loadCoverage() {
  return inspectCoverage({
    manifest: JSON.parse(readFileSync(path.join(root, 'test/migration/table-operations.json'), 'utf8')),
    queryProtocol: readFileSync(path.join(root, 'src/queryProtocol.ts'), 'utf8'),
    nativeSource: readFileSync(path.join(root, 'native/crates/table/src/lib.rs'), 'utf8'),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const coverage = loadCoverage();
  console.log(JSON.stringify(coverage, null, 2));
  assert.deepEqual(coverage.missingReads, [], 'D3.17 native operation coverage is incomplete');
}
