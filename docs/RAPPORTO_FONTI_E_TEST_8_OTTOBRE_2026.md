> **NOTA STORICA — SUPERATO.** Questo documento descrive un checkpoint precedente dell'8/9 ottobre 2026. Non rappresenta lo stato della release corrente. La release corrente e documentata in `00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md` e governata da `release-state.json` + `ops/v4-release-gate.js`.

# PHARAOH - rapporto di continuazione con le fonti del 7 ottobre

**Data della lavorazione: 8 ottobre 2026. STATO: NON DEPLOYABILE.**

Questo e un pacchetto dell'intero albero sorgente aggiornato, non una patch isolata.
Non e il backend definitivo richiesto e non viene presentato come pronto al deploy.
L'avvio applicativo e la modifica dello schema sono deliberatamente bloccati.

## 1. Provenienza e conservazione

Input effettivamente accessibile:
`PHARAOH_BACKEND_V4_FORENSIC_CHECKPOINT_8_OTTOBRE_NON_DEPLOY.zip`

SHA-256 input:
`35cfb0fd8af945bd89c822d618e4ea83a7e708dca08e5620e45813261222421a`

E stata verificata la disponibilita delle versioni corrispondenti ai 114 file del
manifest interno dichiarato del 5 ottobre. Per i tre file gia modificati dal
checkpoint e stata trovata una copia byte-identica al manifest nell'archivio del
2 ottobre: questo NON cambia la baseline di produzione. Non e stata verificata
l'identita del commit attualmente distribuito su Coolify.

Le 25 migration, il piano migration e il lockfile dipendenze (27 file) restano
byte-identici alla baseline dichiarata. I 21 test storici della baseline non sono
stati riscritti per ottenere un PASS. Nessun percorso della baseline e stato tolto.

Non e stato aperto, modificato, resettato o migrato alcun DB di produzione.
Non sono stati trasferiti USDC o creati wallet/account/posizioni reali.
Non e stato eseguito un deploy. La conservazione dei dati live non viene spacciata
per certificata: manca un confronto reale prima/dopo su PostgreSQL.

## 2. Fonti aggiunte e loro significato

- `PHARAOH_NOTA_GIOVANNI_LIMITE_PILETTE_FONDO_A_7_OTTOBRE_2026 (2).docx`:
  sezioni 2-7/9 definiscono il classificatore PILETTA/FONDO A; la sezione 10 lascia
  aperti i ritorni economici FONDO A.
- `PHARAOH_ANALISI_DEFINITIVA_PRE_IMPLEMENTAZIONE_GIOVANNI_7_OTTOBRE.pdf`:
  sezioni 3-5 e 14 definiscono l'adattamento v3, i wallet separati e i controlli di
  riserva. Le sezioni 11-12 conservano la descrizione precedente dei rientri HUMAN;
  la sezione 18 segnala approvazioni ancora da formalizzare.

La fonte PDF non impone un nuovo smart contract v4 per Gemelli/Progetti. ABI v3 e
versione 3.0.0 restano invariate; confronto dell'ABI in
`evidence/registry-abi-check.json`. Non e stata attestata la versione on-chain live.

## 3. Codice effettivamente aggiunto o modificato

| Componente | Lavoro eseguito | Limite attuale |
|---|---|---|
| `s0-generated-batch-policy.js` | Lotti generici da 100 USDC, ISIDE/reinvestimento, P <= H cumulativo, eccedenze FONDO A, importi/contatori esatti, nessuna riconversione | Pianificazione pura, non inserisce posizioni; THOT non inferito |
| `treasury-subwallet-policy.js` | Cinque causali v3, wallet distinti, importi esatti 100/500, confronto prove, saldo libero, riserva Gemelli 0/500, minimo Progetti 100 | Non legge saldi reali e non crea riserve atomiche |
| `subwallet-registry-manager.js` | Verifica ERC-20 tramite il verificatore esistente, poi delega la registrazione v3; conserva hash per riconciliazione | Non collegato a worker/chiusure; nessun trasferimento USDC |
| `pharaoh-registry-manager.js` | Nuovo `registerSubwalletMovement`; stessa ABI; riferimento derivato dalla prova ERC-20, controllo configurazione e soglia conferme | Percorso collaudato con provider/contratto/ABI/crypto simulati, non on-chain |
| `ops/v4-data-preservation.js` | V2 read-only su tutte le tabelle utente e schemi, colonne, vincoli, sequenze; valori convertiti a testo in PostgreSQL; confronto con proiezione | Client PostgreSQL simulato, non DB reale; non e un backup |
| Gate, API, bootstrap DB, migration, restore, preflight, Dockerfile | Blocchi prima di operazioni mutanti o avvio di questa release incompleta | Nessun override ambientale; non e stato costruito Docker |
| `scripts/run-forensic-tests.js` | Scoperta di tutti i test; continua dopo errori; distingue FAIL e dipendenze mancanti; report/log per suite | Esegue i test locali, non certifica servizi esterni |
| `.env.example` | Nomi dei wallet pubblici Gemelli/Progetti | Nessuna chiave o indirizzo reale nuovo |

