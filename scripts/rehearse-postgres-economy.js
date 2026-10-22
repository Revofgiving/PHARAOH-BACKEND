'use strict';
/** Optional REAL PostgreSQL rehearsal. Never uses DATABASE_URL. Requires an
 * explicitly disposable, EMPTY database named pharaoh_test_<8+ chars>.
 * All DDL/data changes occur in ONE transaction and are always rolled back.
 * This is not a live-copy adoption, not a concurrency test, not a chain test.
 */
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {loadPlan}=require('../ops/db-migrate');
const A=require('../economic-amounts'),{EconomicLedger}=require('../economic-ledger'),{PgEconomicStore}=require('../economic-store');
function validateTarget(env=process.env) {
 if(env.PHARAOH_DISPOSABLE_PG_ACK!=='DISPOSABLE_EMPTY_DATABASE')throw A.error('PG_REHEARSAL_EXPLICIT_ACK_REQUIRED');
 if(!env.PHARAOH_TEST_DATABASE_URL)throw A.error('PG_REHEARSAL_TEST_DATABASE_REQUIRED');
 let u;try{u=new URL(env.PHARAOH_TEST_DATABASE_URL);}catch(_){throw A.error('PG_REHEARSAL_URL_INVALID');}
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.hostname||!/^\/pharaoh_test_[a-z0-9_]{8,}$/.test(u.pathname)||u.search||u.hash)throw A.error('PG_REHEARSAL_DISPOSABLE_NAME_REQUIRED');
 if(env.DATABASE_URL){let live;try{live=new URL(env.DATABASE_URL);}catch(_){}if(live&&live.hostname===u.hostname&&(live.port||'5432')===(u.port||'5432')&&live.pathname===u.pathname)throw A.error('PG_REHEARSAL_APPLICATION_DATABASE_FORBIDDEN');}
 return u.toString();
}
async function run(env=process.env) {
 const connectionString=validateTarget(env); // BEFORE loading a driver or connecting.
 const {Pool}=require('pg'),pool=new Pool({connectionString,max:1,connectionTimeoutMillis:5000});
 let c,begun=false,checks=0;
 try {
  c=await pool.connect();
  const userObjects=(await c.query("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f','S')")).rows[0].count;
  if(userObjects!=='0')throw A.error('PG_REHEARSAL_DATABASE_NOT_EMPTY');
  await c.query('BEGIN');begun=true;await c.query("SET LOCAL search_path=public; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'; SET LOCAL TIME ZONE 'UTC'");
  const plan=loadPlan();assert.equal(plan.length,30, 'QA requires the certified 30-migration plan');
  for(const step of plan.slice(0,25))await c.query(step.executionSql);
  checks++;
  const T='0x'+'1'.repeat(40),U='0x'+'2'.repeat(40),TOKEN='0x'+'3'.repeat(40),H='0x'+'4'.repeat(64);
  // Thirteen SYNTHETIC wallets, not the production users and not an H seed.
  const fixtureAccounts=[];
  for(let i=1;i<=13;i++){
   const wallet='0x'+i.toString(16).padStart(40,'0');
   const a=(await c.query("INSERT INTO accounts(wallet,nome,tipo,sigla,numero_posizionale,origin_kind) VALUES($1,$2,'PRIMARIO',$3,$4,'DIRECT') RETURNING id",[wallet,'QA_SYNTHETIC_'+i,String(i+1),i+1])).rows[0];
   const table=(await c.query("INSERT INTO tavole(numero,sezione,livello,capacita,faraone_wallet,turno) VALUES($1,'ENTRATA',0,6,$2,1) RETURNING id",[i,wallet])).rows[0];
   await c.query("INSERT INTO posizioni(tavola_id,casella,wallet,tipo,dono_importo,account_id,account_sigla,numero_posizionale) VALUES($1,1,$2,'DONATORE',100,$3,$4,$5)",[table.id,wallet,a.id,String(i+1),i+1]);
   await c.query("INSERT INTO donazioni(donor_wallet,importo,tx_hash,source_platform,source_event_key,positions_created,tavola_id,livello) VALUES($1,100,$2,'DIRECT',$3,1,$4,0)",[wallet,'0x'+i.toString(16).padStart(64,'0'),'QA_LEGACY_'+i,table.id]);
   fixtureAccounts.push(a.id);
  }
  assert.equal((await c.query('SELECT count(*)::text AS n FROM gift_sessions')).rows[0].n,'0');checks++;
  const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(x=>x.tablename);
  async function fingerprint(){const out={};for(const table of tables){if(!/^[a-z_][a-z0-9_]*$/.test(table))throw A.error('TEST_TABLE_NAME_INVALID');const rows=(await c.query(`SELECT row_to_json(t)::text AS doc FROM "${table}" t ORDER BY row_to_json(t)::text`)).rows.map(r=>r.doc);out[table]=crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');}return out;}
  const before=await fingerprint();
  for(const step of plan.slice(25))await c.query(step.executionSql);
  assert.deepEqual(await fingerprint(),before);checks++;
  assert.equal((await c.query('SELECT status FROM pharaoh_economic_activation')).rows[0].status,'PENDING');checks++;
  await c.query("UPDATE pharaoh_economic_activation SET status='ACTIVE',mode='FRESH',evidence_hash=$1,activated_at=now() WHERE singleton=true",['a'.repeat(64)]);
  await c.query("UPDATE pharaoh_s0_counters SET seeded=true,evidence_hash=$1 WHERE singleton=true",['a'.repeat(64)]);
  const ledger=new EconomicLedger(new PgEconomicStore(c),{token:TOKEN,chainId:'137',minConfirmations:2});
  const proof={txHash:H,from:U,to:T,amountBaseUnits:'1000000000',tokenContract:TOKEN,chainId:'137',blockNumber:'100',blockHash:'0x'+'5'.repeat(64),confirmations:5,transferLogIndexes:[0]};
  const credit={eventKey:'FIXTURE_CREDIT',bucket:{key:'PAID',wallet:T,purpose:'EXTERNAL_ENTRY'},from:U,txHash:H,amountAtomic:A.usdc('1000'),verification:{valida:true,proof}};
  await ledger.incoming(credit);await ledger.incoming(credit);assert.equal(await ledger.balance('PAID'),A.usdc('1000'));checks++;
  await ledger.reallocate({eventKey:'FIXTURE_ALLOCATE',inputs:[{key:'PAID',amountAtomic:A.usdc('1000')}],outputs:[{key:'PAY',wallet:T,purpose:'PAYOUT',amountAtomic:A.usdc('1000')}]});
  await ledger.prepareMovement({key:'TEST_SEND',reserveBucket:'PAY',to:U,amountAtomic:A.usdc('1000'),purpose:'PAYOUT_RHA'});checks++;
  await c.query('SAVEPOINT rejection');
  await assert.rejects(ledger.reallocate({eventKey:'INVALID_DOUBLE_USE',inputs:[{key:'PAY',amountAtomic:A.usdc('1')}],outputs:[{key:'BAD',wallet:T,purpose:'PAYOUT',amountAtomic:A.usdc('1')}]}),/BUCKET_BOUND_TO_TRANSFER/);
  await c.query('ROLLBACK TO SAVEPOINT rejection');assert.equal(await ledger.store.event('INVALID_DOUBLE_USE'),null);checks++;
  await c.query('SAVEPOINT injected_crash');
  await assert.rejects(ledger.event('CRASH','FIXTURE',{},async()=>{await ledger.ensureBucket({key:'SHOULD_ROLL_BACK',wallet:T,purpose:'TEST'});throw A.error('INJECTED_CRASH');}),/INJECTED_CRASH/);
  await c.query('ROLLBACK TO SAVEPOINT injected_crash');assert.equal(await ledger.store.event('CRASH'),null);assert.equal(await ledger.store.bucket('SHOULD_ROLL_BACK'),null);checks++;
  assert.equal((await c.query('SELECT count(*)::text AS n FROM accounts WHERE id=ANY($1::bigint[])',[fixtureAccounts])).rows[0].n,'13');checks++;
  await c.query('ROLLBACK');begun=false;
  assert.equal((await c.query("SELECT count(*)::text AS count FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0');checks++;
  return {status:'PASS',checks,syntheticLegacyWallets:13,syntheticLegacyPositions:13,syntheticLegacyDonations:13,pendingGiftsInFixture:0,migrations:plan.length,rollbackConfirmed:true,scope:'REAL PostgreSQL empty-schema/forward-DDL/ledger tests using synthetic settlement proofs; NOT live-copy adoption, PostgreSQL concurrency, HTTP or chain E2E'};
 }finally{if(c){if(begun)try{await c.query('ROLLBACK');}catch(_){}c.release();}await pool.end();}
}
if(require.main===module)run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify({status:'NOT_PASS',code:e.code||'PG_REHEARSAL_FAILED'}));process.exitCode=1;});
module.exports={validateTarget,run};
