/**
 * 🎁 PHARAOH - Donation Flow Manager
 *
 * FLUSSO CORRETTO (cascata automatica):
 *
 * LIVELLO DI ENTRATA (tavole numerate progressivamente):
 *   Tavola 1 → A al centro  → donatori 1-6   → A sacerdote completo → Anubis
 *   Tavola 2 → 1 al centro  → riporto Cassa 100 + 5 nuovi donatori → sacerdote 1 → Anubis
 *   Tavola 3 → 2 al centro  → riporto Cassa 100 + 5 nuovi donatori → sacerdote 2 → Anubis
 *   Tavola 4 → 3 al centro  → riporto Cassa 100 + 5 nuovi donatori → sacerdote 3 → Horus
 *   ... e così via: dalla Tavola 2 ogni chiusura usa 1 riporto + 5 nuovi ingressi.
 *
 * SISTEMA PHARAOH — BLOCCO 1:
 *   Anubis : 2 sacerdoti   → 18 donatori totali  (A conclude Anubis)
 *   Horus  : +4 sacerdoti  → 42 donatori totali  (A conclude Horus)
 *   Rha    : +12 sacerdoti → 78 donatori totali  (A conclude Rha, esce)
 *
 * INGRESSO AUTOMATICO:
 *   Tavola 1: al 6° dono reale → tavola completa.
 *   Dalla Tavola 2: 1 riporto Cassa da 100 + 5 nuovi ingressi → tavola completa.
 *   → l'erede al centro DIVENTA SACERDOTE e AUTOMATICAMENTE
 *     si posiziona nel livello corretto del Blocco 1 (Anubis/Horus/Rha)
 *   → il livello di entrata riparte con la prossima tavola (sdoppiamento)
 *   → NON serve una seconda transazione blockchain dal sacerdote!
 *
 * SCALABILITÀ PER I FARAONI SUCCESSIVI:
 *   A (primo Faraone) : 78 donatori totali
 *   1 (secondo Faraone): 72 (risparmia 6 perché già formato nel ciclo di A)
 *   2, 3... : 72 ciascuno (già pre-formati dal ciclo precedente)
 *
 * BLOCCO 2 (solo account secondari: Perpetui e Gemelli):
 *   → L4 Thot : ingresso 5.000, uscita 15.000, netto 4.000; 500 umanitari + 5 rientri Entrata
 *   → L5 Iside: ingresso 10.000, uscita 30.000, 5.000 rientri + 25.000 payout ricevente
 */

const db = require('./db-manager');
const tableManager = require('./table-manager');
const containerManager = require('./container-manager');
const functionManager = require('./function-manager');
const rules = require('./rules-engine');
const verifier = require('./blockchain-verifier');
const payoutManager = require('./payout-manager');
const directDonation = require('./direct-donation-manager');
const directSessions = require('./direct-donation-session-manager');
const pharaohRegistry = require('./pharaoh-registry-manager');
const crossOutbound = require('./cross-outbound-manager');

// ========================================
// STATO SISTEMA (wallet distinti)
// ========================================

// Fondo A: account di sistema in posizione concettuale 0.
// Cassa PHARAOH: riceve le donazioni, invia le distribuzioni e rappresenta
// il riporto contabile da 100 USDC dalla Tavola Entrata precedente.
const FONDO_A_WALLET = (
  process.env.PHARAOH_FUND_A_WALLET ||
  '0x0000000000000000000000000000000000000001'
).toLowerCase();
const CASSA_PHARAOH_WALLET = (
  process.env.PHARAOH_TREASURY_WALLET ||
  '0x0000000000000000000000000000000000000002'
).toLowerCase();
const FONDO_WALLET = FONDO_A_WALLET;
const FONDO_SIGLA = 'A';

function verificaWalletSistemaDistinti() {
  if (FONDO_A_WALLET === CASSA_PHARAOH_WALLET) {
    throw new Error('Configurazione non valida: Fondo A e Cassa PHARAOH devono essere wallet differenti');
  }
}

function identityFromAccount(account) {
  if (!account?.id) return null;
  return { accountId: Number(account.id), accountSigla: account.sigla || null };
}

function identityFromTurno(turno) {
  if (!turno?.faraone_account_id) return null;
  return {
    accountId: Number(turno.faraone_account_id),
    accountSigla: turno.faraone_sigla || null
  };
}

async function resolveFlowAccount({ wallet, accountId = null, accountSigla = null, context, requireIdentity = false }, client = null) {
  const w = String(wallet || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(w)) {
    throw new Error(`${context}: wallet Ethereum non valido`);
  }
  if (requireIdentity && !accountId) {
    throw new Error(`${context}: account_id obbligatorio per distinguere percorsi sullo stesso wallet`);
  }
  const account = accountId || accountSigla
    ? await db.getAccountByIdentity({ accountId, wallet: w, sigla: accountSigla || null }, client)
    : await db.getAccount(w, client);
  if (!account) throw new Error(`${context}: identita account non trovata per ${w}`);
  return account;
}

async function resolveTurnFaraone(turno, context, client = null, requireSecondaryIdentity = false) {
  if (!turno?.faraone_wallet) throw new Error(`${context}: turno senza Faraone`);
  const turnoTipo = String(turno.faraone_tipo || '').toUpperCase();
  const requiresExact = requireSecondaryIdentity || ['SECONDARIO', 'PERPETUO', 'GEMELLO'].includes(turnoTipo);
  const account = await resolveFlowAccount({
    wallet: turno.faraone_wallet,
    accountId: turno.faraone_account_id || null,
    accountSigla: turno.faraone_sigla || null,
    context,
    requireIdentity: requiresExact
  }, client);
  if (turno.faraone_sigla && String(account.sigla || '') !== String(turno.faraone_sigla)) {
    throw new Error(`${context}: sigla Faraone non coerente con account_id`);
  }
  return account;
}

// ========================================
// INIZIALIZZAZIONE SISTEMA
// ========================================

/**
 * Inizializza il sistema PHARAOH al primissimo avvio.
 * Crea l'account Fondo (A) e la prima tavola del livello di entrata.
 *
 * A È UNA POSIZIONE DI SISTEMA:
 *  - Non paga nessun ingresso (non ha txHash, non effettua donazioni)
 *  - Il suo wallet sostiene le spese operative del sistema
 *  - Alla chiusura della tavola segue la regola comune: 100 alla terza
 *    stringa e 500 come valore di ingresso nel percorso PHARAOH
 *  - I donatori paganti partono da 1 e vanno a infinito
 */
async function inizializzaSistema() {
  verificaWalletSistemaDistinti();
  await db.initDatabase();

  const state = await db.getState('sistema', null);
  if (state && state.inizializzato) {
    console.log('✅ Sistema PHARAOH già inizializzato');
    return state;
  }

  console.log('\n🏛️ ========================================');
  console.log('   INIZIALIZZAZIONE SISTEMA PHARAOH');
  console.log('========================================\n');

  // 1. Crea account Fondo (A) - reg.1
  const fondoAccount = await db.createAccount({
    wallet: FONDO_WALLET,
    nome: 'Fondo PHARAOH (A)',
    tipo: 'FONDO',
    sigla: FONDO_SIGLA,
    accountKey: 'SYSTEM:FONDO:A',
    originKind: 'SYSTEM'
  });
  if (Number(fondoAccount.root_account_id) !== Number(fondoAccount.id)) {
    await db.updateAccountIdentity(fondoAccount.id, { rootAccountId: fondoAccount.id });
  }
  const fondoIdentity = { accountId: Number(fondoAccount.id), accountSigla: FONDO_SIGLA };

  // 2. Crea prima tavola livello entrata con Fondo al centro
  const primaTavola = await tableManager.creaTavolaPercorso(0, FONDO_WALLET, 1, null, null, fondoIdentity);

  // 3. Crea primo turno livello entrata
  await db.createTurno({
    sezione: 'ENTRATA',
    livello: 0,
    blocco: null,
    numeroTurno: 1,
    faraoneWallet: FONDO_WALLET,
    faraoneTipo: 'FONDO',
    faraoneAccountId: fondoIdentity.accountId,
    faraoneSigla: fondoIdentity.accountSigla,
    sacerdotiNecessari: 6  // tavola entrata = 6 caselle
  });

  // 4. Crea il primo turno del Blocco 1 (Sistema Pharaoh).
  //    La tavola Anubis NON viene pre-creata qui: viene creata in modo lazy
  //    quando il primo sacerdote entra (posizionaSacerdoteInPharaoh).
  //    Questo garantisce la numerazione CORRETTA delle tavole:
  //      Tavola 1 = A al centro (livello entrata)
  //      Tavola 2 = donatore-1 al centro (sdoppiamento di tavola 1)
  //      Tavola 3 = donatore-2 al centro
  //      ... e così via, senza che la tavola Anubis rompa la sequenza.
  await db.createTurno({
    sezione: 'PHARAOH',
    livello: 1,
    blocco: 1,
    numeroTurno: 1,
    faraoneWallet: FONDO_WALLET,
    faraoneTipo: 'FONDO',
    faraoneAccountId: fondoIdentity.accountId,
    faraoneSigla: fondoIdentity.accountSigla,
    sacerdotiNecessari: rules.IMPORTI.SACERDOTI_PRIMO_TURNO
  });
  // La tavola Anubis (L1 PERCORSO) verrà creata automaticamente in
  // posizionaSacerdoteInPharaoh() quando A completa il livello di entrata.

  // 5. Crea i turni del Blocco 2 (L4 Thot e L5 Iside).
  //    Solo Account Secondari (Perpetui e Gemelli) passano da L3 a L4 (reg.12).
  //    A apre sempre il 1° turno di ogni livello (reg.1).
  //    Le tavole L4/L5 vengono create in modo lazy (capacita=3).
  await db.createTurno({
    sezione: 'PHARAOH', livello: 4, blocco: 2, numeroTurno: 1,
    faraoneWallet: FONDO_WALLET, faraoneTipo: 'FONDO',
    faraoneAccountId: fondoIdentity.accountId, faraoneSigla: fondoIdentity.accountSigla,
    sacerdotiNecessari: 3   // 3 Faraoni × 5.000 = 15.000
  });
  await db.createTurno({
    sezione: 'PHARAOH', livello: 5, blocco: 2, numeroTurno: 1,
    faraoneWallet: FONDO_WALLET, faraoneTipo: 'FONDO',
    faraoneAccountId: fondoIdentity.accountId, faraoneSigla: fondoIdentity.accountSigla,
    sacerdotiNecessari: 3   // 3 Faraoni × 10.000 = 30.000
  });

  const nuovoState = {
    inizializzato: true,
    turnoEntrata: 1,
    turnoSistemaPharaoh: 1,
    primaTavolaEntrata: primaTavola.numero,
    fondoWallet: FONDO_WALLET
  };

  await db.setState('sistema', nuovoState);

  console.log('✅ Sistema PHARAOH inizializzato');
  console.log(`   Fondo (A): ${FONDO_WALLET}`);
  console.log(`   Prima tavola entrata: #${primaTavola.numero}`);

  return nuovoState;
}

// ========================================
// INGRESSO AUTOMATICO SACERDOTE NEL BLOCCO 1
// ========================================

/**
 * Posiziona automaticamente un sacerdote nel Sistema Pharaoh (Blocco 1).
 *
 * Viene chiamato AUTOMATICAMENTE quando una tavola di entrata si completa
 * (6° donatore entra → erede al centro = sacerdote completo).
 * Il sacerdote NON deve fare nessuna nuova transazione blockchain.
 *
 * REG.1 — Il Fondo (A) è il FARAONE RICEVENTE:
 *   A non occupa caselle nelle tavole come donatore-sacerdote.
 *   A non incrementa sacerdoti_entrati.
 *   La tavola Anubis viene creata lazily, poi i 18 sacerdoti umani la riempiono.
 *   Donatori necessari: 18 × 6 = 108 (sacerdoti) + 6 (tavola di A) = 114 totali.
 *
 * Posizionamento sacerdoti umani in base a sacerdoti_entrati:
 *   0-1  → Anubis  (2 sacerdoti umani per completare)
 *   2-5  → Horus   (+4 nuovi, 6 totali con progressione da Anubis)
 *   6-17 → Rha     (+12 nuovi, 18 totali con progressione da Horus)
 *   = 18 sacerdoti umani → Faraone esce dal Blocco 1
 *
 * @param {string} wallet - Wallet dell'erede diventato sacerdote
 * @param {string} nome   - Nome del sacerdote
 * @returns {Object|null} Dettagli posizionamento, o null se fallback a container 5.2
 */
