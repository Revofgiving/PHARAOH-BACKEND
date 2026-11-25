'use strict';
const assert=require('node:assert/strict');
const {planExitNet}=require('../s0-confirmed-economics');
const A=require('../economic-amounts');
const w='0x'+'1'.repeat(40);
function plan(accountType,positionClass='HUMAN',level='RHA'){
  return planExitNet({accountType,positionClass,level,ownerWallet:w,fundAWallet:w});
}
for(const type of ['PRIMARIO','FONDO']) {
  const result=plan(type);
  assert.equal(result.grossAtomic,A.usdc('6000'));
  assert.equal(result.gasReserveAtomic,A.usdc('5'));
  assert.equal(result.cashPayoutAtomic,A.usdc('5995'));
  assert.equal(result.grossAtomic,result.netAtomic+result.gasReserveAtomic);
}
for(const type of ['GEMELLO','PERPETUO']) {
  const result=plan(type);
  assert.equal(result.gasReserveAtomic,0n);
  assert.equal(result.cashPayoutAtomic,A.usdc('1000'));
}
for(const level of ['THOT','ISIDE']) assert.equal(plan('GEMELLO','HUMAN',level).gasReserveAtomic,0n);
const piletta=plan('PRIMARIO','PILETTA');
assert.equal(piletta.gasReserveAtomic,0n);
assert.equal(piletta.netAtomic,A.usdc('6000'));
assert.equal(piletta.generatedLots[0].count,60n);
// The rule is determined per economic event; it does not apply a wallet-global flag.
const first=plan('PRIMARIO'),second=plan('PRIMARIO');
assert.equal(first.gasReserveAtomic+second.gasReserveAtomic,A.usdc('10'));
console.log('PASS RHA_GAS_RESERVE_POLICY: primary per-event 5 USDC, no secondary/PILETTA/THOT/ISIDE regression');
