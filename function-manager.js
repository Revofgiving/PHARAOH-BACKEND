/**
 * ⚙️ PHARAOH - Function Manager
 *
 * Gestisce il rilascio e posizionamento delle 4 Funzioni:
 * - 3 SIMBIONTI (1.500): non duplicabili (reg.7), velocizzano il percorso
 * - 1 PERPETUO (500): continuazione dell'account, duplicabile (reg.8)
 * - 1 GEMELLO (500): nuovo account, ticket prenotato (reg.9, reg.10)
 * - ALLOCAZIONE RHA 500: 300 ROG (150 dual HUMAN+PILETTA) + 200 URANUS (10 dual CASSA URANUS+HUMAN)
 *
 * Le Funzioni vengono rilasciate all'uscita dal livello 3 (Rha) (reg.3)
 * e inserite nel turno successivo (reg.6).
 */

const db = require('./db-manager');
const rules = require('./rules-engine');
const accountManager = require('./account-manager');
const tableManager = require('./table-manager');
const reentryManager = require('./reentry-manager');
// ========================================
// HELPERS PRENOTAZIONI FUNZIONI
// ========================================

function buildEventKey({ funzioneId, turnoDestinazione, livelloDestinazione, bloccoDestinazione, tavolaRelativa, casella }) {
  return [
    'FUNZIONE',
    funzioneId,
    `T${turnoDestinazione}`,
    `L${livelloDestinazione}`,
    `B${bloccoDestinazione ?? 0}`,
    `TR${tavolaRelativa}`,
    `C${casella}`
  ].join('_');
}

function parseProgressivoDaSigla(tipo, sigla) {
  if (tipo === 'SIMBIONTE') {
    const match = String(sigla || '').match(/SIM(\d+)_/);
    if (!match) throw new Error(`Sigla Simbionte non valida: ${sigla}`);
    return Number(match[1]);
  }
  if (tipo === 'PERPETUO') {
    const match = String(sigla || '').match(/\.(\d+)$/);
    if (!match) throw new Error(`Sigla Perpetuo non valida: ${sigla}`);
    return Number(match[1]);
  }
  if (tipo === 'GEMELLO') {
    const match = String(sigla || '').match(/^(\d+)-/);
    if (!match) throw new Error(`Sigla Gemello non valida: ${sigla}`);
    return Number(match[1]);
  }
  throw new Error(`Tipo funzione non valido: ${tipo}`);
}

function buildPrenotazioneSpec(funzione, turnoOrigine, turnoDestinazione) {
  const base = {
    funzioneId: funzione.id,
    tipoFunzione: funzione.tipo,
    accountOrigineWallet: funzione.account_origine_wallet,
    accountDestinazioneWallet: funzione.account_generato_wallet || null,
    accountOrigineId: funzione.account_origine_id || null,
    accountDestinazioneId: funzione.account_generato_id || null,
    turnoOrigine,
    turnoDestinazione,
    livelloDestinazione: null,
    bloccoDestinazione: 1,
    tavolaRelativa: null,
    casella: null,
    ticketNumber: funzione.ticket_prenotato ?? null
  };

  if (funzione.tipo === 'SIMBIONTE') {
    const progressivo = parseProgressivoDaSigla('SIMBIONTE', funzione.sigla);
    const indicePosizione = ((progressivo - 1) % 3) + 1;
    if (indicePosizione === 1) {
      return { ...base, livelloDestinazione: 2, tavolaRelativa: 1, casella: 1 };
    }
    if (indicePosizione === 2) {
      return { ...base, livelloDestinazione: 2, tavolaRelativa: 1, casella: 2 };
    }
    if (indicePosizione === 3) {
      return { ...base, livelloDestinazione: 2, tavolaRelativa: 2, casella: 1 };
    }
    throw new Error(`Progressivo Simbionte non valido: ${progressivo}`);
  }

  if (funzione.tipo === 'PERPETUO') {
    if (!funzione.account_generato_wallet) {
      throw new Error(`Wallet Perpetuo mancante per funzione ${funzione.id}`);
    }
    return { ...base, livelloDestinazione: 2, tavolaRelativa: 2, casella: 2 };
  }

  if (funzione.tipo === 'GEMELLO') {
    if (!funzione.account_generato_wallet) {
      throw new Error(`Wallet Gemello mancante per funzione ${funzione.id}`);
    }
    const ticket = Number(funzione.ticket_prenotato);
    if (!Number.isInteger(ticket) || ticket < 1) {
      throw new Error(`Ticket Gemello mancante o non valido per funzione ${funzione.id}`);
    }
    return { ...base, livelloDestinazione: 3, tavolaRelativa: 7, casella: 2 };
  }

  throw new Error(`Tipo funzione non valido: ${funzione.tipo}`);
}

