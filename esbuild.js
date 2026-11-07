const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const minify = !watch;

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode', '@duckdb/node-api'],
  minify,
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/webview.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/webview.js',
  minify,
  sourcemap: true,
};

// The chart's own webview, and its own bundle on purpose: ECharts is ~530 KB
// and only this entry point needs it, so keeping it out of webview.js means
// the grid does not pay for a library it never calls.
/** @type {import('esbuild').BuildOptions} */
const chartViewConfig = {
  entryPoints: ['src/chartView.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/chartView.js',
  minify,
  sourcemap: true,
};

// The PDF editor's UI and worker come from a prebuilt bundle (web/static, ui, bin/dfv-pdf), copied to media/pdf.
// Explicit bundles carry their own manifest. The retained local MVP uses a versioned
// pin, so a missing/stale asset fails before the working assets are replaced.
const LOCAL_PDF_BUNDLE = require('node:path').resolve(__dirname, 'media/pdf');
const LOCAL_PDF_MANIFEST = require('node:path').resolve(__dirname, 'native/pdf-mvp-assets.json');
const requirePdf = process.argv.includes('--require-pdf') || process.env.DFV_PDF_REQUIRED === '1';

function copyPdfBundle() {
  const fs = require('fs');
  const src = process.env.DFV_PDF_BUNDLE || LOCAL_PDF_BUNDLE;
  const manifestPath = process.env.DFV_PDF_BUNDLE ? `${src}/manifest.json` : LOCAL_PDF_MANIFEST;
  if (!process.env.DFV_PDF_BUNDLE && !fs.existsSync(manifestPath)) throw new Error('PDF bundle pin missing: native/pdf-mvp-assets.json');
  const parts = [ 'web/static/index.html', 'web/static/viewer.js', 'bin/dfv-pdf', 'ui/nativeTransport.js', 'licenses/OFL-Inter.txt', 'licenses/font-manifest.json'];
  const missing = parts.filter((p) => !fs.existsSync(`${src}/${p}`));
  if (!fs.existsSync(manifestPath)) missing.push('manifest.json');
  if (missing.length) {
    const stale = fs.existsSync('media/pdf/bin/dfv-pdf') ? 'a previously generated media/pdf is left as is (possibly stale)' : 'media/pdf does not exist, so the PDF editor will report its engine as missing';
    const msg = `PDF bundle ${fs.existsSync(src) ? 'incomplete' : 'not found'} at ${src} (missing: ${missing.join(', ')}). Set DFV_PDF_BUNDLE to a directory containing ${parts.join(', ')}.`;
    if (requirePdf || !process.env.DFV_PDF_BUNDLE) throw new Error(`${msg} Refusing to build a package without the PDF editor.`);
    console.warn(`\n!!! WARNING: ${msg}\n!!! ${stale}.\n`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported PDF bundle manifest');
  const records = new Map(manifest.files.map(file => [file.path, file]));
  if (records.size !== manifest.files.length) throw new Error('Duplicate PDF bundle manifest entries');
  const verified = new Set();
  // Check every copied byte before replacing the working assets, including files added to a directory.
  function verify(name) {
    const file = `${src}/${name}`;
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file)) verify(`${name}/${child}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`PDF bundle asset is not a regular file: ${name}`);
    const record = records.get(name);
    const bytes = fs.readFileSync(file);
    if (!record || record.bytes !== bytes.length || record.sha256 !== require('node:crypto').createHash('sha256').update(bytes).digest('hex')) {
      throw new Error(`PDF bundle integrity check failed: ${name}`);
    }
    verified.add(name);
  }
  for (const name of ['web/static', 'bin', 'licenses', 'ui/nativeTransport.js']) verify(name);
  for (const name of records.keys()) {
    if (/^(web\/static\/|bin\/|licenses\/|ui\/nativeTransport\.js$)/.test(name) && !verified.has(name)) {
      throw new Error(`PDF bundle asset missing: ${name}`);
    }
  }
  if (require('node:path').resolve(src) === require('node:path').resolve('media/pdf')) {
    console.log('PDF retained MVP verified against native/pdf-mvp-assets.json');
    return;
  }
  fs.rmSync('media/pdf', { recursive: true, force: true });
  // only what the extension runs: shared UI, the transport shim and the worker (not the Chrome harness files)
  for (const d of ['web/static', 'bin', 'licenses']) fs.cpSync(`${src}/${d}`, `media/pdf/${d}`, { recursive: true });
  fs.cpSync(`${src}/ui/nativeTransport.js`, 'media/pdf/ui/nativeTransport.js');
  fs.chmodSync('media/pdf/bin/dfv-pdf', 0o755); // the worker is spawned directly; the source copy may be 0700
  console.log(`PDF bundle copied from ${src}`);
}

async function main() {
  copyPdfBundle();
  const configs = [extensionConfig, webviewConfig, chartViewConfig, { ...webviewConfig, entryPoints: ['src/features/mat/view.ts'], outfile: 'dist/matView.js' }, {
    ...extensionConfig,
    entryPoints: ['src/queryWorkerEntry.ts'],
    outfile: 'dist/queryWorkerEntry.js',
  }];
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('watching for changes...');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    console.log('build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
