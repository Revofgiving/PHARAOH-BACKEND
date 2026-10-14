'use strict';
const assert=require('node:assert/strict'),Module=require('node:module');
const A=require('../economic-amounts'),{EconomicLedger}=require('../economic-ledger'),{EconomicFlow}=require('../economic-flow'),{S0Materializer}=require('../s0-materializer');
const {MemoryHarness,memoryPlacement}=require('./support/economic-memory-store');
const T='0x'+'1'.repeat(40),PAYER='0x'+'2'.repeat(40),B='0x'+'3'.repeat(40),F='0x'+'4'.repeat(40),TOKEN='0x'+'5'.repeat(40);
const cfg={treasuryWallet:T,fundAWallet:F,token:TOKEN,chainId:'137',minConfirmations:2};
(async()=>{let cases=0;
 for(const [canonical,alias] of [['URANUS_TO_PHARAOH','URANUS'],['ROG_TO_PHARAOH','ROG'],['DIRECT','DIRECT'],['GIFT','GIFT']]){
  const h=new MemoryHarness(),txHash='0x'+'a'.repeat(64),proof={txHash,from:PAYER,to:T,amountBaseUnits:'300000000',tokenContract:TOKEN,chainId:'137',blockNumber:100,blockHash:'0x'+'b'.repeat(64),confirmations:5,transferLogIndexes:[0]};
  const execute=origin=>h.transaction(store=>{const ledger=new EconomicLedger(store,cfg),flow=new EconomicFlow({ledger,config:cfg,materializer:new S0Materializer({ledger,placement:memoryPlacement(h),config:cfg})});return flow.admitExternal({eventKey:'ORIGIN_FIXTURE',origin,payer:PAYER,beneficiaryWallet:B,count:3,txHash,proof});});
  const result=await execute(canonical);assert.equal(result.positions.length,3);assert.equal(new Set(result.positions.map(p=>p.accountId)).size,3);assert(result.positions.every(p=>p.origin===canonical&&p.ownerWallet===B));assert.equal(h.data.counters.human_cumulative,'3');assert.equal(h.data.proofs.size,1);cases++;
  const snapshot=structuredClone(h.data);assert.deepEqual(await execute(alias),result);assert.deepEqual(h.data,snapshot);cases++;
  for(const invalid of ['THOT','ISIDE','PILETTA_REINVESTMENT','LEGACY','rog','URANUS_TO_PHARAOH ',null]){await assert.rejects(execute(invalid));assert.deepEqual(h.data,snapshot);}cases++;
 }
 // A rule for counting future HUMAN origins must NOT enable the ROG receiver.
 const original=Module._load;let inbound;
 try{Module._load=function(request,parent,isMain){if(parent?.filename?.endsWith('cross-entry-manager.js')&&request.startsWith('./'))return {};return original.call(this,request,parent,isMain);};inbound=require('../cross-entry-manager');}finally{Module._load=original;}
 assert.equal(inbound.SOURCE,'URANUS_TO_PHARAOH');assert.throws(()=>inbound.normalizePayload({origine:'ROG'}),e=>e.code==='CROSS_SOURCE_FORBIDDEN');cases++;
 console.log(JSON.stringify({test:'external-origin-runtime',status:'PASS',cases,scope:'actual flow->ledger->materializer with synthetic proofs/memory placement; receiver admission guard checked, NO real database or remote receiver'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
