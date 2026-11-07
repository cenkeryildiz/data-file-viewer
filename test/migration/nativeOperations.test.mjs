import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectCoverage, loadCoverage } from './nativeOperations.mjs';

const fixture = () => ({
  manifest: { operations: ['one', 'two'].map(name => ({ name, channel: 'read_worker', kind: 'read' })) },
  queryProtocol: "export const READ_METHODS = ['one', /* comment */ 'two'] as const;",
  nativeSource: `
    fn capabilities(&self) -> Capabilities {
        Capabilities { methods: vec!["one"], }
    }
    fn call(&mut self, method: &str) {
        match method {
            "one" => {},
        }
    }
    fn discard(&mut self) {}
`,
});

test('missing reads remain explicit instead of being silently exempted', () => {
  assert.deepEqual(inspectCoverage(fixture()), { expectedReads: 2, coveredReads: ['one'], missingReads: ['two'] });
});
test('inventory drift, duplicate methods and missing advertised arms fail', () => {
  const drift = fixture(); drift.queryProtocol = "export const READ_METHODS = ['one'] as const;";
  assert.throws(() => inspectCoverage(drift), /Regenerate D1.8/);
  const duplicate = fixture(); duplicate.manifest.operations.push(duplicate.manifest.operations[0]);
  assert.throws(() => inspectCoverage(duplicate), /Duplicate/);
  const stub = fixture(); stub.nativeSource = stub.nativeSource.replace('"one" =>', '"unadvertised" =>');
  assert.throws(() => inspectCoverage(stub), /real outer dispatch/);
});
test('an argument match cannot masquerade as an operation route', () => {
  const nested = fixture(); nested.nativeSource = nested.nativeSource.replace('"one" => {},', '"one" => {\n                    "two" => {},\n            },');
  assert.deepEqual(inspectCoverage(nested).missingReads, ['two']);
});
test('the checked-in source inventory and native advertised arms agree', () => {
  const coverage = loadCoverage();
  assert.ok(coverage.expectedReads > 0);
  assert.equal(coverage.coveredReads.length + coverage.missingReads.length, coverage.expectedReads);
});

test('a combined outer match arm covers both advertised methods', () => {
  const both = fixture();
  both.nativeSource = both.nativeSource.replace('methods: vec!["one"]', 'methods: vec!["one", "two"]').replace('"one" => {},', '"one" |\n            "two" => {},');
  assert.deepEqual(inspectCoverage(both).missingReads, []);
});
