/**
 * 📜 PHARAOH - Rules Engine
 *
 * Implementazione delle 14 regole che governano il sistema PHARAOH.
 * Ogni regola è una funzione pura che può essere testata indipendentemente.
 *
 * REGOLE (dal PDF pagina 16):
 *  1. Account A (Fondo) inizia sempre il 1° turno in ogni livello
 *  2. Sdoppiamento: ogni donatore genera una tavola con sé al centro
 *  3. Rilascio Funzioni all'uscita del 3° livello (Rha)
 *  4. Entrata Faraone dal 2° turno: segue numerazione tavole
 *  5. Numerazione sequenziale tavole
 *  6. Entrata Funzioni dal 2° turno in poi
 *  7. Simbionti NON duplicabili
 *  8. Identificazione e numerazione Perpetuo (A.1, A.2 ...)
 *  9. Identificazione e numerazione Gemello (1-A, 2-A ...)
 * 10. Prenotazione ticket Gemelli (da 26, +14)
 * 11. Perpetuo non rilascia Gemello, solo Perpetuo successivo
 * 12. Solo Account Secondari passano da L3 a L4
 * 13. Uscita L4: 10.000 per L5 + 500 progetti umanitari + 500 per 5 rientri Entrata
 * 14. Uscita L5: 5.000 in 50 rientri Entrata + 6.000 quota diretta al ricevente + 19.000 netto base
 */

// ========================================
// COSTANTI FINANZIARIE
// ========================================

const IMPORTI = {
  DONO_ENTRATA: 100,
  DONO_PHARAOH: 500,
  TRATTENUTA_FONDO_ENTRATA: 100, // 100 USDC riportati nella tavola Entrata successiva (Cassa PHARAOH)
  USCITA_ENTRATA_NETTO: 500,    // 600 ricevuti - 100 riporto strutturale = 500 per la progressione

  // Uscita L3 (Rha) — distribuzione dei 9.000€:
  //   9.000€ = 18 sacerdoti × 500€
  //   3.000€ vengono TRATTENUTI dal payout del ricevente RHA:
  //          → 2.500€ restano destinati a struttura/Funzioni e alle altre finalita previste;
  //          → 500€ escono come sostegno reciproco cross-movement (300 ROG + 200 URANUS).
  //          → Funzioni (Simbionti, Perpetuo, Gemello) + quota cross RHA 500
  //            La quota cross RHA e interamente destinata ai movimenti gemelli:
  //            300 USDC ROG = 150 dual HUMAN+PILETTA; 200 USDC URANUS = 10 dual CASSA URANUS+HUMAN.
  //   6.000€ netto al Faraone (Account Primario)
  DONO_TOTALE_L3: 9000,
  TRATTENUTA_CASSA_L3: 3000,    // 3.000€ trattenuti dal payout; 500 finanziano i cross RHA V2
  USCITA_L3_PRIMARIO: 6000,     // 9.000 - 3.000 = 6.000 netto Faraone
  TRATTENUTA_L4_INGRESSO: 5000, // per passare al L4 (Account Secondario)
  USCITA_L3_SECONDARIO: 1000,   // 9.000 - 3.000 - 5.000 (Account Secondario)

  // Funzioni e allocazioni finanziate dalla riserva cassa (3.000€ totali).
  // Dei 3.000 USDC, 500 sono sempre destinati al sostegno reciproco quando il ricevente esce da RHA,
  // sia per account primari (FONDO/PRIMARIO) sia per account secondari (PERPETUO/GEMELLO).
  COSTO_SIMBIONTI: 1500,        // 3 Simbionti × 500 (occupano slot Pharaoh)
  COSTO_PERPETUO: 500,          // 1 Perpetuo (continuazione account)
  COSTO_GEMELLO: 500,           // 1 Gemello (nuovo account)
  RHA_ROG_OUTBOUND: 300,        // 300 / 2 = 150 posizioni dual HUMAN + PILETTA
  RHA_ROG_DUAL_POSITIONS: 150,
  RHA_URANUS_OUTBOUND: 200,     // 200 / 20 = 10 posizioni dual CASSA URANUS + HUMAN
  RHA_URANUS_DUAL_POSITIONS: 10,

  // Uscita L4 (Thot)
  DONO_TOTALE_L4: 15000,
  TRATTENUTA_L5_INGRESSO: 10000,
  TRATTENUTA_PROGETTI_UMANITARI_L4: 500,
  DESTINAZIONE_PROGETTI_UMANITARI_L4: 'PROGETTI_UMANITARI',
  TRATTENUTA_RIENTRI_ENTRATA_L4: 500,
  NUM_RIENTRI_ENTRATA_L4: 5,
  USCITA_L4_NETTO: 4000,

  // Uscita L5 (Iside)
  DONO_TOTALE_L5: 30000,
  TRATTENUTA_RIENTRI_ENTRATA_L5: 5000,
  NUM_RIENTRI_ENTRATA_L5: 50,
  QUOTA_RICEVENTE_L5: 6000,
  USCITA_L5_NETTO_BASE: 19000,
  USCITA_L5_PAYOUT_TOTALE: 25000,
  USCITA_L5_NETTO: 25000,

  // Sacerdoti necessari per completare il Blocco 1:
  //   1° turno (A):
  //     18 sacerdoti UMANI × 6 donatori = 108 donatori
  //     + 6 per la tavola di A (A è il Faraone ricevente, non un sacerdote)
  //     = 114 DONATORI TOTALI per far uscire A da Rha
  //
  //   Dal 2° turno: 13 sacerdoti × 6 donatori = 78 donatori
  //   (il Faraone del turno 2+ è già in posizione via sdoppiamento, non conta)
  //
  //   Perché 13 e non 18?
  //   Le FUNZIONI rilasciate dal Faraone precedente coprono 5 slot:
  //     3 Simbionti (non duplicabili) → -3 sacerdoti umani
  //     1 Perpetuo → -1 sacerdote umano
  //     1 Gemello  → -1 sacerdote umano
  //     Totale riduzione: -5  → 18 - 5 = 13
  //
  //   Le Funzioni donano comunque 500€ ciascuna al Faraone (usando i 3.000€
  //   trattenuti dal Faraone precedente), quindi il totale rimane sempre 9.000€:
  //     13 sacerdoti umani × 500 = 6.500
  //     5 Funzioni         × 500 = 2.500
  //     Totale                   = 9.000 €
  SACERDOTI_PRIMO_TURNO: 18,
  SACERDOTI_DAL_SECONDO: 13
};

