'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {loadPlan} = require('../ops/db-migrate');
const {validateTarget} = require('./rehearse-postgres-economy');
const root = path.resolve(__dirname,'..');
const plan = loadPlan();
assert.equal(plan.length,34,'Migration count changed unexpectedly');
assert.deepEqual(plan.slice(-4).map(s=>s.id),[
 '0031_rha_gas_reserve_registry',
 '0032_manual_usdc_pol_conversion_registry',
 '0033_manual_conversion_cancellation_hold',
 '0034_conversion_dual_control_attestations']);
const sql32=fs.readFileSync(path.join(root,'database/0032_manual_usdc_pol_conversion_registry.sql'),'utf8');
const sql34=fs.readFileSync(path.join(root,'database/0034_conversion_dual_control_attestations.sql'),'utf8');
for(const sql of [sql32,sql34]) {
 assert.match(sql,/BEFORE UPDATE OR DELETE/);
 assert.match(sql,/RAISE EXCEPTION/);
}
const env={PHARAOH_DISPOSABLE_PG_ACK:'DISPOSABLE_EMPTY_DATABASE'};
assert.throws(()=>validateTarget({...env,PHARAOH_TEST_DATABASE_URL:'postgres://qa:qa@db.example.com/pharaoh_test_abcdefgh'}),/LOOPBACK_ONLY/);
assert.throws(()=>validateTarget({...env,PHARAOH_TEST_DATABASE_URL:'postgres://qa:qa@localhost/PHARAOH_PRODUCTION'}),/DISPOSABLE_NAME_REQUIRED/);
assert.throws(()=>validateTarget({...env,PHARAOH_TEST_DATABASE_URL:'postgres://qa:qa@localhost/pharaoh_test_abcdefgh',DATABASE_URL:'postgres://qa:qa@localhost/pharaoh_test_abcdefgh'}),/APPLICATION_DATABASE_FORBIDDEN/);
assert.equal(new URL(validateTarget({...env,PHARAOH_TEST_DATABASE_URL:'postgres://qa:qa@127.0.0.1:5432/pharaoh_test_abcdefgh'})).hostname,'127.0.0.1');
const conv=require('../gas-conversion-manager');
assert.equal(typeof conv.prepare,'function');assert.equal(typeof conv.verifyConversion,'function');
assert.equal(typeof conv.requestCancellation,'function');
assert.equal(typeof conv.release,'undefined','Funds release must stay unimplemented');
const state=require('../release-state.json');assert.notEqual(state.deployable,true);
console.log('PASS FASE7 static: 34 checksummed migrations, append-only triggers present, local disposable lab guards, funds release disabled');
console.log('NOT_NATIVE_DB_TEST: PostgreSQL required for execution/constraints/concurrency/rollback certification');