async function posizionaSacerdoteInPharaoh(wallet, nome, client = null, accountIdentity = null) {
  const pg = require('./pg-connection-manager');

  const turno = await db.getTurnoCorrente('PHARAOH', 1, client);
  if (!turno) {
    throw new Error(`Nessun turno PHARAOH attivo per il posizionamento del sacerdote: ${wallet}`);
  }
  const faraoneIdentity = identityFromTurno(turno);

  // ── REG.1: Il Fondo (A) è il Faraone che RICEVE i doni — non è un sacerdote ──
  // A entra nel Blocco 1 come Faraone, NON occupa caselle come donatore.
  // NON incrementa sacerdoti_entrati (non è uno dei 18 sacerdoti umani).
  // NON crea tavola di sdoppiamento (evita che A diventi Faraone del turno 2).
  // Crea solo la tavola Anubis lazily (reg.5) per accogliere i sacerdoti.
  const accountInIngresso = await resolveFlowAccount({
    wallet,
    accountId: accountIdentity?.accountId || null,
    accountSigla: accountIdentity?.accountSigla || null,
    context: 'Ingresso sacerdote nel Blocco 1',
    requireIdentity: Boolean(accountIdentity?.accountId)
  }, client);
  const sacerdoteIdentity = identityFromAccount(accountInIngresso);
  if (accountInIngresso?.tipo === 'FONDO') {
    const tavolaAnubisEsiste = await tableManager.getTavolaPercorsoAttiva(1, turno.numero_turno, client);
    if (!tavolaAnubisEsiste) {
      await tableManager.creaTavolaPercorso(1, turno.faraone_wallet, turno.numero_turno, null, client, faraoneIdentity);
      console.log(`   👑 Faraone ${nome} entra nel Blocco 1 — tavola Anubis creata`);
      console.log(`      (${nome} è il Faraone ricevente, non occupa caselle)`);
    }
    return { isFaraone: true, wallet, turno: turno.numero_turno };
  }

  // Trova tavola aperta cercando L1→L2→L3
  let tavolaAttiva = null;
  let livelloCorrente = null;

  for (const liv of [1, 2, 3]) {
    tavolaAttiva = liv === 2 && turno.numero_turno === 1
      ? await tableManager.getTavolaPercorsoOperativaHorus(
          turno.numero_turno,
          client
        )
      : liv === 3
      ? await tableManager.getTavolaPercorsoOperativaRha(
          turno.numero_turno,
          client
        )
      : await tableManager.getTavolaPercorsoAttiva(
          liv,
          turno.numero_turno,
          client
        );
    if (tavolaAttiva) { livelloCorrente = liv; break; }
  }

  if (!tavolaAttiva) {
    const entrati = Number(turno.sacerdoti_entrati) || 0;

    if (entrati < 2) {
      livelloCorrente = 1;  // Anubis
    } else if (turno.numero_turno === 1 && entrati < 6) {
      // Solo nel primo turno servono 4 nuovi sacerdoti umani a Horus.
      livelloCorrente = 2;
    } else {
      // Dal secondo turno Horus è completato dalle 4 Funzioni
      // e dai 2 sacerdoti progrediti da Anubis.
      livelloCorrente = 3;
    }

    tavolaAttiva = livelloCorrente === 2 && turno.numero_turno === 1
      ? await tableManager.creaTavolaPercorsoOperativaHorus(
          turno.faraone_wallet,
          turno.numero_turno,
          client,
          faraoneIdentity
        )
      : livelloCorrente === 3
      ? await tableManager.creaTavolaPercorsoOperativaRha(
          turno.faraone_wallet,
          turno.numero_turno,
          client,
          faraoneIdentity
        )
      : await tableManager.creaTavolaPercorso(
          livelloCorrente,
          turno.faraone_wallet,
          turno.numero_turno,
          null,
          client,
          faraoneIdentity
        );

  }

  const livNome = { 1: 'ANUBIS', 2: 'HORUS', 3: 'RHA' };
  console.log(`   ⛩️  Sacerdote → ${livNome[livelloCorrente]} (tavola #${tavolaAttiva.numero})`);

  const risultato = await tableManager.posizionaDonatore({
    tavolaId:     tavolaAttiva.id,
    tavolaNumero: tavolaAttiva.numero,
    livello:      livelloCorrente,
    wallet,
    nome,
    tipo:        'DONATORE',
    donoImporto: rules.IMPORTI.DONO_PHARAOH,  // 500 USDC — trattenuti nella cassa
    turno:       turno.numero_turno,
    sdoppiabile: true,
    capacitaTavola: tavolaAttiva.capacita,
    accountId: sacerdoteIdentity.accountId,
    accountSigla: sacerdoteIdentity.accountSigla,
    client
  });

  // Nella settima tavola Rha il primo sacerdote occupa la casella 1;
  // subito dopo viene materializzato il Gemello prenotato in casella 2.
  if (livelloCorrente === 3) {
    await inserisciGemelloPendente(turno.numero_turno, client);
  }

  await db.incrementSacerdotiEntrati(turno.id, client);

  const entratiRow = client
    ? (await client.query('SELECT sacerdoti_entrati FROM turni WHERE id = $1', [turno.id])).rows[0] || null
    : await pg.queryOne('SELECT sacerdoti_entrati FROM turni WHERE id = $1', [turno.id]);
  const { sacerdoti_entrati } = entratiRow || {};
  const entrati = Number(sacerdoti_entrati) || 0;

  console.log(`   Sacerdoti nel Blocco 1: ${entrati}/${turno.sacerdoti_necessari}`);

  // Progressione automatica distinta tra primo turno e turni successivi.
  if (livelloCorrente === 1 && entrati === 2) {
    console.log('\n   🏛️ ANUBIS COMPLETATO (2/2) → sacerdoti progrediscono a Horus');
    if (turno.numero_turno === 1) {
      await tableManager.avanzaAnubisAHorusPrimoTurnoStrutturale(
        turno.numero_turno,
        turno.faraone_wallet,
        client,
        faraoneIdentity
      );
    } else {
      await tableManager.avanzaSacerdotiAlLivello(
        1, 2, turno.numero_turno, turno.faraone_wallet, client, faraoneIdentity
      );
    }

    if (turno.numero_turno > 1) {
      // Excel ufficiale:
      // 1. la progressione Anubis → Horus crea la tavola principale Horus;
      // 2. successivamente vengono create le due tavole Horus delle Funzioni;
      // 3. il Perpetuo genera la propria tavola di sdoppiamento.
      await materializzaFunzioniNelNuovoTurno(
        turno,
        turno.faraone_wallet,
        client
      );

      console.log('\n   🏛️ HORUS COMPLETATO → sacerdoti e Funzioni progrediscono a Rha');
      await tableManager.avanzaHorusARhaStrutturale(
        turno.numero_turno,
        turno.faraone_wallet,
        client,
        faraoneIdentity
      );
      await inserisciGemelloPendente(turno.numero_turno, client);
    }
  }

  if (
    turno.numero_turno === 1
    && livelloCorrente === 2
    && entrati === 6
  ) {
    console.log('\n   🏛️ HORUS COMPLETATO (6/6) → sacerdoti progrediscono a Rha');
    await tableManager.avanzaHorusARhaStrutturale(
      turno.numero_turno,
      turno.faraone_wallet,
      client,
      faraoneIdentity
    );
    await inserisciGemelloPendente(turno.numero_turno, client);
  }

  // Rha completato → Faraone esce dal Blocco 1
  if (entrati >= turno.sacerdoti_necessari) {
    console.log(`\n   🏆 RHA COMPLETATO (${entrati}/${turno.sacerdoti_necessari}) → FARAONE ESCE`);
    await gestisciUscitaFaraone(turno, client);
  }

  return { livelloCorrente, tavolaNumero: tavolaAttiva.numero, risultato, entrati };
}

// ========================================
// FLUSSO DIRETTO DA WALLET (FASE 6-8 — produzione)
// ========================================

/**
 * Completa UNA sessione DIRECT gia autorizzata dal gate Community + ROG.
 * Invariante economico: 2 USDC ROG + 100 USDC PHARAOH = 1 posizione.
 * Ogni posizione aggiuntiva richiede una nuova sessione e una nuova tx da 100.
 * Nessun DEV_SKIP e nessun multiplo nella singola sessione DIRECT.
 */
async function _processaDonoEntrataWalletLocked({ wallet, txHash, sessionRef, nome }, client) {
  verificaWalletSistemaDistinti();
  await db.initDatabase();
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error('Wallet non valido');
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('txHash obbligatorio e deve essere reale');
  if (!sessionRef) throw new Error('sessionRef obbligatorio per il flusso DIRECT');

  const w = wallet.toLowerCase();
  const canonicalTx = txHash.toLowerCase();
  const nomeEffettivo = (nome || '').trim() || `${w.substring(0, 8)}...`;

  const gate = await directDonation.assertReadyForPharaoh({ wallet: w, sessionRef });
  if (gate.alreadyCompleted) {
    return {
      success: true,
      idempotent: true,
      numeroPosizioni: 1,
      importoTotale: 100,
      sessionRef,
      registry: {
        txHash: gate.session.registry_tx_hash || null,
        txId: gate.session.registry_session_id == null ? null : Number(gate.session.registry_session_id),
        blockNumber: gate.session.registry_block_number == null ? null : Number(gate.session.registry_block_number)
      },
      result: gate.session.position_result || null
    };
  }

  let session = gate.session;
  let blockchainProof = null;
  let verifiedHash = canonicalTx;
  if (session.pharaoh_tx_hash) {
    if (String(session.pharaoh_tx_hash).toLowerCase() !== canonicalTx) {
      const error = new Error('La sessione DIRECT e gia associata a una tx PHARAOH differente');
      error.code = 'DIRECT_SESSION_PROOF_CONFLICT';
      throw error;
    }
    if (Number(session.pharaoh_amount_usdc) !== Number(rules.IMPORTI.DONO_ENTRATA)) {
      const error = new Error('La sessione DIRECT contiene un importo PHARAOH non valido');
      error.code = 'DIRECT_DONATION_EXACT_ENTRY_REQUIRED';
      throw error;
    }
    blockchainProof = typeof session.pharaoh_proof === 'string'
      ? JSON.parse(session.pharaoh_proof)
      : session.pharaoh_proof;
  } else {
    const verifica = await verifier.verificaDonazione({
      txHash: canonicalTx,
      walletMittente: w,
      importoMinimo: rules.IMPORTI.DONO_ENTRATA,
      maxPosizioni: 1
    });
    const n = Number(verifica.numeroPosizioni);
    const importoTotale = Number(verifica.importoEffettivo);
    if (n !== 1 || importoTotale !== Number(rules.IMPORTI.DONO_ENTRATA) || importoTotale !== 100) {
      const error = new Error('DIRECT richiede esattamente 100 USDC per sessione e crea una sola posizione');
      error.code = 'DIRECT_DONATION_EXACT_ENTRY_REQUIRED';
      throw error;
    }
    verifiedHash = verifica.txHash;
    blockchainProof = verifica.proof;
    session = await directSessions.recordPharaohVerified({
      sessionRef,
      wallet: w,
      amountUsdc: importoTotale,
      txHash: verifiedHash,
      proof: blockchainProof
    }, client);
  }

  if (!blockchainProof || Number(blockchainProof.amountUsdc) !== 100 ||
      String(blockchainProof.from || '').toLowerCase() !== w ||
      String(blockchainProof.to || '').toLowerCase() !== CASSA_PHARAOH_WALLET) {
    const error = new Error('Prova blockchain DIRECT non coerente');
    error.code = 'BLOCKCHAIN_PROOF_REQUIRED';
    throw error;
  }

  if (session.status !== 'REGISTRY_CONFIRMED') {
    const registryResult = await pharaohRegistry.registerDirectIncoming({
      session,
      onSubmitted: async (registryTxHash) => {
        session = await directSessions.recordRegistrySubmitted({
          sessionRef,
          txHash: registryTxHash
        }, client);
      }
    });
    session = await directSessions.recordRegistryConfirmed({
      sessionRef,
      txHash: registryResult.txHash,
      txId: registryResult.txId,
      blockNumber: registryResult.blockNumber
    }, client);
  }

  let transactionBegun = false;
  let completedTable = null;
  try {
    await client.query('BEGIN');
    transactionBegun = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['PHARAOH:ENTRATA:POSIZIONAMENTO']);

    const existing = await client.query('SELECT id FROM donazioni WHERE LOWER(tx_hash) = $1 LIMIT 1', [verifiedHash]);
    if (existing.rows.length) {
      const current = await directSessions.requireSession(sessionRef, w, client, { forUpdate: true });
      if (current.status === 'POSITION_ASSIGNED') {
        await client.query('ROLLBACK');
        transactionBegun = false;
        return { success: true, idempotent: true, numeroPosizioni: 1, importoTotale: 100, sessionRef, registry: { txHash: current.registry_tx_hash || null, txId: current.registry_session_id == null ? null : Number(current.registry_session_id), blockNumber: current.registry_block_number == null ? null : Number(current.registry_block_number) }, result: current.position_result || null };
      }
      const error = new Error('Transazione gia registrata nel sistema');
      error.code = 'BLOCKCHAIN_TX_REPLAY';
      throw error;
    }

    let account = await db.getAccount(w, client);
    if (!account) account = await db.createAccount({ wallet: w, nome: nomeEffettivo, tipo: 'PRIMARIO' }, client);

    const turno = await db.getTurnoCorrente('ENTRATA', 0, client);
    if (!turno) throw new Error('Nessun turno attivo al livello di entrata.');
    const tavola = await tableManager.getTavolaPercorsoAttiva(0, turno.numero_turno, client);
    if (!tavola) throw new Error('Nessuna tavola aperta al livello di entrata.');

    const placement = await tableManager.posizionaDonatore({
      tavolaId: tavola.id,
      tavolaNumero: tavola.numero,
      livello: 0,
      wallet: w,
      nome: nomeEffettivo,
      tipo: 'DONATORE',
      donoImporto: 100,
      turno: turno.numero_turno,
      sdoppiabile: true,
      accountId: account.id,
      accountSigla: account.sigla || null,
      client
    });
    await db.incrementSacerdotiEntrati(turno.id, client);

    if (placement.tavolaCompleta) {
      const eredeWallet = tavola.faraone_wallet;
      const eredeAccount = tavola.faraone_account_id
        ? await db.getAccountByIdentity({
            accountId: tavola.faraone_account_id,
            wallet: eredeWallet,
            sigla: tavola.faraone_sigla || null
          }, client)
        : await db.getAccount(eredeWallet, client);
      if (!eredeAccount) throw new Error(`Identita erede Entrata non risolta per tavola ${tavola.id}`);
      const nomeErede = eredeAccount.nome || eredeWallet.substring(0, 10);
      const isFondo = eredeAccount.tipo === 'FONDO';
      const doniRicevuti = rules.IMPORTI.DONO_ENTRATA * 6;
      const postCommitEventKey = `${verifiedHash}:USCITA_ENTRATA:TAVOLA:${tavola.id}`;
      await db.createPostCommitOperation({
        eventKey: postCommitEventKey,
        operationType: 'USCITA_ENTRATA_POST_COMMIT',
        txHash: verifiedHash,
        sourceTavolaId: tavola.id,
        sourceTavolaNumero: tavola.numero,
        turnoId: turno.id,
        turnoNumero: turno.numero_turno,
        wallet: eredeWallet,
        payload: {
          nomeErede,
          isFondo,
          doniRicevuti,
          turnoEntrataAvviatoNelBatch: false,
          eredeAccountId: eredeAccount.id,
          eredeAccountSigla: eredeAccount.sigla || null
        }
      }, client);
      completedTable = {
        turno, tavola, eredeWallet, nomeErede, isFondo, doniRicevuti,
        eredeAccountId: eredeAccount.id, eredeAccountSigla: eredeAccount.sigla || null
      };
    }

    const posizione = {
      tavola: { id: tavola.id, numero: tavola.numero, casella: placement.casellaOccupata, completa: placement.tavolaCompleta },
      tavolaPersonale: placement.tavolaSdoppiamento ? { numero: placement.tavolaSdoppiamento.numero } : null
    };
    const result = {
      success: true,
      sourcePlatform: 'DIRECT',
      sourceEventKey: sessionRef,
      sessionRef,
      paymentWallet: w,
      beneficiaryWallet: w,
      numeroPosizioni: 1,
      importoTotale: 100,
      pharaohTxHash: verifiedHash,
      registry: {
        txHash: session.registry_tx_hash || null,
        txId: session.registry_session_id == null ? null : Number(session.registry_session_id),
        blockNumber: session.registry_block_number == null ? null : Number(session.registry_block_number)
      },
      posizioni: [posizione]
    };

    await db.createDonazione({
      donorWallet: w,
      importo: 100,
      txHash: verifiedHash,
      tipo: 'DONO',
      destinatarioWallet: CASSA_PHARAOH_WALLET,
      beneficiaryWallet: w,
      sourcePlatform: 'DIRECT',
      sourceEventKey: sessionRef,
      positionsCreated: 1,
      tavolaId: tavola.id,
      livello: 0,
      turno: turno.numero_turno,
      blockchainProof
    }, client);

    await directSessions.markPositionAssigned({ sessionRef, result }, client);
    await client.query('COMMIT');
    transactionBegun = false;

    const trasferimentiSistema = [];
    if (completedTable) {
      const verifiedEntry = require('./verified-entry-manager');
      trasferimentiSistema.push(await verifiedEntry._processCompletedEntryTable({
        completed: completedTable,
        txHash: verifiedHash,
        client
      }));
    }
    return { ...result, trasferimentiSistema };
  } catch (error) {
    if (transactionBegun) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    await directSessions.recordError(sessionRef, error).catch(() => null);
    throw error;
  }
}

