// D1.8 generator: derives test/migration/table-operations.json from source.
//
// Source discovery is by SYMBOL, never by line number: every anchor below is a
// declaration name resolved through the TypeScript compiler (program + type
// checker over every src/**/*.ts file, recursively, so a D1.7 move into
// src/backend/ is still found). When an anchor is missing or ambiguous the
// generator throws naming it; regenerate after D1.7 lands rather than editing
// the JSON by hand.
//
// Usage (from the viewer checkout):
//   npx tsc -p tsconfig.test.json && node out-test/test/migration/tableOperations.js --write
//   ... --check         exit 1 when the committed JSON differs from source
//   ... --reuse <path>  D0.4 gridcraft-reuse.json to cross-check (default below)
import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ---------------------------------------------------------------- SETTINGS --
/** Inventory format version; bump when the JSON shape changes. */
export const INVENTORY_VERSION = 2;
/** Committed output, relative to the viewer root. */
export const OUTPUT_PATH = 'test/migration/table-operations.json';
/** D0.4 reuse inventory cross-checked for the read methods (outside this repo). */
export const DEFAULT_REUSE_PATH =
  join('..', '..', 'Python', 'pdf_creator', 'tests', '_evidence', 'd04', 'gridcraft-reuse.json');

// ---------------------------------------------------------------- ANCHORS --
// Symbol names, not lines. D1.7 may move these; it must keep or rename them here.
export const ANCHORS = {
  readMethods: 'READ_METHODS',          // exported string-literal array
  readMetadata: 'ReadMetadata',          // interface sent with every worker reply
  referenceClass: 'DuckDbFile',          // in-process reference / trusted writer
  hostClass: 'ViewerFile',               // host proxy that owns the reader worker
  workerClient: 'QueryWorker',           // parent side of the reader process
  workerMetadataFn: 'metadata',          // reply-metadata builder in the dispatch file
  limits: 'QUERY_LIMITS',
  diagnostic: 'QueryDiagnostic',
} as const;

/** Lifecycle and mutation operations on the host document object. */
const HOST_OPERATIONS: Record<string, { member: string; kind: OperationKind }> = {
  'host.open': { member: 'open', kind: 'lifecycle' },
  'host.close': { member: 'dispose', kind: 'lifecycle' },
  'host.refreshInPlace': { member: 'refreshInPlace', kind: 'lifecycle' },
  'host.cancel': { member: 'interruptCurrentQuery', kind: 'lifecycle' },
  'mutation.createBackup': { member: 'createBackup', kind: 'mutation' },
  'mutation.updateCell': { member: 'updateCell', kind: 'mutation' },
};

/** Write paths a mutation reaches; each must be reachable from a mutation entry. */
const WRITE_PATHS: Record<string, { container?: string; member: string }> = {
  'write.xlsxPatch': { member: 'patchCell' },
  'write.xlsxZipRewrite': { member: 'rewriteZip' },
  'write.flatFileWriteback': { container: 'DuckDbFile', member: 'writeBackFlatFile' },
  'write.sqliteCell': { container: 'DuckDbFile', member: 'updateSqliteCell' },
  'write.duckdbTransaction': { container: 'DuckDbFile', member: 'updateCell' },
  'write.backupCopy': { container: 'DuckDbFile', member: 'createBackup' },
};

/** Bounded traversal depths, recorded in the output. */
const HELPER_DEPTH = 2;   // this.* helpers followed when collecting throw sites
const ROUTE_DEPTH = 6;    // calls followed from a mutation entry to a write path

// ------------------------------------------------- PER-CHANNEL SEMANTICS --
// Cancellation/identity/mutability are behaviour, not syntax. Each claim names
// the symbols that implement it; the generator fails if any evidence symbol
// is missing, so a moved implementation cannot leave a stale claim behind.
type OperationKind = 'read' | 'worker_control' | 'lifecycle' | 'mutation' | 'write_path';
interface Semantics { cancellation: string; identity: string; mutability: Mutability; evidence: string[] }
type Mutability = 'read_only' | 'in_memory' | 'process_state' | 'creates_sibling_file' | 'mutates_source';

const READ_SEMANTICS: Semantics = {
  cancellation: 'Cancellable. QueryWorker.cancel sends {method:"cancel"} then SIGKILLs the reader; every pending reply rejects "Query cancelled." and no partial result is delivered. Deadline QUERY_LIMITS.deadlineMs stops the reader the same way. The next call starts a new reader.',
  identity: 'Every read re-checks realpath and {size, mtimeMs} against the stamp taken at worker open and refuses with "The source changed..." on mismatch; replies carry metadata.stamp.',
  mutability: 'read_only',
  evidence: ['QueryWorker.cancel', 'QueryWorker.stop', 'QueryWorker.call', 'ViewerFile.read'],
};

