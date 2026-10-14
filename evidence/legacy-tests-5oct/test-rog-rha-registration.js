'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'cross-outbound-manager.js'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'database', '0014_rog_rha_registration_evidence.sql'), 'utf8');

// Static guards: nonce prima del broadcast, hash subito dopo, no getDonation.
const nonceIdx = source.indexOf('SET rog_register_nonce=$2');
const broadcastIdx = source.indexOf('contract.registerDonation(');
const hashIdx = source.indexOf('SET rog_register_tx_hash=$2');
assert.ok(nonceIdx >= 0 && broadcastIdx > nonceIdx && hashIdx > broadcastIdx, 'Persistenza nonce/hash registerDonation non ordinata');
assert.ok(source.includes("status='RECONCILIATION_REQUIRED'"), 'Fail-closed reconciliation mancante');
assert.ok(source.includes("const nextStatus = error?.retryable === true ? 'NOTIFY_PENDING' : 'RECONCILIATION_REQUIRED'"), 'Errori notify non retryable devono fermarsi in riconciliazione');
assert.ok(source.includes("payload?.retryable === true || status === 408 || status === 425 || status === 429 || status >= 500"), 'Classificazione retry notifica cross mancante');
assert.ok(source.includes('verifyConfirmedRogRegistration'), 'Verifica receipt DonationRegistered mancante');
assert.ok(source.includes('register_tx_hash: String(row.rog_register_tx_hash'), 'Payload ROG senza register_tx_hash');
assert.ok(source.includes("donation_id: String(row.rog_donation_id"), 'Payload ROG senza donation_id');
assert.ok(!source.includes('.getDonation('), 'Cross RHA non deve usare getDonation ROG');
assert.ok(migration.includes('rog_register_nonce BIGINT'));
assert.ok(migration.includes('rog_register_tx_hash TEXT'));
assert.ok(migration.includes('rog_donation_id TEXT'));

const originalLoad = Module._load;
const PHARAOH = '0x1111111111111111111111111111111111111111';
const ROG = '0x2222222222222222222222222222222222222222';
const ROG_CONTRACT = '0x3333333333333333333333333333333333333333';
const BENEFICIARY = '0x4444444444444444444444444444444444444444';
const TX = `0x${'a'.repeat(64)}`;
const REG = `0x${'b'.repeat(64)}`;
const BLOCK = `0x${'c'.repeat(64)}`;
process.env.ROG_CROSS_PLATFORM_SECRET = 'r'.repeat(40);

class FakeInterface {
  parseLog(log) { return log.parsed || null; }
}
const fakeEthers = {
  parseUnits(value, decimals) {
    assert.equal(decimals, 6);
    return BigInt(String(value)) * 1000000n;
  },
  Interface: FakeInterface,
  Contract: class { constructor() { throw new Error('Contract reale non previsto nel test'); } },
  JsonRpcProvider: class {},
  Wallet: class {}
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'ethers') return { ethers: fakeEthers };
  if (request === './pg-connection-manager' && parent?.filename?.endsWith('cross-outbound-manager.js')) {
    return { async queryMany() { return []; }, async queryOne() { return null; }, async getClient() { throw new Error('DB non previsto'); } };
  }
  if (request === './pharaoh-registry-manager' && parent?.filename?.endsWith('cross-outbound-manager.js')) {
    return { async registerCrossOutgoing() { throw new Error('Registry non previsto'); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const outbound = require('../cross-outbound-manager');
Module._load = originalLoad;

const cfg = {
  target: 'ROG',
  sourceWallet: PHARAOH,
  destinationWallet: ROG,
  receiverUrl: 'https://rog.example.test/api/cross/donation/entrata',
  chainId: 137,
  minConfirmations: 1,
  usdcAddress: '0x5555555555555555555555555555555555555555',
  rogContractAddress: ROG_CONTRACT
};

function registrationProvider({ donor = PHARAOH, amount = 300000000n, donationId = 9001n, status = 1 } = {}) {
  return {
    async getTransactionReceipt(hash) {
      assert.equal(hash, REG);
      return {
        status,
        from: PHARAOH,
        blockNumber: 100,
        blockHash: BLOCK,
        logs: [{
          address: ROG_CONTRACT,
          parsed: { name: 'DonationRegistered', args: { donor, amount, donationId } }
        }]
      };
    },
    async getBlockNumber() { return 101; }
  };
}

(async () => {
  const row = {
    event_key: 'PHARAOH:RHA:9001:PHARAOH_TO_ROG',
    rha_event_key: 'PHARAOH:RHA:9001',
    target_platform: 'ROG',
    protocol_version: outbound.RHA_PROTOCOL_V2,
    source_wallet: PHARAOH,
    beneficiary_wallet: BENEFICIARY,
    destination_wallet: ROG,
    amount_usdc: 300,
    positions_expected: 150,
    payment_tx_hash: TX,
    rog_register_tx_hash: REG,
    rog_donation_id: '9001'
  };

  const proof = await outbound._verifyConfirmedRogRegistration(row, registrationProvider(), cfg);
  assert.equal(proof.donationId, '9001');
  assert.equal(proof.donor, PHARAOH);
  assert.equal(proof.amountBaseUnits, '300000000');

  let rejected = null;
  try {
    await outbound._verifyConfirmedRogRegistration(row, registrationProvider({ donor: BENEFICIARY }), cfg);
  } catch (error) { rejected = error; }
  assert.ok(rejected && rejected.code === 'CROSS_OUTBOUND_ROG_REGISTER_PROOF_MISMATCH');

  // Se il nonce e' gia persistito ma manca l'hash, nessun nuovo broadcast.
  const reconciliationQueries = [];
  const client = {
    async query(sql) {
      reconciliationQueries.push(String(sql));
      return { rows: [{ ...row, rog_register_tx_hash: null, rog_register_nonce: 77, status: 'RECONCILIATION_REQUIRED' }] };
    }
  };
  let reconcileError = null;
  try {
    await outbound._ensureRogRegistration({ ...row, rog_register_tx_hash: null, rog_register_nonce: 77 }, client, cfg, registrationProvider(), {});
  } catch (error) { reconcileError = error; }
  assert.ok(reconcileError && reconcileError.code === 'CROSS_OUTBOUND_ROG_REGISTER_RECONCILIATION_REQUIRED');
  assert.ok(reconciliationQueries.some(q => q.includes("status='RECONCILIATION_REQUIRED'")));

  let captured = null;
  const remote = await outbound._notifyTarget(row, cfg, async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          status: 'COMPLETED',
          donation_id: '9001',
          beneficiaryWallet: BENEFICIARY,
          positionsOwnerWallet: BENEFICIARY,
          rgxOwnerWallet: PHARAOH,
          rgxMinted: 150
        };
      }
    };
  });
  assert.equal(remote.status, 'COMPLETED');
  assert.equal(captured.wallet_beneficiario, BENEFICIARY);
  assert.equal(captured.register_tx_hash, REG);
  assert.equal(captured.donation_id, '9001');
  assert.equal(captured.protocol_version, outbound.RHA_PROTOCOL_V2);

  console.log('PASS ROG RHA REGISTRATION: receipt-backed, donor=Cassa PHARAOH, beneficiary preserved, anti-double fail-closed, HMAC payload complete');
})().catch((error) => {
  console.error('FAIL ROG RHA REGISTRATION');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
