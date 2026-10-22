'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { ethers } = require('ethers');
const pg = require('./pg-connection-manager');

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const REGISTRY_SIGNER_LOCK = 'PHARAOH:REGISTRY:SIGNER';
const REGISTRY_POST_CONFIRM_DELAY_MS = 1100;
const EXPECTED_CONTRACT_ID = '0xa48a6b04ac72048d3478e03390eb959026f091c7a25214a558f417535c1d262d';
const EXPECTED_CONTRACT_VERSION = '4.0.0';
const DIRECTION_IN = 1;
const DIRECTION_OUT = 2;
const TREASURY_EXTERNAL = 0;
const TREASURY_PHARAOH = 1;
const TREASURY_PROJECTS = 2;

const REGISTRY_ABI = [
  'function CONTRACT_ID() view returns (bytes32)',
  'function CONTRACT_VERSION() view returns (string)',
  'function BACKEND_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
  'function usedBackendRefs(bytes32) view returns (bool)',
  'function usedRogRefs(bytes32) view returns (bool)',
  'function parentDAO() view returns (address)',
  'function pharaohTreasury() view returns (address)',
  'function projectsTreasury() view returns (address)',
  'function registerIncoming(address counterparty,uint256 amount,string txType,bytes32 externalTxHash,bytes32 backendRef) returns (uint256)',
  'function registerOutgoing(address counterparty,uint256 amount,string txType,bytes32 externalTxHash,bytes32 backendRef) returns (uint256)',
  'function registerMovement(uint8 sourceTreasury,uint8 destinationTreasury,address sourceWallet,address destinationWallet,uint256 amount,string txType,bytes32 externalTxHash,bytes32 backendRef,bytes32 rogRef) returns (uint256)',
  'event TreasuryTransactionRegistered(uint256 indexed txId,address indexed counterparty,uint8 direction,uint256 amount,string txType,bytes32 externalTxHash,bytes32 indexed backendRef)',
  'event TreasuryMovementRegistered(uint256 indexed movementId,uint8 sourceTreasury,uint8 destinationTreasury,address sourceWallet,address destinationWallet,uint256 amount,string txType,bytes32 externalTxHash,bytes32 indexed backendRef,bytes32 indexed rogRef)'
];

let provider = null;

function makeError(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function normalizedAddress(value, label) {
  const address = String(value || '').trim().toLowerCase();
  if (!WALLET_RE.test(address)) throw makeError(`${label} non valido`, 'PHARAOH_REGISTRY_CONFIG_UNAVAILABLE');
  return address;
}

function normalizedHash(value, label) {
  const hash = String(value || '').trim().toLowerCase();
  if (!HASH_RE.test(hash)) throw makeError(`${label} non valido`, 'PHARAOH_REGISTRY_PROOF_INVALID');
  return hash;
}

function backendRef(value, domain) {
  const raw = String(value || '').trim();
  if (!raw) throw makeError(`${domain} ref mancante`, 'PHARAOH_REGISTRY_PROOF_INVALID');
  if (HASH_RE.test(raw.toLowerCase())) return raw.toLowerCase();
  return ethers.keccak256(ethers.toUtf8Bytes(`${domain}:${raw}`)).toLowerCase();
}

function usdcBaseUnits(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw makeError(`${label} non valido`, 'PHARAOH_REGISTRY_PROOF_INVALID');
  return ethers.parseUnits(String(amount), 6);
}

function registryType(value, fallback) {
  const raw = String(value || fallback || '').trim().toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 64);
  if (!raw) throw makeError('txType Registry mancante', 'PHARAOH_REGISTRY_PROOF_INVALID');
  return raw;
}

function getProvider() {
  if (!provider) {
    const rpc = String(process.env.POLYGON_RPC_URL || '').trim();
    if (!rpc) throw makeError('POLYGON_RPC_URL non configurata', 'PHARAOH_REGISTRY_CONFIG_UNAVAILABLE');
    provider = new ethers.JsonRpcProvider(rpc);
  }
  return provider;
}