const SEMANTICS: Record<string, Partial<Semantics> & { mutability?: Mutability }> = {
  'worker.open': {
    cancellation: 'Cancellable as a worker call (deadline/kill); a killed open leaves no worker document.',
    identity: 'Takes realpath of the host-supplied path and records {size, mtimeMs}; .xlsx also records the SHA-256 of the bytes preflighted.',
    mutability: 'process_state', evidence: ['QueryWorker.call', 'preflightWorkbook'],
  },
  'worker.cancel': {
    cancellation: 'Is the cancellation message itself: no id, no reply; interrupts the current reference query.',
    identity: 'None: addresses the worker process, not a request id.',
    mutability: 'process_state', evidence: ['DuckDbFile.interruptCurrentQuery', 'QueryWorker.cancel'],
  },
  'host.open': {
    cancellation: 'Not cancellable by the user; a failed open disposes the half-built file.',
    identity: 'realpath of the path; writability probed with access(W_OK) unless forceReadOnly.',
    mutability: 'process_state', evidence: ['ViewerFile.ensureOpen'],
  },
  'host.close': {
    cancellation: 'Idempotent. Sets closed, stops the reader, rejects queued reads. The provider defers it behind an active trusted save (lockChain).',
    identity: 'None.',
    mutability: 'process_state', evidence: ['QueryWorker.dispose', 'DuckDBDocument.dispose'],
  },
  'host.refreshInPlace': {
    cancellation: 'Not cancellable; closes the reader and reopens on current bytes.',
    identity: 'Accepts changed source stamp (allowChanged) and clears detected-table identities.',
    mutability: 'process_state', evidence: ['ViewerFile.ensureOpen', 'QueryWorker.close'],
  },
  'host.cancel': {
    cancellation: 'Cancels the reader only; never interrupts a trusted save, which runs outside the worker.',
    identity: 'None.',
    mutability: 'process_state', evidence: ['QueryWorker.cancel'],
  },
  'mutation.createBackup': {
    cancellation: 'Not cancellable and never retried. Runs with the reader closed, then reopens it.',
    identity: 'Refuses unless current {size, mtimeMs} equals the reader stamp; backup path is a fresh timestamped sibling name.',
    mutability: 'creates_sibling_file', evidence: ['ViewerFile.withReaderClosed', 'ViewerFile.write'],
  },
  'mutation.updateCell': {
    cancellation: 'Not cancellable and never retried; close waits for it. Duplicate identical rows are refused, not guessed.',
    identity: 'Refuses on stale {size, mtimeMs}; detected-table identity (JSON equality of DetectedSheetTable) must be unchanged; .xlsx additionally requires the opened SHA-256 and the expected current cell value.',
    mutability: 'mutates_source', evidence: ['ViewerFile.withReaderClosed', 'ViewerFile.updateXlsxCell', 'ViewerFile.write'],
  },
  'write.xlsxPatch': {
    cancellation: 'Not cancellable. Holds a sibling lock; recovers earlier stages; publishes by rename.',
    identity: 'expectedSha256 of source bytes and expectedCurrent cell value; receipt carries sourceSha256/publishedSha256.',
    mutability: 'mutates_source', evidence: ['XlsxPublishError'],
  },
  'write.xlsxZipRewrite': {
    cancellation: 'Synchronous in-memory archive rewrite; replaced members only, untouched members copied.',
    identity: 'Operates on a ZipIndex of the verified source bytes.',
    mutability: 'in_memory', evidence: ['indexZip'],
  },
  'write.flatFileWriteback': {
    cancellation: 'Not cancellable. Stages a sibling file, chmods to source mode, renames over the source.',
    identity: 'Refuses if the disk stamp {size, mtimeMs} changed since editing began; updates diskStamp after publish.',
    mutability: 'mutates_source', evidence: ['DuckDbFile.materializeIfNeeded'],
  },
  'write.sqliteCell': {
    cancellation: 'Not cancellable; transactional on the attached SQLite catalog.',
    identity: 'Row identity via rowid unless shadowed by a real column; ambiguity is refused.',
    mutability: 'mutates_source', evidence: [],
  },
  'write.duckdbTransaction': {
    cancellation: 'Not cancellable; begin/commit with rollback on failure.',
    identity: 'WHERE every editable column IS NOT DISTINCT FROM its shown value; more than one changed row rolls back.',
    mutability: 'mutates_source', evidence: [],
  },
  'write.backupCopy': {
    cancellation: 'Not cancellable; checkpoints duckdb/sqlite first. Refused under a read policy and for kdb.',
    identity: 'Backup name: <base>.backup-<timestamp>-<8 hex><ext> beside the source.',
    mutability: 'creates_sibling_file', evidence: [],
  },
};

// ------------------------------------------------------------- PROGRAM --
interface Ctx { root: string; program: ts.Program; checker: ts.TypeChecker; files: ts.SourceFile[] }

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

function createContext(root: string): Ctx {
  const files = listSources(join(root, 'src'));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true,
    esModuleInterop: true, skipLibCheck: true, moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmit: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  const own = program.getSourceFiles().filter(f => !f.isDeclarationFile && f.fileName.startsWith(join(root, 'src') + sep));
  return { root, program, checker: program.getTypeChecker(), files: own };
}

const rel = (ctx: Ctx, file: string) => relative(ctx.root, file).split(sep).join('/');

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild(child => walk(child, visit));
}

function declName(node: ts.Node): string | undefined {
  const name = (node as { name?: ts.Node }).name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
}

