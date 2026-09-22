'use strict';

const { ethers } = require('ethers');
const pg = require('./pg-connection-manager');
const auth = require('./cross-platform-auth');
const pharaohRegistry = require('./pharaoh-registry-manager');

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const GLOBAL_PAYOUT_SIGNER_LOCK = 'PHARAOH:PAYOUT:SIGNER';
const RHA_PROTOCOL_V1 = 'RHA_200_ROG_100_URANUS_V1';
const RHA_PROTOCOL_V2 = 'RHA_300_ROG_200_URANUS_V2';
const RHA_PROTOCOLS = Object.freeze({
  [RHA_PROTOCOL_V1]: Object.freeze({
    ROG: Object.freeze({ amount: 200, positions: 100 }),
    URANUS: Object.freeze({ amount: 100, positions: 5 })
  }),
  [RHA_PROTOCOL_V2]: Object.freeze({
    ROG: Object.freeze({ amount: 300, positions: 150 }),
    URANUS: Object.freeze({ amount: 200, positions: 10 })
  })
});
const ERC20_ABI = [
  'function transfer(address to,uint256 amount) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
];
const ROG_CROSS_ABI = [
  'function registerDonation(uint256 amount) external returns (uint256)',
  'event DonationRegistered(uint256 indexed donationId,address indexed donor,uint256 amount,uint256 expireTime)'
];

function makeError(message, code, retryable = false, httpStatus = null) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (httpStatus) error.httpStatus = httpStatus;
  return error;
}

function normalizeWallet(value, label) {
  const result = String(value || '').trim().toLowerCase();
  if (!WALLET_RE.test(result)) throw makeError(`${label} non valido`, 'CROSS_OUTBOUND_WALLET_INVALID');
  return result;
}

function normalizeTxHash(value) {
  const result = String(value || '').trim().toLowerCase();
  if (!HASH_RE.test(result)) throw makeError('payment_tx_hash non valido', 'CROSS_OUTBOUND_TX_INVALID');
  return result;
}

function getConfig(target) {
  const platform = String(target || '').trim().toUpperCase();
  if (!['ROG', 'URANUS'].includes(platform)) {
    throw makeError('Target cross outbound non autorizzato', 'CROSS_OUTBOUND_TARGET_INVALID');
  }
  const sourceWallet = normalizeWallet(process.env.PHARAOH_TREASURY_WALLET, 'PHARAOH_TREASURY_WALLET');
  const destinationWallet = platform === 'ROG'
    ? normalizeWallet(process.env.ROG_TREASURY_WALLET, 'ROG_TREASURY_WALLET')
    : normalizeWallet(process.env.URANUS_TREASURY_WALLET, 'URANUS_TREASURY_WALLET');
  const receiverRaw = platform === 'ROG' ? process.env.ROG_CROSS_INGRESS_URL : process.env.URANUS_CROSS_INGRESS_URL;
  const receiverUrl = String(receiverRaw || '').trim();
  if (!receiverUrl) throw makeError(`${platform}_CROSS_INGRESS_URL non configurata`, 'CROSS_OUTBOUND_RECEIVER_UNAVAILABLE', false, 503);
  let parsed;
  try { parsed = new URL(receiverUrl); } catch (_) {
    throw makeError(`${platform}_CROSS_INGRESS_URL non valida`, 'CROSS_OUTBOUND_RECEIVER_UNAVAILABLE', false, 503);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:')) {
    throw makeError(`${platform}_CROSS_INGRESS_URL deve usare HTTPS in produzione`, 'CROSS_OUTBOUND_RECEIVER_UNAVAILABLE', false, 503);
  }
  return {
    target: platform,
    sourceWallet,
    destinationWallet,
    receiverUrl,
    chainId: Number(process.env.POLYGON_CHAIN_ID || 137),
    minConfirmations: Number(process.env.POLYGON_MIN_CONFIRMATIONS || 1),
    usdcAddress: normalizeWallet(process.env.USDC_CONTRACT_ADDRESS, 'USDC_CONTRACT_ADDRESS'),
    rogContractAddress: platform === 'ROG'
      ? normalizeWallet(process.env.ROG_CONTRACT_ADDRESS, 'ROG_CONTRACT_ADDRESS')
      : null
  };
}

