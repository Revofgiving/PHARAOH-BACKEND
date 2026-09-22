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

async function processCompletedEntryTable({ completed, txHash, client }) {
  const donationFlow = require('./donation-flow-manager');
  const { turno, tavola, eredeWallet, nomeErede, isFondo, doniRicevuti, eredeAccountId = null, eredeAccountSigla = null } = completed;
  const eventKey = `${txHash}:USCITA_ENTRATA:TAVOLA:${tavola.id}`;
  let transactionBegun = false;
  try {
    await client.query('BEGIN');
    transactionBegun = true;
    let op = await db.getPostCommitOperationByEventKey(eventKey, client);
    if (op?.status === 'COMPLETED') {
      await client.query('COMMIT');
      return { tavola: tavola.numero, status: 'ALREADY_COMPLETED' };
    }
    const claimed = await db.markPostCommitOperationInProgress(eventKey, client);
    if (!claimed) {
      op = await db.getPostCommitOperationByEventKey(eventKey, client);
      if (op?.status === 'COMPLETED') {
        await client.query('COMMIT');
        return { tavola: tavola.numero, status: 'ALREADY_COMPLETED' };
      }
      if (op?.status === 'IN_PROGRESS') throw makeError(`Operazione post-COMMIT gia in esecuzione: ${eventKey}`, 'ENTRY_POST_COMMIT_BUSY', true);
      throw makeError(`Impossibile acquisire operazione post-COMMIT: ${eventKey}`, 'ENTRY_POST_COMMIT_CLAIM_FAILED', true);
    }

    const trattenuta = rules.IMPORTI.TRATTENUTA_FONDO_ENTRATA;
    const netto = doniRicevuti - trattenuta;
    await db.registraAvanzamento({
      wallet: eredeWallet,
      accountId: eredeAccountId,
      accountSigla: eredeAccountSigla,
      tipoAccount: isFondo ? 'FONDO' : 'SACERDOTE',
      daLivello: 0,
      aLivello: 1,
      turno: turno.numero_turno,
      doniRicevuti,
      doniTrattenuti: trattenuta,
      netto,
      evento: 'USCITA_ENTRATA',
      eventKey
    }, client);

    await donationFlow.posizionaSacerdoteInPharaoh(
      eredeWallet,
      nomeErede,
      client,
      eredeAccountId ? { accountId: eredeAccountId, accountSigla: eredeAccountSigla } : null
    );
    const next = await donationFlow.avviaNuovoTurnoEntrata(turno, client);
    await db.markPostCommitOperationCompleted(eventKey, client);
    await client.query('COMMIT');
    transactionBegun = false;

    return {
      tavola: tavola.numero,
      status: 'COMPLETED',
      rollover: next?.rollover ? {
        amountUsdc: 100,
        targetTable: next.rollover.audit?.target_tavola_numero || null,
        targetSlot: next.rollover.audit?.target_casella || next.rollover.placement?.casellaOccupata || null
      } : null
    };
  } catch (error) {
    if (transactionBegun) { try { await client.query('ROLLBACK'); } catch (_) {} }
    await db.markPostCommitOperationFailed(eventKey, error?.message || String(error));
    return { tavola: tavola.numero, status: 'POST_COMMIT_PENDING', error: error?.message || String(error) };
  }
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
    await client.query('BEGIN'); transactionBegun = true; await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['PHARAOH:ENTRATA:POSIZIONAMENTO']);
    const nomeEffettivo = (beneficiaryName || '').trim() || `${beneficiary.substring(0, 8)}...`; let account = await db.getAccount(beneficiary, client); if (!account) account = await db.createAccount({ wallet: beneficiary, nome: nomeEffettivo, tipo: 'PRIMARIO' }, client);
    const turno = await db.getTurnoCorrente('ENTRATA', 0, client); if (!turno) throw makeError('Nessun turno attivo al livello di entrata', 'ENTRY_TURN_NOT_FOUND'); const tavola = await tableManager.getTavolaPercorsoAttiva(0, turno.numero_turno, client); if (!tavola) throw makeError('Nessuna tavola aperta al livello di entrata', 'ENTRY_TABLE_NOT_FOUND');
    const placement = await tableManager.posizionaDonatore({ tavolaId: tavola.id, tavolaNumero: tavola.numero, livello: 0, wallet: beneficiary, nome: nomeEffettivo, tipo: 'DONATORE', donoImporto: 100, turno: turno.numero_turno, sdoppiabile: true, accountId: account.id, accountSigla: account.sigla || null, client }); await db.incrementSacerdotiEntrati(turno.id, client);
    if (placement.tavolaCompleta) { const eredeWallet = tavola.faraone_wallet; const eredeAccount = tavola.faraone_account_id ? await db.getAccountByIdentity({ accountId: tavola.faraone_account_id, wallet: eredeWallet, sigla: tavola.faraone_sigla || null }, client) : await db.getAccount(eredeWallet, client); if (!eredeAccount) throw makeError(`Identita erede Entrata non risolta per tavola ${tavola.id}`, 'ENTRY_HEIR_IDENTITY_MISSING'); const nomeErede = eredeAccount.nome || eredeWallet.substring(0, 10); const isFondo = eredeAccount.tipo === 'FONDO'; const doniRicevuti = rules.IMPORTI.DONO_ENTRATA * 6; const postCommitEventKey = `${canonicalTx}:USCITA_ENTRATA:TAVOLA:${tavola.id}`; await db.createPostCommitOperation({ eventKey: postCommitEventKey, operationType: 'USCITA_ENTRATA_POST_COMMIT', txHash: canonicalTx, sourceTavolaId: tavola.id, sourceTavolaNumero: tavola.numero, turnoId: turno.id, turnoNumero: turno.numero_turno, wallet: eredeWallet, payload: { nomeErede, isFondo, doniRicevuti, turnoEntrataAvviatoNelBatch: false, eredeAccountId: eredeAccount.id, eredeAccountSigla: eredeAccount.sigla || null } }, client); completedTable = { turno, tavola, eredeWallet, nomeErede, isFondo, doniRicevuti, eredeAccountId: eredeAccount.id, eredeAccountSigla: eredeAccount.sigla || null }; }
    await db.createDonazione({ donorWallet: payer, importo: 100, txHash: canonicalTx, tipo: 'DONO', destinatarioWallet: treasury, beneficiaryWallet: beneficiary, sourcePlatform: source, sourceEventKey: eventKey, positionsCreated: 1, tavolaId: tavola.id, livello: 0, turno: turno.numero_turno, blockchainProof }, client);
    const coreResult = { success: true, sourcePlatform: source, sourceEventKey: eventKey, paymentWallet: payer, beneficiaryWallet: beneficiary, numeroPosizioni: 1, importoTotale: 100, pharaohTxHash: canonicalTx, posizioni: [{ tavola: { numero: tavola.numero, casella: placement.casellaOccupata, completa: placement.tavolaCompleta }, tavolaPersonale: placement.tavolaSdoppiamento ? { numero: placement.tavolaSdoppiamento.numero } : null }] };
    if (typeof atomicComplete === 'function') await atomicComplete(client, coreResult); await client.query('COMMIT'); transactionBegun = false;
    const trasferimentiSistema = []; if (completedTable) trasferimentiSistema.push(await processCompletedEntryTable({ completed: completedTable, txHash: canonicalTx, client })); return { ...coreResult, trasferimentiSistema };
  } catch (error) { flowError = error; if (transactionBegun) { try { await client.query('ROLLBACK'); } catch (_) {} } throw error; }
  finally { let unlockError = null; if (lockAcquired) { try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); } catch (error) { unlockError = error; } } client.release(); if (unlockError && !flowError) throw unlockError; }
}
module.exports = { assignOneVerifiedEntry, _processCompletedEntryTable: processCompletedEntryTable, _makeError: makeError };
