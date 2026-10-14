> **NOTA STORICA — SUPERATO.** Questo documento descrive un checkpoint precedente dell'8/9 ottobre 2026. Non rappresenta lo stato della release corrente. La release corrente e documentata in `00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md` e governata da `release-state.json` + `ops/v4-release-gate.js`.

# PHARAOH - conferme e verifica tecnica dell'8 ottobre 2026

**STATO: IMPLEMENTAZIONE PARZIALE, NON DEPLOY.**

Questo ZIP contiene l'intero albero sorgente del checkpoint aggiornato, non una
release completa/certificata. L'avvio, il deploy e le migrazioni restano bloccati.
La baseline di produzione dichiarata resta il backend del 5 ottobre. Nessun accesso
al database di produzione, invio USDC, reset, rigioco di doni o deploy effettuato.

## 1. Fonti effettivamente lette e gerarchia

1. Ultime conferme scritte dell'utente in questa conversazione (8 ottobre).
2. Nuovo `PHARAOH_DOCUMENTO_ PREIMPLEMENTAZIONE.docx`: testo integrale e rendering;
   contiene gli ESATTO della sezione 18 e l'aggiunta vincolante della sezione 19.
3. Nota antisaturazione PILETTE/FONDO A del 7 ottobre, integrata dalle conferme.
4. PDF pre-implementazione del 7 ottobre: restano superate le radici di rientro
   intestate al ricevente e le proposte che l'utente ha ormai approvato.
5. Sorgente Registry v3 nel pacchetto smart contract del 4 settembre: fonte di codice,
   NON prova di identita o configurazione del contratto effettivamente distribuito.

Gli originali dei tre documenti sono conservati in `docs/source-decisions/`.
Le loro diciture storiche non prevalgono sulle conferme piu recenti.

## 2. Decisioni chiuse (non richiedere nuovamente conferma)

- Non resta alcun rientro automatico dedicato al ricevente. Il ricevente puo
  effettuare successivamente una nuova donazione di propria iniziativa.
- THOT: la quota da 500 USDC genera 5 posizioni S0; ISIDE: la quota da 5.000 genera
  50 posizioni S0. In entrambi i casi si applica P <= H cumulativo: PILETTE fino al
  margine residuo, eccedenze immediatamente FONDO A, nessuna riconversione futura.
- FONDO A riceve i normali netti delle proprie posizioni. Non riceve l'intero
  ammontare della tavola: quote di sistema, funzioni e cross restano distinte.
  PRIMARIO RHA = 6.000; GEMELLO/PERPETUO RHA = 1.000; THOT = 4.000; ISIDE = 25.000.
  Il primario non prosegue esso stesso a THOT/ISIDE; proseguono i secondari.
- Le nuove radici eccedenti intestate ad A sono PRIMARIO con classe FONDO_A, non
  nuove copie del fondatore storico di tipo FONDO. Non possono rifare il bootstrap.
- Gli ingressi HUMAN da ROG e URANUS contano in H allo stesso modo degli altri
  ingressi HUMAN realmente materializzati. Non si conta il numero di wallet o la
  sola registrazione. PILETTE, FONDO A e CASSA PROGETTI non aumentano H.
- Le approvazioni ESATTO confermano Secondario RHA 1.000, CONTINUITA 500 senza
  genealogia per PERPETUO, riserva Gemelli anticipata, capitale Progetti 100
  protetto, 500 THOT ai Progetti, e cross RHA 300 ROG/200 URANUS.
- Il netto delle PILETTE resta reinvestito secondo la nota; e separato dalle quote
  di sistema THOT/ISIDE per evitare un doppio conteggio.

## 3. Wallet pubblici

Configurazioni di esempio aggiornate, senza chiavi e senza attivare trasferimenti:

```
PHARAOH_GEMELLI_WALLET=0x8BA36E9cE031dF5e0d7AB94440DF3161A2f84CdE
PHARAOH_PROJECTS_WALLET=0x7Efb00d35Db624aDe83781B3eF0b67A74e49275c
```

