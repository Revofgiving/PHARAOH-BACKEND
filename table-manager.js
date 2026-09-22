/**
 * 🎲 PHARAOH - Table Manager
 *
 * Gestisce creazione, numerazione e sdoppiamento delle tavole.
 *
 * REGOLE CHIAVE (dal PDF):
 * - Reg.2: Ogni donatore genera una tavola di sdoppiamento (posto al centro come futuro erede/faraone)
 * - Reg.5: Le tavole sono numerate sequenzialmente per sezione; ENTRATA e PHARAOH
 *   hanno sequenze indipendenti che proseguono turno dopo turno
 * - Reg.7: I Simbionti NON generano tavole di sdoppiamento
 *
 * CAPACITÀ TAVOLE:
 * - Livello entrata: 6 caselle
 * - Livello 1 (Anubis): 2 caselle (sinistra + destra)
 * - Livello 2 (Horus): 3 caselle per tavola (2 tavole × 3 = 6 sacerdoti totali)
 * - Livelli 3-5 (Rha, Thot, Iside): 3 caselle per tavola
 */

const db = require('./db-manager');

// ========================================
// COSTANTI
// ========================================

const LIVELLI = {
  ENTRATA: { numero: 0, nome: 'Entrata', capacita: 6, sezione: 'ENTRATA', blocco: null },
  ANUBIS:  { numero: 1, nome: 'Anubis',  capacita: 2, sezione: 'PHARAOH', blocco: 1 },
  HORUS:   { numero: 2, nome: 'Horus',   capacita: 3, sezione: 'PHARAOH', blocco: 1 },
  RHA:     { numero: 3, nome: 'Rha',     capacita: 3, sezione: 'PHARAOH', blocco: 1 },
  THOT:    { numero: 4, nome: 'Thot',    capacita: 3, sezione: 'PHARAOH', blocco: 2 },
  ISIDE:   { numero: 5, nome: 'Iside',   capacita: 3, sezione: 'PHARAOH', blocco: 2 }
};

function getLivelloConfig(livello) {
  const configs = Object.values(LIVELLI);
  return configs.find(c => c.numero === livello) || null;
}

// ========================================
// CREAZIONE TAVOLE
// ========================================

/**
 * Crea una tavola di PERCORSO (quella dove il Faraone/Erede riceve i doni).
 *
 * @param {number} livello - 0-5
 * @param {string} faraoneWallet - Wallet dell'erede/faraone al centro
 * @param {number} turno - Turno corrente
 * @param {number} [numeroForzato] - Se specificato, usa questo numero (reg.4: il Faraone porta la sua tavola)
 * @returns {Object} Tavola creata
 */
async function creaTavolaPercorso(livello, faraoneWallet, turno, numeroForzato = null, client = null, faraoneIdentity = null) {
  const config = getLivelloConfig(livello);
  if (!config) throw new Error(`Livello ${livello} non valido`);
  const numero = numeroForzato ?? await db.getNextTavolaNumero(client, config.sezione);

  const tavola = await db.createTavola({
    numero,
    sezione: config.sezione,
    livello,
    blocco: config.blocco,
    tipo: 'PERCORSO',
    capacita: config.capacita,
    faraoneWallet,
    faraoneAccountId: faraoneIdentity?.accountId || null,
    faraoneSigla: faraoneIdentity?.accountSigla || null,
    turno
  }, client);

  console.log(`   🎲 Tavola PERCORSO #${numero} creata (L${livello} ${config.nome}, cap=${config.capacita})`);
  return tavola;
}

/**
 * Crea una tavola PERCORSO operativa Rha per due sacerdoti individuali.
 *
 * La tavola strutturale Horus → Rha resta separata; le tavole operative
 * Rha seguono la sequenza Excel con due sacerdoti per tavola.
 */
async function creaTavolaPercorsoOperativaRha(
  faraoneWallet,
  turno,
  client = null,
  faraoneIdentity = null
) {
  const numero = await db.getNextTavolaNumero(client, 'PHARAOH');

  const tavola = await db.createTavola({
    numero,
    sezione: 'PHARAOH',
    livello: 3,
    blocco: 1,
    tipo: 'PERCORSO',
    capacita: 2,
    faraoneWallet,
    faraoneAccountId: faraoneIdentity?.accountId || null,
    faraoneSigla: faraoneIdentity?.accountSigla || null,
    turno
  }, client);

  console.log(
    `   🎲 Tavola PERCORSO RHA OPERATIVA #${numero} ` +
    `(L3 Rha, cap=2)`
  );

  return tavola;
}

