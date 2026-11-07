// Small helpers for run.mjs: VS Code binary lookup, process tree, VSIX manifest, sample PDF.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real VS Code executable (not the `code` shell wrapper, which detaches and loses the pid). */
export function vscodeExecutable() {
  if (process.env.DFV_VSCODE_EXECUTABLE) return process.env.DFV_VSCODE_EXECUTABLE;
  const mac = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  if (process.platform === 'darwin' && fs.existsSync(mac)) return mac;
  throw new Error('Set DFV_VSCODE_EXECUTABLE to the VS Code binary (only macOS is auto-detected).');
}

/** The `code` CLI used for --install-extension and for opening files in the running instance. */
export const codeCli = () => process.env.DFV_CODE_CLI || 'code';

/** package.json of the VSIX (read with the system unzip). */
export function vsixManifest(vsix) {
  return JSON.parse(execFileSync('unzip', ['-p', vsix, 'extension/package.json'], { maxBuffer: 1 << 26 }).toString());
}

/** [{pid, ppid, command}] for every descendant of `root` (excluding root). */
export function descendants(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 1 << 26 }).toString().split('\n')
    .map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: +m[1], ppid: +m[2], command: m[3] }));
  const seen = new Set([root]); const out = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.add(r.pid); out.push(r); grew = true; }
  }
  return out;
}

/** Electron's own helpers are not the extension's worker. */
export const isElectronHelper = c => /Code Helper|Electron Helper|crashpad|\/Visual Studio Code\.app\/Contents\/MacOS\/Code\b/.test(c);

/** PDF to open: --pdf / DFV_SMOKE_PDF, else an existing repo-adjacent fixture, else a generated one-page PDF. */
export function samplePdf(dest, given) {
  const fixture = fileURLToPath(new URL('./fixtures/base.pdf', import.meta.url));
  const src = given || process.env.DFV_SMOKE_PDF || fixture;
  if (given || process.env.DFV_SMOKE_PDF) { fs.copyFileSync(src, dest); return src; }
  if (fs.existsSync(src)) { fs.copyFileSync(src, dest); return src; }
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  const stream = 'BT /F1 18 Tf 20 100 Td (DFV smoke PDF) Tj ET';
  objs[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  let body = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(dest, body, 'latin1');
  return 'generated';
}

/** Extension-host log lines about `extId` activation: {activated: bool, error: string|undefined}. */
export function activationLog(userDir, extId) {
  const logs = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'exthost.log') logs.push(p); } };
  try { walk(path.join(userDir, 'logs')); } catch {}
  const text = logs.map(p => fs.readFileSync(p, 'utf8')).join('\n');
  const failed = text.match(new RegExp(`Activating extension ${extId.replace(/\./g, '\\.')} failed[^\\n]*\\n[^\\n]*`));
  return { activated: text.includes(`_doActivateExtension ${extId},`) && !failed, error: failed?.[0].replace(/\s+/g, ' ') };
}