// ========================================
// REGOLA 1: Account Fondo sempre primo
// ========================================

/**
 * Reg.1: L'account «A» (Fondo) è sempre il primo Faraone
 * all'inizio del 1° turno di ogni livello.
 */
function regolaFondoPrimo(turno, livello) {
  if (turno === 1) {
    return {
      faraoneWallet: 'FONDO',
      faraoneTipo: 'FONDO',
      regola: 1,
      descrizione: `Account Fondo (A) inizia il 1° turno al livello ${livello}`
    };
  }
  return null; // Non applicabile per turni > 1
}

// ========================================
// REGOLA 4: Entrata Faraone dal 2° turno
// ========================================

/**
 * Reg.4: Dal 2° turno, il Faraone di turno entra con la propria tavola
 * di sdoppiamento, seguendo la numerazione tavole.
 *
 * Esempio: tavola nr.1 chiusa al turno 1, tavola nr.2 (sdoppiata dal donatore 1)
 * diventa la tavola del Faraone al turno 2.
 *
 * @param {number} turnoCorrente - Turno che sta iniziando
 * @param {Array} tavoleSdoppiate - Tavole sdoppiate dal turno precedente, ordinate per numero
 * @returns {Object} { faraoneWallet, tavolaNumero }
 */
function regolaEntrateFaraoneTurno(turnoCorrente, tavoleSdoppiate) {
  if (turnoCorrente <= 1 || !tavoleSdoppiate || tavoleSdoppiate.length === 0) {
    return null;
  }

  // La prima tavola sdoppiata del turno precedente diventa la tavola del Faraone
  const tavolaFaraone = tavoleSdoppiate[0];

  return {
    faraoneWallet: tavolaFaraone.faraone_wallet,
    tavolaNumero: tavolaFaraone.numero,
    regola: 4,
    descrizione: `Faraone ${tavolaFaraone.faraone_wallet} entra con tavola #${tavolaFaraone.numero}`
  };
}

// ========================================
// REGOLA 5: Numerazione tavole
// ========================================