function assertOperationInvariant(row, cfg) {
  const source = normalizeWallet(row.source_wallet, 'source_wallet');
  const beneficiary = normalizeWallet(row.beneficiary_wallet, 'beneficiary_wallet');
  const destination = normalizeWallet(row.destination_wallet, 'destination_wallet');
  if (source !== cfg.sourceWallet) throw makeError('source_wallet cross diverso dalla Cassa PHARAOH', 'CROSS_OUTBOUND_SOURCE_MISMATCH');
  if (destination !== cfg.destinationWallet) throw makeError('destination_wallet cross diverso dalla Cassa target ufficiale', 'CROSS_OUTBOUND_DESTINATION_MISMATCH');
  const version = String(row.protocol_version || RHA_PROTOCOL_V2);
  const protocol = RHA_PROTOCOLS[version];
  if (!protocol) throw makeError('Versione protocollo RHA non riconosciuta', 'CROSS_OUTBOUND_SPEC_MISMATCH');
  const expected = protocol[cfg.target];
  if (Number(row.amount_usdc) !== expected.amount || Number(row.positions_expected) !== expected.positions) {
    throw makeError('Specifica economica cross outbound non coerente col protocollo RHA', 'CROSS_OUTBOUND_SPEC_MISMATCH');
  }
  const expectedKey = `${String(row.rha_event_key || '').trim()}:PHARAOH_TO_${cfg.target}`;
  if (!row.rha_event_key || String(row.event_key) !== expectedKey) {
    throw makeError('event_key cross outbound non coerente con uscita RHA', 'CROSS_OUTBOUND_EVENT_MISMATCH');
  }
  return { source, beneficiary, destination, expected };
}

function publicOperation(row) {
  if (!row) return null;
  return {
    eventKey: row.event_key,
    rhaEventKey: row.rha_event_key,
    targetPlatform: row.target_platform,
    protocolVersion: row.protocol_version || RHA_PROTOCOL_V2,
    sourceWallet: row.source_wallet,
    beneficiaryWallet: row.beneficiary_wallet,
    accountId: row.account_id == null ? null : Number(row.account_id),
    accountSigla: row.account_sigla || null,
    destinationWallet: row.destination_wallet,
    amountUsdc: Number(row.amount_usdc),
    positionsExpected: Number(row.positions_expected),
    senderNonce: row.sender_nonce == null ? null : Number(row.sender_nonce),
    paymentTxHash: row.payment_tx_hash || null,
    rogRegisterNonce: row.rog_register_nonce == null ? null : Number(row.rog_register_nonce),
    rogRegisterTxHash: row.rog_register_tx_hash || null,
    rogDonationId: row.rog_donation_id || null,
    rogRegisterConfirmedAt: row.rog_register_confirmed_at || null,
    rogRegisterLastError: row.rog_register_last_error || null,
    registryTxHash: row.registry_tx_hash || null,
    registryTxId: row.registry_tx_id == null ? null : Number(row.registry_tx_id),
    registryBlockNumber: row.registry_block_number == null ? null : Number(row.registry_block_number),
    registryConfirmedAt: row.registry_confirmed_at || null,
    registryLastError: row.registry_last_error || null,
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    fundsConfirmedAt: row.funds_confirmed_at || null,
    completedAt: row.completed_at || null
  };
}

async function ensureCrossRegistry(row, client, dependencies = {}) {
  if (!row?.payment_tx_hash || String(row.status) !== 'FUNDS_CONFIRMED') {
    throw makeError('Movimento cross non pronto per PharaohRegistry', 'CROSS_OUTBOUND_REGISTRY_NOT_READY', false, 409);
  }
  if (row.registry_confirmed_at && row.registry_tx_id != null) return row;
  try {
    const registry = await pharaohRegistry.registerCrossOutgoing({
      operation: row,
      onSubmitted: async (registryTxHash) => {
        row = (await client.query(
          `UPDATE cross_outbound_operations
              SET registry_tx_hash=$2, registry_last_error=NULL, updated_at=NOW()
            WHERE event_key=$1 RETURNING *`,
          [row.event_key, registryTxHash]
        )).rows[0];
      }
    }, dependencies);
    row = (await client.query(
      `UPDATE cross_outbound_operations
          SET registry_tx_hash=$2,
              registry_tx_id=$3,
              registry_block_number=$4,
              registry_confirmed_at=COALESCE(registry_confirmed_at,NOW()),
              registry_last_error=NULL,
              updated_at=NOW()
        WHERE event_key=$1 RETURNING *`,
      [row.event_key, registry.txHash, registry.txId, registry.blockNumber]
    )).rows[0];
    return row;
  } catch (error) {
    await client.query(
      `UPDATE cross_outbound_operations
          SET registry_last_error=$2, status='FUNDS_CONFIRMED', updated_at=NOW()
        WHERE event_key=$1`,
      [row.event_key, String(error?.message || error || 'PharaohRegistry cross error').slice(0, 1000)]
    ).catch(() => null);
    throw error;
  }
}