function getConfig() {
  const contractAddress = normalizedAddress(process.env.PHARAOH_REGISTRY_ADDRESS, 'PHARAOH_REGISTRY_ADDRESS');
  const privateKey = String(process.env.PHARAOH_REGISTRY_PRIVATE_KEY || '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw makeError('PHARAOH_REGISTRY_PRIVATE_KEY non configurata', 'PHARAOH_REGISTRY_CONFIG_UNAVAILABLE');
  }
  return {
    contractAddress,
    privateKey,
    chainId: Number(process.env.POLYGON_CHAIN_ID || 137),
    minConfirmations: Math.max(1, Number(process.env.POLYGON_MIN_CONFIRMATIONS || 1)),
    treasuryWallet: normalizedAddress(process.env.PHARAOH_TREASURY_WALLET, 'PHARAOH_TREASURY_WALLET'),
    projectsTreasury: normalizedAddress(process.env.PHARAOH_PROJECTS_WALLET, 'PHARAOH_PROJECTS_WALLET'),
    rogParent: normalizedAddress(process.env.ROG_CONTRACT_ADDRESS, 'ROG_CONTRACT_ADDRESS')
  };
}

async function runtime(dependencies = {}) {
  const cfg = dependencies.config || dependencies.cfg || getConfig();
  const p = dependencies.provider || dependencies.p || getProvider();
  const network = await p.getNetwork();
  if (Number(network.chainId) !== cfg.chainId) {
    throw makeError(`Registry su rete errata: attesa chainId ${cfg.chainId}`, 'PHARAOH_REGISTRY_WRONG_NETWORK');
  }
  const code = await p.getCode(cfg.contractAddress);
  if (!code || code === '0x') throw makeError('PHARAOH_REGISTRY_ADDRESS non contiene un contratto', 'PHARAOH_REGISTRY_CONFIG_UNAVAILABLE');
  const signer = dependencies.signer || new ethers.Wallet(cfg.privateKey, p);
  const contract = dependencies.contract || new ethers.Contract(cfg.contractAddress, REGISTRY_ABI, signer);
  const contractId = String(await contract.CONTRACT_ID()).toLowerCase();
  if (contractId !== EXPECTED_CONTRACT_ID) {
    throw makeError('PHARAOH_REGISTRY_ADDRESS non punta a PharaohRegistry Treasury V3', 'PHARAOH_REGISTRY_CONTRACT_ID_MISMATCH');
  }
  const contractVersion = String(await contract.CONTRACT_VERSION());
  if (contractVersion !== EXPECTED_CONTRACT_VERSION) {
    throw makeError(`Versione PharaohRegistry non supportata: ${contractVersion}`, 'PHARAOH_REGISTRY_VERSION_MISMATCH');
  }
  const [parentDAO, treasury, projectsTreasury, role] = await Promise.all([
    contract.parentDAO(), contract.pharaohTreasury(), contract.projectsTreasury(), contract.BACKEND_ROLE()
  ]);
  if (String(parentDAO).toLowerCase() !== cfg.rogParent) {
    throw makeError('PharaohRegistry non e collegato al contratto ROG configurato', 'PHARAOH_REGISTRY_PARENT_ROG_MISMATCH');
  }
  if (String(treasury).toLowerCase() !== cfg.treasuryWallet) {
    throw makeError('PharaohRegistry non controlla la Cassa PHARAOH configurata', 'PHARAOH_REGISTRY_TREASURY_MISMATCH');
  }
  if (String(projectsTreasury).toLowerCase() !== cfg.projectsTreasury) {
    throw makeError('PharaohRegistry non controlla la Cassa PROGETTI configurata', 'PHARAOH_REGISTRY_PROJECTS_TREASURY_MISMATCH');
  }
  if (cfg.projectsTreasury === cfg.treasuryWallet) {
    throw makeError('Cassa PHARAOH e Cassa PROGETTI devono essere distinte', 'PHARAOH_REGISTRY_TREASURY_COLLISION');
  }
  if (!(await contract.hasRole(role, await signer.getAddress()))) {
    throw makeError('Il wallet backend non possiede BACKEND_ROLE sul PharaohRegistry', 'PHARAOH_REGISTRY_BACKEND_ROLE_MISSING');
  }
  return { cfg, p, signer, contract };
}

async function withRegistrySignerLock(operation, dependencies = {}) {
  const database = dependencies.pg || pg;
  const client = await database.getClient();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [REGISTRY_SIGNER_LOCK]);
    return await operation();
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [REGISTRY_SIGNER_LOCK]); } catch (_) {}
    client.release();
  }
}