async function assicuratiIdentita(funzione, client = null) {
  const progressivo = parseProgressivoDaSigla(funzione.tipo, funzione.sigla);
  const walletProprietario = funzione.tipo === 'SIMBIONTE'
    ? funzione.account_origine_wallet
    : funzione.account_generato_wallet;

  if (!walletProprietario) {
    throw new Error(`Wallet proprietario mancante per funzione ${funzione.id}`);
  }

  return await db.createIdentitaFunzione({
    identityKey: `FUNZIONE_${funzione.id}`,
    walletProprietario,
    accountOrigineWallet: funzione.account_origine_wallet,
    tipo: funzione.tipo,
    sigla: funzione.sigla,
    progressivo
  }, client);
}

async function assicuratiPrenotazione(funzione, turnoOrigine, turnoDestinazione, client = null) {
  const spec = buildPrenotazioneSpec(funzione, turnoOrigine, turnoDestinazione);
  const eventKey = buildEventKey({
    funzioneId: funzione.id,
    turnoDestinazione: spec.turnoDestinazione,
    livelloDestinazione: spec.livelloDestinazione,
    bloccoDestinazione: spec.bloccoDestinazione,
    tavolaRelativa: spec.tavolaRelativa,
    casella: spec.casella
  });

  return await db.createPrenotazioneFunzione({
    eventKey,
    funzioneId: spec.funzioneId,
    tipoFunzione: spec.tipoFunzione,
    accountOrigineWallet: spec.accountOrigineWallet,
    accountDestinazioneWallet: spec.accountDestinazioneWallet,
    accountOrigineId: spec.accountOrigineId,
    accountDestinazioneId: spec.accountDestinazioneId,
    turnoOrigine: spec.turnoOrigine,
    turnoDestinazione: spec.turnoDestinazione,
    livelloDestinazione: spec.livelloDestinazione,
    bloccoDestinazione: spec.bloccoDestinazione,
    tavolaRelativa: spec.tavolaRelativa,
    tavolaNumero: null,
    casella: spec.casella,
    ticketNumber: spec.ticketNumber
  }, client);
}

// ========================================
// RILASCIO FUNZIONI (all'uscita L3)
// ========================================

/**
 * Rilascia tutte le Funzioni per un Faraone che esce dal livello 3.
 *
 * @param {Object} params
 * @param {string} params.faraoneWallet - Wallet del Faraone uscente
 * @param {string} params.faraoneSigla - Sigla (es. 'A', '1', '1-A')
 * @param {string} params.tipoAccount - PRIMARIO | PERPETUO | GEMELLO
 * @param {number} params.turnoCorrente - Turno di uscita
 * @returns {Object} Dettaglio funzioni rilasciate
 */
