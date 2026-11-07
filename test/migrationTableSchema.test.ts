// D1.9: versioned table wire schemas, exact-value codec and boundary fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as ts from 'typescript';
import { decodeValue, decodeWireText, describe as describeValue, encodeValue, ExactValueError } from './migration/exactValues';
import { SchemaSet } from './migration/schemaSubset';
import { NativeTableClient, NativeError } from '../src/backend/native';
import { QUERY_LIMITS } from '../src/queryPolicy';
import { READ_METHODS } from '../src/queryProtocol';

const root = process.cwd();
const dir = join(root, 'test/migration');
const schemas = new SchemaSet(join(dir, 'schema'));
const values = JSON.parse(readFileSync(join(dir, 'fixtures/table-values.v1.json'), 'utf8'));
const documents = JSON.parse(readFileSync(join(dir, 'fixtures/table-documents.v1.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(join(dir, 'table-operations.json'), 'utf8'));
const BASE = 'https://data-file-viewer.invalid/schema/table/v1/';
const REQUIRED = ['common', 'envelope', 'capabilities', 'source-identity', 'read-metadata', 'paged-resource', 'mutation-receipt', 'error', 'query-range'];
// Full suites set both: lifecycle fault tests use DFV_TABLE_WORKER; framing uses the default production build.
const worker = process.env.DFV_TABLE_PRODUCTION_WORKER ?? process.env.DFV_TABLE_WORKER;
const native = { skip: worker && existsSync(worker) ? false : 'Set DFV_TABLE_WORKER to the built table worker.' };

test('D3.1: reviewed framing schema closure matches its frozen hashes', () => {
  const manifest = JSON.parse(readFileSync(join(dir, 'framing-v1-manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.max_frame_bytes, 33554432);
  assert.deepEqual([...manifest.primary_schemas].sort(), ['capabilities', 'common', 'envelope', 'error'].map(n => `${n}.v1.schema.json`));
  for (const [name, hash] of Object.entries(manifest.schema_sha256)) {
    assert.equal(createHash('sha256').update(readFileSync(join(dir, 'schema', name))).digest('hex'), hash, name);
  }
});

test('D1.9: schema set is versioned, complete and closed (no external refs)', () => {
  assert.deepEqual([...schemas.documents.keys()].sort(), REQUIRED.map(n => `${n}.v1.schema.json`).sort());
  for (const [name, doc] of schemas.documents) {
    assert.equal(doc.$id, BASE + name, name);
    assert.equal(doc['x-dfv-version'], 1, name);
    assert.equal(doc.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
  }
  assert.ok(schemas.checkClosed().length > 20);
});

test('D1.9: valid boundary values pass the schema, decode as expected and round-trip canonically', () => {
  for (const fixture of values.valid) {
    assert.deepEqual(schemas.validate(fixture.wire, 'common.v1.schema.json', '/$defs/value'), [], fixture.name);
    const decoded = decodeValue(fixture.wire);
    assert.deepEqual(describeValue(decoded), fixture.expect, fixture.name);
    assert.deepEqual(encodeValue(decoded), fixture.wire, `${fixture.name}: canonical re-encode`);
    assert.deepEqual(describeValue(decodeWireText(JSON.stringify(fixture.wire))), fixture.expect, `${fixture.name}: via JSON text`);
  }
});

test('D1.9: malformed values are refused by the decoder with a typed code; schema gaps are explicit', () => {
  for (const fixture of values.invalid) {
    assert.throws(() => decodeValue(fixture.wire), (e: unknown) => e instanceof ExactValueError && e.code === fixture.code, fixture.name);
    const errors = schemas.validate(fixture.wire, 'common.v1.schema.json', '/$defs/value');
    // schema_rejects:false = only the decoder can see it (range, scale, duplicates).
    assert.equal(errors.length > 0, fixture.schema_rejects, `${fixture.name}: schema ${fixture.schema_rejects ? 'should reject' : 'cannot express this check'}`);
  }
});

test('D1.9: exact scalars never pass through Number, parseInt or parseFloat', () => {
  const calls: string[] = [];
  const realNumber = Number, realParseInt = parseInt, realParseFloat = parseFloat;
  const g = globalThis as Record<string, unknown>;
  const decodeAll = (fixtures: { wire: unknown }[]) => fixtures.map(f => decodeValue(f.wire));
  const containsFloat = (wire: unknown): boolean => JSON.stringify(wire).includes('"$t":"float');
  g.Number = new Proxy(realNumber, { apply: (t, self, args) => { calls.push('Number'); return Reflect.apply(t, self, args); } });
  g.parseInt = (...a: Parameters<typeof parseInt>) => { calls.push('parseInt'); return realParseInt(...a); };
  g.parseFloat = (...a: Parameters<typeof parseFloat>) => { calls.push('parseFloat'); return realParseFloat(...a); };
  let exactCalls: string[], floatCalls: string[];
  try {
    decodeAll(values.valid.filter((f: { wire: unknown }) => !containsFloat(f.wire)));
    exactCalls = calls.splice(0);
    decodeAll(values.valid.filter((f: { wire: unknown }) => containsFloat(f.wire)));
    floatCalls = calls.splice(0);
  } finally {
    g.Number = realNumber; g.parseInt = realParseInt; g.parseFloat = realParseFloat;
  }
  assert.deepEqual(exactCalls, [], 'an exact scalar reached a JS number conversion');
  assert.ok(floatCalls.length > 0, 'spy must observe the explicit float path (proves the spy works)');

  // Static: number conversions appear only inside decodeFloat.
  const source = ts.createSourceFile('exactValues.ts', readFileSync(join(dir, 'exactValues.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const offenders: string[] = [];
  const visit = (node: ts.Node, fn: string | undefined) => {
    const name = ts.isFunctionDeclaration(node) ? node.name?.text : fn;
    const conversion = (ts.isCallExpression(node) && /^(Number|parseInt|parseFloat|Number\.parse(Int|Float))$/.test(node.expression.getText())) ||
      (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken);
    if (conversion && name !== 'decodeFloat') offenders.push(`${name}: ${node.getText()}`);
    node.forEachChild(child => visit(child, name));
  };
  visit(source, undefined);
  assert.deepEqual(offenders, []);
});

test('D1.9: values above 2^53, -0, NaN, null and text stay distinct and exact', () => {
  const big = decodeValue({ $t: 'int64', v: '9007199254740993' });
  assert.equal(big.kind === 'int64' && big.value, 9007199254740993n);
  assert.notEqual(String(Number('9007199254740993')), '9007199254740993', 'the hazard the encoding avoids');
  const negZero = decodeValue({ $t: 'float64', v: '-0' });
  assert.ok(negZero.kind === 'float64' && Object.is(negZero.value, -0));
  assert.deepEqual(encodeValue(negZero), { $t: 'float64', v: '-0' });
  const kinds = [null, { $t: 'float64', v: 'NaN' }, 'NaN', '', false, { $t: 'int64', v: '0' }, { $t: 'float64', v: '0' }, { $t: 'float64', v: '-0' }]
    .map(w => JSON.stringify(describeValue(decodeValue(w))));
  assert.equal(new Set(kinds).size, kinds.length);
});

test('D1.9: column descriptors, including dictionary metadata', () => {
  for (const fixture of values.columns) {
    const errors = schemas.validate(fixture.column, 'common.v1.schema.json', '/$defs/column');
    assert.equal(errors.length === 0, fixture.valid, `${fixture.name}: ${errors.join('; ')}`);
    for (const row of fixture.rows ?? []) {
      const decoded = decodeValue(row);
      const id = fixture.column.type.id;
      assert.ok(decoded.kind === 'null' || decoded.kind === id, `${fixture.name}: row kind ${decoded.kind} vs ${id}`);
    }
  }
});

test('D1.9: envelope, capabilities, identity, metadata, page, receipt and error documents', () => {
  const covered = new Set<string>();
  for (const fixture of documents.documents) {
    const errors = schemas.validate(fixture.document, fixture.schema);
    assert.equal(errors.length === 0, fixture.valid, `${fixture.schema} ${fixture.name}: ${errors.join('; ')}`);
    if (fixture.valid) covered.add(fixture.schema);
    // Every cell of a valid page decodes with the reference codec too.
    if (fixture.valid && fixture.schema === 'paged-resource.v1.schema.json') {
      for (const row of fixture.document.rows) for (const cell of row) decodeValue(cell);
    }
  }
  assert.deepEqual([...covered].sort(), REQUIRED.filter(n => n !== 'common').map(n => `${n}.v1.schema.json`).sort());
});

test('D1.9: schemas agree with the D1.8 inventory', () => {
  const error = schemas.documents.get('error.v1.schema.json') as any;
  assert.deepEqual([...error.properties.category.enum].sort(), inventory.error_categories);

  // Every ReadMetadata field has a wire field (camelCase -> snake_case; stamp -> source identity).
  const meta = schemas.documents.get('read-metadata.v1.schema.json') as any;
  const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
  for (const field of inventory.read_metadata.fields) {
    const wire = field.name === 'stamp' ? 'source' : snake(field.name);
    assert.ok(wire in meta.properties, `ReadMetadata.${field.name} has no wire field ${wire}`);
    assert.equal(meta.required.includes(wire), !field.optional, `${field.name}: optionality`);
  }

  // Request args are named after the inventory's argument names; callbacks never cross.
  const ops = new Map<string, any>(inventory.operations.map((op: any) => [op.name, op]));
  for (const fixture of documents.documents.filter((d: any) => d.valid && d.document.kind === 'request')) {
    const op = ops.get(fixture.document.method);
    assert.ok(op, fixture.document.method);
    const names = op.arguments.filter((a: any) => a.serializable).map((a: any) => a.name);
    for (const key of Object.keys(fixture.document.args)) assert.ok(names.includes(key), `${op.id}: unknown arg ${key}`);
  }

  // Capability limits mirror QUERY_LIMITS.
  const caps = schemas.documents.get('capabilities.v1.schema.json') as any;
  for (const key of ['sqlBytes', 'resultBytes', 'cellBytes', 'queuedRequests', 'deadlineMs']) {
    assert.ok(key in inventory.limits && snake(key) in caps.properties.limits.properties, key);
  }
});

test('D1.9: preparation status and metrics have valid and refused boundary fixtures', () => {
  const base = documents.documents.find((d: any) => d.valid && d.schema === 'read-metadata.v1.schema.json').document;
  const metadata = {
    ...base,
    sheet_preparation: ['pending', 'ready', 'none', 'disabled', 'incomplete', 'bounded', 'cancelled', 'failed'].map(state => ({
      sheet: 'Raw_Data', state, generation: 1, tables: 0, skipped: 0, retryable: state === 'failed',
    })),
    preparation_metrics: {
      phases: { detection: { count: 1, total_ms: 1.5, max_ms: 1.5, last_ms: 1.5 } },
      detector_calls: 1, grid_cells: '9007199254740993', grid_decoded_bytes: '18014398509481986',
      cached_cells: '0', cached_objects: 0, cache_max_cells: '1000000', cache_estimated_bytes: '0', cache_evictions: 0, cache_restores: 0,
      cache_max_bytes: '67108864', cache_accounting: 'decoded-payload-v1',
    },
  };
  assert.deepEqual(schemas.validate(metadata, 'read-metadata.v1.schema.json'), []);
  for (const mutate of [
    (m: any) => { m.sheet_preparation[0].state = 'success'; },
    (m: any) => { m.sheet_preparation[0].generation = -1; },
    (m: any) => { m.preparation_metrics.grid_cells = 9007199254740992; },
    (m: any) => { m.preparation_metrics.phases.detection.count = 0.5; },
    (m: any) => { m.preparation_metrics.phases.detection.total_ms = -1; },
    (m: any) => { m.preparation_metrics.cache_max_bytes = 67108864; },
    (m: any) => { m.preparation_metrics.cache_accounting = 'rss'; },
  ]) {
    const invalid = structuredClone(metadata); mutate(invalid);
    assert.ok(schemas.validate(invalid, 'read-metadata.v1.schema.json').length > 0);
  }
});

test('D3.1: real stdio handshake, requests and refusals conform to the v1 framing schemas', native, () => {
  const request = { protocol: 'dfv-table', version: 1, kind: 'request', id: '1', method: 'ping', args: {} };
  assert.deepEqual(schemas.validate(request, 'envelope.v1.schema.json'), []);
  const inputs = [request, { ...request, id: '2', version: 2 }, { ...request, id: '3', args: [] }, { ...request, id: '4', method: 'missingMethod' }];
  const result = spawnSync(worker!, ['--stdio'], {
    input: inputs.map(r => JSON.stringify(r)).join('\n') + '\n{broken\n', encoding: 'utf8', timeout: 5000,
    env: { ...process.env, DFV_TABLE_TEST_DOC: '0' },
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.split('\n').filter(Boolean).every(line => line.startsWith('table_worker:')));
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 6);
  const caps = frames[0];
  assert.deepEqual(schemas.validate(caps, 'capabilities.v1.schema.json'), []);
  assert.equal(caps.engine.name, 'dfv-table');
  assert.deepEqual([...caps.methods].sort(), ['ping', 'open', 'close', ...READ_METHODS, 'readResource', 'releaseResource',
    'createBackup', 'setSafeMode', 'updateCell', 'queryMutationOutcome'].sort());
  const formats = { csv: 'table_rewrite', parquet: 'table_rewrite', duckdb: 'transactional', sqlite: 'transactional',
    xlsx: 'cell_patch', arrow: 'table_rewrite', feather: 'table_rewrite', dta: 'none', kdb: 'none' };
  assert.deepEqual(caps.formats.map((format: any) => format.file_kind).sort(), Object.keys(formats).sort());
  for (const format of caps.formats) {
    assert.equal(format.read, true);
    assert.equal(format.write, formats[format.file_kind as keyof typeof formats]);
    assert.equal(format.backup, format.write !== 'none');
  }
  assert.deepEqual(caps.limits, {
    max_frame_bytes: '33554432', sql_bytes: String(QUERY_LIMITS.sqlBytes), result_bytes: String(QUERY_LIMITS.resultBytes),
    cell_bytes: String(QUERY_LIMITS.cellBytes), queued_requests: String(QUERY_LIMITS.queuedRequests), deadline_ms: String(QUERY_LIMITS.deadlineMs),
  });
  const replies = new Map(frames.slice(1).map(frame => {
    assert.deepEqual(schemas.validate(frame, 'envelope.v1.schema.json'), [], JSON.stringify(frame));
    return [frame.id, frame];
  }));
  assert.equal(replies.get('1')?.ok, true);
  for (const [id, code] of [['0', 'malformed_request'], ['2', 'unsupported'], ['3', 'malformed_request'], ['4', 'unknown_method']]) {
    assert.equal(replies.get(id)?.error.code, code);
    assert.deepEqual(schemas.validate(replies.get(id)?.error, 'error.v1.schema.json'), []);
  }
});

test('D3.1: the host decoder accepts the same production handshake and typed refusal', native, async () => {
  const client = await NativeTableClient.start({ executable: worker!, env: { DFV_TABLE_TEST_DOC: '0' } });
  try {
    assert.equal(client.capabilities.engine.name, 'dfv-table');
    assert.equal(client.capabilities.limits.max_frame_bytes, 33554432);
    assert.deepEqual(await client.call('ping'), {});
    await assert.rejects(client.call('open', { path: 3 }), (error: unknown) =>
      error instanceof NativeError && error.code === 'malformed_value' && !error.host);
    assert.ok(client.alive);
  } finally { await client.close(); }
});
