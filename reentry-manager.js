'use strict';

/**
 * PHARAOH - Re-entry Manager
 *
 * Ogni rientro THOT/ISIDE e una NUOVA radice autonoma del percorso ENTRATA:
 * - stesso wallet Ethereum reale del ricevente;
 * - account_id distinto;
 * - ticket ordinario distinto;
 * - sigla radice = ticket;
 * - tavola personale/sdoppiamento legata a quella specifica radice.
 *
 * L'account secondario che ha generato il rientro resta soltanto come provenienza audit.
 */

const db = require('./db-manager');
const tableManager = require('./table-manager');
const rules = require('./rules-engine');

function normalizeWallet(wallet) {
  const w = String(wallet || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(w)) throw new Error(`Wallet rientro non valido: ${wallet}`);
  return w;
}

async function materializzaRientriEntrata({
  source,
  eventKey,
  wallet,
  nome,
  sourceAccountId,
  sourceAccountSigla,
  count,
  client
}) {
  if (!client) throw new Error('Client transazionale obbligatorio per i rientri Entrata');
  const sourceName = String(source || '').trim().toUpperCase();
  if (!['THOT_REENTRY', 'ISIDE_REENTRY'].includes(sourceName)) {
    throw new Error(`Sorgente rientro non valida: ${source}`);
  }
  const event = String(eventKey || '').trim();
  if (!event) throw new Error('eventKey rientro obbligatoria');
  const w = normalizeWallet(wallet);
  const expected = Number(count);
  if (!Number.isInteger(expected) || expected < 1) throw new Error('Numero rientri non valido');

  const sourceAccount = await db.getAccountByIdentity({
    accountId: sourceAccountId,
    wallet: w,
    sigla: sourceAccountSigla || null
  }, client);
  if (!sourceAccount || !['PERPETUO', 'GEMELLO'].includes(sourceAccount.tipo)) {
    throw new Error(`${sourceName}: identita Secondario sorgente mancante o incoerente`);
  }

  const positions = [];
  for (let index = 1; index <= expected; index += 1) {
    const accountKey = `${sourceName}:${event}:ROOT:${index}`;
    let root = await db.getAccountByKey(accountKey, client);
    if (!root) {
      root = await db.createAccount({
        wallet: w,
        nome: nome || sourceAccount.nome || w.substring(0, 10),
        tipo: 'PRIMARIO',
        sigla: null,
        parentWallet: null,
        accountKey,
        parentAccountId: null,
        rootAccountId: null,
        sourceAccountId: sourceAccount.id,
        sourceEventKey: event,
        originKind: sourceName
      }, client);
    }

    if (String(root.wallet).toLowerCase() !== w || root.tipo !== 'PRIMARIO') {
      throw new Error(`${sourceName}: radice rientro ${index} incoerente`);
    }

    root = await db.assignTicketToAccountId(root.id, client);
    const sigla = String(root.ticket_number);
    if (!sigla || sigla === 'null' || sigla === 'undefined') {
      throw new Error(`${sourceName}: ticket non assegnato alla radice ${index}`);
    }
    if (root.sigla !== sigla || Number(root.root_account_id) !== Number(root.id)) {
      root = await db.updateAccountIdentity(root.id, {
        sigla,
        rootAccountId: root.id
      }, client);
    }

    const turnoEntrata = await db.getTurnoCorrente('ENTRATA', 0, client);
    if (!turnoEntrata) throw new Error(`${sourceName}: nessun turno Entrata attivo`);
    const tavola = await tableManager.getTavolaPercorsoAttiva(0, turnoEntrata.numero_turno, client);
    if (!tavola) throw new Error(`${sourceName}: nessuna tavola Entrata aperta`);

    const placement = await tableManager.posizionaDonatore({
      tavolaId: tavola.id,
      tavolaNumero: tavola.numero,
      livello: 0,
      wallet: w,
      nome: root.nome || nome || w.substring(0, 10),
      tipo: 'DONATORE',
      donoImporto: rules.IMPORTI.DONO_ENTRATA,
      turno: turnoEntrata.numero_turno,
      sdoppiabile: true,
      accountId: root.id,
      accountSigla: root.sigla,
      client
    });
    await db.incrementSacerdotiEntrati(turnoEntrata.id, client);

    const proof = {
      index,
      wallet: w,
      accountId: Number(root.id),
      ticketNumber: Number(root.ticket_number),
      sigla: root.sigla,
      sourceAccountId: Number(sourceAccount.id),
      sourceAccountSigla: sourceAccount.sigla || null,
      amountUsdc: rules.IMPORTI.DONO_ENTRATA,
      turno: Number(turnoEntrata.numero_turno),
      tavolaId: Number(tavola.id),
      tavolaNumero: Number(tavola.numero),
      casella: Number(placement.casellaOccupata),
      completedTable: Boolean(placement.tavolaCompleta),
      personalTableId: placement.tavolaSdoppiamento?.id ? Number(placement.tavolaSdoppiamento.id) : null,
      personalTableNumber: placement.tavolaSdoppiamento?.numero == null ? null : Number(placement.tavolaSdoppiamento.numero)
    };
    positions.push(proof);

    if (placement.tavolaCompleta) {
      const eredeAccount = tavola.faraone_account_id
        ? await db.getAccountById(tavola.faraone_account_id, client)
        : await db.getAccount(tavola.faraone_wallet, client);
      const eredeWallet = String(tavola.faraone_wallet || '').toLowerCase();
      const nomeErede = eredeAccount?.nome || eredeWallet.substring(0, 10);
      const isFondo = eredeAccount?.tipo === 'FONDO';
      const batchContinues = index < expected;
      const postKey = `${event}:REENTRY:${index}:USCITA_ENTRATA:TAVOLA:${tavola.id}`;

      await db.createPostCommitOperation({
        eventKey: postKey,
        operationType: 'USCITA_ENTRATA_POST_COMMIT',
        txHash: null,
        sourceTavolaId: tavola.id,
        sourceTavolaNumero: tavola.numero,
        turnoId: turnoEntrata.id,
        turnoNumero: turnoEntrata.numero_turno,
        wallet: eredeWallet,
        payload: {
          nomeErede,
          isFondo,
          doniRicevuti: rules.IMPORTI.DONO_ENTRATA * 6,
          turnoEntrataAvviatoNelBatch: batchContinues,
          eredeAccountId: eredeAccount?.id || tavola.faraone_account_id || null,
          eredeAccountSigla: eredeAccount?.sigla || tavola.faraone_sigla || null,
          source: sourceName,
          sourceEventKey: event
        }
      }, client);

      if (batchContinues) {
        // Require lazy to avoid a circular dependency at module load time.
        const donationFlow = require('./donation-flow-manager');
        await donationFlow.avviaNuovoTurnoEntrata(turnoEntrata, client);
      }
    }
  }

  if (positions.length !== expected) throw new Error(`${sourceName}: conteggio rientri incompleto`);
  if (new Set(positions.map(p => p.accountId)).size !== expected) {
    throw new Error(`${sourceName}: i rientri non hanno account autonomi distinti`);
  }
  if (new Set(positions.map(p => p.ticketNumber)).size !== expected) {
    throw new Error(`${sourceName}: i rientri non hanno ticket distinti`);
  }
  if (positions.some(p => p.wallet !== w || p.accountId === Number(sourceAccount.id))) {
    throw new Error(`${sourceName}: attribuzione wallet/account rientri non valida`);
  }

  return positions;
}

module.exports = { materializzaRientriEntrata };
