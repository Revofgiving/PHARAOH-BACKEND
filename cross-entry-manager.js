'use strict';

const pg = require('./pg-connection-manager');
const db = require('./db-manager');
const tableManager = require('./table-manager');
const rules = require('./rules-engine');
const verifier = require('./blockchain-verifier');
const pharaohRegistry = require('./pharaoh-registry-manager');

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const SOURCE = 'URANUS_TO_PHARAOH';

function makeError(message, code, retryable = false, httpStatus = null) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (httpStatus) error.httpStatus = httpStatus;
  return error;
}
function wallet(v, label) { const x = String(v || '').trim().toLowerCase(); if (!WALLET_RE.test(x)) throw makeError(`${label} non valido`, 'CROSS_WALLET_INVALID'); return x; }
function hash(v, label = 'paymentTxHash') { const x = String(v || '').trim().toLowerCase(); if (!HASH_RE.test(x)) throw makeError(`${label} non valido`, 'CROSS_TX_INVALID'); return x; }
function eventKey(v) { const x = String(v || '').trim(); if (!x || x.length > 200 || !/^[A-Za-z0-9:_\-.]+$/.test(x)) throw makeError('event_key non valido', 'CROSS_EVENT_KEY_INVALID'); return x; }
function first(body, ...keys) { for (const key of keys) if (body?.[key] !== undefined && body[key] !== null && body[key] !== '') return body[key]; return null; }

function normalizePayload(body) {
  const origin = String(first(body, 'origine', 'sourcePlatform', 'source_platform') || '').trim().toUpperCase();
  if (origin && !['URANUS', SOURCE].includes(origin)) throw makeError('Solo URANUS_TO_PHARAOH e autorizzato', 'CROSS_SOURCE_FORBIDDEN', false, 403);
  const paymentWallet = wallet(first(body, 'wallet_origine', 'paymentWallet', 'payment_wallet'), 'wallet_origine');
  const beneficiaryWallet = wallet(first(body, 'wallet_beneficiario', 'beneficiaryWallet', 'beneficiary_wallet'), 'wallet_beneficiario');
  const destinationWallet = wallet(first(body, 'wallet_cassa', 'destinationWallet', 'destination_wallet') || process.env.PHARAOH_TREASURY_WALLET, 'wallet_cassa');
  const amountUsdc = Number(first(body, 'importo_totale', 'amountUSDC', 'amountUsdc', 'amount_usdc'));
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0 || amountUsdc % 100 !== 0) throw makeError('URANUS_TO_PHARAOH richiede un multiplo esatto di 100 USDC', 'CROSS_AMOUNT_INVALID');
  const expectedPositions = amountUsdc / 100;
  if (!Number.isInteger(expectedPositions) || expectedPositions < 1 || expectedPositions > 100) throw makeError('Numero posizioni cross non valido', 'CROSS_POSITIONS_INVALID');
  const declaredPositions = first(body, 'num_ingressi', 'positions', 'positionsExpected', 'positions_expected');
  if (declaredPositions != null && Number(declaredPositions) !== expectedPositions) throw makeError('num_ingressi non coerente con importo', 'CROSS_POSITIONS_MISMATCH');
  return {
    eventKey: eventKey(first(body, 'event_key', 'sourceEventKey', 'source_event_key')),
    sourcePlatform: SOURCE,
    paymentWallet,
    beneficiaryWallet,
    destinationWallet,
    amountUsdc,
    positionsExpected: expectedPositions,
    paymentTxHash: hash(first(body, 'payment_tx_hash', 'paymentTxHash', 'txHash')),
    beneficiaryName: String(first(body, 'beneficiary_name', 'beneficiaryName', 'nome') || '').trim().slice(0, 100) || null
  };
}

function assertTreasuries(payload) {
  const uranus = wallet(process.env.URANUS_TREASURY_WALLET, 'URANUS_TREASURY_WALLET');
  const pharaoh = wallet(process.env.PHARAOH_TREASURY_WALLET, 'PHARAOH_TREASURY_WALLET');
  if (payload.paymentWallet !== uranus) throw makeError('Il mittente on-chain deve essere la Cassa URANUS ufficiale', 'CROSS_SOURCE_TREASURY_MISMATCH', false, 403);
  if (payload.destinationWallet !== pharaoh) throw makeError('Il destinatario on-chain deve essere la Cassa PHARAOH ufficiale', 'CROSS_DESTINATION_TREASURY_MISMATCH', false, 403);
}