async function processaDonoEntrataWallet({ wallet, txHash, sessionRef, nome }) {
  if (!sessionRef) {
    const error = new Error('sessionRef obbligatorio: il backend non consente bypass del prerequisito ROG');
    error.code = 'DIRECT_SESSION_REF_REQUIRED';
    throw error;
  }
  return directDonation._withSessionLock(sessionRef, (client) =>
    _processaDonoEntrataWalletLocked({ wallet, txHash, sessionRef, nome }, client)
  );
}

async function processaDonoEntrata() {
  return {
    success: false,
    code: 'LEGACY_ENTRY_FLOW_DISABLED',
    error:
      'Flusso admin disabilitato: una posizione può essere creata soltanto ' +
      'da una donazione on-chain verificata tramite /api/donazione/entrata/wallet'
  };
}

/**
 * Avvia un nuovo turno al livello di entrata.
 *
 * REGOLA CHIAVE (numerazione sequenziale):
 *   Tavola 1 = A, Tavola 2 = donatore 1, Tavola 3 = donatore 2 ...
 *   La prossima tavola è SEMPRE la prima SDOPPIAMENTO APERTA al livello 0
 *   in ordine di numero della sezione ENTRATA, indipendentemente dal turno.
 *
 *   NON si usa solo il turno chiuso: se cercassimo solo nel turno corrente
 *   salteremmo i donatori 2-6 (le cui tavole sono state create nel turno 1
 *   e non nel turno 2) portando a un ordine errato.
 */
async function avviaNuovoTurnoEntrata(turnoChiuso, client = null) {
  await db.completaTurno(turnoChiuso.id, rules.IMPORTI.DONO_ENTRATA * 6, client);

  const nuovoNumeroTurno = Number(turnoChiuso.numero_turno) + 1;
  const pg = require('./pg-connection-manager');

  const sourceSql = `SELECT * FROM tavole
     WHERE sezione = 'ENTRATA'
       AND livello = 0
       AND turno = $1
       AND tipo = 'PERCORSO'
       AND status = 'COMPLETATA'
     ORDER BY numero ASC
     LIMIT 1`;
  const sourceTavola = client
    ? (await client.query(sourceSql, [turnoChiuso.numero_turno])).rows[0] || null
    : await pg.queryOne(sourceSql, [turnoChiuso.numero_turno]);
  if (!sourceTavola) {
    throw new Error(`Tavola Entrata completata non trovata per turno ${turnoChiuso.numero_turno}`);
  }

  // Prende la PROSSIMA tavola di sdoppiamento al livello 0 in ordine di numero.
  const selectSql = `SELECT * FROM tavole
     WHERE sezione = 'ENTRATA'
       AND tipo    = 'SDOPPIAMENTO'
       AND status  = 'APERTA'
       AND livello = 0
     ORDER BY numero ASC
     LIMIT 1`;
  const prossimaTavola = client
    ? (await client.query(selectSql)).rows[0] || null
    : await pg.queryOne(selectSql);

  if (!prossimaTavola) {
    console.log('⚠️  Nessuna tavola di sdoppiamento disponibile per il prossimo turno entrata');
    return null;
  }

  const updateSql = `UPDATE tavole SET tipo = 'PERCORSO', turno = $1 WHERE id = $2 RETURNING *`;
  const tavolaAttiva = client
    ? (await client.query(updateSql, [nuovoNumeroTurno, prossimaTavola.id])).rows[0] || { ...prossimaTavola, tipo: 'PERCORSO', turno: nuovoNumeroTurno }
    : await pg.queryOne(updateSql, [nuovoNumeroTurno, prossimaTavola.id]);

  const prossimoErede = prossimaTavola.faraone_account_id
    ? await db.getAccountByIdentity({
        accountId: prossimaTavola.faraone_account_id,
        wallet: prossimaTavola.faraone_wallet,
        sigla: prossimaTavola.faraone_sigla || null
      }, client)
    : await db.getAccount(prossimaTavola.faraone_wallet, client);
  if (!prossimoErede) {
    throw new Error(`Identita erede Entrata non risolta per tavola ${prossimaTavola.id}`);
  }

  const nuovoTurno = await db.createTurno({
    sezione:          'ENTRATA',
    livello:          0,
    blocco:           null,
    numeroTurno:      nuovoNumeroTurno,
    faraoneWallet:    prossimaTavola.faraone_wallet,
    faraoneTipo:      'EREDE',
    faraoneAccountId: prossimoErede.id,
    faraoneSigla:     prossimoErede.sigla || prossimaTavola.faraone_sigla || null,
    tavolaFaraoneNum: prossimaTavola.numero,
    sacerdotiNecessari: 5
  }, client);

  const rollover = await tableManager.materializzaRolloverEntrata({
    sourceTavola,
    targetTavola: tavolaAttiva,
    targetTurno: nuovoNumeroTurno,
    cassaWallet: CASSA_PHARAOH_WALLET,
    client
  });

  console.log(`\n🔄 Nuovo turno entrata #${nuovoNumeroTurno}`);
  console.log(`   Erede: ${prossimaTavola.faraone_wallet}`);
  console.log(`   Tavola: #${prossimaTavola.numero} (convertita a PERCORSO)`);
  console.log(`   Riporto: 100 USDC Cassa PHARAOH in casella ${rollover?.placement?.casellaOccupata || rollover?.audit?.target_casella}`);

  return { turno: nuovoTurno, tavola: tavolaAttiva, rollover };
}

// ========================================
// FLUSSO SISTEMA PHARAOH (FASE 9-12)
// ========================================

/**
 * Processa un dono da 500 nel Sistema Pharaoh (Blocco 1).
 *
 * Il sacerdote-donatore viene preso dal contenitore 5.2,
 * posizionato nella tavola del Faraone di turno, sdoppiato.
 *
 * Quando tutte le tavole del Blocco 1 sono complete (18 o 13 sacerdoti),
 * il Faraone esce dal livello 3 e si rilasciano le Funzioni.
 */
