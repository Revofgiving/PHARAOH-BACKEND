> **NOTA STORICA — SUPERATO.** Questo documento descrive un checkpoint precedente dell'8/9 ottobre 2026. Non rappresenta lo stato della release corrente. La release corrente e documentata in `00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md` e governata da `release-state.json` + `ops/v4-release-gate.js`.

# PHARAOH - Rapporto forense backend, PostgreSQL e cross - 9 ottobre 2026

**Stato: NON DEPLOY.** Il database di produzione resta lo stesso PostgreSQL su Coolify.
Questo rapporto documenta codice realmente modificato e comandi realmente eseguiti.
Non dichiara conclusi la transizione contabile del database esistente, il collaudo
PostgreSQL nativo o il collaudo dei receiver reali.

## 1. Provenienza e vincoli

Input verificato: `PHARAOH_BACKEND_INTEGRAZIONE_RUNTIME_8_OTTOBRE_2026_NON_DEPLOY.zip`.
SHA-256: `2b768c784a7efe8630598e666661e66aa792be06a68e2429c913a6d5b6476640`.
552 voci ZIP; controllo CRC passato. L'archivio originale viene conservato nella
consegna. La baseline dichiarata del 5 ottobre non viene sostituita da quella del
2 ottobre. I 114 percorsi baseline sono ancora presenti; i 21 test originari restano
archiviati byte-identici. Questo non identifica il commit effettivamente distribuito.

La nuova dichiarazione operativa dell'utente è: 13 persone reali e nessuna Carta
Regalo pendente. È una dichiarazione, non il risultato di una query eseguita qui.
Non equivale a 13 account, 13 wallet distinti o 13 posizioni. H conta le radici HUMAN
esterne effettivamente materializzate. Nessun contatore è stato inizializzato a 13.

Decisioni economiche confermate in precedenza invariate. Prima backend, dopo smart
contract. Nessuna modifica ad ABI, Solidity, indirizzi on-chain o contratti distribuiti.
Nessuna connessione alla produzione, nessuna migrazione applicata, nessun trasferimento
reale. Non inviare chiavi, seed, password o `.env` in chat.

## 2. PHARAOH verso ROG: collegamento verificato

La lista precedente DIRECT/GIFT/URANUS descriveva gli ingressi in PHARAOH, non le uscite.
L'uscita RHA chiama `economicFlow.planExit` e `crossOutbound.scheduleRhaExit` in
`donation-flow-manager.js`. La pianificazione crea le due operazioni, ognuna legata alla
propria riserva: ROG 300 USDC / 150 dual; URANUS 200 USDC / 10 dual.

Il percorso mittente ROG mantiene pagamento, registrazione PHARAOH, registrazione ROG,
notifica HMAC e controlli specifici su beneficiario, titolarità RGx e donationId.
Il receiver deve produrre 150 HUMAN al beneficiario e 150 PILETTE tecniche ROG; i 150
RGx appartengono alla Cassa PHARAOH, non al beneficiario. La PILETTA ROG non è una
PILETTA S0 PHARAOH e la sua creazione non aumenta H/P PHARAOH.

`test-cross-runtime-loopback.js` esercita i gestori PHARAOH reali con HTTP locale reale
e HMAC, ma SQL in memoria, ABI/chain sintetici e receiver MODELLO. Tre uscite RHA
producono nel modello 450 HUMAN ROG, 450 PILETTE ROG, 450 RGx e 30+30 componenti URANUS.
Sono registrate 6 firme e 6 broadcast SIMULATI, non transazioni reali; 9 richieste HTTP
comprendono i retry. La perdita di risposta dopo il commit simulato del peer ripete
la notifica, non il pagamento. Il receiver effettivo non è stato avviato.

Il vecchio endpoint automatico ROG verso PHARAOH resta disabilitato. La regola che una
vera entrata HUMAN da ROG conti in H non autorizza ad aprire un endpoint incompleto.

