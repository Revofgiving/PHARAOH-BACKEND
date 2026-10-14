'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const registry = require('../pharaoh-registry-manager');

const CONTRACT = '0x1000000000000000000000000000000000000001';
const SIGNER = '0x2000000000000000000000000000000000000002';
const USER = '0x3000000000000000000000000000000000000003';
const BENEFICIARY = '0x4000000000000000000000000000000000000004';
const PHARAOH_TREASURY = '0x5000000000000000000000000000000000000005';
const ROG_PARENT = '0x6000000000000000000000000000000000000006';
const ROG_TREASURY = '0x7000000000000000000000000000000000000007';
const URANUS_TREASURY = '0x8000000000000000000000000000000000000008';
const cfg = {
  contractAddress: CONTRACT,
  privateKey: `0x${'11'.repeat(32)}`,
  chainId: 137,
  minConfirmations: 1,
  treasuryWallet: PHARAOH_TREASURY.toLowerCase(),
  rogParent: ROG_PARENT.toLowerCase()
};
const iface = new ethers.Interface(registry.REGISTRY_ABI);
const h = (label) => ethers.keccak256(ethers.toUtf8Bytes(label)).toLowerCase();

function receipt(values, txHash) {
  const encoded = iface.encodeEventLog(iface.getEvent('TreasuryTransactionRegistered'), values);
  return {
    status: 1,
    hash: txHash,
    transactionHash: txHash,
    blockNumber: 123456,
    logs: [{ address: CONTRACT, topics: encoded.topics, data: encoded.data }]
  };
}

function txFor(direction, args, label) {
  const hash = h(`registry:${label}`);
  const [counterparty, amount, txType, externalTxHash, ref] = args;
  return { hash, wait: async () => receipt([1n, counterparty, direction, amount, txType, externalTxHash, ref], hash) };
}

function makeContract(overrides = {}) {
  return {
    CONTRACT_ID: async () => registry.EXPECTED_CONTRACT_ID,
    CONTRACT_VERSION: async () => registry.EXPECTED_CONTRACT_VERSION,
    BACKEND_ROLE: async () => h('BACKEND_ROLE'),
    hasRole: async () => true,
    usedBackendRefs: async () => false,
    parentDAO: async () => ROG_PARENT,
    pharaohTreasury: async () => PHARAOH_TREASURY,
    registerIncoming: async (...a) => txFor(1, a, 'in'),
    registerOutgoing: async (...a) => txFor(2, a, 'out'),
    ...overrides
  };
}

function dependencies(contract = makeContract()) {
  return {
    config: cfg,
    provider: {
      getNetwork: async () => ({ chainId: 137n }),
      getCode: async () => '0x60006000',
      getTransactionReceipt: async () => null,
      getLogs: async () => []
    },
    signer: { getAddress: async () => SIGNER },
    contract,
    pg: {
      getClient: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {}
      })
    },
    cooldownGuardMs: 0,
    sleep: async () => {}
  };
}

