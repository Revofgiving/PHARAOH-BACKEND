'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const migrations=require('../ops/db-migrate');
(async()=>{
 const plan=migrations.loadPlan();let checks=0;
 for(const item of plan){assert.equal(typeof item.executionSql,'string','Migration runner must provide transaction-safe execution SQL: '+item.id);checks++;}
 const policy=require('../ops/migration-transaction-policy');
 for(const item of plan){const result=policy.prepareMigrationSql(item);assert.equal(result.executionSql,item.executionSql);assert.equal(result.rawSha256,item.sha256);checks++;}
 const wrapped=plan.filter(i=>i.transactionNormalization!=='NONE');
 assert.deepEqual(wrapped.map(i=>i.id),['0016_gift_pending_rog_beneficiary','0017_gift_dynamic_rog_amount','0018_gift_rog_exact_2']);checks++;
 for(const item of wrapped){assert.match(item.sql,/^BEGIN;/);assert.doesNotMatch(item.executionSql,/^\s*BEGIN;/);assert.doesNotMatch(item.executionSql,/COMMIT;\s*$/);checks++;}
 const prepare=sql=>policy.prepareMigrationSql({id:'9999_fixture',sql,sha256:migrations.sha256(sql)});
 for(const sql of ['COMMIT;','BEGIN; SELECT 1; COMMIT;','START TRANSACTION;','ROLLBACK;','END;','ABORT;','SAVEPOINT a;','RELEASE SAVEPOINT a;','PREPARE TRANSACTION \'x\';','SET TRANSACTION READ WRITE;','SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;','SELECT 1; /* comment */ COMMIT;']){assert.throws(()=>prepare(sql),/TRANSACTION_CONTROL_FORBIDDEN/);checks++;}
 for(const sql of ["DO $$ BEGIN RAISE NOTICE 'COMMIT;'; END $$;", "CREATE FUNCTION f() RETURNS void AS $tag$ BEGIN RETURN; END $tag$ LANGUAGE plpgsql;", "SELECT 'COMMIT;', E'can\\\'t; ROLLBACK;', \"END;\"; -- COMMIT\n", '/* outer /* inner COMMIT; */ BEGIN; */ SELECT 1;', "SELECT 'it''s not a COMMIT;';"]){assert.equal(prepare(sql).executionSql,sql);checks++;}
 for(const sql of ["SELECT 'unclosed",'/* unclosed','DO $a$ unclosed','SELECT "unclosed']){assert.throws(()=>prepare(sql),/UNTERMINATED/);checks++;}
 assert.throws(()=>policy.prepareMigrationSql({...wrapped[0],sql:wrapped[0].sql+' '}),/CHECKSUM/);checks++;
 const drift={...wrapped[0],sql:wrapped[0].sql+' '};drift.sha256=migrations.sha256(drift.sql);assert.throws(()=>policy.prepareMigrationSql(drift),/WRAPPER_REVIEW_REQUIRED/);checks++;
 // SQL recording double checks runner transaction boundaries and rollback bookkeeping.
 // No PostgreSQL connection: this is not a native atomicity certification.
 const source=fs.readFileSync(path.join(__dirname,'../ops/db-migrate.js'),'utf8');
 const scope={URL,__dirname:path.join(__dirname,'../ops'),module:{exports:{}},console,process:{env:{DATABASE_URL:'postgres://qa@127.0.0.1/pharaoh_test_fake123'}},require(name){if(name==='./v4-release-gate')return{assertReleaseAllowed(){}};if(name==='./migration-transaction-policy')return policy;return require(name);}};
 vm.runInNewContext(source,scope);
 function recordingPool(failId=null){let inTx=false,committed=[],staged=[],begins=0,commits=0,rollbacks=0,release=0;const executed=[];
  return{getClient:async()=>({async query(sql,params=[]){
   if(sql==='BEGIN'){assert.equal(inTx,false);inTx=true;begins++;return{rows:[]};}
   if(sql==='COMMIT'){assert.equal(inTx,true);committed.push(...staged);staged=[];inTx=false;commits++;return{rows:[]};}
   if(sql==='ROLLBACK'){staged=[];inTx=false;rollbacks++;return{rows:[]};}
   if(sql.includes('pg_advisory_'))return{rows:[]};
   if(sql.includes('to_regclass'))return{rows:[{table_name:null}]};
   if(/^\s*INSERT INTO pharaoh_schema_migrations/.test(sql)){assert.equal(inTx,true);if(params[0]===failId)throw new Error('INJECTED_MIGRATION_FAILURE');staged.push(params[0]);return{rows:[]};}
   assert.equal(inTx,true,'Every DDL statement must remain within the caller transaction');policy.assertNoTransactionControl(sql);executed.push(sql);return{rows:[]};
  },release(){release++;}}),state:()=>({committed,staged,begins,commits,rollbacks,release,executed})};
 }
 const ok=recordingPool();const ids=await scope.module.exports.migrate(ok);assert.equal(ids.length,30);assert.equal(ok.state().committed.length,30);assert.equal(ok.state().begins,1);assert.equal(ok.state().commits,1);assert.equal(ok.state().rollbacks,0);assert.equal(ok.state().release,1);checks++;
 const bad=recordingPool('0026_economic_ledger_s0');await assert.rejects(scope.module.exports.migrate(bad),/INJECTED_MIGRATION_FAILURE/);assert.equal(bad.state().committed.length,0);assert.equal(bad.state().staged.length,0);assert.equal(bad.state().rollbacks,1);assert.equal(bad.state().commits,0);assert.equal(bad.state().release,1);checks++;
 console.log('MIGRATION_ATOMIC_ENVELOPE_PASS: '+checks+' checks; 30 planned migrations, 3 reviewed wrappers normalized at execution only; SQL recording double, NOT native PostgreSQL');
})().catch(e=>{console.error(e);process.exitCode=1;});
