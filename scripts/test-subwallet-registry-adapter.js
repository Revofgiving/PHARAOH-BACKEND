'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const p=require('../treasury-subwallet-policy');
const {registerConfirmedSubwalletMovement:register}=require('../subwallet-registry-manager');
const A=n=>'0x'+String(n).repeat(40),H=n=>'0x'+String(n).repeat(64);
const cfg={wallets:{PHARAOH:A(1),GEMELLI:A(2),PROGETTI:A(3)},tokenContract:A(4),chainId:137,requiredConfirmations:3};
const params=purpose=>({purpose,amountAtomic:p.PURPOSES[purpose].amount,externalTxHash:H(5),eventKey:'event:123',onSubmitted:async()=>{}});
function proofFor(plan){return {valida:true,proof:{txHash:plan.externalTxHash,from:plan.from,to:plan.to,tokenContract:plan.tokenContract,chainId:137,amountBaseUnits:plan.amountAtomic.toString(),blockNumber:10,blockHash:H(6),confirmations:3,transferLogIndexes:[0]}};}
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
async function main(){
 for(const purpose of Object.keys(p.PURPOSES))await check('verified adapter '+purpose,async()=>{
  const input=params(purpose),plan=p.prepareSubwalletMovement({...input,...cfg});let vCalls=0,rCalls=0;
  const result=await register(input,{config:cfg,verifier:{async verificaDonazione(args){vCalls++;assert.equal(args.maxPosizioni,1);assert.equal(args.skipDonationReplayCheck,true);assert.equal(args.walletMittente,plan.from);assert.equal(args.destinatarioWallet,plan.to);return proofFor(plan);}},registry:{async registerSubwalletMovement(args){rCalls++;assert.equal(args.plan.direction,p.PURPOSES[purpose].direction);return {txHash:H(7)};}}});
  assert.equal(vCalls,1);assert.equal(rCalls,1);assert.equal(result.txHash,H(7));
 });
 const valid=params('GEMELLI_RESERVE_OUT');const plan=p.prepareSubwalletMovement({...valid,...cfg});
 for(const [field,value] of [['txHash',H(8)],['from',A(8)],['to',A(8)],['tokenContract',A(8)],['chainId',1],['amountBaseUnits','1'],['confirmations',2],['transferLogIndexes',[null]],['blockNumber',0]]){
  await check('reject mismatched proof '+field,async()=>{let calls=0;const v=proofFor(plan);v.proof[field]=value;
   await assert.rejects(register(valid,{config:cfg,verifier:{verificaDonazione:async()=>v},registry:{registerSubwalletMovement:async()=>{calls++;}}}));assert.equal(calls,0);
  });
 }
 await check('unverified transfer never reaches Registry',async()=>{await assert.rejects(register(valid,{config:cfg,verifier:{verificaDonazione:async()=>({valida:false})}}),/NOT_VERIFIED/);});
 await check('stored Registry hash forwarded for reconciliation',async()=>{
  await register({...valid,existingRegistryTxHash:H(7)},{config:cfg,verifier:{verificaDonazione:async()=>proofFor(plan)},registry:{registerSubwalletMovement:async args=>{assert.equal(args.existingRegistryTxHash,H(7));return {recovered:true};}}});
 });
 await check('durable onSubmitted callback is mandatory',async()=>{await assert.rejects(register({...valid,onSubmitted:null},{config:cfg}),/DURABLE/);});
 await check('Projects to external beneficiary is native V4 movement',async()=>{
  const input={purpose:'PROJECTS_HUMANITARIAN_OUT',amountAtomic:250n*p.DECIMALS,externalTxHash:H(9),destinationWallet:A(8),eventKey:'projects:1',onSubmitted:async()=>{}};
  const projectPlan=p.prepareSubwalletMovement({...input,...cfg});
  assert.equal(projectPlan.from,A(3));assert.equal(projectPlan.to,A(8));assert.equal(projectPlan.direction,2);
  let calls=0;
  await register(input,{config:cfg,verifier:{verificaDonazione:async()=>proofFor(projectPlan)},registry:{registerSubwalletMovement:async args=>{calls++;assert.equal(args.plan.to,A(8));return {txHash:H(7)};}}});
  assert.equal(calls,1);
 });
 await check('Projects cannot pay another managed treasury',()=>assert.throws(()=>p.prepareSubwalletMovement({purpose:'PROJECTS_MAINTENANCE_OUT',amountAtomic:1n*p.DECIMALS,externalTxHash:H(9),destinationWallet:A(1),...cfg}),/EXTERNAL/));
 await check('Projects 50000 cap enforced',()=>assert.throws(()=>p.prepareSubwalletMovement({purpose:'PROJECTS_HUMANITARIAN_OUT',amountAtomic:50000n*p.DECIMALS+1n,externalTxHash:H(9),destinationWallet:A(8),...cfg}),/50000/));
 await check('wrong fixed amount rejected before any network call',()=>assert.throws(()=>p.prepareSubwalletMovement({...valid,...cfg,amountAtomic:501n*p.DECIMALS}),/AMOUNT_MISMATCH/));
 await check('separate wallet roles enforced',()=>assert.throws(()=>p.prepareSubwalletMovement({...valid,...cfg,wallets:{...cfg.wallets,GEMELLI:A(1)}}),/SEPARATE/));
 await check('same transfer has same reference even if purpose changes',()=>{
  const a=p.prepareSubwalletMovement({...params('GEMELLI_FUNDING_IN'),...cfg});const b=p.prepareSubwalletMovement({...params('CONTINUITY_IN'),...cfg});assert.equal(a.proofReference,b.proofReference);
 });
 await check('free balance subtracts all distinct commitments exactly',()=>{assert.equal(p.freeSettledBalance({settledAtomic:1000n*p.DECIMALS,reservations:[{id:'gemello',amountAtomic:500n*p.DECIMALS},{id:'payout',amountAtomic:100n*p.DECIMALS}]}),400n*p.DECIMALS);});
 await check('duplicate commitments rejected',()=>assert.throws(()=>p.freeSettledBalance({settledAtomic:100n,reservations:[{id:'same',amountAtomic:1n},{id:'same',amountAtomic:1n}]}),/DUPLICATE/));
 await check('overcommitment rejected',()=>assert.throws(()=>p.freeSettledBalance({settledAtomic:10n,reservations:[{id:'a',amountAtomic:11n}]}),/EXCEED/));
 await check('Gemelli enforces 500 -> 0 -> 500',()=>{
  assert.equal(p.requireGemelliBalance(500n*p.DECIMALS,'RELEASE_CURRENT'),true);assert.equal(p.requireGemelliBalance(0n,'DEPOSIT_NEXT'),true);
  assert.throws(()=>p.requireGemelliBalance(500n*p.DECIMALS,'DEPOSIT_NEXT'),/DOUBLE/);assert.throws(()=>p.requireGemelliBalance(499n*p.DECIMALS,'RELEASE_CURRENT'),/RECONCILIATION/);
 });
 await check('Projects structural 100 cannot be spent',()=>{
  assert.equal(p.requireProjectsFloorAfterSpend({settledAtomic:600n*p.DECIMALS,otherReservedAtomic:0n,amountAtomic:500n*p.DECIMALS}),true);
  assert.throws(()=>p.requireProjectsFloorAfterSpend({settledAtomic:600n*p.DECIMALS,otherReservedAtomic:0n,amountAtomic:500n*p.DECIMALS+1n}),/STRUCTURAL/);
 });
 await check('Registry ABI/version are V4; adapter contains no ERC20 broadcast',()=>{
  const code=fs.readFileSync(path.join(__dirname,'../pharaoh-registry-manager.js'),'utf8');assert.match(code,/EXPECTED_CONTRACT_VERSION = '4.0.0'/);assert.match(code,/registerMovement/);assert.match(code,/projectsTreasury/);
  const adapter=fs.readFileSync(path.join(__dirname,'../subwallet-registry-manager.js'),'utf8');assert.doesNotMatch(adapter,/\.transfer\(|sendTransaction\(|broadcastTransaction\(/);
 });
 console.log(`SUBWALLET_ADAPTER_V4_PASS: ${passed} pure/mock scenarios; no RPC, Registry write or ERC20 transfer`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
