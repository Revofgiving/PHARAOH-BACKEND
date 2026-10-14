'use strict';
/** Durable, at-most-one automatic broadcast per movement. Signed bytes/hash are
 * committed BEFORE network submission. Unknown outcomes are reconciled and a
 * replacement transaction is never manufactured automatically.
 */
const A=require('./economic-amounts');
const {configuredLedger}=require('./economic-ledger');
const subwalletPolicy=require('./treasury-subwallet-policy');
const GLOBAL_SIGNER_LOCK='PHARAOH:PAYOUT:SIGNER';
const CONFIRMED=new Set(['CONFIRMED','REGISTERED']);

class TransferDispatcher {
  constructor({repository,chain,config}){this.repo=repository;this.chain=chain;this.config=config;}
  async read(key){return this.repo.transaction(async({ledger,store})=>{await ledger.ready();const m=await store.movement(key);if(!m)throw A.error('TRANSFER_NOT_PREPARED');return m;});}
  public(m){return {movementKey:m.movement_key,status:m.status,txHash:m.tx_hash||null,confirmed:CONFIRMED.has(m.status),proof:m.proof||null};}

  async assertProjectsFloor(store,m,preSpendBalanceAtomic) {
    const projects=A.address(this.config.projectsWallet);
    if(m.source_wallet!==projects)return;
    const structural=await store.bucket('PROJECTS:STRUCTURAL_CAPITAL');
    if(!structural || structural.wallet!==projects || structural.purpose!=='PROJECTS_STRUCTURAL_CAPITAL' || A.atomic(structural.balance_atomic)!==A.usdc('100'))throw A.error('PROJECTS_SETTLED_STRUCTURAL_CAPITAL_REQUIRED');
    const reserved=A.atomic((await store.reserved(projects)).atomic);
    const amount=A.atomic(m.amount_atomic),floor=A.usdc('100');
    if(reserved<amount+floor)throw A.error('PROJECTS_RESERVATION_STATE_INVALID');
    const otherReserved=reserved-amount-floor;
    subwalletPolicy.requireProjectsFloorAfterSpend({settledAtomic:A.atomic(preSpendBalanceAtomic),otherReservedAtomic:otherReserved,amountAtomic:amount});
  }

  async checkSettledWalletPolicy(m) {
    const g=A.address(this.config.gemelliWallet),p=A.address(this.config.projectsWallet);
    if(m.source_wallet!==g && m.destination_wallet!==g && m.source_wallet!==p)return;
    const snapshot=await this.chain.balances(m);
    if(m.source_wallet===g && A.atomic(snapshot.sourceAtomic)!==0n)throw A.error('GEMELLI_RETURN_POST_BALANCE_NOT_ZERO');
    if(m.destination_wallet===g && A.atomic(snapshot.destinationAtomic)!==A.usdc('500'))throw A.error('GEMELLI_DEPOSIT_POST_BALANCE_NOT_500');
    if(m.source_wallet===p) {
      await this.repo.transaction(async({ledger,store})=>{
        await ledger.ready();
        await this.assertProjectsFloor(store,m,A.atomic(snapshot.sourceAtomic)+A.atomic(m.amount_atomic));
      });
    }
  }

  async reconcile(key,m) {
    const verification=await this.chain.verify(m);
    if(!verification)return this.public(m);
    await this.checkSettledWalletPolicy(m);
    await this.repo.transaction(async({ledger})=>ledger.settleMovement({movementKey:key,verification}));
    return this.public(await this.read(key));
  }

  async assertFirstBroadcast(m) {
    await this.chain.preflightSigned(m);
    const snapshot=await this.chain.balances(m);
    await this.repo.transaction(async({ledger,store})=>{
      await ledger.ready();
      const current=await store.movement(m.movement_key);
      if(!current || current.status!=='SIGNED' || current.broadcast_attempted_at || current.tx_hash!==m.tx_hash)throw A.error('BROADCAST_STATE_CHANGED');
      if(await store.unresolvedSigner(m.source_wallet,m.movement_key))throw A.error('SIGNER_PREVIOUS_TRANSACTION_UNRESOLVED');
      await ledger.assertSolvent(m.source_wallet,snapshot.sourceAtomic);
      const g=A.address(this.config.gemelliWallet);
      if(m.source_wallet===g && A.atomic(snapshot.sourceAtomic)!==A.usdc('500'))throw A.error('GEMELLI_BALANCE_MUST_BE_500_BEFORE_RETURN');
      if(m.destination_wallet===g && A.atomic(snapshot.destinationAtomic)!==0n)throw A.error('GEMELLI_DOUBLE_DEPOSIT_FORBIDDEN');
      await this.assertProjectsFloor(store,m,snapshot.sourceAtomic);
    });
  }