async function scheduleRhaExit({ rhaEventKey, beneficiaryWallet, accountId = null, accountSigla = null, turno = null }, client = null) {
  const event = String(rhaEventKey || '').trim();
  if (!event) throw makeError('rhaEventKey obbligatorio', 'RHA_CROSS_EVENT_REQUIRED');
  const beneficiary = normalizeWallet(beneficiaryWallet, 'beneficiaryWallet');
  const runner = client || pg;

  await runner.query(
    `INSERT INTO rha_exit_allocations (rha_event_key, beneficiary_wallet, account_id, account_sigla, turno, protocol_version)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (rha_event_key) DO NOTHING`,
    [event, beneficiary, accountId, accountSigla || null, turno, RHA_PROTOCOL_V2]
  );
  const allocation = (await runner.query('SELECT * FROM rha_exit_allocations WHERE rha_event_key=$1', [event])).rows[0];
  if (!allocation) throw makeError('Impossibile persistere allocazione RHA', 'RHA_CROSS_ALLOCATION_FAILED');
  const protocolVersion = String(allocation.protocol_version || RHA_PROTOCOL_V1);
  const protocol = RHA_PROTOCOLS[protocolVersion];
  if (!protocol) throw makeError('RHA event con protocollo sconosciuto', 'RHA_CROSS_EVENT_CONFLICT', false, 409);
  if (
    String(allocation.beneficiary_wallet).toLowerCase() !== beneficiary ||
    (accountId != null && Number(allocation.account_id) !== Number(accountId)) ||
    (accountSigla && String(allocation.account_sigla || '') !== String(accountSigla)) ||
    (turno != null && Number(allocation.turno) !== Number(turno)) ||
    Number(allocation.rog_usdc) !== protocol.ROG.amount ||
    Number(allocation.uranus_usdc) !== protocol.URANUS.amount ||
    allocation.repayable !== false
  ) {
    throw makeError('RHA event gia legato a dati differenti', 'RHA_CROSS_EVENT_CONFLICT', false, 409);
  }

  const source = normalizeWallet(process.env.PHARAOH_TREASURY_WALLET, 'PHARAOH_TREASURY_WALLET');
  const specs = [
    { target: 'ROG', amount: protocol.ROG.amount, positions: protocol.ROG.positions, dest: normalizeWallet(process.env.ROG_TREASURY_WALLET, 'ROG_TREASURY_WALLET') },
    { target: 'URANUS', amount: protocol.URANUS.amount, positions: protocol.URANUS.positions, dest: normalizeWallet(process.env.URANUS_TREASURY_WALLET, 'URANUS_TREASURY_WALLET') }
  ];
  const operations = [];

  for (const spec of specs) {
    const key = `${event}:PHARAOH_TO_${spec.target}`;
    await runner.query(
      `INSERT INTO cross_outbound_operations
         (event_key,rha_event_key,target_platform,source_wallet,beneficiary_wallet,account_id,account_sigla,destination_wallet,amount_usdc,positions_expected,protocol_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (event_key) DO NOTHING`,
      [key, event, spec.target, source, beneficiary, accountId, accountSigla || null, spec.dest, spec.amount, spec.positions, protocolVersion]
    );
    const row = (await runner.query('SELECT * FROM cross_outbound_operations WHERE event_key=$1', [key])).rows[0];
    if (!row ||
        String(row.rha_event_key) !== event ||
        String(row.target_platform).toUpperCase() !== spec.target ||
        String(row.source_wallet).toLowerCase() !== source ||
        String(row.beneficiary_wallet).toLowerCase() !== beneficiary ||
        (accountId != null && Number(row.account_id) !== Number(accountId)) ||
        (accountSigla && String(row.account_sigla || '') !== String(accountSigla)) ||
        Number(row.amount_usdc) !== spec.amount ||
        Number(row.positions_expected) !== spec.positions ||
        String(row.protocol_version || RHA_PROTOCOL_V1) !== protocolVersion ||
        String(row.destination_wallet).toLowerCase() !== spec.dest) {
      throw makeError('Operazione RHA esistente non coerente', 'RHA_CROSS_OPERATION_CONFLICT', false, 409);
    }
    operations.push(publicOperation(row));
  }

  return {
    allocation: {
      rhaEventKey: event,
      beneficiaryWallet: beneficiary,
      accountId: accountId == null ? null : Number(accountId),
      accountSigla: accountSigla || null,
      protocolVersion,
      rogUsdc: protocol.ROG.amount,
      rogDualPositions: protocol.ROG.positions,
      uranusUsdc: protocol.URANUS.amount,
      uranusDualPositions: protocol.URANUS.positions,
      repayable: false
    },
    operations
  };
}

let sharedProvider = null;
function provider() {
  if (!sharedProvider) {
    const rpc = String(process.env.POLYGON_RPC_URL || '').trim();
    if (!rpc) throw makeError('POLYGON_RPC_URL non configurata', 'CROSS_OUTBOUND_RPC_UNAVAILABLE', false, 503);
    sharedProvider = new ethers.JsonRpcProvider(rpc);
  }
  return sharedProvider;
}