async function postConfirmCooldownGuard(result, dependencies = {}) {
  if (result?.recovered) return;
  const delayMs = Number(dependencies.cooldownGuardMs || REGISTRY_POST_CONFIRM_DELAY_MS);
  const sleep = dependencies.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  await sleep(delayMs);
}

function parseEventFromReceipt(receipt, contractAddress, expected, indexedLog = null) {
  const iface = new ethers.Interface(REGISTRY_ABI);
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== String(contractAddress).toLowerCase()) continue;
    if (indexedLog && (
      String(log.data || '').toLowerCase() !== String(indexedLog.data || '').toLowerCase() ||
      JSON.stringify((log.topics || []).map(t => String(t).toLowerCase())) !==
      JSON.stringify((indexedLog.topics || []).map(t => String(t).toLowerCase()))
    )) continue;
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== 'TreasuryTransactionRegistered') continue;
      if (typeof expected === 'function' && !expected(parsed.args)) continue;
      return parsed.args;
    } catch (_) {}
  }
  return null;
}

function isMatchingIndexedRegistryLog(indexedLog, receipt) {
  const indexedBlockHash = String(indexedLog?.blockHash || '').toLowerCase();
  const receiptBlockHash = String(receipt?.blockHash || '').toLowerCase();
  const indexedTxHash = String(indexedLog?.transactionHash || '').toLowerCase();
  const receiptTxHash = String(receipt?.hash || receipt?.transactionHash || '').toLowerCase();
  return HASH_RE.test(indexedBlockHash) &&
    HASH_RE.test(receiptBlockHash) &&
    indexedBlockHash === receiptBlockHash &&
    HASH_RE.test(indexedTxHash) &&
    indexedTxHash === receiptTxHash;
}

async function recoverByIndexedBackendRef({ ref, fromBlock = 0, expected, dependencies = {} }) {
  const { cfg, p } = await runtime(dependencies);
  const iface = new ethers.Interface(REGISTRY_ABI);
  const event = iface.getEvent('TreasuryTransactionRegistered');
  const logs = await p.getLogs({
    address: cfg.contractAddress,
    fromBlock: Math.max(0, Number(fromBlock || 0)),
    toBlock: 'latest',
    topics: [event.topicHash, null, null, ref]
  });
  for (let i = logs.length - 1; i >= 0; i--) {
    let parsed;
    try { parsed = iface.parseLog(logs[i]); } catch (_) { continue; }
    if (!parsed || parsed.name !== 'TreasuryTransactionRegistered') continue;
    if (typeof expected === 'function' && !expected(parsed.args)) continue;
    const receipt = await p.getTransactionReceipt(logs[i].transactionHash);
    if (!receipt || Number(receipt.status) !== 1) continue;
    await assertRegistryRecoveryConfirmations(receipt, cfg, p);
    if (!isMatchingIndexedRegistryLog(logs[i], receipt)) continue;

    const confirmedArgs = parseEventFromReceipt(
      receipt,
      cfg.contractAddress,
      expected,
      logs[i]
    );

    if (!confirmedArgs) continue;

    return {
      receipt,
      args: confirmedArgs,
      recovered: true
    };
  }
  throw makeError('Evento PharaohRegistry gia consumato ma non recuperabile', 'PHARAOH_REGISTRY_RECOVERY_FAILED', true);
}

async function receiptFromStoredHash({ txHash, expected, dependencies = {} }) {
  const { cfg, p } = await runtime(dependencies);
  const canonical = normalizedHash(txHash, 'registryTxHash');
  const receipt = await p.getTransactionReceipt(canonical);
  if (!receipt) throw makeError('Registrazione PharaohRegistry ancora in conferma', 'PHARAOH_REGISTRY_PENDING', true);
  if (Number(receipt.status) !== 1) throw makeError('Registrazione PharaohRegistry revertita', 'PHARAOH_REGISTRY_REVERTED');

    await assertRegistryRecoveryConfirmations(receipt, cfg, p);
  const args = parseEventFromReceipt(receipt, cfg.contractAddress, expected);
  if (!args) throw makeError('Receipt PharaohRegistry non coerente', 'PHARAOH_REGISTRY_EVENT_MISMATCH');
  return { receipt, args, recovered: true };
}