async function rilasciaFunzioniL3({ faraoneWallet, faraoneSigla, tipoAccount, turnoCorrente, faraoneAccountId = null }, client = null) {
  const rilasci = rules.regolaRilasciFunzioni(tipoAccount);
  const turnoEntrata = turnoCorrente + 1;  // reg.6: entrano al turno successivo
  const walletNormalizzato = faraoneWallet.toLowerCase();
  const sourceAccount = await db.getAccountByIdentity({
    accountId: faraoneAccountId,
    wallet: walletNormalizzato,
    sigla: faraoneSigla || null,
    tipo: tipoAccount === 'SECONDARIO' ? null : tipoAccount
  }, client) || (!faraoneAccountId ? await db.getAccount(walletNormalizzato, client) : null);
  if (!sourceAccount) throw new Error('Identita account RHA non risolta');

  console.log(`\n⚙️ RILASCIO FUNZIONI L3 per ${faraoneSigla} (${tipoAccount})`);
  console.log(`   Turno rilascio: ${turnoCorrente}`);
  console.log(`   Turno entrata: ${turnoEntrata}`);

  const risultato = {
    faraoneWallet,
    faraoneSigla,
    tipoAccount,
    turnoRilascio: turnoCorrente,
    turnoEntrata,
    simbionti: [],
    perpetuo: null,
    gemello: null,
    rhaAllocation: null
  };
  const funzioniEsistenti = (await db.getFunzioniByOrigine(faraoneWallet, client, sourceAccount.id))
    .filter((f) => Number(f.turno_rilascio) === Number(turnoCorrente));

  // 1. SIMBIONTI (3 x 500 = 1.500)
  if (rilasci.rilasciaSimbionti) {
    const shouldManageTx = !client;
    const pg = shouldManageTx ? require('./pg-connection-manager') : null;
    const dbClient = shouldManageTx ? await pg.getClient() : client;
    const simbiontiRilasciati = [];
    try {
      if (shouldManageTx) {
        await dbClient.query('BEGIN');
      }
      await dbClient.query(
        'SELECT pg_advisory_xact_lock(hashtext($1)) AS locked',
        [`SIMBIONTE:${sourceAccount.id}`]
      );
      const existingRes = await dbClient.query(
        `SELECT * FROM funzioni
         WHERE account_origine_id = $1
           AND turno_rilascio = $2
         FOR UPDATE`,
        [sourceAccount.id, turnoCorrente]
      );
      const existingFunzioni = existingRes.rows || [];
      const existingSimbionti = existingFunzioni.filter((f) => f.tipo === 'SIMBIONTE');
      const existingMax = existingSimbionti.reduce((max, f) => {
        try {
          return Math.max(max, parseProgressivoDaSigla('SIMBIONTE', f.sigla));
        } catch {
          return max;
        }
      }, 0);

      const maxRow = await dbClient.query(
        `SELECT COALESCE(MAX(progressivo), 0) AS max_prog
         FROM identita_funzioni
         WHERE wallet_proprietario = $1
           AND tipo = 'SIMBIONTE'`,
        [walletNormalizzato]
      );
      const maxProgressivoDb = Number(maxRow.rows[0]?.max_prog || 0);
      if (existingSimbionti.length >= 3) {
        const ordinati = [...existingSimbionti].sort((a, b) => {
          return parseProgressivoDaSigla('SIMBIONTE', a.sigla)
            - parseProgressivoDaSigla('SIMBIONTE', b.sigla);
        });
        simbiontiRilasciati.push(...ordinati.slice(0, 3));
      } else {
        const baseProgressivo = Math.max(existingMax, maxProgressivoDb);
        const mancanti = 3 - existingSimbionti.length;
        for (let offset = 1; offset <= mancanti; offset++) {
          const progressivo = baseProgressivo + offset;
          const sigla = `SIM${progressivo}_${faraoneSigla}`;
          let simbionte = existingSimbionti.find((f) => f.sigla === sigla);
          if (!simbionte) {
            const inserted = await dbClient.query(
              `INSERT INTO funzioni (
                tipo, account_origine_wallet, account_generato_wallet,
                account_origine_id, account_generato_id, sigla, ticket_prenotato,
                importo, turno_rilascio, turno_entrata, tavola_posizionamento, posizione_in_tavola
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
              RETURNING *`,
              [
                'SIMBIONTE', walletNormalizzato, null, sourceAccount.id, null, sigla, null,
                rules.IMPORTI.DONO_PHARAOH, turnoCorrente, turnoEntrata, null, null
              ]
            );
            simbionte = inserted.rows[0];
          }
          simbiontiRilasciati.push(simbionte);
        }
        if (existingSimbionti.length > 0) {
          simbiontiRilasciati.push(...existingSimbionti);
        }
      }
      if (shouldManageTx) {
        await dbClient.query('COMMIT');
      }
    } catch (err) {
      if (shouldManageTx) {
        try {
          await dbClient.query('ROLLBACK');
        } catch (_) {}
      }
      throw err;
    } finally {
      if (shouldManageTx) {
        dbClient.release();
      }
    }

    for (const simbionte of simbiontiRilasciati) {
      await assicuratiIdentita(simbionte, client);
      await assicuratiPrenotazione(simbionte, turnoCorrente, turnoEntrata, client);
      risultato.simbionti.push(simbionte);
    }
    console.log(`   ✅ 3 Simbionti rilasciati (1.500)`);
  }

  // 2. PERPETUO (500) - reg.8
  if (rilasci.rilasciaPerpetuo) {
    let funzione = funzioniEsistenti.find((f) => f.tipo === 'PERPETUO');
    let perpetuoData = null;
    if (!funzione) {
      const numPerpetui = await accountManager.countPerpetui(faraoneWallet, client, sourceAccount.id);
      const nuovoNumero = numPerpetui + 1;
      perpetuoData = await accountManager.creaPerpetuo(faraoneWallet, faraoneSigla, nuovoNumero, client, sourceAccount.id);

      funzione = await db.createFunzione({
        tipo: 'PERPETUO',
        accountOrigineWallet: faraoneWallet,
        accountGeneratoWallet: perpetuoData.wallet,
        accountOrigineId: sourceAccount.id,
        accountGeneratoId: perpetuoData.account.id,
        sigla: perpetuoData.sigla,
        ticketPrenotato: null,
        importo: rules.IMPORTI.DONO_PHARAOH,
        turnoRilascio: turnoCorrente,
        turnoEntrata,
        tavolaPosizionamento: null,
        posizioneInTavola: null
      }, client);
    }

    await assicuratiIdentita(funzione, client);
    await assicuratiPrenotazione(funzione, turnoCorrente, turnoEntrata, client);
    risultato.perpetuo = { funzione, account: perpetuoData };
    console.log(`   ✅ Perpetuo rilasciato: ${funzione.sigla} (500)`);
  }

  // 3. GEMELLO (500) - reg.9, reg.10, reg.11
  if (rilasci.rilasciaGemello) {
    let funzione = funzioniEsistenti.find((f) => f.tipo === 'GEMELLO');
    let gemelloData = null;
    if (!funzione) {
      const numGemelli = await accountManager.countGemelli(faraoneWallet, client, sourceAccount.id);
      const nuovoNumero = numGemelli + 1;
      gemelloData = await accountManager.creaGemello(faraoneWallet, faraoneSigla, nuovoNumero, client, sourceAccount.id);

      funzione = await db.createFunzione({
        tipo: 'GEMELLO',
        accountOrigineWallet: faraoneWallet,
        accountGeneratoWallet: gemelloData.wallet,
        accountOrigineId: sourceAccount.id,
        accountGeneratoId: gemelloData.account.id,
        sigla: gemelloData.sigla,
        ticketPrenotato: gemelloData.ticketPrenotato,
        importo: rules.IMPORTI.DONO_PHARAOH,
        turnoRilascio: turnoCorrente,
        turnoEntrata,
        tavolaPosizionamento: null,
        posizioneInTavola: null
      }, client);
    }

    await assicuratiIdentita(funzione, client);
    await assicuratiPrenotazione(funzione, turnoCorrente, turnoEntrata, client);
    risultato.gemello = { funzione, account: gemelloData };
    console.log(`   ✅ Gemello rilasciato: ${funzione.sigla} (ticket prenotato: ${funzione.ticket_prenotato}) (500)`);
  } else {
    console.log(`   ⛔ Gemello NON rilasciato (reg.11: Perpetuo non rilascia Gemello)`);
  }

  // 4. ALLOCAZIONE RHA 500 — decisione aggiornata 3 settembre 2026.
  // Ogni uscita RHA, primaria o secondaria, destina l'intera quota da 500 ai due movimenti cross.
  // Non esistono quote omaggi, Doni al Volo o Doni a Credito.
  risultato.rhaAllocation = {
    rogUsdc: rules.IMPORTI.RHA_ROG_OUTBOUND,
    rogDualPositions: rules.IMPORTI.RHA_ROG_DUAL_POSITIONS,
    uranusUsdc: rules.IMPORTI.RHA_URANUS_OUTBOUND,
    uranusDualPositions: rules.IMPORTI.RHA_URANUS_DUAL_POSITIONS,
    repayable: false
  };
  console.log('   ✅ Quota RHA 500: 300 ROG / 150 dual + 200 URANUS / 10 dual, al ricevente RHA');

  console.log(`   🏦 Totale riserva cassa L3: ${rules.IMPORTI.TRATTENUTA_CASSA_L3}`);

  return risultato;
}