/**
 * Reg.5: Le tavole sono numerate sequenzialmente e la numerazione
 * prosegue da un turno all'altro senza reset.
 *
 * Turno 1: tavole 1-29 (primo turno L1 con 18 sacerdoti)
 * Turno 2: tavole 30-54 (25 tavole, ridotte dalle funzioni)
 * Turno 3: tavole 55-79
 * ...
 *
 * @param {number} ultimaTavolaTurnoPrecedente - Ultimo numero tavola del turno precedente
 * @returns {number} Primo numero tavola del nuovo turno
 */
function regolaNumerazioneTavole(ultimaTavolaTurnoPrecedente) {
  return (ultimaTavolaTurnoPrecedente || 0) + 1;
}

// ========================================
// REGOLA 7: Simbionti non duplicabili
// ========================================

/**
 * Reg.7: I Simbionti (Cloni) NON generano tavole di sdoppiamento.
 * Riducono quindi il numero di donatori necessari (-3) e di tavole.
 */
function regolaSimbionteDuplicabile(tipo) {
  return tipo !== 'SIMBIONTE';
}

// ========================================
// REGOLA 10: Prenotazione ticket Gemelli
// ========================================

/**
 * Reg.10: Il sistema prenota il ticket per tutti i Gemelli futuri,
 * partendo dal nr. 26 e continuando con multipli di 14.
 * Es: 26, 40, 54, 68, 82, 96, ...
 *
 * @param {number} gemelloOrdine - Ordine del gemello (1=primo, 2=secondo, ...)
 * @returns {number} Ticket prenotato
 */
function regolaTicketGemello(gemelloOrdine) {
  return 26 + (gemelloOrdine - 1) * 14;
}

// ========================================
// REGOLA 11: Perpetuo senza Gemello
// ========================================

/**
 * Reg.11: Il Perpetuo NON rilascia il Gemello.
 * Rilascia solo il suo Perpetuo successivo.
 *
 * Es: A.1 → A.2 (sì), A.1 → 1-A.1 (NO)
 *
 * @param {string} tipoAccount - PRIMARIO | PERPETUO | GEMELLO
 * @returns {Object} { rilasciaPerpetuo, rilasciaGemello }
 */
function regolaRilasciFunzioni(tipoAccount) {
  switch (tipoAccount) {
    case 'PRIMARIO':
    case 'FONDO':  // Il Fondo (A) si comporta come un Account Primario
      return { rilasciaPerpetuo: true, rilasciaGemello: true, rilasciaSimbionti: true };
    case 'PERPETUO':
      // Reg.11: solo Perpetuo successivo, NO Gemello
      return { rilasciaPerpetuo: true, rilasciaGemello: false, rilasciaSimbionti: true };
    case 'GEMELLO':
      // Il Gemello è trattato come account normale
      return { rilasciaPerpetuo: true, rilasciaGemello: true, rilasciaSimbionti: true };
    default:
      return { rilasciaPerpetuo: false, rilasciaGemello: false, rilasciaSimbionti: false };
  }
}

// ========================================
// REGOLA 12: Solo secondari al L4
// ========================================

/**
 * Reg.12: Solo Account Secondari (Perpetui e Gemelli) possono
 * passare dal 3° livello al 4°. Gli Account Primari escono
 * definitivamente dopo L3 con 6.000.
 *
 * @param {string} tipoAccount
 * @returns {boolean}
 */
function regolaPuoPassareAlL4(tipoAccount) {
  // FONDO e PRIMARIO escono definitivamente dal L3, solo secondari proseguono
  return tipoAccount === 'PERPETUO' || tipoAccount === 'GEMELLO';
}

function classificaAccountRha(tipoAccount) {
  const tipo = String(tipoAccount || '').trim().toUpperCase();
  if (tipo === 'FONDO' || tipo === 'PRIMARIO') {
    return { tipo, categoria: 'PRIMARIO', passaAlL4: false };
  }
  if (tipo === 'PERPETUO' || tipo === 'GEMELLO') {
    return { tipo, categoria: 'SECONDARIO', passaAlL4: true };
  }
  throw new Error(`Tipo account non valido per uscita Rha: ${tipoAccount || 'MANCANTE'}`);
}

function validaAccountSecondario(tipoAccount, livello = 'Thot') {
  const classificazione = classificaAccountRha(tipoAccount);
  if (classificazione.categoria !== 'SECONDARIO') {
    throw new Error(
      `Accesso ${livello} riservato agli Account Secondari: ${classificazione.tipo}`
    );
  }
  return classificazione;
}

// ========================================
// REGOLE 3, 13, 14: Calcolo uscita livello
// ========================================