async function assertRegistryRecoveryConfirmations(receipt, cfg, provider) {
  const required = Number(cfg.minConfirmations);

  if (!Number.isSafeInteger(required) || required < 1) {
    throw makeError(
      'Configurazione conferme Registry non valida',
      'PHARAOH_REGISTRY_CONFIG_UNAVAILABLE'
    );
  }

  const block = Number(receipt?.blockNumber);

  if (!Number.isSafeInteger(block) || block < 0) {
    throw makeError(
      'Blocco della ricevuta Registry non disponibile',
      'PHARAOH_REGISTRY_PENDING',
      true
    );
  }

  const head = Number(await provider.getBlockNumber());

  if (!Number.isSafeInteger(head) || head < block) {
    throw makeError(
      'Conferme Registry non ancora disponibili',
      'PHARAOH_REGISTRY_PENDING',
      true
    );
  }

  const confirmations = head - block + 1;

  if (confirmations < required) {
    throw makeError(
      'Conferme Registry insufficienti',
      'PHARAOH_REGISTRY_PENDING',
      true
    );
  }
}

function expectedTreasuryEvent({ direction, counterparty, amount, txType, externalTxHash, ref }) {
  return (args) => (
    Number(args.direction) === Number(direction) &&
    String(args.counterparty).toLowerCase() === counterparty &&
    BigInt(args.amount.toString()) === amount &&
    String(args.txType) === txType &&
    String(args.externalTxHash).toLowerCase() === externalTxHash &&
    String(args.backendRef).toLowerCase() === ref
  );
}


function parseMovementEventFromReceipt(receipt, contractAddress, expected, indexedLog = null) {
  const iface = new ethers.Interface(REGISTRY_ABI);
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== String(contractAddress).toLowerCase()) continue;
    if (indexedLog && (
      String(log.data || '').toLowerCase() !== String(indexedLog.data || '').toLowerCase() ||
      JSON.stringify((log.topics || []).map(t => String(t).toLowerCase())) !==
      JSON.stringify((indexedLog.topics || []).map(t => String(t).toLowerCase()))
    )) continue;
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== 'TreasuryMovementRegistered') continue;
      if (typeof expected === 'function' && !expected(parsed.args)) continue;
      return parsed.args;
    } catch (_) {}
  }
  return null;
}

function expectedMovementEvent({
  sourceTreasury,
  destinationTreasury,
  sourceWallet,
  destinationWallet,
  amount,
  txType,
  externalTxHash,
  ref,
  rogRef
}) {
  return (args) => (
    Number(args.sourceTreasury) === Number(sourceTreasury) &&
    Number(args.destinationTreasury) === Number(destinationTreasury) &&
    String(args.sourceWallet).toLowerCase() === sourceWallet &&
    String(args.destinationWallet).toLowerCase() === destinationWallet &&
    BigInt(args.amount.toString()) === amount &&
    String(args.txType) === txType &&
    String(args.externalTxHash).toLowerCase() === externalTxHash &&
    String(args.backendRef).toLowerCase() === ref &&
    String(args.rogRef).toLowerCase() === rogRef
  );
}

async function recoverMovementByIndexedBackendRef({ ref, fromBlock = 0, expected, dependencies = {} }) {
  const { cfg, p } = await runtime(dependencies);
  const iface = new ethers.Interface(REGISTRY_ABI);
  const event = iface.getEvent('TreasuryMovementRegistered');
  const logs = await p.getLogs({
    address: cfg.contractAddress,
    fromBlock: Math.max(0, Number(fromBlock || 0)),
    toBlock: 'latest',
    topics: [event.topicHash, null, ref]
  });

  for (let i = logs.length - 1; i >= 0; i--) {
    let parsed;
    try { parsed = iface.parseLog(logs[i]); } catch (_) { continue; }
    if (!parsed || parsed.name !== 'TreasuryMovementRegistered') continue;
    if (typeof expected === 'function' && !expected(parsed.args)) continue;

    const receipt = await p.getTransactionReceipt(logs[i].transactionHash);
    if (!receipt || Number(receipt.status) !== 1) continue;
    await assertRegistryRecoveryConfirmations(receipt, cfg, p);
    if (!isMatchingIndexedRegistryLog(logs[i], receipt)) continue;


    const confirmedArgs = parseMovementEventFromReceipt(
      receipt,
      cfg.contractAddress,
      expected,
      logs[i]
    );

    if (!confirmedArgs) continue;

    return {
      receipt,
      args: confirmedArgs,
      recovered: true
    };
  }

  throw makeError(
    'Movimento PharaohRegistry gia consumato ma non recuperabile',
    'PHARAOH_REGISTRY_RECOVERY_FAILED',
    true
  );
}