/**
 * Applica la regola THOT aggiornata (reg.13):
 * - 500 USDC restano in Cassa PHARAOH per PROGETTI_UMANITARI
 * - 500 USDC materializzano 5 rientri da 100 al livello Entrata
 *   intestati al ricevente THOT
 * - nessun Dono a Credito o Dono al Volo viene creato
 */
async function rilasciaFunzioniL4({ faraoneWallet, faraoneAccountId = null, faraoneSigla = null, turnoCorrente, eventKey, cassaWallet }, client = null) {
  const shouldManageTx = !client;
  const pg = shouldManageTx ? require('./pg-connection-manager') : null;
  const dbClient = shouldManageTx ? await pg.getClient() : client;
  const wallet = String(faraoneWallet || '').trim().toLowerCase();
  const event = String(eventKey || '').trim();
  const treasury = String(cassaWallet || '').trim().toLowerCase();
  if (!wallet || !event || !treasury) throw new Error('Dati obbligatori mancanti per allocazione THOT');

  try {
    if (shouldManageTx) await dbClient.query('BEGIN');
    await dbClient.query('SELECT pg_advisory_xact_lock(hashtext($1)) AS locked', [event]);
    await dbClient.query('SELECT pg_advisory_xact_lock(hashtext($1)) AS locked', ['PHARAOH:ENTRATA:POSIZIONAMENTO']);

    const account = await db.getAccountByIdentity({ accountId: faraoneAccountId, wallet, sigla: faraoneSigla || null }, dbClient);
    if (!account) throw new Error(`Identita account THOT non trovata: ${wallet}`);
    rules.validaAccountSecondario(account.tipo, 'Thot');

    const allocation = await db.createThotExitAllocation({
      eventKey: event,
      beneficiaryWallet: wallet,
      cassaWallet: treasury,
      sourceAccountId: account.id,
      sourceAccountSigla: account.sigla,
      turno: turnoCorrente,
      humanitarianUsdc: rules.IMPORTI.TRATTENUTA_PROGETTI_UMANITARI_L4,
      humanitarianDestination: rules.IMPORTI.DESTINAZIONE_PROGETTI_UMANITARI_L4,
      reentryUsdc: rules.IMPORTI.TRATTENUTA_RIENTRI_ENTRATA_L4,
      reentryUnitUsdc: rules.IMPORTI.DONO_ENTRATA,
      reentryPositionsExpected: rules.IMPORTI.NUM_RIENTRI_ENTRATA_L4
    }, dbClient);
    if (!allocation) throw new Error(`Allocazione THOT non persistita: ${event}`);

    const invariantOk =
      String(allocation.beneficiary_wallet).toLowerCase() === wallet &&
      String(allocation.cassa_wallet).toLowerCase() === treasury &&
      Number(allocation.source_account_id) === Number(account.id) &&
      String(allocation.source_account_sigla || '') === String(account.sigla || '') &&
      Number(allocation.turno) === Number(turnoCorrente) &&
      Number(allocation.humanitarian_reserved_usdc) === rules.IMPORTI.TRATTENUTA_PROGETTI_UMANITARI_L4 &&
      Number(allocation.reentry_positions_expected) === rules.IMPORTI.NUM_RIENTRI_ENTRATA_L4;
    if (!invariantOk) throw new Error(`THOT event gia legato a dati differenti: ${event}`);

    if (allocation.status === 'MATERIALIZED') {
      let positionResult = allocation.position_result || [];
      if (typeof positionResult === 'string') positionResult = JSON.parse(positionResult);
      if (Number(allocation.reentry_positions_created) !== rules.IMPORTI.NUM_RIENTRI_ENTRATA_L4) {
        throw new Error(`Allocazione THOT materializzata con conteggio incoerente: ${event}`);
      }
      if (shouldManageTx) await dbClient.query('COMMIT');
      return {
        eventKey: event,
        idempotent: true,
        humanitarian: { cassaWallet: treasury, amountUsdc: rules.IMPORTI.TRATTENUTA_PROGETTI_UMANITARI_L4, destination: rules.IMPORTI.DESTINAZIONE_PROGETTI_UMANITARI_L4 },
        reentries: { amountUsdc: rules.IMPORTI.TRATTENUTA_RIENTRI_ENTRATA_L4, positionsExpected: rules.IMPORTI.NUM_RIENTRI_ENTRATA_L4, positionsCreated: Number(allocation.reentry_positions_created), positions: positionResult }
      };
    }
    if (Number(allocation.reentry_positions_created || 0) !== 0) throw new Error(`Allocazione THOT parziale non riconciliata: ${event}`);

    const positions = await reentryManager.materializzaRientriEntrata({
      source: 'THOT_REENTRY', eventKey: event, wallet,
      nome: account.nome || wallet.substring(0, 10),
      sourceAccountId: account.id, sourceAccountSigla: account.sigla,
      count: rules.IMPORTI.NUM_RIENTRI_ENTRATA_L4, client: dbClient
    });
    const completed = await db.completeThotExitAllocation({ eventKey: event, positions }, dbClient);
    if (!completed || completed.status !== 'MATERIALIZED' || Number(completed.reentry_positions_created) !== positions.length) {
      throw new Error(`Allocazione THOT non finalizzata correttamente: ${event}`);
    }
    if (shouldManageTx) await dbClient.query('COMMIT');
    return {
      eventKey: event,
      idempotent: false,
      humanitarian: { cassaWallet: treasury, amountUsdc: rules.IMPORTI.TRATTENUTA_PROGETTI_UMANITARI_L4, destination: rules.IMPORTI.DESTINAZIONE_PROGETTI_UMANITARI_L4 },
      reentries: { amountUsdc: rules.IMPORTI.TRATTENUTA_RIENTRI_ENTRATA_L4, positionsExpected: positions.length, positionsCreated: positions.length, positions }
    };
  } catch (err) {
    if (shouldManageTx) { try { await dbClient.query('ROLLBACK'); } catch (_) {} }
    throw err;
  } finally { if (shouldManageTx) dbClient.release(); }
}

