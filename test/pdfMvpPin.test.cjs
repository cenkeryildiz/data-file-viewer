// Pin failures must stop the actual build entry before existing PDF assets are replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const fault of ['missing pin', 'malformed pin', 'wrong hash']) {
  test(`PDF retained MVP rejects ${fault} and preserves assets`, () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-pdf-pin-'));
    try {
      fs.copyFileSync(path.join(root, 'esbuild.js'), path.join(sandbox, 'esbuild.js'));
      const parts = ['web/static/index.html', 'web/static/viewer.js', 'bin/dfv-pdf', 'ui/nativeTransport.js', 'licenses/OFL-Inter.txt', 'licenses/font-manifest.json'];
      for (const name of parts) {
        const target = path.join(sandbox, 'media/pdf', name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, name === 'bin/dfv-pdf' ? 'previous worker' : 'asset');
      }
      fs.mkdirSync(path.join(sandbox, 'native'));
      if (fault !== 'missing pin') fs.writeFileSync(path.join(sandbox, 'native/pdf-mvp-assets.json'), fault === 'malformed pin' ? '{' : JSON.stringify({ format: 1, files: [{ path: 'bin/dfv-pdf', bytes: 15, sha256: 'bad' }] }));
      const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules') };
      delete env.DFV_PDF_BUNDLE;
      const result = spawnSync(process.execPath, ['esbuild.js'], { cwd: sandbox, env, encoding: 'utf8', timeout: 10000 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${fault}: ${result.stderr}`);
      assert.match(result.stderr, fault === 'missing pin' ? /PDF bundle pin missing/ : fault === 'malformed pin' ? /SyntaxError/ : /PDF bundle integrity check failed/);
      assert.equal(fs.readFileSync(path.join(sandbox, 'media/pdf/bin/dfv-pdf'), 'utf8'), 'previous worker');
    } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
  });
}
