/**
 * 👤 PHARAOH - Account Manager
 *
 * Gestisce registrazione account, rilascio ticket sequenziale,
 * e classificazione in PRIMARIO / PERPETUO / GEMELLO / SIMBIONTE.
 *
 * Il primo accesso umano passa dal flusso di donazione verificata da 100 USDC.
 * Non esistono più Doni al Volo, Doni a Credito o lista d'attesa 5.1.
 */

const db = require('./db-manager');
const containerManager = require('./container-manager');

// ========================================
// COSTANTI
// ========================================

// Quota di ingresso standard
const QUOTA_INGRESSO = 100;

// ========================================
// REGISTRAZIONE
// ========================================

/**
 * Registra un nuovo account nel sistema PHARAOH.
 *
 * @param {Object} params
 * @param {string} params.wallet - Indirizzo wallet
 * @param {string} params.nome - Nome dell'utente
 * @returns {Object} { account, ticket, contenitore }
 */
async function registraAccount({ wallet, nome }) {
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    throw new Error('Wallet non valido');
  }

  const w = wallet.toLowerCase();
  const existing = await db.getAccount(w);

  if (existing) {
    return {
      success: true,
      recognized: true,
      isNew: false,
      account: existing,
      ticketNumber: null,
      contenitore: null,
      positionCreated: false,
      message: `Wallet già riconosciuto: ${w}`
    };
  }

  const account = await db.createAccount({ wallet: w, nome: nome || null, tipo: 'PRIMARIO' });

  return {
    success: true,
    recognized: true,
    isNew: true,
    account,
    ticketNumber: null,
    contenitore: null,
    positionCreated: false,
    message: `Wallet riconosciuto per la prima volta: ${w}`
  };
}

// ========================================
// ACCOUNT SECONDARI (Perpetuo / Gemello)
// ========================================

function normalizzaSiglaGenealogica(parentSigla) {
  const sigla = String(parentSigla || '').trim();
  if (!sigla || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?(?:\.\d+)?$/.test(sigla)) {
    throw new Error(`Sigla genealogica non valida: ${parentSigla}`);
  }
  return sigla;
}

/** Calcola A.1 → A.2 e 1-A → 1-A.1 secondo la regola 8. */
function calcolaSiglaPerpetuo(parentSigla, perpetuoNumero) {
  const parent = normalizzaSiglaGenealogica(parentSigla);
  const corrente = parent.match(/^(.*)\.(\d+)$/);
  if (corrente) {
    return `${corrente[1]}.${Number(corrente[2]) + 1}`;
  }
  const progressivo = Number(perpetuoNumero);
  if (!Number.isInteger(progressivo) || progressivo < 1) {
    throw new Error(`Progressivo Perpetuo non valido: ${perpetuoNumero}`);
  }
  return `${parent}.${progressivo}`;
}

/** Calcola A → 1-A e 1-A → 2-A secondo la regola 9. */
function calcolaSiglaGemello(parentSigla, gemelloNumero) {
  const parent = normalizzaSiglaGenealogica(parentSigla);
  const corrente = parent.match(/^(\d+)-(.+)$/);
  if (corrente) {
    return `${Number(corrente[1]) + 1}-${corrente[2]}`;
  }
  const progressivo = Number(gemelloNumero);
  if (!Number.isInteger(progressivo) || progressivo < 1) {
    throw new Error(`Progressivo Gemello non valido: ${gemelloNumero}`);
  }
  return `${progressivo}-${parent}`;
}

/**
 * Crea un account PERPETUO (rilasciato dal Faraone all'uscita L3).
 *
 * Sigla: A.1, A.2, 1-A.1 ecc. (reg.8)
 * Il Perpetuo NON rilascia Gemello (reg.11), solo il suo Perpetuo successivo.
 *
 * @param {string} parentWallet - Wallet del Faraone che rilascia
 * @param {string} parentSigla - Sigla del parent (es. 'A', '1', '1-A')
 * @param {number} perpetuoNumero - Numero progressivo (1, 2, 3...)
 */
async function creaPerpetuo(parentWallet, parentSigla, perpetuoNumero, client = null, parentAccountId = null) {
  const walletReale = String(parentWallet || '').trim().toLowerCase();
  const parent = parentAccountId
    ? await db.getAccountByIdentity({ accountId: parentAccountId, wallet: walletReale }, client)
    : await db.getAccountByIdentity({ wallet: walletReale, sigla: parentSigla || null }, client);
  if (!parent) throw new Error(`Account origine Perpetuo non trovato: ${walletReale}`);

  const siglaBase = parentSigla || parent.sigla || (parent.ticket_number ? String(parent.ticket_number) : null);
  const sigla = calcolaSiglaPerpetuo(siglaBase, perpetuoNumero);
  const rootId = parent.root_account_id || parent.id;

  console.log(`   🔄 Creazione PERPETUO: ${sigla} (wallet condiviso ${walletReale.substring(0, 10)}...)`);

  const account = await db.createAccount({
    wallet: walletReale,
    nome: `Perpetuo ${sigla}`,
    tipo: 'PERPETUO',
    sigla,
    parentWallet: walletReale,
    accountKey: `FUNCTION:PERPETUO:${parent.id}:${sigla}`,
    parentAccountId: parent.id,
    rootAccountId: rootId,
    originKind: 'FUNCTION'
  }, client);

  return { account, sigla, wallet: walletReale };
}

