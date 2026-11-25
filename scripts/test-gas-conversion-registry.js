'use strict';
const assert=require('node:assert/strict');
const M=require('../gas-conversion-manager'),P=require('../swap-proof-verifier');
const A=require('../economic-amounts');
const wallet='0x'+'1'.repeat(40),router='0x'+'2'.repeat(40),receiptHash='0x'+'a'.repeat(64);
function fakePool(){
 const s={conversions:[],allocs:[],events:[],entries:[{payout_id:1,amount_atomic:'5000000'},{payout_id:2,amount_atomic:'5000000'}],next:1};
 const client={release(){},async query(q,values=[]){
  if(/^(BEGIN|COMMIT|ROLLBACK)$/.test(q)||q.includes('pg_advisory_xact_lock'))return {rows:[]};
  if(q.includes('FROM pharaoh_gas_conversions WHERE request_key'))return {rows:s.conversions.filter(x=>x.request_key===values[0])};
  if(q.includes('WITH locked AS MATERIALIZED'))return {rows:s.entries.map(e=>({...e,allocated_atomic:String(s.allocs.filter(a=>a.payout_id===e.payout_id).reduce((n,a)=>n+BigInt(a.amount_atomic),0n))}))};
  if(q.includes('INSERT INTO pharaoh_gas_conversions')){
   const row={id:s.next++,request_key:values[0],chain_id:137,treasury_wallet:values[1],pol_wallet:values[2],usdc_atomic:values[3],expected_pol_wei:values[4],status:'PREPARATA',tx_hash:null};s.conversions.push(row);return {rows:[row]};
  }
  if(q.includes('INSERT INTO pharaoh_gas_conversion_allocations')){s.allocs.push({conversion_id:values[0],payout_id:values[1],amount_atomic:values[2]});return {rows:[]};}
  if(q.includes('INSERT INTO pharaoh_gas_conversion_events')){s.events.push({id:values[0],type:values[1]});return {rows:[]};}
  if(q.includes('FROM pharaoh_gas_conversions WHERE id=$1'))return {rows:s.conversions.filter(x=>String(x.id)===String(values[0]))};
  if(q.includes('FROM pharaoh_gas_conversions WHERE chain_id=137'))return {rows:s.conversions.filter(x=>x.tx_hash===values[0]&&String(x.id)!==String(values[1]))};
  if(q.includes('UPDATE pharaoh_gas_conversions SET status=\'DA_RICONCILIARE\'')){s.conversions.find(x=>String(x.id)===String(values[0])).status='DA_RICONCILIARE';return {rows:[]};}
  if(q.includes('UPDATE pharaoh_gas_conversions SET status=\'VERIFICATA\'')){const x=s.conversions.find(r=>String(r.id)===String(values[0]));x.status='VERIFICATA';x.tx_hash=values[1];return {rows:[]};}
  if(q.includes("UPDATE pharaoh_gas_conversions SET status='ANNULLAMENTO_RICHIESTO'")){s.conversions.find(x=>String(x.id)===String(values[0])).status='ANNULLAMENTO_RICHIESTO';return {rows:[]};}
  if(q.includes('FROM pharaoh_gas_reserve_entries GROUP BY status'))return {rows:[{status:'AVAILABLE',amount_atomic:'10000000'}]};
  if(q.includes('FROM pharaoh_gas_conversion_allocations a')){
   return {rows:['PREPARATA','DA_RICONCILIARE','ANNULLAMENTO_RICHIESTO','VERIFICATA'].map(status=>({status,amount_atomic:String(s.allocs.filter(a=>s.conversions.find(c=>c.id===a.conversion_id)?.status===status).reduce((n,a)=>n+BigInt(a.amount_atomic),0n))}))};
  }
  throw Error('UNMOCKED_SQL '+q);
 }};
 return {getClient:async()=>client,state:s};
}
async function test(){
 const pool=fakePool();const input={requestKey:'request-one',usdc:'7',expectedPolWei:'1000000000000000000',treasury:wallet,recipient:wallet};
 const a=await M.prepare(pool,input,'admin');assert.equal(a.status,'PREPARATA');assert.equal(pool.state.allocs.length,2);
 assert.equal((await M.balances(pool)).availableUsdc,'3');
 assert.equal((await M.prepare(pool,input,'admin')).replayed,true);
 await assert.rejects(M.prepare(pool,{...input,usdc:'8'},'admin'),/GAS_CONVERSION_IDEMPOTENCY_CONFLICT/);
 await assert.rejects(M.prepare(pool,{...input,requestKey:'two',usdc:'4'},'admin'),/GAS_CONVERSION_INSUFFICIENT_RESERVE/);
 const verifier=async()=>({txHash:receiptHash,spentAtomic:A.usdc('7').toString(),polWei:input.expectedPolWei,block:100,blockHash:receiptHash});
 const result=await M.verifyConversion(pool,a.id,receiptHash,'admin',{verifier});assert.equal(result.status,'VERIFICATA');
 assert.equal((await M.balances(pool)).usedUsdc,'7');
 assert.equal((await M.verifyConversion(pool,a.id,receiptHash,'admin',{verifier})).replayed,true);
 const second=await M.prepare(pool,{...input,requestKey:'two',usdc:'3'},'admin');
 await assert.rejects(M.verifyConversion(pool,second.id,receiptHash,'admin',{verifier:async()=>({...await verifier(),spentAtomic:A.usdc('3').toString()})}),/GAS_CONVERSION_DUPLICATE_TX/);
 assert.equal(pool.state.conversions.length,2);
 const wrong=await assert.rejects(M.prepare(pool,{...input,requestKey:'three',usdc:'0'},'admin'),/INVALID_CONVERSION_USDC|INVALID_USDC_AMOUNT/);
 assert.equal(pool.state.events.filter(x=>x.type==='VERIFICATA').length,1);
 const topic='0x'+'0'.repeat(24)+wallet.slice(2);
 const receipt={status:1,hash:receiptHash,blockHash:receiptHash,blockNumber:100,logs:[{address:'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',topics:[P.TRANSFER_TOPIC||'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic,'0x'+'0'.repeat(24)+router.slice(2)],data:'0x'+A.usdc('7').toString(16)}]};
 const trace={type:'CALL',from:wallet,to:router,value:'0x0',calls:[{type:'CALL',from:router,to:wallet,value:'0xde0b6b3a7640000'}]};
 const proof=P.assess({chainId:137,receipt,tx:{hash:receiptHash,from:wallet},trace,treasury:wallet,recipient:wallet,expectedUsdcAtomic:A.usdc('7').toString(),expectedPolWei:'1000000000000000000',confirmations:3,canonicalBlockHash:receiptHash});
 assert.equal(proof.polWei,'1000000000000000000');
 assert.throws(()=>P.assess({chainId:137,receipt,tx:{hash:receiptHash,from:wallet},trace:{...trace,calls:[...trace.calls,{type:'CALL',from:wallet,to:router,value:'0x1'}]},treasury:wallet,recipient:wallet,expectedUsdcAtomic:A.usdc('7').toString(),expectedPolWei:proof.polWei,confirmations:3,canonicalBlockHash:receiptHash}),/SWAP_POL_OUTGOING_VALUE_DETECTED/);
 assert.throws(()=>P.assess({chainId:137,receipt,tx:{hash:receiptHash,from:wallet},trace:null,treasury:wallet,recipient:wallet,expectedUsdcAtomic:A.usdc('7').toString(),expectedPolWei:proof.polWei,confirmations:3,canonicalBlockHash:receiptHash}),/SWAP_NATIVE_POL_TRACE_UNAVAILABLE/);
 assert.throws(()=>P.assess({chainId:1,receipt,tx:{hash:receiptHash,from:wallet},trace,treasury:wallet,recipient:wallet,expectedUsdcAtomic:A.usdc('7').toString(),expectedPolWei:proof.polWei,confirmations:3,canonicalBlockHash:receiptHash}),/SWAP_WRONG_CHAIN/);
 // Cancellation does not release funds. An eventual transaction remains verifiable.
 const cPool=fakePool();
 const c=await M.prepare(cPool,{...input,requestKey:'cancel-one',usdc:'5'},'admin');
 assert.equal((await M.balances(cPool)).availableUsdc,'5');
 await assert.rejects(M.requestCancellation(cPool,c.id,'admin','short'),/GAS_CONVERSION_CANCELLATION_REASON_INVALID/);
 const cancellation=await M.requestCancellation(cPool,c.id,'admin','USER_DECLARED_NOT_BROADCAST');
 assert.equal(cancellation.status,'ANNULLAMENTO_RICHIESTO');
 assert.equal(cancellation.fundsReleased,false);
 assert.equal((await M.balances(cPool)).availableUsdc,'5');
 assert.equal((await M.balances(cPool)).reservedUsdc,'5');
 assert.equal((await M.requestCancellation(cPool,c.id,'admin','USER_DECLARED_NOT_BROADCAST')).replayed,true);
 await assert.rejects(M.prepare(cPool,{...input,requestKey:'overbook',usdc:'6'},'admin'),/GAS_CONVERSION_INSUFFICIENT_RESERVE/);
 const verified=await M.verifyConversion(cPool,c.id,receiptHash,'admin',{verifier:async()=>({txHash:receiptHash,spentAtomic:A.usdc('5').toString(),polWei:input.expectedPolWei,block:100,blockHash:receiptHash})});
 assert.equal(verified.status,'VERIFICATA');
 await assert.rejects(M.requestCancellation(cPool,c.id,'admin','USER_DECLARED_NOT_BROADCAST'),/GAS_CONVERSION_ALREADY_VERIFIED/);
 assert.equal(cPool.state.events.filter(x=>x.type==='ANNULLAMENTO_RICHIESTO').length,1);
 assert.equal(pool.state.events.length,3);
 console.log('PASS gas-conversion-registry: reserve funds, idempotence, replay, duplicate hash, proof, fail-closed trace');
}
test().catch(e=>{console.error(e);process.exitCode=1});