/**
 * Applica la regola ISIDE aggiornata (reg.14):
 * - 5.000 USDC materializzano 50 rientri da 100 al livello Entrata
 *   intestati al ricevente ISIDE
 * - 6.000 USDC diventano quota diretta aggiuntiva al ricevente
 * - 19.000 USDC restano netto base; payout unico ricevente = 25.000 USDC
 * - nessun Dono a Credito o Dono al Volo viene creato
 */
async function rilasciaFunzioniL5({ faraoneWallet, faraoneAccountId = null, faraoneSigla = null, turnoCorrente, eventKey, cassaWallet }, client = null) {
  const shouldManageTx = !client;
  const pg = shouldManageTx ? require('./pg-connection-manager') : null;
  const dbClient = shouldManageTx ? await pg.getClient() : client;
  const wallet = String(faraoneWallet || '').trim().toLowerCase();
  const event = String(eventKey || '').trim();
  const treasury = String(cassaWallet || '').trim().toLowerCase();
  if (!wallet || !event || !treasury) throw new Error('Dati obbligatori mancanti per allocazione ISIDE');

  try {
    if (shouldManageTx) await dbClient.query('BEGIN');
    await dbClient.query('SELECT pg_advisory_xact_lock(hashtext($1)) AS locked', [event]);
    await dbClient.query('SELECT pg_advisory_xact_lock(hashtext($1)) AS locked', ['PHARAOH:ENTRATA:POSIZIONAMENTO']);

    const account = await db.getAccountByIdentity({ accountId: faraoneAccountId, wallet, sigla: faraoneSigla || null }, dbClient);
    if (!account) throw new Error(`Identita account ISIDE non trovata: ${wallet}`);
    rules.validaAccountSecondario(account.tipo, 'Iside');

    const allocation = await db.createIsideExitAllocation({
      eventKey: event, beneficiaryWallet: wallet, cassaWallet: treasury,
      sourceAccountId: account.id, sourceAccountSigla: account.sigla,
      turno: turnoCorrente,
      totalReceivedUsdc: rules.IMPORTI.DONO_TOTALE_L5,
      baseNetUsdc: rules.IMPORTI.USCITA_L5_NETTO_BASE,
      receiverGiftUsdc: rules.IMPORTI.QUOTA_RICEVENTE_L5,
      receiverPayoutUsdc: rules.IMPORTI.USCITA_L5_PAYOUT_TOTALE,
      reentryUsdc: rules.IMPORTI.TRATTENUTA_RIENTRI_ENTRATA_L5,
      reentryUnitUsdc: rules.IMPORTI.DONO_ENTRATA,
      reentryPositionsExpected: rules.IMPORTI.NUM_RIENTRI_ENTRATA_L5
    }, dbClient);
    if (!allocation) throw new Error(`Allocazione ISIDE non persistita: ${event}`);

    const invariantOk =
      String(allocation.beneficiary_wallet).toLowerCase() === wallet &&
      String(allocation.cassa_wallet).toLowerCase() === treasury &&
      Number(allocation.source_account_id) === Number(account.id) &&
      String(allocation.source_account_sigla || '') === String(account.sigla || '') &&
      Number(allocation.receiver_payout_usdc) === rules.IMPORTI.USCITA_L5_PAYOUT_TOTALE &&
      Number(allocation.reentry_positions_expected) === rules.IMPORTI.NUM_RIENTRI_ENTRATA_L5;
    if (!invariantOk) throw new Error(`ISIDE event gia legato a dati differenti: ${event}`);

    const accounting = {
      cassaWallet: treasury,
      totalReceivedUsdc: rules.IMPORTI.DONO_TOTALE_L5,
      baseNetUsdc: rules.IMPORTI.USCITA_L5_NETTO_BASE,
      receiverGiftUsdc: rules.IMPORTI.QUOTA_RICEVENTE_L5,
      receiverPayoutUsdc: rules.IMPORTI.USCITA_L5_PAYOUT_TOTALE
    };
    if (allocation.status === 'MATERIALIZED') {
      let positionResult = allocation.position_result || [];
      if (typeof positionResult === 'string') positionResult = JSON.parse(positionResult);
      if (Number(allocation.reentry_positions_created) !== rules.IMPORTI.NUM_RIENTRI_ENTRATA_L5) throw new Error(`Allocazione ISIDE materializzata con conteggio incoerente: ${event}`);
      if (shouldManageTx) await dbClient.query('COMMIT');
      return { eventKey: event, idempotent: true, accounting, reentries: { amountUsdc: rules.IMPORTI.TRATTENUTA_RIENTRI_ENTRATA_L5, positionsExpected: rules.IMPORTI.NUM_RIENTRI_ENTRATA_L5, positionsCreated: Number(allocation.reentry_positions_created), positions: positionResult } };
    }
    if (Number(allocation.reentry_positions_created || 0) !== 0) throw new Error(`Allocazione ISIDE parziale non riconciliata: ${event}`);

    const positions = await reentryManager.materializzaRientriEntrata({
      source: 'ISIDE_REENTRY', eventKey: event, wallet,
      nome: account.nome || wallet.substring(0, 10),
      sourceAccountId: account.id, sourceAccountSigla: account.sigla,
      count: rules.IMPORTI.NUM_RIENTRI_ENTRATA_L5, client: dbClient
    });
    const completed = await db.completeIsideExitAllocation({ eventKey: event, positions }, dbClient);
    if (!completed || completed.status !== 'MATERIALIZED' || Number(completed.reentry_positions_created) !== positions.length) throw new Error(`Allocazione ISIDE non finalizzata correttamente: ${event}`);
    if (shouldManageTx) await dbClient.query('COMMIT');
    return { eventKey: event, idempotent: false, accounting, reentries: { amountUsdc: rules.IMPORTI.TRATTENUTA_RIENTRI_ENTRATA_L5, positionsExpected: positions.length, positionsCreated: positions.length, positions } };
  } catch (err) {
    if (shouldManageTx) { try { await dbClient.query('ROLLBACK'); } catch (_) {} }
    throw err;
  } finally { if (shouldManageTx) dbClient.release(); }
}


// ========================================
// DISTRIBUZIONE CREDITI POST-TURNO
// ========================================

// ========================================
// EXPORTS
// ========================================

module.exports = {
  rilasciaFunzioniL3,
  rilasciaFunzioniL4,
  rilasciaFunzioniL5,
  buildPrenotazioneSpec,
  assicuratiPrenotazione
};
