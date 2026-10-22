'use strict';
/** Native PostgreSQL concurrency test, ONLY in an explicitly disposable EMPTY
 * database. Owns a random private schema and removes ONLY that schema, checking
 * its ownership marker first. Never uses DATABASE_URL or production wallets.
 * ERC20 proofs are synthetic fixtures. Not a blockchain or full receiver test.
 */
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {validateTarget}=require('./rehearse-postgres-economy'),{loadPlan}=require('../ops/db-migrate');
const A=require('../economic-amounts'),{EconomicLedger}=require('../economic-ledger'),{PgEconomicStore,LOCK}=require('../economic-store');
function safeSchema(value){if(!/^pharaoh_qa_[a-f0-9]{24}$/.test(value))throw A.error('PG_QA_SCHEMA_NAME_INVALID');return '"'+value+'"';}
async function run(env=process.env){
 const connectionString=validateTarget(env);
 const {Pool}=require('pg'),pool=new Pool({connectionString,max:4,connectionTimeoutMillis:5000});
 const schema='pharaoh_qa_'+crypto.randomBytes(12).toString('hex'),quoted=safeSchema(schema),token=crypto.randomBytes(32).toString('hex');
 const T='0x'+'1'.repeat(40),U='0x'+'2'.repeat(40),TOKEN='0x'+'3'.repeat(40),H='0x'+'4'.repeat(64);
 const config={token:TOKEN,chainId:'137',minConfirmations:2};const plan=loadPlan();assert.equal(plan.length,30, 'QA requires the certified 30-migration plan');let admin,created=false,tests=0,cleanupConfirmed=false,stage='CONNECT',serverVersion;
 const connect=async()=>{const c=await pool.connect();try{await c.query(`SET search_path=${quoted},pg_catalog; SET statement_timeout='15s'; SET lock_timeout='5s'; SET TIME ZONE 'UTC'`);return c;}catch(e){c.release();throw e;}};
 const tx=async fn=>{const c=await connect();try{await c.query('BEGIN');const store=new PgEconomicStore(c),ledger=new EconomicLedger(store,config);const out=await fn({c,store,ledger});await c.query('COMMIT');return out;}catch(e){try{await c.query('ROLLBACK');}catch(_){}throw e;}finally{c.release();}};
 try{
  admin=await pool.connect();
  const actual=(await admin.query('SELECT current_database() AS db, current_setting(\'server_version\') AS version')).rows[0];
  assert.equal(actual.db,new URL(connectionString).pathname.slice(1));serverVersion=actual.version;
  const count=(await admin.query("SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f','S')")).rows[0].n;
  if(count!=='0')throw A.error('PG_REHEARSAL_DATABASE_NOT_EMPTY');
  stage='CREATE_PRIVATE_SCHEMA';await admin.query('BEGIN');
  try{await admin.query(`CREATE SCHEMA ${quoted}; SET LOCAL search_path=${quoted},pg_catalog`);for(const step of plan){stage='MIGRATION:'+step.id;await admin.query(step.executionSql);}await admin.query(`CREATE TABLE ${quoted}.qa_ownership(token text PRIMARY KEY);`);await admin.query(`INSERT INTO ${quoted}.qa_ownership VALUES($1)`,[token]);await admin.query(`UPDATE ${quoted}.pharaoh_economic_activation SET status='ACTIVE',mode='FRESH',evidence_hash=$1,activated_at=now()`,['a'.repeat(64)]);await admin.query(`UPDATE ${quoted}.pharaoh_s0_counters SET seeded=true,evidence_hash=$1`,['a'.repeat(64)]);await admin.query('COMMIT');created=true;}catch(e){await admin.query('ROLLBACK');throw e;}
  admin.release();admin=null;
  stage='TRANSACTION_LOCK';let c1=await connect(),c2=await connect();
  try{await c1.query('BEGIN');await c2.query('BEGIN');await new PgEconomicStore(c1).lock();assert.equal((await c2.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',[LOCK])).rows[0].acquired,false);await c1.query('COMMIT');assert.equal((await c2.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',[LOCK])).rows[0].acquired,true);await c2.query('ROLLBACK');tests++;}finally{await c1.query('ROLLBACK').catch(()=>null);await c2.query('ROLLBACK').catch(()=>null);c1.release();c2.release();}
  stage='DUPLICATE_CREDIT_RACE';const proof={txHash:H,from:U,to:T,amountBaseUnits:'100000000',tokenContract:TOKEN,chainId:'137',blockNumber:'100',blockHash:'0x'+'5'.repeat(64),confirmations:5,transferLogIndexes:[0]};
  const credit={eventKey:'QA_CREDIT',bucket:{key:'PAID',wallet:T,purpose:'EXTERNAL_ENTRY'},from:U,txHash:H,amountAtomic:A.usdc('100'),verification:{valida:true,proof}};
  await Promise.all([tx(({ledger})=>ledger.incoming(credit)),tx(({ledger})=>ledger.incoming(credit))]);
  await tx(async({ledger,c})=>{assert.equal(await ledger.balance('PAID'),A.usdc('100'));assert.equal((await c.query("SELECT count(*)::text AS n FROM pharaoh_economic_events WHERE event_key='QA_CREDIT'")).rows[0].n,'1');});tests++;
  stage='DOUBLE_SPEND_RACE';const spend=key=>tx(({ledger})=>ledger.reallocate({eventKey:'SPEND:'+key,inputs:[{key:'PAID',amountAtomic:A.usdc('100')}],outputs:[{key,wallet:T,purpose:'PAYOUT',amountAtomic:A.usdc('100')}]}));
  const outcomes=await Promise.allSettled([spend('PAY_A'),spend('PAY_B')]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);tests++;
  const winner=outcomes[0].status==='fulfilled'?'PAY_A':'PAY_B';
  stage='CUMULATIVE_CAP_RACE';await tx(async({ledger,c})=>{await ledger.ready();await c.query('UPDATE pharaoh_s0_counters SET human_cumulative=13,piletta_cumulative=0');});
  const generated=await Promise.allSettled(Array.from({length:20},()=>tx(async({ledger,store})=>{await ledger.ready();if(!await store.incrementCounters(0n,1n))throw A.error('TEST_CAP_EXHAUSTED');})));
  assert.equal(generated.filter(x=>x.status==='fulfilled').length,13);assert.equal(generated.filter(x=>x.status==='rejected').length,7);
  await tx(async({store})=>{const c=await store.counters();assert.equal(String(c.human_cumulative),'13');assert.equal(String(c.piletta_cumulative),'13');});tests++;
  stage='ROLLBACK_AFTER_EVENT';await assert.rejects(tx(({ledger})=>ledger.event('QA_CRASH','QA',{},async()=>{await ledger.ensureBucket({key:'QA_GHOST',wallet:T,purpose:'QA'});throw A.error('INJECTED_CRASH');})),/INJECTED_CRASH/);
  await tx(async({store})=>{assert.equal(await store.event('QA_CRASH'),null);assert.equal(await store.bucket('QA_GHOST'),null);});tests++;
  stage='PREPARE_IDEMPOTENCY';const prepare=()=>tx(({ledger})=>ledger.prepareMovement({key:'QA_SEND',reserveBucket:winner,to:U,amountAtomic:A.usdc('100'),purpose:'PAYOUT_RHA'}));await Promise.all([prepare(),prepare()]);
  await tx(async({c})=>assert.equal((await c.query("SELECT count(*)::text AS n FROM pharaoh_treasury_movements WHERE movement_key='QA_SEND'")).rows[0].n,'1'));tests++;
  stage='BOUND_RESERVE_REJECTS_SPEND';await assert.rejects(tx(({ledger})=>ledger.reallocate({eventKey:'BOUND_DOUBLE_SPEND',inputs:[{key:winner,amountAtomic:A.usdc('1')}],outputs:[{key:'INVALID',wallet:T,purpose:'QA',amountAtomic:A.usdc('1')}]})),/BUCKET_BOUND_TO_TRANSFER/);tests++;
  stage='PROOF_REPLAY_DIFFERENT_EVENT';await assert.rejects(tx(({ledger})=>ledger.incoming({...credit,eventKey:'DIFFERENT_CREDIT'})),/PROOF_ALREADY_CONSUMED/);tests++;
  stage='DISCONNECTED_TRANSACTION_ROLLBACK';c1=await connect();await c1.query('BEGIN');await new PgEconomicStore(c1).lock();await c1.query("INSERT INTO pharaoh_economic_buckets(bucket_key,wallet,purpose) VALUES('DISCONNECT_GHOST',$1,'QA')",[T]);c1.release(true);
  await tx(async({ledger,store})=>{await ledger.ready();assert.equal(await store.bucket('DISCONNECT_GHOST'),null);});tests++;
  stage='CLEANUP';
 }catch(e){e.qaStage=stage;throw e;}
 finally{
  try {
   if(admin)admin.release();
   if(created){const c=await pool.connect();try{const owner=await c.query(`SELECT token FROM ${quoted}.qa_ownership`);if(owner.rows.length!==1||owner.rows[0].token!==token)throw A.error('PG_QA_CLEANUP_OWNERSHIP_MISMATCH');await c.query(`DROP SCHEMA ${quoted} CASCADE`);cleanupConfirmed=(await c.query('SELECT count(*)::text AS n FROM pg_namespace WHERE nspname=$1',[schema])).rows[0].n==='0';}finally{c.release();}}
  } finally { await pool.end(); }
 }
 assert.equal(cleanupConfirmed,true);
 return {status:'PASS',tests,serverVersion,migrations:plan.length,privateSchemaRemoved:true,scope:'Native PostgreSQL locks/transactions/races/rollback with SYNTHETIC data; NOT production adoption, full table progression or real receiver E2E'};
}
if(require.main===module)run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify({status:'NOT_PASS',code:e.code||'PG_CONCURRENCY_FAILED',stage:e.qaStage||'BEFORE_CONNECT'}));process.exitCode=1;});
module.exports={run,safeSchema};