/** `file::Container.member` for a declaration; no line numbers by design. */
function locator(ctx: Ctx, node: ts.Node): string {
  const parts: string[] = [];
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
        (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer) || n === node))) {
      const name = declName(n);
      if (name) parts.unshift(name);
    }
  }
  return `${rel(ctx, node.getSourceFile().fileName)}::${parts.join('.')}`;
}

/** The unique top-level declaration with this name across src/. */
function findDeclaration(ctx: Ctx, name: string, test: (n: ts.Node) => boolean): ts.Node {
  const found: ts.Node[] = [];
  for (const file of ctx.files) {
    walk(file, n => { if (test(n) && declName(n) === name) found.push(n); });
  }
  if (found.length !== 1) {
    throw new Error(`Anchor "${name}" resolved to ${found.length} declarations (${found.map(f => locator(ctx, f)).join(', ') || 'none'}); update ANCHORS after D1.7.`);
  }
  return found[0];
}

const findClass = (ctx: Ctx, name: string) => findDeclaration(ctx, name, ts.isClassDeclaration) as ts.ClassDeclaration;

function findMember(cls: ts.ClassDeclaration, name: string): ts.ClassElement | undefined {
  return cls.members.find(m => declName(m) === name);
}

function requireMember(ctx: Ctx, cls: ts.ClassDeclaration, name: string): ts.ClassElement {
  const member = findMember(cls, name);
  if (!member) throw new Error(`Anchor "${cls.name?.text}.${name}" not found in ${locator(ctx, cls)}; regenerate after D1.7.`);
  return member;
}

/** Resolve "Class.member" or a bare function/class/const name; used for evidence. */
function resolveEvidence(ctx: Ctx, symbol: string): string {
  const [container, member] = symbol.includes('.') ? symbol.split('.') : [undefined, symbol];
  if (container) return locator(ctx, requireMember(ctx, findClass(ctx, container), member));
  return locator(ctx, findDeclaration(ctx, member, n => ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isVariableDeclaration(n)));
}

/** Body of a method, arrow-property, accessor or function declaration. */
function bodyOf(node: ts.Node): ts.Node | undefined {
  if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isGetAccessorDeclaration(node)) return node.body;
  if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.initializer.body;
  return undefined;
}

// ----------------------------------------------------------- SIGNATURES --
interface Argument { name: string; type: string; optional: boolean; default?: string; serializable: boolean }
interface Signature { arguments: Argument[]; returns: string }

const typeText = (ctx: Ctx, type: ts.Type) =>
  ctx.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);

function signatureOf(ctx: Ctx, member: ts.Node): Signature {
  const fn = ts.isMethodDeclaration(member) || ts.isFunctionDeclaration(member) ? member
    : (ts.isPropertyDeclaration(member) || ts.isVariableDeclaration(member)) && member.initializer && ts.isArrowFunction(member.initializer) ? member.initializer
    : undefined;
  if (!fn) throw new Error(`Not a callable member: ${locator(ctx, member)}`);
  const signature = ctx.checker.getSignatureFromDeclaration(fn);
  if (!signature) throw new Error(`No signature: ${locator(ctx, member)}`);
  const args = fn.parameters.map((p): Argument => {
    const type = ctx.checker.getTypeAtLocation(p);
    const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
    return {
      name, type: typeText(ctx, type), optional: !!p.questionToken || !!p.initializer,
      ...(p.initializer ? { default: p.initializer.getText() } : {}),
      serializable: type.getNonNullableType().getCallSignatures().length === 0,
    };
  });
  let returns = typeText(ctx, signature.getReturnType());
  const promise = /^Promise<(.*)>$/s.exec(returns);
  if (promise) returns = promise[1];
  return { arguments: args, returns };
}

// --------------------------------------------------------------- ERRORS --
interface ThrowSite { error: string; message: string; via: string; extra?: string[] }

function messageText(node: ts.Expression | undefined): string {
  if (!node) return '';
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(s => '${…}' + s.literal.text).join('');
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return messageText(node.left) + messageText(node.right);
  if (ts.isParenthesizedExpression(node)) return messageText(node.expression);
  return '${…}';
}

function throwsIn(ctx: Ctx, cls: ts.ClassDeclaration | undefined, member: ts.Node, depth = HELPER_DEPTH,
  seen = new Set<ts.Node>()): ThrowSite[] {
  if (seen.has(member)) return [];
  seen.add(member);
  const body = bodyOf(member);
  if (!body) return [];
  const via = locator(ctx, member);
  const out: ThrowSite[] = [];
  walk(body, n => {
    if (ts.isThrowStatement(n)) {
      let expr = n.expression;
      let extra: string[] | undefined;
      if (ts.isCallExpression(expr) && expr.expression.getText() === 'Object.assign' && expr.arguments.length > 1) {
        const props = expr.arguments[1];
        if (ts.isObjectLiteralExpression(props)) extra = props.properties.map(p => declName(p) ?? p.getText()).sort();
        expr = expr.arguments[0];
      }
      if (ts.isNewExpression(expr)) out.push({ error: expr.expression.getText(), message: messageText(expr.arguments?.[0]), via, ...(extra ? { extra } : {}) });
    }
    // Helpers: `this.x()` members of the same class, and functions declared in
    // the same module, resolved through the checker.
    if (depth > 0 && ts.isCallExpression(n)) {
      if (cls && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const helper = findMember(cls, n.expression.name.text);
        if (helper) out.push(...throwsIn(ctx, cls, helper, depth - 1, seen));
      } else if (ts.isIdentifier(n.expression)) {
        for (const decl of resolvedDeclarations(ctx, n)) {
          if (ts.isFunctionDeclaration(decl) && decl.getSourceFile() === member.getSourceFile()) out.push(...throwsIn(ctx, undefined, decl, depth - 1, seen));
        }
      }
    }
  });
  return out;
}

