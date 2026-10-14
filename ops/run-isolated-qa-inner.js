'use strict';
/** Runs only inside the disposable QA container with no production secrets. */
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
function main(){
 if(process.env.PHARAOH_QA_ACK!=='ISOLATED_NO_PRODUCTION')throw new Error('QA_CONTAINER_ACK_REQUIRED');
 if(process.env.DATABASE_URL)throw new Error('QA_APPLICATION_DATABASE_FORBIDDEN');
 if(Object.keys(process.env).some(k=>/(PRIVATE_KEY|SEED_PHRASE|MNEMONIC)$/.test(k)&&process.env[k]))throw new Error('QA_PRODUCTION_SECRET_FORBIDDEN');
 const out='/evidence',root=path.resolve(__dirname,'..'),env={...process.env,NODE_ENV:'test'};
 fs.mkdirSync(path.join(out,'test-logs'),{recursive:false});
 const steps=[
  ['dependencies',process.execPath,['ops/dependency-preflight.js'],30000],
  ['unit',process.execPath,['scripts/run-forensic-tests.js'],240000],
  ['migration-plan',process.execPath,['ops/db-migrate.js','plan'],30000],
  ['postgres-conservation',process.execPath,['scripts/rehearse-postgres-economy.js'],120000],
  ['postgres-concurrency',process.execPath,['scripts/rehearse-postgres-concurrency.js'],120000]
 ];
 const results=[];for(const [name,cmd,args,timeout] of steps){const start=Date.now();const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',timeout,maxBuffer:16*1024*1024,env:{...env,PHARAOH_TEST_REPORT:path.join(out,'tests.json'),PHARAOH_TEST_LOG_DIR:path.join(out,'test-logs')}});fs.writeFileSync(path.join(out,name+'.log'),(r.stdout||'')+(r.stderr||''),{flag:'wx',mode:0o600});const record={name,exitCode:r.status,error:r.error?.code||null,signal:r.signal||null,durationMs:Date.now()-start,passed:r.status===0&&!r.error};results.push(record);console.log(JSON.stringify(record));}
 const allPassed=results.every(x=>x.passed);fs.writeFileSync(path.join(out,'qa-summary.json'),JSON.stringify({version:1,node:process.version,allExecutedChecksPassed:allPassed,deployable:false,productionAccessed:false,realTransfers:0,results,notCertified:['PRODUCTION_DATABASE_ADOPTION','FULL_STRUCTURAL_MULTI_TURN_PROGRESSION','ACTUAL_ROG_URANUS_RECEIVERS','LIVE_CHAIN']},null,2)+'\n',{flag:'wx',mode:0o600});if(!allPassed)process.exitCode=1;
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={main};