  async assertPolicy(m) {
    const treasury=A.address(this.config.treasuryWallet),gemelli=A.address(this.config.gemelliWallet),projects=A.address(this.config.projectsWallet);
    const managed=new Set([treasury,gemelli,projects]);
    if(!managed.has(m.source_wallet))throw A.error('UNMANAGED_TRANSFER_SOURCE');

    if(m.source_wallet===projects) {
      if(!subwalletPolicy.PROJECTS_OUT_PURPOSES.includes(m.purpose))throw A.error('PROJECTS_OUTGOING_PURPOSE_FORBIDDEN');
      if(managed.has(m.destination_wallet))throw A.error('PROJECTS_DESTINATION_MUST_BE_EXTERNAL');
      if(A.atomic(m.amount_atomic)>50000n*subwalletPolicy.DECIMALS)throw A.error('TRANSFER_LIMIT_50000_USDC');
      if(m.destination_bucket || m.destination_purpose)throw A.error('PROJECTS_EXTERNAL_DESTINATION_BUCKET_FORBIDDEN');
    }

    if(m.source_wallet===gemelli && (!['GEMELLI_FUNDING_IN','CONTINUITY_IN'].includes(m.purpose)||m.destination_wallet!==treasury||A.atomic(m.amount_atomic)!==A.usdc('500')))throw A.error('GEMELLI_OUTGOING_POLICY_MISMATCH');
    if(m.destination_wallet===gemelli && A.atomic(m.amount_atomic)!==A.usdc('500'))throw A.error('GEMELLI_RESERVE_AMOUNT_INVALID');
    if(m.depends_on) {
      const d=await this.read(m.depends_on);
      if(!CONFIRMED.has(d.status))throw A.error('TRANSFER_DEPENDENCY_NOT_SETTLED');
    }
  }

  async run(key) {
    A.key(key);
    return this.repo.withSignerLock(async()=>{
      let m=await this.read(key);if(m.status==='CANCELLED')throw A.error('TRANSFER_CANCELLED');
      if(CONFIRMED.has(m.status))return this.public(m);
      await this.assertPolicy(m);
      if(m.tx_hash) {
        const result=await this.reconcile(key,m);
        if(result.confirmed)return result;
        if(m.broadcast_attempted_at || m.status==='RECONCILIATION_REQUIRED' || !m.signed_raw_tx)return result;
        if(await this.chain.knownTransaction(m.tx_hash))return result;
      }
      if(!m.tx_hash) {
        if(m.status!=='PREPARED')throw A.error('UNSIGNED_TRANSFER_STATE_INVALID');
        const snapshot=await this.chain.balances(m);
        await this.repo.transaction(async({ledger,store})=>{
          await ledger.ready();const current=await store.movement(key);
          if(current.status!=='PREPARED'||current.tx_hash)throw A.error('TRANSFER_STATE_CHANGED');
          if(await store.unresolvedSigner(m.source_wallet,key))throw A.error('SIGNER_PREVIOUS_TRANSACTION_UNRESOLVED');
          await ledger.assertSolvent(m.source_wallet,snapshot.sourceAtomic);
          const g=A.address(this.config.gemelliWallet);
          if(m.source_wallet===g&&A.atomic(snapshot.sourceAtomic)!==A.usdc('500'))throw A.error('GEMELLI_BALANCE_MUST_BE_500_BEFORE_RETURN');
          if(m.destination_wallet===g&&A.atomic(snapshot.destinationAtomic)!==0n)throw A.error('GEMELLI_DOUBLE_DEPOSIT_FORBIDDEN');
          if(A.atomic((await store.bucket(m.reserve_bucket)).balance_atomic)!==A.atomic(m.amount_atomic))throw A.error('TRANSFER_RESERVE_DRIFT');
          await this.assertProjectsFloor(store,m,snapshot.sourceAtomic);
        });
        const signed=await this.chain.sign(m);
        A.hash(signed.txHash);A.atomic(signed.nonce,'NONCE');
        if(typeof signed.raw!=='string'||!/^0x[0-9a-f]+$/i.test(signed.raw))throw A.error('SIGNED_BYTES_INVALID');
        await this.repo.transaction(async({ledger,store})=>{
          await ledger.ready();const current=await store.movement(key);
          if(current.status!=='PREPARED'||current.tx_hash)throw A.error('TRANSFER_STATE_CHANGED');
          await ledger.assertSolvent(m.source_wallet,snapshot.sourceAtomic);
          if(!await store.saveSigned(key,signed))throw A.error('SIGNED_TRANSACTION_NOT_PERSISTED');
        });
        m=await this.read(key);
      }
      await this.assertFirstBroadcast(m);
      await this.repo.transaction(async({ledger,store})=>{
        await ledger.ready();if(!await store.markBroadcastAttempted(key))throw A.error('BROADCAST_ALREADY_ATTEMPTED');
      });
      try {
        const broadcast=await this.chain.broadcast(m.signed_raw_tx);
        if(A.hash(broadcast.hash)!==m.tx_hash)throw A.error('BROADCAST_HASH_MISMATCH');
      } catch(error) {
        await this.repo.transaction(async({store})=>store.requireReconciliation(key,error.code||'BROADCAST_OUTCOME_UNKNOWN'));
        throw A.error('TRANSFER_RECONCILIATION_REQUIRED',{movementKey:key,txHash:m.tx_hash});
      }
      return this.reconcile(key,await this.read(key));
    });
  }

