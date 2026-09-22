'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { ethers } = require('ethers');
const pg = require('./pg-connection-manager');

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const REGISTRY_SIGNER_LOCK = 'PHARAOH:REGISTRY:SIGNER';
const REGISTRY_POST_CONFIRM_DELAY_MS = 1100;
const EXPECTED_CONTRACT_ID = '0x26ae20af02532d4554967dbcfd3f908a8109b10c192532c20ef9689d9bf2fde2';
const EXPECTED_CONTRACT_VERSION = '3.0.0';
const DIRECTION_IN = 1;
const DIRECTION_OUT = 2;

const REGISTRY_ABI = [
  'function CONTRACT_ID() view returns (bytes32)',
  'function CONTRACT_VERSION() view returns (string)',
  'function BACKEND_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
  'function usedBackendRefs(bytes32) view returns (bool)',
  'function parentDAO() view returns (address)',
  'function pharaohTreasury() view returns (address)',
  'function registerIncoming(address counterparty,uint256 amount,string txType,bytes32 externalTxHash,bytes32 backendRef) returns (uint256)',
  'function registerOutgoing(address counterparty,uint256 amount,string txType,bytes32 externalTxHash,bytes32 backendRef) returns (uint256)',
  'event TreasuryTransactionRegistered(uint256 indexed txId,address indexed counterparty,uint8 direction,uint256 amount,string txType,bytes32 externalTxHash,bytes32 indexed backendRef)'
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
  const [parentDAO, treasury, role] = await Promise.all([
    contract.parentDAO(), contract.pharaohTreasury(), contract.BACKEND_ROLE()
  ]);
  if (String(parentDAO).toLowerCase() !== cfg.rogParent) {
    throw makeError('PharaohRegistry non e collegato al contratto ROG configurato', 'PHARAOH_REGISTRY_PARENT_ROG_MISMATCH');
  }
  if (String(treasury).toLowerCase() !== cfg.treasuryWallet) {
    throw makeError('PharaohRegistry non controlla la Cassa PHARAOH configurata', 'PHARAOH_REGISTRY_TREASURY_MISMATCH');
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

function parseEventFromReceipt(receipt, contractAddress, expected) {
  const iface = new ethers.Interface(REGISTRY_ABI);
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== String(contractAddress).toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== 'TreasuryTransactionRegistered') continue;
      if (typeof expected === 'function' && !expected(parsed.args)) continue;
      return parsed.args;
    } catch (_) {}
  }
  return null;
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
    return { receipt, args: parsed.args, recovered: true };
  }
  throw makeError('Evento PharaohRegistry gia consumato ma non recuperabile', 'PHARAOH_REGISTRY_RECOVERY_FAILED', true);
}

async function receiptFromStoredHash({ txHash, expected, dependencies = {} }) {
  const { cfg, p } = await runtime(dependencies);
  const canonical = normalizedHash(txHash, 'registryTxHash');
  const receipt = await p.getTransactionReceipt(canonical);
  if (!receipt) throw makeError('Registrazione PharaohRegistry ancora in conferma', 'PHARAOH_REGISTRY_PENDING', true);
  if (Number(receipt.status) !== 1) throw makeError('Registrazione PharaohRegistry revertita', 'PHARAOH_REGISTRY_REVERTED');
  const args = parseEventFromReceipt(receipt, cfg.contractAddress, expected);
  if (!args) throw makeError('Receipt PharaohRegistry non coerente', 'PHARAOH_REGISTRY_EVENT_MISMATCH');
  return { receipt, args, recovered: true };
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

async function registerDirectIncoming({ session, onSubmitted }, dependencies = {}) {
  return finalizeTreasuryCall({
    direction: DIRECTION_IN,
    counterparty: normalizedAddress(session.wallet, 'wallet'),
    amount: usdcBaseUnits(session.pharaoh_amount_usdc, 'pharaohAmountUsdc'),
    txType: 'DIRECT_IN',
    externalTxHash: normalizedHash(session.pharaoh_tx_hash, 'pharaohTxHash'),
    ref: backendRef(session.session_ref, 'DIRECT_IN'),
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

module.exports = {
  REGISTRY_ABI,
  EXPECTED_CONTRACT_ID,
  EXPECTED_CONTRACT_VERSION,
  DIRECTION_IN,
  DIRECTION_OUT,
  getConfig,
  backendRef,
  registerDirectIncoming,
  registerGiftIncoming,
  registerPayoutOutgoing,
  registerCrossOutgoing,
  registerCrossIncoming,
  _runtime: runtime,
  _parseEventFromReceipt: parseEventFromReceipt,
  _recoverByIndexedBackendRef: recoverByIndexedBackendRef,
  _withRegistrySignerLock: withRegistrySignerLock,
  _postConfirmCooldownGuard: postConfirmCooldownGuard,
  _submitTreasuryCall: submitTreasuryCall
};
