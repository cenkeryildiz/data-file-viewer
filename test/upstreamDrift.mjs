#!/usr/bin/env node
// PLOT-04 upstream drift gate. A non-zero exit means "review the listed extension
// files and tests", never "rewrite them": nothing here edits sources or baselines.
//   node test/upstreamDrift.mjs            check against test/fixtures/upstreamDrift/baseline.json
//   node test/upstreamDrift.mjs --record   print a fresh baseline to stdout (explicit, never overwrites)
// Environment: DFV_UPSTREAM_ROOT (default ~/Desktop/Kod/Projects), DFV_EXT_ROOT (default: parent of test/),
// DFV_PYTHON (default: `conda run -n myproject python`).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, 'fixtures', 'upstreamDrift', 'baseline.json');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const specName = (s) => s.split('~')[0]; // "name~needle" = symbol must also contain a nested needle

/* ------------------------------------------------------------ symbol extraction */

// Python: the stdlib parser gives exact top-level extents (decorators included), so no heuristics.
const PY_HELPER = String.raw`
import ast, hashlib, json, re, sys
req = json.loads(sys.argv[1])
out = {"files": {}, "patterns": {}}
for f in req["files"]:
    src = open(f["path"], encoding="utf-8").read()
    lines = src.split("\n")
    tree = ast.parse(src)
    found = {}
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names = [n.name]
            start = min([n.lineno] + [d.lineno for d in n.decorator_list])
        elif isinstance(n, ast.Assign):
            names = [t.id for t in n.targets if isinstance(t, ast.Name)]; start = n.lineno
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            names = [n.target.id]; start = n.lineno
        else:
            continue
        body = "\n".join(lines[start - 1:n.end_lineno])
        for name in names:
            found[name] = body
    out["files"][f["path"]] = {
        "sha256": hashlib.sha256(open(f["path"], "rb").read()).hexdigest(),
        "symbols": {s: found.get(s) for s in f["symbols"]},
    }
for p in req.get("patterns", []):
    ns = {"re": re}
    src = open(p, encoding="utf-8").read()
    for n in ast.parse(src).body:
        if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "_DATE_COL_PATTERN" for t in n.targets):
            exec(compile(ast.Module([n], []), p, "exec"), ns)
    rx = ns["_DATE_COL_PATTERN"]
    out["patterns"][p] = {w: bool(rx.match(w)) for w in req["words"]}
json.dump(out, sys.stdout)
`;

