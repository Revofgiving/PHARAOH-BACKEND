'use strict';
const assert=require('node:assert/strict');
const {classifyGeneratedBatch:plan,UNIT_ATOMIC:U,exactCount}=require('../s0-generated-batch-policy');
let count=0;
function check(name,fn){fn();count++;console.log('PASS '+name);}
const make=(h,p,n,source='PILETTA_REINVESTMENT')=>plan({source,humanExternalCumulative:h,pilettaS0Cumulative:p,amountAtomic:BigInt(n)*U,settledAvailableAtomic:BigInt(n)*U});
check('note section 4: 6000 => 60 FONDO A at P=H',()=>{const r=make(1000,1000,60);assert.equal(r.pilettaToCreate,0n);assert.equal(r.fondoAToCreate,60n);assert.equal(r.unusedAtomic,0n);assert.equal(r.externalHumanDelta,0n);});
check('note section 5: ISIDE 50 with margin 30 => 30/20',()=>{const r=make(100,70,50,'ISIDE');assert.equal(r.pilettaToCreate,30n);assert.equal(r.fondoAToCreate,20n);});
check('later H increase opens only future rights, never converts old FONDO A',()=>{const first=make(1000,1000,60);const next=make(1020,1000,20);assert.equal(first.fondoAToCreate,60n);assert.equal(next.pilettaToCreate,20n);assert.equal(first.reclassifyExistingFondoA,false);});
check('no external H means only FONDO A',()=>assert.equal(make(0,0,50,'ISIDE').fondoAToCreate,50n));
check('counters beyond JS safe integer remain exact',()=>{const h=9007199254740993000n;assert.equal(make(h,h-1n,50,'ISIDE').pilettaToCreate,1n);});
check('counter drift P>H fails closed',()=>assert.throws(()=>make(5,6,50),/CAP_ALREADY/));
check('8 October: THOT uses the same cumulative cap (5 => 2 PILETTE + 3 FONDO A)',()=>{const r=make(50,48,5,'THOT');assert.equal(r.pilettaToCreate,2n);assert.equal(r.fondoAToCreate,3n);assert.equal(r.externalHumanDelta,0n);});
check('unknown generated source is rejected',()=>assert.throws(()=>make(50,0,5,'UNKNOWN'),/SOURCE_NOT_DEFINED/));
check('partial 100 units are not silently discarded',()=>assert.throws(()=>plan({source:'ISIDE',humanExternalCumulative:5,pilettaS0Cumulative:0,amountAtomic:U+1n,settledAvailableAtomic:U+1n}),/WHOLE_S0/));
check('uncovered value does not become positions',()=>assert.throws(()=>plan({source:'ISIDE',humanExternalCumulative:50,pilettaS0Cumulative:0,amountAtomic:50n*U,settledAvailableAtomic:50n*U-1n}),/SETTLED_VALUE/));
check('unsafe counters rejected',()=>{for(const x of [NaN,Infinity,-1,1.5,9007199254740992,'1e3','1.0','01',null,undefined])assert.throws(()=>exactCount(x,'COUNTER'),/INVALID/);});
check('plan is immutable and explicitly not materialization',()=>{const r=make(100,0,50,'ISIDE');assert.ok(Object.isFrozen(r));assert.equal(r.status,'PLAN_ONLY_NO_POSITIONS_CREATED');});
check('1000 deterministic recursive batches preserve H/P bound and every 100 unit',()=>{
 let H=0n,P=0n,F=0n,total=0n;
 for(let i=1;i<=1000;i++){
  H+=BigInt(i%7);const n=BigInt(1+i%60);const r=make(H,P,n);
  assert.equal(r.pilettaToCreate+r.fondoAToCreate,n);assert.equal(r.externalHumanDelta,0n);
  P+=r.pilettaToCreate;F+=r.fondoAToCreate;total+=n;
  assert.ok(P<=H);assert.equal(P+F,total);
 }
});
console.log(`S0_NOTE_POLICY_PASS: ${count} pure scenarios; no database writes or S0 positions created`);
