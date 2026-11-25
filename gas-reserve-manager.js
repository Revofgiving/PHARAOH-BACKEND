'use strict';
/** PHARAOH commission reserve: append-only association to an existing economic bucket.
 * All operations require the caller's PostgreSQL transaction. No on-chain transfer.
 * A SENT payout becomes available only if the underlying settled movement matches.
 */
const A = require('./economic-amounts');
const FIVE = A.usdc('5').toString();
function gasDetails(row) {
  const d = typeof row.dettagli === 'string' ? JSON.parse(row.dettagli) : (row.dettagli || {});
  return d.commissioneGas || null;
}
function classifyPayout(row, movement) {
  if (row.status !== 'SENT') return 'PENDING';
  if (!row.tx_hash || !movement || !['CONFIRMED','REGISTERED'].includes(movement.status) ||
      String(row.tx_hash).toLowerCase() !== String(movement.tx_hash || '').toLowerCase() ||
      !movement.proof || String(movement.proof.txHash || '').toLowerCase() !== String(row.tx_hash).toLowerCase() || A.atomic(movement.amount_atomic || '0') !== A.usdc('5995') ||
      A.address(movement.destination_wallet || '') !== A.address(row.wallet) ||
      String(movement.reserve_bucket) !== String((typeof row.dettagli === 'string' ? JSON.parse(row.dettagli) : row.dettagli)?.economicReserveBucket)) throw A.error('GAS_RESERVE_PAYOUT_PROOF_REQUIRED');
  return 'AVAILABLE';
}
async function recordPending(client, row) {
  const gas = gasDetails(row);
  if (!gas || Number(gas.trattenutaUsdc) === 0) return null;
  if (Number(row.livello) !== 3 || Number(row.importo) !== 5995 ||
      Number(gas.lordoUsdc) !== 6000 || Number(gas.nettoUsdc) !== 5995 ||
      Number(gas.trattenutaUsdc) !== 5 || !gas.riservaBucket) throw A.error('GAS_RESERVE_POLICY_MISMATCH');
  const bucket = (await client.query('SELECT * FROM pharaoh_economic_buckets WHERE bucket_key=$1 FOR UPDATE', [gas.riservaBucket])).rows[0];
  if (!bucket || bucket.purpose !== 'GAS_RESERVE_PENDING' ||
      A.atomic(bucket.balance_atomic).toString() !== FIVE ||
      bucket.wallet !== A.address(process.env.PHARAOH_TREASURY_WALLET)) throw A.error('GAS_RESERVE_BUCKET_MISMATCH');
  const insertion = await client.query(`INSERT INTO pharaoh_gas_reserve_entries
     (payout_id,source_event_key,account_id,reserve_bucket,amount_atomic,status)
     VALUES ($1,$2,$3,$4,$5,'PENDING')
     ON CONFLICT(payout_id) DO NOTHING RETURNING *`,
     [row.id,row.event_key,row.account_id,gas.riservaBucket,FIVE]);
  const existing = insertion.rows[0] || (await client.query('SELECT * FROM pharaoh_gas_reserve_entries WHERE payout_id=$1 FOR UPDATE',[row.id])).rows[0];
  if (!existing || String(existing.source_event_key) !== String(row.event_key) ||
      String(existing.account_id) !== String(row.account_id) ||
      existing.reserve_bucket !== gas.riservaBucket || A.atomic(existing.amount_atomic).toString() !== FIVE)
    throw A.error('GAS_RESERVE_REPLAY_CONFLICT');
  return existing;
}
async function syncPayout(client, row) {
  const gas = gasDetails(row);
  if (!gas || Number(gas.trattenutaUsdc) === 0) return null;
  const entry = await recordPending(client,row);
  if (row.status === 'EXPIRED') {
    // Allocation can still contain funds; never silently return them to free treasury.
    await client.query(`UPDATE pharaoh_gas_reserve_entries SET status='REVIEW_REQUIRED',updated_at=now()
      WHERE payout_id=$1 AND status='PENDING'`,[row.id]);
    return 'REVIEW_REQUIRED';
  }
  if (row.status !== 'SENT') return entry.status;
  if (entry.status === 'REVIEW_REQUIRED') throw A.error('GAS_RESERVE_MANUAL_REVIEW_REQUIRED');
  const movement = (await client.query('SELECT * FROM pharaoh_treasury_movements WHERE movement_key=$1',[`PAYOUT:${row.id}`])).rows[0];
  const next = classifyPayout(row,movement);
  if (entry.status === 'AVAILABLE') {
    if (String(entry.confirmed_payout_tx_hash).toLowerCase() !== String(row.tx_hash).toLowerCase()) throw A.error('GAS_RESERVE_CONFIRMATION_CONFLICT');
    return 'AVAILABLE';
  }
  if (entry.status !== 'PENDING') throw A.error('GAS_RESERVE_STATUS_INVALID');
  await client.query(`UPDATE pharaoh_gas_reserve_entries
    SET status=$2,confirmed_payout_tx_hash=$3,available_at=now(),updated_at=now()
    WHERE payout_id=$1 AND status='PENDING'`,[row.id,next,A.hash(row.tx_hash)]);
  return next;
}
async function balances(client) {
  const r=await client.query(`SELECT status,COALESCE(SUM(amount_atomic),0)::text AS atomic,COUNT(*)::int AS entries
    FROM pharaoh_gas_reserve_entries GROUP BY status`);
  const totals=Object.fromEntries(['PENDING','AVAILABLE','REVIEW_REQUIRED'].map(k=>[k,{usdc:'0',entries:0}]));
  for(const row of r.rows) totals[row.status]={usdc:A.decimal(row.atomic),entries:Number(row.entries)};
  return totals;
}
module.exports={recordPending,syncPayout,balances,classifyPayout,gasDetails};