async function receiptFromStoredMovementHash({ txHash, expected, dependencies = {} }) {
  const { cfg, p } = await runtime(dependencies);
  const canonical = normalizedHash(txHash, 'registryTxHash');
  const receipt = await p.getTransactionReceipt(canonical);

  if (!receipt) {
    throw makeError(
      'Registrazione movimento PharaohRegistry ancora in conferma',
      'PHARAOH_REGISTRY_PENDING',
      true
    );
  }

  if (Number(receipt.status) !== 1) {
    throw makeError('Registrazione movimento PharaohRegistry revertita', 'PHARAOH_REGISTRY_REVERTED');
  }
  await assertRegistryRecoveryConfirmations(receipt, cfg, p);

  const args = parseMovementEventFromReceipt(receipt, cfg.contractAddress, expected);
  if (!args) {
    throw makeError(
      'Receipt movimento PharaohRegistry non coerente',
      'PHARAOH_REGISTRY_EVENT_MISMATCH'
    );
  }

  return { receipt, args, recovered: true };
}

async function submitMovementCall({
  sourceTreasury,
  destinationTreasury,
  sourceWallet,
  destinationWallet,
  amount,
  txType,
  externalTxHash,
  ref,
  rogRef = ethers.ZeroHash,
  existingTxHash,
  fromBlock = 0,
  onSubmitted
}, dependencies = {}) {
  const ctx = await runtime(dependencies);
  const shared = {
    ...dependencies,
    config: ctx.cfg,
    provider: ctx.p,
    signer: ctx.signer,
    contract: ctx.contract
  };

  const canonicalRogRef = normalizedHash(rogRef, 'rogRef');

  const expected = expectedMovementEvent({
    sourceTreasury,
    destinationTreasury,
    sourceWallet,
    destinationWallet,
    amount,
    txType,
    externalTxHash,
    ref,
    rogRef: canonicalRogRef
  });

  if (existingTxHash) {
    return receiptFromStoredMovementHash({
      txHash: existingTxHash,
      expected,
      dependencies: shared
    });
  }

  if (await ctx.contract.usedBackendRefs(ref)) {
    return recoverMovementByIndexedBackendRef({
      ref,
      fromBlock,
      expected,
      dependencies: shared
    });
  }

  if (
    canonicalRogRef !== ethers.ZeroHash.toLowerCase() &&
    await ctx.contract.usedRogRefs(canonicalRogRef)
  ) {
    throw makeError(
      'Il ciclo ROG risulta gia utilizzato da un altro movimento PharaohRegistry',
      'PHARAOH_REGISTRY_ROG_REF_ALREADY_USED'
    );
  }

  const tx = await ctx.contract.registerMovement(
    sourceTreasury,
    destinationTreasury,
    sourceWallet,
    destinationWallet,
    amount,
    txType,
    externalTxHash,
    ref,
    canonicalRogRef
  );

  if (typeof onSubmitted === 'function') {
    await onSubmitted(String(tx.hash).toLowerCase());
  }

  const receipt = await tx.wait(ctx.cfg.minConfirmations);

  if (!receipt || Number(receipt.status) !== 1) {
    throw makeError(
      'Registrazione movimento PharaohRegistry non confermata',
      'PHARAOH_REGISTRY_REVERTED'
    );
  }

  const args = parseMovementEventFromReceipt(
    receipt,
    ctx.cfg.contractAddress,
    expected
  );

  if (!args) {
    throw makeError(
      'Evento TreasuryMovementRegistered non coerente',
      'PHARAOH_REGISTRY_EVENT_MISMATCH'
    );
  }

  return { receipt, args, recovered: false };
}