## 3. Correzioni reali del codice

### 3.1 Origine URANUS non coerente tra i servizi

Il receiver produceva `URANUS_TO_PHARAOH`, mentre `EconomicFlow.holdExternalPayment`
accettava `URANUS`: l'evento canonico era rifiutato con `EXTERNAL_ORIGIN_INVALID`.
La variante corta, a sua volta, non era ammessa dal controllo HUMAN del materializzatore.
La precedente prova a componenti separati non aveva dimostrato questo collegamento.

Ora `normalizeHumanOrigin` normalizza i nomi prima di creare la fingerprint economica
in `economic-flow.js` e `s0-materializer.js`. Nome canonico e alias dello stesso evento
sono idempotenti. Il test dedicato verifica radici distinte, credito consumato una volta,
H incrementato una volta e rifiuto di THOT/ISIDE/rientri interni come HUMAN esterne.
I log RED/verde sono `external-origin-before.log` e `external-origin-after.log`.
Non è stato abilitato l'ingresso automatico ROG.

### 3.2 Risposta remota non equivale a completamento

Il ramo URANUS accettava anche `{success:true}`, senza prova di stato concluso.
`cross-notification-policy.js` ora richiede `COMPLETED` per entrambi i peer. Stati di
lavorazione restano in attesa; risposte mancanti o contraddittorie portano alla
riconciliazione. Gli eventuali campi di eco importo/evento/tx/numero/beneficiario devono
coincidere. Non sono stati inventati campi obbligatori sconosciuti dei receiver.

Il contratto di risposta reale URANUS deve quindi essere verificato prima del deploy:
se non restituisce COMPLETED, il nuovo mittente si ferma deliberatamente. Questo
controllo non dimostra da solo che il peer abbia creato le righe corrette.

Sono gestiti timeout limitati, rifiuto redirect e errori di rete ritentabili. Un errore
di trasporto conserva hash e riserva già regolati; una risposta economicamente errata
non viene trasformata in semplice retry. I controlli ROG esistenti restano attivi.

Il test `test-rha-dual-allocation-dynamic.js` ha ricevuto una sola modifica di fixture:
URANUS risponde anche `status: COMPLETED`. Non sono stati riscritti i test storici
archiviati, né mascherate le tre dipendenze mancanti.

### 3.3 Protezione della transazione delle migrazioni

I file storici 0016, 0017 e 0018 contengono BEGIN/COMMIT propri. Il runner precedente li
inviava dentro una transazione complessiva. Un BEGIN dentro una transazione PostgreSQL
non crea una transazione annidata; il COMMIT termina quella corrente. Quindi un errore
successivo non avrebbe potuto annullare tutto come dichiarato dal runner.

`ops/migration-transaction-policy.js` mantiene una allowlist dei tre SHA-256 esatti e
rimuove SOLTANTO l'involucro esterno dalla proiezione eseguibile. `loadPlan()` conserva
`sql`, checksum e manifest originali e aggiunge `executionSql`; runner e rehearsal
eseguono quest'ultima. Nuovi comandi di controllo transazione non revisionati vengono
rifiutati. Commenti, stringhe e blocchi dollar-quoted sono distinti dai comandi esterni.
Non è un parser SQL generale: la sintassi resta da collaudare su PostgreSQL.

Gli 83 controlli del test dedicato passano, comprese tutte le 27 proiezioni e il
rollback modellato di un errore alla 0026. Non sono una prova di atomicità nativa.
Il primo tentativo dopo la modifica falliva nella fixture VM per `URL` non esposto:
il log è conservato e il test corretto è passato. Nessun file SQL è stato riscritto.

Riferimenti primari consultati il 9 ottobre 2026, per la semantica e non come prova di
esecuzione del progetto:
- PostgreSQL 16, BEGIN: https://www.postgresql.org/docs/16/sql-begin.html
- PostgreSQL 16, COMMIT: https://www.postgresql.org/docs/16/sql-commit.html
- npm CLI v10, npm ci: https://docs.npmjs.com/cli/v10/commands/npm-ci/