/**
 * Crea un account GEMELLO (rilasciato dal Faraone all'uscita L3).
 *
 * Sigla: 1-A, 2-A, ecc. (reg.9)
 * Il Gemello è trattato come account nuovo a tutti gli effetti.
 * Ticket prenotato: partendo da 26, +14 per ogni successivo (reg.10)
 *
 * @param {string} parentWallet - Wallet del Faraone che rilascia
 * @param {string} parentSigla - Sigla del parent
 * @param {number} gemelloNumero - Numero progressivo (1, 2, 3...)
 */
async function creaGemello(parentWallet, parentSigla, gemelloNumero, client = null, parentAccountId = null) {
  const walletReale = String(parentWallet || '').trim().toLowerCase();
  const parent = parentAccountId
    ? await db.getAccountByIdentity({ accountId: parentAccountId, wallet: walletReale }, client)
    : await db.getAccountByIdentity({ wallet: walletReale, sigla: parentSigla || null }, client);
  if (!parent) throw new Error(`Account origine Gemello non trovato: ${walletReale}`);

  const siglaBase = parentSigla || parent.sigla || (parent.ticket_number ? String(parent.ticket_number) : null);
  const sigla = calcolaSiglaGemello(siglaBase, gemelloNumero);
  const rootId = parent.root_account_id || parent.id;
  console.log(`   👥 Creazione GEMELLO: ${sigla} (wallet condiviso ${walletReale.substring(0, 10)}...)`);

  const account = await db.createAccount({
    wallet: walletReale,
    nome: `Gemello ${sigla}`,
    tipo: 'GEMELLO',
    sigla,
    parentWallet: walletReale,
    accountKey: `FUNCTION:GEMELLO:${parent.id}:${sigla}`,
    parentAccountId: parent.id,
    rootAccountId: rootId,
    originKind: 'FUNCTION'
  }, client);
  const accountConTicket = await db.assignNextGemelloTicketToAccountId(account.id, client);
  const ticketPrenotato = accountConTicket.ticket_number;

  return { account: accountConTicket, sigla, wallet: walletReale, ticketPrenotato };
}

/**
 * Conta il numero di Perpetui rilasciati da un account
 */
async function countPerpetui(parentWallet, client = null, parentAccountId = null) {
  const sql = parentAccountId
    ? `SELECT COUNT(*) AS cnt FROM accounts WHERE parent_account_id = $1 AND tipo = 'PERPETUO'`
    : `SELECT COUNT(*) AS cnt FROM accounts WHERE parent_wallet = $1 AND tipo = 'PERPETUO'`;
  const params = [parentAccountId || parentWallet.toLowerCase()];
  if (client) {
    const result = await client.query(sql, params);
    const row = result?.rows?.[0];
    return Number(row?.cnt) || 0;
  }
  const pg = require('./pg-connection-manager');
  const row = await pg.queryOne(sql, params);
  return Number(row?.cnt) || 0;
}

/**
 * Conta il numero di Gemelli rilasciati da un account
 */
async function countGemelli(parentWallet, client = null, parentAccountId = null) {
  const sql = parentAccountId
    ? `SELECT COUNT(*) AS cnt FROM accounts WHERE parent_account_id = $1 AND tipo = 'GEMELLO'`
    : `SELECT COUNT(*) AS cnt FROM accounts WHERE parent_wallet = $1 AND tipo = 'GEMELLO'`;
  const params = [parentAccountId || parentWallet.toLowerCase()];
  if (client) {
    const result = await client.query(sql, params);
    const row = result?.rows?.[0];
    return Number(row?.cnt) || 0;
  }
  const pg = require('./pg-connection-manager');
  const row = await pg.queryOne(sql, params);
  return Number(row?.cnt) || 0;
}

// ========================================
// PERCORSO ACCOUNT (per Area Personale)
// ========================================

const LIVELLI_PERCORSO = {
  0: { uiLevel: 2, nome: 'Entrata' },
  1: { uiLevel: 3, nome: 'Anubis' },
  2: { uiLevel: 4, nome: 'Horus' },
  3: { uiLevel: 5, nome: 'Rha' },
  4: { uiLevel: 6, nome: 'Thot' },
  5: { uiLevel: 7, nome: 'Iside' }
};

