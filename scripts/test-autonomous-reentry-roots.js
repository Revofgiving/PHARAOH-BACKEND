'use strict';
// Replaces the obsolete receiver-owned-HUMAN fixture. Original is preserved in
// evidence/legacy-tests-5oct. Runs the real funded materializer, not PostgreSQL.
const assert=require('node:assert/strict'),Module=require('node:module');
const A=require('../economic-amounts'),{EconomicLedger}=require('../economic-ledger');
const {EconomicFlow}=require('../economic-flow'),{S0Materializer}=require('../s0-materializer');
const {MemoryHarness,memoryPlacement}=require('./support/economic-memory-store');
const reentry=require('../reentry-manager');
const T='0x'+'1'.repeat(40),F='0x'+'2'.repeat(40),U='0x'+'3'.repeat(40),P='0x'+'4'.repeat(40);
const config={treasuryWallet:T,fundAWallet:F,projectsWallet:P};
const original=Module._load;let activeFlow=null,cases=0;
Module._load=function(name,parent,main){if(name==='./economic-flow'&&parent?.filename.endsWith('/reentry-manager.js'))return {configuredFlow(client){assert.ok(client);assert.ok(activeFlow);return activeFlow;}};return original.call(this,name,parent,main);};
async function scenario(level,type){
 const h=new MemoryHarness({human:30n}),id='9000',key=`${level}:${type}`;
 h.data.nextAccount=100;
 h.data.accounts.set(id,{id,wallet:U,tipo:type,sigla:'23.1'});
 h.data.economics.set(id,{account_id:id,root_account_id:'23',position_class:'HUMAN',owner_wallet:U,custody_wallet:U});
 const bucket=level==='THOT'?'L4_TURN:1':'L5_TURN:1';
 h.data.buckets.set(bucket,{bucket_key:bucket,wallet:T,purpose:'TURN',metadata:{},balance_atomic:A.usdc(level==='THOT'?'15000':'30000').toString()});
 async function run(fn){return h.transaction(async store=>{const ledger=new EconomicLedger(store,config);activeFlow=new EconomicFlow({ledger,materializer:new S0Materializer({ledger,placement:memoryPlacement(h),config}),config});return fn(activeFlow);});}
 await run(f=>f.planExit({eventKey:key,level,turn:{id:1,numero_turno:1,sacerdoti_entrati:3,sacerdoti_necessari:3},account:h.data.accounts.get(id)}));
 const input={source:level+'_REENTRY',eventKey:key,sourceAccountId:id,count:level==='THOT'?5:50,client:{fixture:true}};
 const result=await run(()=>reentry.materializzaRientriEntrata(input));
 assert.equal(result.length,input.count);assert.equal(new Set(result.map(p=>p.accountId)).size,input.count);
 assert.equal(new Set(result.map(p=>p.numeroPosizionale)).size,input.count);
 for(const row of result){const e=h.data.economics.get(String(row.accountId));assert.equal(e.root_account_id,String(row.accountId));assert.notEqual(e.root_account_id,'23');assert.equal(row.automaticReceiverReentry,false);assert.ok(row.tavolaPersonale.id);assert.ok(row.ownerWallet===null||row.ownerWallet===F);assert.notEqual(row.ownerWallet,U);const n=BigInt(row.numeroPosizionale);assert.ok(n<26n||(n-26n)%14n!==0n);}
 assert.equal(h.data.counters.human_cumulative,'30');assert.equal(result.filter(x=>x.positionClass==='PILETTA').length,Math.min(input.count,30));cases++;
 const before=structuredClone(h.data);assert.deepEqual(await run(()=>reentry.materializzaRientriEntrata(input)),result);assert.deepEqual(h.data,before);cases++;
 await assert.rejects(run(()=>reentry.materializzaRientriEntrata({...input,count:input.count+1})),/QUOTA_INVALID/);cases++;
}
(async()=>{await assert.rejects(reentry.materializzaRientriEntrata({}),/TRANSACTION_REQUIRED/);cases++;for(const level of ['THOT','ISIDE'])for(const type of ['PERPETUO','GEMELLO'])await scenario(level,type);console.log(JSON.stringify({test:'autonomous-system-roots',status:'PASS',cases,scope:'actual funding/flow/materializer/wrapper with memory storage; no receiver-owned automatic HUMAN roots, no PostgreSQL'}));})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{Module._load=original;});