function uniqueThrows(sites: ThrowSite[]): ThrowSite[] {
  const map = new Map<string, ThrowSite>();
  for (const site of sites) {
    const key = `${site.error}\u0000${site.message}\u0000${site.via}`;
    if (!map.has(key)) map.set(key, site);
  }
  return [...map.values()].sort((a, b) => a.via.localeCompare(b.via) || a.error.localeCompare(b.error) || a.message.localeCompare(b.message));
}

// -------------------------------------------------------- CALL GRAPH --
function resolvedDeclarations(ctx: Ctx, call: ts.CallExpression | ts.NewExpression): ts.Node[] {
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let symbol = ctx.checker.getSymbolAtLocation(callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
  return (symbol?.declarations ?? []).filter(d => ctx.files.includes(d.getSourceFile()));
}

/** Chains of locators from `entry` to each target declaration, breadth-first. */
function routes(ctx: Ctx, entry: ts.Node, targets: Map<ts.Node, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const queue: { node: ts.Node; chain: string[] }[] = [{ node: entry, chain: [locator(ctx, entry)] }];
  const seen = new Set<ts.Node>([entry]);
  while (queue.length) {
    const { node, chain } = queue.shift()!;
    if (chain.length > ROUTE_DEPTH) continue;
    const body = bodyOf(node);
    if (!body) continue;
    walk(body, n => {
      if (!ts.isCallExpression(n)) return;
      for (const decl of resolvedDeclarations(ctx, n)) {
        if (seen.has(decl)) continue;
        seen.add(decl);
        const next = [...chain, locator(ctx, decl)];
        const id = targets.get(decl);
        if (id && !found[id]) found[id] = next;
        queue.push({ node: decl, chain: next });
      }
    });
  }
  return found;
}

/**
 * Same-named members of the interfaces a class `implements` (D1.7's backend
 * contract): callers that hold the contract type resolve to these, not to the
 * class, so they must count as callers of the operation.
 */
function contractMembers(ctx: Ctx, cls: ts.ClassDeclaration, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  for (const clause of cls.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const type of clause.types) {
      const property = ctx.checker.getTypeAtLocation(type).getProperty(name);
      for (const decl of property?.declarations ?? []) if (ctx.files.includes(decl.getSourceFile())) out.push(decl);
    }
  }
  return out;
}

/** Calls in src/ (outside the excluded classes) that resolve to one of `decls`. */
function callersOf(ctx: Ctx, decls: ts.Node[], exclude: ts.ClassDeclaration[]): { caller: string; webview_command?: string }[] {
  const out = new Map<string, { caller: string; webview_command?: string }>();
  for (const file of ctx.files) {
    walk(file, n => {
      if (!ts.isCallExpression(n)) return;
      if (exclude.some(cls => n.pos >= cls.pos && n.end <= cls.end && n.getSourceFile() === cls.getSourceFile())) return;
      if (!resolvedDeclarations(ctx, n).some(d => decls.includes(d))) return;
      let command: string | undefined;
      let owner: ts.Node | undefined;
      for (let p: ts.Node = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
        if (!command && ts.isIfStatement(p) && ts.isBinaryExpression(p.expression) &&
            p.expression.left.getText().endsWith('.command') && ts.isStringLiteral(p.expression.right)) command = p.expression.right.text;
        if (!owner && (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isConstructorDeclaration(p) ||
            (ts.isPropertyDeclaration(p) && p.initializer && ts.isArrowFunction(p.initializer)) ||
            (ts.isPropertyAssignment(p) && ts.isArrowFunction(p.initializer) && ts.isVariableDeclaration(p.parent.parent)))) owner = p;
      }
      let caller: string | undefined;
      if (owner && ts.isPropertyAssignment(owner)) {
        // Factory object member, e.g. `export const referenceBackend = { open: (...) => ... }`.
        const holder = owner.parent.parent;
        caller = `${rel(ctx, file.fileName)}::${declName(holder)}.${declName(owner)}`;
      } else if (owner) caller = ts.isConstructorDeclaration(owner) ? `${locator(ctx, owner.parent)}.constructor` : locator(ctx, owner);
      if (!caller) {
        // Module-level callback, e.g. the worker's process.on('message') handler.
        let p: ts.Node = n.parent;
        while (p && !ts.isSourceFile(p) && !(ts.isCallExpression(p) && ts.isStringLiteral(p.arguments[0] ?? p))) p = p.parent;
        caller = ts.isCallExpression(p) ? `${rel(ctx, file.fileName)}::${p.expression.getText()}('${(p.arguments[0] as ts.StringLiteral).text}')` : `${rel(ctx, file.fileName)}::<module>`;
      }
      const entry = { caller, ...(command ? { webview_command: command } : {}) };
      out.set(JSON.stringify(entry), entry);
    });
  }
  return [...out.values()].sort((a, b) => a.caller.localeCompare(b.caller) || (a.webview_command ?? '').localeCompare(b.webview_command ?? ''));
}