async function processaDonoPharaoh() {
  await db.initDatabase();
  const pg = require('./pg-connection-manager');

  // 1. Preleva sacerdote dal contenitore 5.2
  const sacerdote = await containerManager.prelevaProssimo('5.2');
  if (!sacerdote) {
    return { success: false, error: 'Nessun sacerdote disponibile nel contenitore 5.2' };
  }

  // 2. Trova turno attivo Pharaoh (unico turno gestisce L1-L3)
  const turno = await db.getTurnoCorrente('PHARAOH', 1);
  if (!turno) {
    return { success: false, error: 'Nessun turno attivo nel Sistema Pharaoh' };
  }
  const faraoneIdentity = identityFromTurno(turno);

  // 3. Trova tavola PERCORSO aperta: cerca L1 → L2 → L3
  let tavolaAttiva = null;
  let livelloCorrente = null;

  for (const liv of [1, 2, 3]) {
    tavolaAttiva = liv === 2 && turno.numero_turno === 1
      ? await tableManager.getTavolaPercorsoOperativaHorus(
          turno.numero_turno
        )
      : liv === 3
      ? await tableManager.getTavolaPercorsoOperativaRha(
          turno.numero_turno
        )
      : await tableManager.getTavolaPercorsoAttiva(
          liv,
          turno.numero_turno
        );

    if (tavolaAttiva) {
      livelloCorrente = liv;
      break;
    }
  }

  // Se nessuna tavola aperta, crea la prossima tavola del livello corretto.
  // DISTRIBUZIONE CORRETTA (da documento):
  //   L1 Anubis : sacerdoti 1-2   (entrati 0-1)  → 2 nuovi, poi PROGREDISCONO a Horus
  //   L2 Horus  : sacerdoti 3-6   (entrati 2-5)  → 4 nuovi + 2 progrediti da Anubis = 6 totali
  //   L3 Rha    : sacerdoti 7-18  (entrati 6-17) → 12 nuovi + 6 progrediti da Horus = 18 totali
  if (!tavolaAttiva) {
    const entrati = turno.sacerdoti_entrati;

    if (entrati < 2) {
      livelloCorrente = 1;  // Anubis
    } else if (turno.numero_turno === 1 && entrati < 6) {
      // Solo nel primo turno servono 4 nuovi sacerdoti umani a Horus.
      livelloCorrente = 2;
    } else {
      // Dal secondo turno Horus è completato da:
      // 4 Funzioni + 2 sacerdoti progrediti da Anubis.
      livelloCorrente = 3;
    }

    tavolaAttiva = livelloCorrente === 2 && turno.numero_turno === 1
      ? await tableManager.creaTavolaPercorsoOperativaHorus(
          turno.faraone_wallet,
          turno.numero_turno,
          null,
          faraoneIdentity
        )
      : livelloCorrente === 3
      ? await tableManager.creaTavolaPercorsoOperativaRha(
          turno.faraone_wallet,
          turno.numero_turno,
          null,
          faraoneIdentity
        )
      : await tableManager.creaTavolaPercorso(
          livelloCorrente,
          turno.faraone_wallet,
          turno.numero_turno,
          null,
          null,
          faraoneIdentity
        );
  }

  // 4. Posiziona sacerdote-donatore
  const nome = sacerdote.nome || `#${sacerdote.ticket_number}`;
  const risultato = await tableManager.posizionaDonatore({
    tavolaId: tavolaAttiva.id,
    tavolaNumero: tavolaAttiva.numero,
    livello: livelloCorrente,
    wallet: sacerdote.wallet,
    nome,
    tipo: 'DONATORE',
    donoImporto: rules.IMPORTI.DONO_PHARAOH,
    turno: turno.numero_turno,
    sdoppiabile: true,
    capacitaTavola: tavolaAttiva.capacita,
    accountId: sacerdote.account_id || null,
    accountSigla: sacerdote.account_sigla || null
  });

  // Protegge la casella 2 della settima tavola Rha:
  // prima entra il sacerdote in casella 1, poi il Gemello prenotato.
  if (livelloCorrente === 3) {
    await inserisciGemelloPendente(turno.numero_turno);
  }

  await db.incrementSacerdotiEntrati(turno.id);

  // 5. Ricalcola sacerdoti entrati aggiornato
  const turnoAggiornato = await pg.queryOne('SELECT sacerdoti_entrati FROM turni WHERE id = $1', [turno.id]);
  const entrati = Number(turnoAggiornato?.sacerdoti_entrati) || 0;

  // 6. PROGRESSIONE SACERDOTI (i sacerdoti avanzano con il Faraone)
  //
  // Quando Anubis è completo (2° sacerdote entrato):
  //   i 2 sacerdoti di Anubis progrediscono a Horus come PROGREDITO.
  //   Risultato a Horus: 2 progrediti + 4 nuovi (sacerdoti 3-6) = 6 totali.
  //
  // Quando Horus è completo (6° sacerdote entrato):
  //   i 6 sacerdoti di Horus (2 progrediti + 4 nuovi) progrediscono a Rha come PROGREDITO.
  //   Risultato a Rha: 6 progrediti + 12 nuovi (sacerdoti 7-18) = 18 totali.

  if (livelloCorrente === 1 && entrati === 2) {
    // Anubis completato → progressione dei 2 sacerdoti verso Horus
    console.log('\n   🏛️ ANUBIS COMPLETATO → progressione sacerdoti a Horus');
    if (turno.numero_turno === 1) {
      await tableManager.avanzaAnubisAHorusPrimoTurnoStrutturale(
        turno.numero_turno,
        turno.faraone_wallet,
        null,
        faraoneIdentity
      );
    } else {
      await tableManager.avanzaSacerdotiAlLivello(
        1, 2, turno.numero_turno, turno.faraone_wallet, null, faraoneIdentity
      );
    }

    if (turno.numero_turno > 1) {
      // Dopo la tavola principale Horus vengono materializzate
      // le due tavole Horus delle Funzioni previste dall'Excel.
      await materializzaFunzioniNelNuovoTurno(
        turno,
        turno.faraone_wallet
      );

      console.log('\n   🏛️ HORUS COMPLETATO → progressione a Rha');
      await tableManager.avanzaHorusARhaStrutturale(
        turno.numero_turno,
        turno.faraone_wallet,
        null,
        faraoneIdentity
      );
    }
  }

  if (
    turno.numero_turno === 1
    && livelloCorrente === 2
    && entrati === 6
  ) {
    // Primo turno: Horus si completa con 2 progrediti e 4 nuovi sacerdoti.
    console.log('\n   🏛️ HORUS COMPLETATO → progressione sacerdoti a Rha');
    await tableManager.avanzaHorusARhaStrutturale(
      turno.numero_turno,
      turno.faraone_wallet,
      null,
      faraoneIdentity
    );
  }

  // 7. Se turno completato (18 sacerdoti totali) → Faraone esce da L3
  if (entrati >= turno.sacerdoti_necessari) {
    await gestisciUscitaFaraone(turno);
  }

  return {
    success: true,
    sacerdote: { wallet: sacerdote.wallet, ticket: sacerdote.ticket_number, nome },
    livello: livelloCorrente,
    tavola: { numero: tavolaAttiva.numero, completa: risultato.tavolaCompleta },
    entrati,
    necessari: turno.sacerdoti_necessari,
    sdoppiamento: risultato.tavolaSdoppiamento ? { numero: risultato.tavolaSdoppiamento.numero } : null
  };
}

// ========================================
// BLOCCO 2 — L4 THOT (reg.12-13)
// ========================================

/**
 * Posiziona un Faraone Secondario (Perpetuo o Gemello) nel livello 4 (Thot).
 * Viene chiamato AUTOMATICAMENTE quando l'account esce da L3.
 * Il Faraone NON fa una nuova tx blockchain: usa i 5.000€ già trattenuti da L3.
 *
 * Struttura L4: tavola a 3 caselle, 3 Faraoni x 5.000 = 15.000
 * All'uscita (reg.13): -10.000 per L5 -500 umanitari -500 per 5 rientri Entrata = 4.000 netto
 */
async function posizionaFaraoneInL4(wallet, nome, client = null, accountIdentity = null) {
  const pg = require('./pg-connection-manager');

  const account = await resolveFlowAccount({
    wallet,
    accountId: accountIdentity?.accountId || null,
    accountSigla: accountIdentity?.accountSigla || null,
    context: 'Ingresso THOT Secondario',
    requireIdentity: true
  }, client);
  rules.validaAccountSecondario(account.tipo, 'Thot');

  const turno = await db.getTurnoCorrente('PHARAOH', 4, client);
  if (!turno) {
    console.log(`   ⚠️  Nessun turno L4 attivo — ${nome} in attesa`);
    return null;
  }
  if (Number(turno.sacerdoti_necessari) !== 3) {
    throw new Error(`Turno Thot ${turno.id} non valido: la tavola deve avere tre partecipanti`);
  }
  const faraoneIdentity = identityFromTurno(turno);

  let tavola = await tableManager.getTavolaPercorsoAttiva(4, turno.numero_turno, client);
  if (!tavola) {
    tavola = await tableManager.creaTavolaPercorso(
      4,
      turno.faraone_wallet,
      turno.numero_turno,
      null,
      client,
      faraoneIdentity
    );
  }

  console.log(`   ⛩️  Faraone Secondario ${account.sigla || account.id} → L4 THOT tavola #${tavola.numero}`);

  const risultato = await tableManager.posizionaDonatore({
    tavolaId:     tavola.id,
    tavolaNumero: tavola.numero,
    livello:      4,
    wallet:       account.wallet,
    nome,
    tipo:         'DONATORE',
    donoImporto:  rules.IMPORTI.TRATTENUTA_L4_INGRESSO,
    turno:        turno.numero_turno,
    sdoppiabile:  true,
    capacitaTavola: 3,
    accountId: account.id,
    accountSigla: account.sigla || null,
    client
  });

  await db.incrementSacerdotiEntrati(turno.id, client);

  const entratiRow = client
    ? (await client.query('SELECT sacerdoti_entrati FROM turni WHERE id = $1', [turno.id])).rows[0] || null
    : await pg.queryOne('SELECT sacerdoti_entrati FROM turni WHERE id = $1', [turno.id]);
  const entrati = Number(entratiRow?.sacerdoti_entrati) || 0;

  console.log(`   Faraoni a Thot: ${entrati}/${turno.sacerdoti_necessari}`);

  if (entrati >= turno.sacerdoti_necessari) {
    console.log(`\n   🏆 THOT COMPLETATO (${entrati}/${turno.sacerdoti_necessari}) → FARAONE ESCE DA L4`);
    await gestisciUscitaFaraoneL4(turno, client);
  }

  return { tavola, risultato, entrati, accountId: account.id, accountSigla: account.sigla || null };
}

/**
 * Gestisce l'uscita del Faraone dal livello 4 (Thot) - reg.13
 *   15.000 ricevuti: -10.000 per L5 -500 umanitari -500 per 5 rientri Entrata = 4.000 netto
 */
function buildUscitaThotEventKey(turno, wallet) {
  const numeroTurno = Number(turno?.numero_turno);
  const w = String(wallet || '').trim().toLowerCase();
  if (!Number.isInteger(numeroTurno) || numeroTurno < 1 || !w) {
    throw new Error('Dati mancanti per la chiave idempotente di uscita Thot');
  }
  return `PHARAOH:L4:${numeroTurno}:${w}:USCITA_L4`;
}

async function gestisciUscitaFaraoneL4(turno, client = null) {
  if (client) {
    return await gestisciUscitaFaraoneL4Atomica(turno, client);
  }

  const pg = require('./pg-connection-manager');
  const txClient = await pg.getClient();
  try {
    await txClient.query('BEGIN');
    const risultato = await gestisciUscitaFaraoneL4Atomica(turno, txClient);
    await txClient.query('COMMIT');
    return risultato;
  } catch (err) {
    try {
      await txClient.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    txClient.release();
  }
}

async function gestisciUscitaFaraoneL4Atomica(turno, client) {
  if (!turno?.id) throw new Error('Turno Thot mancante o privo di id');
  const faraoneWallet = String(turno.faraone_wallet || '').toLowerCase();
  const eventKey = buildUscitaThotEventKey(turno, faraoneWallet);

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)) AS locked', [eventKey]);
  const turnoCorrente = await client.query(
    'SELECT * FROM turni WHERE id = $1 FOR UPDATE',
    [turno.id]
  );
  const statoTurno = turnoCorrente.rows[0];
  if (!statoTurno) throw new Error(`Turno Thot non trovato: ${turno.id}`);
  if (statoTurno.status === 'COMPLETATO') {
    const storico = await client.query('SELECT * FROM storico_avanzamenti WHERE event_key = $1 LIMIT 1', [eventKey]);
    const record = storico.rows[0];
    if (!record) throw new Error(`Turno Thot completato senza storico idempotente: ${eventKey}`);
    let dettagli = record.dettagli || {};
    if (typeof dettagli === 'string') dettagli = JSON.parse(dettagli);
    return { uscita: dettagli.uscita || null, thotAllocation: dettagli.thotAllocation || null, eventKey, idempotent: true };
  }

  const account = await resolveTurnFaraone(statoTurno, 'Uscita THOT', client, true);
  const classificazione = rules.validaAccountSecondario(account.tipo, 'Thot');
  const tipoAccount = classificazione.tipo;
  const accountIdentity = identityFromAccount(account);
  const doniRicevuti = rules.IMPORTI.DONO_TOTALE_L4;
  const uscita = rules.calcolaUscitaLivello(4, tipoAccount, doniRicevuti);

  console.log(`\n🏆 ========================================`);
  console.log(`   USCITA DAL LIVELLO 4 (THOT)`);
  console.log(`========================================`);
  console.log(`   Account  : ${account.sigla || account.id}`);
  console.log(`   Wallet   : ${faraoneWallet}`);
  console.log(`   Ricevuti : ${doniRicevuti}`);
  console.log(`   → L5 ingresso          : ${uscita.trattenutaIngressoL5}`);
  console.log(`   → Progetti umanitari   : ${uscita.trattenutaProgettiUmanitari}`);
  console.log(`   → 5 rientri Entrata    : ${uscita.trattenutaRientriEntrata}`);
  console.log(`   → Netto                : ${uscita.netto}`);

  const thotAllocation = await functionManager.rilasciaFunzioniL4({
    faraoneWallet,
    faraoneAccountId: account.id,
    faraoneSigla: account.sigla || null,
    turnoCorrente: statoTurno.numero_turno,
    eventKey,
    cassaWallet: CASSA_PHARAOH_WALLET
  }, client);

  await db.registraAvanzamento({
    wallet: faraoneWallet,
    accountId: account.id,
    accountSigla: account.sigla || null,
    tipoAccount,
    daLivello: 4,
    aLivello: 5,
    daBlocco: 2,
    aBlocco: 2,
    turno: statoTurno.numero_turno,
    doniRicevuti,
    doniTrattenuti:
      uscita.trattenutaIngressoL5 +
      uscita.trattenutaProgettiUmanitari +
      uscita.trattenutaRientriEntrata,
    netto: uscita.netto,
    evento: 'USCITA_L4',
    dettagli: { uscita, thotAllocation, esitoPercorso: 'PASSAGGIO_L5' },
    eventKey
  }, client);

  await payoutManager.createPendingGift({
    wallet: faraoneWallet,
    accountId: account.id,
    accountSigla: account.sigla || null,
    importo: uscita.netto,
    livello: 4,
    tipoUscita: 'USCITA_L4',
    tipoAccount,
    turno: statoTurno.numero_turno,
    dettagli: { uscita, thotAllocation },
    eventKey
  }, client);

  await db.completaTurno(statoTurno.id, doniRicevuti, client);
  await avviaNextTurnoL4(statoTurno, client);

  const nomeErede = account.nome || faraoneWallet.substring(0, 10);
  await posizionaFaraoneInL5(faraoneWallet, nomeErede, client, accountIdentity);

  console.log(`========================================\n`);
  return { uscita, thotAllocation, eventKey, idempotent: false };
}

/**
 * Avvia il prossimo turno L4 dopo l'uscita del Faraone corrente.
 * La prossima tavola viene dalla prima sdoppiatura disponibile al livello 4.
 */