function directRogRef(session) {
  if (String(session?.rog_fulfillment_status || '').toUpperCase() !== 'COMPLETED') {
    throw makeError(
      'Fulfillment ROG non completato per il movimento DIRECT PHARAOH',
      'PHARAOH_REGISTRY_ROG_PROOF_REQUIRED'
    );
  }

  if (!session?.rog_confirmed_at) {
    throw makeError(
      'Conferma ROG mancante per il movimento DIRECT PHARAOH',
      'PHARAOH_REGISTRY_ROG_PROOF_REQUIRED'
    );
  }

  const wallet = normalizedAddress(session.wallet, 'wallet');
  const usdcTxHash = normalizedHash(session.rog_usdc_tx_hash, 'rogUsdcTxHash');
  const registerTxHash = normalizedHash(session.rog_register_tx_hash, 'rogRegisterTxHash');

  const donationId = String(session.rog_donation_id || '').trim();
  if (!/^\d+$/.test(donationId) || BigInt(donationId) <= 0n) {
    throw makeError(
      'rogDonationId non valido per il movimento DIRECT PHARAOH',
      'PHARAOH_REGISTRY_ROG_PROOF_REQUIRED'
    );
  }

  const humanPosition = Number(session.rog_human_position);
  if (!Number.isSafeInteger(humanPosition) || humanPosition <= 0) {
    throw makeError(
      'Posizione HUMAN ROG non valida per il movimento DIRECT PHARAOH',
      'PHARAOH_REGISTRY_ROG_PROOF_REQUIRED'
    );
  }

  const canonical = [
    'DIRECT_ROG_V4',
    wallet,
    usdcTxHash,
    registerTxHash,
    donationId,
    String(humanPosition)
  ].join(':');

  return ethers.keccak256(ethers.toUtf8Bytes(canonical)).toLowerCase();
}

function treasuryKindForWallet(wallet, cfg) {
  const w = normalizedAddress(wallet, 'movementWallet');

  if (w === cfg.treasuryWallet) return TREASURY_PHARAOH;
  if (w === cfg.projectsTreasury) return TREASURY_PROJECTS;

  return TREASURY_EXTERNAL;
}

async function submitTreasuryCall({ direction, counterparty, amount, txType, externalTxHash, ref, existingTxHash, fromBlock = 0, onSubmitted }, dependencies = {}) {
  const ctx = await runtime(dependencies);
  const shared = { ...dependencies, config: ctx.cfg, provider: ctx.p, signer: ctx.signer, contract: ctx.contract };
  const expected = expectedTreasuryEvent({ direction, counterparty, amount, txType, externalTxHash, ref });
  if (existingTxHash) return receiptFromStoredHash({ txHash: existingTxHash, expected, dependencies: shared });
  if (await ctx.contract.usedBackendRefs(ref)) {
    return recoverByIndexedBackendRef({ ref, fromBlock, expected, dependencies: shared });
  }
  const tx = direction === DIRECTION_IN
    ? await ctx.contract.registerIncoming(counterparty, amount, txType, externalTxHash, ref)
    : await ctx.contract.registerOutgoing(counterparty, amount, txType, externalTxHash, ref);
  if (typeof onSubmitted === 'function') await onSubmitted(String(tx.hash).toLowerCase());
  const receipt = await tx.wait(ctx.cfg.minConfirmations);
  if (!receipt || Number(receipt.status) !== 1) throw makeError('Registrazione PharaohRegistry non confermata', 'PHARAOH_REGISTRY_REVERTED');
  const args = parseEventFromReceipt(receipt, ctx.cfg.contractAddress, expected);
  if (!args) throw makeError('Evento TreasuryTransactionRegistered non coerente', 'PHARAOH_REGISTRY_EVENT_MISMATCH');
  return { receipt, args, recovered: false };
}

function proofBlock(value) {
  if (!value) return 0;
  let proof = value;
  if (typeof proof === 'string') {
    try { proof = JSON.parse(proof); } catch (_) { return 0; }
  }
  return Number(proof?.blockNumber || 0);
}

async function finalizeTreasuryCall(params, dependencies = {}) {
  return withRegistrySignerLock(async () => {
    const result = await submitTreasuryCall(params, dependencies);
    await postConfirmCooldownGuard(result, dependencies);
    return {
      txHash: String(result.receipt.hash || result.receipt.transactionHash).toLowerCase(),
      txId: Number(result.args.txId.toString()),
      blockNumber: Number(result.receipt.blockNumber),
      recovered: result.recovered
    };
  }, dependencies);
}