// R: top-level "name <- value"; the statement ends at a newline outside brackets/strings/comments
// unless the line ends in an operator or the next line continues it (else / {).
// shortcut: no raw strings (r"(...)") -- none in the upstream; extend if one appears.
export function extractRSymbol(text, name) {
  const m = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(<-|=)`, 'm').exec(text);
  if (!m) return null;
  let i = m.index, depth = 0, quote = null, lastSig = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; lastSig = 'q'; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === '\n' && depth === 0 && !/[,+\-*\/<>=|&%~!^(]/.test(lastSig) && !/^\s*(else\b|\{)/.test(text.slice(i + 1, i + 40))) break;
    if (!/\s/.test(c)) lastSig = c;
  }
  return text.slice(m.index, i).trimEnd();
}

/* ------------------------------------------------------------------- collection */

function runPython(request) {
  const [cmd, ...pre] = process.env.DFV_PYTHON ? [process.env.DFV_PYTHON] : ['conda', 'run', '-n', 'myproject', 'python'];
  const r = spawnSync(cmd, [...pre, '-I', '-c', PY_HELPER, JSON.stringify(request)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`python helper failed (${r.status}): ${r.stderr || r.error}`);
  return JSON.parse(r.stdout);
}

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

// Everything the comparison needs, read from the live upstreams and extension; no judgement here.
export function collect(baseline, { upstreamRoot, extRoot }) {
  const wanted = new Map(); // upstream path -> Set(symbol names)
  for (const row of baseline.rows) for (const [p, syms] of Object.entries(row.upstream)) {
    if (!wanted.has(p)) wanted.set(p, new Set());
    for (const s of syms) wanted.get(p).add(specName(s));
  }
  const obs = { files: {}, git: {}, ext: {}, patterns: {} };
  const pyFiles = [];
  for (const [p, syms] of wanted) {
    const abs = path.join(upstreamRoot, p);
    if (!existsSync(abs)) { obs.files[p] = null; continue; }
    if (p.endsWith('.py')) pyFiles.push({ path: abs, symbols: [...syms] });
    else {
      const t = readFileSync(abs, 'utf8');
      obs.files[p] = { sha256: sha(readFileSync(abs)), symbols: Object.fromEntries([...syms].map((s) => [s, extractRSymbol(t, s)])) };
    }
  }
  const diff = baseline.differential;
  const py = pyFiles.length ? runPython({ files: pyFiles, patterns: [diff.etlFile, diff.historicalFile].map((f) => path.join(upstreamRoot, f)), words: diff.words }) : { files: {}, patterns: {} };
  for (const f of pyFiles) {
    const rel = path.relative(upstreamRoot, f.path), o = py.files[f.path];
    obs.files[rel] = { sha256: o.sha256, symbols: o.symbols };
  }
  for (const [p, o] of Object.entries(obs.files)) if (o) for (const [s, body] of Object.entries(o.symbols)) o.symbols[s] = body == null ? null : { sha256: sha(body), body };
  for (const f of [diff.etlFile, diff.historicalFile]) obs.patterns[f] = py.patterns[path.join(upstreamRoot, f)];
  for (const repo of baseline.repos) {
    const dir = path.join(upstreamRoot, repo.prefix);
    const files = Object.keys(baseline.files).filter((f) => f.startsWith(repo.prefix + '/')).map((f) => f.slice(repo.prefix.length + 1));
    const known = git(dir, 'cat-file', '-e', `${repo.commit}^{commit}`).status === 0;
    const differs = (rev) => files.filter((f) => git(dir, 'diff', '--quiet', rev, '--', f).status !== 0);
    obs.git[repo.prefix] = { known, head: git(dir, 'rev-parse', 'HEAD').stdout.trim(), changed: known ? differs(repo.commit) : files, dirty: differs('HEAD') };
  }
  const extFiles = new Set([diff.tsFile, ...baseline.rows.flatMap((r) => [...Object.keys(r.extension), ...r.tests])]);
  for (const f of extFiles) obs.ext[f] = existsSync(path.join(extRoot, f)) ? readFileSync(path.join(extRoot, f), 'utf8') : null;
  obs.tsPattern = obs.ext[diff.tsFile];
  return obs;
}

/* --------------------------------------------------------------------- compare */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Declarations and members across TS and Rust: `function x`, `const x`, `fn x`, `x(` as a method.
const hasExtSymbol = (text, n) => new RegExp(`\\b(?:function|const|let|var|class|fn|enum|struct|type|interface)\\s+${escapeRe(n)}\\b|^\\s*(?:(?:pub|async|static|public|private|protected|readonly)\\s+)*${escapeRe(n)}\\s*[(<:=]`, 'm').test(text);

function tsPattern(text) {
  const m = /export const DATE_COL_PATTERN\s*=\s*\/(.*)\/([a-z]*);/.exec(text ?? '');
  return m ? new RegExp(m[1], m[2]) : null;
}

export function compare(baseline, obs) {
  const problems = [];
  const rowsFor = (file, sym) => baseline.rows.filter((r) => r.upstream[file]?.some((s) => !sym || specName(s) === sym));
  const review = (row) => `    review: ${Object.keys(row.extension).join(', ')}\n    tests:  ${row.tests.join(', ')}\n    row:    ${row.behavior}`;
  const add = (kind, text, rows) => problems.push({ kind, text: `${kind}: ${text}\n${rows.map(review).join('\n')}` });

  for (const [p, base] of Object.entries(baseline.files)) {
    const o = obs.files[p];
    if (!o) { add('MISSING-FILE', `${p} no longer exists`, rowsFor(p)); continue; }
    let symbolProblem = false;
    for (const [spec, want] of Object.entries(base.symbols)) {
      const n = specName(spec), got = o.symbols[n], before = problems.length;
      if (!got) { add('MISSING-SYMBOL', `${p}::${n} not found`, rowsFor(p, n)); symbolProblem = true; continue; }
      if (spec.includes('~') && !got.body.includes(spec.split('~').slice(1).join('~'))) add('MISSING-SYMBOL', `${p}::${n} no longer contains "${spec.split('~').slice(1).join('~')}"`, rowsFor(p, n));
      else if (got.sha256 !== want) add('CHANGED-SYMBOL', `${p}::${n} body hash ${want.slice(0, 12)} -> ${got.sha256.slice(0, 12)}`, rowsFor(p, n));
      symbolProblem ||= problems.length > before;
    }
    if (o.sha256 !== base.sha256 && !symbolProblem)
      add('CHANGED-FILE', `${p} hash ${base.sha256.slice(0, 12)} -> ${o.sha256.slice(0, 12)} outside the mapped symbols (a new or changed function may need a map entry)`, rowsFor(p));
  }
  for (const repo of baseline.repos) {
    const g = obs.git[repo.prefix];
    if (!g.known) problems.push({ kind: 'BASELINE-COMMIT', text: `BASELINE-COMMIT: ${repo.commit} not found under ${repo.prefix}; the baseline snapshot is stale or the checkout is not the baselined repository` });
    else if (g.changed.length) problems.push({ kind: 'UPSTREAM-MOVED', text: `UPSTREAM-MOVED: ${repo.prefix} differs from baseline commit ${repo.commit.slice(0, 12)} (HEAD ${g.head.slice(0, 12)}) in: ${g.changed.join(', ')}` });
  }
  for (const row of baseline.rows) for (const [f, syms] of Object.entries(row.extension)) {
    const text = obs.ext[f];
    if (text == null) { problems.push({ kind: 'MISSING-EXTENSION', text: `MISSING-EXTENSION: ${f} (row "${row.id}") does not exist; update the map or restore the file` }); continue; }
    for (const s of syms) if (!hasExtSymbol(text, s)) problems.push({ kind: 'MISSING-EXTENSION', text: `MISSING-EXTENSION: ${f}::${s} (row "${row.id}") not found; update the map or restore the symbol` });
  }
  for (const t of baseline.rows.flatMap((r) => r.tests)) if (obs.ext[t] == null) problems.push({ kind: 'MISSING-EXTENSION', text: `MISSING-EXTENSION: test ${t} does not exist` });
  problems.push(...compareDateNames(baseline.differential, obs));
  return problems;
}

// Differential: ETL's Python pattern (current and historical copy) vs the viewer's TS pattern on one word list.
export function compareDateNames(diff, obs) {
  const out = [], ts = tsPattern(obs.tsPattern);
  if (!ts) return [{ kind: 'MISSING-EXTENSION', text: `MISSING-EXTENSION: ${diff.tsFile}::DATE_COL_PATTERN is not a literal regex any more` }];
  const etl = obs.patterns[diff.etlFile], hist = obs.patterns[diff.historicalFile];
  const known = new Map(diff.intentionalDifferences.map((d) => [d.word, d]));
  for (const w of diff.words) {
    const t = ts.test(w), e = etl[w], h = hist[w];
    if (e !== h) out.push({ kind: 'ETL-COPIES-DIFFER', text: `ETL-COPIES-DIFFER: ${JSON.stringify(w)} current ETL=${e} historical=${h}` });
    const d = known.get(w);
    if (e === t && d) out.push({ kind: 'STALE-DIFFERENCE', text: `STALE-DIFFERENCE: ${JSON.stringify(w)} is listed as an intentional difference but ETL and viewer now agree (${t}); remove it` });
    else if (e !== t && !d) out.push({ kind: 'UNNAMED-DIFFERENCE', text: `UNNAMED-DIFFERENCE: ${JSON.stringify(w)} ETL=${e} viewer=${t}; fix the viewer or name it in differential.intentionalDifferences with a status (intentional|gap) and a reason` });
    else if (d && (d.etl !== e || d.viewer !== t)) out.push({ kind: 'STALE-DIFFERENCE', text: `STALE-DIFFERENCE: ${JSON.stringify(w)} recorded etl=${d.etl}/viewer=${d.viewer}, observed etl=${e}/viewer=${t}` });
  }
  for (const d of diff.intentionalDifferences) if (!diff.words.includes(d.word)) out.push({ kind: 'STALE-DIFFERENCE', text: `STALE-DIFFERENCE: ${JSON.stringify(d.word)} is not in the word list` });
  return out;
}

/* ------------------------------------------------------------------------- CLI */

export function recordBaseline(baseline, obs) {
  const next = structuredClone(baseline);
  next.files = {};
  for (const [p, o] of Object.entries(obs.files)) if (o) next.files[p] = { sha256: o.sha256, symbols: Object.fromEntries(Object.entries(o.symbols).map(([s, b]) => [s, b?.sha256 ?? null])) };
  // keep spec keys ("name~needle") aligned with the map
  for (const [p, f] of Object.entries(next.files)) {
    const specs = new Set(next.rows.flatMap((r) => r.upstream[p] ?? []));
    f.symbols = Object.fromEntries([...specs].map((s) => [s, f.symbols[specName(s)]]));
  }
  for (const repo of next.repos) {
    const g = obs.git[repo.prefix];
    if (g.dirty.length) throw new Error(`refusing to baseline ${repo.prefix}: uncommitted changes in ${g.dirty.join(', ')}`);
    repo.commit = g.head;
  }
  return next;
}

async function main() {
  const args = process.argv.slice(2);
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const opts = {
    upstreamRoot: process.env.DFV_UPSTREAM_ROOT || path.join(homedir(), 'Desktop', 'Kod', 'Projects'),
    extRoot: process.env.DFV_EXT_ROOT || path.resolve(HERE, '..'),
  };
  if (!existsSync(opts.upstreamRoot)) { console.error(`upstream root not found: ${opts.upstreamRoot} (set DFV_UPSTREAM_ROOT)`); process.exit(2); }
  const obs = collect(baseline, opts);
  if (args.includes('--record')) {
    // Explicit re-baselining: print only; the reviewer commits the result after reading the CHANGED lines.
    process.stdout.write(JSON.stringify(recordBaseline(baseline, obs), null, 2) + '\n');
    return;
  }
  const problems = compare(baseline, obs);
  const symbols = Object.values(baseline.files).reduce((n, f) => n + Object.keys(f.symbols).length, 0);
  if (!problems.length) {
    console.log(`upstream drift: OK (${Object.keys(baseline.files).length} upstream files, ${symbols} symbols, ${baseline.differential.words.length} date-name words, ${baseline.differential.intentionalDifferences.length} named differences)`);
    for (const d of baseline.differential.intentionalDifferences.filter((x) => x.status === 'gap')) console.log(`  open gap: ${JSON.stringify(d.word)} -- ${d.reason}`);
    return;
  }
  console.error(problems.map((p) => p.text).join('\n\n'));
  console.error(`\nupstream drift: ${problems.length} finding(s). This means REVIEW the listed extension files and tests against the changed upstream behaviour; it is not a request to rewrite them or to refresh the baseline blindly (see "Baseline and update procedure" in PDF_VIEWER_RESEARCH.md).`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