async function avviaNextTurnoL4(turnoChiuso, client = null) {
  const pg = require('./pg-connection-manager');
  const nuovoNumeroTurno = turnoChiuso.numero_turno + 1;
  const selectSql = `SELECT * FROM tavole
     WHERE tipo = 'SDOPPIAMENTO' AND status = 'APERTA' AND livello = 4
     ORDER BY numero ASC LIMIT 1`;
  const prossimaTavola = client
    ? (await client.query(selectSql)).rows[0] || null
    : await pg.queryOne(selectSql);

  if (!prossimaTavola) {
    console.log('⚠️  Nessuna tavola L4 sdoppiata disponibile per il prossimo turno');
    return;
  }
  if (!prossimaTavola.faraone_account_id) {
    throw new Error(`Tavola L4 ${prossimaTavola.id} senza identita Secondario`);
  }
  const nextAccount = await db.getAccountByIdentity({
    accountId: prossimaTavola.faraone_account_id,
    wallet: prossimaTavola.faraone_wallet,
    sigla: prossimaTavola.faraone_sigla || null
  }, client);
  if (!nextAccount) throw new Error(`Identita prossimo Faraone L4 non risolta: tavola ${prossimaTavola.id}`);
  rules.validaAccountSecondario(nextAccount.tipo, 'Thot');

  const updateSql = `UPDATE tavole SET tipo = 'PERCORSO', turno = $1 WHERE id = $2`;
  if (client) await client.query(updateSql, [nuovoNumeroTurno, prossimaTavola.id]);
  else await pg.query(updateSql, [nuovoNumeroTurno, prossimaTavola.id]);

  await db.createTurno({
    sezione: 'PHARAOH', livello: 4, blocco: 2,
    numeroTurno: nuovoNumeroTurno,
    faraoneWallet: nextAccount.wallet,
    faraoneTipo: 'SECONDARIO',
    faraoneAccountId: nextAccount.id,
    faraoneSigla: nextAccount.sigla || null,
    tavolaFaraoneNum: prossimaTavola.numero,
    sacerdotiNecessari: 3
  }, client);

  console.log(`\n🔄 Nuovo turno L4 #${nuovoNumeroTurno} — Faraone: ${nextAccount.sigla || nextAccount.id} / ${nextAccount.wallet.substring(0, 10)}`);
}

// ========================================
// BLOCCO 2 — L5 ISIDE (reg.14)
// ========================================

/**
 * Posiziona il Faraone nel livello 5 (Iside).
 * Viene chiamato AUTOMATICAMENTE dopo l'uscita da L4.
 *
 * Struttura L5: tavola a 3 caselle, 3 Faraoni × 10.000 = 30.000
 * All'uscita (reg.14): 5.000 in 50 rientri Entrata + 6.000 dono + 19.000 netto base = 25.000 payout
 */
async function posizionaFaraoneInL5(wallet, nome, client = null, accountIdentity = null) {
  const pg = require('./pg-connection-manager');

  const account = await resolveFlowAccount({
    wallet,
    accountId: accountIdentity?.accountId || null,
    accountSigla: accountIdentity?.accountSigla || null,
    context: 'Ingresso ISIDE Secondario',
    requireIdentity: true
  }, client);
  rules.validaAccountSecondario(account.tipo, 'Iside');

  const turno = await db.getTurnoCorrente('PHARAOH', 5, client);
  if (!turno) {
    console.log(`   ⚠️  Nessun turno L5 attivo — ${nome} in attesa`);
    return null;
  }
  if (Number(turno.sacerdoti_necessari) !== 3) {
    throw new Error(`Turno Iside ${turno.id} non valido: la tavola deve avere tre partecipanti`);
  }
  const faraoneIdentity = identityFromTurno(turno);
  let tavola = await tableManager.getTavolaPercorsoAttiva(5, turno.numero_turno, client);
  if (!tavola) {
    tavola = await tableManager.creaTavolaPercorso(
      5,
      turno.faraone_wallet,
      turno.numero_turno,
      null,
      client,
      faraoneIdentity
    );
  }

  console.log(`   🔱  Faraone Secondario ${account.sigla || account.id} → L5 ISIDE tavola #${tavola.numero}`);

  const risultato = await tableManager.posizionaDonatore({
    tavolaId:     tavola.id,
    tavolaNumero: tavola.numero,
    livello:      5,
    wallet:       account.wallet,
    nome,
    tipo:         'DONATORE',
    donoImporto:  rules.IMPORTI.TRATTENUTA_L5_INGRESSO,
    turno:        turno.numero_turno,
    sdoppiabile:  true,
    capacitaTavola: 3,
    accountId: account.id,
    accountSigla: account.sigla || null,
    client
  });

  await db.incrementSacerdotiEntrati(turno.id, client);

  const entratiRow = client
    ? (await client.query('SELECT sacerdoti_entrati FROM turni WHERE id = $1', [turno.id])).rows[0] || null
    : await pg.queryOne('SELECT sacerdoti_entrati FROM turni WHERE id = $1', [turno.id]);
  const entrati = Number(entratiRow?.sacerdoti_entrati) || 0;

  console.log(`   Faraoni a Iside: ${entrati}/${turno.sacerdoti_necessari}`);
  if (entrati >= turno.sacerdoti_necessari) {
    console.log(`\n   🏆 ISIDE COMPLETATO (${entrati}/${turno.sacerdoti_necessari}) → FARAONE ESCE DEFINITIVAMENTE`);
    await gestisciUscitaFaraoneL5(turno, client);
  }

  return { tavola, risultato, entrati, accountId: account.id, accountSigla: account.sigla || null };
}

/**
 * Gestisce l'uscita definitiva del Faraone dal livello 5 (Iside) — reg.14
 *   30.000 ricevuti: 5.000 in 50 rientri + 25.000 payout (19.000 netto base + 6.000 dono)
 */
function buildUscitaIsideEventKey(turno, wallet) {
  const numeroTurno = Number(turno?.numero_turno);
  const w = String(wallet || '').trim().toLowerCase();
  if (!Number.isInteger(numeroTurno) || numeroTurno < 1 || !w) {
    throw new Error('Dati mancanti per la chiave idempotente di uscita Iside');
  }
  return `PHARAOH:L5:${numeroTurno}:${w}:USCITA_L5`;
}

async function gestisciUscitaFaraoneL5(turno, client = null) {
  if (client) {
    return await gestisciUscitaFaraoneL5Atomica(turno, client);
  }

  const pg = require('./pg-connection-manager');
  const txClient = await pg.getClient();
  try {
    await txClient.query('BEGIN');
    const risultato = await gestisciUscitaFaraoneL5Atomica(turno, txClient);
    await txClient.query('COMMIT');
    return risultato;
  } catch (err) {
    try {
      await txClient.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    txClient.release();
  }
}

async function gestisciUscitaFaraoneL5Atomica(turno, client) {
  if (!turno?.id) throw new Error('Turno Iside mancante o privo di id');
  const faraoneWallet = String(turno.faraone_wallet || '').toLowerCase();
  const eventKey = buildUscitaIsideEventKey(turno, faraoneWallet);

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)) AS locked', [eventKey]);
  const turnoCorrente = await client.query('SELECT * FROM turni WHERE id = $1 FOR UPDATE', [turno.id]);
  const statoTurno = turnoCorrente.rows[0];
  if (!statoTurno) throw new Error(`Turno Iside non trovato: ${turno.id}`);
  if (statoTurno.status === 'COMPLETATO') {
    const storico = await client.query('SELECT * FROM storico_avanzamenti WHERE event_key = $1 LIMIT 1', [eventKey]);
    const record = storico.rows[0];
    if (!record) throw new Error(`Turno Iside completato senza storico idempotente: ${eventKey}`);
    let dettagli = record.dettagli || {};
    if (typeof dettagli === 'string') dettagli = JSON.parse(dettagli);
    return { uscita: dettagli.uscita || null, isideAllocation: dettagli.isideAllocation || null, eventKey, idempotent: true };
  }

  const account = await resolveTurnFaraone(statoTurno, 'Uscita ISIDE', client, true);
  const classificazione = rules.validaAccountSecondario(account.tipo, 'Iside');
  const tipoAccount = classificazione.tipo;
  const doniRicevuti = rules.IMPORTI.DONO_TOTALE_L5;
  const uscita = rules.calcolaUscitaLivello(5, tipoAccount, doniRicevuti);

  console.log('\nISIDE - USCITA DEFINITIVA L5');
  console.log(`   Account     : ${account.sigla || account.id}`);
  console.log(`   Wallet      : ${faraoneWallet}`);
  console.log(`   Ricevuti    : ${doniRicevuti}`);
  console.log(`   50 rientri  : ${uscita.trattenutaRientriEntrata}`);
  console.log(`   Netto base  : ${uscita.nettoBase}`);
  console.log(`   Quota diretta: ${uscita.quotaRicevente}`);
  console.log(`   Payout      : ${uscita.payoutRicevente}`);

  const isideAllocation = await functionManager.rilasciaFunzioniL5({
    faraoneWallet,
    faraoneAccountId: account.id,
    faraoneSigla: account.sigla || null,
    turnoCorrente: statoTurno.numero_turno,
    eventKey,
    cassaWallet: CASSA_PHARAOH_WALLET
  }, client);

  await db.registraAvanzamento({
    wallet: faraoneWallet,
    accountId: account.id,
    accountSigla: account.sigla || null,
    tipoAccount,
    daLivello: 5,
    aLivello: null,
    daBlocco: 2,
    aBlocco: null,
    turno: statoTurno.numero_turno,
    doniRicevuti,
    doniTrattenuti: uscita.trattenutaRientriEntrata,
    netto: uscita.payoutRicevente,
    evento: 'USCITA_L5',
    dettagli: {
      uscita,
      isideAllocation,
      esitoPercorso: 'USCITA_DEFINITIVA',
      payoutBreakdown: {
        nettoBaseUsdc: uscita.nettoBase,
        donoRiceventeUsdc: uscita.quotaRicevente,
        payoutTotaleUsdc: uscita.payoutRicevente
      }
    },
    eventKey
  }, client);

  await payoutManager.createPendingGift({
    wallet: faraoneWallet,
    accountId: account.id,
    accountSigla: account.sigla || null,
    importo: uscita.payoutRicevente,
    livello: 5,
    tipoUscita: 'USCITA_L5',
    tipoAccount,
    turno: statoTurno.numero_turno,
    dettagli: {
      uscita,
      nettoBaseUsdc: uscita.nettoBase,
      donoRiceventeUsdc: uscita.quotaRicevente,
      payoutTotaleUsdc: uscita.payoutRicevente,
      isideAllocationEventKey: isideAllocation.eventKey
    },
    eventKey
  }, client);

  await db.completaTurno(statoTurno.id, doniRicevuti, client);
  await avviaNextTurnoL5(statoTurno, client);

  console.log(`ISIDE: ricevente ${faraoneWallet.substring(0, 10)} payout ${uscita.payoutRicevente} USDC`);
  console.log(`   19.000 netto base + 6.000 quota diretta + 5.000 in 50 rientri = ${doniRicevuti} USDC`);

  return { uscita, isideAllocation, eventKey, idempotent: false };
}

/**
 * Avvia il prossimo turno L5 dopo l'uscita del Faraone corrente.
 */
async function avviaNextTurnoL5(turnoChiuso, client = null) {
  const pg = require('./pg-connection-manager');
  const nuovoNumeroTurno = turnoChiuso.numero_turno + 1;

  const selectSql = `SELECT * FROM tavole
     WHERE tipo = 'SDOPPIAMENTO' AND status = 'APERTA' AND livello = 5
     ORDER BY numero ASC LIMIT 1`;
  const prossimaTavola = client
    ? (await client.query(selectSql)).rows[0] || null
    : await pg.queryOne(selectSql);

  if (!prossimaTavola) {
    console.log('⚠️  Nessuna tavola L5 sdoppiata disponibile per il prossimo turno');
    return;
  }
  if (!prossimaTavola.faraone_account_id) {
    throw new Error(`Tavola L5 ${prossimaTavola.id} senza identita Secondario`);
  }
  const nextAccount = await db.getAccountByIdentity({
    accountId: prossimaTavola.faraone_account_id,
    wallet: prossimaTavola.faraone_wallet,
    sigla: prossimaTavola.faraone_sigla || null
  }, client);
  if (!nextAccount) throw new Error(`Identita prossimo Faraone L5 non risolta: tavola ${prossimaTavola.id}`);
  rules.validaAccountSecondario(nextAccount.tipo, 'Iside');

  const updateSql = `UPDATE tavole SET tipo = 'PERCORSO', turno = $1 WHERE id = $2`;
  if (client) await client.query(updateSql, [nuovoNumeroTurno, prossimaTavola.id]);
  else await pg.query(updateSql, [nuovoNumeroTurno, prossimaTavola.id]);

  await db.createTurno({
    sezione: 'PHARAOH', livello: 5, blocco: 2,
    numeroTurno: nuovoNumeroTurno,
    faraoneWallet: nextAccount.wallet,
    faraoneTipo: 'SECONDARIO',
    faraoneAccountId: nextAccount.id,
    faraoneSigla: nextAccount.sigla || null,
    tavolaFaraoneNum: prossimaTavola.numero,
    sacerdotiNecessari: 3
  }, client);

  console.log(`\n🔄 Nuovo turno L5 #${nuovoNumeroTurno} — Faraone: ${nextAccount.sigla || nextAccount.id} / ${nextAccount.wallet.substring(0, 10)}`);
}

