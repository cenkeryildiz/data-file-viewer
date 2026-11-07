// Differential check: decode Rust-written fixtures with the TypeScript reference parser and compare to the Rust dump.
// Usage: node compare.mjs <fixture-dir> <esbuild.js-path> <path-to-src/kdbParser.ts>
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const [dir, esbuild, ts] = process.argv.slice(2);
const out = path.join(dir, '_kdbParser.cjs');
execFileSync(esbuild, [ts, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error']);
const {parseKdbFile} = createRequire(import.meta.url)(out);
const f4 = (v) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v); return d.getUint32(0).toString(16).padStart(8, '0'); };
const f8 = (v) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v); return d.getBigUint64(0).toString(16).padStart(16, '0'); };
const canon = (t, v) => {
  if (v === null) return 'null';
  if (t === 1) return `b:${v ? 1 : 0}`;
  if (t === 2 || t === 10 || t === 11) return `s:${v}`;
  if (t === 8) return `f4:${f4(v)}`;
  if (t === 9) return `f8:${f8(v)}`;
  if (typeof v === 'bigint') return `j:${v}`;
  return `i:${v}`;
};
let bad = 0, checked = 0, cells = 0;
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  const rust = JSON.parse(fs.readFileSync(path.join(dir, name)));
  const t = parseKdbFile(path.join(dir, name.slice(0, -5)));
  checked++;
  const ok = t.rowCount === rust.rowCount && t.columns.length === rust.columns.length;
  if (!ok) { console.log('SHAPE', name, t.rowCount, rust.rowCount); bad++; continue; }
  t.columns.forEach((c, i) => {
    const r = rust.columns[i];
    if (c.name !== r.name || c.qType !== r.qType) { console.log('COLUMN', name, i); bad++; return; }
    c.values.forEach((v, k) => {
      cells++;
      const a = canon(c.qType, v);
      if (a !== r.values[k]) { if (bad++ < 15) console.log('DIFF', name, c.name, k, 'ts=', a, 'rust=', r.values[k]); }
    });
  });
}
console.log(JSON.stringify({files: checked, cells, mismatches: bad}));
process.exit(bad ? 1 : 0);