function signerFor(p) {
  const key = String(process.env.PHARAOH_PAYOUT_PRIVATE_KEY || '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) throw makeError('PHARAOH_PAYOUT_PRIVATE_KEY non configurata', 'PAYOUT_NOT_CONFIGURED', false, 503);
  return new ethers.Wallet(key, p);
}

async function verifyConfirmedTransfer(row, p, cfg) {
  const hash = normalizeTxHash(row.payment_tx_hash);
  const receipt = await p.getTransactionReceipt(hash);
  if (!receipt) throw makeError('Trasferimento cross ancora pending', 'CROSS_OUTBOUND_TX_PENDING', true, 425);
  if (Number(receipt.status) !== 1) throw makeError('Trasferimento cross revertito', 'CROSS_OUTBOUND_TX_REVERTED');
  if (String(receipt.from || '').toLowerCase() !== cfg.sourceWallet) {
    throw makeError('Mittente della transazione cross diverso dalla Cassa PHARAOH', 'CROSS_OUTBOUND_SENDER_MISMATCH');
  }
  const current = await p.getBlockNumber();
  const confirmations = Number(current) - Number(receipt.blockNumber) + 1;
  if (!Number.isInteger(confirmations) || confirmations < cfg.minConfirmations) {
    throw makeError('Conferme cross insufficienti', 'CROSS_OUTBOUND_TX_PENDING', true, 425);
  }

  const iface = new ethers.Interface(ERC20_ABI);
  let sum = 0n;
  const expected = ethers.parseUnits(String(Number(row.amount_usdc)), 6);
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== cfg.usdcAddress) continue;
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== 'Transfer') continue;
      if (String(parsed.args.from).toLowerCase() === cfg.sourceWallet && String(parsed.args.to).toLowerCase() === cfg.destinationWallet) {
        sum += BigInt(parsed.args.value.toString());
      }
    } catch (_) { /* non ERC20 */ }
  }
  if (sum !== expected) throw makeError('Receipt cross non contiene il Transfer USDC esatto atteso', 'CROSS_OUTBOUND_PROOF_MISMATCH');
  return {
    txHash: hash,
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    confirmations,
    from: cfg.sourceWallet,
    to: cfg.destinationWallet,
    amountUsdc: Number(row.amount_usdc),
    amountBaseUnits: sum.toString(),
    tokenContract: cfg.usdcAddress,
    verifiedAt: new Date().toISOString()
  };
}

async function verifyConfirmedRogRegistration(row, p, cfg) {
  if (cfg.target !== 'ROG') return null;
  const hash = normalizeTxHash(row.rog_register_tx_hash);
  const receipt = await p.getTransactionReceipt(hash);
  if (!receipt) throw makeError('registerDonation ROG ancora pending', 'CROSS_OUTBOUND_ROG_REGISTER_PENDING', true, 425);
  if (Number(receipt.status) !== 1) {
    throw makeError('registerDonation ROG revertita: riconciliazione manuale necessaria', 'CROSS_OUTBOUND_ROG_REGISTER_REVERTED', false, 409);
  }
  if (String(receipt.from || '').toLowerCase() !== cfg.sourceWallet) {
    throw makeError('registerDonation ROG non firmata dalla Cassa PHARAOH', 'CROSS_OUTBOUND_ROG_REGISTER_SENDER_MISMATCH');
  }
  const current = await p.getBlockNumber();
  const confirmations = Number(current) - Number(receipt.blockNumber) + 1;
  if (!Number.isInteger(confirmations) || confirmations < cfg.minConfirmations) {
    throw makeError('Conferme registerDonation ROG insufficienti', 'CROSS_OUTBOUND_ROG_REGISTER_PENDING', true, 425);
  }
  const iface = new ethers.Interface(ROG_CROSS_ABI);
  const expectedAmount = ethers.parseUnits(String(Number(row.amount_usdc)), 6);
  let proof = null;
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== cfg.rogContractAddress) continue;
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== 'DonationRegistered') continue;
      const donor = String(parsed.args.donor).toLowerCase();
      const amount = BigInt(parsed.args.amount.toString());
      const donationId = BigInt(parsed.args.donationId.toString());
      if (donor === cfg.sourceWallet && amount === expectedAmount && donationId > 0n) {
        proof = {
          txHash: hash,
          donationId: donationId.toString(),
          donor,
          amountUsdc: Number(row.amount_usdc),
          amountBaseUnits: amount.toString(),
          blockNumber: Number(receipt.blockNumber),
          blockHash: receipt.blockHash,
          confirmations,
          contractAddress: cfg.rogContractAddress,
          verifiedAt: new Date().toISOString()
        };
        break;
      }
    } catch (_) { /* log non ROG */ }
  }
  if (!proof) throw makeError('Evento DonationRegistered ROG non coerente con Cassa PHARAOH/importo', 'CROSS_OUTBOUND_ROG_REGISTER_PROOF_MISMATCH');
  if (row.rog_donation_id && String(row.rog_donation_id) !== proof.donationId) {
    throw makeError('donationId ROG persistito diverso dal receipt', 'CROSS_OUTBOUND_ROG_DONATION_ID_MISMATCH', false, 409);
  }
  return proof;
}