/**
 * Calcola le trattenute e il netto per l'uscita da un livello.
 *
 * @param {number} livello - 3, 4 o 5
 * @param {string} tipoAccount - PRIMARIO | PERPETUO | GEMELLO
 * @param {number} doniRicevuti - Totale doni ricevuti
 * @returns {Object} Dettaglio trattenute e netto
 */
function calcolaUscitaLivello(livello, tipoAccount, doniRicevuti) {
  switch (livello) {
    case 3: { // Rha
      const totale = Number(doniRicevuti);
      if (!Number.isFinite(totale) || totale !== IMPORTI.DONO_TOTALE_L3) {
        throw new Error(
          `Uscita Rha non valida: attesi ${IMPORTI.DONO_TOTALE_L3}, ricevuti ${doniRicevuti}`
        );
      }
      const classificazione = classificaAccountRha(tipoAccount);
      // 3.000€ trattenuti dal payout: 500 finanziano i cross RHA, il resto resta alla struttura/funzioni.
      const riservaCassa = IMPORTI.TRATTENUTA_CASSA_L3;  // 3000
      const rilasci = regolaRilasciFunzioni(classificazione.tipo);
      const puoPassareL4 = classificazione.passaAlL4;

      let netto;
      let ingressoL4 = 0;

      if (puoPassareL4) {
        // Account Secondario: 9000 - 3000 (cassa) - 5000 (ingresso L4) = 1000
        ingressoL4 = IMPORTI.TRATTENUTA_L4_INGRESSO;
        netto = totale - riservaCassa - ingressoL4;
      } else {
        // Account Primario: 9000 - 3000 (cassa) = 6.000 netto, esce definitivamente
        netto = totale - riservaCassa;
      }

      return {
        livello: 3,
        tipoAccount: classificazione.tipo,
        categoriaAccount: classificazione.categoria,
        doniRicevuti: totale,
        trattenutaCassa: riservaCassa,    // 3.000€ rimangono in cassa
        trattenutaIngressoL4: ingressoL4,
        netto,
        passaAlL4: puoPassareL4,
        uscitaDefinitiva: !puoPassareL4,
        rilasci,
        dettaglioFunzioni: {
          simbionti: rilasci.rilasciaSimbionti ? { numero: 3, importo: IMPORTI.COSTO_SIMBIONTI } : null,
          perpetuo: rilasci.rilasciaPerpetuo ? { importo: IMPORTI.COSTO_PERPETUO } : null,
          gemello: rilasci.rilasciaGemello ? { importo: IMPORTI.COSTO_GEMELLO } : null,
          allocazioneRha: {
            rogUsdc: IMPORTI.RHA_ROG_OUTBOUND,
            rogDualPositions: IMPORTI.RHA_ROG_DUAL_POSITIONS,
            uranusUsdc: IMPORTI.RHA_URANUS_OUTBOUND,
            uranusDualPositions: IMPORTI.RHA_URANUS_DUAL_POSITIONS,
            repayable: false
          }
        }
      };
    }

    case 4: { // Thot - Reg.13
      const totale = Number(doniRicevuti);
      const classificazione = validaAccountSecondario(tipoAccount, 'Thot');
      if (!Number.isFinite(totale) || totale !== IMPORTI.DONO_TOTALE_L4) {
        throw new Error(
          `Uscita Thot non valida: attesi ${IMPORTI.DONO_TOTALE_L4}, ricevuti ${doniRicevuti}`
        );
      }
      const ingressoL5 = IMPORTI.TRATTENUTA_L5_INGRESSO;
      const progettiUmanitari = IMPORTI.TRATTENUTA_PROGETTI_UMANITARI_L4;
      const rientriEntrata = IMPORTI.TRATTENUTA_RIENTRI_ENTRATA_L4;
      const netto = totale - ingressoL5 - progettiUmanitari - rientriEntrata;

      return {
        livello: 4,
        tipoAccount: classificazione.tipo,
        categoriaAccount: classificazione.categoria,
        doniRicevuti: totale,
        trattenutaIngressoL5: ingressoL5,
        trattenutaProgettiUmanitari: progettiUmanitari,
        destinazioneProgettiUmanitari: IMPORTI.DESTINAZIONE_PROGETTI_UMANITARI_L4,
        trattenutaRientriEntrata: rientriEntrata,
        numRientriEntrata: IMPORTI.NUM_RIENTRI_ENTRATA_L4,
        importoSingoloRientro: IMPORTI.DONO_ENTRATA,
        netto,
        passaAlL5: true
      };
    }

    case 5: { // Iside - Reg.14
      const totale = Number(doniRicevuti);
      const classificazione = validaAccountSecondario(tipoAccount, 'Iside');
      if (!Number.isFinite(totale) || totale !== IMPORTI.DONO_TOTALE_L5) {
        throw new Error(
          `Uscita Iside non valida: attesi ${IMPORTI.DONO_TOTALE_L5}, ricevuti ${doniRicevuti}`
        );
      }
      const rientriEntrata = IMPORTI.TRATTENUTA_RIENTRI_ENTRATA_L5;
      const nettoBase = IMPORTI.USCITA_L5_NETTO_BASE;
      const quotaRicevente = IMPORTI.QUOTA_RICEVENTE_L5;
      const payoutRicevente = nettoBase + quotaRicevente;

      if (rientriEntrata + payoutRicevente !== totale) {
        throw new Error('Invariante economica Iside non valida');
      }

      return {
        livello: 5,
        tipoAccount: classificazione.tipo,
        categoriaAccount: classificazione.categoria,
        doniRicevuti: totale,
        trattenutaRientriEntrata: rientriEntrata,
        numRientriEntrata: IMPORTI.NUM_RIENTRI_ENTRATA_L5,
        importoSingoloRientro: IMPORTI.DONO_ENTRATA,
        nettoBase,
        quotaRicevente,
        payoutRicevente,
        netto: payoutRicevente,
        uscitaDefinitiva: true
      };
    }

    default:
      throw new Error(`Livello ${livello} non prevede uscita con trattenute`);
  }
}