function livelloToPercorso(livello, extra = {}) {
  const config = LIVELLI_PERCORSO[livello] || LIVELLI_PERCORSO[0];
  return {
    uiLevel: config.uiLevel,
    livelloNumero: livello,
    livelloNome: config.nome,
    ...extra
  };
}

/**
 * Calcola il punto reale di UNA identita posizionale/percorso.
 *
 * IMPORTANTE: il wallet Ethereum identifica sempre la stessa persona.
 * `accounts.id` e `sigla` servono soltanto come chiavi interne per distinguere
 * i diversi percorsi/posizioni (Primario, Perpetuo, Gemello e rientri) che
 * condividono esattamente lo stesso wallet MetaMask.
 */
async function getPercorsoAccount(wallet, account) {
  const pg = require('./pg-connection-manager');
  const w = wallet.toLowerCase();
  const accountId = Number(account?.id);

  // 1. Posizione piu recente di QUESTO percorso. Non si mescolano percorsi
  // differenti che condividono lo stesso wallet.
  const posizione = Number.isInteger(accountId) && accountId > 0
    ? await pg.queryOne(
        `SELECT
           t.livello, t.numero AS tavola_numero, t.status AS tavola_status,
           t.tipo AS tavola_tipo, t.turno,
           p.casella, p.tipo AS posizione_tipo, p.created_at
         FROM posizioni p
         JOIN tavole t ON p.tavola_id = t.id
         WHERE p.account_id = $1
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 1`,
        [accountId]
      )
    : await pg.queryOne(
        `SELECT
           t.livello, t.numero AS tavola_numero, t.status AS tavola_status,
           t.tipo AS tavola_tipo, t.turno,
           p.casella, p.tipo AS posizione_tipo, p.created_at
         FROM posizioni p
         JOIN tavole t ON p.tavola_id = t.id
         WHERE p.wallet = $1
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 1`,
        [w]
      );

  if (posizione) {
    return livelloToPercorso(Number(posizione.livello), {
      status: posizione.tavola_status,
      tavolaNumero: posizione.tavola_numero,
      turno: posizione.turno,
      casella: posizione.casella,
      tipoPosizione: posizione.posizione_tipo,
      source: 'posizioni'
    });
  }

  // 2. Storico avanzamenti della stessa identita posizionale.
  const storico = Number.isInteger(accountId) && accountId > 0
    ? await pg.queryOne(
        `SELECT da_livello, a_livello, evento, created_at
         FROM storico_avanzamenti
         WHERE account_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [accountId]
      )
    : await pg.queryOne(
        `SELECT da_livello, a_livello, evento, created_at
         FROM storico_avanzamenti
         WHERE wallet = $1
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [w]
      );

  if (storico) {
    const livello = storico.a_livello === null || storico.a_livello === undefined
      ? Number(storico.da_livello)
      : Number(storico.a_livello);
    return livelloToPercorso(livello, {
      status: storico.evento,
      source: 'storico'
    });
  }

  // 3. Un ticket/sigla esistente identifica un percorso che deve ancora
  // materializzare una posizione successiva.
  if (account?.ticket_number || account?.sigla) {
    return livelloToPercorso(0, {
      status: account.status || 'REGISTRATO',
      source: 'ticket'
    });
  }

  return {
    uiLevel: 1,
    livelloNumero: null,
    livelloNome: 'Registrato',
    status: account?.status || 'REGISTRATO',
    source: 'fallback'
  };
}

function percorsoPubblico(account, percorso) {
  const numeroPosizionale = account.ticket_number == null ? null : Number(account.ticket_number);
  const sigla = account.sigla || (numeroPosizionale == null ? null : String(numeroPosizionale));
  return {
    // ID tecnico interno del percorso: NON e un wallet e NON identifica una persona diversa.
    percorso_id: Number(account.id),
    numero_posizionale: numeroPosizionale,
    sigla,
    tipo: account.tipo,
    status: account.status,
    origin_kind: account.origin_kind || null,
    created_at: account.created_at || null,
    percorso
  };
}

/**
 * Snapshot bulk dei percorsi appartenenti allo stesso wallet/persona.
 *
 * Evita il pattern N+1: anche con 50/100 rientri l'Area Personale esegue
 * soltanto due query di stato (ultima posizione + ultimo avanzamento), non
 * due query per ogni percorso.
 */
