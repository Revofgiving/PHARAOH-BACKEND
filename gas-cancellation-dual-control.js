'use strict';
/** NON DEPLOY: independently signed attestations. NO FUNDS-RELEASE FUNCTION.
 * ADMIN_API_KEY is only a perimeter control, never an identity proof. */
const crypto = require('node:crypto');
const conv = require('./gas-conversion-manager');
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code){ const e=new Error(code);e.code=code;throw e; }
function trustedOperators(json){
 let raw;
 try {raw=JSON.parse(json||'{}');} catch(_){fail('DUAL_CONTROL_OPERATOR_CONFIG_INVALID');}
 if(!raw || typeof raw!=='object' || Array.isArray(raw)) fail('DUAL_CONTROL_OPERATOR_CONFIG_INVALID');
 const operators=new Map();
 for(const [id,pem] of Object.entries(raw)){
  if(!/^[A-Za-z0-9_.-]{3,100}$/.test(id)||typeof pem!=='string')fail('DUAL_CONTROL_OPERATOR_CONFIG_INVALID');
  let key;
  try {key=crypto.createPublicKey(pem);}catch(_){fail('DUAL_CONTROL_OPERATOR_CONFIG_INVALID');}
  if(key.asymmetricKeyType!=='ed25519')fail('DUAL_CONTROL_OPERATOR_KEY_NOT_ED25519');
  operators.set(id,key);
 }
 return operators;
}
function statement({conversionId,operatorId,evidenceSha256,nonce,signedAt}){
 const id=String(conversionId);
 if(!/^[1-9][0-9]*$/.test(id)||!/^[A-Za-z0-9_.-]{3,100}$/.test(operatorId) ||
    !HEX64.test(evidenceSha256)||!UUID.test(nonce)||typeof signedAt!=='string'||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(signedAt) ||
    !Number.isFinite(Date.parse(signedAt))) fail('DUAL_CONTROL_STATEMENT_INVALID');
 return `PHARAOH_GAS_CANCELLATION_ATTEST_V1\nconversion=${id}\noperator=${operatorId}\nevidence_sha256=${evidenceSha256}\nnonce=${nonce}\nsigned_at=${signedAt}\n`;
}
function validate(input,operators,now=Date.now()){
 const {conversionId,operatorId,evidenceSha256,nonce,signedAt,signature}=input||{};
 const msg=statement({conversionId,operatorId,evidenceSha256,nonce,signedAt});
 if(Math.abs(now-Date.parse(signedAt))>5*60*1000)fail('DUAL_CONTROL_SIGNATURE_EXPIRED');
 const key=operators.get(operatorId);if(!key)fail('DUAL_CONTROL_OPERATOR_NOT_TRUSTED');
 if(typeof signature!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature))fail('DUAL_CONTROL_SIGNATURE_INVALID');
 const bytes=Buffer.from(signature,'base64');
 if(bytes.length!==64||bytes.toString('base64')!==signature||!crypto.verify(null,Buffer.from(msg),key,bytes))
  fail('DUAL_CONTROL_SIGNATURE_INVALID');
 return {conversionId:String(conversionId),operatorId,evidenceSha256,nonce,signedAt,signature,
  statementSha256:crypto.createHash('sha256').update(msg).digest('hex')};
}
async function attest(pool,input,operatorJson){
 const p=validate(input,trustedOperators(operatorJson));
 return conv.transaction(pool,async c=>{
  const row=(await c.query('SELECT id,status FROM pharaoh_gas_conversions WHERE id=$1 FOR UPDATE',[p.conversionId])).rows[0];
  if(!row)fail('DUAL_CONTROL_CONVERSION_NOT_FOUND');
  if(row.status!=='ANNULLAMENTO_RICHIESTO')fail('DUAL_CONTROL_CONVERSION_NOT_CANCELLING');
  const existing=(await c.query('SELECT * FROM pharaoh_gas_cancellation_attestations WHERE conversion_id=$1 ORDER BY id FOR UPDATE',[p.conversionId])).rows;
  if(existing.some(x=>x.evidence_sha256!==p.evidenceSha256))fail('DUAL_CONTROL_EVIDENCE_CONFLICT');
  const prior=existing.find(x=>x.operator_id===p.operatorId);
  if(prior){
   if(prior.statement_sha256!==p.statementSha256||prior.signature!==p.signature)fail('DUAL_CONTROL_OPERATOR_ALREADY_ATTESTED');
   return {conversionId:p.conversionId,approvals:existing.length,dualApproved:existing.length>=2,replayed:true,fundsReleased:false};
  }
  const previousCount=existing.length;
  await c.query(`INSERT INTO pharaoh_gas_cancellation_attestations
   (conversion_id,operator_id,evidence_sha256,nonce,signed_at,signature,statement_sha256)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[p.conversionId,p.operatorId,p.evidenceSha256,p.nonce,p.signedAt,p.signature,p.statementSha256]);
  return {conversionId:p.conversionId,approvals:previousCount+1,dualApproved:previousCount+1>=2,replayed:false,fundsReleased:false};
 });
}
module.exports={trustedOperators,statement,validate,attest};