// ------------------------------------------------------- WORKER DISPATCH --
interface Dispatch {
  locator: string;
  readGate: boolean;
  controls: string[];
  specialCases: Record<string, string[]>;
  identityChecks: string[];
  forcedOpenOptions: Record<string, string>;
  metadataKeys: string[];
  throws: ThrowSite[];
}

function analyseDispatch(ctx: Ctx, readMethods: readonly string[]): Dispatch {
  const handlers: ts.CallExpression[] = [];
  for (const file of ctx.files) {
    walk(file, n => {
      if (ts.isCallExpression(n) && n.expression.getText() === 'process.on' &&
          ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'message') handlers.push(n);
    });
  }
  if (handlers.length !== 1) throw new Error(`Worker dispatch: expected one process.on('message') handler in src/, found ${handlers.length}; update the generator after D1.7.`);
  const handler = handlers[0];
  const file = handler.getSourceFile();
  const controls = new Set<string>();
  const specialCases: Record<string, string[]> = {};
  const identity = new Set<string>();
  const forced: Record<string, string> = {};
  let readGate = false;
  const throws: ThrowSite[] = [];
  const where = `${rel(ctx, file.fileName)}::process.on('message')`;
  walk(handler, n => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        /(^|\.)method$/.test(n.left.getText()) && ts.isStringLiteral(n.right)) {
      const name = n.right.text;
      if (readMethods.includes(name)) {
        const context = ts.isConditionalExpression(n.parent) ? 'argument_override' : 'error_diagnostic';
        (specialCases[name] ??= []).includes(context) || specialCases[name].push(context);
      } else controls.add(name);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'includes' &&
        n.expression.expression.getText().includes(ANCHORS.readMethods)) readGate = true;
    if (ts.isPropertyAccessExpression(n) && ['size', 'mtimeMs'].includes(n.name.text) && /stamp|current/.test(n.expression.getText())) identity.add(n.name.text);
    if (ts.isCallExpression(n) && n.expression.getText() === 'realpath') identity.add('realpath');
    if (ts.isCallExpression(n) && /\.open$/.test(n.expression.getText())) {
      const options = n.arguments[2];
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const p of options.properties) {
          if (ts.isPropertyAssignment(p) && (p.initializer.kind === ts.SyntaxKind.TrueKeyword || p.initializer.kind === ts.SyntaxKind.FalseKeyword)) {
            forced[declName(p)!] = p.initializer.getText();
          }
        }
      }
    }
    if (ts.isThrowStatement(n) && ts.isNewExpression(n.expression)) {
      throws.push({ error: n.expression.expression.getText(), message: messageText(n.expression.arguments?.[0]), via: where });
    }
  });
  if (!readGate) throw new Error('Worker dispatch no longer gates on READ_METHODS.includes(method); the read allowlist moved.');
  const metadataFn = findDeclaration(ctx, ANCHORS.workerMetadataFn, n => ts.isFunctionDeclaration(n) && n.getSourceFile() === file);
  const keys: string[] = [];
  walk(bodyOf(metadataFn)!, n => {
    if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
      for (const p of n.expression.properties) keys.push(declName(p) ?? p.getText());
    }
  });
  return {
    locator: where, readGate, controls: [...controls].sort(), specialCases,
    identityChecks: [...identity].sort(), forcedOpenOptions: forced, metadataKeys: keys.sort(), throws: uniqueThrows(throws),
  };
}

// -------------------------------------------------------------- REUSE --
interface ReuseCheck {
  path: string; sha256: string; viewer_commit: string; query_protocol_sha256: string;
  query_protocol_sha256_matches_current: boolean; read_methods_equal: boolean;
  methods: Record<string, { reuse_mode: string; proposed_local_adapter: string; status: string }>;
}

export function readReuse(path: string, readMethods: readonly string[], queryProtocolSha: string): ReuseCheck | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  const data = JSON.parse(bytes.toString('utf8'));
  const keys = Object.keys(data.read_methods ?? {}).sort();
  const methods: ReuseCheck['methods'] = {};
  for (const key of keys) {
    const m = data.read_methods[key];
    methods[key] = { reuse_mode: m.reuse_mode, proposed_local_adapter: m.proposed_local_adapter, status: m.status };
  }
  return {
    path, sha256: createHash('sha256').update(bytes).digest('hex'), viewer_commit: data.viewer_commit,
    query_protocol_sha256: data.query_protocol_sha256,
    query_protocol_sha256_matches_current: data.query_protocol_sha256 === queryProtocolSha,
    read_methods_equal: JSON.stringify(keys) === JSON.stringify([...readMethods].sort()),
    methods,
  };
}

