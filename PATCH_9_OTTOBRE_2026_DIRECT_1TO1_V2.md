> **NOTA STORICA — SUPERATO.** Questo documento descrive un checkpoint precedente dell'8/9 ottobre 2026. Non rappresenta lo stato della release corrente. La release corrente e documentata in `00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md` e governata da `release-state.json` + `ops/v4-release-gate.js`.

# PHARAOH — patch DIRECT 1:1 ROG -> HUMAN ROG -> PHARAOH

Data: 9 ottobre 2026  
Stato: **NON DEPLOY**  
Protocollo runtime introdotto: `ROG_DIRECT_CYCLE_1TO1_V2`

## Regola autoritativa implementata

Per ogni nuova posizione PHARAOH DIRECT deve esistere un nuovo ciclo ROG causale e dedicato:

`1 nuova donazione ROG -> 1 nuova HUMAN ROG -> 1 nuova posizione PHARAOH`

Una HUMAN ROG storica, anche se recente o non ancora usata da PHARAOH, **non** abilita una nuova posizione PHARAOH.

## Correzione runtime

Il vecchio percorso poteva cercare una HUMAN ROG recente per wallet e creare/bindare una sessione PHARAOH a posteriori. Quel comportamento e' stato rimosso come criterio di eligibility.

Il nuovo percorso richiede invece:

1. verifica Community ROG;
2. apertura di una sessione PHARAOH DIRECT `ROG_DIRECT_CYCLE_1TO1_V2` **prima** della nuova donazione ROG;
3. verifica on-chain del trasferimento ROG da 2 USDC per la stessa sessione;
4. verifica `DonationRegistered` ROG per la stessa sessione/donationId;
5. completamento ROG con una HUMAN specifica restituita dalla completion;
6. prova temporale che trasferimento, registration e HUMAN non precedano l'apertura del ciclo;
7. finestra eligibility HUMAN di 60 minuti;
8. claim atomico PHARAOH di 10 minuti, con blocco doppio browser/dispositivo;
9. verifica live che la stessa `rog_human_position` sia ancora una HUMAN dello stesso wallet;
10. pagamento/verifica PHARAOH e Registry;
11. materializzazione di una sola posizione PHARAOH;
12. consumo definitivo della sessione/prova. La seconda posizione richiede un nuovo ciclo e una nuova HUMAN.

## Anti-replay e recovery

Restano attivi i vincoli univoci gia' esistenti su prova ROG/PHARAOH. Il percorso nuovo rifiuta il riuso di tx ROG, register tx, donationId o HUMAN gia' legati a un'altra sessione.

Se il `pharaoh_tx_hash` e' gia' stato persistito, il recovery della **stessa** sessione e' consentito senza imporre un secondo ROG o un secondo pagamento PHARAOH. Questo evita doppie donazioni dopo un'interruzione tra verifica tx e completamento Registry/materializzazione.

Il controllo di freschezza e' applicato anche nelle funzioni centrali di persistenza della prova, cosi' il worker/retry asincrono non puo' aggirare il vincolo temporale.

## File runtime modificati

- `direct-donation-manager.js`
- `direct-donation-session-manager.js`
- `direct-rog-eligibility-manager.js`
- `api-server.js`
- `security-manager.js`
- `package.json`

## Test modificati/aggiunti

- nuovo `scripts/test-direct-1to1-golden-e2e.js`;
- `scripts/test-direct-rog-external-gate.js`;
- `scripts/test-direct-gift-static.js`;
- `scripts/test-direct-gift-dynamic.js`;
- comando `npm run test:direct-1to1`.

Il golden E2E usa i manager DIRECT e il `donation-flow-manager` reali, con adapter isolati in memoria per PostgreSQL/chain/ROG/Registry/economia. Copre:

- rifiuto HUMAN storica;
- rifiuto prova ROG precedente all'apertura del ciclo;
- ciclo fresco valido;
- doppio browser/dispositivo;
- release claim;
- claim timeout;
- retry idempotente;
- replay prova ROG;
- recovery dopo `pharaoh_tx_hash` gia' noto;
- rifiuto HUMAN piu' vecchia del ciclo;
- seconda posizione solo tramite secondo ciclo ROG/HUMAN.

Risultato locale: **PASS, 15 controlli**, 2 cicli distinti -> 2 HUMAN distinte -> 2 posizioni PHARAOH.

## Schema e migrazioni

Nessuna nuova migrazione. Il piano resta a **28 migrazioni**. Nessuna SQL del checkpoint e' stata modificata per questa correzione.

## Limite della certificazione corrente

In questo ambiente non sono disponibili `pg`, PostgreSQL nativo/Docker, `ethers` e `dotenv`; `npm ci --offline` fallisce per pacchetti non presenti in cache. Quindi:

- golden application-flow E2E: **PASS**;
- test mirati DIRECT/kill-switch: **PASS**;
- sintassi JS: **138/138 PASS**;
- suite forense: **48 PASS, 0 FAIL, 3 BLOCKED_DEPENDENCY**;
- E2E con PostgreSQL reale/clone: **NON ESEGUITO in questo ambiente**;
- LIVE_CHAIN: **NON ESEGUITO**;
- produzione: **NON TOCCATA**.

Per questo il pacchetto rimane **NON_DEPLOY**. Non e' lecito trasformare questo PASS isolato in una certificazione di staging/produzione.
