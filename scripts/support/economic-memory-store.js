'use strict';
// Test double, NOT PostgreSQL. Transaction serialization/rollback is explicit.
// These tests exercise the real ledger/materializer with an in-memory repository.
const A=require('../../economic-amounts');
class MemoryHarness {
  constructor({human=0n,piletta=0n}={}) {
    this.data={activation:{status:'ACTIVE',mode:'FRESH',evidence_hash:'a'.repeat(64)},events:new Map(),buckets:new Map(),journal:[],proofs:new Map(),
      economics:new Map(),memberships:new Map(),movements:new Map(),counters:{seeded:true,human_cumulative:String(human),piletta_cumulative:String(piletta)},
      accounts:new Map(),positions:[],nextAccount:1,nextPosition:1,nextNumber:8,nextTable:2,currentSlots:1,nextPersonalTable:10000,completed:[]};
    this.tail=Promise.resolve();this.inTransaction=false;
  }
  async transaction(fn) {
    const previous=this.tail;let release;this.tail=new Promise(r=>{release=r;});await previous;
    const before=structuredClone(this.data);this.inTransaction=true;
    try{return await fn(new MemoryEconomicStore(this));}catch(e){this.data=before;throw e;}finally{this.inTransaction=false;release();}
  }
}
class MemoryEconomicStore {
  constructor(h){this.h=h;} get d(){return this.h.data;}
  async lock(){if(!this.h.inTransaction)throw A.error('TEST_TRANSACTION_REQUIRED');}
  async activation(){return this.d.activation;}
  async event(key){return this.d.events.get(key)||null;}
  async startEvent(key,kind,fingerprint,context){if(this.d.events.has(key))throw A.error('DUPLICATE_EVENT');const row={event_key:key,kind,fingerprint,context,status:'STARTED'};this.d.events.set(key,row);return row;}
  async completeEvent(key,result){const row=this.d.events.get(key);row.status='COMPLETED';row.result=structuredClone(result);return row;}
  async bucket(key){return this.d.buckets.get(key)||null;}
  async ensureBucket(b){if(!this.d.buckets.has(b.key))this.d.buckets.set(b.key,{bucket_key:b.key,wallet:b.wallet,purpose:b.purpose,metadata:b.metadata||{},balance_atomic:'0'});return this.bucket(b.key);}
  async boundMovement(key){return [...this.d.movements.values()].find(m=>m.reserve_bucket===key&&m.status!=='CANCELLED')||null;}
  async changeBucket(key,delta,event,ordinal){const b=await this.bucket(key);if(!b||BigInt(b.balance_atomic)+BigInt(delta)<0n)throw A.error('ECONOMIC_BUCKET_INSUFFICIENT');b.balance_atomic=String(BigInt(b.balance_atomic)+BigInt(delta));this.d.journal.push({event_key:event,ordinal,bucket_key:key,delta_atomic:String(delta),balance_after_atomic:b.balance_atomic});return b;}
  async claimProof(key,event,proof,index){if(this.d.proofs.has(key))throw A.error('ECONOMIC_PROOF_ALREADY_CONSUMED');this.d.proofs.set(key,{event,proof,index});}
  async reserved(wallet){return {atomic:String([...this.d.buckets.values()].filter(b=>b.wallet===wallet).reduce((n,b)=>n+BigInt(b.balance_atomic),0n))};}
  async counters(){return this.d.counters;}
  async incrementCounters(h,p){const c=this.d.counters;const nh=BigInt(c.human_cumulative)+h,np=BigInt(c.piletta_cumulative)+p;if(!c.seeded||np>nh)throw A.error('CAP_EXCEEDED');c.human_cumulative=String(nh);c.piletta_cumulative=String(np);return c;}
  async economics(id){return this.d.economics.get(String(id))||null;}
  async putEconomics(e){const key=String(e.accountId);if(!this.d.economics.has(key))this.d.economics.set(key,{account_id:key,root_account_id:String(e.rootAccountId),position_class:e.positionClass,owner_wallet:e.ownerWallet,custody_wallet:e.custodyWallet,origin:e.origin,source_event_key:e.sourceEventKey});return this.economics(key);}
  async membership(m){if(this.d.memberships.has(String(m.positionId))||[...this.d.memberships.values()].some(x=>x.eventKey===m.eventKey&&x.index===m.index))throw A.error('DUPLICATE_MEMBERSHIP');this.d.memberships.set(String(m.positionId),structuredClone(m));return m;}
  async movement(key){return this.d.movements.get(key)||null;}
  async createMovement(m){if(this.d.movements.has(m.key))throw A.error('DUPLICATE_MOVEMENT');const row={movement_key:m.key,reserve_bucket:m.reserveBucket,source_wallet:m.sourceWallet,destination_wallet:m.destinationWallet,amount_atomic:String(m.amountAtomic),purpose:m.purpose,destination_bucket:m.destinationBucket,destination_purpose:m.destinationPurpose,depends_on:m.dependsOn||null,status:'PREPARED',tx_hash:null};this.d.movements.set(m.key,row);return row;}
  async unresolvedSigner(wallet,key){return [...this.d.movements.values()].find(m=>m.source_wallet===wallet&&m.movement_key!==key&&m.tx_hash&&!['CONFIRMED','REGISTERED','CANCELLED'].includes(m.status))||null;}
  async saveSigned(key,s){const m=await this.movement(key);if(!m||m.status!=='PREPARED'||m.tx_hash)return null;Object.assign(m,{status:'SIGNED',signed_raw_tx:s.raw,tx_hash:s.txHash,sender_nonce:String(s.nonce),chain_id:s.chainId,token:s.token});return m;}
  async markBroadcastAttempted(key){const m=await this.movement(key);if(!m||m.status!=='SIGNED'||m.broadcast_attempted_at)return null;m.status='SUBMITTED';m.broadcast_attempted_at='test-attempt';return m;}
  async requireReconciliation(key,code){const m=await this.movement(key);if(!['CONFIRMED','REGISTERED','CANCELLED'].includes(m.status)){m.status='RECONCILIATION_REQUIRED';m.last_error=code;}return m;}
  async confirmMovement(key,proof){const m=await this.movement(key);m.status='CONFIRMED';m.proof=proof;m.tx_hash=proof.txHash;return m;}
}
function memoryPlacement(h,{failAt=null}={}) {
  let calls=0;
  return {
    getAccountByKey:async key=>[...h.data.accounts.values()].find(a=>a.account_key===key)||null,
    getAccountById:async id=>h.data.accounts.get(String(id))||null,
    createRoot:async input=>{const id=String(h.data.nextAccount++);const row={id,wallet:input.wallet,tipo:input.tipo,account_key:input.accountKey,nome:input.nome};h.data.accounts.set(id,row);return row;},
    place:async account=>{
      if(++calls===failAt)throw A.error('INJECTED_MID_BATCH_FAILURE');
      while(h.data.nextNumber>=26&&(h.data.nextNumber-26)%14===0)h.data.nextNumber++;
      const n=h.data.nextNumber++;const positionId=String(h.data.nextPosition++);h.data.currentSlots++;
      const p={positionId,accountId:account.id,number:n,tableId:h.data.nextTable,tableNumber:h.data.nextTable,slot:h.data.currentSlots,personalTableId:h.data.nextPersonalTable++,completed:h.data.currentSlots===6};
      account.numero_posizionale=n;account.sigla=String(n);h.data.positions.push(p);return p;
    },
    queueCompleted:async ({placed,eventKey})=>{
      h.data.completed.push({tableId:placed.tableId,eventKey});h.data.nextTable++;h.data.currentSlots=1;
      // CASSA consumes a global number, not the human counter or another 100.
      while(h.data.nextNumber>=26&&(h.data.nextNumber-26)%14===0)h.data.nextNumber++;
      h.data.nextNumber++;
    }
  };
}
module.exports={MemoryHarness,MemoryEconomicStore,memoryPlacement};
