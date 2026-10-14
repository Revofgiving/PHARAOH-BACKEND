'use strict';
/** Creates only a durable Projects outgoing reservation/movement.
 * No network call, signature or broadcast occurs in prepareProjectOutgoing().
 */
const A=require('./economic-amounts');
const v4=require('./treasury-v4-policy');
const subwallet=require('./treasury-subwallet-policy');
const {configuredLedger}=require('./economic-ledger');

const PURPOSE_ALIASES=Object.freeze({
  HUMANITARIAN:'PROJECTS_HUMANITARIAN_OUT',
  MAINTENANCE:'PROJECTS_MAINTENANCE_OUT',
  PROJECTS_HUMANITARIAN_OUT:'PROJECTS_HUMANITARIAN_OUT',
  PROJECTS_MAINTENANCE_OUT:'PROJECTS_MAINTENANCE_OUT'
});

function normalizePurpose(value) {
  const p=PURPOSE_ALIASES[String(value||'').trim().toUpperCase()];
  if(!p)throw A.error('PROJECTS_OUTGOING_PURPOSE_FORBIDDEN');
  return p;
}
function fundingPlan(rows,amountAtomic) {
  let remaining=A.atomic(amountAtomic);const inputs=[];
  for(const row of rows) {
    if(remaining===0n)break;
    const balance=A.atomic(row.balance_atomic);
    if(balance<=0n)continue;
    const take=balance<remaining?balance:remaining;
    inputs.push({key:row.bucket_key,amountAtomic:take});
    remaining-=take;
  }
  if(remaining!==0n)throw A.error('PROJECTS_UNRESERVED_FUNDS_INSUFFICIENT');
  return inputs;
}
function pgRepository(pg=require('./pg-connection-manager')) {
  return {
    async transaction(fn) {
      const client=await pg.getClient();
      try {
        await client.query('BEGIN');
        const ledger=configuredLedger(client);
        const result=await fn({client,ledger,store:ledger.store});
        await client.query('COMMIT');
        return result;
      } catch(error) {
        try{await client.query('ROLLBACK');}catch(_){}
        throw error;
      } finally {client.release();}
    }
  };
}
async function prepareProjectOutgoing({requestKey,destinationWallet,amountUsdc,purpose},dependencies={}) {
  const request=A.key(String(requestKey||''),'PROJECTS_REQUEST');
  const destination=A.address(destinationWallet);
  const amount=A.usdc(String(amountUsdc));
  const normalizedPurpose=normalizePurpose(purpose);
  const projects=A.address((dependencies.config||{}).projectsWallet||process.env.PHARAOH_PROJECTS_WALLET);
  const treasury=A.address((dependencies.config||{}).treasuryWallet||process.env.PHARAOH_TREASURY_WALLET);
  const gemelli=A.address((dependencies.config||{}).gemelliWallet||process.env.PHARAOH_GEMELLI_WALLET);
  if(new Set([projects,treasury,gemelli]).size!==3)throw A.error('TREASURY_WALLETS_MUST_BE_SEPARATE');
  if([projects,treasury,gemelli].includes(destination))throw A.error('PROJECTS_DESTINATION_MUST_BE_EXTERNAL');

  const movementKey=`PROJECTS_OUT:${A.digest(request)}`;
  const reserveKey=`${movementKey}:RESERVE`;
  const repo=dependencies.repository||pgRepository(dependencies.pg);

  return repo.transaction(async({client,ledger,store})=>{
    await ledger.ready();
    const existing=await store.movement(movementKey);
    if(existing) {
      if(existing.source_wallet!==projects || existing.destination_wallet!==destination ||
         A.atomic(existing.amount_atomic)!==amount || existing.purpose!==normalizedPurpose ||
         existing.reserve_bucket!==reserveKey)throw A.error('PROJECTS_OUTGOING_REQUEST_CONFLICT');
      return {movementKey,status:existing.status,destinationWallet:destination,amountAtomic:amount.toString(),purpose:normalizedPurpose};
    }

    const rows=(await client.query(
      `SELECT b.bucket_key,b.purpose,b.balance_atomic,
              EXISTS(
                SELECT 1 FROM pharaoh_treasury_movements m
                WHERE m.reserve_bucket=b.bucket_key AND m.status<>'CANCELLED'
              ) AS bound
         FROM pharaoh_economic_buckets b
        WHERE b.wallet=$1 AND b.balance_atomic>0
        ORDER BY b.created_at,b.bucket_key
        FOR UPDATE OF b`,
      [projects]
    )).rows;

    const structural=rows.find(r=>r.bucket_key==='PROJECTS:STRUCTURAL_CAPITAL');
    if(!structural || structural.purpose!=='PROJECTS_STRUCTURAL_CAPITAL' || A.atomic(structural.balance_atomic)!==A.usdc('100'))throw A.error('PROJECTS_SETTLED_STRUCTURAL_CAPITAL_REQUIRED');

    const spendable=rows.filter(r=>!r.bound && r.bucket_key!=='PROJECTS:STRUCTURAL_CAPITAL' && r.purpose!=='PROJECTS_STRUCTURAL_CAPITAL');
    const total=rows.reduce((s,r)=>s+A.atomic(r.balance_atomic),0n);
    const free=spendable.reduce((s,r)=>s+A.atomic(r.balance_atomic),0n);
    const reserved=total-free;

    v4.checkTransfer({source:'PROGETTI',destination,amountAtomic:amount,settledBalanceAtomic:total,reservedAtomic:reserved});
    subwallet.requireProjectsFloorAfterSpend({settledAtomic:total,otherReservedAtomic:reserved-A.usdc('100'),amountAtomic:amount});

    const inputs=fundingPlan(spendable,amount);
    await ledger.reallocate({
      eventKey:`ALLOCATE:${movementKey}`,
      inputs,
      outputs:[{key:reserveKey,wallet:projects,purpose:'PROJECTS_OUT_RESERVE',amountAtomic:amount}],
      context:{requestKey:request,purpose:normalizedPurpose,destinationWallet:destination}
    });
    const prepared=await ledger.prepareMovement({
      key:movementKey,reserveBucket:reserveKey,to:destination,amountAtomic:amount,purpose:normalizedPurpose
    });
    return {...prepared,destinationWallet:destination,amountAtomic:amount.toString(),purpose:normalizedPurpose};
  });
}
module.exports={PURPOSE_ALIASES,normalizePurpose,fundingPlan,prepareProjectOutgoing,pgRepository};
