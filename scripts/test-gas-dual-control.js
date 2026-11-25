'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const D=require('../gas-cancellation-dual-control');
const keys=[crypto.generateKeyPairSync('ed25519'),crypto.generateKeyPairSync('ed25519')];
const identities={alice:keys[0].publicKey.export({format:'pem',type:'spki'}),bob:keys[1].publicKey.export({format:'pem',type:'spki'})};
const identityJson=JSON.stringify(identities);
const evidence='a'.repeat(64);
const sign=(operatorId,key,nonce)=>{
 const input={conversionId:'12',operatorId,evidenceSha256:evidence,nonce,signedAt:new Date().toISOString()};
 input.signature=crypto.sign(null,Buffer.from(D.statement(input)),key.privateKey).toString('base64');return input;
};
function mock(){
 const state={status:'ANNULLAMENTO_RICHIESTO',rows:[],txs:0};
 const c={release(){},async query(sql,args=[]){
 if(sql==='BEGIN'){state.txs++;return {rows:[]};}
 if(['COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return {rows:[]};
 if(sql.includes('SELECT id,status FROM pharaoh_gas_conversions'))return {rows:[{id:12,status:state.status}]};
 if(sql.includes('FROM pharaoh_gas_cancellation_attestations WHERE'))return {rows:state.rows};
 if(sql.includes('INSERT INTO pharaoh_gas_cancellation_attestations')){
   if(state.rows.some(r=>r.operator_id===args[1]||r.nonce===args[3]))throw Error('duplicate');
   state.rows.push({operator_id:args[1],evidence_sha256:args[2],nonce:args[3],signature:args[5],statement_sha256:args[6]});return {rows:[]};
 }
 throw Error('UNEXPECTED_SQL '+sql);
 }};
 return {pool:{getClient:async()=>c},state};
}
async function main(){
 const a=sign('alice',keys[0],'11111111-1111-4111-8111-111111111111');
 const b=sign('bob',keys[1],'22222222-2222-4222-8222-222222222222');
 assert.equal(D.validate(a,D.trustedOperators(identityJson)).operatorId,'alice');
 assert.throws(()=>D.validate({...a,evidenceSha256:'b'.repeat(64)},D.trustedOperators(identityJson)),/DUAL_CONTROL_SIGNATURE_INVALID/);
 assert.throws(()=>D.validate({...a,operatorId:'bob'},D.trustedOperators(identityJson)),/DUAL_CONTROL_SIGNATURE_INVALID/);
 assert.throws(()=>D.validate({...a,signedAt:'2020-01-01T00:00:00.000Z'},D.trustedOperators(identityJson)),/DUAL_CONTROL_SIGNATURE_EXPIRED/);
 assert.throws(()=>D.trustedOperators(JSON.stringify({alice:'not-key'})),/DUAL_CONTROL_OPERATOR_CONFIG_INVALID/);
 const {pool,state}=mock();
 const one=await D.attest(pool,a,identityJson);assert.equal(one.approvals,1);assert.equal(one.fundsReleased,false);
 const replay=await D.attest(pool,a,identityJson);assert.equal(replay.replayed,true);
 const two=await D.attest(pool,b,identityJson);assert.equal(two.approvals,2);assert.equal(two.dualApproved,true);
 assert.equal(two.fundsReleased,false);
 assert.equal(state.rows.length,2);
 await assert.rejects(D.attest(pool,{...b,evidenceSha256:'b'.repeat(64)},identityJson),/DUAL_CONTROL_SIGNATURE_INVALID/);
 state.status='VERIFICATA';
 const c=sign('alice',keys[0],'33333333-3333-4333-8333-333333333333');
 await assert.rejects(D.attest(pool,c,identityJson),/DUAL_CONTROL_CONVERSION_NOT_CANCELLING/);
 console.log('PASS dual control: ed25519 operator identity, replay, distinct operators, evidence, locked funds');
}
main().catch(e=>{console.error(e);process.exitCode=1});