/**
 * Crea una tavola Horus operativa del primo turno per due nuovi sacerdoti.
 * La Tav.4 strutturale conserva 1-2; le operative Tav.5 e Tav.8 ricevono
 * rispettivamente 3-4 e 5-6, come nel foglio Faraone A.
 */
async function creaTavolaPercorsoOperativaHorus(
  faraoneWallet,
  turno,
  client = null,
  faraoneIdentity = null
) {
  const numero = await db.getNextTavolaNumero(client, 'PHARAOH');
  return await db.createTavola({
    numero,
    sezione: 'PHARAOH',
    livello: 2,
    blocco: 1,
    tipo: 'PERCORSO',
    capacita: 2,
    faraoneWallet,
    faraoneAccountId: faraoneIdentity?.accountId || null,
    faraoneSigla: faraoneIdentity?.accountSigla || null,
    turno
  }, client);
}

/**
 * Crea una tavola di SDOPPIAMENTO per un donatore (reg.2).
 *
 * Dopo che un donatore fa il dono, il sistema gli crea una tavola
 * e lo posiziona al centro come futuro erede/faraone.
 *
 * @param {number} livello - Livello della tavola padre
 * @param {string} donatoreWallet - Wallet del donatore
 * @param {number} turno - Turno corrente
 * @returns {Object} Tavola di sdoppiamento creata
 */
async function creaTavolaSdoppiamento(livello, donatoreWallet, turno, client = null, accountIdentity = null) {
  const config = getLivelloConfig(livello);
  if (!config) throw new Error(`Livello ${livello} non valido`);
  const numero = await db.getNextTavolaNumero(client, config.sezione);

  // La tavola di sdoppiamento ha la stessa capacità del livello
  // (nel livello entrata = 6, Anubis = 2, altri = 3)
  const tavola = await db.createTavola({
    numero,
    sezione: config.sezione,
    livello,
    blocco: config.blocco,
    tipo: 'SDOPPIAMENTO',
    capacita: config.capacita,
    faraoneWallet: donatoreWallet,
    faraoneAccountId: accountIdentity?.accountId || null,
    faraoneSigla: accountIdentity?.accountSigla || null,
    turno
  }, client);

  console.log(`   🔀 Tavola SDOPPIAMENTO #${numero} creata per ${donatoreWallet.substring(0, 10)}... (L${livello})`);
  return tavola;
}

// ========================================
// POSIZIONAMENTO DONATORE
// ========================================

async function resolveCasellaDisponibile({
  tavolaId,
  tavolaNumero,
  livello,
  turno,
  capacita,
  client
}) {
  if (Number(livello) !== 0) {
    const occupate = await db.countPosizioniInTavola(tavolaId, client);
    return { casella: occupate + 1, occupate, riservate: [] };
  }

  const posizioni = await db.getPosizioniTavola(tavolaId, client);
  const occupateSet = new Set(posizioni.map(p => Number(p.casella)));
  const riservate = await db.getEntryReservedSlots({
    turnoNumero: turno,
    tavolaNumero,
    tavolaRelativa: 1
  }, client);
  const riservateSet = new Set(riservate.map(Number));

  for (let casella = 1; casella <= Number(capacita); casella += 1) {
    if (!occupateSet.has(casella) && !riservateSet.has(casella)) {
      return { casella, occupate: occupateSet.size, riservate };
    }
  }

  return { casella: null, occupate: occupateSet.size, riservate };
}

/**
 * Posiziona un donatore in una casella della tavola e gestisce lo sdoppiamento.
 *
 * @param {Object} params
 * @param {number} params.tavolaId - ID tavola di percorso
 * @param {number} params.tavolaNumero - Numero tavola
 * @param {number} params.livello - Livello corrente
 * @param {string} params.wallet - Wallet donatore
 * @param {string} params.nome - Nome donatore
 * @param {string} params.tipo - DONATORE | SIMBIONTE | PERPETUO | GEMELLO
 * @param {number} params.donoImporto - Importo del dono
 * @param {number} params.turno - Turno corrente
 * @param {boolean} params.sdoppiabile - Se true crea tavola sdoppiamento (reg.7: simbionti = false)
 * @returns {Object} { posizione, tavolaSdoppiamento }
 */
