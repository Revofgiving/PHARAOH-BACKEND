'use strict';
const assert=require('node:assert/strict');
const A=require('../economic-amounts');
const {EconomicLedger}=require('../economic-ledger');
const {TransferDispatcher}=require('../treasury-transfer-manager');
const {MemoryHarness}=require('./support/economic-memory-store');
const T='0x'+'1'.repeat(40),G='0x'+'2'.repeat(40),P='0x'+'3'.repeat(40),U='0x'+'4'.repeat(40),TOKEN='0x'+'5'.repeat(40);
const cfg={treasuryWallet:T,gemelliWallet:G,projectsWallet:P,token:TOKEN,chainId:'137',minConfirmations:2};
const hash=n=>'0x'+String(n).padStart(64,'0');
async function setup({from=T,to=U,purpose='PAYOUT_RHA',amount='1000',settled='1000',destination='0'}={}) {
 const h=new MemoryHarness();h.data.buckets.set('RESERVE',{bucket_key:'RESERVE',wallet:from,purpose,metadata:{},balance_atomic:A.usdc(amount).toString()});
 if(from===P)h.data.buckets.set('PROJECTS:STRUCTURAL_CAPITAL',{bucket_key:'PROJECTS:STRUCTURAL_CAPITAL',wallet:P,purpose:'PROJECTS_STRUCTURAL_CAPITAL',metadata:{},balance_atomic:A.usdc('100').toString()});
 let signTail=Promise.resolve();
 const repo={
  transaction:fn=>h.transaction(async store=>structuredClone(await fn({ledger:new EconomicLedger(store,cfg),store}))),
  async withSignerLock(fn){const old=signTail;let done;signTail=new Promise(r=>done=r);await old;try{return await fn();}finally{done();}}
 };
 await repo.transaction(({ledger})=>ledger.prepareMovement({key:'SEND',reserveBucket:'RESERVE',to,amountAtomic:A.usdc(amount),purpose}));
 const state={signs:0,broadcasts:0,verified:false,known:false,source:A.usdc(settled),destination:A.usdc(destination),failure:false,preflightFailure:false};
 const chain={
  async sign(){state.signs++;return {txHash:hash(101),raw:'0xab12',nonce:7,chainId:'137',token:TOKEN};},
  async preflightSigned(){if(state.preflightFailure)throw A.error('SIGNED_NONCE_RECONCILIATION_REQUIRED');},
  async knownTransaction(){return state.known;},
  async balances(){return {sourceAtomic:state.source,destinationAtomic:state.destination};},
  async broadcast(){state.broadcasts++;const row=h.data.movements.get('SEND');assert.equal(row.status,'SUBMITTED');assert(row.broadcast_attempted_at);assert.equal(row.signed_raw_tx,'0xab12');assert.equal(row.tx_hash,hash(101));if(state.failure)throw new Error('NETWORK_TIMEOUT');state.known=true;return {hash:hash(101)};},
  async verify(m){if(!state.verified)return null;return {valida:true,proof:{txHash:m.tx_hash,from:m.source_wallet,to:m.destination_wallet,amountBaseUnits:m.amount_atomic,chainId:'137',tokenContract:TOKEN,blockNumber:'100',blockHash:hash(900),confirmations:'10',transferLogIndexes:[2]}};}
 };
 return {h,repo,state,chain,dispatcher:new TransferDispatcher({repository:repo,chain,config:cfg})};
}
async function main(){let cases=0;
 let f=await setup();const pending=await f.dispatcher.run('SEND');assert.equal(pending.confirmed,false);assert.equal(f.state.signs,1);assert.equal(f.state.broadcasts,1);cases++;
 await f.dispatcher.run('SEND');await f.dispatcher.run('SEND');assert.equal(f.state.broadcasts,1);assert.equal(f.state.signs,1);cases++;
 f.state.verified=true;f.state.source=0n;const confirmed=await f.dispatcher.run('SEND');assert.equal(confirmed.confirmed,true);assert.equal(f.h.data.buckets.get('RESERVE').balance_atomic,'0');assert.equal(f.state.broadcasts,1);cases++;
 assert.deepEqual(await f.dispatcher.run('SEND'),confirmed);cases++;
 f=await setup();f.state.failure=true;await assert.rejects(f.dispatcher.run('SEND'),/RECONCILIATION_REQUIRED/);assert.equal(f.h.data.movements.get('SEND').status,'RECONCILIATION_REQUIRED');f.state.failure=false;await f.dispatcher.run('SEND');assert.equal(f.state.broadcasts,1);cases++;
 f.state.verified=true;assert.equal((await f.dispatcher.run('SEND')).confirmed,true);assert.equal(f.state.broadcasts,1);cases++;
 f=await setup();await f.repo.transaction(({store})=>store.saveSigned('SEND',{txHash:hash(101),raw:'0xab12',nonce:7,chainId:'137',token:TOKEN}));await f.dispatcher.run('SEND');assert.equal(f.state.signs,0);assert.equal(f.state.broadcasts,1);cases++;
 f=await setup();await f.repo.transaction(async({store})=>{await store.saveSigned('SEND',{txHash:hash(101),raw:'0xab12',nonce:7,chainId:'137',token:TOKEN});await store.markBroadcastAttempted('SEND');});await f.dispatcher.run('SEND');assert.equal(f.state.broadcasts,0);cases++;
 f=await setup({settled:'999'});await assert.rejects(f.dispatcher.run('SEND'),/EXCEED_SETTLED/);assert.equal(f.state.signs,0);assert.equal(f.state.broadcasts,0);cases++;
 f=await setup();f.state.preflightFailure=true;await assert.rejects(f.dispatcher.run('SEND'),/SIGNED_NONCE/);assert.equal(f.state.broadcasts,0);assert.equal(f.h.data.movements.get('SEND').status,'SIGNED');cases++;
 f=await setup({to:G,purpose:'GEMELLI_RESERVE_OUT',amount:'500',settled:'500',destination:'500'});await assert.rejects(f.dispatcher.run('SEND'),/DOUBLE_DEPOSIT/);assert.equal(f.state.broadcasts,0);cases++;
 f=await setup({from:G,to:T,purpose:'GEMELLI_FUNDING_IN',amount:'500',settled:'501'});await assert.rejects(f.dispatcher.run('SEND'),/MUST_BE_500/);cases++;
 f=await setup({from:P,to:U,purpose:'PROJECTS_HUMANITARIAN_OUT',amount:'100',settled:'200'});const projectsPending=await f.dispatcher.run('SEND');assert.equal(projectsPending.confirmed,false);assert.equal(f.state.broadcasts,1);cases++;
 f=await setup({from:P,to:U,purpose:'PAYOUT_RHA',amount:'100',settled:'200'});await assert.rejects(f.dispatcher.run('SEND'),/PROJECTS_OUTGOING_PURPOSE_FORBIDDEN/);assert.equal(f.state.broadcasts,0);cases++;
 f=await setup();f.h.data.movements.set('OLD',{movement_key:'OLD',source_wallet:T,tx_hash:hash(55),status:'SUBMITTED'});await assert.rejects(f.dispatcher.run('SEND'),/PREVIOUS_TRANSACTION/);assert.equal(f.state.signs,0);cases++;
 f=await setup();f.h.data.movements.get('SEND').depends_on='OLD';f.h.data.movements.set('OLD',{movement_key:'OLD',status:'PREPARED'});await assert.rejects(f.dispatcher.run('SEND'),/DEPENDENCY_NOT_SETTLED/);cases++;
 f=await setup();f.state.verified=true;assert.equal((await f.dispatcher.attachManualProof('SEND',hash(333))).confirmed,true);assert.equal(f.state.broadcasts,0);assert.equal(f.state.signs,0);cases++;
 await assert.rejects(f.dispatcher.attachManualProof('SEND',hash(444)),/CANNOT_BE_REPLACED/);cases++;
 f=await setup({to:G,purpose:'GEMELLI_RESERVE_OUT',amount:'500',settled:'500',destination:'1000'});f.state.verified=true;await assert.rejects(f.dispatcher.attachManualProof('SEND',hash(777)),/POST_BALANCE_NOT_500/);assert.equal(f.h.data.movements.get('SEND').status,'PREPARED');cases++;
 f=await setup();await Promise.all([f.dispatcher.run('SEND'),f.dispatcher.run('SEND')]);assert.equal(f.state.signs,1);assert.equal(f.state.broadcasts,1);cases++;
 f=await setup();f.h.data.movements.get('SEND').status='CANCELLED';await assert.rejects(f.dispatcher.run('SEND'),/TRANSFER_CANCELLED/);cases++;
 f=await setup();f.h.data.activation.status='PAUSED';await assert.rejects(f.dispatcher.run('SEND'),/CUTOVER_NOT_ACTIVE/);assert.equal(f.state.broadcasts,0);cases++;
 console.log(JSON.stringify({test:'treasury-dispatcher-runtime',status:'PASS',cases,scope:'real dispatcher/ledger; memory transactions and simulated chain; NO live transfer'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
