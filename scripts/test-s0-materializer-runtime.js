'use strict';
const assert=require('node:assert/strict');
const A=require('../economic-amounts');
const {EconomicLedger}=require('../economic-ledger');
const {S0Materializer}=require('../s0-materializer');
const {MemoryHarness,memoryPlacement}=require('./support/economic-memory-store');
const T='0x'+'1'.repeat(40),F='0x'+'2'.repeat(40),U='0x'+'3'.repeat(40),TOKEN='0x'+'4'.repeat(40);
const cfg={token:TOKEN,chainId:'137',minConfirmations:2};
function seedBucket(h,key,purpose,value){h.data.buckets.set(key,{bucket_key:key,wallet:T,purpose,metadata:{},balance_atomic:A.usdc(String(value)).toString()});}
function seedSource(h,id='10000',type='GEMELLO',positionClass='HUMAN'){
 h.data.accounts.set(id,{id,tipo:type,wallet:positionClass==='PILETTA'?T:U});
 h.data.economics.set(id,{account_id:id,root_account_id:id,position_class:positionClass,owner_wallet:positionClass==='PILETTA'?null:U,custody_wallet:positionClass==='PILETTA'?T:U});
}
async function main(){let cases=0;
 async function testBatch({h,p,value,source,sourceLevel,expectedP,expectedA,type='GEMELLO',cls='HUMAN'}) {
  const harness=new MemoryHarness({human:BigInt(h),piletta:BigInt(p)});seedSource(harness,'10000',type,cls);seedBucket(harness,'GEN','GENERATED_S0',value);
  const args={eventKey:'GENERATE:one',source,sourceAccountId:'10000',sourceLevel,amountAtomic:A.usdc(String(value)),fundingBucket:'GEN'};
  const run=failAt=>harness.transaction(store=>new S0Materializer({ledger:new EconomicLedger(store,cfg),placement:memoryPlacement(harness,{failAt}),config:{treasuryWallet:T,fundAWallet:F}}).generated(args));
  const r=await run();assert.equal(r.pilettaCreated,String(expectedP));assert.equal(r.fondoACreated,String(expectedA));assert.equal(r.positions.length,expectedP+expectedA);
  assert.equal(new Set(r.positions.map(x=>x.accountId)).size,r.positions.length);assert.equal(new Set(r.positions.map(x=>x.number)).size,r.positions.length);
  assert(r.positions.every(x=>x.number<26||(x.number-26)%14!==0));
  assert(r.positions.filter(x=>x.positionClass==='FONDO_A').every(x=>x.ownerWallet===F));assert(r.positions.filter(x=>x.positionClass==='PILETTA').every(x=>x.ownerWallet===null));
  assert.equal(harness.data.counters.human_cumulative,String(h));assert.equal(harness.data.counters.piletta_cumulative,String(p+expectedP));assert.equal(harness.data.buckets.get('GEN').balance_atomic,'0');
  const before=structuredClone(harness.data);assert.deepEqual(await run(),r);assert.deepEqual(harness.data,before);cases+=2;
 }
 await testBatch({h:1000,p:1000,value:6000,source:'PILETTA_REINVESTMENT',sourceLevel:'RHA',expectedP:0,expectedA:60,type:'PRIMARIO',cls:'PILETTA'});
 await testBatch({h:1000,p:970,value:5000,source:'ISIDE',sourceLevel:'ISIDE',expectedP:30,expectedA:20});
 await testBatch({h:10,p:0,value:500,source:'THOT',sourceLevel:'THOT',expectedP:5,expectedA:0});
 await testBatch({h:10,p:10,value:500,source:'THOT',sourceLevel:'THOT',expectedP:0,expectedA:5});
 const rollback=new MemoryHarness({human:100n});seedSource(rollback);seedBucket(rollback,'GEN','GENERATED_S0',5000);const before=structuredClone(rollback.data);
 await assert.rejects(rollback.transaction(store=>new S0Materializer({ledger:new EconomicLedger(store,cfg),placement:memoryPlacement(rollback,{failAt:17}),config:{treasuryWallet:T,fundAWallet:F}}).generated({eventKey:'FAIL',source:'ISIDE',sourceAccountId:'10000',sourceLevel:'ISIDE',amountAtomic:A.usdc('5000'),fundingBucket:'GEN'})),/INJECTED_MID_BATCH/);assert.deepEqual(rollback.data,before);cases++;
 const concurrent=new MemoryHarness({human:10n});seedSource(concurrent);seedBucket(concurrent,'G1','GENERATED_S0',5000);seedBucket(concurrent,'G2','GENERATED_S0',5000);
 const runs=[1,2].map(n=>concurrent.transaction(store=>new S0Materializer({ledger:new EconomicLedger(store,cfg),placement:memoryPlacement(concurrent),config:{treasuryWallet:T,fundAWallet:F}}).generated({eventKey:`CONCURRENT:${n}`,source:'ISIDE',sourceAccountId:'10000',sourceLevel:'ISIDE',amountAtomic:A.usdc('5000'),fundingBucket:`G${n}`})));
 const result=await Promise.all(runs);assert.equal(result.reduce((n,r)=>n+Number(r.pilettaCreated),0),10);assert.equal(concurrent.data.positions.length,100);assert.equal(concurrent.data.counters.piletta_cumulative,'10');cases++;
 for(const origin of ['DIRECT','GIFT','ROG_TO_PHARAOH','URANUS_TO_PHARAOH']) {
  const human=new MemoryHarness();seedBucket(human,'EXTERNAL','EXTERNAL_ENTRY',200);
  const r=await human.transaction(store=>new S0Materializer({ledger:new EconomicLedger(store,cfg),placement:memoryPlacement(human),config:{treasuryWallet:T,fundAWallet:F}}).external({eventKey:`EXTERNAL:${origin}`,origin,beneficiaryWallet:U,count:2,fundingBucket:'EXTERNAL'}));
  assert.equal(human.data.counters.human_cumulative,'2');assert.notEqual(r.positions[0].accountId,r.positions[1].accountId);cases++;
 }
 const missing=new MemoryHarness({human:10n});seedSource(missing);await assert.rejects(missing.transaction(store=>new S0Materializer({ledger:new EconomicLedger(store,cfg),placement:memoryPlacement(missing),config:{treasuryWallet:T,fundAWallet:F}}).generated({eventKey:'NO_FUNDS',source:'THOT',sourceAccountId:'10000',sourceLevel:'THOT',amountAtomic:A.usdc('500'),fundingBucket:'MISSING'})),/FUNDING_RESERVE_REQUIRED/);assert.equal(missing.data.positions.length,0);cases++;
 console.log(JSON.stringify({test:'s0-materializer-runtime',status:'PASS',cases,scope:'real service, memory repository and placement double; not PostgreSQL/E2E'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