async function finalizeMovementCall(params, dependencies = {}) {
  return withRegistrySignerLock(async () => {
    const result = await submitMovementCall(params, dependencies);
    await postConfirmCooldownGuard(result, dependencies);

    const movementId = Number(result.args.movementId.toString());

    return {
      txHash: String(result.receipt.hash || result.receipt.transactionHash).toLowerCase(),
      txId: movementId,
      movementId,
      blockNumber: Number(result.receipt.blockNumber),
      recovered: result.recovered
    };
  }, dependencies);
}

async function registerDirectIncoming({ session, onSubmitted }, dependencies = {}) {
  const cfg = dependencies.config || dependencies.cfg || getConfig();
  const payer = normalizedAddress(session.wallet, 'wallet');

  return finalizeMovementCall({
    sourceTreasury: TREASURY_EXTERNAL,
    destinationTreasury: TREASURY_PHARAOH,
    sourceWallet: payer,
    destinationWallet: cfg.treasuryWallet,
    amount: usdcBaseUnits(session.pharaoh_amount_usdc, 'pharaohAmountUsdc'),
    txType: 'DIRECT_IN',
    externalTxHash: normalizedHash(session.pharaoh_tx_hash, 'pharaohTxHash'),
    ref: backendRef(session.session_ref, 'DIRECT_IN'),
    rogRef: directRogRef(session),
    existingTxHash: session.registry_tx_hash || null,
    fromBlock: proofBlock(session.pharaoh_proof),
    onSubmitted
  }, dependencies);
}

async function registerGiftIncoming({ gift, onSubmitted }, dependencies = {}) {
  return finalizeTreasuryCall({
    direction: DIRECTION_IN,
    counterparty: normalizedAddress(gift.payment_wallet, 'paymentWallet'),
    amount: usdcBaseUnits(gift.pharaoh_amount_usdc, 'pharaohAmountUsdc'),
    txType: 'GIFT_IN',
    externalTxHash: normalizedHash(gift.pharaoh_tx_hash, 'pharaohTxHash'),
    ref: backendRef(gift.gift_id, 'GIFT_IN'),
    existingTxHash: gift.registry_tx_hash || null,
    fromBlock: proofBlock(gift.pharaoh_proof),
    onSubmitted
  }, dependencies);
}

async function registerPayoutOutgoing({ payout, onSubmitted }, dependencies = {}) {
  return finalizeTreasuryCall({
    direction: DIRECTION_OUT,
    counterparty: normalizedAddress(payout.wallet, 'wallet'),
    amount: usdcBaseUnits(payout.importo, 'payoutAmountUsdc'),
    txType: registryType(`PAYOUT_${payout.tipo_uscita || `L${payout.livello || 'NA'}`}`, 'PAYOUT_OUT'),
    externalTxHash: normalizedHash(payout.tx_hash, 'payoutTxHash'),
    ref: backendRef(payout.event_key || payout.id, 'PAYOUT_OUT'),
    existingTxHash: payout.registry_tx_hash || null,
    fromBlock: Number(payout.tx_block_number || 0),
    onSubmitted
  }, dependencies);
}

async function registerCrossOutgoing({ operation, onSubmitted }, dependencies = {}) {
  return finalizeTreasuryCall({
    direction: DIRECTION_OUT,
    counterparty: normalizedAddress(operation.destination_wallet, 'destinationWallet'),
    amount: usdcBaseUnits(operation.amount_usdc, 'crossAmountUsdc'),
    txType: registryType(`${operation.operation_type || 'CROSS'}_OUT`, 'CROSS_OUT'),
    externalTxHash: normalizedHash(operation.payment_tx_hash, 'crossTxHash'),
    ref: backendRef(operation.event_key, 'CROSS_OUT'),
    existingTxHash: operation.registry_tx_hash || null,
    fromBlock: proofBlock(operation.blockchain_proof),
    onSubmitted
  }, dependencies);
}

async function registerCrossIncoming({ event, onSubmitted }, dependencies = {}) {
  return finalizeTreasuryCall({
    direction: DIRECTION_IN,
    counterparty: normalizedAddress(event.payment_wallet, 'paymentWallet'),
    amount: usdcBaseUnits(event.amount_usdc, 'crossEntryAmountUsdc'),
    txType: registryType(`${event.source_platform || 'CROSS'}_TO_PHARAOH_IN`, 'CROSS_IN'),
    externalTxHash: normalizedHash(event.payment_tx_hash, 'crossEntryTxHash'),
    ref: backendRef(event.event_key, 'CROSS_IN'),
    existingTxHash: event.registry_tx_hash || null,
    fromBlock: proofBlock(event.blockchain_proof),
    onSubmitted
  }, dependencies);
}

