'use strict';
/** Settled-value ledger. Internal allocations conserve USDC per wallet.
 * An ERC20 proof is the only non-cutover source of value. A number supplied by
 * a caller (e.g. settledAvailableAtomic) is never accepted as funding evidence.
 */
const A = require('./economic-amounts');
const { PgEconomicStore } = require('./economic-store');
function normalizeProof(verification, expected, cfg) {
  if (verification?.valida !== true || !verification.proof) throw A.error('SETTLED_ERC20_PROOF_REQUIRED');
  const p = verification.proof;
  const proof = {
    txHash: A.hash(p.txHash), from: A.address(p.from), to: A.address(p.to),
    tokenContract: A.address(p.tokenContract, 'TOKEN'), chainId: A.positive(p.chainId, 'CHAIN_ID').toString(),
    amountBaseUnits: A.positive(p.amountBaseUnits, 'PROOF_AMOUNT').toString(),
    blockNumber: A.positive(p.blockNumber, 'BLOCK_NUMBER').toString(), blockHash: A.hash(p.blockHash, 'BLOCK_HASH'),
    confirmations: A.positive(p.confirmations, 'CONFIRMATIONS').toString(),
    transferLogIndexes: p.transferLogIndexes
  };
  if (proof.from !== A.address(expected.from) || proof.to !== A.address(expected.to) ||
      proof.amountBaseUnits !== A.positive(expected.amountAtomic).toString() ||
      proof.tokenContract !== A.address(cfg.token) || proof.chainId !== A.positive(cfg.chainId).toString() ||
      BigInt(proof.confirmations) < A.positive(cfg.minConfirmations)) throw A.error('SETTLED_ERC20_PROOF_MISMATCH');
  if (expected.txHash && proof.txHash !== A.hash(expected.txHash)) throw A.error('SETTLED_TX_HASH_MISMATCH');
  if (!Array.isArray(proof.transferLogIndexes) || !proof.transferLogIndexes.length ||
      proof.transferLogIndexes.some(n => !Number.isSafeInteger(n) || n < 0) ||
      new Set(proof.transferLogIndexes).size !== proof.transferLogIndexes.length) throw A.error('SETTLED_LOGS_INVALID');
  proof.transferLogIndexes = [...proof.transferLogIndexes].sort((a,b)=>a-b);
  return proof;
}
class EconomicLedger {
  constructor(store, config) { this.store = store; this.config = config; }
  async ready() {
    await this.store.lock();
    const state = await this.store.activation();
    if (state?.status !== 'ACTIVE' || !/^[0-9a-f]{64}$/.test(state.evidence_hash || '') || !['FRESH','ADOPTED'].includes(state.mode)) throw A.error('ECONOMIC_CUTOVER_NOT_ACTIVE');
  }
  async event(key, kind, context, execute) {
    A.key(key); await this.ready();
    const fingerprint = A.digest({ kind, context });
    const previous = await this.store.event(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.kind !== kind) throw A.error('ECONOMIC_EVENT_CONFLICT', { key });
      if (previous.status !== 'COMPLETED') throw A.error('ECONOMIC_EVENT_INCOMPLETE', { key });
      return previous.result;
    }
    await this.store.startEvent(key, kind, fingerprint, context);
    const result = A.canonical(await execute());
    if (!await this.store.completeEvent(key, result)) throw A.error('ECONOMIC_EVENT_NOT_COMPLETED');
    return result;
  }
  async ensureBucket(b) {
    const spec = { key: A.key(b.key,'BUCKET'), wallet: A.address(b.wallet), purpose: A.key(b.purpose,'PURPOSE'), metadata: b.metadata || {} };
    const existing = await this.store.ensureBucket(spec);
    if (!existing || existing.wallet !== spec.wallet || existing.purpose !== spec.purpose || A.digest(existing.metadata) !== A.digest(spec.metadata)) throw A.error('ECONOMIC_BUCKET_IDENTITY_CONFLICT', { key: spec.key });
    return existing;
  }
  async claimProof(eventKey, proof) {
    for (const log of proof.transferLogIndexes) {
      await this.store.claimProof(`${proof.chainId}:${proof.tokenContract}:${proof.txHash}:${log}`, eventKey, proof, log);
    }
  }
  async incoming({ eventKey, bucket, verification, from, amountAtomic, txHash }) {
    const amount = A.positive(amountAtomic);
    const proof = normalizeProof(verification, { from, to: bucket.wallet, amountAtomic: amount, txHash }, this.config);
    // Confirmations may grow on retry; use immutable evidence only in the fingerprint.
    const { confirmations, ...immutable } = proof;
    return this.event(eventKey, 'SETTLED_INCOMING', { bucket, amount, proof: immutable }, async () => {
      const activation=await this.store.activation();
      if(activation.mode==='ADOPTED' && (activation.cutover_block_number==null || BigInt(proof.blockNumber)<=BigInt(activation.cutover_block_number)))throw A.error('PRE_CUTOVER_PROOF_RECONCILIATION_REQUIRED');
      await this.claimProof(eventKey, proof);
      await this.ensureBucket(bucket);
      await this.store.changeBucket(bucket.key, amount, eventKey, 0);
      return { bucket: bucket.key, amountAtomic: amount, txHash: proof.txHash };
    });
  }
  async balance(key) {
    const row = await this.store.bucket(A.key(key));
    if (!row) throw A.error('ECONOMIC_BUCKET_MISSING', { key });
    return A.atomic(row.balance_atomic);
  }
  async reallocate({ eventKey, inputs, outputs, context = {}, exactInputs = false }) {
    if (!Array.isArray(inputs) || !inputs.length || !Array.isArray(outputs) || !outputs.length) throw A.error('ALLOCATION_INPUTS_OUTPUTS_REQUIRED');
    const source = inputs.map(i=>({ key: A.key(i.key), amount: A.positive(i.amountAtomic) }));
    const dest = outputs.map(o=>({ ...o, key:A.key(o.key), wallet:A.address(o.wallet), purpose:A.key(o.purpose), amountAtomic:A.positive(o.amountAtomic), metadata:o.metadata || {} }));
    if (new Set(source.map(i=>i.key)).size !== source.length || new Set(dest.map(i=>i.key)).size !== dest.length) throw A.error('DUPLICATE_ALLOCATION_BUCKET');
    if (source.some(i=>dest.some(o=>o.key===i.key))) throw A.error('ALLOCATION_SELF_TRANSFER');
    if (source.reduce((n,i)=>n+i.amount,0n) !== dest.reduce((n,o)=>n+o.amountAtomic,0n)) throw A.error('UNBALANCED_ECONOMIC_ALLOCATION');
    return this.event(eventKey, 'INTERNAL_ALLOCATION', { source, dest, context, exactInputs }, async ()=> {
      const sums = new Map();
      for (const i of source) {
        const b = await this.store.bucket(i.key);
        if (!b || A.atomic(b.balance_atomic) < i.amount) throw A.error('ALLOCATION_FUNDING_MISSING', { key:i.key });
        if (exactInputs && A.atomic(b.balance_atomic) !== i.amount) throw A.error('ALLOCATION_EXACT_FUNDING_REQUIRED', { key:i.key });
        if (await this.store.boundMovement(i.key)) throw A.error('BUCKET_BOUND_TO_TRANSFER', { key:i.key });
        sums.set(b.wallet,(sums.get(b.wallet)||0n)-i.amount);
      }
      for (const o of dest) {
        if (await this.store.boundMovement(o.key)) throw A.error('BUCKET_BOUND_TO_TRANSFER', { key:o.key });
        await this.ensureBucket(o); sums.set(o.wallet,(sums.get(o.wallet)||0n)+o.amountAtomic);
      }
      if ([...sums.values()].some(v=>v!==0n)) throw A.error('ALLOCATION_CANNOT_MOVE_VALUE_BETWEEN_WALLETS');
      let ordinal=0;
      for (const i of source) await this.store.changeBucket(i.key,-i.amount,eventKey,ordinal++);
      for (const o of dest) await this.store.changeBucket(o.key,o.amountAtomic,eventKey,ordinal++);
      return { funded: true, inputs:source.map(i=>i.key), outputs:dest.map(o=>({key:o.key,amountAtomic:o.amountAtomic})) };
    });
  }
  async prepareMovement({ key, reserveBucket, to, amountAtomic, purpose, destinationBucket=null, destinationPurpose=null, dependsOn=null }) {
    const amount=A.positive(amountAtomic); const toWallet=A.address(to);
    if (dependsOn) A.key(dependsOn, 'DEPENDENCY');
    if (Boolean(destinationBucket)!==Boolean(destinationPurpose)) throw A.error('MOVEMENT_DESTINATION_BUCKET_INCOMPLETE');
    return this.event(`PREPARE:${A.key(key)}`, 'PREPARE_TRANSFER', {key,reserveBucket,to:toWallet,amount,purpose,destinationBucket,destinationPurpose,dependsOn}, async ()=>{
      const bucket=await this.store.bucket(A.key(reserveBucket));
      if (!bucket || A.atomic(bucket.balance_atomic)!==amount) throw A.error('TRANSFER_REQUIRES_EXACT_RESERVE');
      if (bucket.wallet===toWallet) throw A.error('SELF_TRANSFER_FORBIDDEN');
      if (await this.store.boundMovement(reserveBucket)) throw A.error('RESERVE_ALREADY_BOUND');
      const row=await this.store.createMovement({key,reserveBucket,sourceWallet:bucket.wallet,destinationWallet:toWallet,amountAtomic:amount,purpose,destinationBucket,destinationPurpose,dependsOn});
      return {movementKey:row.movement_key,status:row.status,reserveBucket};
    });
  }
  async settleMovement({ movementKey, verification }) {
    await this.ready();
    const m=await this.store.movement(A.key(movementKey));
    if (!m) throw A.error('TRANSFER_NOT_PREPARED');
    if(m.status==='CANCELLED')throw A.error('TRANSFER_CANCELLED');
    const proof=normalizeProof(verification,{from:m.source_wallet,to:m.destination_wallet,amountAtomic:m.amount_atomic,txHash:m.tx_hash},this.config);
    const {confirmations,...immutable}=proof;
    return this.event(`SETTLE:${movementKey}`, 'SETTLE_TRANSFER', { movementKey, proof:immutable }, async ()=>{
      const activation=await this.store.activation();
      if(activation.mode==='ADOPTED' && BigInt(proof.blockNumber)<=A.positive(activation.cutover_block_number,'CUTOVER_BLOCK'))throw A.error('PRE_CUTOVER_OUTGOING_PROOF_REQUIRES_REVIEW');
      if (A.atomic((await this.store.bucket(m.reserve_bucket))?.balance_atomic)!==A.atomic(m.amount_atomic)) throw A.error('TRANSFER_RESERVE_DRIFT');
      await this.claimProof(`SETTLE:${movementKey}`,proof);
      await this.store.changeBucket(m.reserve_bucket,-A.atomic(m.amount_atomic),`SETTLE:${movementKey}`,0);
      if (m.destination_bucket) {
        await this.ensureBucket({key:m.destination_bucket,wallet:m.destination_wallet,purpose:m.destination_purpose});
        await this.store.changeBucket(m.destination_bucket,A.atomic(m.amount_atomic),`SETTLE:${movementKey}`,1);
      }
      await this.store.confirmMovement(movementKey,proof);
      return {movementKey,txHash:proof.txHash,amountAtomic:m.amount_atomic,status:'CONFIRMED'};
    });
  }
  async assertSolvent(wallet, settledAtomic) {
    const settled=A.atomic(settledAtomic); const reserved=A.atomic((await this.store.reserved(A.address(wallet))).atomic);
    if(settled<reserved) throw A.error('TREASURY_RESERVATIONS_EXCEED_SETTLED_BALANCE',{settled:settled.toString(),reserved:reserved.toString()});
    return {settledAtomic:settled,reservedAtomic:reserved,freeAtomic:settled-reserved};
  }
}
function configuredLedger(client) {
  return new EconomicLedger(new PgEconomicStore(client), {
    token:process.env.USDC_CONTRACT_ADDRESS,
    chainId:process.env.POLYGON_CHAIN_ID || '137',
    minConfirmations:process.env.POLYGON_MIN_CONFIRMATIONS || '1'
  });
}
module.exports={EconomicLedger,configuredLedger,normalizeProof};