async function submitRogRegistration({ client, row, cfg, p, dependencies }) {
  if (cfg.target !== 'ROG') return row;
  let signerLocked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [GLOBAL_PAYOUT_SIGNER_LOCK]);
    signerLocked = true;
    const signer = dependencies.signer || signerFor(p);
    const address = String(await signer.getAddress()).toLowerCase();
    if (address !== cfg.sourceWallet) throw makeError('La chiave payout non corrisponde alla Cassa PHARAOH', 'PAYOUT_WALLET_MISMATCH', false, 503);
    const network = await p.getNetwork();
    if (Number(network.chainId) !== cfg.chainId) throw makeError('Rete Polygon non coerente', 'BLOCKCHAIN_WRONG_NETWORK');

    const nonce = await p.getTransactionCount(address, 'pending');
    row = (await client.query(
      `UPDATE cross_outbound_operations
          SET rog_register_nonce=$2, rog_register_last_error=NULL, updated_at=NOW()
        WHERE event_key=$1 RETURNING *`,
      [row.event_key, nonce]
    )).rows[0];

    const contract = dependencies.rogContract || new ethers.Contract(cfg.rogContractAddress, ROG_CROSS_ABI, signer);
    const tx = await contract.registerDonation(ethers.parseUnits(String(Number(row.amount_usdc)), 6), { nonce });
    row = (await client.query(
      `UPDATE cross_outbound_operations
          SET rog_register_tx_hash=$2, rog_register_submitted_at=COALESCE(rog_register_submitted_at,NOW()),
              rog_register_last_error=NULL, updated_at=NOW()
        WHERE event_key=$1 RETURNING *`,
      [row.event_key, String(tx.hash).toLowerCase()]
    )).rows[0];
    return { row, tx };
  } catch (error) {
    if (row?.rog_register_nonce != null && !row?.rog_register_tx_hash) {
      await client.query(
        `UPDATE cross_outbound_operations
            SET status='RECONCILIATION_REQUIRED', rog_register_last_error=$2, last_error=$2, updated_at=NOW()
          WHERE event_key=$1`,
        [row.event_key, String(error.message).slice(0, 1000)]
      ).catch(() => null);
    } else {
      await client.query(
        `UPDATE cross_outbound_operations SET rog_register_last_error=$2, updated_at=NOW() WHERE event_key=$1`,
        [row.event_key, String(error.message).slice(0, 1000)]
      ).catch(() => null);
    }
    throw error;
  } finally {
    if (signerLocked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [GLOBAL_PAYOUT_SIGNER_LOCK]); } catch (_) { /* release connection */ }
    }
  }
}

async function ensureRogRegistration(row, client, cfg, p, dependencies = {}) {
  if (cfg.target !== 'ROG') return row;
  if (row.rog_register_tx_hash) {
    try {
      const proof = await verifyConfirmedRogRegistration(row, p, cfg);
      row = (await client.query(
        `UPDATE cross_outbound_operations
            SET rog_donation_id=$2, rog_register_proof=$3::jsonb,
                rog_register_confirmed_at=COALESCE(rog_register_confirmed_at,NOW()),
                rog_register_last_error=NULL, updated_at=NOW()
          WHERE event_key=$1 RETURNING *`,
        [row.event_key, proof.donationId, JSON.stringify(proof)]
      )).rows[0];
      return row;
    } catch (error) {
      if (error.code === 'CROSS_OUTBOUND_ROG_REGISTER_REVERTED') {
        row = (await client.query(
          `UPDATE cross_outbound_operations
              SET status='RECONCILIATION_REQUIRED', rog_register_last_error=$2, last_error=$2, updated_at=NOW()
            WHERE event_key=$1 RETURNING *`,
          [row.event_key, String(error.message).slice(0, 1000)]
        )).rows[0];
      }
      throw error;
    }
  }
  if (row.rog_register_nonce != null) {
    row = (await client.query(
      `UPDATE cross_outbound_operations
          SET status='RECONCILIATION_REQUIRED',
              rog_register_last_error=COALESCE(rog_register_last_error,'Nonce registerDonation ROG riservato ma tx hash assente'),
              last_error=COALESCE(last_error,'Nonce registerDonation ROG riservato ma tx hash assente'),
              updated_at=NOW()
        WHERE event_key=$1 RETURNING *`,
      [row.event_key]
    )).rows[0];
    throw makeError('registerDonation ROG richiede riconciliazione prima di qualsiasi nuovo broadcast', 'CROSS_OUTBOUND_ROG_REGISTER_RECONCILIATION_REQUIRED', false, 409);
  }

  const submitted = await submitRogRegistration({ client, row, cfg, p, dependencies });
  row = submitted.row;
  try {
    const receipt = await submitted.tx.wait(cfg.minConfirmations);
    if (!receipt) throw makeError('Receipt registerDonation ROG non disponibile', 'CROSS_OUTBOUND_ROG_REGISTER_PENDING', true, 425);
    const proof = await verifyConfirmedRogRegistration(row, p, cfg);
    row = (await client.query(
      `UPDATE cross_outbound_operations
          SET rog_donation_id=$2, rog_register_proof=$3::jsonb,
              rog_register_confirmed_at=NOW(), rog_register_last_error=NULL, updated_at=NOW()
        WHERE event_key=$1 RETURNING *`,
      [row.event_key, proof.donationId, JSON.stringify(proof)]
    )).rows[0];
    return row;
  } catch (error) {
    await client.query(
      `UPDATE cross_outbound_operations SET rog_register_last_error=$2, updated_at=NOW() WHERE event_key=$1`,
      [row.event_key, String(error.message).slice(0, 1000)]
    ).catch(() => null);
    throw error;
  }
}