async function posizionaDonatore({
  tavolaId,
  tavolaNumero,
  livello,
  wallet,
  nome,
  tipo,
  donoImporto,
  turno,
  sdoppiabile = true,
  capacitaTavola = null,
  accountId = null,
  accountSigla = null,
  client = null
}) {
  const config = getLivelloConfig(livello);
  const capacitaEffettiva =
    Number(capacitaTavola) > 0
      ? Number(capacitaTavola)
      : config.capacita;
  const slot = await resolveCasellaDisponibile({
    tavolaId,
    tavolaNumero,
    livello,
    turno,
    capacita: capacitaEffettiva,
    client
  });
  const occupate = Number(slot.occupate) || 0;
  const casella = slot.casella;

  if (!Number.isInteger(casella) || casella < 1 || casella > capacitaEffettiva) {
    if (Number(livello) === 0 && slot.riservate.length > 0 && occupate < capacitaEffettiva) {
      throw new Error(
        `Tavola Entrata #${tavolaNumero}: nessuna casella libera senza invadere ` +
        `prenotazioni Funzioni (${slot.riservate.join(',')})`
      );
    }
    throw new Error(
      `Tavola #${tavolaNumero} piena ` +
      `(${occupate}/${capacitaEffettiva})`
    );
  }

  // Inserisci posizione
  const posizione = await db.createPosizione({
    tavolaId,
    casella,
    wallet,
    nome,
    tipo,
    donoImporto,
    accountId,
    accountSigla
  }, client);

  // Aggiorna totale doni ricevuti nella tavola
  await db.updateTavolaDoni(tavolaNumero, donoImporto, client, config.sezione);

  console.log(`   📍 ${nome} posizionato in tavola #${tavolaNumero} casella ${casella}/${capacitaEffettiva} (${tipo}, dono=${donoImporto})`);

  // Sdoppiamento (reg.2): crea tavola e metti donatore al centro come futuro erede
  // Reg.7: I Simbionti NON si sdoppiano
  let tavolaSdoppiamento = null;

  if (sdoppiabile && tipo !== 'SIMBIONTE') {
    tavolaSdoppiamento = await creaTavolaSdoppiamento(livello, wallet, turno, client, { accountId, accountSigla });

    // Aggiorna la posizione con il riferimento alla tavola di sdoppiamento
    await db.updatePosizioneSdoppiamento(posizione.id, tavolaSdoppiamento.id, client);

    console.log(`   🔀 Sdoppiamento: tavola #${tavolaSdoppiamento.numero} con ${nome} al centro`);
  }

  // Verifica se la tavola è ora completa. Le prenotazioni vuote non contano:
  // una tavola Entrata si chiude solo con tutte e 6 le caselle materializzate.
  const nuoveOccupate = occupate + 1;
  const tavolaCompleta = nuoveOccupate >= capacitaEffettiva;

  if (tavolaCompleta) {
    await db.updateTavolaStatus(tavolaNumero, 'COMPLETATA', client, config.sezione);
    console.log(`   ✅ Tavola #${tavolaNumero} COMPLETATA (${nuoveOccupate}/${capacitaEffettiva})`);
  }

  return {
    posizione,
    tavolaSdoppiamento,
    tavolaCompleta,
    casellaOccupata: casella,
    totaleCaselle: capacitaEffettiva
  };
}

/**
 * Materializza il riporto da 100 USDC dalla tavola Entrata appena chiusa
 * alla tavola Entrata successiva.
 *
 * Regola recovery 4/9/2026:
 * - Tavola 1 (Fondo A): 6 donatori reali = 600; 500 finanziano la progressione;
 *   i 100 eccedenti restano in Cassa PHARAOH e diventano una posizione di riporto
 *   nella tavola successiva.
 * - Dalla Tavola 2 in poi: 1 posizione ROLLOVER da 100 + 5 nuovi donatori = 600;
 *   alla chiusura i successivi 100 vengono riportati ancora.
 * - Il riporto non crea account, ticket o sdoppiamento e non puo occupare
 *   una casella riservata a una Funzione.
 */
