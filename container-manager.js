/**
 * 📦 PHARAOH - Container Manager
 *
 * Gestisce le code operative ancora attive nel sistema:
 * - Contenitore 5:   ingressi da 100 pronti per il livello Entrata
 * - Contenitore 5.2: uscite Entrata da 500 pronte per il Sistema PHARAOH
 *
 * Le code legacy eliminate non fanno parte del modello operativo corrente.
 */

const db = require('./db-manager');
const rules = require('./rules-engine');

// ========================================
// OPERAZIONI BASE
// ========================================

/**
 * Inserisce un account in un contenitore operativo.
 */
async function inserisciInContenitore({ tipo, wallet, ticketNumber, nome, importo, provenienza }, client = null) {
  return await db.addToContenitore({
    tipo,
    wallet,
    ticketNumber,
    nome,
    importo,
    provenienza
  }, client);
}

/**
 * Preleva il prossimo account da un contenitore FIFO.
 * @param {string} tipo - '5' | '5.2'
 * @returns {Object|null} Account prelevato o null se vuoto
 */
async function prelevaProssimo(tipo, client = null) {
  const item = await db.getNextFromContenitore(tipo, client);
  if (!item) return null;

  await db.markContenitoreUsato(item.id, client);

  console.log(`   📤 Prelevato da contenitore ${tipo}: ticket ${item.ticket_number} (${item.wallet.substring(0, 10)}...)`);
  return item;
}

/**
 * Conta gli elementi in attesa in un contenitore.
 */
async function conta(tipo, client = null) {
  return await db.countInContenitore(tipo, client);
}

// ========================================
// TRASFERIMENTO TRA CONTENITORI
// ========================================

/**
 * Trasferisce un Sacerdote-erede uscente dal livello di entrata
 * al contenitore 5.2 (pronto per Sistema Pharaoh con 500).
 *
 * La progressione Entrata utilizza 500 USDC. L'eventuale quota strutturale
 * da 100 USDC viene riportata alla tavola successiva dal motore Entrata e
 * non viene sottratta qui come accantonamento.
 */
async function trasferisciAContenitore52(wallet, ticketNumber, nome) {
  console.log(`   📦 Trasferimento a contenitore 5.2: ${nome} (ticket ${ticketNumber})`);

  return await inserisciInContenitore({
    tipo: '5.2',
    wallet,
    ticketNumber,
    nome,
    importo: rules.IMPORTI.USCITA_ENTRATA_NETTO,
    provenienza: 'USCITA_ENTRATA'
  });
}

// ========================================
// STATO CONTENITORI
// ========================================

/**
 * Ottiene lo stato delle sole code operative ancora esistenti.
 */
async function getStatoContenitori() {
  const c5 = await conta('5');
  const c52 = await conta('5.2');

  return {
    contenitore_5: { tipo: '5', descrizione: 'Pronti ingresso 100', inAttesa: c5 },
    contenitore_52: { tipo: '5.2', descrizione: 'Pronti ingresso 500 (Sistema PHARAOH)', inAttesa: c52 }
  };
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  inserisciInContenitore,
  prelevaProssimo,
  conta,
  trasferisciAContenitore52,
  getStatoContenitori
};