  async attachManualProof(key,txHash) {
    return this.repo.withSignerLock(async()=>{
      const m=await this.read(A.key(key));await this.assertPolicy(m);
      if(m.tx_hash && m.tx_hash!==A.hash(txHash))throw A.error('KNOWN_TRANSFER_HASH_CANNOT_BE_REPLACED');
      if(m.signed_raw_tx && m.tx_hash!==A.hash(txHash))throw A.error('SIGNED_TRANSFER_ALREADY_EXISTS');
      const proof=await this.chain.verify({...m,tx_hash:A.hash(txHash)});
      if(!proof)throw A.error('MANUAL_TRANSFER_NOT_SETTLED');
      await this.checkSettledWalletPolicy(m);
      await this.repo.transaction(async({ledger})=>ledger.settleMovement({movementKey:key,verification:proof}));
      return this.public(await this.read(key));
    });
  }
}

function pgRepository(database=require('./pg-connection-manager')) {
  return {
    async transaction(fn) {
      const client=await database.getClient();
      try {await client.query('BEGIN');const ledger=configuredLedger(client);const result=await fn({ledger,store:ledger.store,client});await client.query('COMMIT');return result;}
      catch(error){try{await client.query('ROLLBACK');}catch(_){}throw error;}finally{client.release();}
    },
    async withSignerLock(fn) {
      const client=await database.getClient();let locked=false;
      try {await client.query('SELECT pg_advisory_lock(hashtext($1))',[GLOBAL_SIGNER_LOCK]);locked=true;return await fn();}
      finally {if(locked)try{await client.query('SELECT pg_advisory_unlock(hashtext($1))',[GLOBAL_SIGNER_LOCK]);}catch(_){}client.release();}
    }
  };
}
function configuredDispatcher(dependencies={}) {
  const config={treasuryWallet:process.env.PHARAOH_TREASURY_WALLET,gemelliWallet:process.env.PHARAOH_GEMELLI_WALLET,
    projectsWallet:process.env.PHARAOH_PROJECTS_WALLET,token:process.env.USDC_CONTRACT_ADDRESS,
    chainId:process.env.POLYGON_CHAIN_ID||'137',minConfirmations:process.env.POLYGON_MIN_CONFIRMATIONS||'1'};
  const {createTreasuryChain}=require('./treasury-chain-adapter');
  return new TransferDispatcher({repository:dependencies.repository||pgRepository(dependencies.pg),chain:dependencies.chain||createTreasuryChain(config),config});
}
module.exports={TransferDispatcher,configuredDispatcher,pgRepository,GLOBAL_SIGNER_LOCK};
