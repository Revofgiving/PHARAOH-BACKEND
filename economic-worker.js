'use strict';
/** Treasury/progression worker. It never creates an economic entitlement and
 * never initiates a recipient payout without its separate acceptance flow.
 * Cross-platform dispatch remains controlled by CROSS_OUTBOUND_WORKER_ENABLED.
 */
const A=require('./economic-amounts');
const INTERNAL_PURPOSES=Object.freeze(['GEMELLI_RESERVE_OUT','GEMELLI_FUNDING_IN','CONTINUITY_IN','PROJECTS_BOOTSTRAP_OUT','THOT_PROJECTS_OUT','PROJECTS_HUMANITARIAN_OUT','PROJECTS_MAINTENANCE_OUT']);
const CYCLE_LOCK='PHARAOH:ECONOMY:WORKER';
class EconomicWorker {
  constructor({repository,dispatcher,register,advance,reconcilePayouts,isBlocked}) {
    Object.assign(this,{repository,dispatcher,register,advance,reconcilePayouts,isBlocked});this.running=false;
  }
  async run(limit=20) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw A.error('ECONOMIC_WORKER_BATCH_INVALID');
    if(this.running)return {skipped:'LOCAL_CYCLE_RUNNING'};
    this.running=true;
    try{return await this.repository.withCycleLock(async()=>{
      if(await this.isBlocked())return {skipped:'SYSTEM_BLOCKED'};
      if(!await this.repository.isActive())return {skipped:'ECONOMIC_CUTOVER_NOT_ACTIVE'};
      const movements=[];
      for(const original of await this.repository.listInternal(limit)) {
        if(!INTERNAL_PURPOSES.includes(original.purpose))throw A.error('ECONOMIC_WORKER_FORBIDDEN_PURPOSE');
        if(await this.isBlocked())return {movements,skipped:'SYSTEM_BLOCKED'};
        try {
          const transfer=await this.dispatcher.run(original.movement_key);
          if(!transfer.confirmed){movements.push({movementKey:original.movement_key,status:transfer.status});continue;}
          const row=await this.dispatcher.read(original.movement_key);
          if(row.status==='REGISTERED'){movements.push({movementKey:row.movement_key,status:'REGISTERED'});continue;}
          const result=await this.register(row,hash=>this.repository.registrySubmitted(row.movement_key,hash));
          await this.repository.registryCompleted(row.movement_key,result);
          movements.push({movementKey:row.movement_key,status:'REGISTERED'});
        } catch(error) {
          movements.push({movementKey:original.movement_key,status:'RETRY_OR_RECONCILIATION_REQUIRED',code:String(error.code||'ECONOMIC_WORKER_STEP_FAILED')});
        }
      }
      if(await this.isBlocked())return {movements,skipped:'SYSTEM_BLOCKED'};
      const payouts=await this.reconcilePayouts(limit);
      if(await this.isBlocked())return {movements,payouts,skipped:'SYSTEM_BLOCKED'};
      const progression=await this.advance(limit);
      return {movements,payouts,progression};
    });}finally{this.running=false;}
  }
}
function pgWorkerRepository(pg=require('./pg-connection-manager')) {
  const tx=require('./treasury-transfer-manager').pgRepository(pg);
  return {
    async withCycleLock(fn) {
      const client=await pg.getClient();let locked=false;
      try{locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[CYCLE_LOCK])).rows[0]?.locked===true;
        if(!locked)return {skipped:'OTHER_CYCLE_RUNNING'};return await fn();}
      finally{if(locked)try{await client.query('SELECT pg_advisory_unlock(hashtext($1))',[CYCLE_LOCK]);}catch(_){}client.release();}
    },
    async isActive(){const row=await pg.queryOne('SELECT status FROM pharaoh_economic_activation WHERE singleton=true');return row?.status==='ACTIVE';},
    async listInternal(limit){return pg.queryMany(`SELECT movement_key,purpose,status FROM pharaoh_treasury_movements
      WHERE purpose=ANY($1::text[]) AND status NOT IN ('REGISTERED','CANCELLED') ORDER BY created_at,movement_key LIMIT $2`,[INTERNAL_PURPOSES,limit]);},
    async registrySubmitted(key,hash) {
      await tx.transaction(async({ledger,client})=>{
        await ledger.ready();const row=await ledger.store.movement(key);
        const canonical=A.hash(hash);
        if(!row||!['CONFIRMED','REGISTERED'].includes(row.status)||!row.tx_hash)throw A.error('REGISTRY_REQUIRES_SETTLED_MOVEMENT');
        if(row.registry_tx_hash && row.registry_tx_hash!==canonical)throw A.error('KNOWN_REGISTRY_HASH_CANNOT_BE_REPLACED');
        await client.query('UPDATE pharaoh_treasury_movements SET registry_tx_hash=$2,updated_at=now() WHERE movement_key=$1',[key,canonical]);
      });
    },
    async registryCompleted(key,result) {
      await tx.transaction(async({ledger,client})=>{
        await ledger.ready();const row=await ledger.store.movement(key);
        if(!row||!['CONFIRMED','REGISTERED'].includes(row.status)||!row.tx_hash||!result?.txHash||result.txId==null||result.blockNumber==null)throw A.error('REGISTRY_CONFIRMATION_INCOMPLETE');
        const hash=A.hash(result.txHash);
        if(row.registry_tx_hash && row.registry_tx_hash!==hash)throw A.error('KNOWN_REGISTRY_HASH_CANNOT_BE_REPLACED');
        if(row.registry_result && A.digest(row.registry_result)!==A.digest(result))throw A.error('REGISTRY_RESULT_CONFLICT');
        await client.query("UPDATE pharaoh_treasury_movements SET status='REGISTERED',registry_tx_hash=$2,registry_result=$3::jsonb,last_error=NULL,updated_at=now() WHERE movement_key=$1",[key,hash,A.json(result)]);
      });
    }
  };
}
function configuredWorker() {
  const {configuredDispatcher}=require('./treasury-transfer-manager'),dispatcher=configuredDispatcher();
  return new EconomicWorker({repository:pgWorkerRepository(),dispatcher,
    async register(row,onSubmitted) {
      return require('./subwallet-registry-manager').registerConfirmedSubwalletMovement({eventKey:row.movement_key,purpose:row.purpose,
        amountAtomic:A.atomic(row.amount_atomic),externalTxHash:row.tx_hash,destinationWallet:row.destination_wallet,existingRegistryTxHash:row.registry_tx_hash,onSubmitted},
      {verifier:{verificaDonazione:async()=>{
        const proof=await dispatcher.chain.verify(row);if(!proof)throw A.error('REGISTRY_SETTLEMENT_NOT_CONFIRMED');return proof;
      }}});
    },
    advance:limit=>require('./donation-flow-manager').recuperaOperazioniPostCommit(limit),
    reconcilePayouts:limit=>require('./payout-economic-adapter').reconcileAccepted(limit),
    isBlocked:async()=>Boolean((await require('./db-manager').getStatoBlocco())?.bloccato)
  });
}
function startEconomicWorker({logger=console}={}) {
  if(process.env.PHARAOH_ECONOMIC_WORKER_ENABLED!=='1')return null;
  const interval=Number(process.env.PHARAOH_ECONOMIC_WORKER_INTERVAL_MS||15000),batch=Number(process.env.PHARAOH_ECONOMIC_WORKER_BATCH||20);
  if(!Number.isSafeInteger(interval)||interval<5000||interval>3600000||!Number.isSafeInteger(batch)||batch<1||batch>100)throw A.error('ECONOMIC_WORKER_CONFIG_INVALID');
  const worker=configuredWorker();
  const run=async()=>{try{const r=await worker.run(batch);const failures=[...(r.movements?.filter(m=>m.code)||[]),...(r.payouts?.filter(m=>m.code)||[])];if(failures.length)logger.warn('ECONOMIC_WORKER_RECONCILIATION',A.json(failures));if(r.progression?.fallite)logger.warn('ECONOMIC_PROGRESSION_PENDING',A.json({failed:r.progression.fallite,completed:r.progression.completate}));}catch(error){logger.error('ECONOMIC_WORKER_ERROR',error.code||'FAILED');}};
  const timer=setInterval(run,interval);timer.unref();setImmediate(run);return timer;
}
module.exports={EconomicWorker,configuredWorker,pgWorkerRepository,startEconomicWorker,INTERNAL_PURPOSES};
