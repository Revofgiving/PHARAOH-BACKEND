'use strict';
// Isolated dynamic regression of the added indexed log/receipt provenance guard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../pharaoh-registry-manager.js'), 'utf8');
const signature = 'function isMatchingIndexedRegistryLog(indexedLog, receipt) {';
const start = source.indexOf(signature);
assert.ok(start >= 0, 'Indexed recovery provenance guard missing');
let depth = 0, end = -1;
for (let i = source.indexOf('{', start); i < source.length; i++) {
  if (source[i] === '{') depth++;
  if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
}
assert.ok(end > start, 'Guard source incomplete');
const context = vm.createContext({ HASH_RE: /^0x[a-f0-9]{64}$/ });
vm.runInContext(source.slice(start, end), context);
const check = context.isMatchingIndexedRegistryLog;
const BH = '0x' + 'aa'.repeat(32), TX = '0x' + 'bb'.repeat(32);
const idx = {blockHash: BH, transactionHash: TX};
const receipt = {blockHash: BH, transactionHash: TX};
assert.equal(check(idx, receipt), true, 'Valid provenance should pass');
assert.equal(check({...idx, blockHash: undefined}, {...receipt, blockHash: undefined}), false, 'Both missing block hashes must fail');
assert.equal(check({...idx, blockHash: 'bad'}, receipt), false);
assert.equal(check(idx, {...receipt, blockHash: '0x' + 'cc'.repeat(32)}), false);
assert.equal(check({...idx, transactionHash: '0x' + 'cc'.repeat(32)}, receipt), false);
assert.equal(check({...idx, transactionHash: undefined}, receipt), false);
assert.equal(check(idx, {...receipt, transactionHash: undefined}), false);
for (const [name, parser] of [
  ['recoverByIndexedBackendRef', 'parseEventFromReceipt'],
  ['recoverMovementByIndexedBackendRef', 'parseMovementEventFromReceipt']
]) {
  const startFn = source.indexOf('async function ' + name + '(');
  assert.ok(startFn !== -1);
  const segment = source.slice(startFn, source.indexOf('\nasync function ', startFn + 1));
  assert.match(segment, /assertRegistryRecoveryConfirmations\(receipt, cfg, p\)/);
  assert.match(segment, /isMatchingIndexedRegistryLog\(logs\[i\], receipt\)/);
  assert.ok(segment.includes(parser + '(') && segment.includes('logs[i]\n    );'), name + ' must compare exact event payload');
}
console.log('REGISTRY_RECOVERY_HARDENING_PASS: 7 provenance scenarios and both indexed paths; offline; no RPC or DB');
