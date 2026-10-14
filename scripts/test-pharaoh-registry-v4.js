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
const PROJECTS_TREASURY = '0x9000000000000000000000000000000000000009';

const cfg = {
  contractAddress: CONTRACT,
  privateKey: `0x${'11'.repeat(32)}`,
  chainId: 137,
  minConfirmations: 1,
  treasuryWallet: PHARAOH_TREASURY.toLowerCase(),
  projectsTreasury: PROJECTS_TREASURY.toLowerCase(),
  rogParent: ROG_PARENT.toLowerCase()
};

const iface = new ethers.Interface(registry.REGISTRY_ABI);
const h = (label) => ethers.keccak256(ethers.toUtf8Bytes(label)).toLowerCase();

function legacyReceipt(values, txHash) {
  const encoded = iface.encodeEventLog(
    iface.getEvent('TreasuryTransactionRegistered'),
    values
  );

  return {
    status: 1,
    hash: txHash,
    transactionHash: txHash,
    blockNumber: 123456,
    logs: [{
      address: CONTRACT,
      topics: encoded.topics,
      data: encoded.data
    }]
  };
}

function movementReceipt(values, txHash) {
  const encoded = iface.encodeEventLog(
    iface.getEvent('TreasuryMovementRegistered'),
    values
  );

  return {
    status: 1,
    hash: txHash,
    transactionHash: txHash,
    blockNumber: 123456,
    logs: [{
      address: CONTRACT,
      topics: encoded.topics,
      data: encoded.data
    }]
  };
}

function legacyTxFor(direction, args, label) {
  const hash = h(`registry:${label}`);
  const [counterparty, amount, txType, externalTxHash, ref] = args;

  return {
    hash,
    wait: async () => legacyReceipt(
      [1n, counterparty, direction, amount, txType, externalTxHash, ref],
      hash
    )
  };
}

function movementTxFor(args, label) {
  const hash = h(`registry:${label}`);

  const [
    sourceTreasury,
    destinationTreasury,
    sourceWallet,
    destinationWallet,
    amount,
    txType,
    externalTxHash,
    ref,
    rogRef
  ] = args;

  return {
    hash,
    wait: async () => movementReceipt(
      [
        1n,
        sourceTreasury,
        destinationTreasury,
        sourceWallet,
        destinationWallet,
        amount,
        txType,
        externalTxHash,
        ref,
        rogRef
      ],
      hash
    )
  };
}