// ------------------------------------------------------------ GENERATE --
export interface Operation {
  id: string; kind: OperationKind; name: string; channel: string;
  source: Record<string, string>;
  arguments: Argument[]; result: { type: string; envelope: string };
  errors: ThrowSite[];
  cancellation: string; identity: string; mutability: Mutability; evidence: string[];
  callers?: { caller: string; webview_command?: string }[];
  routes?: Record<string, string[]>;
  worker_special_cases?: string[];
  reuse?: ReuseCheck['methods'][string];
}

export interface Inventory {
  inventory_version: number;
  task: 'D1.8';
  generated_by: string;
  discovery: string;
  status_note: string;
  limits: Record<string, string>;
  channels: Record<string, unknown>;
  read_metadata: { fields: { name: string; type: string; optional: boolean }[]; worker_metadata_keys: string[] };
  host_result_views: Record<string, { commands: string[]; schema: string; source: string; validation: string; mutability: 'read_only' | 'in_memory'; coordinates: string; identity: string; paging: string; errors: string }>;
  error_categories: string[];
  operations: Operation[];
  reuse_cross_check: Omit<ReuseCheck, 'methods'> | { status: 'not_available'; path: string };
  provenance: { source_sha256: Record<string, string> };
}

function semanticsFor(ctx: Ctx, id: string, kind: OperationKind): Semantics {
  const own = SEMANTICS[id];
  const base = kind === 'read' ? READ_SEMANTICS : undefined;
  const merged = { ...base, ...own } as Semantics;
  if (!merged.cancellation || !merged.identity || !merged.mutability) throw new Error(`No cancellation/identity/mutability semantics for ${id}; add them to SEMANTICS.`);
  return { ...merged, evidence: [...new Set(merged.evidence ?? [])].sort().map(e => resolveEvidence(ctx, e)) };
}

