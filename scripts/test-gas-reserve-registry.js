'use strict';
const assert=require('node:assert/strict');
const A=require('../economic-amounts');
const M=require('../gas-reserve-manager');
const wallet='0x'+'1'.repeat(40),hash='0x'+'a'.repeat(64);
process.env.PHARAOH_TREASURY_WALLET=wallet;
function gift(id=1,status='PENDING') {return {id,event_key:`RHA:${id}`,account_id:id,livello:3,importo:5995,wallet,status,tx_hash:status==='SENT'?hash:null,
  dettagli:{economicReserveBucket:`EXIT:${id}:NET`,commissioneGas:{lordoUsdc:6000,trattenutaUsdc:5,nettoUsdc:5995,riservaBucket:`EXIT:${id}:GAS_RESERVE`}}};}
function fake(){
 const entries=new Map();const buckets=new Map();const movement=new Map();
 const state={entries,buckets,movement};
 const client={async query(sql,args){
   if(sql.includes('FROM pharaoh_economic_buckets'))return {rows:[buckets.get(args[0])].filter(Boolean)};
   if(sql.includes('INSERT INTO pharaoh_gas_reserve_entries')){
     const [id,key,account,bucket,amount]=args;
     if(entries.has(id))return {rows:[]};
     const row={payout_id:id,source_event_key:key,account_id:account,reserve_bucket:bucket,amount_atomic:amount,status:'PENDING'};
     if([...entries.values()].some(r=>r.reserve_bucket===bucket||r.source_event_key===key))throw Error('UNIQUE_CONSTRAINT');
     entries.set(id,row);return {rows:[row]};
   }
   if(sql.includes('FROM pharaoh_gas_reserve_entries WHERE payout_id'))return {rows:[entries.get(args[0])].filter(Boolean)};
   if(sql.includes('FROM pharaoh_treasury_movements'))return {rows:[movement.get(args[0])].filter(Boolean)};
   if(sql.includes('UPDATE pharaoh_gas_reserve_entries')){
     const row=entries.get(args[0]);
     if(sql.includes("status='REVIEW_REQUIRED'")){if(row.status==='PENDING')row.status='REVIEW_REQUIRED';}
     else if(row.status==='PENDING'){row.status=args[1];row.confirmed_payout_tx_hash=args[2];}
     return {rows:[]};
   }
   if(sql.includes('GROUP BY status')){
     const grouped=new Map();for(const r of entries.values()){const g=grouped.get(r.status)||{status:r.status,atomic:0n,entries:0};g.atomic+=BigInt(r.amount_atomic);g.entries++;grouped.set(r.status,g);}
     return {rows:[...grouped.values()].map(r=>({...r,atomic:String(r.atomic)}))};
   }
   throw Error('UNEXPECTED_SQL:'+sql);
 }};
 return {client,state};
}
async function run(){
 const {client,state}=fake(),g=gift();
 state.buckets.set('EXIT:1:GAS_RESERVE',{bucket_key:'EXIT:1:GAS_RESERVE',purpose:'GAS_RESERVE_PENDING',balance_atomic:'5000000',wallet});
 assert.equal((await M.recordPending(client,g)).status,'PENDING');
 assert.equal(state.entries.size,1);
 assert.equal((await M.recordPending(client,g)).status,'PENDING');assert.equal(state.entries.size,1);
 assert.equal(await M.syncPayout(client,g),'PENDING');
 assert.equal((await M.balances(client)).PENDING.usdc,'5');
 await assert.rejects(M.syncPayout(client,gift(1,'SENT')),/GAS_RESERVE_PAYOUT_PROOF_REQUIRED/);
 state.movement.set('PAYOUT:1',{status:'SUBMITTED',tx_hash:hash,proof:{}});
 await assert.rejects(M.syncPayout(client,gift(1,'SENT')),/GAS_RESERVE_PAYOUT_PROOF_REQUIRED/);
 state.movement.set('PAYOUT:1',{status:'CONFIRMED',tx_hash:'0x'+'b'.repeat(64),proof:{}});
 await assert.rejects(M.syncPayout(client,gift(1,'SENT')),/GAS_RESERVE_PAYOUT_PROOF_REQUIRED/);
 state.movement.set('PAYOUT:1',{status:'CONFIRMED',tx_hash:hash,proof:{verified:true,txHash:hash},amount_atomic:'5995000000',destination_wallet:wallet,reserve_bucket:'EXIT:1:NET'});
 assert.equal(await M.syncPayout(client,gift(1,'SENT')),'AVAILABLE');
 assert.equal(await M.syncPayout(client,gift(1,'SENT')),'AVAILABLE');
 assert.equal((await M.balances(client)).AVAILABLE.usdc,'5');
 await assert.rejects(M.recordPending(client,{...g,importo:6000}),/GAS_RESERVE_POLICY_MISMATCH/);
 state.buckets.set('EXIT:2:GAS_RESERVE',{bucket_key:'EXIT:2:GAS_RESERVE',purpose:'GAS_RESERVE_PENDING',balance_atomic:'5000000',wallet});
 const exp=gift(2,'EXPIRED');assert.equal(await M.syncPayout(client,exp),'REVIEW_REQUIRED');
 assert.equal((await M.balances(client)).REVIEW_REQUIRED.usdc,'5');
 await assert.rejects(M.syncPayout(client,gift(2,'SENT')),/GAS_RESERVE_MANUAL_REVIEW_REQUIRED/);
 assert.equal(state.entries.size,2);
 assert.equal(A.usdc('5995')+A.usdc('5'),A.usdc('6000'));
 console.log('PASS gas-reserve-registry: idempotence, settlement proof, pending, mismatch, expiration hold, balances');
}
run().catch(e=>{console.error(e);process.exitCode=1});