async function materializzaRolloverEntrata({
  sourceTavola,
  targetTavola,
  targetTurno,
  cassaWallet,
  client
}) {
  if (!client) throw new Error('Client transazionale obbligatorio per rollover Entrata');
  if (!sourceTavola?.id || !targetTavola?.id) throw new Error('Tavole sorgente/destinazione rollover mancanti');
  if (Number(targetTavola.numero) <= 1 || Number(targetTurno) <= 1) {
    throw new Error('Il rollover Entrata e ammesso soltanto dalla Tavola/Turno 2 in poi');
  }
  const wallet = String(cassaWallet || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('Wallet Cassa PHARAOH non valido per rollover Entrata');

  const existing = await db.getEntryRolloverBySourceTable(sourceTavola.id, client);
  if (existing) {
    if (Number(existing.target_tavola_id) !== Number(targetTavola.id) || String(existing.cassa_wallet).toLowerCase() !== wallet) {
      throw new Error(`Rollover Entrata sorgente ${sourceTavola.id} gia materializzato con destinazione diversa`);
    }
    return { audit: existing, idempotent: true };
  }

  const placement = await posizionaDonatore({
    tavolaId: targetTavola.id,
    tavolaNumero: targetTavola.numero,
    livello: 0,
    wallet,
    nome: 'CASSA PHARAOH - RIPORTO 100',
    tipo: 'ROLLOVER',
    donoImporto: 100,
    turno: targetTurno,
    sdoppiabile: false,
    capacitaTavola: 6,
    accountId: null,
    accountSigla: null,
    client
  });

  if (placement.tavolaSdoppiamento) {
    throw new Error('Il rollover Entrata non deve generare sdoppiamento');
  }

  const eventKey = `PHARAOH:ENTRATA:ROLLOVER:${sourceTavola.id}:${targetTavola.id}`;
  const audit = await db.createEntryRolloverAudit({
    eventKey,
    sourceTavolaId: sourceTavola.id,
    sourceTavolaNumero: sourceTavola.numero,
    targetTavolaId: targetTavola.id,
    targetTavolaNumero: targetTavola.numero,
    targetTurno,
    cassaWallet: wallet,
    amountUsdc: 100,
    targetCasella: placement.casellaOccupata,
    posizioneId: placement.posizione.id
  }, client);

  return { audit, placement, idempotent: false };
}

// ========================================
// PROGRESSIONE SACERDOTI (da un livello al successivo)
// ========================================

/**
 * Avanza i sacerdoti da un livello completato al livello successivo.
 *
 * Il documento descrive i sacerdoti che PROGREDISCONO con il Faraone:
 *   - Sacerdoti 1-2 appaiono ad Anubis → poi a Horus → poi a Rha
 *   - Sacerdoti 3-6 appaiono a Horus → poi a Rha
 *   - Sacerdoti 7-18 entrano direttamente a Rha
 *
 * Quando un livello si completa, questa funzione crea le tavole al livello
 * superiore e vi inserisce i sacerdoti come PROGREDITO (importo già contabilizzato).
 *
 * @param {number} daLivello       - Livello di origine (es. 1=Anubis, 2=Horus)
 * @param {number} aLivello        - Livello di destinazione (es. 2=Horus, 3=Rha)
 * @param {number} turnoNumero     - Numero turno corrente
 * @param {string} faraoneWallet   - Wallet del Faraone di turno
 * @returns {Array} Lista delle tavole create al livello superiore
 */
async function avanzaSacerdotiAlLivello(daLivello, aLivello, turnoNumero, faraoneWallet, client = null, faraoneIdentity = null) {
  const pg = require('./pg-connection-manager');

  // Recupera tutti i sacerdoti dal livello di origine.
  const sacerdotiQuery = `SELECT p.wallet, p.nome, p.account_id, p.account_sigla
     FROM posizioni p
     JOIN tavole t ON p.tavola_id = t.id
     WHERE t.livello = $1
       AND t.turno   = $2
       AND t.tipo    = 'PERCORSO'
       AND p.tipo   != 'EREDE'
     ORDER BY p.id ASC`;
  const sacerdoti = client
    ? (await client.query(sacerdotiQuery, [daLivello, turnoNumero])).rows
    : await pg.queryMany(
      `SELECT p.wallet, p.nome, p.account_id, p.account_sigla
     FROM posizioni p
     JOIN tavole t ON p.tavola_id = t.id
     WHERE t.livello = $1
       AND t.turno   = $2
       AND t.tipo    = 'PERCORSO'
       AND p.tipo   != 'EREDE'
     ORDER BY p.id ASC`,
      [daLivello, turnoNumero]
    );

  if (sacerdoti.length === 0) {
    console.log(`   ℹ️  Nessun sacerdote da avanzare da L${daLivello} → L${aLivello}`);
    return [];
  }

  const destConfig = getLivelloConfig(aLivello);
  if (!destConfig) throw new Error(`Livello destinazione ${aLivello} non valido`);

  console.log(
    `\n   ⬆️  PROGRESSIONE: ${sacerdoti.length} sacerdoti ` +
    `L${daLivello} → L${aLivello} (${destConfig.nome})`
  );

  const tavoleUtilizzate = [];
  const tavoleViste = new Set();

  for (const sacerdote of sacerdoti) {
    // Prima riempie le tavole PERCORSO già aperte.
    // È essenziale dal secondo turno, quando le Funzioni occupano
    // le prime due caselle delle due tavole Horus.
    let tavola = await getTavolaPercorsoAttiva(aLivello, turnoNumero, client);

    if (!tavola) {
      tavola = await creaTavolaPercorso(
        aLivello,
        faraoneWallet,
        turnoNumero,
        null,
        client,
        faraoneIdentity
      );
    }

    const occupate = await db.countPosizioniInTavola(tavola.id, client);
    const casella = occupate + 1;

    if (casella > destConfig.capacita) {
      throw new Error(
        `Tavola #${tavola.numero} piena durante progressione ` +
        `L${daLivello} → L${aLivello}`
      );
    }

    await db.createPosizione({
      tavolaId: tavola.id,
      casella,
      wallet: sacerdote.wallet,
      nome: sacerdote.nome,
      tipo: 'PROGREDITO',
      donoImporto: 0,
      accountId: sacerdote.account_id || null,
      accountSigla: sacerdote.account_sigla || null
    }, client);

    console.log(
      `     → ${sacerdote.nome || sacerdote.wallet.substring(0, 10)} ` +
      `progredisce a L${aLivello}, tavola #${tavola.numero}, casella ${casella}`
    );

    if (!tavoleViste.has(tavola.id)) {
      tavoleViste.add(tavola.id);
      tavoleUtilizzate.push(tavola);
    }

    if (casella >= destConfig.capacita) {
      await db.updateTavolaStatus(tavola.numero, 'COMPLETATA', client, destConfig.sezione);
      console.log(
        `     ✅ Tavola #${tavola.numero} COMPLETATA ` +
        `(${casella}/${destConfig.capacita})`
      );
    }
  }

  console.log(
    `   ✅ Progressione completata: ${tavoleUtilizzate.length} tavole utilizzate a L${aLivello}`
  );

  return tavoleUtilizzate;
}

/**
 * Primo turno: materializza la sola Tav.4 strutturale Horus con i due
 * sacerdoti provenienti da Anubis e la chiude. I donatori 3-6 entrano
 * successivamente nelle tavole Horus operative da due posti.
 */
async function avanzaAnubisAHorusPrimoTurnoStrutturale(
  turnoNumero,
  faraoneWallet,
  client = null,
  faraoneIdentity = null
) {
  const pg = require('./pg-connection-manager');
  const sql = `SELECT p.wallet, p.nome, p.account_id, p.account_sigla
     FROM posizioni p
     JOIN tavole t ON p.tavola_id = t.id
     WHERE t.livello = 1
       AND t.turno = $1
       AND t.tipo = 'PERCORSO'
       AND p.tipo != 'EREDE'
     ORDER BY p.id ASC`;
  const sacerdoti = client
    ? (await client.query(sql, [turnoNumero])).rows
    : await pg.queryMany(sql, [turnoNumero]);

  if (sacerdoti.length !== 2) {
    throw new Error(
      `Progressione Anubis → Horus primo turno non valida: ` +
      `attesi 2 sacerdoti, trovati ${sacerdoti.length}`
    );
  }

  const numero = await db.getNextTavolaNumero(client, 'PHARAOH');
  const tavola = await db.createTavola({
    numero,
    sezione: 'PHARAOH',
    livello: 2,
    blocco: 1,
    tipo: 'PERCORSO',
    capacita: 2,
    faraoneWallet,
    faraoneAccountId: faraoneIdentity?.accountId || null,
    faraoneSigla: faraoneIdentity?.accountSigla || null,
    turno: turnoNumero
  }, client);

  for (let index = 0; index < sacerdoti.length; index += 1) {
    const sacerdote = sacerdoti[index];
    await db.createPosizione({
      tavolaId: tavola.id,
      casella: index + 1,
      wallet: sacerdote.wallet,
      nome: sacerdote.nome,
      tipo: 'PROGREDITO',
      donoImporto: 0,
      accountId: sacerdote.account_id || null,
      accountSigla: sacerdote.account_sigla || null
    }, client);
  }

  await db.updateTavolaStatus(tavola.numero, 'COMPLETATA', client, 'PHARAOH');
  return { ...tavola, status: 'COMPLETATA' };
}

/**
 * Crea la tavola Rha principale dalla struttura Horus completata.
 *
 * Excel ufficiale:
 * - turno 1: il blocco iniziale è rappresentato come 1-6;
 * - dai turni successivi: il blocco iniziale comprende i sacerdoti
 *   provenienti da Anubis e le Funzioni Horus, es. 19-CL A.1.
 *
 * Le sei identità originali restano conservate nelle tavole Horus.
 * Rha riceve inizialmente un solo riferimento strutturale.
 */
async function avanzaHorusARhaStrutturale(
  turnoNumero,
  faraoneWallet,
  client = null,
  faraoneIdentity = null
) {
  const pg = require('./pg-connection-manager');
  const componentiQuery = `SELECT
       p.id,
       p.wallet,
       p.nome,
       p.tipo,
       p.account_id,
       p.account_sigla,
       t.numero AS tavola_numero,
       p.casella
     FROM posizioni p
     JOIN tavole t ON p.tavola_id = t.id
     WHERE t.livello = 2
       AND t.turno = $1
       AND t.tipo = 'PERCORSO'
       AND p.tipo != 'EREDE'
     ORDER BY t.numero ASC, p.casella ASC, p.id ASC`;
  const componentiHorus = client
    ? (await client.query(componentiQuery, [turnoNumero])).rows
    : await pg.queryMany(
      `SELECT
       p.id,
       p.wallet,
       p.nome,
       p.tipo,
       p.account_id,
       p.account_sigla,
       t.numero AS tavola_numero,
       p.casella
     FROM posizioni p
     JOIN tavole t ON p.tavola_id = t.id
     WHERE t.livello = 2
       AND t.turno = $1
       AND t.tipo = 'PERCORSO'
       AND p.tipo != 'EREDE'
     ORDER BY t.numero ASC, p.casella ASC, p.id ASC`,
      [turnoNumero]
    );

  if (componentiHorus.length !== 6) {
    throw new Error(
      `Progressione Horus → Rha non valida: ` +
      `attese 6 componenti, trovate ${componentiHorus.length}`
    );
  }

  // Nel secondo turno le sei identità sono distribuite tra la tavola
  // strutturale Horus e le due tavole delle Funzioni. Ogni tavola rappresenta
  // un blocco completo dell'Excel anche quando contiene due righe fisiche:
  // dopo la progressione a Rha non deve più accogliere sacerdoti reali.
  const numeriHorus = [...new Set(
    componentiHorus.map((componente) => Number(componente.tavola_numero))
  )].filter(Number.isInteger);
  for (const numeroHorus of numeriHorus) {
    await db.updateTavolaStatus(
      numeroHorus,
      'COMPLETATA',
      client,
      'PHARAOH'
    );
  }

  const prima = componentiHorus[0];
  const ultima = componentiHorus[componentiHorus.length - 1];

  if (!prima?.nome || !ultima?.nome) {
    throw new Error(
      'Impossibile costruire il riferimento strutturale Rha'
    );
  }

  const nomeBlocco = Number(turnoNumero) === 1
    ? `${prima.nome}-${ultima.nome}`
    : `${prima.nome}-CL ${ultima.nome}`;

  const numero = await db.getNextTavolaNumero(client, 'PHARAOH');

  const tavolaRha = await db.createTavola({
    numero,
    sezione: 'PHARAOH',
    livello: 3,
    blocco: 1,
    tipo: 'PERCORSO',
    capacita: 2,
    faraoneWallet,
    faraoneAccountId: faraoneIdentity?.accountId || null,
    faraoneSigla: faraoneIdentity?.accountSigla || null,
    turno: turnoNumero
  }, client);

  console.log(
    `\n   ⬆️  HORUS → RHA: ` +
    `creata soltanto Tavola #${tavolaRha.numero}; ` +
    `le 6 identità restano preservate nelle tavole Horus`
  );

  return {
    tavola: tavolaRha,
    riferimentoExcel: nomeBlocco,
    componentiHorus
  };
}

// ========================================
// QUERY TAVOLE
// ========================================

/**
 * Trova la tavola di percorso attiva per un livello/turno
 */
async function getTavolaPercorsoAttiva(livello, turno, client = null) {
  const pg = require('./pg-connection-manager');
  if (client) {
    const result = await client.query(
      `SELECT * FROM tavole
       WHERE livello = $1 AND turno = $2 AND tipo = 'PERCORSO' AND status = 'APERTA'
       ORDER BY numero ASC LIMIT 1`,
      [livello, turno]
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    `SELECT * FROM tavole
     WHERE livello = $1 AND turno = $2 AND tipo = 'PERCORSO' AND status = 'APERTA'
     ORDER BY numero ASC LIMIT 1`,
    [livello, turno]
  );
}

/**
 * Trova la tavola Rha operativa destinata ai sacerdoti individuali.
 *
 * Esclude la tavola principale Horus → Rha.
 *
 * La prima tavola PERCORSO Rha del turno resta riservata come
 * Tav.36 principale; gli ingressi individuali utilizzano soltanto
 * le tavole PERCORSO con numerazione successiva.
 */
async function getTavolaPercorsoOperativaRha(turno, client = null) {
  const pg = require('./pg-connection-manager');

  const sql = `SELECT t.*
     FROM tavole t
     WHERE t.livello = 3
       AND t.turno = $1
       AND t.tipo = 'PERCORSO'
       AND t.status = 'APERTA'
       AND t.numero > (
         SELECT MIN(principale.numero)
         FROM tavole principale
         WHERE principale.livello = 3
           AND principale.turno = $1
           AND principale.tipo = 'PERCORSO'
       )
     ORDER BY t.numero ASC
     LIMIT 1`;
  if (client) {
    const result = await client.query(sql, [turno]);
    return result.rows[0] || null;
  }
  return await pg.queryOne(sql, [turno]);
}

/** Trova una tavola Horus operativa del primo turno, escludendo la strutturale. */
async function getTavolaPercorsoOperativaHorus(turno, client = null) {
  const pg = require('./pg-connection-manager');
  const sql = `SELECT t.*
     FROM tavole t
     WHERE t.livello = 2
       AND t.turno = $1
       AND t.tipo = 'PERCORSO'
       AND t.status = 'APERTA'
       AND t.numero > (
         SELECT MIN(principale.numero)
         FROM tavole principale
         WHERE principale.livello = 2
           AND principale.turno = $1
           AND principale.tipo = 'PERCORSO'
       )
     ORDER BY t.numero ASC
     LIMIT 1`;
  if (client) {
    const result = await client.query(sql, [turno]);
    return result.rows[0] || null;
  }
  return await pg.queryOne(sql, [turno]);
}

/**
 * Conta tavole create in un turno (per reg.5)
 */
async function countTavoleInTurno(turno) {
  const pg = require('./pg-connection-manager');
  const row = await pg.queryOne(
    'SELECT COUNT(*) AS cnt FROM tavole WHERE turno = $1',
    [turno]
  );
  return Number(row?.cnt) || 0;
}

/**
 * Ottiene tutte le tavole di sdoppiamento di un turno
 */
async function getTavoleSdoppiamentoTurno(turno) {
  const pg = require('./pg-connection-manager');
  return await pg.queryMany(
    `SELECT * FROM tavole WHERE turno = $1 AND tipo = 'SDOPPIAMENTO' ORDER BY numero ASC`,
    [turno]
  );
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  creaTavolaPercorso,
  creaTavolaPercorsoOperativaRha,
  creaTavolaPercorsoOperativaHorus,
  creaTavolaSdoppiamento,
  posizionaDonatore,
  materializzaRolloverEntrata,
  avanzaSacerdotiAlLivello,
  avanzaAnubisAHorusPrimoTurnoStrutturale,
  avanzaHorusARhaStrutturale,
  getTavolaPercorsoAttiva,
  getTavolaPercorsoOperativaRha,
  getTavolaPercorsoOperativaHorus,
  countTavoleInTurno,
  getTavoleSdoppiamentoTurno,
  getLivelloConfig,
  LIVELLI
};