Entrambi gli indirizzi forniti superano la verifica checksum EIP-55 effettuata
localmente con Keccak-256 (`@noble/hashes` presente nell'archivio smart contract,
solo per diagnostica, NON usato per simulare un'installazione delle dipendenze).
Questo non prova proprieta delle chiavi, rete operativa, saldo o finanziamento.

Nei sorgenti backend/Registry esaminati non e stata identificata una configurazione
pubblica di produzione verificabile per FONDO A, CASSA PHARAOH e Registry. Gli
`.env.example` contengono segnaposto. Il JSON di deploy Hardhat contiene indirizzi
locali. L'indirizzo 0x0723... nella checklist e ROG_DAO_ADDRESS, NON Cassa PHARAOH.
Non sostituire gli indirizzi in produzione con questi esempi.

## 4. Massimale: cosa dice realmente il sorgente

In `PharaohRegistry.sol` v3 fornito:

```
MAX_SINGLE_AMOUNT = 500000 * 10**6;
MAX_VOLUME_PER_HOUR = 1000000 * 10**6;
```

Il primo limita il singolo importo REGISTRATO; il secondo il volume orario
REGISTRATO. Non sono tetti al saldo della tesoreria. Il contratto non trasferisce
ne custodisce USDC. Il limite per singolo importo e una costante, senza setter.
Il valore 50.000 esiste gia in un helper del checkpoint, ma non dimostra che quel
limite sia attivo nel contratto distribuito o in tutti i percorsi di pagamento.

Da chiudere: conferma che 50.000 debba essere il tetto del singolo movimento da
inviare/registrare, e scelta della transizione del Registry. Il controllo backend
prima dell'invio e necessario ma non riscrive una costante del contratto esistente.
Nessuna variazione Solidity o distribuzione e stata effettuata in questo turno.

## 5. Requisito nuovo: registro ufficiale uscite PROGETTI -> beneficiari

La sezione 19 del nuovo DOCX richiede esplicitamente anche queste registrazioni.
Non basta l'adattatore v3 che copre solo movimenti da/per Cassa PHARAOH.

La sezione 18 approva il mantenimento del v3 per quei movimenti; la sezione 19
aggiunge un ambito ulteriore. Sono compatibili conservando il v3 come storico e
aggiungendo una soluzione di registrazione appropriata, ma NON presentando
falsamente PROGETTI -> beneficiario come uscita CASSA PHARAOH.

Occorre scegliere/approvare l'architettura: nuovo Registry multi-tesoreria oppure
registro Progetti aggiuntivo. Un registro Progetti separato non abbassa da solo la
costante 500.000 del vecchio v3. La scelta deve trattare entrambi i requisiti.

## 6. Modifiche di codice di questo turno

| File | Modifica reale | Ambito/limite |
|---|---|---|
| s0-generated-batch-policy.js | THOT ora ammesso per conferma esplicita | Classificatore puro, non inserimento DB |
| s0-system-position-policy.js | Adattatore storico delega allo stesso classificatore esatto | Nessun doppio algoritmo divergente |
| s0-confirmed-economics.js | Conteggio HUMAN cross, identita radici A, destinazione netti, zero rientri ricevente, lotti di sistema distinti | Regole pure, non agganciate a payout/worker |
| .env.example | Indirizzi pubblici Gemelli/Progetti forniti dall'utente | Nessun finanziamento o attivazione |
| ops/dependency-preflight.js | Confronto metadati di tutti i pacchetti installati con il lockfile | Non esegue librerie, non certifica integrita tarball |
| ops/public-runtime-inspection.js | Solo variabili pubbliche; opzionale lettura contratto/saldi a blocco fissato | Non legge chiavi, non scrive DB, non invia transazioni |
| ops/v4-release-gate.js | Rimuove decisioni ormai risolte dai blocker e registra gli effettivi lavori residui | Blocco assoluto conservato |
| Test/documentazione/stato release | Test sulle nuove regole, log e handoff aggiornati | Non nasconde i FAIL storici |

Il receiver ROG -> PHARAOH e ancora vietato nel codice legacy (`cross-entry-manager`).
La regola di conteggio dei relativi ingressi non equivale ad averne implementato
l'ammissione. Non e stato aperto un bridge senza verifica del protocollo sorgente.

## 7. Dipendenze: risposta esatta e tentativo effettuato

I tre blocchi del rapporto precedente erano:

| Suite | Primo modulo mancante nel log |
|---|---|
| test-blockchain-cross-dynamic.js | ethers |
| test-cross-forensic.js | dotenv |
| test-pharaoh-registry-v3.js | ethers |

Il primo modulo mancante non e l'elenco completo: il controllo attuale trova
**111 pacchetti del lockfile non installati**, incluse le otto dipendenze dirette:

| Dipendenza | Versione fissata nel lockfile |
|---|---|
| cors | 2.8.6 |
| dotenv | 16.6.1 |
| ethers | 6.17.0 |
| express | 5.2.1 |
| express-rate-limit | 8.5.2 |
| helmet | 8.2.0 |
| multer | 2.2.0 |
| pg | 8.20.0 |

`npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=12000`
e stato effettivamente tentato nella copia isolata. Esito: exit 1, errori DNS
`EAI_AGAIN` verso registry.npmjs.org e messaggio npm `Exit handler never called!`.
Log completo allegato. Non e stato usato ethers 6.16 del vecchio archivio al posto
6.17, ne cambiato il lockfile per far passare i test.

Non manca un dato economico dell'utente: occorre un ambiente con accesso npm per
installare le versioni bloccate. L'installazione non risolvera da sola i due FAIL
THOT/ISIDE, che riguardano handler ancora deliberatamente bloccati.

## 8. Test effettivamente eseguiti

| Verifica | Esito |
|---|---|
| npm test, tutti i test scoperti dal runner | 31 suite: 26 PASS, 2 FAIL, 3 BLOCKED_DEPENDENCY; exit 1 |
| Sintassi JavaScript | 76/76 PASS |
| Piano/checksum migration | PASS: 25 migration |
| Preflight statico | PASS; nessun DB contattato |
| Release gate | DENIED, exit 1 come previsto |
| Check dipendenze vs lockfile | FAIL: 111 pacchetti mancanti |
| Installazione npm ci | FAIL, dettagli sopra |
| DB reale, migrazione/cutover, chain live, receiver cross, Docker/Coolify | NON ESEGUITI |

Nuove suite: 23 scenari di regole confermate; 6 scenari filesystem della diagnostica
pacchetti; 9 scenari puri/mock della diagnostica pubblica. Il classificatore aggiornato
ha 13 scenari, inclusi THOT e simulazione deterministica di 1.000 lotti.

I due FAIL rimangono esattamente THOT e ISIDE: `PHARAOH_*_S0_MATERIALIZATION_NOT_YET_CERTIFIED`.
I 21 test storici della baseline non sono stati riscritti. Il test nuovo che negava
THOT e stato aggiornato perche quella limitazione e superata dalla conferma scritta,
non per nascondere un errore dell'implementazione.

Tutte le 25 migration, il loro piano e package-lock.json sono byte-identici alla
baseline dichiarata. Tutti i 114 percorsi baseline sono conservati. La conservazione
deI DATI live non e stata certificata: non esiste in questa sessione un confronto
reale prima/dopo sul database di produzione.

## 9. Cosa serve ancora, senza riaprire le decisioni gia chiuse

Decisioni operative: ambito preciso del massimale 50.000; architettura Registry per
il nuovo requisito; autorizzazione/provenienza della provvista iniziale delle casse.
Per il sistema esistente non si riproducono i primi sei doni storici. Il bootstrap
puo avvenire una sola volta, dopo riconciliazione, con nuova provvista o saldo
fisicamente disponibile e non impegnato: questa origine non va inventata.

Dati/evidenze operative: indirizzi pubblici live, commit distribuito, stato migration,
backup con ripristino verificato e copia di collaudo isolata; sorgenti/protocolli
attuali dei receiver ROG/URANUS per il test completo. La sola patch URANUS allegata
non e il backend URANUS integrale di produzione.

Lavoro di codice ancora effettivamente mancante: materializzazione S0 atomica con
contatori e idempotenza, collocamento della Cassa Progetti, riserve settled e ledger,
Gemelli one-step-ahead/CONTINUITA, destinazione netti nei worker, registrazione
Progetti diretta, eventuale receiver ROG e passaggio verificato dallo stato esistente.
Non e corretto presentare questi lavori come gia terminati solo perche la policy
pura e approvata e i suoi test passano.

## 10. Uso sicuro della diagnostica

`ops/public-runtime-inspection.js` e standalone: si puo copiare solo questo script
nella cartella `/app` del backend ATTUALE, senza sostituire il backend con lo ZIP.

```
node public-runtime-inspection.js
# Facoltativo, richiede ethers gia installato e POLYGON_RPC_URL nell'ambiente:
node public-runtime-inspection.js --chain
```

Il secondo comando esegue solo chiamate di lettura. Non legge chiavi private.
Gli errori non ripetono URL RPC eventualmente contenenti credenziali. I saldi
riportati NON sono il saldo libero da riserve. I test di questa utility sono mock:
nessuna esecuzione --chain su una rete reale e avvenuta qui.

Per un semplice primo riscontro non serve copiare file: dalla console del backend
attuale si possono stampare soltanto le tre variabili pubbliche gia note.
Non inviare `.env`, seed, chiavi private, token, password o segreti HMAC.

## 11. Download e continuita

Non occorre scaricare e ricaricare gli allegati per continuare questa conversazione.
Per backup/handoff basta conservare lo ZIP corrente con rapporto, decisioni, log e
fonti originali. I vecchi checkpoint restano storico, non istruzioni per il deploy.
Il backend attuale del 5 ottobre e il suo database non vanno sostituiti da questo
pacchetto. Questo sorgente NON DEPLOY non e una copia/backup del database.
