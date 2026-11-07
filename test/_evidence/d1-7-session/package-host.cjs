const {spawn}=require('node:child_process');
(async()=>{for(const [step,...command] of [
  ['package-build-01','npm','run','package'],
  ['package-check-01','npm','run','test:package'],
  ['installed-host-01','npm','run','test:host'],
]){const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['test/_evidence/d1-7-session/run-step.cjs',step,...command],{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>resolve(code??128));});if(code){process.exitCode=code;return;}}})().catch(e=>{console.error(e);process.exitCode=1;});
