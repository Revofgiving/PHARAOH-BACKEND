'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classify } = require('../s0-system-position-policy');
const { checkTransfer } = require('../treasury-v4-policy');
const root = path.resolve(__dirname, '..');
const policy = (s,h,p,b) => classify({source:s,humanExternalCumulative:h,pilettaS0Cumulative:p,settledUsdc:b});
assert.deepEqual([policy('THOT',100,100,500).piletta, policy('THOT',100,100,500).fondoA], [0,5]);
assert.deepEqual([policy('ISIDE',100,70,5000).piletta, policy('ISIDE',100,70,5000).fondoA],[30,20]);
assert.deepEqual([policy('ISIDE',60,0,5000).piletta, policy('ISIDE',60,0,5000).fondoA],[50,0]);
assert.throws(()=>policy('ISIDE',49,50,5000),/S0_CAP/);
assert.throws(()=>policy('THOT',50,45,499),/SETTLED/);
assert.throws(()=>policy('THOT',1.2,0,500),/INVALID_HUMAN/);
assert.throws(()=>checkTransfer({source:'PHARAOH',destination:'0x'+'2'.repeat(40),amountAtomic:50000000001n,settledBalanceAtomic:100000000000n}), /LIMIT/);
assert.equal(checkTransfer({source:'PHARAOH', destination:'0x'+'2'.repeat(40),amountAtomic:50000000000n,settledBalanceAtomic:60000000000n, reservedAtomic:10000000000n}).amountAtomic,'50000000000');
assert.throws(()=>checkTransfer({source:'PROGETTI',destination:'0x'+'3'.repeat(40),amountAtomic:1000000n,settledBalanceAtomic:1000000n,reservedAtomic:1n}),/UNRESERVED/);
assert.throws(()=>checkTransfer({source:'FONDO_A',destination:'0x'+'3'.repeat(40),amountAtomic:1000000n,settledBalanceAtomic:1000000n}),/SOURCE_TREASURY/);
const f = fs.readFileSync(path.join(root, 'function-manager.js'),'utf8');
assert.ok(f.includes("configuredLedger(client).ready()"));
assert.ok(f.includes("reentryManager.materializzaRientriEntrata"));
const reentry=fs.readFileSync(path.join(root,'reentry-manager.js'),'utf8');
assert.ok(reentry.includes('GENERATED_S0_TRANSACTION_REQUIRED'));
assert.ok(reentry.includes('flow.materializeQuota'));
assert.ok(!reentry.includes('db.createAccount')); // no bypass of the funded materializer

console.log('S0_POLICY_SAFE_TESTS=PASS (pure policy + funding boundary wiring; isolated 50000 helper is NOT a live contract cap)');