export function generate(root: string, reusePath = DEFAULT_REUSE_PATH): Inventory {
  const ctx = createContext(root);
  const { checker } = ctx;

  // READ_METHODS by symbol: the exported array literal of strings.
  const readDecl = findDeclaration(ctx, ANCHORS.readMethods, ts.isVariableDeclaration) as ts.VariableDeclaration;
  let init = readDecl.initializer;
  while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
  if (!init || !ts.isArrayLiteralExpression(init) || !init.elements.every(ts.isStringLiteral)) throw new Error('READ_METHODS is no longer a string-literal array.');
  const readMethods = init.elements.map(e => (e as ts.StringLiteral).text);
  if (new Set(readMethods).size !== readMethods.length) throw new Error('READ_METHODS contains duplicates.');
  const protocolFile = readDecl.getSourceFile().fileName;
  const protocolSha = createHash('sha256').update(readFileSync(protocolFile)).digest('hex');

  const reference = findClass(ctx, ANCHORS.referenceClass);
  const host = findClass(ctx, ANCHORS.hostClass);
  const worker = findClass(ctx, ANCHORS.workerClient);
  const dispatch = analyseDispatch(ctx, readMethods);

  const unknownSemantics = Object.keys(SEMANTICS).filter(id =>
    !(id in HOST_OPERATIONS) && !(id in WRITE_PATHS) && !dispatch.controls.map(c => `worker.${c}`).includes(id));
  if (unknownSemantics.length) throw new Error(`SEMANTICS entries with no discovered operation: ${unknownSemantics.join(', ')}`);

  const reuse = readReuse(reusePath, readMethods, protocolSha);
  const operations: Operation[] = [];

  for (const name of readMethods) {
    const ref = requireMember(ctx, reference, name);
    const proxy = requireMember(ctx, host, name);
    const id = `read.${name}`;
    operations.push({
      id, kind: 'read', name, channel: 'read_worker',
      source: { reference: locator(ctx, ref), host: locator(ctx, proxy), dispatch: dispatch.locator, allowlist: locator(ctx, readDecl) },
      ...signatureOf(ctx, ref) && { arguments: signatureOf(ctx, ref).arguments },
      result: { type: signatureOf(ctx, ref).returns, envelope: 'ReadReply' },
      errors: uniqueThrows([...throwsIn(ctx, reference, ref), ...throwsIn(ctx, host, proxy, 0)]),
      ...semanticsFor(ctx, id, 'read'),
      ...(dispatch.specialCases[name] ? { worker_special_cases: dispatch.specialCases[name] } : {}),
      ...(reuse?.methods[name] ? { reuse: reuse.methods[name] } : {}),
    });
  }

  for (const control of dispatch.controls) {
    const id = `worker.${control}`;
    const ref = control === 'open' ? requireMember(ctx, reference, 'open') : requireMember(ctx, reference, 'interruptCurrentQuery');
    const sig = signatureOf(ctx, ref);
    operations.push({
      id, kind: 'worker_control', name: control, channel: 'read_worker',
      source: { dispatch: dispatch.locator, reference: locator(ctx, ref) },
      arguments: sig.arguments,
      result: { type: control === 'cancel' ? 'none (no reply)' : sig.returns, envelope: control === 'cancel' ? 'none' : 'ReadReply' },
      errors: control === 'open' ? dispatch.throws.filter(t => /already owns/.test(t.message)) : [],
      ...semanticsFor(ctx, id, 'worker_control'),
    });
  }

  // Targets for route discovery: every write path declaration.
  const writeDecls = new Map<ts.Node, string>();
  for (const [id, anchor] of Object.entries(WRITE_PATHS)) {
    const decl = anchor.container ? requireMember(ctx, findClass(ctx, anchor.container), anchor.member)
      : findDeclaration(ctx, anchor.member, ts.isFunctionDeclaration);
    writeDecls.set(decl, id);
  }

  for (const [id, { member, kind }] of Object.entries(HOST_OPERATIONS)) {
    const decl = requireMember(ctx, host, member);
    const refDecl = findMember(reference, member);
    const sig = signatureOf(ctx, refDecl && member !== 'open' ? refDecl : decl);
    const op: Operation = {
      id, kind, name: member, channel: kind === 'mutation' ? 'trusted_writer' : 'host',
      source: { host: locator(ctx, decl), ...(refDecl ? { reference: locator(ctx, refDecl) } : {}) },
      arguments: sig.arguments,
      result: { type: sig.returns, envelope: 'direct' },
      errors: uniqueThrows([...throwsIn(ctx, host, decl), ...(refDecl && kind === 'mutation' ? throwsIn(ctx, reference, refDecl, 0) : [])]),
      ...semanticsFor(ctx, id, kind),
      callers: callersOf(ctx, [decl, ...(refDecl ? [refDecl] : []), ...contractMembers(ctx, host, member)], [host, reference]),
    };
    if (kind === 'mutation') op.routes = routes(ctx, decl, writeDecls);
    operations.push(op);
  }

  const reached = new Set(operations.flatMap(o => Object.keys(o.routes ?? {})));
  for (const [decl, id] of writeDecls) {
    if (!reached.has(id)) throw new Error(`Write path ${id} (${locator(ctx, decl)}) is not reachable from any mutation entry within ${ROUTE_DEPTH} calls.`);
    const cls = ts.isClassDeclaration(decl.parent) ? decl.parent : undefined;
    const sig = signatureOf(ctx, decl);
    operations.push({
      id, kind: 'write_path', name: declName(decl)!, channel: 'trusted_writer',
      source: { implementation: locator(ctx, decl) },
      arguments: sig.arguments, result: { type: sig.returns, envelope: 'direct' },
      errors: uniqueThrows(throwsIn(ctx, cls, decl, cls ? HELPER_DEPTH : 0)),
      ...semanticsFor(ctx, id, 'write_path'),
    });
  }

  // ReadMetadata fields via the checker; must equal the worker's metadata() keys.
  const metaDecl = findDeclaration(ctx, ANCHORS.readMetadata, ts.isInterfaceDeclaration) as ts.InterfaceDeclaration;
  const metaType = checker.getTypeAtLocation(metaDecl);
  const fields = metaType.getProperties().map(p => ({
    name: p.name, type: typeText(ctx, checker.getTypeOfSymbolAtLocation(p, metaDecl)), optional: !!(p.flags & ts.SymbolFlags.Optional),
  })).sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(fields.map(f => f.name)) !== JSON.stringify(dispatch.metadataKeys)) {
    throw new Error(`ReadMetadata fields (${fields.map(f => f.name)}) differ from worker metadata() keys (${dispatch.metadataKeys}).`);
  }

  const diag = findDeclaration(ctx, ANCHORS.diagnostic, ts.isInterfaceDeclaration) as ts.InterfaceDeclaration;
  const category = checker.getTypeAtLocation(diag).getProperty('category')!;
  const categoryType = checker.getTypeOfSymbolAtLocation(category, diag);
  const categories = (categoryType.isUnion() ? categoryType.types : [categoryType])
    .map(t => (t as ts.StringLiteralType).value).sort();

  const limitsDecl = findDeclaration(ctx, ANCHORS.limits, ts.isVariableDeclaration) as ts.VariableDeclaration;
  const limits: Record<string, string> = {};
  walk(limitsDecl.initializer!, n => {
    if (ts.isPropertyAssignment(n)) limits[declName(n)!] = n.initializer.getText();
  });

  const workerThrows: ThrowSite[] = [];
  for (const m of ['call', 'start', 'cancel', 'stop']) workerThrows.push(...throwsIn(ctx, worker, requireMember(ctx, worker, m), 1));
  const stopReasons: string[] = [];
  walk(worker, n => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'stop' && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      stopReasons.push(n.arguments[0].text);
    }
  });

  const sourceSha: Record<string, string> = {};
  for (const file of ctx.files) sourceSha[rel(ctx, file.fileName)] = createHash('sha256').update(readFileSync(file.fileName)).digest('hex');

  return {
    inventory_version: INVENTORY_VERSION,
    task: 'D1.8',
    generated_by: 'test/migration/tableOperations.ts',
    discovery: 'Symbol-based: TypeScript program + checker over every src/**/*.ts. Locators are "file::Container.member" with no line numbers. Missing or ambiguous anchors fail generation.',
    status_note: 'Generated against the current source tree. Task acceptance is tracked separately in the programme ledger.',
    limits: { ...limits, helper_depth_for_errors: String(HELPER_DEPTH), route_depth: String(ROUTE_DEPTH) },
    channels: {
      read_worker: {
        transport: 'Node child_process.fork IPC, serialization "advanced" (structured clone). D1.9 defines the portable JSON envelope.',
        dispatch: dispatch.locator,
        allowlist_gate: dispatch.readGate,
        controls: dispatch.controls,
        identity_checks: dispatch.identityChecks,
        forced_open_options: dispatch.forcedOpenOptions,
        dispatch_errors: dispatch.throws,
        client_errors: uniqueThrows(workerThrows),
        client_stop_reasons: [...new Set(stopReasons)].sort(),
        reply_error_shape: 'Operation failure with an open document: {value: undefined, metadata, error: <diagnostic message>} -> QueryWorkerOperationError(message, metadata). Without a document: {id, error}.',
      },
      host: { transport: 'In-process calls on the host document object (ViewerFile).' },
      trusted_writer: { transport: 'In-process; the reader is closed first (ViewerFile.withReaderClosed), a fresh DuckDbFile writer or xlsxWrite.patchCell performs the write, then the reader reopens.' },
    },
    read_metadata: { fields, worker_metadata_keys: dispatch.metadataKeys },
    host_result_views: {
      manual_table: {
        commands: ['useRangeAsTable'], schema: 'query-range.v1.schema.json',
        source: locator(ctx, findDeclaration(ctx, 'tableFromRange', ts.isFunctionDeclaration)),
        validation: locator(ctx, findDeclaration(ctx, 'validateQueryMessage', ts.isFunctionDeclaration)),
        mutability: 'in_memory',
        coordinates: 'Captured raw worksheet only; one-based inclusive rectangle and header row or null, converted to zero-based half-open bounds. SQL result coordinates refuse.',
        identity: 'Execution token and source stats/generation. Keep other manual rectangles; replace overlapping ones atomically on the selected sheet. Retain across unchanged-source reconnect; clear with notice when source changes.',
        paging: 'Reuse bounded range preview; native preparation validates worksheet bounds and at most64 nonoverlapping manual rectangles. No source cells are written.',
        errors: 'Stale token/source, non-worksheet result, invalid bounds/header/overlap or failed preparation refuses without replacing prior metadata.',
      },
      query_range: {
        commands: ['queryRange', 'invalidateRange'],
        schema: 'query-range.v1.schema.json',
        source: locator(ctx, findDeclaration(ctx, 'selectResultRange', ts.isFunctionDeclaration)),
        validation: locator(ctx, findDeclaration(ctx, 'validateQueryMessage', ts.isFunctionDeclaration)),
        mutability: 'read_only',
        coordinates: 'One-based inclusive A1 rectangles. Worksheet row/column coordinates are preserved; SQL row 1 is the first data row and an explicit outer ORDER BY is required.',
        identity: 'Execution token and captured source stamp/inode; worker source generation checked before reading. Requery, sort, edit, reconnect, live refresh and explicit invalidation discard the snapshot.',
        paging: 'Captured result order is never reexecuted between pages. At most 100 rows and 16384 cells per page; raw worksheet previews may extend to the requested row within worker/configured limits. SQL ranges beyond captured rows refuse.',
        errors: 'Malformed/reversed/out-of-bounds coordinates, stale source/token/order, invalid page and unordered SQL refuse without source writes.',
      },
    },
    error_categories: categories,
    operations,
    reuse_cross_check: reuse
      ? (({ methods: _m, ...rest }) => rest)(reuse)
      : { status: 'not_available', path: reusePath },
    provenance: { source_sha256: sourceSha },
  };
}

