'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const expected='8ff7bfca0a5cf1feb65896a6cafcd7f0364c0879051f28f4191ec80e11f2cde7';
if(!path.basename(root).includes('NON_DEPLOY')) throw new Error('STOP: non isolated NON_DEPLOY directory');
const source=fs.readFileSync(path.join(root,'pharaoh-registry-manager.js'));
const sha=crypto.createHash('sha256').update(source).digest('hex');
if(sha!==expected) throw new Error('STOP: Registry digest mismatch '+sha);
const env={NODE_ENV:'test',PATH:process.env.PATH||'',HOME:process.env.HOME||'',TMPDIR:process.env.TMPDIR||'/tmp'};
const jobs=[
 ['hardening','scripts/test-registry-recovery-hardening.js'],
 ['registry-v4','scripts/test-pharaoh-registry-v4.js'],
 ['subwallet-v4','scripts/test-subwallet-registry-wiring.js'],
 ['forensic-53-plus','scripts/run-forensic-tests.js']
];
const results=[];
for(const [name,file] of jobs){
 const r=spawnSync(process.execPath,[file],{cwd:root,env,encoding:'utf8',timeout:name==='forensic-53-plus'?900000:90000,maxBuffer:20*1024*1024});
 const out=(r.stdout||'')+(r.stderr||'');
 const passed=r.status===0&&!r.error;
 results.push({name,passed,status:r.status,error:r.error?String(r.error):null,tail:out.slice(-7000)});
 console.log(name+': '+(passed?'PASS':'FAIL'));
 if(name==='forensic-53-plus')console.log((out.match(/FINAL_TESTS=[^\n]*/)||[])[0]||'FINAL_TESTS_NOT_FOUND');
 if(!passed)console.log(out.slice(-1500));
}
const report={status:'NON_DEPLOY',registrySha256:sha,producedAt:new Date().toISOString(),results,allPassed:results.every(x=>x.passed)};
const target=path.join(root,'REGISTRY_V2_QA_LOCAL_RESULTS.json');
if(fs.existsSync(target))throw new Error('STOP: report already exists; preserve previous report');
fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log('REPORT='+target);
console.log('FINAL='+ (report.allPassed?'PASS':'NON_CERTIFICATO'));
if(!report.allPassed)process.exitCode=1;