async function getPercorsiWalletSnapshot(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const pg = require('./pg-connection-manager');
  const ids = accounts
    .map(a => Number(a.id))
    .filter(id => Number.isInteger(id) && id > 0);
  if (!ids.length) return [];

  const [posizioni, avanzamenti] = await Promise.all([
    pg.queryMany(
      `SELECT DISTINCT ON (p.account_id)
         p.account_id,
         t.livello,
         t.numero AS tavola_numero,
         t.status AS tavola_status,
         t.turno,
         p.casella,
         p.tipo AS posizione_tipo,
         p.created_at
       FROM posizioni p
       JOIN tavole t ON t.id = p.tavola_id
       WHERE p.account_id = ANY($1::bigint[])
       ORDER BY p.account_id, p.created_at DESC, p.id DESC`,
      [ids]
    ),
    pg.queryMany(
      `SELECT DISTINCT ON (s.account_id)
         s.account_id,
         s.da_livello,
         s.a_livello,
         s.evento,
         s.created_at
       FROM storico_avanzamenti s
       WHERE s.account_id = ANY($1::bigint[])
       ORDER BY s.account_id, s.created_at DESC, s.id DESC`,
      [ids]
    )
  ]);

  const posizioneByAccount = new Map(posizioni.map(row => [Number(row.account_id), row]));
  const avanzamentoByAccount = new Map(avanzamenti.map(row => [Number(row.account_id), row]));

  return accounts.map(account => {
    const accountId = Number(account.id);
    const posizione = posizioneByAccount.get(accountId);
    if (posizione) {
      return percorsoPubblico(account, livelloToPercorso(Number(posizione.livello), {
        status: posizione.tavola_status,
        tavolaNumero: posizione.tavola_numero,
        turno: posizione.turno,
        casella: posizione.casella,
        tipoPosizione: posizione.posizione_tipo,
        source: 'posizioni'
      }));
    }

    const storico = avanzamentoByAccount.get(accountId);
    if (storico) {
      const livello = storico.a_livello === null || storico.a_livello === undefined
        ? Number(storico.da_livello)
        : Number(storico.a_livello);
      return percorsoPubblico(account, livelloToPercorso(livello, {
        status: storico.evento,
        source: 'storico'
      }));
    }

    if (account.ticket_number || account.sigla) {
      return percorsoPubblico(account, livelloToPercorso(0, {
        status: account.status || 'REGISTRATO',
        source: 'ticket'
      }));
    }

    return percorsoPubblico(account, {
      uiLevel: 1,
      livelloNumero: null,
      livelloNome: 'Registrato',
      status: account.status || 'REGISTRATO',
      source: 'fallback'
    });
  });
}

/**
 * Profilo wallet per l'Area Personale.
 *
 * Un solo wallet MetaMask = una sola persona. Lo stesso wallet puo avere
 * molte posizioni/percorso con numerazioni diverse; Perpetuo/Gemello sono
 * nomi genealogici del percorso e non wallet differenti.
 */
async function getAccountInfo(wallet) {
  const w = String(wallet || '').trim().toLowerCase();
  const accounts = await db.getAccountsByWallet(w);
  if (!accounts.length) return null;

  const principale = accounts.find(a => a.tipo === 'PRIMARIO' && !a.source_account_id)
    || accounts.find(a => a.tipo === 'PRIMARIO')
    || accounts[0];

  // Le righe accounts sono identita posizionali interne che condividono il
  // medesimo wallet/persona. Lo snapshot bulk evita query ripetute quando i
  // rientri producono molte nuove posizioni numerate sullo stesso MetaMask.
  const percorsi = await getPercorsiWalletSnapshot(accounts);

  percorsi.sort((a, b) => {
    const ta = a.numero_posizionale == null ? Number.MAX_SAFE_INTEGER : a.numero_posizionale;
    const tb = b.numero_posizionale == null ? Number.MAX_SAFE_INTEGER : b.numero_posizionale;
    if (ta !== tb) return ta - tb;
    return a.percorso_id - b.percorso_id;
  });

  const perpetui = accounts.filter(a => a.tipo === 'PERPETUO').length;
  const gemelli = accounts.filter(a => a.tipo === 'GEMELLO').length;
  const primari = accounts.filter(a => a.tipo === 'PRIMARIO').length;

  return {
    ...principale,
    wallet: w,
    // Campi aggregati wallet-level. "accounts" non vengono esposti come persone.
    totale_percorsi: percorsi.length,
    percorsi_primari: primari,
    perpetui_rilasciati: perpetui,
    gemelli_rilasciati: gemelli,
    percorsi,
    percorso: percorsi.find(p => p.percorso_id === Number(principale.id))?.percorso || null
  };
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  registraAccount,
  creaPerpetuo,
  creaGemello,
  calcolaSiglaPerpetuo,
  calcolaSiglaGemello,
  countPerpetui,
  countGemelli,
  getAccountInfo,
  getPercorsoAccount,
  getPercorsiWalletSnapshot,
  QUOTA_INGRESSO
};
