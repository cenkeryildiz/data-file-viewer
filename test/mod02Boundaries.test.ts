import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';

import { DuckDbFile } from '../src/duckdbConnection';
import { createDataController, type ExtensionMessage } from '../src/features/data';
import { xlsxFile } from './stress/generators/_write';

/*
 * MOD-02 boundaries. The data-view feature (src/features/data) and the Excel
 * backend modules (src/backend/excel) are reachable only through declared
 * entrypoints, import no host/PDF code or reference implementation, and form
 * no import cycles. Two documents never share selection or preparation state.
 */

const SRC = resolve('src');

type Graph = Map<string, string[]>;

function specifiersOf(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function walk(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, walk);
  }
  walk(source);
  return found;
}

/** Resolve a relative specifier to a .ts file (`x.ts` or `x/index.ts`); bare specifiers stay as written. */
function resolveSpecifier(from: string, specifier: string, exists: (path: string) => boolean): string {
  if (!specifier.startsWith('.')) return specifier;
  const base = resolve(dirname(from), specifier);
  if (exists(`${base}.ts`)) return `${base}.ts`;
  if (exists(join(base, 'index.ts'))) return join(base, 'index.ts');
  return `${base}.ts`;
}

function buildGraph(files: Map<string, string>): Graph {
  const graph: Graph = new Map();
  for (const [file, text] of files) {
    graph.set(file, specifiersOf(file, text).map((s) => resolveSpecifier(file, s, (p) => files.has(p))));
  }
  return graph;
}

function findCycles(graph: Graph, roots: readonly string[]): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  function visit(file: string): void {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'open') { cycles.push([...stack.slice(stack.indexOf(file)), file]); return; }
    state.set(file, 'open'); stack.push(file);
    for (const next of graph.get(file) ?? []) if (graph.has(next)) visit(next);
    stack.pop(); state.set(file, 'done');
  }
  for (const root of roots) visit(root);
  return cycles;
}

interface Rules { featureRoot: string; excelRoot: string; allowedFeatureShims: readonly string[] }

/** Every boundary violation in `graph`; empty means the layout is clean. */
function violations(graph: Graph, rules: Rules): string[] {
  const out: string[] = [];
  const inside = (file: string, root: string) => file.startsWith(root + sep);
  const featureIndex = join(rules.featureRoot, 'index.ts');
  const forbiddenForModules = /(^vscode(?:\/|$)|pdf|[\\/](?:duckdbConnection|viewerFile|duckdbEditorProvider|extension|queryWorker|chartPanel)\.ts$|[\\/]backend[\\/](?:reference|session)\.ts$)/i;
  for (const [file, deps] of graph) {
    const inFeature = inside(file, rules.featureRoot);
    const inExcel = inside(file, rules.excelRoot);
    for (const dep of deps) {
      if ((inFeature || inExcel) && forbiddenForModules.test(dep)) out.push(`${file} -> ${dep}: host, PDF or reference implementation`);
      if (inFeature && inside(dep, dirname(rules.featureRoot)) && !inside(dep, rules.featureRoot)) out.push(`${file} -> ${dep}: feature-to-feature import`);
      if (inExcel && inside(dep, dirname(rules.featureRoot))) out.push(`${file} -> ${dep}: backend imports a UI feature`);
      if (!inFeature && inside(dep, rules.featureRoot) && dep !== featureIndex && !rules.allowedFeatureShims.includes(file)) {
        out.push(`${file} -> ${dep}: deep import past the feature entrypoint`);
      }
    }
  }
  const roots = [...graph.keys()].filter((f) => inside(f, rules.featureRoot) || inside(f, rules.excelRoot));
  for (const cycle of findCycles(graph, roots)) out.push(`cycle: ${cycle.join(' -> ')}`);
  return out;
}

function sourceFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules' && name !== '_evidence' && name !== 'fixtures') walk(path); }
      else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) files.set(path, readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return files;
}

const RULES: Rules = {
  featureRoot: join(SRC, 'features', 'data'),
  excelRoot: join(SRC, 'backend', 'excel'),
  allowedFeatureShims: [join(SRC, 'webviewState.ts')],
};

test('MOD-02: feature and Excel backend modules respect import boundaries and have no cycles', () => {
  const files = sourceFiles(SRC);
  for (const [path, text] of sourceFiles(resolve('test'))) files.set(path, text);
  for (const required of ['controller.ts', 'worksheetSelection.ts', 'queryPicker.ts', 'index.ts']) {
    assert.ok(files.has(join(RULES.featureRoot, required)), `features/data/${required} exists`);
  }
  for (const required of ['prepare.ts', 'detect.ts', 'sourceMap.ts']) {
    assert.ok(files.has(join(RULES.excelRoot, required)), `backend/excel/${required} exists`);
  }
  assert.deepEqual(violations(buildGraph(files), RULES), []);
  // The webview bundle reaches the feature only through its entrypoint.
  const webviewDeps = buildGraph(files).get(join(SRC, 'webview.ts')) ?? [];
  assert.ok(webviewDeps.includes(join(RULES.featureRoot, 'index.ts')));
});

test('MOD-02: the boundary checker rejects each kind of violation it guards', () => {
  const f = (p: string) => join(SRC, p);
  const synthetic = new Map<string, string>([
    [f('features/data/index.ts'), "export * from './controller';"],
    [f('features/data/controller.ts'), "import './queryPicker'; import 'vscode'; import '../../duckdbConnection'; import '../charts/index';"],
    [f('features/data/queryPicker.ts'), "import './controller';"],
    [f('features/charts/index.ts'), ''],
    [f('backend/excel/detect.ts'), "import '../../features/data/index'; import '../reference';"],
    [f('webview.ts'), "import './features/data/queryPicker';"],
    [f('duckdbConnection.ts'), ''],
    [f('backend/reference.ts'), ''],
  ]);
  const found = violations(buildGraph(synthetic), RULES).join('\n');
  for (const expected of ['host, PDF or reference implementation', 'feature-to-feature import', 'backend imports a UI feature', 'deep import past the feature entrypoint', 'cycle:']) {
    assert.ok(found.includes(expected), `checker reports "${expected}":\n${found}`);
  }
});