// ========================================
// REGOLA 6: Posizionamento Funzioni
// ========================================

/**
 * Reg.6: Le Funzioni vengono inserite al turno successivo del loro rilascio.
 * Posizionamento fisso nella struttura:
 *
 * - 3 Simbionti: prime 2 tavole del livello 2 (Horus): 1.5 tavole
 *   → tav1: SIM1, SIM2 (ma tav Horus è da 3, quindi SIM1 + SIM2 + terzo posto)
 *   → Effettivamente: SIM1+SIM2 nella prima tavola Horus, SIM3 + Perpetuo nella seconda
 * - Perpetuo: seconda casella della seconda tavola Horus
 * - Gemello: seconda casella della settima tavola Rha (L3)
 *
 * @param {number} turno - Turno in cui le funzioni vengono inserite
 * @returns {Object} Mappa posizionamenti
 */
function regolaPosizionamentoFunzioni(turno) {
  return {
    simbionti: {
      livello: 2, // Horus
      tavole: [
        { tavolaRelativa: 1, caselle: [1, 2] },  // 2 simbionti nella prima tavola Horus
        { tavolaRelativa: 2, caselle: [1] }       // 1 simbionte nella seconda tavola Horus
      ]
    },
    perpetuo: {
      livello: 2, // Horus
      tavolaRelativa: 2, // Seconda tavola Horus
      casella: 2         // Seconda casella (dopo il simbionte)
    },
    gemello: {
      livello: 3, // Rha
      tavolaRelativa: 7, // Settima tavola Rha
      casella: 2
    },
    turnoInserimento: turno
  };
}

// ========================================
// CALCOLO SACERDOTI NECESSARI
// ========================================

/**
 * Calcola quanti sacerdoti servono per il turno.
 * Primo turno: 18 (6 x 3 tavole Horus/Rha piene)
 * Dal secondo: 13 (grazie ai 3 Simbionti + Perpetuo + Gemello = -5)
 */
function calcolaSacerdotiNecessari(turno) {
  return turno === 1 ? IMPORTI.SACERDOTI_PRIMO_TURNO : IMPORTI.SACERDOTI_DAL_SECONDO;
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  // Regole
  regolaFondoPrimo,
  regolaEntrateFaraoneTurno,
  regolaNumerazioneTavole,
  regolaSimbionteDuplicabile,
  regolaTicketGemello,
  regolaRilasciFunzioni,
  regolaPuoPassareAlL4,
  classificaAccountRha,
  validaAccountSecondario,
  calcolaUscitaLivello,
  regolaPosizionamentoFunzioni,
  calcolaSacerdotiNecessari,

  // Costanti
  IMPORTI
};
