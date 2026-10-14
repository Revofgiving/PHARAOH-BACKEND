'use strict';
// Only public proof hashes and read-only diagnostics. NO activation switch or
// private-key import endpoint is exposed by this module.
const A=require('./economic-amounts');
function registerEconomicAdmin(app,security) {
 const pg=require('./pg-connection-manager');
 app.get('/api/admin/economy/status',security.requireAdminKey,async(_req,res)=>{
  try {
   const activation=await pg.queryOne('SELECT status,mode,evidence_hash,cutover_block_number,cutover_block_hash,activated_at FROM pharaoh_economic_activation WHERE singleton=true');
   const counters=await pg.queryOne('SELECT human_cumulative,piletta_cumulative,seeded,evidence_hash FROM pharaoh_s0_counters WHERE singleton=true');
   const balances=await pg.queryMany('SELECT wallet,sum(balance_atomic)::text AS reserved_atomic FROM pharaoh_economic_buckets GROUP BY wallet ORDER BY wallet');
   const movements=await pg.queryMany(`SELECT movement_key,purpose,source_wallet,destination_wallet,amount_atomic,status,tx_hash,registry_tx_hash,last_error,updated_at
     FROM pharaoh_treasury_movements WHERE status NOT IN ('REGISTERED','CANCELLED') ORDER BY created_at,movement_key LIMIT 100`);
   res.json({success:true,activation,counters,balances,movements});
  }catch(e){res.status(503).json({success:false,code:e.code||'ECONOMIC_STATUS_UNAVAILABLE'});}
 });
 app.post('/api/admin/economy/settlement',security.requireAdminKey,async(req,res)=>{
  try {
   if(Object.keys(req.body||{}).some(k=>!['movementKey','txHash'].includes(k)))throw A.error('ONLY_MOVEMENT_AND_PUBLIC_HASH_ACCEPTED');
   if((await require('./db-manager').getStatoBlocco())?.bloccato)throw A.error('SYSTEM_BLOCKED');
   const result=await require('./treasury-transfer-manager').configuredDispatcher().attachManualProof(A.key(req.body?.movementKey),A.hash(req.body?.txHash));
   res.json({success:true,result});
  }catch(e){res.status(409).json({success:false,code:e.code||'ECONOMIC_SETTLEMENT_FAILED'});}
 });
 app.post('/api/admin/economy/projects/prepare',security.requireAdminKey,async(req,res)=>{
  try {
   if(Object.keys(req.body||{}).some(k=>!['requestKey','destinationWallet','amountUsdc','purpose'].includes(k)))throw A.error('PROJECTS_PREPARE_FIELDS_INVALID');
   if((await require('./db-manager').getStatoBlocco())?.bloccato)throw A.error('SYSTEM_BLOCKED');
   const result=await require('./projects-treasury-manager').prepareProjectOutgoing({
    requestKey:req.body?.requestKey,
    destinationWallet:req.body?.destinationWallet,
    amountUsdc:req.body?.amountUsdc,
    purpose:req.body?.purpose
   });
   res.json({success:true,result});
  }catch(e){res.status(409).json({success:false,code:e.code||e.message||'PROJECTS_PREPARE_FAILED'});}
 });
 app.post('/api/admin/economy/run',security.requireAdminKey,async(req,res)=>{
  try{const limit=req.body?.limit==null?20:security.validateIntegerInRange(req.body.limit,1,100,'limit');res.json({success:true,result:await require('./economic-worker').configuredWorker().run(limit)});}
  catch(e){res.status(409).json({success:false,code:e.code||'ECONOMIC_WORKER_FAILED'});}
 });
}
module.exports={registerEconomicAdmin};