// ========================================
// USCITA FARAONE
// ========================================

/**
 * Gestisce l'uscita del Faraone dal Blocco 1 (livello 3 Rha).
 *
 * 🇮🇩 ZK-KYC CHECKPOINT — il payout è gestito tramite dono pendente:
 * la verifica KYC blocca l'accettazione del dono (non la creazione).
 */
function buildUscitaRhaEventKey(turno, wallet) {
  const numeroTurno = Number(turno?.numero_turno);
  const w = String(wallet || '').trim().toLowerCase();
  if (!Number.isInteger(numeroTurno) || numeroTurno < 1 || !w) {
    throw new Error('Dati mancanti per la chiave idempotente di uscita Rha');
  }
  return `PHARAOH:L3:${numeroTurno}:${w}:USCITA_L3`;
}

async function gestisciUscitaFaraone(turno, client = null) {
  if (client) {
    return await gestisciUscitaFaraoneAtomica(turno, client);
  }

  const pg = require('./pg-connection-manager');
  const txClient = await pg.getClient();
  try {
    await txClient.query('BEGIN');
    const risultato = await gestisciUscitaFaraoneAtomica(turno, txClient);
    await txClient.query('COMMIT');
    return risultato;
  } catch (err) {
    try {
      await txClient.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    txClient.release();
  }
}

async function gestisciUscitaFaraoneAtomica(turno, client) {
  if (!turno?.id) throw new Error('Turno Rha mancante o privo di id');
  const faraoneWallet = String(turno.faraone_wallet || '').toLowerCase();
  const eventKey = buildUscitaRhaEventKey(turno, faraoneWallet);

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)) AS locked', [eventKey]);
  const turnoCorrente = await client.query('SELECT * FROM turni WHERE id = $1 FOR UPDATE', [turno.id]);
  const statoTurno = turnoCorrente.rows[0];
  if (!statoTurno) throw new Error(`Turno Rha non trovato: ${turno.id}`);
  if (statoTurno.status === 'COMPLETATO') {
    const storico = await client.query('SELECT * FROM storico_avanzamenti WHERE event_key = $1 LIMIT 1', [eventKey]);
    const record = storico.rows[0];
    if (!record) throw new Error(`Turno Rha completato senza storico idempotente: ${eventKey}`);
    let dettagli = record.dettagli || {};
    if (typeof dettagli === 'string') dettagli = JSON.parse(dettagli);
    return {
      uscita: dettagli.uscita || null,
      funzioni: null,
      crossMovements: dettagli.crossMovements || null,
      rhaAllocation: dettagli.rhaAllocation || null,
      eventKey,
      idempotent: true
    };
  }

  const account = await resolveTurnFaraone(statoTurno, 'Uscita RHA', client, false);
  const classificazione = rules.classificaAccountRha(account.tipo);
  const tipoAccount = classificazione.tipo;
  if (!['PRIMARIO', 'SECONDARIO'].includes(classificazione.categoria)) {
    throw new Error(`Categoria account RHA non supportata per cross-movements: ${classificazione.categoria}`);
  }
  if (classificazione.categoria === 'SECONDARIO' && !statoTurno.faraone_account_id) {
    throw new Error('Uscita RHA Secondario senza account_id: impossibile distinguere percorsi sul wallet condiviso');
  }
  const sigla = account.sigla || FONDO_SIGLA;
  const doniRicevuti = rules.IMPORTI.DONO_TOTALE_L3;

  console.log(`\n🏆 ========================================`);
  console.log(`   USCITA FARAONE DAL LIVELLO 3 (RHA)`);
  console.log(`========================================`);
  console.log(`   Faraone: ${sigla} (${tipoAccount})`);
  console.log(`   Account ID: ${account.id}`);
  console.log(`   Wallet: ${faraoneWallet}`);

  const uscita = rules.calcolaUscitaLivello(3, tipoAccount, doniRicevuti);
  console.log(`   Doni ricevuti: ${doniRicevuti}`);
  console.log(`   Trattenuta RHA (3.000€): ${uscita.trattenutaCassa} → include quota cross 500 (300 ROG + 200 URANUS)`);
  console.log(`   Netto Faraone: ${uscita.netto}`);

  const funzioni = await functionManager.rilasciaFunzioniL3({
    faraoneWallet,
    faraoneAccountId: account.id,
    faraoneSigla: sigla,
    tipoAccount,
    turnoCorrente: statoTurno.numero_turno
  }, client);

  const crossMovements = await crossOutbound.scheduleRhaExit({
    rhaEventKey: eventKey,
    beneficiaryWallet: faraoneWallet,
    accountId: account.id,
    accountSigla: sigla,
    turno: statoTurno.numero_turno
  }, client);

  try {
    const alerts = require('./alert-manager');
    alerts.alertPayout(faraoneWallet, uscita.netto, statoTurno.numero_turno);
  } catch (_) {}

  await db.registraAvanzamento({
    wallet: faraoneWallet,
    accountId: account.id,
    accountSigla: sigla,
    tipoAccount,
    daLivello: 3,
    aLivello: uscita.passaAlL4 ? 4 : null,
    daBlocco: 1,
    aBlocco: uscita.passaAlL4 ? 2 : null,
    turno: statoTurno.numero_turno,
    doniRicevuti,
    doniTrattenuti: (uscita.trattenutaCassa || 0) + (uscita.trattenutaIngressoL4 || 0),
    netto: uscita.netto,
    evento: 'USCITA_L3',
    dettagli: {
      uscita,
      esitoPercorso: uscita.uscitaDefinitiva ? 'USCITA_DEFINITIVA' : 'PASSAGGIO_L4',
      funzioni: {
        simbionti: funzioni.simbionti.length,
        perpetuo: !!funzioni.perpetuo,
        gemello: !!funzioni.gemello
      },
      rhaAllocation: crossMovements.allocation,
      crossMovements: crossMovements.operations
    },
    eventKey
  }, client);

  await payoutManager.createPendingGift({
    wallet: faraoneWallet,
    accountId: account.id,
    accountSigla: sigla,
    importo: uscita.netto,
    livello: 3,
    tipoUscita: 'USCITA_L3',
    tipoAccount,
    turno: statoTurno.numero_turno,
    dettagli: { uscita },
    eventKey
  }, client);

  if (uscita.passaAlL4) {
    console.log(`   ➡️  Secondario ${sigla}: passa a L4 Thot con ${uscita.trattenutaIngressoL4}€`);
    const nomeErede = account.nome || faraoneWallet.substring(0, 10);
    await posizionaFaraoneInL4(faraoneWallet, nomeErede, client, identityFromAccount(account));
  } else {
    console.log(`   🏁 Account Primario esce definitivamente con ${uscita.netto}`);
  }

  await db.completaTurno(statoTurno.id, doniRicevuti, client);
  await avviaNuovoTurnoPharaoh(statoTurno, client);

  console.log(`========================================\n`);
  return {
    uscita,
    funzioni,
    crossMovements: crossMovements.operations,
    rhaAllocation: crossMovements.allocation,
    eventKey,
    idempotent: false
  };
}

// ========================================
// GEMELLO LAZY INSERTION (reg.6, reg.9)
// ========================================
async function getFunzioneById(funzioneId) {
  const pg = require('./pg-connection-manager');
  return await pg.queryOne('SELECT * FROM funzioni WHERE id = $1', [funzioneId]);
}

function buildSimWallet(turnoNum, index) {
  return `0x${turnoNum.toString().padStart(8,'0')}SIM${index.toString().padStart(10,'0')}`.substring(0,42).padEnd(42,'0');
}

function inferSimIndexFromPrenotazione(prenotazione) {
  if (Number(prenotazione.tavola_relativa) === 1 && Number(prenotazione.casella) === 1) return 1;
  if (Number(prenotazione.tavola_relativa) === 1 && Number(prenotazione.casella) === 2) return 2;
  if (Number(prenotazione.tavola_relativa) === 2 && Number(prenotazione.casella) === 1) return 3;
  return null;
}

function buildPosizioneLabel(livello, tavolaRelativa, casella) {
  if (livello === 2) return `HORUS_TAV${tavolaRelativa}_POS${casella}`;
  if (livello === 3) return `RHA_TAV${tavolaRelativa}_POS${casella}`;
  return `L${livello}_TAV${tavolaRelativa}_POS${casella}`;
}