function publicRow(row) {
  if (!row) return null;
  return { eventKey: row.event_key, sourcePlatform: row.source_platform, paymentWallet: row.payment_wallet, beneficiaryWallet: row.beneficiary_wallet, destinationWallet: row.destination_wallet, amountUsdc: Number(row.amount_usdc), positionsExpected: Number(row.positions_expected), paymentTxHash: row.payment_tx_hash, registryTxHash: row.registry_tx_hash || null, registryTxId: row.registry_tx_id == null ? null : Number(row.registry_tx_id), registryBlockNumber: row.registry_block_number == null ? null : Number(row.registry_block_number), registryConfirmedAt: row.registry_confirmed_at || null, status: row.status, positionResult: row.position_result || null, lastError: row.last_error || row.registry_last_error || null };
}

async function processCompletedEntryTable({ completed, txHash, client }) {
  const donationFlow = require('./donation-flow-manager');
  const { turno, tavola, eredeWallet, nomeErede, isFondo, doniRicevuti, turnoEntrataAvviatoNelBatch } = completed;
  const event = `${txHash}:USCITA_ENTRATA:TAVOLA:${tavola.id}`;
  let tx = false;
  try {
    await client.query('BEGIN');
    tx = true;
    let op = await db.getPostCommitOperationByEventKey(event, client);
    if (op?.status === 'COMPLETED') {
      await client.query('COMMIT');
      tx = false;
      return { tavola: tavola.numero, status: 'ALREADY_COMPLETED' };
    }
    const claimed = await db.markPostCommitOperationInProgress(event, client);
    if (!claimed) {
      op = await db.getPostCommitOperationByEventKey(event, client);
      if (op?.status === 'COMPLETED') {
        await client.query('COMMIT');
        tx = false;
        return { tavola: tavola.numero, status: 'ALREADY_COMPLETED' };
      }
      throw makeError(`Post-COMMIT busy: ${event}`, 'CROSS_POST_COMMIT_BUSY', true);
    }

    const trattenuta = rules.IMPORTI.TRATTENUTA_FONDO_ENTRATA;
    await db.registraAvanzamento({
      wallet: eredeWallet,
      tipoAccount: isFondo ? 'FONDO' : 'SACERDOTE',
      daLivello: 0,
      aLivello: 1,
      turno: turno.numero_turno,
      doniRicevuti,
      doniTrattenuti: trattenuta,
      netto: doniRicevuti - trattenuta,
      evento: 'USCITA_ENTRATA',
      eventKey: event
    }, client);

    await donationFlow.posizionaSacerdoteInPharaoh(eredeWallet, nomeErede, client);
    let rollover = null;
    if (!turnoEntrataAvviatoNelBatch) {
      const next = await donationFlow.avviaNuovoTurnoEntrata(turno, client);
      rollover = next?.rollover || null;
    }
    await db.markPostCommitOperationCompleted(event, client);
    await client.query('COMMIT');
    tx = false;

    return {
      tavola: tavola.numero,
      status: 'COMPLETED',
      rollover: rollover ? {
        amountUsdc: 100,
        targetTable: rollover.audit?.target_tavola_numero || null,
        targetSlot: rollover.audit?.target_casella || rollover.placement?.casellaOccupata || null
      } : null
    };
  } catch (error) {
    if (tx) try { await client.query('ROLLBACK'); } catch (_) {}
    await db.markPostCommitOperationFailed(event, error.message).catch(() => null);
    return { tavola: tavola.numero, status: 'POST_COMMIT_PENDING', error: error.message };
  }
}

