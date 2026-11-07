// Scripted stand-in for dfv-table used by nativeBackend tests to produce the failures a healthy worker never does.
const mode = process.argv[2];
if (process.env.DFV_FAKE_START_LOG) require('node:fs').appendFileSync(process.env.DFV_FAKE_START_LOG, String(process.pid) + '\n');
const frame = o => process.stdout.write(JSON.stringify(o) + '\n');
const READS = ['listTables', 'listSidebarTables', 'listSiblingTables', 'getCombinableTableNames', 'buildCombinedQuery', 'getPollCadenceSeconds', 'getSeriesFrequency', 'buildDetectedTableQuery', 'runDetectedTableQuery', 'runQuery', 'runChartQuery', 'runSortedQuery', 'countMatchingRows', 'checkEditableSelect', 'getColumnTopValues', 'getColumnDescriptiveStats', 'compareToBackup', 'diffQueryAgainstBackup', 'getQueryCatalog', 'getQueryColumns', 'locateXlsxEdit', 'retrySheetPreparation'];
const ENGINE = ['open', 'close', 'readResource', 'releaseResource', 'setSafeMode', 'createBackup', 'updateCell', ...READS, ...(process.env.DFV_FAKE_NO_OUTCOME ? [] : ['queryMutationOutcome'])];
const caps = { protocol: 'dfv-table', version: 1, kind: 'capabilities', engine: { name: 'fake', version: '0' }, methods: mode === 'engine' ? ['ping', ...(process.env.DFV_FAKE_METHODS ? process.env.DFV_FAKE_METHODS.split(',') : ENGINE)] : ['ping', 'work'], formats: [], value_tags: [], time_units: [],
  limits: { max_frame_bytes: '1048576', queued_requests: mode === 'slow' ? '2' : '8', deadline_ms: '30000' } };
if (mode === 'badcaps') caps.protocol = 'other';
if (mode === 'badlimits') caps.limits.max_frame_bytes = '0';
if (mode === 'badengine') delete caps.engine;
if (mode === 'badmethods') caps.methods.push('work');
if (mode !== 'nocaps') frame(caps);
const ok = (id, result) => frame({ protocol: 'dfv-table', version: 1, kind: 'response', id, ok: true, result });
const bad = (id, error) => frame({ protocol: 'dfv-table', version: 1, kind: 'response', id, ok: false, error });
let inflight = 0, peak = 0, buf = '';
let sourceRevision = '1';
const held = new Map();
const fs = require('node:fs');
const col = (name, stats_kind = 'other') => ({ name, type: { id: 'int64' }, stats_kind });
const i64 = v => ({ $t: 'int64', v: String(v) });
const pageOf = (extra = {}) => ({ resource: { id: 'r1', source_revision: '1' }, columns: [col('id', 'numeric'), col('name')], rows: [[i64(9007199254740993n), 'a'], [i64(2), null]],
  page: { offset: '0', row_count: '2', total_rows: '7', next_offset: null, truncated: false }, ...extra });
