import assert from 'node:assert/strict';
import test from 'node:test';
import { queryDiagnostic, queryNotices } from '../src/queryDiagnostics';
import { NativeError } from '../src/backend/nativeWorker';

test('native diagnostics retain typed failures and raw worksheet guidance without engine text', () => {
  const secret = 'SYNTHETIC_PRIVATE_VALUE';
  const diagnostic = queryDiagnostic(new NativeError('query_failed', secret), true);
  assert.equal(diagnostic.category, 'unknown');
  assert.match(diagnostic.message, /detected table/);
  assert.ok(!diagnostic.message.includes(secret));
  assert.match(queryDiagnostic(new NativeError('runtime_busy', secret, { category: 'resource' })).message, /busy/);
  assert.match(queryDiagnostic(new NativeError('deadline_exceeded', secret, { category: 'resource' })).message, /time limit/);
  for (const category of ['cancelled', 'resource', 'blocked'] as const) {
    const diagnostic = queryDiagnostic(new NativeError('query_failed', secret, { category }));
    assert.equal(diagnostic.category, category);
    assert.ok(!diagnostic.message.includes(secret));
  }
});

test('diagnostics preserve categories without exposing echoed rows, SQL, paths or credentials', () => {
  const sentinel = 'SYNTHETIC_PRIVATE_VALUE';
  for (const prefix of ['Conversion Error: Could not convert', 'Parser Error:', 'Binder Error: Referenced column not found', 'unknown failure']) {
    const diagnostic = queryDiagnostic(new Error(`${prefix} ${sentinel} /private/${sentinel} https://user:${sentinel}@example.test/?token=${sentinel}\nLINE 3: select '${sentinel}'`));
    assert.ok(!JSON.stringify(diagnostic).includes(sentinel));
  }
  assert.equal(queryDiagnostic(new Error('Parser Error: syntax\nLINE 3: secret')).line, 3);
  assert.equal(queryDiagnostic(new Error('interrupt')).category, 'cancelled');
});

test('reading notices do not expose sampled values or hostile labels', () => {
  const sentinel = 'SYNTHETIC_PRIVATE_VALUE';
  const notices = queryNotices([
    `Column "${sentinel}" was left as text: ${sentinel} is ambiguous. Set dataFileViewer.numberLocale.`,
    `${sentinel}: 2 text columns read as numbers`,
    `${sentinel}: unknown diagnostic`,
    `The edit was saved, but "${sentinel}" could not be re-read`,
  ]);
  assert.equal(notices.length, 4);
  assert.ok(!JSON.stringify(notices).includes(sentinel));
  assert.match(notices[0], /decimal convention/);
  assert.match(notices[3], /edit was saved/);
});

test('type guidance distinguishes text comparisons and raw worksheet columns', () => {
  assert.match(queryDiagnostic(new Error('Binder Error: Cannot compare values of type VARCHAR and type INTEGER_LITERAL')).message, /CAST\(column AS DATE\)/);
  assert.match(queryDiagnostic(new Error('Binder Error: Cannot compare values of type DATE and type INTEGER_LITERAL')).message, /numeric year is not a date literal/);
  assert.match(queryDiagnostic(new Error('Binder Error: Referenced column not found'), true).message, /detected table/);
});

test('an unreadable worksheet explains itself, including through a detected-table name', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DuckDbFile } = await import('../src/duckdbConnection');
  const { xlsxFile } = await import('./stress/generators/_write');
  const dir = await mkdtemp(join(tmpdir(), 'dfv-unreadable-'));
  let file: Awaited<ReturnType<typeof DuckDbFile.open>> | undefined;
  try {
    // Excel caps a cell at 32,767 characters; DuckDB refuses one this large as damaged.
    const path = await xlsxFile(join(dir, 'b.xlsx'), [
      { name: 'Bad', rows: [['id', 'v'], [1, 'a'], [], ['big'], ['x'.repeat(100_000)]] },
      { name: 'Good', rows: [['id', 'v'], [1, 'a']] },
    ]);
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    for (const sql of ['select * from "Bad"', 'select * from "Bad · Table 1"']) {
      const error: unknown = await file.runQuery(sql).then(() => undefined, (e: unknown) => e);
      assert.ok(error, sql);
      const d = queryDiagnostic(error);
      assert.equal(d.category, 'resource', `${sql}: ${String(error)}`);
      assert.match(d.message, /32,767/);
    }
    assert.equal((await file.runQuery('select count(*) from "Good · Table 1"')).rows[0][0] + '', '1');
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('typed native failures name their real cause without echoing the worker text', () => {
  const secret = 'SYNTHETIC_PRIVATE_VALUE /private/path SELECT secret';
  const e = (code: string, o: ConstructorParameters<typeof NativeError>[2] = {}) => queryDiagnostic(new NativeError(code, secret, o)).message;
  const cases: Array<[string, RegExp, ConstructorParameters<typeof NativeError>[2]?]> = [
    ['stale_source', /^The file changed on disk since it was opened\. Reopen it to continue\.$/],
    ['stale_source', /changed on disk.*Nothing was saved\. Reopen it/, { mutationOutcome: 'not-published' }],
    ['table_changed', /table changed.*Nothing was saved/, { mutationOutcome: 'not-published' }],
    ['ambiguous_row', /More than one row.*Nothing was saved/, { mutationOutcome: 'not-published' }],
    ['no_matching_row', /No row matches.*Nothing was saved/, { mutationOutcome: 'not-published' }],
    ['mutation_not_published', /did not happen/],
    ['mutation_unknown', /not confirmed.*reopen the file to check it/i, { mutationOutcome: 'unknown' }],
    ['worker_exited', /stopped while saving\. The save was not confirmed; reopen the file to check it\./, { mutationOutcome: 'unknown', host: true }],
    ['worker_timeout', /stopped responding while saving\. The save was not confirmed/, { mutationOutcome: 'unknown', host: true }],
    ['malformed_value', /The save was not confirmed/, { mutationOutcome: 'unknown', category: 'conversion' }],
    ['worker_exited', /^The table worker stopped\. Reopen/, { host: true }],
    ['worker_timeout', /^The table worker stopped responding\. Reopen/, { host: true }],
    ['worker_failed', /^The table worker failed\. Reopen/],
    ['protocol_violation', /^The table worker failed\. Reopen/, { host: true }],
    ['not_open', /document is closed/],
    ['client_closed', /document is closed/, { host: true }],
    ['read_only', /read-only/, { category: 'blocked' }],
    ['unsupported', /not available for this document/, { category: 'unsupported' }],
    ['unknown_method', /not available for this document/, { host: true }],
    ['frame_too_large', /too large for the table worker/, { host: true }],
    ['malformed_value', /value or argument was not valid/, { category: 'conversion' }],
    ['resource_limit', /resource limit/, { category: 'resource' }],
    ['cancelled', /^Query cancelled\.$/, { category: 'cancelled' }],
    ['policy_refused', /^This operation is unavailable for this document or its access settings\.$/, { category: 'blocked' }],
  ];
  for (const [code, pattern, o] of cases) {
    const message = e(code, o);
    assert.match(message, pattern, `${code} ${JSON.stringify(o)}`);
    assert.doesNotMatch(message, /could not be completed/, code);
    assert.ok(!/SYNTHETIC|private|SELECT/.test(message), `${code} leaked`);
    if (o?.mutationOutcome === 'unknown') assert.doesNotMatch(message, /nothing was saved|retried|was saved\b/i, code);
  }
  assert.match(queryDiagnostic(new NativeError('malformed_value', secret, { category: 'conversion' }), false, true).message, /read as dates.*ISO date/);
});
