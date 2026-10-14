'use strict';

const db = require('./db-manager');
const tableManager = require('./table-manager');
const rules = require('./rules-engine');
const pg = require('./pg-connection-manager');

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const ALLOWED_SOURCES = new Set(['GIFT']);
function makeError(message, code, retryable = false) { const error = new Error(message); error.code = code; error.retryable = retryable; return error; }
function normalizeWallet(value, label) { const wallet = String(value || '').trim().toLowerCase(); if (!WALLET_RE.test(wallet)) throw makeError(`${label} non valido`, 'VERIFIED_ENTRY_WALLET_INVALID'); return wallet; }
function normalizeTx(value) { const hash = String(value || '').trim().toLowerCase(); if (!HASH_RE.test(hash)) throw makeError('txHash non valido', 'VERIFIED_ENTRY_TX_INVALID'); return hash; }
function getSystemWallets() { const donationFlow = require('./donation-flow-manager'); return { treasury: donationFlow.CASSA_PHARAOH_WALLET }; }

async function processCompletedEntryTable() {
  // Never execute legacy post-commit operations without reviewed funding.
  throw makeError('Usare la coda post-commit economica V4', 'LEGACY_UNFUNDED_ENTRY_COMPLETION_DISABLED');
}

async function assignOneVerifiedEntry({ paymentWallet, beneficiaryWallet, txHash, amountUsdc, blockchainProof, sourcePlatform, sourceEventKey, beneficiaryName = null, atomicComplete = null }) {
  const payer = normalizeWallet(paymentWallet, 'paymentWallet'); const beneficiary = normalizeWallet(beneficiaryWallet, 'beneficiaryWallet'); const canonicalTx = normalizeTx(txHash); const source = String(sourcePlatform || '').trim().toUpperCase(); const eventKey = String(sourceEventKey || '').trim();
  if (!ALLOWED_SOURCES.has(source)) throw makeError('sourcePlatform non autorizzata', 'VERIFIED_ENTRY_SOURCE_INVALID'); if (!eventKey) throw makeError('sourceEventKey obbligatoria', 'VERIFIED_ENTRY_EVENT_KEY_REQUIRED');
  if (Number(amountUsdc) !== Number(rules.IMPORTI.DONO_ENTRATA) || Number(amountUsdc) !== 100) throw makeError('Carta Regalo richiede esattamente 100 USDC e una posizione', 'GIFT_PHARAOH_AMOUNT_INVALID');
  if (!blockchainProof || typeof blockchainProof !== 'object') throw makeError('Prova blockchain PHARAOH obbligatoria', 'BLOCKCHAIN_PROOF_REQUIRED');
  if (String(blockchainProof.txHash || '').toLowerCase() !== canonicalTx || String(blockchainProof.from || '').toLowerCase() !== payer || Number(blockchainProof.amountUsdc) !== 100) throw makeError('Prova blockchain PHARAOH non coerente con Carta Regalo', 'GIFT_PHARAOH_PROOF_MISMATCH');
  const { treasury } = getSystemWallets(); if (String(blockchainProof.to || '').toLowerCase() !== String(treasury).toLowerCase()) throw makeError('Destinatario on-chain diverso dalla Cassa PHARAOH', 'GIFT_PHARAOH_TREASURY_MISMATCH');
  await db.initDatabase(); const client = await pg.getClient(); let lockAcquired = false; let transactionBegun = false; let flowError = null; let completedTable = null; const lockKey = canonicalTx;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]); lockAcquired = true;
    const existingTx = await client.query('SELECT id FROM donazioni WHERE LOWER(tx_hash) = $1 LIMIT 1', [canonicalTx]); if (existingTx?.rows?.length) throw makeError('Transazione gia registrata nel sistema', 'BLOCKCHAIN_TX_REPLAY');
    const existingEvent = await client.query('SELECT id FROM donazioni WHERE source_platform = $1 AND source_event_key = $2 LIMIT 1', [source, eventKey]); if (existingEvent?.rows?.length) throw makeError('Evento Carta Regalo gia consumato', 'GIFT_EVENT_REPLAY');
    await client.query('BEGIN'); transactionBegun = true; await require('./economic-ledger').configuredLedger(client).ready(); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['PHARAOH:ENTRATA:POSIZIONAMENTO']);
    const economicFlow = require('./economic-flow');
    const materialized = await economicFlow.configuredFlow(client).admitExternal({eventKey,origin:'GIFT',payer,
      beneficiaryWallet:beneficiary,name:(beneficiaryName || '').trim() || null,count:1,txHash:canonicalTx,proof:blockchainProof});
    const entry = materialized.positions[0];
    const tavola = {id:entry.tableId,numero:entry.tableNumber};
    const turno = {id:entry.turnId,numero_turno:entry.turnNumber};
    await db.createDonazione({ donorWallet: payer, importo: 100, txHash: canonicalTx, tipo: 'DONO', destinatarioWallet: treasury, beneficiaryWallet: beneficiary, sourcePlatform: source, sourceEventKey: eventKey, positionsCreated: 1, tavolaId: tavola.id, livello: 0, turno: turno.numero_turno, blockchainProof }, client);
    const coreResult = {success:true,sourcePlatform:source,sourceEventKey:eventKey,paymentWallet:payer,
      beneficiaryWallet:beneficiary,numeroPosizioni:1,importoTotale:100,pharaohTxHash:canonicalTx,
      posizioni:materialized.positions.map(economicFlow.publicPosition)};
    if (typeof atomicComplete === 'function') await atomicComplete(client, coreResult); await client.query('COMMIT'); transactionBegun = false;
    const trasferimentiSistema = []; if (completedTable) trasferimentiSistema.push(await processCompletedEntryTable({ completed: completedTable, txHash: canonicalTx, client })); return { ...coreResult, trasferimentiSistema };
  } catch (error) { flowError = error; if (transactionBegun) { try { await client.query('ROLLBACK'); } catch (_) {} } throw error; }
  finally { let unlockError = null; if (lockAcquired) { try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); } catch (error) { unlockError = error; } } client.release(); if (unlockError && !flowError) throw unlockError; }
}
module.exports = { assignOneVerifiedEntry, _processCompletedEntryTable: processCompletedEntryTable, _makeError: makeError };
