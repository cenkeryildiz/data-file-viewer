import assert from 'node:assert/strict';
import test from 'node:test';
import { compare, compareDateNames, extractRSymbol } from './upstreamDrift.mjs';

const sym = (sha256, body = 'x') => ({ sha256, body });
const baseline = () => ({
  repos: [{ prefix: 'R/x', commit: 'c0' }],
  files: { 'R/x/a.R': { sha256: 'F1', symbols: { f: 'S1' } } },
  rows: [{ id: 'r', behavior: 'B', upstream: { 'R/x/a.R': ['f'] }, extension: { 'src/a.ts': ['thing'] }, tests: ['test/a.test.ts'] }],
  differential: { etlFile: 'e', historicalFile: 'h', tsFile: 'src/a.ts', words: ['Date', 'TARİH'], intentionalDifferences: [{ word: 'TARİH', etl: true, viewer: false, status: 'gap', reason: 'r' }] },
});
const observed = () => ({
  files: { 'R/x/a.R': { sha256: 'F1', symbols: { f: sym('S1') } } },
  git: { 'R/x': { known: true, head: 'c0', changed: [], dirty: [] } },
  ext: { 'src/a.ts': 'export const DATE_COL_PATTERN = /^(?:date)$/i;\nexport function thing() {}', 'test/a.test.ts': '' },
  patterns: { e: { Date: true, 'TARİH': true }, h: { Date: true, 'TARİH': true } },
  tsPattern: 'export const DATE_COL_PATTERN = /^(?:date)$/i;\nexport function thing() {}',
});
const kinds = (b, o) => compare(b, o).map((p) => p.kind);

test('matching baseline passes; pinned gap is not a failure', () => assert.deepEqual(kinds(baseline(), observed()), []));
test('a changed symbol fails and names the extension files and tests to review', () => {
  const o = observed(); o.files['R/x/a.R'].symbols.f = sym('S2');
  const [p] = compare(baseline(), o);
  assert.equal(p.kind, 'CHANGED-SYMBOL');
  assert.match(p.text, /src\/a\.ts/); assert.match(p.text, /test\/a\.test\.ts/);
});
test('missing symbol, missing file, file change outside the map and a moved upstream all fail', () => {
  let o = observed(); o.files['R/x/a.R'].symbols.f = null; assert.deepEqual(kinds(baseline(), o), ['MISSING-SYMBOL']);
  o = observed(); o.files['R/x/a.R'] = null; assert.deepEqual(kinds(baseline(), o), ['MISSING-FILE']);
  o = observed(); o.files['R/x/a.R'].sha256 = 'F2'; assert.deepEqual(kinds(baseline(), o), ['CHANGED-FILE']);
  o = observed(); o.git['R/x'].changed = ['a.R']; assert.deepEqual(kinds(baseline(), o), ['UPSTREAM-MOVED']);
  o = observed(); o.git['R/x'].known = false; assert.deepEqual(kinds(baseline(), o), ['BASELINE-COMMIT']);
});
test('a nested needle must still be present in the symbol body', () => {
  const b = baseline(); b.files['R/x/a.R'].symbols = { 'f~qLabel': 'S1' }; b.rows[0].upstream['R/x/a.R'] = ['f~qLabel'];
  assert.deepEqual(kinds(b, observed()), ['MISSING-SYMBOL']);
});
test('extension symbols and tests that vanish fail', () => {
  let o = observed(); o.ext['src/a.ts'] = 'export const DATE_COL_PATTERN = /^(?:date)$/i;'; assert.deepEqual(kinds(baseline(), o), ['MISSING-EXTENSION']);
  o = observed(); o.ext['test/a.test.ts'] = null; assert.deepEqual(kinds(baseline(), o), ['MISSING-EXTENSION']);
});
test('date-name differences must be named, current and match the observation', () => {
  const diff = baseline().differential;
  let o = observed(); o.patterns.e.Date = o.patterns.h.Date = false; assert.deepEqual(compareDateNames(diff, o).map((p) => p.kind), ['UNNAMED-DIFFERENCE']);
  o = observed(); o.patterns.e['TARİH'] = o.patterns.h['TARİH'] = false; assert.deepEqual(compareDateNames(diff, o).map((p) => p.kind), ['STALE-DIFFERENCE']);
  o = observed(); o.patterns.h.Date = false; assert.ok(compareDateNames(diff, o).some((p) => p.kind === 'ETL-COPIES-DIFFER'));
});
test('R extraction ends at the statement, not at brackets or comments inside strings', () => {
  const t = 'a <- 1\nf <- function(x) {\n  s <- "}" # not "}"\n  if (x) {\n    1\n  } else {\n    2\n  }\n}\n\ng <- 2 +\n  3\nh <- 4';
  assert.equal(extractRSymbol(t, 'f').split('\n').length, 8);
  assert.equal(extractRSymbol(t, 'g'), 'g <- 2 +\n  3');
  assert.equal(extractRSymbol(t, 'a'), 'a <- 1');
  assert.equal(extractRSymbol(t, 'missing'), null);
});
