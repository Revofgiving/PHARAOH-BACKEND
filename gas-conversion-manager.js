'use strict';
/** Reserve-only ledger. All writes run in one PostgreSQL transaction with a
 * constant advisory lock, serialising competing conversion allocations. */
const A=require('./economic-amounts');
const {verify}=require('./swap-proof-verifier');
const LOCK_A=614731,LOCK_B=32;
const parseId=id=>{if(!/^[1-9][0-9]*$/.test(String(id)))throw A.error('GAS_CONVERSION_BAD_ID');return String(id);};
function policy({requestKey,usdc,expectedPolWei,treasury,recipient}){
 const key=A.key(requestKey,'CONVERSION_REQUEST_KEY');if(key.length>128)throw A.error('CONVERSION_REQUEST_KEY_TOO_LONG');
 const usdcAtomic=A.positive(A.usdc(usdc),'CONVERSION_USDC');
 const polWei=A.positive(expectedPolWei,'CONVERSION_POL_WEI');
 return {key,usdcAtomic:usdcAtomic.toString(),polWei:polWei.toString(),treasury:A.address(treasury),recipient:A.address(recipient)};
}
async function transaction(pool,fn){
 const c=await pool.getClient();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1,$2)',[LOCK_A,LOCK_B]);
  const result=await fn(c);await c.query('COMMIT');return result;
 }catch(err){try{await c.query('ROLLBACK');}catch(_){}throw err;}finally{c.release();}
}
const selectConversion=`SELECT * FROM pharaoh_gas_conversions WHERE id=$1 FOR UPDATE`;
async function event(c,id,type,actor,detail={}){
 await c.query(`INSERT INTO pharaoh_gas_conversion_events(conversion_id,event_type,actor,detail)
 VALUES($1,$2,$3,$4::jsonb)`,[id,type,actor,JSON.stringify(detail)]);
}
async function prepare(pool,input,actor){
 const p=policy(input);const admin=A.key(actor,'ADMIN_ACTOR');
 return transaction(pool,async c=>{
  const old=(await c.query('SELECT * FROM pharaoh_gas_conversions WHERE request_key=$1 FOR UPDATE',[p.key])).rows[0];
  if(old){
    if(String(old.usdc_atomic)!==p.usdcAtomic||String(old.expected_pol_wei)!==p.polWei||old.treasury_wallet!==p.treasury||old.pol_wallet!==p.recipient||Number(old.chain_id)!==137)
      throw A.error('GAS_CONVERSION_IDEMPOTENCY_CONFLICT');
    return {id:old.id,status:old.status,replayed:true};
  }
  // Locked globally across all requests. Each reserve can be partially allocated.
  const list=(await c.query(`WITH locked AS MATERIALIZED (SELECT payout_id,amount_atomic
     FROM pharaoh_gas_reserve_entries WHERE status='AVAILABLE' ORDER BY payout_id FOR UPDATE)
    SELECT e.payout_id,e.amount_atomic,COALESCE(SUM(a.amount_atomic),0)::text AS allocated_atomic
    FROM locked e LEFT JOIN pharaoh_gas_conversion_allocations a ON a.payout_id=e.payout_id
    GROUP BY e.payout_id,e.amount_atomic ORDER BY e.payout_id`)).rows;
  let remainder=BigInt(p.usdcAtomic);const allocations=[];
  for(const r of list){const free=BigInt(r.amount_atomic)-BigInt(r.allocated_atomic);
   if(free<0n)throw A.error('GAS_CONVERSION_ALLOCATION_CORRUPT');
   if(free===0n)continue;
   const take=free>remainder?remainder:free;
   allocations.push([r.payout_id,take.toString()]);remainder-=take;
   if(remainder===0n)break;
  }
  if(remainder!==0n)throw A.error('GAS_CONVERSION_INSUFFICIENT_RESERVE');
  const inserted=(await c.query(`INSERT INTO pharaoh_gas_conversions
   (request_key,chain_id,treasury_wallet,pol_wallet,usdc_atomic,expected_pol_wei)
   VALUES($1,137,$2,$3,$4,$5) RETURNING *`,[p.key,p.treasury,p.recipient,p.usdcAtomic,p.polWei])).rows[0];
  for(const [payout,amount] of allocations)await c.query(`INSERT INTO pharaoh_gas_conversion_allocations
    (conversion_id,payout_id,amount_atomic) VALUES($1,$2,$3)`,[inserted.id,payout,amount]);
  await event(c,inserted.id,'PREPARATA',admin,{usdcAtomic:p.usdcAtomic,expectedPolWei:p.polWei,allocations:allocations.length});
  return {id:inserted.id,status:'PREPARATA',replayed:false,usdc:A.decimal(p.usdcAtomic)};
 });
}
async function balances(pool){
 const c=await pool.getClient();try{
 const [r,alloc]=await Promise.all([
  c.query(`SELECT status,COALESCE(SUM(amount_atomic),0)::text amount_atomic FROM pharaoh_gas_reserve_entries GROUP BY status`),
  c.query(`SELECT c.status,COALESCE(SUM(a.amount_atomic),0)::text amount_atomic FROM pharaoh_gas_conversion_allocations a
 JOIN pharaoh_gas_conversions c ON c.id=a.conversion_id GROUP BY c.status`)]);
 const total=Object.fromEntries(['PENDING','AVAILABLE','REVIEW_REQUIRED'].map(s=>[s,0n]));
 for(const x of r.rows)total[x.status]=BigInt(x.amount_atomic);
 const committed=Object.fromEntries(['PREPARATA','DA_RICONCILIARE','ANNULLAMENTO_RICHIESTO','VERIFICATA'].map(s=>[s,0n]));
 for(const x of alloc.rows)committed[x.status]=BigInt(x.amount_atomic);
 const available=total.AVAILABLE-committed.PREPARATA-committed.DA_RICONCILIARE-committed.ANNULLAMENTO_RICHIESTO-committed.VERIFICATA;
 if(available<0n)throw A.error('GAS_CONVERSION_NEGATIVE_BALANCE');
 return {pendingUsdc:A.decimal(total.PENDING),reviewUsdc:A.decimal(total.REVIEW_REQUIRED),accruedUsdc:A.decimal(total.AVAILABLE),availableUsdc:A.decimal(available),reservedUsdc:A.decimal(committed.PREPARATA+committed.DA_RICONCILIARE+committed.ANNULLAMENTO_RICHIESTO),usedUsdc:A.decimal(committed.VERIFICATA)};
 }finally{c.release();}
}
async function markReconciliation(pool,id,actor,reason){
 const key=parseId(id),user=A.key(actor,'ADMIN_ACTOR');
 return transaction(pool,async c=>{
 const row=(await c.query(selectConversion,[key])).rows[0];if(!row)throw A.error('GAS_CONVERSION_NOT_FOUND');
 if(row.status==='VERIFICATA')throw A.error('GAS_CONVERSION_ALREADY_VERIFIED');
 if(row.status==='ANNULLAMENTO_RICHIESTO')return {id:key,status:'ANNULLAMENTO_RICHIESTO'};
 if(row.status==='PREPARATA'){
  await c.query(`UPDATE pharaoh_gas_conversions SET status='DA_RICONCILIARE',updated_at=now() WHERE id=$1`,[key]);
  await event(c,key,'DA_RICONCILIARE',user,{reason:A.key(reason,'RECONCILIATION_REASON')});
 }
 return {id:key,status:'DA_RICONCILIARE'};
 });
}
/** A cancellation request is NOT a release. No negative chain proof exists from an absent hash.
 * Keep all allocations locked; a later verified transaction must still be reconcilable. */