async function notifyTarget(row, cfg, fetchImpl = fetch) {
  const body = {
    event_key: row.event_key,
    origine: 'PHARAOH',
    wallet_origine: cfg.sourceWallet,
    wallet_beneficiario: String(row.beneficiary_wallet).toLowerCase(),
    wallet_cassa: cfg.destinationWallet,
    importo_totale: Number(row.amount_usdc),
    num_ingressi: Number(row.positions_expected),
    payment_tx_hash: String(row.payment_tx_hash).toLowerCase(),
    ...(cfg.target === 'ROG' ? {
      protocol_version: String(row.protocol_version || RHA_PROTOCOL_V2),
      register_tx_hash: String(row.rog_register_tx_hash || '').toLowerCase(),
      donation_id: String(row.rog_donation_id || '')
    } : {})
  };
  const controller = new AbortController();
  const timeoutMs = Number(process.env.CROSS_OUTBOUND_TIMEOUT_MS || 10000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(cfg.receiverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Platform-Origin': 'PHARAOH',
        'X-Platform-Signature': auth.signBody(body, cfg.target)
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* invalid JSON handled below */ }
    if (!response.ok || payload?.success !== true) {
      const status = Number(response.status || 503);
      const retryable = payload?.retryable === true || status === 408 || status === 425 || status === 429 || status >= 500;
      const error = makeError(`${cfg.target} non ha confermato evento cross`, 'CROSS_OUTBOUND_NOTIFY_FAILED', retryable, status);
      error.payload = payload;
      throw error;
    }
    if (cfg.target === 'ROG') {
      const beneficiary = String(row.beneficiary_wallet).toLowerCase();
      const rgxOwner = String(payload?.rgxOwnerWallet || '').toLowerCase();
      const beneficiaryOwner = String(payload?.beneficiaryWallet || '').toLowerCase();
      const positionsOwner = String(payload?.positionsOwnerWallet || '').toLowerCase();
      const rgxMinted = Number(payload?.rgxMinted);
      const remoteDonationId = String(payload?.donation_id || payload?.donationId || '');
      if (String(payload?.status || '').toUpperCase() !== 'COMPLETED' ||
          beneficiaryOwner !== beneficiary || positionsOwner !== beneficiary ||
          rgxOwner !== cfg.sourceWallet || rgxMinted !== Number(row.positions_expected) ||
          remoteDonationId !== String(row.rog_donation_id || '')) {
        const error = makeError('ROG ha risposto con ownership/conteggi/donationId incoerenti', 'CROSS_OUTBOUND_ROG_POSTCONDITION_FAILED', false, 409);
        error.payload = payload;
        throw error;
      }
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw makeError(`Timeout notifica ${cfg.target}`, 'CROSS_OUTBOUND_NOTIFY_FAILED', true, 503);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function submitTransfer({ client, row, cfg, p, dependencies }) {
  assertOperationInvariant(row, cfg);
  let signerLocked = false;
  let tx = null;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [GLOBAL_PAYOUT_SIGNER_LOCK]);
    signerLocked = true;

    const signer = dependencies.signer || signerFor(p);
    const address = String(await signer.getAddress()).toLowerCase();
    if (address !== cfg.sourceWallet) throw makeError('La chiave payout non corrisponde alla Cassa PHARAOH', 'PAYOUT_WALLET_MISMATCH', false, 503);
    const network = await p.getNetwork();
    if (Number(network.chainId) !== cfg.chainId) throw makeError('Rete Polygon non coerente', 'BLOCKCHAIN_WRONG_NETWORK');

    const nonce = await p.getTransactionCount(address, 'pending');
    row = (await client.query(
      `UPDATE cross_outbound_operations
          SET status='TRANSFER_SUBMITTING', sender_nonce=$2, attempts=attempts+1, updated_at=NOW(), last_error=NULL
        WHERE event_key=$1 RETURNING *`,
      [row.event_key, nonce]
    )).rows[0];

    const contract = dependencies.contract || new ethers.Contract(cfg.usdcAddress, ERC20_ABI, signer);
    tx = await contract.transfer(cfg.destinationWallet, ethers.parseUnits(String(Number(row.amount_usdc)), 6), { nonce });
    row = (await client.query(
      `UPDATE cross_outbound_operations SET payment_tx_hash=$2, updated_at=NOW() WHERE event_key=$1 RETURNING *`,
      [row.event_key, String(tx.hash).toLowerCase()]
    )).rows[0];
    return { row, tx };
  } catch (error) {
    if (row?.sender_nonce != null && !row?.payment_tx_hash) {
      await client.query(
        `UPDATE cross_outbound_operations
            SET status='RECONCILIATION_REQUIRED', last_error=$2, updated_at=NOW()
          WHERE event_key=$1`,
        [row.event_key, String(error.message).slice(0, 1000)]
      ).catch(() => null);
    }
    throw error;
  } finally {
    if (signerLocked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [GLOBAL_PAYOUT_SIGNER_LOCK]); } catch (_) { /* connection release is final guard */ }
    }
  }
}