async function main() {
  const runtime = await registry._runtime(dependencies());
  assert.equal(await runtime.contract.CONTRACT_VERSION(), '3.0.0');

  await assert.rejects(
    registry._runtime(dependencies(makeContract({ CONTRACT_ID: async () => h('WRONG') }))),
    (e) => e.code === 'PHARAOH_REGISTRY_CONTRACT_ID_MISMATCH'
  );
  await assert.rejects(
    registry._runtime(dependencies(makeContract({ CONTRACT_VERSION: async () => '2.0.0' }))),
    (e) => e.code === 'PHARAOH_REGISTRY_VERSION_MISMATCH'
  );
  await assert.rejects(
    registry._runtime(dependencies(makeContract({ parentDAO: async () => USER }))),
    (e) => e.code === 'PHARAOH_REGISTRY_PARENT_ROG_MISMATCH'
  );
  await assert.rejects(
    registry._runtime(dependencies(makeContract({ pharaohTreasury: async () => USER }))),
    (e) => e.code === 'PHARAOH_REGISTRY_TREASURY_MISMATCH'
  );

  let submitted = null;
  let incomingArgs = null;
  const directContract = makeContract({
    registerIncoming: async (...a) => {
      incomingArgs = a;
      return txFor(1, a, 'direct');
    }
  });
  const direct = await registry.registerDirectIncoming({
    session: {
      wallet: USER,
      pharaoh_amount_usdc: 100,
      pharaoh_tx_hash: h('d-pharaoh'),
      session_ref: h('direct-session'),
      pharaoh_proof: JSON.stringify({ blockNumber: 123 }),
      // Queste prove ROG possono esistere nel workflow backend, ma NON vengono
      // passate al PharaohRegistry V3.
      rog_amount_usdc: 2,
      rog_usdc_tx_hash: h('d-rog-usdc'),
      rog_register_tx_hash: h('d-rog-reg'),
      rog_donation_id: '77'
    },
    onSubmitted: async (hash) => { submitted = hash; }
  }, dependencies(directContract));
  assert.equal(direct.txId, 1);
  assert.equal(direct.blockNumber, 123456);
  assert.match(submitted, /^0x[a-f0-9]{64}$/);
  assert.equal(incomingArgs.length, 5);
  assert.equal(incomingArgs[0].toLowerCase(), USER.toLowerCase());
  assert.equal(incomingArgs[1], 100_000_000n);
  assert.equal(incomingArgs[2], 'DIRECT_IN');
  assert.equal(incomingArgs[3], h('d-pharaoh'));

  let giftArgs = null;
  const gift = await registry.registerGiftIncoming({
    gift: {
      payment_wallet: USER,
      beneficiary_wallet: BENEFICIARY,
      pharaoh_amount_usdc: 100,
      pharaoh_tx_hash: h('g-pharaoh'),
      gift_id: 'gift_test_1234567890abcdef',
      pharaoh_proof: { blockNumber: 124 },
      rog_amount_usdc: 2,
      rog_usdc_tx_hash: h('g-rog-usdc'),
      rog_register_tx_hash: h('g-rog-reg'),
      rog_donation_id: '88'
    }
  }, dependencies(makeContract({ registerIncoming: async (...a) => { giftArgs = a; return txFor(1, a, 'gift'); } })));
  assert.equal(gift.txId, 1);
  assert.equal(giftArgs[0].toLowerCase(), USER.toLowerCase(), 'nel Registry conta il pagatore reale della tx verso PHARAOH');
  assert.equal(giftArgs[2], 'GIFT_IN');

  let payoutArgs = null;
  const payout = await registry.registerPayoutOutgoing({
    payout: {
      id: 90,
      event_key: 'PAYOUT-90',
      wallet: USER,
      importo: 4000,
      tipo_uscita: 'THOT_NET_4000',
      tx_hash: h('payout-chain'),
      tx_block_number: 125
    }
  }, dependencies(makeContract({ registerOutgoing: async (...a) => { payoutArgs = a; return txFor(2, a, 'payout'); } })));
  assert.equal(payout.txId, 1);
  assert.equal(payoutArgs[0].toLowerCase(), USER.toLowerCase());
  assert.equal(payoutArgs[2], 'PAYOUT_THOT_NET_4000');

  let crossOutArgs = null;
  const cross = await registry.registerCrossOutgoing({
    operation: {
      event_key: 'RHA-ROG-91',
      wallet_beneficiario: USER,
      destination_wallet: ROG_TREASURY,
      amount_usdc: 300,
      payment_tx_hash: h('cross-chain'),
      target_platform: 'ROG',
      operation_type: 'RHA_DUAL_ROG',
      blockchain_proof: { blockNumber: 126 }
    }
  }, dependencies(makeContract({ registerOutgoing: async (...a) => { crossOutArgs = a; return txFor(2, a, 'cross-out'); } })));
  assert.equal(cross.txId, 1);
  assert.equal(crossOutArgs[0].toLowerCase(), ROG_TREASURY.toLowerCase(), 'Registry deve registrare il vero destinatario della Cassa PHARAOH');
  assert.equal(crossOutArgs[2], 'RHA_DUAL_ROG_OUT');

  let crossInArgs = null;
  const inbound = await registry.registerCrossIncoming({
    event: {
      event_key: 'URANUS-IN-92',
      source_platform: 'URANUS',
      payment_wallet: URANUS_TREASURY,
      beneficiary_wallet: USER,
      amount_usdc: 100,
      payment_tx_hash: h('uranus-in-chain'),
      blockchain_proof: { blockNumber: 127 }
    }
  }, dependencies(makeContract({ registerIncoming: async (...a) => { crossInArgs = a; return txFor(1, a, 'cross-in'); } })));
  assert.equal(inbound.txId, 1);
  assert.equal(crossInArgs[0].toLowerCase(), URANUS_TREASURY.toLowerCase());
  assert.equal(crossInArgs[2], 'URANUS_TO_PHARAOH_IN');

  const managerSource = fs.readFileSync(path.join(__dirname, '..', 'pharaoh-registry-manager.js'), 'utf8');
  assert.equal(managerSource.includes('URANUS_REGISTRY_ADDRESS'), false, 'PharaohRegistry manager non deve dipendere da UranusRegistry');
  assert.equal(managerSource.includes('registeredPlatforms'), false, 'PharaohRegistry V3 non deve avere sibling platform registry');

  console.log('PHARAOH_TREASURY_REGISTRY_V3_BACKEND_INTEGRATION_PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