async function requestCancellation(pool,id,actor,reason){
 const key=parseId(id),user=A.key(actor,'ADMIN_ACTOR'),why=A.key(reason,'CANCELLATION_REASON');
 if(why.length<12||why.length>1024)throw A.error('GAS_CONVERSION_CANCELLATION_REASON_INVALID');
 return transaction(pool,async c=>{
  const row=(await c.query(selectConversion,[key])).rows[0];
  if(!row)throw A.error('GAS_CONVERSION_NOT_FOUND');
  if(row.status==='VERIFICATA')throw A.error('GAS_CONVERSION_ALREADY_VERIFIED');
  if(row.status==='ANNULLAMENTO_RICHIESTO')return {id:key,status:row.status,replayed:true,fundsReleased:false};
  if(!['PREPARATA','DA_RICONCILIARE'].includes(row.status))throw A.error('GAS_CONVERSION_CANCELLATION_STATUS_INVALID');
  await c.query(`UPDATE pharaoh_gas_conversions SET status='ANNULLAMENTO_RICHIESTO',updated_at=now() WHERE id=$1`,[key]);
  await event(c,key,'ANNULLAMENTO_RICHIESTO',user,{reason:why,release:'BLOCKED_PENDING_INDEPENDENT_RECONCILIATION'});
  return {id:key,status:'ANNULLAMENTO_RICHIESTO',replayed:false,fundsReleased:false};
 });
}
async function verifyConversion(pool,id,txHash,actor,{rpc,verifier=verify}={}){
 const key=parseId(id),hash=A.hash(txHash),user=A.key(actor,'ADMIN_ACTOR');
 // The proof is fetched without holding a DB transaction. Rechecked under lock below.
 const c=await pool.getClient();let row;
 try{row=(await c.query('SELECT * FROM pharaoh_gas_conversions WHERE id=$1',[key])).rows[0];}finally{c.release();}
 if(!row)throw A.error('GAS_CONVERSION_NOT_FOUND');
 if(row.status==='VERIFICATA'){
  if(row.tx_hash===hash)return {id:key,status:'VERIFICATA',replayed:true};
  throw A.error('GAS_CONVERSION_ALREADY_VERIFIED');
 }
 let proof;
 try{proof=await verifier({txHash:hash,treasury:row.treasury_wallet,recipient:row.pol_wallet,usdcAtomic:String(row.usdc_atomic),polWei:String(row.expected_pol_wei)},rpc);}
 catch(err){await markReconciliation(pool,key,user,'BLOCKCHAIN_PROOF_UNAVAILABLE_OR_MISMATCH:'+hash);throw err;}
 if(proof.txHash!==hash || String(proof.spentAtomic)!==String(row.usdc_atomic) || String(proof.polWei)!==String(row.expected_pol_wei) ||
    !Number.isSafeInteger(proof.block) || !/^0x[0-9a-f]{64}$/.test(proof.blockHash))throw A.error('GAS_CONVERSION_INVALID_PROOF');
 return transaction(pool,async c=>{
  const current=(await c.query(selectConversion,[key])).rows[0];
  if(!current)throw A.error('GAS_CONVERSION_NOT_FOUND');
  if(current.status==='VERIFICATA'){
   if(current.tx_hash===hash)return {id:key,status:'VERIFICATA',replayed:true};
   throw A.error('GAS_CONVERSION_ALREADY_VERIFIED');
  }
  if(String(current.usdc_atomic)!==String(proof.spentAtomic)||String(current.expected_pol_wei)!==String(proof.polWei)||current.treasury_wallet!==row.treasury_wallet||current.pol_wallet!==row.pol_wallet)
   throw A.error('GAS_CONVERSION_CHANGED_DURING_PROOF');
  const duplicate=(await c.query('SELECT id FROM pharaoh_gas_conversions WHERE chain_id=137 AND tx_hash=$1 AND id<>$2',[hash,key])).rows[0];
  if(duplicate)throw A.error('GAS_CONVERSION_DUPLICATE_TX');
  await c.query(`UPDATE pharaoh_gas_conversions SET status='VERIFICATA',tx_hash=$2,verified_usdc_atomic=$3,
    verified_pol_wei=$4,verified_block=$5,verified_block_hash=$6,verified_at=now(),updated_at=now() WHERE id=$1`,
   [key,hash,proof.spentAtomic,proof.polWei,proof.block,proof.blockHash]);
  await event(c,key,'VERIFICATA',user,{hash,block:proof.block,blockHash:proof.blockHash,usdcAtomic:proof.spentAtomic,polWei:proof.polWei});
  return {id:key,status:'VERIFICATA',replayed:false,txHash:hash};
 });
}
module.exports={policy,transaction,prepare,balances,markReconciliation,requestCancellation,verifyConversion};
