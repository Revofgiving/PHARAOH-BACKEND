'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const tests = [
  'scripts/test-direct-gift-static.js',
  'scripts/test-direct-gift-dynamic.js',
  'scripts/test-direct-rog-external-gate.js',
  'scripts/test-blockchain-cross-dynamic.js',
  'scripts/test-cross-forensic.js',
  'scripts/test-rha-dual-allocation-static.js',
  'scripts/test-rha-dual-allocation-dynamic.js',
  'scripts/test-rog-rha-registration.js',
  'scripts/test-thot-humanitarian-reentry.js',
  'scripts/test-iside-reentry-receiver-gift.js',
  'scripts/test-autonomous-reentry-roots.js',
  'scripts/test-entry-rollover-100.js',
  'scripts/test-secondary-shared-wallet-identity.js',
  'scripts/test-wallet-person-paths-static.js',
  'scripts/test-no-credit-no-dono-al-volo.js',
  'scripts/test-migration-compat.js',
  'scripts/test-pharaoh-registry-v3.js'
];
for (const test of tests) {
  const run = spawnSync(process.execPath, [path.join(ROOT, test)], { cwd: ROOT, env: process.env, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status || 1);
}
console.log(`FINAL_TESTS=PASS (${tests.length} suites)`);