// A scripted engine for the document layer: plausible shapes for every operation, and a journal that survives a restart.
function engine(m) {
  const a = m.args, log = process.env.DFV_FAKE_STATE;
  if (process.env.DFV_FAKE_WIRE) fs.appendFileSync(process.env.DFV_FAKE_WIRE, JSON.stringify({ method: m.method, args: m.args }) + '\n');
  if (process.env.DFV_FAKE_REFUSE && m.method !== 'open' && m.method !== 'close') return bad(m.id, { code: 'refused_by_test', category: 'blocked', message: 'refused ' + m.method, retryable: false, mutation_outcome: ['updateCell', 'createBackup', 'setSafeMode'].includes(m.method) ? 'not-published' : null });
  if (process.env.DFV_FAKE_CHECK_REVISION && ['updateCell', 'createBackup', 'setSafeMode'].includes(m.method) && a.expected_revision !== sourceRevision) return bad(m.id, { code: 'stale_source', category: 'conversion', message: 'stale revision', retryable: false, mutation_outcome: 'not-published' });
  const note = line => log && fs.appendFileSync(log, line + '\n');
  switch (m.method) {
    case 'open': return ok(m.id, { session: 's' + process.pid, file_kind: 'xlsx', read_only: false, read_only_by_format: false, has_sibling: true, has_pending_sheets: false, worksheets: ['Sheet1'],
      open_warnings: [], number_locale: null, source_revision: '1',
      detected_tables: [{ name: 'T1', sheet: 'Sheet1', top: 0, bottom: 3, left: 0, right: 2, header_row: 0, columns: ['id', 'name'], column_stats_kind: ['numeric', 'other'], data_rows: [{ start: 1, end: 3 }], excluded_rows: [], row_count: '2' }],
      sheet_preparation: [{ sheet: 'Sheet1', state: 'ready', generation: 0, tables: 1, skipped: 0, retryable: false }] });
    case 'close': return ok(m.id, { closed: true, released: 0 });
    case 'listTables': case 'listSidebarTables': case 'listSiblingTables': case 'getCombinableTableNames': return ok(m.id, { names: [m.method] });
    case 'getQueryCatalog': return ok(m.id, { relations: [{ catalog: 'c', schema: 's', name: 'Sheet1', sql_name: '"Sheet1"' }, { catalog: 'c', schema: 's', name: 'T1', sql_name: '"T1"' }], next_offset: null });
    case 'getQueryColumns': return ok(m.id, { columns: [{ name: 'id', source_type: 'BIGINT' }] });
    case 'buildCombinedQuery': return ok(m.id, { sql: 'select 1 /*' + a.limit_n + '*/', time_column: null });
    case 'getPollCadenceSeconds': return ok(m.id, { seconds: process.env.DFV_FAKE_SECONDS ? JSON.parse(process.env.DFV_FAKE_SECONDS) : 60 });
    case 'getSeriesFrequency': return ok(m.id, { frequency: 'monthly' });
    case 'buildDetectedTableQuery': return ok(m.id, { sql: 'select * from T1 /*' + JSON.stringify(a.filters) + (a.limit ?? '') + '*/' });
    case 'runDetectedTableQuery': return ok(m.id, pageOf({ sql: 'select * from T1' }));
    case 'runQuery': return ok(m.id, pageOf(process.env.DFV_FAKE_PAGE_DRIFT ? { rows: [[i64(1), 'a']], page: { offset: '0', row_count: '1', total_rows: '2', next_offset: '1', truncated: false } } : {}));
    case 'runSortedQuery': return ok(m.id, pageOf({ sql: 'sorted ' + a.direction }));
    case 'runChartQuery': return ok(m.id, { x_axis_mode: a.x_is_row ? 'category' : 'time', result: pageOf(), ...(a.x_as_date ? { note: '1 row with no date left out' } : {}), seen: a });
    case 'readResource': return ok(m.id, pageOf(process.env.DFV_FAKE_PAGE_DRIFT ? { resource: { id: 'r1', source_revision: '2' }, rows: [[i64(2), 'b']] } : {}));
    case 'releaseResource': return ok(m.id, { released: true });
    case 'countMatchingRows': return ok(m.id, { count: a.sql === 'none' ? null : '7' });
    case 'checkEditableSelect': return ok(m.id, { editable: true, table: 'T1', columns: ['id', 'name'] });
    case 'getColumnTopValues': return ok(m.id, { total_rows: '3', non_null_rows: '2', null_count: '1', distinct_count: '2', top_values: [{ value: i64(9007199254740993n), frequency: '2' }] });
    case 'getColumnDescriptiveStats': return ok(m.id, { total_rows: '3', non_null_rows: '2', null_count: '1', min: i64(1), max: i64(9007199254740993n), mean: { $t: 'float64', v: '1.5' }, p5: null, p95: null });
    case 'compareToBackup': return ok(m.id, { tables: { T1: 'changed' } });
    case 'diffQueryAgainstBackup': return ok(m.id, { diff: a.sql === 'same' ? null : { cell_changed: [[true]], row_is_new: [false], renamed_columns: {}, seen: a.live_rows } });
    case 'locateXlsxEdit': return ok(m.id, { target: { sheet_path: 'xl/worksheets/sheet1.xml', column_names: ['id'], row_ordinal: process.env.DFV_FAKE_ROW_ORDINAL ?? '3', column_name: 'id' }, sha256: 'a'.repeat(64) });
    case 'retrySheetPreparation': {
      const status = { sheet: a.sheet, state: 'ready', generation: 1, tables: 1, skipped: 0, retryable: false };
      return ok(m.id, { status, detected_tables: [{ name: 'T2', sheet: a.sheet, columns: ['new'], row_count: '3' }, { name: 'Unchanged', sheet: 'Other', columns: ['id'], row_count: '2' }],
        sheet_preparation: [status, { sheet: 'Other', state: 'pending', generation: 0, tables: 0, skipped: 0, retryable: false }],
        has_pending_sheets: process.env.DFV_FAKE_BAD_RETRY ? 'false' : true });
    }
    case 'setSafeMode': return process.env.DFV_FAKE_SAFE_REFUSE ? bad(m.id, { code: 'policy_refused', category: 'blocked', message: 'Safe Mode remains on.', retryable: false, mutation_outcome: 'not-published' }) : ok(m.id, { enabled: a.enabled });
    case 'createBackup': return ok(m.id, { operation: 'createBackup', outcome: 'published', rows_changed: '0', backup_path: '/tmp/x.bak', notices: [] });
    case 'updateCell': {
      note('send ' + a.mutation_id);
      sourceRevision = String(BigInt(sourceRevision) + 1n);
      const receipt = { operation: 'updateCell', outcome: 'published', rows_changed: '1', notices: ['saved'], source_after: { revision: sourceRevision } };
      if (process.env.DFV_FAKE_UPDATE === 'publish-then-die') { note('published ' + a.mutation_id); process.exit(1); }
      if (process.env.DFV_FAKE_UPDATE === 'die-first') process.exit(1);
      if (process.env.DFV_FAKE_BAD_RECEIPT) { note('published ' + a.mutation_id); return ok(m.id, { ...receipt, rows_changed: 'not a count' }); }
      return ok(m.id, receipt);
    }
    case 'queryMutationOutcome': {
      const done = log && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('published ' + a.mutation_id);
      return ok(m.id, done ? { outcome: 'published', receipt: { operation: 'updateCell', outcome: 'published', rows_changed: '1', notices: [], source_after: { revision: '2' } } } : { outcome: 'not-published' });
    }
    default: return bad(m.id, { code: 'unknown_method', category: 'syntax', message: 'no', retryable: false, mutation_outcome: null });
  }
}
process.stdin.on('data', chunk => {
  buf += chunk;
  for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (m.kind === 'cancel' && held.has(m.id) && !process.env.DFV_FAKE_IGNORE_CANCEL) {
      clearTimeout(held.get(m.id)); held.delete(m.id);
      bad(m.id, { code: 'cancelled', category: 'cancelled', message: 'stopped', retryable: false, mutation_outcome: null });
    }
    if (m.kind !== 'request') continue;
    switch (mode) {
      case 'engine': engine(m); break;
      case 'hang': break;
      case 'duplicate': ok(m.id, { n: 1 }); ok(m.id, { n: 2 }); break;
      case 'eofmid': process.stdout.write('{"protocol":"dfv-table","version":1,"kind":"respo', () => process.exit(0)); break;
      case 'hold': held.set(m.id, setTimeout(() => { held.delete(m.id); ok(m.id, { held: true }); }, +(m.args.ms ?? 100))); break;
      case 'invalidresponse': frame({ protocol: 'dfv-table', version: 1, kind: 'response', id: m.id, ok: true }); break;
      case 'invaliderror': bad(m.id, { code: 'unknown', category: 'unknown', message: 'bad', retryable: false, mutation_outcome: 'invalid' }); break;
      case 'bothresponse': frame({ protocol: 'dfv-table', version: 1, kind: 'response', id: m.id, ok: true, result: {}, error: {} }); break;
      case 'garbage': process.stdout.write('this is not json\n'); break;
      case 'oversize': process.stdout.write('x'.repeat(2 * 1048576) + '\n'); break;
      case 'unattributed': bad('0', { code: 'malformed_request', category: 'syntax', message: 'no', retryable: false, mutation_outcome: null }); break;
      case 'die': process.exit(1); break;
      case 'queue_full': bad(m.id, { code: 'queue_full', category: 'resource', message: 'full', retryable: true, mutation_outcome: null }); break;
      case 'mutation_unknown': bad(m.id, { code: 'mutation_unknown', category: 'unknown', message: 'unsure', retryable: false, mutation_outcome: 'unknown' }); break;
      case 'slow': inflight++; peak = Math.max(peak, inflight); setTimeout(() => { inflight--; ok(m.id, { peak }); }, 40); break;
      default: ok(m.id, { echo: m.args });
    }
  }
});
process.stdin.on('end', () => mode === 'delayedExit' ? setTimeout(() => process.exit(0), 150) : process.exit(0));