## 4. Simulazione economica finanziata su dieci turni

`test-funded-multiturn-model.js`: 63 controlli passati. Usa ledger, flusso e
materializzatore effettivi, ma placement delle tavole e scelta dei Faraoni modellati,
con prove ERC-20 sintetiche. Non esegue l'intero `donation-flow-manager` su PostgreSQL.

Si parte da saldo zero, senza inventare un credito RHA da 9.000. Sei ingressi alimentano
500 Gemelli e 100 Progetti; altri 90 ingressi formano i 18 contributi da 500 del primo
RHA. I nove turni successivi usano 65 ingressi ciascuno, con casi PERPETUO e GEMELLO.
Le riserve generate alimentano nove contributi THOT, tre chiusure THOT e una ISIDE.

Bilancio sintetico finale: 68.100 USDC entrati = 57.000 usciti + 11.100 ancora riservati.
I 57.000 comprendono 52.000 netti, 3.000 ROG e 2.000 URANUS. Si osservano 681 radici
HUMAN e 65 PILETTE dalle quote THOT/ISIDE, nessuna radice automatica del ricevente.
Gemelli alterna 500/0/500 e termina a 500. Progetti termina a 1.600, inclusi 100 protetti.
Le prove su saturazione e netti reinvestiti restano nelle altre suite dedicate.

Il numero di 13 wallet usato dalla fixture è sintetico. Non è una lettura o una
ricostruzione delle persone reali nel database di produzione.

## 5. Stesso PostgreSQL, nuova contabilità additiva

Le 27 SQL e il piano sono invariati rispetto al checkpoint in ingresso. Le 25
migrazioni storiche restano inalterate; 0026/0027 erano già presenti. In questo turno
non è stata aggiunta alcuna migrazione. I vincoli DDL previsti da 0027 restano da
verificare: conservare le righe non significa fingere che lo schema non cambi.

L'inventario di sola lettura ora include versione PostgreSQL, alcuni stati/legami e
campi di provenienza. Il valutatore offline confronta hash, distingue candidati S0,
wallet, dati personali non inferibili e obbligazioni. Anche una gift cancellata con
pagamento ancora non assegnato richiede verifica. Zero gift non implica zero doni,
progressioni, CASSA o altre riserve.

Il valutatore NON applica adozione, NON imposta H/P, NON attiva il runtime e NON calcola
un saldo libero dal solo balanceOf. Non è un backup. La nuova gestione deve essere
legata allo storico reale nello stesso DB, senza replay dei primi sei doni.

## 6. npm e ambiente: prove effettive

Node v22.16.0 e npm 10.9.2 erano già installati. Tentato `npm ci` online con versioni
bloccate: exit 1, errori EAI_AGAIN e messaggio finale npm "Exit handler never called".
Tentato anche offline: exit 1 ENOTCACHED. La cache contiene solo 19 contenuti che
corrispondono all'integrità delle 111 dipendenze; 92 non sono presenti. Nessun modulo
è stato sostituito con versioni diverse degli archivi di altri progetti.

L'ispezione successiva rileva 111 pacchetti non installati, incluse tutte le otto
dipendenze dirette. Ethers 6.17.0, dotenv 16.6.1 e pg 8.20.0 non sono disponibili qui.
L'errore riguarda questo ambiente di lavorazione, non dimostra un problema del server
Coolify o un guasto globale del registry npm.

## 7. Risultati correnti e limiti