async function processOperation(eventKey, dependencies = {}) {
  const database = dependencies.pg || pg;
  const client = await database.getClient();
  const key = String(eventKey || '').trim();
  if (!key) {
    client.release();
    throw makeError('eventKey obbligatorio', 'CROSS_OUTBOUND_EVENT_REQUIRED');
  }
  const eventLock = `PHARAOH:CROSS:OUT:${key}`;
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [eventLock]);
    locked = true;
    let row = (await client.query('SELECT * FROM cross_outbound_operations WHERE event_key=$1', [key])).rows[0];
    if (!row) throw makeError('Operazione cross outbound non trovata', 'CROSS_OUTBOUND_NOT_FOUND', false, 404);
    if (row.status === 'COMPLETED') return { success: true, idempotent: true, operation: publicOperation(row) };

    const cfg = getConfig(row.target_platform);
    assertOperationInvariant(row, cfg);
    const p = dependencies.provider || provider();

    if (row.payment_tx_hash) {
      const proof = await verifyConfirmedTransfer(row, p, cfg);
      row = (await client.query(
        `UPDATE cross_outbound_operations
            SET status='FUNDS_CONFIRMED', blockchain_proof=$2::jsonb,
                funds_confirmed_at=COALESCE(funds_confirmed_at,NOW()), updated_at=NOW(), last_error=NULL
          WHERE event_key=$1 RETURNING *`,
        [key, JSON.stringify(proof)]
      )).rows[0];
    } else if (row.status === 'TRANSFER_SUBMITTING' || row.status === 'RECONCILIATION_REQUIRED') {
      row = (await client.query(
        `UPDATE cross_outbound_operations
            SET status='RECONCILIATION_REQUIRED', updated_at=NOW(),
                last_error=COALESCE(last_error,'Nonce riservato ma tx hash assente: riconciliazione manuale necessaria')
          WHERE event_key=$1 RETURNING *`,
        [key]
      )).rows[0];
      throw makeError('Operazione richiede riconciliazione prima di qualsiasi nuovo invio', 'CROSS_OUTBOUND_RECONCILIATION_REQUIRED', false, 409);
    } else {
      const submitted = await submitTransfer({ client, row, cfg, p, dependencies });
      row = submitted.row;
      try {
        const receipt = await submitted.tx.wait(cfg.minConfirmations);
        if (!receipt) throw makeError('Receipt payout cross non disponibile', 'CROSS_OUTBOUND_TX_PENDING', true, 425);
        const proof = await verifyConfirmedTransfer(row, p, cfg);
        row = (await client.query(
          `UPDATE cross_outbound_operations
              SET status='FUNDS_CONFIRMED', blockchain_proof=$2::jsonb,
                  funds_confirmed_at=NOW(), updated_at=NOW(), last_error=NULL
            WHERE event_key=$1 RETURNING *`,
          [key, JSON.stringify(proof)]
        )).rows[0];
      } catch (error) {
        await client.query(
          `UPDATE cross_outbound_operations SET last_error=$2, updated_at=NOW() WHERE event_key=$1`,
          [key, String(error.message).slice(0, 1000)]
        ).catch(() => null);
        throw error;
      }
    }

    // Il trasferimento RHA viene prima ancorato al PharaohRegistry. Solo dopo
    // viene notificato il receiver ROG/URANUS, cosi un crash non puo lasciare
    // il remote completato senza prova on-chain PHARAOH.
    row = await ensureCrossRegistry(row, client, dependencies);

    // Solo per ROG: dopo i fondi e la prova PharaohRegistry, la stessa Cassa
    // PHARAOH registra l'importo sul contratto ROG. La prova e persistita
    // prima della notifica HMAC; nessun retry puo ripetere alla cieca il broadcast.
    row = await ensureRogRegistration(row, client, cfg, p, dependencies);

    try {
      const remote = await notifyTarget(row, cfg, dependencies.fetch || fetch);
      row = (await client.query(
        `UPDATE cross_outbound_operations
            SET status='COMPLETED', notify_response=$2::jsonb, completed_at=NOW(), updated_at=NOW(), last_error=NULL
          WHERE event_key=$1 RETURNING *`,
        [key, JSON.stringify(remote)]
      )).rows[0];
      return { success: true, operation: publicOperation(row), remote };
    } catch (error) {
      const nextStatus = error?.retryable === true ? 'NOTIFY_PENDING' : 'RECONCILIATION_REQUIRED';
      row = (await client.query(
        `UPDATE cross_outbound_operations SET status=$2, last_error=$3, updated_at=NOW() WHERE event_key=$1 RETURNING *`,
        [key, nextStatus, String(error.message).slice(0, 1000)]
      )).rows[0];
      error.operation = publicOperation(row);
      throw error;
    }
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [eventLock]); } catch (_) { /* release connection */ }
    }
    client.release();
  }
}

