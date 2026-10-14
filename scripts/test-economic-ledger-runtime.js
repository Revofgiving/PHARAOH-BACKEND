'use strict';
const assert=require('node:assert/strict');
const A=require('../economic-amounts');
const {EconomicLedger}=require('../economic-ledger');
const {MemoryHarness}=require('./support/economic-memory-store');
const T='0x'+'1'.repeat(40),U='0x'+'2'.repeat(40),G='0x'+'3'.repeat(40),TOKEN='0x'+'4'.repeat(40);
const config={token:TOKEN,chainId:'137',minConfirmations:2};
function proof(n,amount,from=U,to=T){return {valida:true,proof:{txHash:'0x'+n.toString(16).padStart(64,'0'),from,to,tokenContract:TOKEN,chainId:137,amountBaseUnits:A.usdc(amount).toString(),blockNumber:100,blockHash:'0x'+'a'.repeat(64),confirmations:2,transferLogIndexes:[0]}};}
async function main(){
 const h=new MemoryHarness();let cases=0;
 const run=fn=>h.transaction(s=>fn(new EconomicLedger(s,config)));
 const credit={eventKey:'CREDIT:1',bucket:{key:'ENTRY',wallet:T,purpose:'EXTERNAL_ENTRY'},verification:proof(1,'600'),from:U,amountAtomic:A.usdc('600')};
 const initial=await run(l=>l.incoming(credit));assert.equal(initial.amountAtomic,'600000000');cases++;
 assert.deepEqual(await run(l=>l.incoming(credit)),initial);assert.equal(h.data.journal.length,1);cases++;
 await assert.rejects(run(l=>l.incoming({...credit,eventKey:'CREDIT:2'})),/PROOF_ALREADY_CONSUMED/);cases++;
 await assert.rejects(run(l=>l.incoming({...credit,eventKey:'CREDIT:bad',amountAtomic:A.usdc('500')})),/PROOF_MISMATCH/);cases++;
 await assert.rejects(run(l=>l.reallocate({eventKey:'BAD_BALANCE',inputs:[{key:'ENTRY',amountAtomic:A.usdc('600')}],outputs:[{key:'X',wallet:T,purpose:'X',amountAtomic:A.usdc('700')}]})),/UNBALANCED/);cases++;
 await assert.rejects(run(l=>l.reallocate({eventKey:'BAD_WALLET',inputs:[{key:'ENTRY',amountAtomic:A.usdc('100')}],outputs:[{key:'GHOST',wallet:G,purpose:'X',amountAtomic:A.usdc('100')}]})),/CANNOT_MOVE/);assert.equal(h.data.buckets.has('GHOST'),false);cases++;
 await run(l=>l.reallocate({eventKey:'SPLIT',inputs:[{key:'ENTRY',amountAtomic:A.usdc('600')}],outputs:[{key:'NEXT_GEMELLO',wallet:T,purpose:'GEMELLI_NEXT',amountAtomic:A.usdc('500')},{key:'PROJECTS',wallet:T,purpose:'STRUCTURAL',amountAtomic:A.usdc('100')}]}));cases++;
 await run(l=>l.prepareMovement({key:'SEND:500',reserveBucket:'NEXT_GEMELLO',to:G,amountAtomic:A.usdc('500'),purpose:'GEMELLI_RESERVE_OUT',destinationBucket:'GEMELLI:READY',destinationPurpose:'GEMELLI_RESERVE'}));cases++;
 await assert.rejects(run(l=>l.reallocate({eventKey:'DOUBLE_USE',inputs:[{key:'NEXT_GEMELLO',amountAtomic:A.usdc('500')}],outputs:[{key:'DUP',wallet:T,purpose:'X',amountAtomic:A.usdc('500')}]})),/BOUND_TO_TRANSFER/);cases++;
 await assert.rejects(run(l=>l.assertSolvent(T,A.usdc('599'))),/EXCEED_SETTLED/);assert.equal((await run(l=>l.assertSolvent(T,A.usdc('600')))).freeAtomic,0n);cases++;
 const moved=await run(l=>l.settleMovement({movementKey:'SEND:500',verification:proof(2,'500',T,G)}));
 assert.equal(h.data.buckets.get('GEMELLI:READY').balance_atomic,A.usdc('500').toString());assert.equal(h.data.buckets.get('NEXT_GEMELLO').balance_atomic,'0');cases++;
 assert.deepEqual(await run(l=>l.settleMovement({movementKey:'SEND:500',verification:proof(2,'500',T,G)})),moved);cases++;
 await assert.rejects(run(l=>l.settleMovement({movementKey:'SEND:500',verification:proof(3,'500',T,G)})),/HASH_MISMATCH/);cases++;
 h.data.activation.status='PAUSED';await assert.rejects(run(l=>l.incoming({...credit,eventKey:'PAUSED'})),/CUTOVER_NOT_ACTIVE/);cases++;
 assert.equal(A.usdc('1.000001'),1000001n);assert.equal(A.decimal(1000001n),'1.000001');assert.throws(()=>A.usdc('1.0000001'));assert.throws(()=>A.atomic(Number.MAX_SAFE_INTEGER+1));cases++;
 console.log(JSON.stringify({test:'economic-ledger-runtime',status:'PASS',cases,repository:'in-memory test double; PostgreSQL NOT executed'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
