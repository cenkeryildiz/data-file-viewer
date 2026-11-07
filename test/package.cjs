// PKG-01–04: inspect a built VSIX against allow/deny rules. Usage:
//   npm run test:package                  (data-file-viewer-<package.json version>*.vsix here)
//   node test/package.cjs path/to/file.vsix
// Reads the archive; installs nothing and publishes nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync, strFromU8 } = require('fflate');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');

const root = path.resolve(__dirname, '..');
// Invalid build inputs must fail before replacing a previously working PDF bundle.
for (const fault of ['missing manifest', 'changed worker', 'wrong size', 'missing dependency', 'duplicate record', 'unlisted asset', 'symlink asset']) {
  const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dfv-pdf-package-'));
  try {
    const bundle = path.join(sandbox, 'bundle');
    const files = ['web/static/index.html', 'web/static/viewer.js', 'web/static/outline.js', 'bin/dfv-pdf',
      'ui/nativeTransport.js', 'licenses/OFL-Inter.txt', 'licenses/font-manifest.json'];
    const manifest = { format: 1, files: files.map(name => {
      const bytes = Buffer.from(name);
      fs.mkdirSync(path.dirname(path.join(bundle, name)), { recursive: true });
      fs.writeFileSync(path.join(bundle, name), bytes);
      return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }) };
    if (fault === 'changed worker') fs.writeFileSync(path.join(bundle, 'bin/dfv-pdf'), 'bad/dfv-pdf');
    if (fault === 'wrong size') manifest.files[0].bytes++;
    if (fault === 'missing dependency') fs.unlinkSync(path.join(bundle, 'web/static/outline.js'));
    if (fault === 'duplicate record') manifest.files.push(manifest.files[0]);
    if (fault === 'unlisted asset') fs.writeFileSync(path.join(bundle, 'web/static/unlisted.js'), 'unverified');
    if (fault === 'symlink asset') fs.symlinkSync(path.join(bundle, 'bin/dfv-pdf'), path.join(bundle, 'web/static/link.js'));
    if (fault !== 'missing manifest') fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    const previous = path.join(sandbox, 'media/pdf/bin/dfv-pdf');
    fs.mkdirSync(path.dirname(previous), { recursive: true });
    fs.writeFileSync(previous, 'working worker');
    const result = spawnSync(process.execPath, [path.join(root, 'esbuild.js'), '--require-pdf'], {
      cwd: sandbox, env: { ...process.env, DFV_PDF_BUNDLE: bundle }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `${fault}: build must refuse invalid inputs`);
    assert.match(result.stderr, /PDF bundle|PDF asset/, `${fault}: must report the input failure`);
    assert.equal(fs.readFileSync(previous, 'utf8'), 'working worker', `${fault}: existing worker must survive`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
console.log('PDF bundle integrity: 7 invalid inputs refused; existing assets preserved');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Restrict to the current version, then pick its newest candidate; an explicit path selects an archival build.
const vsix = process.argv[2] ?? fs.readdirSync(root)
  .filter(name => new RegExp(`^data-file-viewer-${pkg.version.replace(/\./g, '\\.')}(-.+)?\\.vsix$`).test(name))
  .map(name => path.join(root, name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
assert.ok(vsix, `no data-file-viewer-${pkg.version}*.vsix in ${root}; run \`npx vsce package --allow-missing-repository\` first (or pass a path)`);

const bytes = fs.readFileSync(vsix);
const entries = unzipSync(bytes);
const names = Object.keys(entries);
const own = names.filter(n => n.startsWith('extension/') && !n.startsWith('extension/node_modules/'));
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
check(/\bTargetPlatform="darwin-arm64"/.test(strFromU8(entries['extension.vsixmanifest'] ?? new Uint8Array())), 'VSIX must declare the qualified darwin-arm64 target');

// PKG-02/03: the tested code ships, with its native binding and worker.
for (const required of ['extension/package.json', 'extension/dist/extension.js', 'extension/dist/webview.js',
  'extension/dist/chartView.js', 'extension/dist/matView.js', 'extension/media/main.css', 'extension/LICENSE.txt',
  'extension/THIRD_PARTY_LICENSES.txt', 'extension/README.md', 'extension/bin/dfv-table', 'extension/bin/dfv-mat',
  'extension/bin/workers.json']) {
  check(names.includes(required), `missing ${required}`);
}
// The installed extension must not need the Node reference backend (V-plan: no Node processing backend).
check(!names.some(n => /^extension\/node_modules\/@duckdb\//.test(n)), 'Node DuckDB reference backend shipped');
const shipped = JSON.parse(strFromU8(entries['extension/package.json']));
if (shipped.contributes?.customEditors?.some(editor => editor.viewType === 'dataFileViewer.pdf')) {
  const pdfFiles = new Map();
  function readPdfAssets(relative) {
    for (const file of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${file.name}`;
      if (file.isDirectory()) readPdfAssets(name);
      else pdfFiles.set(`extension/${name}`, fs.readFileSync(path.join(root, name)));
    }
  }
  readPdfAssets('media/pdf');
  for (const [name, source] of pdfFiles) {
    check(entries[name] && source.equals(entries[name]), `packaged PDF asset missing or changed: ${name}`);
  }
  for (const name of names.filter(name => name.startsWith('extension/media/pdf/'))) {
    check(pdfFiles.has(name), `untested PDF asset shipped: ${name}`);
  }
  for (const file of ['pdf/bin/dfv-pdf', 'pdf/web/static/index.html', 'pdf/web/static/viewer.js',
    'pdf/ui/nativeTransport.js', 'pdf/licenses/OFL-Inter.txt', 'pdf/licenses/font-manifest.json',
    'pdf-vscode/theme.css', 'pdf-vscode/interface.css', 'pdf-vscode/surfaces.css', 'pdf-vscode/interface.js']) {
    const name = `extension/media/${file}`;
    check(names.includes(name), `missing ${name}`);
    if (entries[name]) check(fs.readFileSync(path.join(root, 'media', file)).equals(entries[name]), `packaged PDF asset differs from the tested file: ${file}`);
  }
}
check(shipped.version === pkg.version, `packaged version ${shipped.version} != package.json ${pkg.version}`);
const notices = strFromU8(entries['extension/THIRD_PARTY_LICENSES.txt'] ?? new Uint8Array());
const pdfNotices = fs.readFileSync(path.join(root, 'native/pdf-third-party-licenses.txt'), 'utf8');
check(notices.includes(pdfNotices), 'retained PDF dependency notices missing or changed');
check(pdfNotices.includes('PDF WORKER THIRD-PARTY LICENCES') && pdfNotices.includes('alloc-stdlib 0.2.4') && pdfNotices.includes('Copyright (c) 2016 Dropbox, Inc.'), 'PDF licence inventory incomplete');
check(notices.includes(fs.readFileSync(path.join(root, 'native/duckdb-third-party-licenses.txt'), 'utf8')), 'bundled DuckDB C/C++ dependency notices missing or changed');
check(names.length > 60 && names.length < 4000, `unexpected file count ${names.length} (9 means the empty-package trap; required files are listed above)`);

// PKG-05: native workers. Real Mach-O arm64, executable, hash-bound, built without test switches,
// and carrying no build-machine paths.
function zipModes() { // zip central directory: name -> unix mode (fflate does not expose attributes)
  const modes = new Map();
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0, n = bytes.readUInt16LE(end + 10); i < n; i++) {
    const nameLen = bytes.readUInt16LE(at + 28), extraLen = bytes.readUInt16LE(at + 30), commentLen = bytes.readUInt16LE(at + 32);
    modes.set(bytes.toString('utf8', at + 46, at + 46 + nameLen), bytes.readUInt32LE(at + 38) >>> 16);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return modes;
}
const modes = zipModes();
const workerManifest = entries['extension/bin/workers.json'] ? JSON.parse(strFromU8(entries['extension/bin/workers.json'])) : null;
check(workerManifest?.platform === 'darwin-arm64', 'bin/workers.json missing or not darwin-arm64');
const FORBIDDEN_TEXT = ['DFV_TABLE_TEST_DOC', 'DFV_TEST_PUBLICATION_FAULT', 'DFV_TEST_PUBLICATION_PAUSE_MS'];
const BUILD_PATHS = /\/Users\/|\/private\/tmp|\/var\/folders|\.codex-work|\.cargo\/registry/;
for (const worker of ['dfv-table', 'dfv-mat', 'pdf/bin/dfv-pdf']) {
  const name = worker.startsWith('pdf/') ? `extension/media/${worker}` : `extension/bin/${worker}`;
  const data = entries[name] && Buffer.from(entries[name]);
  if (!data) { check(false, `missing worker ${name}`); continue; }
  check(data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === 0x0100000c, `${name} is not a Mach-O arm64 executable`);
  check(((modes.get(name) ?? 0) & 0o111) === 0o111, `${name} is not executable in the archive (mode ${(modes.get(name) ?? 0).toString(8)})`);
  if (!worker.startsWith('pdf/')) { // the qualified PDF worker is bound by native/pdf-mvp-assets.json instead
    const recorded = workerManifest?.workers?.[worker];
    check(recorded && recorded.bytes === data.length && recorded.sha256 === createHash('sha256').update(data).digest('hex'), `${name} differs from bin/workers.json`);
    if (process.env.DFV_WORKER_DIR) check(data.equals(fs.readFileSync(path.join(process.env.DFV_WORKER_DIR, worker))), `${name} differs from the built worker in DFV_WORKER_DIR`);
    for (const text of FORBIDDEN_TEXT) check(!data.includes(text), `${name} contains test switch ${text}`);
    const leaked = BUILD_PATHS.exec(data.toString('latin1'));
    check(!leaked, `${name} embeds a build-machine path: ${leaked?.[0]}`);
  }
}

// PKG-03: no tests, fixtures, docs, backups, drafts or source maps of our own.
for (const name of own) {
  check(!/^extension\/(test|out-test|docs|\.tmp|src|\.github|\.serena|native)\//.test(name), `development file shipped: ${name}`);
  check(!/\.(ts|map|vsix|duckdb|sqlite|db|xlsx|csv|parquet|arrows?|feather|dta|wal|bak|orig)$/i.test(name) || name.endsWith('.d.ts'), `data or build artifact shipped: ${name}`);
}
// Synthetic sentinels used by the security suites must never reach an artifact.
for (const name of own) {
  if (!/\.(js|json|css|html|md|txt)$/i.test(name)) continue;
  const text = strFromU8(entries[name]);
  check(!/SYNTHETIC_(SECRET|OUTSIDE|TOKEN|PASSWORD|REMOTE)/.test(text), `test sentinel inside ${name}`);
  // media/pdf is the hash-pinned qualified MVP (font-manifest.json records its build source); it is bound by native/pdf-mvp-assets.json.
  if (/^extension\/(dist|media|bin)\//.test(name) && !name.startsWith('extension/media/pdf/')) check(!/\/Users\/|\/private\/tmp|\.codex-work|dfv-resume|dfv-ui-native/.test(text), `development path inside ${name}`);
}
// PKG-01: dependencies resolve from the lockfile, not a developer's temp directory.
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
check(lock.version === pkg.version && lock.packages[''].version === pkg.version, 'package-lock.json version fields do not match package.json');
for (const [key, meta] of Object.entries(lock.packages)) {
  if (!key || meta.dev) continue;
  check(!meta.link && !(meta.resolved ?? '').startsWith('file:'), `production dependency resolved locally: ${key}`);
}

const size = bytes.length;
console.log(JSON.stringify({ vsix: path.basename(vsix), files: names.length, ownFiles: own.length, bytes: size, version: shipped.version }));
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('PKG checks passed');