async function processPending(limit = 10) {
  const n = Math.min(100, Math.max(1, Number(limit) || 10));
  const rows = await pg.queryMany(
    `SELECT event_key
       FROM cross_outbound_operations
      WHERE status IN ('PENDING','TRANSFER_SUBMITTING','FUNDS_CONFIRMED','NOTIFY_PENDING')
      ORDER BY created_at ASC
      LIMIT $1`,
    [n]
  );
  const results = [];
  for (const row of rows) {
    try { results.push(await processOperation(row.event_key)); }
    catch (error) {
      results.push({
        success: false,
        eventKey: row.event_key,
        code: error.code || 'ERROR',
        retryable: error.retryable === true,
        operation: error.operation || null,
        error: error.message
      });
    }
  }
  return { success: true, processed: results.length, results };
}

async function listOperations(limit = 100) {
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  const rows = await pg.queryMany('SELECT * FROM cross_outbound_operations ORDER BY created_at DESC LIMIT $1', [n]);
  return rows.map(publicOperation);
}

async function attachReconciledTx({ eventKey, paymentTxHash }) {
  const key = String(eventKey || '').trim();
  const hash = normalizeTxHash(paymentTxHash);
  const result = await pg.queryOne(
    `UPDATE cross_outbound_operations
        SET payment_tx_hash=$2, status='TRANSFER_SUBMITTING', last_error=NULL, updated_at=NOW()
      WHERE event_key=$1 AND status='RECONCILIATION_REQUIRED' AND payment_tx_hash IS NULL
      RETURNING *`,
    [key, hash]
  );
  if (!result) throw makeError('Operazione non riconciliabile o gia dotata di tx', 'CROSS_OUTBOUND_RECONCILE_CONFLICT', false, 409);
  return publicOperation(result);
}

async function attachReconciledRogRegisterTx({ eventKey, registerTxHash }) {
  const key = String(eventKey || '').trim();
  const hash = normalizeTxHash(registerTxHash);
  const result = await pg.queryOne(
    `UPDATE cross_outbound_operations
        SET rog_register_tx_hash=$2,
            rog_register_submitted_at=COALESCE(rog_register_submitted_at,NOW()),
            status='FUNDS_CONFIRMED', rog_register_last_error=NULL, last_error=NULL, updated_at=NOW()
      WHERE event_key=$1
        AND target_platform='ROG'
        AND status='RECONCILIATION_REQUIRED'
        AND rog_register_nonce IS NOT NULL
        AND rog_register_tx_hash IS NULL
      RETURNING *`,
    [key, hash]
  );
  if (!result) throw makeError('Operazione ROG non riconciliabile o gia dotata di register tx', 'CROSS_OUTBOUND_ROG_REGISTER_RECONCILE_CONFLICT', false, 409);
  return publicOperation(result);
}

module.exports = {
  GLOBAL_PAYOUT_SIGNER_LOCK,
  RHA_PROTOCOL_V1,
  RHA_PROTOCOL_V2,
  RHA_PROTOCOLS,
  scheduleRhaExit,
  processOperation,
  processPending,
  ensureCrossRegistry,
  listOperations,
  attachReconciledTx,
  attachReconciledRogRegisterTx,
  _verifyConfirmedTransfer: verifyConfirmedTransfer,
  _verifyConfirmedRogRegistration: verifyConfirmedRogRegistration,
  _submitRogRegistration: submitRogRegistration,
  _ensureRogRegistration: ensureRogRegistration,
  _notifyTarget: notifyTarget,
  _getConfig: getConfig,
  _publicOperation: publicOperation,
  _assertOperationInvariant: assertOperationInvariant,
  _submitTransfer: submitTransfer
};