/** The part of the inventory the drift test compares (provenance hashes excluded). */
export function comparable(inventory: Inventory): unknown {
  const { provenance: _p, reuse_cross_check: _r, ...rest } = inventory;
  return { ...rest, operations: inventory.operations.map(({ reuse: _u, ...op }) => op) };
}

/** Set difference of operation ids, both directions; empty arrays mean equal sets. */
export function diffOperationIds(expected: readonly string[], actual: readonly string[]): { missing: string[]; extra: string[] } {
  const a = new Set(actual), e = new Set(expected);
  return { missing: [...e].filter(id => !a.has(id)).sort(), extra: [...a].filter(id => !e.has(id)).sort() };
}

export const serialize = (inventory: Inventory) => JSON.stringify(inventory, null, 2) + '\n';

if (require.main === module) {
  const args = process.argv.slice(2);
  const root = process.cwd();
  const reuseIndex = args.indexOf('--reuse');
  const reusePath = reuseIndex >= 0 ? args[reuseIndex + 1] : DEFAULT_REUSE_PATH;
  const inventory = generate(root, reusePath);
  const target = join(root, OUTPUT_PATH);
  if (args.includes('--write')) {
    writeFileSync(target, serialize(inventory));
    process.stdout.write(`Wrote ${OUTPUT_PATH}: ${inventory.operations.length} operations.\n`);
  } else if (args.includes('--check')) {
    const committed = JSON.parse(readFileSync(target, 'utf8')) as Inventory;
    const same = JSON.stringify(comparable(committed)) === JSON.stringify(comparable(inventory));
    process.stdout.write(same ? 'table-operations.json matches source.\n' : 'table-operations.json differs from source; regenerate with --write.\n');
    process.exitCode = same ? 0 : 1;
  } else {
    process.stdout.write(serialize(inventory));
  }
}