async function materializzaPrenotazioneSuTavola({ prenotazione, tavola, livello, turnoNum }, client = null) {
  const pg = require('./pg-connection-manager');

  if (!prenotazione) return null;

  const dbClient = client || await pg.getClient();
  const shouldManageTx = !client;
  try {
    if (shouldManageTx) {
      await dbClient.query('BEGIN');
    }

    const locked = await dbClient.query(
      `SELECT * FROM prenotazioni_funzioni WHERE id = $1 FOR UPDATE`,
      [prenotazione.id]
    );
    const corrente = locked.rows[0];
    if (!corrente) {
      if (shouldManageTx) {
        await dbClient.query('ROLLBACK');
      }
      return null;
    }

    if (corrente.funzione_id !== prenotazione.funzione_id) {
      throw new Error(`Prenotazione ${corrente.id} non coerente con funzione attesa`);
    }
    if (Number(corrente.turno_destinazione) !== Number(turnoNum)) {
      throw new Error(`Prenotazione ${corrente.id} non appartiene al turno ${turnoNum}`);
    }
    if (Number(corrente.livello_destinazione) !== Number(livello)) {
      throw new Error(`Prenotazione ${corrente.id} non appartiene al livello ${livello}`);
    }
    if (Number(corrente.tavola_relativa) !== Number(prenotazione.tavola_relativa)) {
      throw new Error(`Prenotazione ${corrente.id} tavola_relativa non coerente`);
    }
    if (Number(corrente.casella) !== Number(prenotazione.casella)) {
      throw new Error(`Prenotazione ${corrente.id} casella non coerente`);
    }

    if (corrente.stato === 'MATERIALIZED') {
      const posizione = await dbClient.query(
        `SELECT * FROM posizioni WHERE id = $1`,
        [corrente.posizione_id]
      );
      if (shouldManageTx) {
        await dbClient.query('COMMIT');
      }
      return posizione.rows[0] || null;
    }

    if (corrente.stato !== 'RESERVED') {
      throw new Error(`Prenotazione ${corrente.id} in stato ${corrente.stato}`);
    }

    const funzioneRes = await dbClient.query(
      'SELECT * FROM funzioni WHERE id = $1',
      [corrente.funzione_id]
    );
    const funzione = funzioneRes.rows[0];
    const tipoFunzione = corrente.tipo_funzione;
    const casella = Number(corrente.casella);
    const tavolaRelativa = Number(corrente.tavola_relativa);
    const posizioneLabel = buildPosizioneLabel(livello, tavolaRelativa, casella);

    const expectedWallet = tipoFunzione === 'SIMBIONTE'
      ? buildSimWallet(turnoNum, inferSimIndexFromPrenotazione(corrente))
      : corrente.account_destinazione_wallet;

    if (!expectedWallet) {
      throw new Error(`Wallet atteso mancante per prenotazione ${corrente.id}`);
    }

    let destinationAccount = null;
    if (tipoFunzione !== 'SIMBIONTE') {
      if (!corrente.account_destinazione_id) {
        throw new Error(`Prenotazione ${corrente.id} senza account_destinazione_id`);
      }
      destinationAccount = await db.getAccountByIdentity({
        accountId: corrente.account_destinazione_id,
        wallet: expectedWallet,
        sigla: funzione?.sigla || null
      }, dbClient);
      if (!destinationAccount) {
        throw new Error(`Identita destinazione funzione non risolta: prenotazione ${corrente.id}`);
      }
    }

    const posizioneEsistente = await dbClient.query(
      `SELECT * FROM posizioni WHERE tavola_id = $1 AND casella = $2`,
      [tavola.id, casella]
    );

    if (posizioneEsistente.rows[0]) {
      const existingMatches = posizioneEsistente.rows[0].wallet === expectedWallet.toLowerCase() &&
        (tipoFunzione === 'SIMBIONTE' ||
          Number(posizioneEsistente.rows[0].account_id) === Number(destinationAccount.id));
      if (existingMatches) {
        await dbClient.query(
          `UPDATE prenotazioni_funzioni
           SET stato = 'MATERIALIZED',
               posizione_id = $1,
               tavola_numero = $2,
               materialized_at = NOW(),
               updated_at = NOW()
           WHERE id = $3`,
          [posizioneEsistente.rows[0].id, tavola.numero, corrente.id]
        );
        if (funzione) {
          await dbClient.query(
            `UPDATE funzioni
             SET status = 'POSIZIONATO', tavola_posizionamento = $1, posizione_in_tavola = $2
             WHERE id = $3`,
            [tavola.numero, posizioneLabel, funzione.id]
          );
        }
        if (shouldManageTx) {
          await dbClient.query('COMMIT');
        }
        return posizioneEsistente.rows[0];
      }

      await dbClient.query(
        `UPDATE prenotazioni_funzioni
         SET stato = 'ERROR', updated_at = NOW()
         WHERE id = $1`,
        [corrente.id]
      );
      if (shouldManageTx) {
        await dbClient.query('COMMIT');
      }
      return null;
    }

    if (tipoFunzione === 'SIMBIONTE') {
      const simIndex = inferSimIndexFromPrenotazione(corrente);
      if (!simIndex) {
        throw new Error(`Prenotazione Simbionte non valida: ${corrente.id}`);
      }

      const posizioneRes = await dbClient.query(
        `INSERT INTO posizioni (tavola_id, casella, wallet, nome, tipo, dono_importo)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [tavola.id, casella, expectedWallet.toLowerCase(), funzione?.sigla || `SIM${simIndex}`, 'SIMBIONTE', rules.IMPORTI.DONO_PHARAOH]
      );
      const posizione = posizioneRes.rows[0];

      await dbClient.query(
        `UPDATE tavole SET doni_ricevuti = doni_ricevuti + $1 WHERE id = $2`,
        [rules.IMPORTI.DONO_PHARAOH, tavola.id]
      );

      await dbClient.query(
        `UPDATE prenotazioni_funzioni
         SET stato = 'MATERIALIZED',
             posizione_id = $1,
             tavola_numero = $2,
             materialized_at = NOW(),
             updated_at = NOW()
         WHERE id = $3`,
        [posizione.id, tavola.numero, corrente.id]
      );

      if (funzione) {
        await dbClient.query(
          `UPDATE funzioni
           SET status = 'POSIZIONATO', tavola_posizionamento = $1, posizione_in_tavola = $2
           WHERE id = $3`,
          [tavola.numero, posizioneLabel, funzione.id]
        );
      }

      if (shouldManageTx) {
        await dbClient.query('COMMIT');
      }
      return posizione;
    }

    const occupateRes = await dbClient.query(
      `SELECT COUNT(*) AS cnt FROM posizioni WHERE tavola_id = $1 AND tipo != $2`,
      [tavola.id, 'EREDE']
    );
    const occupate = Number(occupateRes.rows[0]?.cnt || 0);
    if (occupate + 1 !== casella) {
      if (shouldManageTx) {
        await dbClient.query('COMMIT');
      }
      return null;
    }

    const posizioneRes = await dbClient.query(
      `INSERT INTO posizioni (tavola_id, casella, wallet, nome, tipo, dono_importo, account_id, account_sigla)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        tavola.id, casella, expectedWallet.toLowerCase(),
        funzione?.sigla || expectedWallet.substring(0, 10),
        tipoFunzione, rules.IMPORTI.DONO_PHARAOH,
        destinationAccount.id, destinationAccount.sigla || funzione?.sigla || null
      ]
    );
    const posizione = posizioneRes.rows[0];

    await dbClient.query(
      `UPDATE tavole SET doni_ricevuti = doni_ricevuti + $1 WHERE id = $2`,
      [rules.IMPORTI.DONO_PHARAOH, tavola.id]
    );

    // Usa il numeratore PHARAOH centralizzato nella stessa transazione e
    // impedisce interferenze con la numerazione ENTRATA. L'irrobustimento
    // concorrente del numeratore resta nell'ambito specifico del Punto 11.
    const nextNumero = Number(
      await db.getNextTavolaNumero(dbClient, 'PHARAOH')
    );
    if (!Number.isInteger(nextNumero) || nextNumero < 1) {
      throw new Error('Numerazione PHARAOH non disponibile per lo sdoppiamento funzione');
    }
    const sdoppiamentoRes = await dbClient.query(
      `INSERT INTO tavole (
         numero, sezione, livello, blocco, tipo, capacita, faraone_wallet,
         faraone_account_id, faraone_sigla, turno
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        nextNumero,
        tavola.sezione,
        tavola.livello,
        tavola.blocco,
        'SDOPPIAMENTO',
        tavola.capacita,
        expectedWallet.toLowerCase(),
        destinationAccount.id,
        destinationAccount.sigla || funzione?.sigla || null,
        turnoNum
      ]
    );
    const tavolaSdoppiamento = sdoppiamentoRes.rows[0];

    await dbClient.query(
      `UPDATE posizioni SET sdoppiamento_tavola_id = $1 WHERE id = $2`,
      [tavolaSdoppiamento.id, posizione.id]
    );

    if (occupate + 1 >= Number(tavola.capacita || 0)) {
      await dbClient.query(
        `UPDATE tavole SET status = 'COMPLETATA' WHERE id = $1`,
        [tavola.id]
      );
    }

    await dbClient.query(
      `UPDATE prenotazioni_funzioni
       SET stato = 'MATERIALIZED',
           posizione_id = $1,
           tavola_numero = $2,
           materialized_at = NOW(),
           updated_at = NOW()
       WHERE id = $3`,
      [posizione.id, tavola.numero, corrente.id]
    );

    if (funzione) {
      await dbClient.query(
        `UPDATE funzioni
         SET status = 'POSIZIONATO', tavola_posizionamento = $1, posizione_in_tavola = $2
         WHERE id = $3`,
        [tavola.numero, posizioneLabel, funzione.id]
      );
    }

    if (shouldManageTx) {
      await dbClient.query('COMMIT');
    }
    return posizione;
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
}

/**
 * Inserisce il Gemello pendente nella seconda casella della settima tavola Rha (L3) del turno.
 *
 * Chiamato:
 *  - Subito dopo aver creato una nuova tavola Rha in posizionaSacerdoteInPharaoh
 *  - Dopo la progressione Horus→Rha in avanzaSacerdotiAlLivello
 *
 * Logica:
 *  1. Verifica se esiste una prenotazione Gemello RESERVED per questo turno
 *  2. Conta le tavole Rha PERCORSO per il turno corrente
 *  3. Se il conteggio raggiunge 7, inserisce il Gemello nella 7ª tavola, casella 2
 *
 * @param {number} turnoNum - Numero del turno corrente del Blocco 1
 */
async function inserisciGemelloPendente(turnoNum, client = null) {
  const pg = require('./pg-connection-manager');

  // 1. Recupera prenotazione Gemello RESERVED per questo turno
  const prenotazioneGemello = await db.getPrenotazioneByPosizione({
    turnoDestinazione: turnoNum,
    livelloDestinazione: 3,
    bloccoDestinazione: 1,
    tavolaRelativa: 7,
    casella: 2
  }, client);
  if (!prenotazioneGemello || prenotazioneGemello.stato !== 'RESERVED') return;

  // 2. Individua la tavola principale Rha del turno.
  // Nell'Excel ufficiale la numerazione relativa parte dalle tavole
  // strutturali successive alla tavola principale.
  const tavolaPrincipaleSql = `SELECT * FROM tavole
     WHERE livello = 3
       AND tipo = 'PERCORSO'
       AND turno = $1
     ORDER BY numero ASC
     LIMIT 1`;
  const tavolaRhaPrincipale = client
    ? (await client.query(tavolaPrincipaleSql, [turnoNum])).rows[0] || null
    : await pg.queryOne(tavolaPrincipaleSql, [turnoNum]);
  if (!tavolaRhaPrincipale) return;

  // 3. Recupera la 7ª tavola Rha successiva alla principale,
  // contando sia PERCORSO sia SDOPPIAMENTO.
  // Esempio Excel Faraone 1:
  // principale Tav.36 → successione Tav.37-43 → Gemello in Tav.43.
  const settimaSql = `SELECT * FROM tavole
     WHERE livello = 3
       AND turno = $1
       AND numero > $2
     ORDER BY numero ASC
     LIMIT 1 OFFSET 6`;
  const settimaTavola = client
    ? (await client.query(settimaSql, [turnoNum, tavolaRhaPrincipale.numero])).rows[0] || null
    : await pg.queryOne(settimaSql, [turnoNum, tavolaRhaPrincipale.numero]);
  if (!settimaTavola) return;

  // 4. Verifica che la casella 2 sia libera
  const casellaSql = `SELECT id FROM posizioni WHERE tavola_id = $1 AND casella = 2`;
  const casella2Occupata = client
    ? (await client.query(casellaSql, [settimaTavola.id])).rows[0] || null
    : await pg.queryOne(casellaSql, [settimaTavola.id]);
  if (casella2Occupata) {
    console.log(`   ⚠️  Casella 2 della 7ª tavola Rha #${settimaTavola.numero} già occupata — Gemello non inserito`);
    return;
  }

  console.log(`\n⚙️ INSERIMENTO GEMELLO PRENOTATO → Rha tavola #${settimaTavola.numero} casella 2`);

  const risultatoGem = await materializzaPrenotazioneSuTavola({
    prenotazione: prenotazioneGemello,
    tavola: settimaTavola,
    livello: 3,
    turnoNum
  }, client);

  if (risultatoGem) {
    console.log(`   ✅ Gemello prenotato → Rha tavola #${settimaTavola.numero} casella 2`);
  }
}

// ========================================
// AVVIO AUTOMATICO TURNO PHARAOH (reg.4)
// ========================================

/**
 * Avvia automaticamente il turno successivo del Blocco 1 dopo l'uscita di un Faraone da L3.
 *
 * REG.4 + REG.5 — Segue la numerazione GLOBALE delle tavole:
 *   Ogni sacerdote che entra nel Sistema Pharaoh come DONATORE (a qualsiasi livello:
 *   L1 Anubis, L2 Horus, L3 Rha) crea una tavola di sdoppiamento.
 *   La prima disponibile per numero più basso determina il prossimo Faraone.
 *   Questo include Perpetui (L2), Gemelli (L3), e sacerdoti umani (L1/L2/L3).
 *
 * DOC — «Il Sistema prende questa tavola e la porta nel livello 1 Anubis»:
 *   Indipendentemente dal livello originale della sdoppiatura (L1, L2 o L3),
 *   il Faraone INIZIA SEMPRE da Anubis (L1) con capacita=2.
 *   Questo permette la formula 13×3×3=117 sacerdoti per far uscire A da Iside.
 *
 * REG.6: inserisce le Funzioni rilasciate nelle tavole fisse del nuovo turno.
 */
async function avviaNuovoTurnoPharaoh(turnoChiuso, client = null) {
  const pg = require('./pg-connection-manager');
  const nuovoTurnoNum = turnoChiuso.numero_turno + 1;

  const selectSql = `SELECT * FROM tavole
     WHERE tipo = 'SDOPPIAMENTO' AND status = 'APERTA' AND livello IN (1, 2, 3)
     ORDER BY numero ASC LIMIT 1`;
  const prossimaTavolaFaraone = client
    ? (await client.query(selectSql)).rows[0] || null
    : await pg.queryOne(selectSql);

  if (!prossimaTavolaFaraone) {
    console.log('⚠️  Nessuna tavola Pharaoh sdoppiata disponibile per il turno successivo');
    return;
  }

  const nextFaraoneWallet = String(prossimaTavolaFaraone.faraone_wallet || '').toLowerCase();
  const livelloOrigine = prossimaTavolaFaraone.livello;

  let nextAccount = null;
  if (prossimaTavolaFaraone.faraone_account_id) {
    nextAccount = await db.getAccountByIdentity({
      accountId: prossimaTavolaFaraone.faraone_account_id,
      wallet: nextFaraoneWallet,
      sigla: prossimaTavolaFaraone.faraone_sigla || null
    }, client);
  } else {
    const candidates = await db.getAccountsByWallet(nextFaraoneWallet, client);
    if (candidates.length === 1) nextAccount = candidates[0];
    else if (candidates.length > 1) {
      throw new Error(
        `Tavola PHARAOH ${prossimaTavolaFaraone.id} senza account_id: ` +
        `${candidates.length} percorsi condividono il wallet ${nextFaraoneWallet}`
      );
    }
  }
  if (!nextAccount) {
    throw new Error(`Identita prossimo Faraone non risolta per tavola ${prossimaTavolaFaraone.id}`);
  }

  const updateSql = `UPDATE tavole
     SET tipo = 'PERCORSO', turno = $1, livello = 1, capacita = 2, blocco = 1, sezione = 'PHARAOH',
         faraone_account_id = $3, faraone_sigla = $4
     WHERE id = $2`;
  const updateParams = [nuovoTurnoNum, prossimaTavolaFaraone.id, nextAccount.id, nextAccount.sigla || null];
  if (client) await client.query(updateSql, updateParams);
  else await pg.query(updateSql, updateParams);

  const faraoneTipo = nextAccount.tipo || 'PRIMARIO';
  await db.createTurno({
    sezione: 'PHARAOH',
    livello: 1,
    blocco: 1,
    numeroTurno: nuovoTurnoNum,
    faraoneWallet: nextFaraoneWallet,
    faraoneTipo,
    faraoneAccountId: nextAccount.id,
    faraoneSigla: nextAccount.sigla || null,
    tavolaFaraoneNum: prossimaTavolaFaraone.numero,
    sacerdotiNecessari: rules.IMPORTI.SACERDOTI_DAL_SECONDO
  }, client);

  const indicatoreLivello = livelloOrigine > 1
    ? ` (tavola originale L${livelloOrigine} → L1 Anubis)`
    : '';

  console.log(`\n🔄 Nuovo turno Pharaoh #${nuovoTurnoNum} avviato automaticamente`);
  console.log(`   Faraone: ${nextAccount.sigla || nextAccount.id} / ${nextFaraoneWallet.substring(0, 12)}... (${faraoneTipo})${indicatoreLivello}`);
  console.log(`   Sacerdoti necessari: ${rules.IMPORTI.SACERDOTI_DAL_SECONDO}`);
}

/**
 * Inserisce le Funzioni rilasciate (Simbionti, Perpetuo, Gemello) nelle tavole fisse del nuovo turno.
 * Reg.6: posizionamento fisso nella struttura:
 *   Horus tav.1 slot 1,2 = Simbionte 1,2 (no sdoppiamento - reg.7)
 *   Horus tav.2 slot 1   = Simbionte 3   (no sdoppiamento - reg.7)
 *   Horus tav.2 slot 2   = Perpetuo      (con sdoppiamento - futuro Faraone)
 *   Rha   tav.7 slot 2   = Gemello       (con sdoppiamento - futuro Faraone) [lazy]
 */
async function materializzaFunzioniNelNuovoTurno(nuovoTurno, faraoneWallet, client = null) {
  const faraoneIdentity = identityFromTurno(nuovoTurno);
  const prenotazioniHorus1 = await db.getPrenotazioniRiservate({
    turnoDestinazione: nuovoTurno.numero_turno,
    livelloDestinazione: 2,
    bloccoDestinazione: 1,
    tavolaRelativa: 1
  }, client);
  const prenotazioniHorus2 = await db.getPrenotazioniRiservate({
    turnoDestinazione: nuovoTurno.numero_turno,
    livelloDestinazione: 2,
    bloccoDestinazione: 1,
    tavolaRelativa: 2
  }, client);
  const prenotazioneGemello = await db.getPrenotazioneByPosizione({
    turnoDestinazione: nuovoTurno.numero_turno,
    livelloDestinazione: 3,
    bloccoDestinazione: 1,
    tavolaRelativa: 7,
    casella: 2
  }, client);

  if (
    prenotazioniHorus1.length === 0
    && prenotazioniHorus2.length === 0
    && (!prenotazioneGemello || prenotazioneGemello.stato !== 'RESERVED')
  ) {
    console.log(`   ℹ️  Nessuna prenotazione RESERVED per il turno ${nuovoTurno.numero_turno}`);
    return;
  }

  console.log(`\n⚙️ POSIZIONAMENTO FUNZIONI nel turno ${nuovoTurno.numero_turno} (da prenotazioni)`);

  // ── HORUS TAVOLA 1: Simbionti 1 e 2 ─────────────────────────────────────────────
  if (prenotazioniHorus1.length > 0) {
    const horusTav1 = await tableManager.creaTavolaPercorso(2, faraoneWallet, nuovoTurno.numero_turno, null, client, faraoneIdentity);
    const prenotazioniOrdinate = [...prenotazioniHorus1].sort((a, b) => a.casella - b.casella);
    for (const prenotazione of prenotazioniOrdinate) {
      await materializzaPrenotazioneSuTavola({
        prenotazione,
        tavola: horusTav1,
        livello: 2,
        turnoNum: nuovoTurno.numero_turno
      }, client);
    }
    const occupate = await db.countPosizioniInTavola(horusTav1.id, client);
    if (occupate >= 3) {
      await db.updateTavolaStatus(horusTav1.numero, 'COMPLETATA', client, 'PHARAOH');
    }
    console.log(`   ✅ Simbionti 1,2 → Horus tavola #${horusTav1.numero} (${occupate}/3 occupate)`);
  }

  // ── HORUS TAVOLA 2: Simbionte 3 + Perpetuo ──────────────────────────────────────
  if (prenotazioniHorus2.length > 0) {
    const horusTav2 = await tableManager.creaTavolaPercorso(2, faraoneWallet, nuovoTurno.numero_turno, null, client, faraoneIdentity);
    const prenotazioniOrdinate = [...prenotazioniHorus2].sort((a, b) => a.casella - b.casella);
    for (const prenotazione of prenotazioniOrdinate) {
      await materializzaPrenotazioneSuTavola({
        prenotazione,
        tavola: horusTav2,
        livello: 2,
        turnoNum: nuovoTurno.numero_turno
      }, client);
    }
    const occupate = await db.countPosizioniInTavola(horusTav2.id, client);
    if (occupate >= 3) {
      await db.updateTavolaStatus(horusTav2.numero, 'COMPLETATA', client, 'PHARAOH');
    }
  }

  if (prenotazioneGemello && prenotazioneGemello.stato === 'RESERVED') {
    console.log(`   ⏳ Gemello prenotato → pendente (si inserirà alla 7ª tavola Rha)`);
  }

  console.log(`   ✅ Funzioni posizionate nel turno ${nuovoTurno.numero_turno}`);
}

// ========================================
// STATO SISTEMA
// ========================================

/**
 * Ottiene stato completo del sistema PHARAOH
 */
async function getStatoSistema() {
  await db.initDatabase();

  const sistema = await db.getState('sistema', {});
  const contenitori = await containerManager.getStatoContenitori();

  const pg = require('./pg-connection-manager');
  const stats = await pg.queryOne(`
    SELECT
      (SELECT COUNT(*) FROM accounts) AS totale_account,
      (SELECT COUNT(*) FROM accounts WHERE ticket_number IS NOT NULL) AS account_con_ticket,
      (SELECT COUNT(*) FROM tavole) AS totale_tavole,
      (SELECT COUNT(*) FROM tavole WHERE status = 'APERTA') AS tavole_aperte,
      (SELECT COUNT(*) FROM tavole WHERE status = 'COMPLETATA') AS tavole_completate,
      (SELECT COUNT(*) FROM turni WHERE status = 'IN_CORSO') AS turni_attivi,
      (SELECT COUNT(*) FROM funzioni) AS totale_funzioni,
      (SELECT COALESCE(SUM(importo), 0) FROM donazioni WHERE status = 'COMPLETATA') AS totale_donazioni,
      (SELECT COUNT(*) FROM storico_avanzamenti) AS totale_avanzamenti
  `);

  return {
    sistema,
    contenitori,
    statistiche: {
      totaleAccount: Number(stats?.totale_account) || 0,
      accountConTicket: Number(stats?.account_con_ticket) || 0,
      totaleTavole: Number(stats?.totale_tavole) || 0,
      tavoleAperte: Number(stats?.tavole_aperte) || 0,
      tavoleCompletate: Number(stats?.tavole_completate) || 0,
      turniAttivi: Number(stats?.turni_attivi) || 0,
      totaleFunzioni: Number(stats?.totale_funzioni) || 0,
      totaleDonazioni: Number(stats?.totale_donazioni) || 0,
      totaleAvanzamenti: Number(stats?.totale_avanzamenti) || 0
    }
  };
}

async function recuperaOperazioniPostCommit(limit = 100) {
  await db.initDatabase();
  const pg = require('./pg-connection-manager');
  const operazioni = await db.listRecoverablePostCommitOperations(limit);
  const risultati = [];

  for (const operazione of operazioni) {
    const eventKey = operazione.event_key;

    if (operazione.operation_type !== 'USCITA_ENTRATA_POST_COMMIT') {
      risultati.push({
        eventKey,
        status: 'SKIPPED',
        reason: `Tipo operazione non supportato: ${operazione.operation_type}`
      });
      continue;
    }

    let client = null;
    let transactionBegun = false;

    try {
      client = await pg.getClient();
      await client.query('BEGIN');
      transactionBegun = true;
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [eventKey]
      );

      const claimed = await db.markPostCommitOperationInProgress(
        eventKey,
        client
      );

      if (!claimed) {
        const corrente = await db.getPostCommitOperationByEventKey(
          eventKey,
          client
        );

        await client.query('COMMIT');
        transactionBegun = false;

        risultati.push({
          eventKey,
          status: corrente?.status || 'SKIPPED'
        });
        continue;
      }

      let payload = operazione.payload || {};
      if (typeof payload === 'string') {
        payload = JSON.parse(payload);
      }

      const wallet = operazione.wallet;
      const nomeErede = payload.nomeErede || wallet;
      const isFondo = Boolean(payload.isFondo);
      const eredeAccountId = payload.eredeAccountId || null;
      const eredeAccountSigla = payload.eredeAccountSigla || null;
      const doniRicevuti = Number(payload.doniRicevuti);
      const turnoEntrataAvviatoNelBatch = Boolean(
        payload.turnoEntrataAvviatoNelBatch
      );
      const turno = {
        id: operazione.turno_id,
        numero_turno: Number(operazione.turno_numero)
      };

      if (!wallet) {
        throw new Error(`Wallet mancante per operazione post-COMMIT: ${eventKey}`);
      }
      if (!turno.id || !Number.isFinite(turno.numero_turno)) {
        throw new Error(`Turno non valido per operazione post-COMMIT: ${eventKey}`);
      }
      if (!Number.isFinite(doniRicevuti)) {
        throw new Error(`doniRicevuti non valido per operazione post-COMMIT: ${eventKey}`);
      }

      const eredeAccount = await resolveFlowAccount({
        wallet,
        accountId: eredeAccountId,
        accountSigla: eredeAccountSigla,
        context: `Post-COMMIT Entrata ${eventKey}`,
        requireIdentity: Boolean(eredeAccountId)
      }, client);
      const eredeIdentity = identityFromAccount(eredeAccount);

      const trattenuta = rules.IMPORTI.TRATTENUTA_FONDO_ENTRATA;
      const netto = doniRicevuti - trattenuta;

      if (isFondo) {
        await db.registraAvanzamento({
          wallet,
          accountId: eredeIdentity.accountId,
          accountSigla: eredeIdentity.accountSigla,
          tipoAccount: 'FONDO',
          daLivello: 0,
          aLivello: 1,
          turno: turno.numero_turno,
          doniRicevuti,
          doniTrattenuti: trattenuta,
          netto,
          evento: 'USCITA_ENTRATA',
          eventKey
        }, client);
      } else {
        await db.registraAvanzamento({
          wallet,
          accountId: eredeIdentity.accountId,
          accountSigla: eredeIdentity.accountSigla,
          tipoAccount: 'SACERDOTE',
          daLivello: 0,
          aLivello: 1,
          turno: turno.numero_turno,
          doniRicevuti,
          doniTrattenuti: trattenuta,
          netto,
          evento: 'USCITA_ENTRATA',
          eventKey
        }, client);
      }
      await posizionaSacerdoteInPharaoh(wallet, nomeErede, client, eredeIdentity);
      let rollover = null;
      if (!turnoEntrataAvviatoNelBatch) {
        const next = await avviaNuovoTurnoEntrata(turno, client);
        rollover = next?.rollover || null;
      }
      await db.markPostCommitOperationCompleted(eventKey, client);

      await client.query('COMMIT');
      transactionBegun = false;

      risultati.push({
        eventKey,
        status: 'COMPLETED',
        rollover: rollover ? {
          amountUsdc: 100,
          targetTable: rollover.audit?.target_tavola_numero || null,
          targetSlot: rollover.audit?.target_casella || rollover.placement?.casellaOccupata || null
        } : null
      });
    } catch (err) {
      if (transactionBegun && client) {
        try {
          await client.query('ROLLBACK');
        } finally {
          transactionBegun = false;
        }
      }

      await db.markPostCommitOperationFailed(
        eventKey,
        err?.message || String(err)
      );

      risultati.push({
        eventKey,
        status: 'FAILED',
        error: err?.message || String(err)
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  return {
    totale: risultati.length,
    completate: risultati.filter((r) => r.status === 'COMPLETED').length,
    fallite: risultati.filter((r) => r.status === 'FAILED').length,
    saltate: risultati.filter((r) => r.status === 'SKIPPED').length,
    risultati
  };
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  inizializzaSistema,
  processaDonoEntrataWallet,
  processaDonoEntrata,
  processaDonoPharaoh,
  gestisciUscitaFaraone,
  buildUscitaRhaEventKey,
  materializzaFunzioniNelNuovoTurno,
  materializzaPrenotazioneSuTavola,
  inserisciGemelloPendente,
  // Blocco 2
  posizionaFaraoneInL4,
  gestisciUscitaFaraoneL4,
  buildUscitaThotEventKey,
  posizionaFaraoneInL5,
  gestisciUscitaFaraoneL5,
  buildUscitaIsideEventKey,
  recuperaOperazioniPostCommit,
  // helper interni riusati dal bridge URANUS_TO_PHARAOH per la stessa cascata Entrata
  posizionaSacerdoteInPharaoh,
  avviaNuovoTurnoEntrata,
  getStatoSistema,
  FONDO_WALLET,
  FONDO_A_WALLET,
  CASSA_PHARAOH_WALLET,
  FONDO_SIGLA
};