test('MOD-02: two document controllers never share selection, picker or transport state', () => {
  const sentA: any[] = [];
  const sentB: any[] = [];
  const a = createDataController({ postMessage: (m) => sentA.push(m) });
  const b = createDataController({ postMessage: (m) => sentB.push(m) });

  const catalogA = a.post({ command: 'queryCatalog', cursor: 0 });
  a.choose('A1');
  b.choose('B1');
  b.choose('B2');
  assert.equal(a.state.selection.sheet, 'A1');
  assert.equal(a.state.selection.seq, 1);
  assert.equal(b.state.selection.sheet, 'B2');
  assert.equal(b.state.selection.seq, 2);
  assert.notEqual(a.state.selection, b.state.selection);

  const target = (id: string, generation: number) => ({ id, generation, catalog: 'c', schema: 'main', name: id, sqlName: `"${id}"`, rawWorksheet: true, worksheet: id, prepared: true });
  assert.equal(a.picker.acceptCatalog({ command: 'queryCatalog', targets: [target('A1', 3)], generation: 3, cursor: 0, requestId: catalogA } as any), 'reset');
  assert.equal(a.picker.generation, 3);
  assert.equal(b.picker.generation, 0, 'a catalog accepted by one document leaves the other untouched');
  assert.equal(b.picker.targets.size, 0);
  // A reply carrying the other document's request id is not this document's reply.
  assert.equal(b.picker.acceptCatalog({ command: 'queryCatalog', targets: [target('X', 9)], generation: 9, cursor: 0, requestId: catalogA } as any), 'ignored');

  const before = sentB.length;
  const fx = a.receive({ command: 'error', message: 'boom' } as ExtensionMessage);
  assert.ok(Array.isArray(fx));
  assert.equal(sentB.length, before, 'one document never posts through another document\'s host channel');
  assert.ok(sentA.every((m) => m.generation === 0 || m.generation === 3));
  assert.deepEqual(sentB.map((m) => m.requestId), [], 'choosing does not post; the view dispatches previews');
});

test('EX-03: delayed picker replies belong to the exact worksheet choice, including A→B→A', () => {
  for (const command of ['queryTarget', 'queryTargetSql', 'sheetTableSql']) {
    const data = createDataController({ postMessage() {} });
    const target = { id: 'a', generation: 0, catalog: 'c', schema: 'main', name: 'A', sqlName: '"A"', rawWorksheet: true, worksheet: 'A', prepared: true };
    const details = { target, columns: [{ name: 'value', type: 'INTEGER' }] };
    assert.equal(data.picker.acceptDetails(details, data.state.selection.seq), false, 'unsolicited reply');
    assert.equal(data.picker.acceptSqlDraft({ target }, 'draft', data.state.selection.seq), 'ignored');
    data.choose('A');
    const requestId = data.post({ command, targetId: target.id });
    data.choose('B');
    for (const sheet of ['B', 'A']) {
      if (sheet === 'A') data.choose('A');
      assert.equal(data.picker.acceptDetails({ ...details, requestId }, data.state.selection.seq), false);
      assert.equal(data.picker.acceptSqlDraft({ target, requestId }, 'draft', data.state.selection.seq), 'ignored');
      assert.equal(data.picker.selected, undefined);
      assert.equal(data.picker.targets.size, 0);
      assert.equal(data.picker.columns.size, 0);
      assert.equal(data.picker.hasDrafts, false);
    }
    const fresh = data.post({ command, targetId: target.id });
    assert.equal(data.picker.acceptDetails({ ...details, requestId: fresh, target: { ...target, generation: 1 } }, data.state.selection.seq), false, 'unknown generation');
    assert.equal(data.picker.acceptDetails({ ...details, requestId: fresh }, data.state.selection.seq), true);
    assert.equal(data.picker.acceptSqlDraft({ target, requestId: fresh }, 'draft', data.state.selection.seq), 'accepted');
    assert.equal(data.picker.restoreDraft(), 'draft');
  }
});

test('MOD-02: two documents over one workbook prepare sheets and cache detected tables independently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mod02-'));
  try {
    const path = await xlsxFile(join(dir, 'book.xlsx'), [
      { name: 'A', rows: [['id', 'v'], [1, 2], [3, 4]] },
      { name: 'B', rows: [['k', 'w'], [5, 6], [7, 8]] },
    ]);
    const first = await DuckDbFile.open(path);
    const second = await DuckDbFile.open(path);
    try {
      await first.runQuery('select * from "A" limit 1');
      assert.equal(first.getDetectedSheetTables('A').length, 1);
      assert.equal(second.getDetectedSheetTables('A').length, 0, 'preparing A in one document does not prepare it in the other');
      await second.runQuery('select * from "B" limit 1');
      assert.equal(second.getDetectedSheetTables('B').length, 1);
      assert.equal(first.getDetectedSheetTables('B').length, 0);
      assert.equal(second.getDetectedSheetTables('A').length, 0);
      // Mutating a returned description cannot reach either document's cache.
      first.getDetectedSheetTables('A')[0].columns.push('injected');
      assert.ok(!first.getDetectedSheetTables('A')[0].columns.includes('injected'));
    } finally {
      first.dispose();
      second.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assert.ok(!existsSync(dir));
  }
});