| Verifica eseguita | Esito | Perimetro |
|---|---|---|
| npm test prima delle modifiche | 42: 39 PASS, 3 bloccate; exit 1 | sorgente in ingresso |
| npm test corrente | 50: 47 PASS, 0 FAIL, 3 bloccate; exit 1 | sorgente, mock, HTTP loopback |
| Sintassi JavaScript | 116/116 PASS | parser, non import dipendenze |
| db:plan | 27 PASS; 3 involucri normalizzati | file/checksum, zero SQL eseguito |
| Preflight statico | PASS | non preflight produzione |
| Blocco release | exit 1 atteso | ancora NON DEPLOY |
| Conservazione file immutabili | 31/31 identici | SQL, piano, lock, Registry/ABI |
| Native PostgreSQL conservazione/concorrenza | tentativi bloccati prima della connessione | pg mancante |
| Runner Docker isolato | tentativo bloccato, exit 2 | Docker non disponibile |
| Receiver reali ROG/URANUS, chain, clone produzione | NON ESEGUITI | nessuna certificazione E2E |

I tre test bloccati restano `test-blockchain-cross-dynamic.js` (ethers),
`test-cross-forensic.js` (dotenv), `test-pharaoh-registry-v3.js` (ethers).
Non vengono saltati o riclassificati PASS. Questi 50 sono suite/script, non una misura
della copertura completa del programma. I conteggi interni dei controlli non vanno
sommati alle suite per produrre percentuali più favorevoli.

## 8. Collaudo PostgreSQL predisposto, non spacciato per eseguito

`rehearse-postgres-economy.js` predispone una prova nativa con 13 wallet, posizioni e
donazioni sintetici, zero gift, fingerprint delle vecchie tabelle prima/dopo 0026/27 e
rollback finale. `rehearse-postgres-concurrency.js` predispone nove scenari nativi con
connessioni concorrenti: lock, race, unicita del credito, doppia spesa, P<=H, riserve,
prove riutilizzate e rollback per disconnessione. Il suo schema temporaneo viene
eliminato solo dopo controllo del token di proprietà.

Entrambi richiedono un DB esplicitamente vuoto e disposable. Non usano DATABASE_URL
come fallback. Qui falliscono all'import di pg, prima di una connessione. I test delle
protezioni di accesso passano, ma non provano che il SQL sia stato eseguito.

Il runner host copia solo sorgenti autorizzati, installa con npm ci in un container
separato, avvia PostgreSQL effimero su rete interna senza porte pubbliche ed esegue i
test salvando tutti gli esiti. Non monta volumi, file .env o chiavi di produzione.
Non è stato eseguito integralmente qui. La guida `COLLAUDO_ISOLATO_9_OTTOBRE_2026.md`
contiene il comando e i limiti. Il database di test non sostituisce quello su Coolify.

## 9. Materiale receiver realmente disponibile

L'archivio ROG del 31 agosto ha 123 voci: contiene il bridge URANUS storico, ma non
fornisce la versione corrente certificata del receiver PHARAOH. L'archivio URANUS del
2 settembre contiene solo 6 voci ed è una patch Carta Regalo, non il backend completo.
Il loro inventario è nei log. Nel riferimento precedente sono conservati estratti
tecnici, non una attestazione del codice attualmente distribuito.

Per certificare 300->150+150 e 200->10 dual occorre usare i receiver effettivi con
una fixture isolata, poi confrontare righe create, proprietari, tx/evento, retry e
completamento. Non basta un modello creato da PHARAOH che restituisca i numeri attesi.

## 10. Residuo necessario prima della release

Restano: adozione/versionamento delle riserve e classificazioni storiche nello stesso
DB; collegamento economico delle CASSA preesistenti e operazioni pendenti; coda durevole
per il primo lotto multiplo da DB vuoto che attraversa la prima tavola; verifica reale
PostgreSQL, clone/ripristino, progressione strutturale completa e receiver correnti.

Le informazioni 13 persone / zero gift riducono il caso concreto da riconciliare, ma
non completano queste funzioni automaticamente. Non basta installare le dipendenze
per trasformare il pacchetto in release. Nessun'altra decisione economica viene
riaperta e il lavoro contrattuale resta rinviato.