/** V4: registra solo movimenti subwallet gia realmente trasferiti e verificati. */
async function registerSubwalletMovement({ plan, verification, requiredConfirmations, eventKey, existingRegistryTxHash, onSubmitted }, dependencies = {}) {
  const policy = require('./treasury-subwallet-policy');
  if (typeof eventKey !== 'string' || !eventKey.trim() || typeof onSubmitted !== 'function') throw new Error('SUBWALLET_DURABLE_CONTEXT_REQUIRED');

  const cfg = dependencies.config || dependencies.cfg || getConfig();

  const subConfig = dependencies.subwalletConfig || {
    wallets: {
      PHARAOH: cfg.treasuryWallet,
      GEMELLI: process.env.PHARAOH_GEMELLI_WALLET,
      PROGETTI: cfg.projectsTreasury
    },
    tokenContract: process.env.USDC_CONTRACT_ADDRESS,
    chainId: cfg.chainId
  };

  const canonical = policy.prepareSubwalletMovement({
    purpose: plan?.purpose,
    amountAtomic: plan?.amountAtomic,
    externalTxHash: plan?.externalTxHash,
    destinationWallet: plan?.to,
    ...subConfig
  });

  for (const key of ['from', 'to', 'counterparty', 'pharaohWallet', 'tokenContract', 'chainId', 'direction']) {
    if (canonical[key] !== plan[key]) throw new Error('SUBWALLET_PLAN_CONFIGURATION_MISMATCH');
  }

  if (
    String(cfg.treasuryWallet).toLowerCase() !== canonical.pharaohWallet ||
    String(cfg.projectsTreasury).toLowerCase() !== String(subConfig.wallets.PROGETTI || '').toLowerCase() ||
    String(cfg.chainId) !== canonical.chainId
  ) {
    throw new Error('SUBWALLET_REGISTRY_CONFIGURATION_MISMATCH');
  }

  policy.requireMatchingProof(canonical, verification, requiredConfirmations);
  policy.requireMatchingProof(canonical, verification, cfg.minConfirmations);

  const sourceWallet = normalizedAddress(canonical.from, 'sourceWallet');
  const destinationWallet = normalizedAddress(canonical.to, 'destinationWallet');

  return finalizeMovementCall({
    sourceTreasury: treasuryKindForWallet(sourceWallet, cfg),
    destinationTreasury: treasuryKindForWallet(destinationWallet, cfg),
    sourceWallet,
    destinationWallet,
    amount: canonical.amountAtomic,
    txType: canonical.purpose,
    externalTxHash: canonical.externalTxHash,
    ref: backendRef(canonical.proofReference, 'SUBWALLET_TRANSFER_V4'),
    rogRef: ethers.ZeroHash.toLowerCase(),
    existingTxHash: existingRegistryTxHash || null,
    fromBlock: Number(verification.proof.blockNumber),
    onSubmitted
  }, dependencies);
}

module.exports = {
  REGISTRY_ABI,
  EXPECTED_CONTRACT_ID,
  EXPECTED_CONTRACT_VERSION,
  DIRECTION_IN,
  DIRECTION_OUT,
  TREASURY_EXTERNAL,
  TREASURY_PHARAOH,
  TREASURY_PROJECTS,
  getConfig,
  backendRef,
  registerDirectIncoming,
  registerSubwalletMovement,
  registerGiftIncoming,
  registerPayoutOutgoing,
  registerCrossOutgoing,
  registerCrossIncoming,
  _runtime: runtime,
  _parseEventFromReceipt: parseEventFromReceipt,
  _parseMovementEventFromReceipt: parseMovementEventFromReceipt,
  _recoverByIndexedBackendRef: recoverByIndexedBackendRef,
  _recoverMovementByIndexedBackendRef: recoverMovementByIndexedBackendRef,
  _withRegistrySignerLock: withRegistrySignerLock,
  _postConfirmCooldownGuard: postConfirmCooldownGuard,
  _submitTreasuryCall: submitTreasuryCall,
  _submitMovementCall: submitMovementCall,
  _finalizeMovementCall: finalizeMovementCall,
  _directRogRef: directRogRef,
  _treasuryKindForWallet: treasuryKindForWallet
};
