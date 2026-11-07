// Runs one gate step: hashes source before/after, optionally holds the shared heavy-test lock via lock.sh.
// usage: node run-step.cjs <evidence-dir> <step> <lock|nolock> <command> [args...]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const LOCK_SH='/Users/macc/Desktop/Kod/.codex-work/pdf-resume-20261016/lock.sh';
const [dir,step,lockMode,command,...args]=process.argv.slice(2),out=path.resolve(dir,step);
function snapshot(){const names=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','src','test','package.json','package-lock.json','tsconfig.json','tsconfig.test.json'],{encoding:'utf8'}).trim().split('\n').filter(n=>n&&!n.startsWith('test/_evidence/')&&!n.split('/').includes('_work')&&fs.statSync(n,{throwIfNoEntry:false})?.isFile()).sort();return Object.fromEntries(names.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(n)).digest('hex')]));}
function run(cmd,a,fd){return new Promise((resolve,reject)=>{const c=spawn(cmd,a,{stdio:['ignore',fd??'inherit',fd??'inherit'],detached:process.platform!=='win32'});const timeout=setTimeout(()=>{if(c.pid){if(process.platform==='win32')c.kill('SIGKILL');else process.kill(-c.pid,'SIGKILL');}},30*60*1000);c.on('error',e=>{clearTimeout(timeout);reject(e);});c.on('exit',code=>{clearTimeout(timeout);resolve(code??128);});});}
(async()=>{
  fs.mkdirSync(out);const before=snapshot();fs.writeFileSync(path.join(out,'source-before.json'),JSON.stringify(before,null,2)+'\n');
  const locked=lockMode==='lock';
  if(locked&&await run(LOCK_SH,['acquire','D17',`D1.7 ${step}`]))throw new Error('lock acquire failed');
  let code;
  try{
    fs.writeFileSync(path.join(out,'command.json'),JSON.stringify({cwd:process.cwd(),command:[command,...args],locked,started:new Date().toISOString()},null,2)+'\n');
    const fd=fs.openSync(path.join(out,'output.log'),'wx');
    try{code=await run(command,args,fd);}finally{fs.closeSync(fd);}
  }finally{if(locked)await run(LOCK_SH,['release','D17']);}
  const after=snapshot();fs.writeFileSync(path.join(out,'source-after.json'),JSON.stringify(after,null,2)+'\n');
  const unchanged=JSON.stringify(before)===JSON.stringify(after);
  const log=fs.readFileSync(path.join(out,'output.log'),'utf8'),counts={};
  for(const k of ['tests','pass','fail','cancelled','skipped','todo']){const m=[...log.matchAll(new RegExp(`^ℹ ${k} (\\d+)$`,'gm'))];if(m.length)counts[k]=m.reduce((s,x)=>s+Number(x[1]),0);}
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({finished:new Date().toISOString(),exit:code,source_unchanged:unchanged,log_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(out,'output.log'))).digest('hex'),counts},null,2)+'\n');
  process.exitCode=code||(!unchanged?1:0);
})().catch(e=>{console.error(e);process.exitCode=1;});
