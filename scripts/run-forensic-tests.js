'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
function classify(run){
  if(run.status===0&&!run.error)return 'PASS';
  if(run.error?.code==='ETIMEDOUT')return 'TIMEOUT';
  if(/Cannot find module|ERR_MODULE_NOT_FOUND/.test((run.stdout||'')+(run.stderr||'')))return 'BLOCKED_DEPENDENCY';
  return 'FAIL';
}
function run(){
  const LEGACY_NON_CURRENT=new Set(['test-pharaoh-registry-v3.js']);
  const tests=fs.readdirSync(path.join(ROOT,'scripts')).filter(n=>/^test-.*\.js$/.test(n)&&!LEGACY_NON_CURRENT.has(n)).sort();
  const results=[];
  for(const name of tests){
    const start=Date.now();const r=spawnSync(process.execPath,[path.join(ROOT,'scripts',name)],{cwd:ROOT,encoding:'utf8',env:{...process.env,NODE_ENV:'test'},timeout:30000,maxBuffer:8*1024*1024});
    const status=classify(r);console.log(`\n=== ${name} ===`);process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');console.log(`RESULT=${status}`);
    const record={name,status,exitCode:r.status,durationMs:Date.now()-start,signal:r.signal||null};results.push(record);
    if(process.env.PHARAOH_TEST_LOG_DIR)fs.writeFileSync(path.join(process.env.PHARAOH_TEST_LOG_DIR,name+'.log'),(r.stdout||'')+(r.stderr||''),{flag:'wx',mode:0o600});
  }
  const counts=Object.fromEntries(['PASS','FAIL','BLOCKED_DEPENDENCY','TIMEOUT'].map(s=>[s,results.filter(r=>r.status===s).length]));
  const report={version:1,node:process.version,total:results.length,counts,allPassed:results.length>0&&results.every(r=>r.status==='PASS'),scope:'Local source/unit/mock tests; not live PostgreSQL, ERC20 settlement or deployment',results};
  if(process.env.PHARAOH_TEST_REPORT)fs.writeFileSync(process.env.PHARAOH_TEST_REPORT,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(`FINAL_TESTS=${report.allPassed?'PASS':'NOT_PASS'} ${JSON.stringify(counts)} total=${results.length}`);if(!report.allPassed)process.exitCode=1;
}
if(require.main===module){try{run();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={classify};