function makeContract(overrides = {}) {
  return {
    CONTRACT_ID: async () => registry.EXPECTED_CONTRACT_ID,
    CONTRACT_VERSION: async () => registry.EXPECTED_CONTRACT_VERSION,
    BACKEND_ROLE: async () => h('BACKEND_ROLE'),
    hasRole: async () => true,
    usedBackendRefs: async () => false,
    usedRogRefs: async () => false,
    parentDAO: async () => ROG_PARENT,
    pharaohTreasury: async () => PHARAOH_TREASURY,
    projectsTreasury: async () => PROJECTS_TREASURY,
    registerIncoming: async (...a) => legacyTxFor(1, a, 'in'),
    registerOutgoing: async (...a) => legacyTxFor(2, a, 'out'),
    registerMovement: async (...a) => movementTxFor(a, 'movement'),
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
    signer: {
      getAddress: async () => SIGNER
    },
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

function directSession(overrides = {}) {
  return {
    wallet: USER,
    pharaoh_amount_usdc: 100,
    pharaoh_tx_hash: h('d-pharaoh'),
    session_ref: h('direct-session'),
    pharaoh_proof: JSON.stringify({ blockNumber: 123 }),

    rog_amount_usdc: 2,
    rog_usdc_tx_hash: h('d-rog-usdc'),
    rog_register_tx_hash: h('d-rog-reg'),
    rog_donation_id: '77',
    rog_human_position: 12345,
    rog_fulfillment_status: 'COMPLETED',
    rog_confirmed_at: '2026-10-10T12:00:00.000Z',

    ...overrides
  };
}

async function main() {
  const runtime = await registry._runtime(dependencies());

  assert.equal(await runtime.contract.CONTRACT_VERSION(), '4.0.0');
  assert.equal(registry.TREASURY_EXTERNAL, 0);
  assert.equal(registry.TREASURY_PHARAOH, 1);
  assert.equal(registry.TREASURY_PROJECTS, 2);

  await assert.rejects(
    registry._runtime(dependencies(makeContract({
      CONTRACT_ID: async () => h('WRONG')
    }))),
    (e) => e.code === 'PHARAOH_REGISTRY_CONTRACT_ID_MISMATCH'
  );

  await assert.rejects(
    registry._runtime(dependencies(makeContract({
      CONTRACT_VERSION: async () => '3.0.0'
    }))),
    (e) => e.code === 'PHARAOH_REGISTRY_VERSION_MISMATCH'
  );

  await assert.rejects(
    registry._runtime(dependencies(makeContract({
      parentDAO: async () => USER
    }))),
    (e) => e.code === 'PHARAOH_REGISTRY_PARENT_ROG_MISMATCH'
  );

  await assert.rejects(
    registry._runtime(dependencies(makeContract({
      pharaohTreasury: async () => USER
    }))),
    (e) => e.code === 'PHARAOH_REGISTRY_TREASURY_MISMATCH'
  );

  await assert.rejects(
    registry._runtime(dependencies(makeContract({
      projectsTreasury: async () => USER
    }))),
    (e) => e.code === 'PHARAOH_REGISTRY_PROJECTS_TREASURY_MISMATCH'
  );

  const collisionDeps = dependencies(makeContract({
    projectsTreasury: async () => PHARAOH_TREASURY
  }));

  collisionDeps.config = {
    ...cfg,
    projectsTreasury: PHARAOH_TREASURY.toLowerCase()
  };

  await assert.rejects(
    registry._runtime(collisionDeps),
    (e) => e.code === 'PHARAOH_REGISTRY_TREASURY_COLLISION'
  );

  let submitted = null;
  let movementArgs = null;

  const directContract = makeContract({
    registerMovement: async (...a) => {
      movementArgs = a;
      return movementTxFor(a, 'direct');
    }
  });

  const session = directSession();

  const direct = await registry.registerDirectIncoming({
    session,
    onSubmitted: async (hash) => {
      submitted = hash;
    }
  }, dependencies(directContract));

  assert.equal(direct.txId, 1);
  assert.equal(direct.movementId, 1);
  assert.equal(direct.blockNumber, 123456);
  assert.match(submitted, /^0x[a-f0-9]{64}$/);

  assert.equal(movementArgs.length, 9);
  assert.equal(movementArgs[0], registry.TREASURY_EXTERNAL);
  assert.equal(movementArgs[1], registry.TREASURY_PHARAOH);
  assert.equal(movementArgs[2].toLowerCase(), USER.toLowerCase());
  assert.equal(movementArgs[3].toLowerCase(), PHARAOH_TREASURY.toLowerCase());
  assert.equal(movementArgs[4], 100_000_000n);
  assert.equal(movementArgs[5], 'DIRECT_IN');
  assert.equal(movementArgs[6], h('d-pharaoh'));
  assert.equal(
    movementArgs[7],
    registry.backendRef(session.session_ref, 'DIRECT_IN')
  );

  const expectedRogRef = registry._directRogRef(session);
  assert.equal(movementArgs[8], expectedRogRef);
  assert.match(expectedRogRef, /^0x[a-f0-9]{64}$/);
  assert.notEqual(expectedRogRef, ethers.ZeroHash.toLowerCase());

  const sameRogDifferentSession = registry._directRogRef(directSession({
    session_ref: h('different-pharaoh-session')
  }));

  assert.equal(
    sameRogDifferentSession,
    expectedRogRef,
    'lo stesso ciclo ROG deve produrre lo stesso rogRef anche in una sessione PHARAOH diversa'
  );

  const differentRogPayment = registry._directRogRef(directSession({
    rog_usdc_tx_hash: h('different-rog-usdc')
  }));

  assert.notEqual(
    differentRogPayment,
    expectedRogRef,
    'una prova ROG diversa deve produrre un rogRef diverso'
  );

  await assert.rejects(
    registry.registerDirectIncoming({
      session: directSession({
        rog_fulfillment_status: 'PROCESSING'
      }),
      onSubmitted: async () => {}
    }, dependencies()),
    (e) => e.code === 'PHARAOH_REGISTRY_ROG_PROOF_REQUIRED'
  );

  await assert.rejects(
    registry.registerDirectIncoming({
      session: directSession({
        rog_human_position: null
      }),
      onSubmitted: async () => {}
    }, dependencies()),
    (e) => e.code === 'PHARAOH_REGISTRY_ROG_PROOF_REQUIRED'
  );

  await assert.rejects(
    registry.registerDirectIncoming({
      session,
      onSubmitted: async () => {}
    }, dependencies(makeContract({
      usedRogRefs: async (ref) => ref === expectedRogRef
    }))),
    (e) => e.code === 'PHARAOH_REGISTRY_ROG_REF_ALREADY_USED'
  );

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
  }, dependencies(makeContract({
    registerIncoming: async (...a) => {
      giftArgs = a;
      return legacyTxFor(1, a, 'gift');
    }
  })));

  assert.equal(gift.txId, 1);
  assert.equal(giftArgs[0].toLowerCase(), USER.toLowerCase());
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
  }, dependencies(makeContract({
    registerOutgoing: async (...a) => {
      payoutArgs = a;
      return legacyTxFor(2, a, 'payout');
    }
  })));

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
  }, dependencies(makeContract({
    registerOutgoing: async (...a) => {
      crossOutArgs = a;
      return legacyTxFor(2, a, 'cross-out');
    }
  })));

  assert.equal(cross.txId, 1);
  assert.equal(
    crossOutArgs[0].toLowerCase(),
    ROG_TREASURY.toLowerCase()
  );
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
  }, dependencies(makeContract({
    registerIncoming: async (...a) => {
      crossInArgs = a;
      return legacyTxFor(1, a, 'cross-in');
    }
  })));

  assert.equal(inbound.txId, 1);
  assert.equal(
    crossInArgs[0].toLowerCase(),
    URANUS_TREASURY.toLowerCase()
  );
  assert.equal(crossInArgs[2], 'URANUS_TO_PHARAOH_IN');

  const managerSource = fs.readFileSync(
    path.join(__dirname, '..', 'pharaoh-registry-manager.js'),
    'utf8'
  );

  assert.equal(
    managerSource.includes('URANUS_REGISTRY_ADDRESS'),
    false,
    'PharaohRegistry manager non deve dipendere da UranusRegistry'
  );

  assert.equal(
    managerSource.includes('registeredPlatforms'),
    false,
    'PharaohRegistry V4 non deve avere sibling platform registry'
  );

  assert.match(managerSource, /SUBWALLET_TRANSFER_V4/);
  assert.match(managerSource, /TreasuryMovementRegistered/);
  assert.match(managerSource, /projectsTreasury/);

  console.log('PHARAOH_TREASURY_REGISTRY_V4_BACKEND_INTEGRATION_PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
