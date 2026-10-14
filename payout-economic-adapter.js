'use strict';
const A=require('./economic-amounts');
const {configuredLedger}=require('./economic-ledger');
function details(row) {return typeof row.dettagli==='string'?JSON.parse(row.dettagli):row.dettagli||{};}
async function reserveFor(row,client) {
  let bucket=details(row).economicReserveBucket;
  if(!bucket)bucket=(await client.query("SELECT bucket_key FROM pharaoh_operating_bindings WHERE operation_type='PAYOUT' AND operation_key=$1",[String(row.id)])).rows[0]?.bucket_key;
  if(!bucket)throw A.error('PAYOUT_CUTOVER_RESERVE_REQUIRED');
  return A.key(bucket);
}
async function validateNewGift({wallet,accountId,importo,livello,eventKey,dettagli},client) {
  if(!client)throw A.error('PAYOUT_ALLOCATION_TRANSACTION_REQUIRED');
  const ledger=configuredLedger(client);await ledger.ready();
  const e=await ledger.store.economics(accountId);
  if(!e || e.position_class==='PILETTA' || e.owner_wallet!==A.address(wallet))throw A.error('PAYOUT_ECONOMIC_OWNER_MISMATCH');
  const allocation=await ledger.store.event(`ALLOCATE_EXIT:${A.digest(eventKey)}`);
  const expectedLevel={3:'RHA',4:'THOT',5:'ISIDE'}[livello];
  if(!allocation || allocation.status!=='COMPLETED' || String(allocation.context.context.accountId)!==String(accountId) || allocation.context.context.level!==expectedLevel)throw A.error('PAYOUT_EXIT_ALLOCATION_REQUIRED');
  const bucket=dettagli?.economicReserveBucket,b=await ledger.store.bucket(bucket);
  if(bucket!==require('./economic-flow').exitKeys(eventKey).NET || !b || b.purpose!=='PAYOUT' || b.wallet!==A.address(process.env.PHARAOH_TREASURY_WALLET) || A.atomic(b.balance_atomic)!==A.usdc(String(importo)))throw A.error('PAYOUT_EXACT_RESERVE_REQUIRED');
}
async function prepareAndRun(row) {
  const pg=require('./pg-connection-manager'),{configuredDispatcher}=require('./treasury-transfer-manager');
  const dispatcher=configuredDispatcher(),key=`PAYOUT:${row.id}`;
  const client=await pg.getClient();
  try {
    await client.query('BEGIN');const ledger=configuredLedger(client);await ledger.ready();
    const current=(await client.query('SELECT * FROM doni_pendenti WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
    if(!current || current.status!=='PROCESSING' || !current.accepted_at)throw A.error('PAYOUT_MUST_BE_ACCEPTED');
    if(current.wallet!==row.wallet || String(current.importo)!==String(row.importo))throw A.error('PAYOUT_ROW_CHANGED');
    const reserve=await reserveFor(current,client);
    await ledger.prepareMovement({key,reserveBucket:reserve,to:row.wallet,amountAtomic:A.usdc(String(row.importo)),purpose:`PAYOUT_${{3:'RHA',4:'THOT',5:'ISIDE'}[Number(row.livello)]||'INVALID'}`});
    await client.query('COMMIT');
  } catch(error){try{await client.query('ROLLBACK');}catch(_){}throw error;}finally{client.release();}
  let result,dispatchError;
  try{result=await dispatcher.run(key);}catch(error){dispatchError=error;}
  const movement=await dispatcher.read(key);
  if(movement.tx_hash) {
    // Even a SUBMITTED/unknown outcome is linked immediately; expiry and retry
    // must never treat this as an unsent gift.
    await pg.query(`UPDATE doni_pendenti SET tx_hash=$2,errore=$3
      WHERE id=$1 AND status='PROCESSING' AND (tx_hash IS NULL OR LOWER(tx_hash)=$2)`,[row.id,movement.tx_hash,dispatchError?.code||null]);
    return {txHash:movement.tx_hash,simulated:false,pending:!['CONFIRMED','REGISTERED'].includes(movement.status),status:movement.status,proof:movement.proof||null};
  }
  if(dispatchError)throw dispatchError;
  return {txHash:result?.txHash||null,simulated:false,pending:true,status:movement.status};
}
async function reconcileAccepted(limit=20) {
  const pg=require('./pg-connection-manager'),{configuredDispatcher}=require('./treasury-transfer-manager');
  const rows=await pg.queryMany(`SELECT d.id FROM doni_pendenti d JOIN pharaoh_treasury_movements m ON m.movement_key='PAYOUT:'||d.id::text
    WHERE d.status IN ('PROCESSING','FAILED') AND d.accepted_at IS NOT NULL AND m.tx_hash IS NOT NULL ORDER BY d.id LIMIT $1`,[Math.max(1,Math.min(100,Number(limit)||20))]);
  const results=[];
  for(const row of rows) {
    try {
      const settled=await configuredDispatcher().run(`PAYOUT:${row.id}`);
      if(!settled.confirmed){results.push({id:row.id,status:settled.status});continue;}
      const client=await pg.getClient();let updated;
      try {
        await client.query('BEGIN');await configuredLedger(client).ready();
        updated=(await client.query(`UPDATE doni_pendenti SET status='SENT',tx_hash=$2,sent_at=COALESCE(sent_at,now()),errore=NULL
          WHERE id=$1 AND status IN ('PROCESSING','FAILED') AND accepted_at IS NOT NULL AND (tx_hash IS NULL OR LOWER(tx_hash)=$2) RETURNING *`,[row.id,settled.txHash])).rows[0];
        if(updated)await client.query("INSERT INTO audit_doni_pendenti(dono_pendente_id,evento,dettagli) VALUES($1,'SENT_RECONCILED',$2::jsonb)",[row.id,A.json({txHash:settled.txHash})]);
        await client.query('COMMIT');
      }catch(error){try{await client.query('ROLLBACK');}catch(_){}throw error;}finally{client.release();}
      if(updated)await require('./payout-manager').ensurePayoutRegistry(updated);
      results.push({id:row.id,status:'SENT'});
    }catch(error){results.push({id:row.id,status:'RECONCILIATION_REQUIRED',code:error.code||'PAYOUT_RECONCILIATION_ERROR'});}
  }
  return results;
}
async function expireUnsent({limit=200}) {
  const pg=require('./pg-connection-manager'),client=await pg.getClient();
  try {
    await client.query('BEGIN');const ledger=configuredLedger(client);await ledger.ready();
    const rows=(await client.query(`SELECT d.* FROM doni_pendenti d
      WHERE status IN ('PENDING','FAILED') AND expires_at<=now() AND tx_hash IS NULL
      AND NOT EXISTS(SELECT 1 FROM pharaoh_treasury_movements m WHERE m.movement_key='PAYOUT:'||d.id::text AND m.tx_hash IS NOT NULL)
      ORDER BY expires_at,id LIMIT $1 FOR UPDATE`,[Math.max(1,Math.min(1000,Number(limit)||200))])).rows;
    for(const row of rows) {
      const reserve=await reserveFor(row,client),key=`PAYOUT:${row.id}`;
      const movement=await ledger.store.movement(key);
      if(movement) {
        if(movement.status!=='PREPARED' || movement.tx_hash || movement.signed_raw_tx)throw A.error('SIGNED_PAYOUT_CANNOT_EXPIRE');
        await client.query("UPDATE pharaoh_treasury_movements SET status='CANCELLED',last_error='EXPIRED_BEFORE_SIGNING',updated_at=now() WHERE movement_key=$1",[key]);
      }
      const destination=`TREASURY:EXPIRED_PAYOUT:${row.id}`;
      await ledger.reallocate({eventKey:`EXPIRE_PAYOUT:${row.id}`,inputs:[{key:reserve,amountAtomic:A.usdc(String(row.importo))}],outputs:[{key:destination,wallet:process.env.PHARAOH_TREASURY_WALLET,purpose:'TREASURY_EXPIRED_OWN_FUNDS',amountAtomic:A.usdc(String(row.importo))}],context:{pendingGiftId:String(row.id)}});
      await client.query("UPDATE doni_pendenti SET status='EXPIRED',expired_at=now(),dettagli=dettagli||$2::jsonb WHERE id=$1",[row.id,A.json({destinazione:'CASSA_PHARAOH',economicBucket:destination})]);
      await client.query("INSERT INTO audit_doni_pendenti(dono_pendente_id,evento,dettagli) VALUES($1,'EXPIRED',$2::jsonb)",[row.id,A.json({economicBucket:destination})]);
    }
    await client.query('COMMIT');return {expired:rows.length,destinazione:{destinazione:'CASSA_PHARAOH',wallet:process.env.PHARAOH_TREASURY_WALLET}};
  }catch(error){try{await client.query('ROLLBACK');}catch(_){}throw error;}finally{client.release();}
}
module.exports={validateNewGift,prepareAndRun,reconcileAccepted,expireUnsent};
