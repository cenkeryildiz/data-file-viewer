import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(__dirname, '../..');
const worker = process.env.DFV_TABLE_WORKER;

/** A fresh process proves cold initialization, rather than an already cached dependency. */
function deniedRuntime(source: string, suffix: string, env = process.env) {
  const script = `
    const assert=require('node:assert/strict');
    require(${JSON.stringify(path.join(root, 'out-test/test/stress/stubs/vscode.js'))});
    const Module=require('node:module'), load=Module._load, denied=[];
    Module._load=function(name,...args){
      if(/^(?:@duckdb\\/|apache-arrow(?:\\/|$)|xlsx(?:\\/|$))/.test(name)){denied.push(name);throw new Error('DENIED Node data processor '+name);}
      return load.call(this,name,...args);
    };
    const extension=new Module(${JSON.stringify(path.join(root, 'dist/extension.js'))});
    extension.filename=${JSON.stringify(path.join(root, 'dist/extension.js'))};
    extension.paths=Module._nodeModulePaths(${JSON.stringify(root)});
    const vscode=require(${JSON.stringify(path.join(root, 'out-test/test/stress/stubs/vscode.js'))}).default;
    vscode.EventEmitter=class {event=()=>({dispose(){}});fire(){}dispose(){}};
    extension._compile(require('node:fs').readFileSync(0,'utf8'),extension.filename);
    const subscriptions=[];
    extension.exports.activate({extensionPath:${JSON.stringify(root)},extensionUri:vscode.Uri.file(${JSON.stringify(root)}),globalStorageUri:vscode.Uri.file('/unused-test-storage'),subscriptions});
    ${suffix}
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, input: source, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stderr ?? ''}${result.stdout ?? ''}`);
  assert.equal(result.signal, null);
  return result.stdout;
}
async function bundle() {
  const result = await build({ entryPoints: [path.join(root, 'src/extension.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode', '@duckdb/node-api'], metafile: true });
  return result.outputFiles[0].text;
}

test('cold native activation does not load Node data processors without a backend override', async () => {
  const env = { ...process.env }; delete env.DFV_BACKEND;
  const output = deniedRuntime(await bundle(), `assert.equal(denied.length,0); console.log('cold native activation PASS');`, env);
  assert.match(output, /cold native activation PASS/);
});

test('actual default native provider reads offline with Node processors denied and no fallback on a missing worker', { skip: !worker ? 'set DFV_TABLE_WORKER for actual default-native qualification' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-default-')), file = path.join(dir, 'rows.csv');
  const original = 'id,name\n1,alpha\n'; fs.writeFileSync(file, original);
  const env = { ...process.env }; delete env.DFV_BACKEND;
  try {
    const output = deniedRuntime(await bundle(), `
      (async()=>{
        const {selectBackend}=require(${JSON.stringify(path.join(root, 'out-test/src/backend/nativeSelect.js'))});
        const {nativeWorkerUsage}=require(${JSON.stringify(path.join(root, 'out-test/src/native/supervisor.js'))});
        assert.equal(nativeWorkerUsage().workers.length,0);
        const backend=selectBackend(${JSON.stringify(root)},{DFV_TABLE_WORKER:${JSON.stringify(worker)}});
        const file=await backend.open(${JSON.stringify(file)});
        try{assert.deepEqual(nativeWorkerUsage().workers.map(worker=>worker.feature),['table']);assert.equal(file.constructor.name,'NativeDocument');assert.deepEqual((await file.runQuery('select * from rows')).rows,[['1','alpha']]);}
        finally{await file.close();}
        assert.equal(nativeWorkerUsage().workers.length,0);
        await assert.rejects(selectBackend('/missing-extension',{}).open(${JSON.stringify(file)}),e=>e.code==='worker_exited');
        assert.deepEqual(denied,[]);extension.exports.deactivate();console.log('actual default native offline PASS');
      })().catch(e=>{console.error(e);process.exitCode=1});
    `, env);
    assert.match(output, /actual default native offline PASS/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