async function processUranusDonation(body, dependencies = {}) {
  const payload = normalizePayload(body); assertTreasuries(payload);
  await db.initDatabase();
  const database = dependencies.pg || pg;
  const client = await database.getClient();
  const lockKey = `PHARAOH:CROSS:${payload.eventKey}`;
  let locked = false; let inTx = false; let flowError = null;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]); locked = true;
    let existing = (await client.query('SELECT * FROM cross_entry_events WHERE event_key=$1', [payload.eventKey])).rows[0] || null;
    if (existing) {
      const same = String(existing.payment_wallet).toLowerCase() === payload.paymentWallet && String(existing.beneficiary_wallet).toLowerCase() === payload.beneficiaryWallet && String(existing.destination_wallet).toLowerCase() === payload.destinationWallet && Number(existing.amount_usdc) === payload.amountUsdc && Number(existing.positions_expected) === payload.positionsExpected && String(existing.payment_tx_hash).toLowerCase() === payload.paymentTxHash;
      if (!same) throw makeError('event_key gia usato con dati differenti', 'CROSS_EVENT_CONFLICT', false, 409);
      if (existing.status === 'POSITION_ASSIGNED') return { success: true, idempotent: true, event: publicRow(existing), result: existing.position_result || null };
      if (existing.status === 'CANCELLED') throw makeError('Evento cross cancellato', 'CROSS_CANCELLED', false, 409);
    } else {
      try {
        existing = (await client.query(`INSERT INTO cross_entry_events (event_key,source_platform,payment_wallet,beneficiary_wallet,destination_wallet,amount_usdc,positions_expected,payment_tx_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [payload.eventKey, SOURCE, payload.paymentWallet, payload.beneficiaryWallet, payload.destinationWallet, payload.amountUsdc, payload.positionsExpected, payload.paymentTxHash])).rows[0];
      } catch (error) {
        if (String(error.code) === '23505') throw makeError('payment_tx_hash gia associata a un altro evento cross', 'CROSS_TX_REPLAY', false, 409);
        throw error;
      }
    }

    let proof = existing.blockchain_proof;
    if (!proof) {
      const check = await verifier.verificaDonazione({ txHash: payload.paymentTxHash, walletMittente: payload.paymentWallet, importoMinimo: 100, destinatarioWallet: payload.destinationWallet, maxPosizioni: 100 });
      if (Number(check.importoEffettivo) !== payload.amountUsdc || Number(check.numeroPosizioni) !== payload.positionsExpected) throw makeError('Prova on-chain URANUS non coerente con evento firmato', 'CROSS_BLOCKCHAIN_PROOF_MISMATCH');
      proof = check.proof;
      existing = (await client.query(`UPDATE cross_entry_events SET status='BLOCKCHAIN_VERIFIED', blockchain_proof=$2::jsonb, updated_at=NOW(), last_error=NULL WHERE event_key=$1 RETURNING *`, [payload.eventKey, JSON.stringify(proof)])).rows[0];
    }

    if (!existing.registry_confirmed_at || existing.registry_tx_id == null) {
      try {
        const registry = await pharaohRegistry.registerCrossIncoming({
          event: existing,
          onSubmitted: async (registryTxHash) => {
            existing = (await client.query(
              `UPDATE cross_entry_events
                  SET registry_tx_hash=$2, registry_last_error=NULL, updated_at=NOW()
                WHERE event_key=$1 RETURNING *`,
              [payload.eventKey, registryTxHash]
            )).rows[0];
          }
        }, dependencies);
        existing = (await client.query(
          `UPDATE cross_entry_events
              SET registry_tx_hash=$2,
                  registry_tx_id=$3,
                  registry_block_number=$4,
                  registry_confirmed_at=COALESCE(registry_confirmed_at,NOW()),
                  registry_last_error=NULL,
                  updated_at=NOW()
            WHERE event_key=$1 RETURNING *`,
          [payload.eventKey, registry.txHash, registry.txId, registry.blockNumber]
        )).rows[0];
      } catch (error) {
        await client.query(
          `UPDATE cross_entry_events SET registry_last_error=$2, updated_at=NOW() WHERE event_key=$1`,
          [payload.eventKey, String(error?.message || error || 'PharaohRegistry cross entry error').slice(0,1000)]
        ).catch(() => null);
        throw error;
      }
    }

    await client.query('BEGIN'); inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['PHARAOH:ENTRATA:POSIZIONAMENTO']);
    const duplicateTx = await client.query('SELECT id FROM donazioni WHERE LOWER(tx_hash)=$1 LIMIT 1', [payload.paymentTxHash]);
    if (duplicateTx.rows.length) throw makeError('Transazione cross gia consumata in donazioni', 'CROSS_TX_REPLAY', false, 409);
    const duplicateEvent = await client.query('SELECT id FROM donazioni WHERE source_platform=$1 AND source_event_key=$2 LIMIT 1', [SOURCE, payload.eventKey]);
    if (duplicateEvent.rows.length) throw makeError('Evento cross gia consumato in donazioni', 'CROSS_EVENT_REPLAY', false, 409);

    const name = payload.beneficiaryName || `${payload.beneficiaryWallet.substring(0,8)}...`;
    if (!await db.getAccount(payload.beneficiaryWallet, client)) await db.createAccount({ wallet: payload.beneficiaryWallet, nome: name, tipo: 'PRIMARIO' }, client);
    const positions = []; const completedTables = [];
    for (let i=0; i<payload.positionsExpected; i+=1) {
      const turno = await db.getTurnoCorrente('ENTRATA', 0, client); if (!turno) throw makeError('Nessun turno Entrata attivo', 'CROSS_ENTRY_TURN_NOT_FOUND');
      const tavola = await tableManager.getTavolaPercorsoAttiva(0, turno.numero_turno, client); if (!tavola) throw makeError('Nessuna tavola Entrata aperta', 'CROSS_ENTRY_TABLE_NOT_FOUND');
      const placement = await tableManager.posizionaDonatore({ tavolaId: tavola.id, tavolaNumero: tavola.numero, livello: 0, wallet: payload.beneficiaryWallet, nome: name, tipo: 'DONATORE', donoImporto: 100, turno: turno.numero_turno, sdoppiabile: true, client });
      await db.incrementSacerdotiEntrati(turno.id, client);
      positions.push({ tavola: { id: tavola.id, numero: tavola.numero, casella: placement.casellaOccupata, completa: placement.tavolaCompleta }, tavolaPersonale: placement.tavolaSdoppiamento ? { numero: placement.tavolaSdoppiamento.numero } : null });
      if (placement.tavolaCompleta) {
        const eredeWallet = tavola.faraone_wallet; const eredeAccount = await db.getAccount(eredeWallet, client); const nomeErede = eredeAccount?.nome || String(eredeWallet).substring(0,10); const isFondo = eredeAccount?.tipo === 'FONDO'; const doniRicevuti = rules.IMPORTI.DONO_ENTRATA * 6; const batchContinues = i < payload.positionsExpected - 1; const postKey = `${payload.paymentTxHash}:USCITA_ENTRATA:TAVOLA:${tavola.id}`;
        await db.createPostCommitOperation({ eventKey: postKey, operationType: 'USCITA_ENTRATA_POST_COMMIT', txHash: payload.paymentTxHash, sourceTavolaId: tavola.id, sourceTavolaNumero: tavola.numero, turnoId: turno.id, turnoNumero: turno.numero_turno, wallet: eredeWallet, payload: { nomeErede, isFondo, doniRicevuti, turnoEntrataAvviatoNelBatch: batchContinues } }, client);
        if (batchContinues) await require('./donation-flow-manager').avviaNuovoTurnoEntrata(turno, client);
        completedTables.push({ turno, tavola, eredeWallet, nomeErede, isFondo, doniRicevuti, turnoEntrataAvviatoNelBatch: batchContinues });
      }
    }
    await db.createDonazione({ donorWallet: payload.paymentWallet, importo: payload.amountUsdc, txHash: payload.paymentTxHash, tipo: 'DONO', destinatarioWallet: payload.destinationWallet, beneficiaryWallet: payload.beneficiaryWallet, sourcePlatform: SOURCE, sourceEventKey: payload.eventKey, positionsCreated: payload.positionsExpected, tavolaId: positions[0]?.tavola?.id || null, livello: 0, turno: null, blockchainProof: proof }, client);
    const result = { success: true, sourcePlatform: SOURCE, sourceEventKey: payload.eventKey, paymentWallet: payload.paymentWallet, beneficiaryWallet: payload.beneficiaryWallet, amountUsdc: payload.amountUsdc, numeroPosizioni: payload.positionsExpected, paymentTxHash: payload.paymentTxHash, positions };
    await client.query(`UPDATE cross_entry_events SET status='POSITION_ASSIGNED', position_result=$2::jsonb, completed_at=NOW(), updated_at=NOW(), last_error=NULL WHERE event_key=$1`, [payload.eventKey, JSON.stringify(result)]);
    await client.query('COMMIT'); inTx = false;
    const postCommit = []; for (const completed of completedTables) postCommit.push(await processCompletedEntryTable({ completed, txHash: payload.paymentTxHash, client }));
    return { success: true, event: { ...payload, status: 'POSITION_ASSIGNED' }, result: { ...result, postCommit } };
  } catch (error) {
    flowError = error; if (inTx) try { await client.query('ROLLBACK'); } catch (_) {}
    await client.query(`UPDATE cross_entry_events SET last_error=$2, updated_at=NOW(), status=CASE WHEN status='POSITION_ASSIGNED' THEN status ELSE 'FAILED' END WHERE event_key=$1`, [payload.eventKey, String(error.message).slice(0,1000)]).catch(()=>null);
    throw error;
  } finally {
    if (locked) try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); } catch (e) { if (!flowError) throw e; }
    client.release();
  }
}

module.exports = { SOURCE, normalizePayload, assertTreasuries, processUranusDonation, _makeError: makeError };