L'adattatore v3 gestisce solo:
`GEMELLI_RESERVE_OUT`, `GEMELLI_FUNDING_IN`, `CONTINUITY_IN`,
`PROJECTS_BOOTSTRAP_OUT`, `THOT_PROJECTS_OUT`.
Le uscite dirette PROGETTI -> terzi non sono registrate falsamente come uscite di
Cassa PHARAOH. Un hash ERC-20 noto non viene usato per effettuare un secondo invio:
l'adattatore non ha un percorso di invio ERC-20.

Il riferimento v3 non cambia semplicemente cambiando etichetta/eventKey o causale
alla stessa prova. La garanzia completa richiede comunque il ledger DB, i worker,
i recovery e il test end-to-end: non si dichiara qui un exactly-once distribuito.

## 4. Test realmente eseguiti in questa continuazione

Ambiente: Node.js v22.16.0, npm 10.9.2.

| Verifica | Esito effettivo |
|---|---|
| `npm test` | 28 suite: 23 PASS, 2 FAIL, 3 BLOCKED_DEPENDENCY; exit code 1 |
| Sintassi JavaScript (`node --check`) | 70/70 PASS |
| Piano/checksum migration | PASS, 25 migration |
| Preflight statico | PASS: controlla la forma dei sorgenti, non autorizza il deploy |
| Release gate | DENIED, exit code 1: comportamento atteso |
| `npm ci --offline` | FAIL ENOTCACHED: dipendenze non installate |
| PostgreSQL reale / migration rehearsal | NON ESEGUITI |
| Docker build / Coolify | NON ESEGUITI |
| ROG/URANUS live / Registry live / pagamenti | NON ESEGUITI |

Le cinque nuove suite passano:
- Classificatore S0: 12 scenari, inclusi gli esempi 60 FONDO A e 30/20; simulazione
  deterministica di 1.000 lotti. Non e un test di materializzazione/concorrenza DB.
- Policy/adattatore sub-wallet: 27 scenari puri/mock.
- Wiring del manager Registry: 11 scenari sul codice del manager, con provider,
  contratto, decodifica ABI e funzione hash MOCKED. Non e una prova Ethereum.
- Preservazione V2: 17 scenari con client simulato/puri.
- Protezioni e sorgenti: 14 scenari, 114 percorsi conservati, 27 file immutati e
  21 suite storiche non riscritte.

I due FAIL sono `test-thot-humanitarian-reentry.js` e
`test-iside-reentry-receiver-gift.js`: incontrano i blocchi espliciti dei due handler.
Non sono stati nascosti, esclusi o ribattezzati PASS.

Le tre suite bloccate da dipendenze sono `test-blockchain-cross-dynamic.js`,
`test-cross-forensic.js` e `test-pharaoh-registry-v3.js`. L'esecuzione si arresta
nel caricamento delle dipendenze; non certifica il loro comportamento.

Risultati machine-readable: `evidence/current-tests.json`.
Output completi: `evidence/current-tests.log` e `evidence/test-logs/`.

## 5. Come usare solo l'audit in una copia staging isolata

Configurare la connessione DB nell'ambiente, non in un file condiviso in chat.
Prima fermare tutti gli scrittori: il blocco dei nuovi doni non ferma da solo worker
payout, callback o altri processi. Non usare il backend incompleto come servizio.

```sh
node ops/v4-data-preservation.js snapshot /secure/before.json
# Solo dopo una futura migrazione revisionata e autorizzata, non presente qui:
node ops/v4-data-preservation.js snapshot /secure/after.json --projection /secure/before.json
node ops/v4-data-preservation.js compare /secure/before.json /secure/after.json
```

Lo strumento usa una transazione READ ONLY/REPEATABLE READ, fallisce su permessi
insufficienti/RLS filtrante e foreign table, non sovrascrive snapshot e scrive con
permessi 0600. Non esporta wallet in chiaro. Righe duplicate sono conservate con
molteplicita. Le sequenze richiedono una finestra senza scrittori perche il loro
stato non e transazionale come quello delle tabelle.

Non copre il ripristino integrale di ruoli, permessi, funzioni, viste, trigger o
large objects. Non e `pg_dump`, non e un backup e non e una firma crittografica.
I file snapshot devono essere conservati separatamente e protetti da alterazioni.

## 6. Lavoro ancora da completare

Restano la decisione economica FONDO A/THOT, classificazione certa degli HUMAN
esterni, materializzazione S0 atomica, contatori/lock/idempotenza reali, gestione
completa one-step-ahead e Continuita, Cassa Progetti nel flusso, ledger di copertura,
collegamento dell'adattatore ai worker, cutover del DB storico, prove di backup,
rehearsal PostgreSQL, golden test S0 e test end-to-end.

Le domande aggiornate sono in `docs/QUESTIONI_RESIDUE_FONTI_7_OTTOBRE.md`.
Non si reinstalla il database e non si rigiocano donazioni storiche per inizializzare
le nuove casse. Le precedenti istruzioni di deploy nell'albero sono storiche e
non superano il gate di questa consegna.
