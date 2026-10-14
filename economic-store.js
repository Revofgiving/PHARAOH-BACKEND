'use strict';
/** PostgreSQL repository. Every mutating method requires the caller's transaction.
 * The single advisory lock gives all accounting/S0 operations a consistent order.
 * No network request or broadcast belongs inside these transactions.
 */
const { error, json } = require('./economic-amounts');
const LOCK = 'PHARAOH:ECONOMY:V4';
class PgEconomicStore {
  constructor(client) {
    if (!client || typeof client.query !== 'function') throw error('ECONOMIC_TRANSACTION_CLIENT_REQUIRED');
    this.client = client;
  }
  async one(sql, values = []) { return (await this.client.query(sql, values)).rows[0] || null; }
  async many(sql, values = []) { return (await this.client.query(sql, values)).rows; }
  async lock() { await this.client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK]); }
  async activation() { return this.one('SELECT * FROM pharaoh_economic_activation WHERE singleton=true'); }
  async event(key) { return this.one('SELECT * FROM pharaoh_economic_events WHERE event_key=$1', [key]); }
  async startEvent(key, kind, fingerprint, context) {
    return this.one(`INSERT INTO pharaoh_economic_events(event_key,kind,fingerprint,context)
      VALUES($1,$2,$3,$4::jsonb) RETURNING *`, [key, kind, fingerprint, json(context)]);
  }
  async completeEvent(key, result) {
    return this.one(`UPDATE pharaoh_economic_events SET status='COMPLETED',result=$2::jsonb,completed_at=now()
      WHERE event_key=$1 AND status='STARTED' RETURNING *`, [key, json(result)]);
  }
  async bucket(key) { return this.one('SELECT * FROM pharaoh_economic_buckets WHERE bucket_key=$1 FOR UPDATE', [key]); }
  async ensureBucket(b) {
    await this.client.query(`INSERT INTO pharaoh_economic_buckets(bucket_key,wallet,purpose,metadata)
      VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(bucket_key) DO NOTHING`, [b.key,b.wallet,b.purpose,json(b.metadata || {})]);
    return this.bucket(b.key);
  }
  async boundMovement(key) { return this.one("SELECT * FROM pharaoh_treasury_movements WHERE reserve_bucket=$1 AND status<>'CANCELLED'", [key]); }
  async changeBucket(key, delta, event, ordinal) {
    const row = await this.one(`UPDATE pharaoh_economic_buckets
      SET balance_atomic=balance_atomic+$2::numeric,updated_at=now()
      WHERE bucket_key=$1 AND balance_atomic+$2::numeric>=0 RETURNING *`, [key,String(delta)]);
    if (!row) throw error('ECONOMIC_BUCKET_INSUFFICIENT', { bucket: key });
    await this.client.query(`INSERT INTO pharaoh_economic_journal(event_key,ordinal,bucket_key,delta_atomic,balance_after_atomic)
      VALUES($1,$2,$3,$4,$5)`, [event,ordinal,key,String(delta),row.balance_atomic]);
    return row;
  }
  async claimProof(proofKey, event, proof, logIndex) {
    const existing = await this.one('SELECT event_key FROM pharaoh_economic_proofs WHERE proof_key=$1', [proofKey]);
    if (existing) throw error('ECONOMIC_PROOF_ALREADY_CONSUMED', { event: existing.event_key });
    await this.client.query(`INSERT INTO pharaoh_economic_proofs(proof_key,event_key,chain_id,token,tx_hash,log_index,proof)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [proofKey,event,String(proof.chainId),proof.tokenContract,proof.txHash,logIndex,json(proof)]);
  }
  async reserved(wallet) {
    return this.one(`SELECT COALESCE(sum(balance_atomic),0)::text AS atomic
      FROM pharaoh_economic_buckets WHERE wallet=$1`, [wallet]);
  }
  async counters() { return this.one('SELECT * FROM pharaoh_s0_counters WHERE singleton=true FOR UPDATE'); }
  async incrementCounters(h, p) {
    return this.one(`UPDATE pharaoh_s0_counters SET human_cumulative=human_cumulative+$1::bigint,
      piletta_cumulative=piletta_cumulative+$2::bigint,updated_at=now()
      WHERE singleton=true AND seeded=true AND piletta_cumulative+$2::bigint<=human_cumulative+$1::bigint
      RETURNING *`, [String(h),String(p)]);
  }
  async economics(id) { return this.one('SELECT * FROM pharaoh_account_economics WHERE account_id=$1', [String(id)]); }
  async putEconomics(e) {
    await this.client.query(`INSERT INTO pharaoh_account_economics
      (account_id,root_account_id,position_class,owner_wallet,custody_wallet,origin,source_event_key)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id) DO NOTHING`,
    [String(e.accountId),String(e.rootAccountId),e.positionClass,e.ownerWallet,e.custodyWallet,e.origin,e.sourceEventKey]);
    return this.economics(e.accountId);
  }
  async membership(m) {
    return this.one(`INSERT INTO pharaoh_s0_memberships
      (posizione_id,account_id,event_key,entry_index,position_class,origin,numero_posizionale,amount_atomic)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [String(m.positionId),String(m.accountId),m.eventKey,m.index,m.positionClass,m.origin,String(m.number),String(m.amountAtomic)]);
  }
  async movement(key) { return this.one('SELECT * FROM pharaoh_treasury_movements WHERE movement_key=$1 FOR UPDATE', [key]); }
  async createMovement(m) {
    return this.one(`INSERT INTO pharaoh_treasury_movements
      (movement_key,reserve_bucket,source_wallet,destination_wallet,amount_atomic,purpose,destination_bucket,destination_purpose,depends_on)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [m.key,m.reserveBucket,m.sourceWallet,m.destinationWallet,String(m.amountAtomic),m.purpose,m.destinationBucket,m.destinationPurpose,m.dependsOn]);
  }
  async unresolvedSigner(wallet, excludingKey) {
    return this.one(`SELECT movement_key FROM pharaoh_treasury_movements
      WHERE source_wallet=$1 AND movement_key<>$2 AND tx_hash IS NOT NULL
      AND status NOT IN ('CONFIRMED','REGISTERED','CANCELLED') LIMIT 1`,[wallet,excludingKey]);
  }
  async saveSigned(key,signed) {
    return this.one(`UPDATE pharaoh_treasury_movements SET signed_raw_tx=$2,tx_hash=$3,sender_nonce=$4,
      chain_id=$5,token=$6,status='SIGNED',updated_at=now() WHERE movement_key=$1 AND status='PREPARED' AND tx_hash IS NULL RETURNING *`,
      [key,signed.raw,signed.txHash,String(signed.nonce),String(signed.chainId),signed.token]);
  }
  async markBroadcastAttempted(key) {
    return this.one(`UPDATE pharaoh_treasury_movements SET status='SUBMITTED',broadcast_attempted_at=now(),updated_at=now()
      WHERE movement_key=$1 AND status='SIGNED' AND broadcast_attempted_at IS NULL RETURNING *`,[key]);
  }
  async requireReconciliation(key,code) {
    return this.one(`UPDATE pharaoh_treasury_movements SET status='RECONCILIATION_REQUIRED',last_error=$2,updated_at=now()
      WHERE movement_key=$1 AND status NOT IN ('CONFIRMED','REGISTERED','CANCELLED') RETURNING *`,[key,String(code).slice(0,200)]);
  }
  async confirmMovement(key, proof) {
    return this.one(`UPDATE pharaoh_treasury_movements SET status='CONFIRMED',proof=$2::jsonb,
      tx_hash=$3,updated_at=now(),last_error=NULL WHERE movement_key=$1 RETURNING *`, [key,json(proof),proof.txHash]);
  }
}
module.exports = { PgEconomicStore, LOCK };
