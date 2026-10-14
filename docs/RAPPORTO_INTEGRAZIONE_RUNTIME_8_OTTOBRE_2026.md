> **NOTA STORICA — SUPERATO.** Questo documento descrive un checkpoint precedente dell'8/9 ottobre 2026. Non rappresenta lo stato della release corrente. La release corrente e documentata in `00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md` e governata da `release-state.json` + `ops/v4-release-gate.js`.

# PHARAOH - rapporto forense dell'integrazione runtime
**Data: 8 ottobre 2026. Stato: NON DEPLOYABILE. Solo backend.**

## 1. Risultato e confine della consegna
Sono stati scritti e collegati nuovi servizi operativi di contabilita, creazione
S0, distribuzione dei netti, riserva dei pagamenti e riconciliazione. Non si tratta
della rinomina del checkpoint precedente. La release, tuttavia, non e' completa:
la transizione del database preesistente alle nuove riserve non e' implementata
integralmente e non e' stata provata su PostgreSQL. Non sono stati eseguiti deploy,
trasferimenti, migrazioni di produzione o verifiche del commit realmente attivo.

L'intero albero corrente e' nella directory BACKEND del pacchetto. Il documento
corrente prevale sui rapporti storici presenti al suo interno. Lo smart contract
rimane nella fase successiva: nessuna modifica Solidity, ABI o indirizzo Registry.
La richiesta di un massimale da 50.000 e del registro delle uscite dirette Progetti
non e' stata trasformata in un requisito da risolvere prima di questi lavori backend.

## 2. Provenienza verificata
L'handoff precedente e' stato estratto e il relativo verificatore ha restituito
PASS per 920 file. Il punto di partenza del codice e' il checkpoint
`PHARAOH_BACKEND_CONFERME_8_OTTOBRE_NON_DEPLOY.zip`, SHA-256
`e3cfcd33a36a4021013a5569136d535e5665beaad062df0dddc07323d9aeb242`.
La baseline dichiarata del 5 ottobre e' conservata nel precedente handoff con 114
corrispondenze di checksum: non e' una verifica del repository oggi in produzione.

Tutti i 114 percorsi della baseline sono presenti. I 25 file SQL originali e il
lockfile delle dipendenze sono byte per byte invariati; i primi 25 record del piano
migrazioni sono invariati. Anche l'intero `pharaoh-registry-manager.js`, che contiene
l'ABI in uso, coincide con il checkpoint. Le differenze correnti e gli hash per file
sono in `evidence/implementation-pass/changes-from-input.json` e nel patch associato.

## 3. Regole recepite, senza nuove conferme
Le conferme dell'utente prevalgono sui testi precedenti: niente rientri automatici
intestati al ricevente; THOT 500 genera 5 posizioni, ISIDE 5.000 ne genera 50, e i
netti delle PILETTE generano nuove posizioni da 100. Il limite e' cumulativo P <= H;
l'eccedenza diventa subito FONDO A, non aumenta H e non viene riconvertita.

H cresce soltanto dopo la materializzazione delle HUMAN, anche per origini ROG e
URANUS. L'approvazione del conteggio non autorizza un receiver ROG non verificato:
il receiver legacy ROG resta disabilitato. Il FONDO A riceve i netti come proprietario
ordinario. Il PRIMARIO/FONDO termina a RHA con 6.000; i Secondari ricevono 1.000 RHA,
4.000 THOT e 25.000 ISIDE, secondo maturazione. Una PILETTA reinveste il proprio
netto invece di generare un pagamento al wallet tecnico di custodia.

RHA mantiene 300 ROG / 200 URANUS. Cassa Gemelli usa la precedente provvista 500
per il turno corrente e riceve nuovi 500 per il successore; PERPETUO genera
CONTINUITA_RHA non genealogica anziche' Gemello. Cassa Progetti ha un solo capitale
strutturale 100 protetto e riceve la quota THOT 500. I numeri 26+14n non sono caselle
paganti S0. La CASSA e' una posizione completa con identita', numero e sdoppiamento,
non un ripristino del vecchio ROLLOVER senza account. La prova locale ha mantenuto
il suo avanzamento nella sequenza globale senza contarlo in H/P.

I wallet pubblici delle due nuove casse restano quelli forniti dall'utente:
- Gemelli: `0x8BA36E9cE031dF5e0d7AB94440DF3161A2f84CdE`.
- Progetti: `0x7Efb00d35Db624aDe83781B3eF0b67A74e49275c`.

Non sono stati inventati i valori di produzione per FONDO A, Cassa PHARAOH o Registry.
Il template `.env.example` non va sovrascritto alla configurazione in uso.

## 4. Implementazione effettiva, file e limiti
### Ledger e schema
`economic-amounts.js`, `economic-store.js`, `economic-ledger.js` gestiscono importi
atomici interi, eventi con fingerprint immutabile, fondi riservati per wallet,
allocazioni bilanciate, prove ERC20 non riutilizzabili e movimenti associati a una
riserva esatta. Un saldo numerico dichiarato dal chiamante non crea fondi.

`0026_economic_ledger_s0.sql` aggiunge tabelle dedicate. L'attivazione iniziale e'
PENDING e i contatori sono non inizializzati: non esiste un backfill silenzioso.
`0027_continuity_non_genealogical.sql` estende i vincoli per una CONTINUITA senza
identita', con slot/importo vincolati; le posizioni non CONTINUITA restano obbligate
ad avere wallet. Nessuna delle due SQL aggiorna, elimina o ricrea righe storiche.
Questa proprieta' del sorgente non equivale a una migrazione verificata su dati reali.

### Materializzazione e ingressi
`s0-materializer.js` crea radici PRIMARIE distinte, identita' economica separata dal
tipo genealogico, posizione/numerazione/tavola personale, finanziamento della tavola,
H/P e lavoro post-commit nella medesima transazione del chiamante. La classificazione
PILETTA/FONDO A viene calcolata sotto il lock economico. Classi e fonte sono propagate
ai Secondari in `account-manager.js`.

`donation-flow-manager.js`, `cross-entry-manager.js`, `verified-entry-manager.js` e
`reentry-manager.js` usano questi servizi: il DIRECT non riutilizza un account gia'
numerato; gli ingressi multipli URANUS hanno radici distinte; THOT/ISIDE non creano
piu' HUMAN del ricevente. I vecchi percorsi amministrativi non finanziati falliscono
prima di scrivere dati. Le funzioni pure precedenti sono usate dal runtime, non sono
piu' l'unico contenuto dell'implementazione.

Scelta tecnica esplicita: la PILETTA ha owner economico NULL e usa la Cassa PHARAOH
come indirizzo tecnico di custodia nella struttura legacy. Non e' un nuovo wallet,
non determina un pagamento esterno del netto e non aggiunge H. Questa scelta richiede
la verifica integrata delle viste utente e delle allocazioni cross prima della release.

### Chiusure e casse
`economic-flow.js` alloca gli importi reali RHA/THOT/ISIDE, lega i contributi dei
Sacerdoti/Funzioni al turno, prepara il ciclo Gemelli ritorno-prima-del-rifornimento,
protegge il capitale Progetti e collega quote generate e reinvestimenti. Il bootstrap
da vuoto e' distinto dal passaggio di un database preesistente. Il secondo non puo'
rigiocare i primi sei doni. `continuity-manager.js` riserva/materializza 500 senza
account, wallet, sigla, numero o sdoppiamento. I controlli impediscono di collocarla
in un turno diverso o in uno slot occupato da un'altra identita'.

Il pagamento dei doni al proprietario rimane il flusso di accettazione del backend:
la maturazione crea un dono pendente coperto, non un trasferimento arbitrario anticipato.

### Movimenti, pagamenti e recupero
`treasury-transfer-manager.js` conserva raw transaction firmata, hash e nonce prima
del broadcast; il tentativo e' registrato prima della chiamata di rete. Un esito
incerto non genera una nuova transazione automatica. Il gestore ricontrolla nonce,
payload, saldo settled e riserve; il sender e le policy dei wallet devono coincidere.
Una firma che non e' mai arrivata alla rete puo' richiedere riconciliazione manuale:
questa implementazione privilegia evitare doppi invii rispetto al reinvio cieco.

`treasury-chain-adapter.js` verifica rete, token, logs ERC20, importo, conferme,
block hash e, per un pagamento manuale, data successiva alla preparazione della
riserva. La prova usa il mittente ERC20 reale, non presume che un multisig coincida
con il mittente esterno della transazione. La registrazione di uscite dirette Progetti
resta bloccata perche' appartiene alla fase contrattuale rinviata.

`payout-economic-adapter.js`, `payout-manager.js` e `cross-outbound-manager.js` legano
le operazioni alle riserve e non marcano SENT un trasferimento simulato/pending.
La riconciliazione cross non accetta piu' un hash pubblico senza verifica del movimento.
`economic-worker.js` coordina movimenti interni, annotazione Registry v3, pagamenti
accettati e FIFO post-commit. Gli endpoint in `economic-admin.js` espongono stato e
riconciliazione autenticata, non un interruttore di attivazione o un'importazione chiavi.

`gift-session-manager.js` riserva i 100 PHARAOH quando la Carta Regalo viene verificata,
prima dell'attivazione del beneficiario. L'attivazione riusa lo stesso evento di credito;
non crea nuovamente il saldo. Un pagamento anticipato in attesa di redeem non e' denaro
libero da impiegare per altre operazioni.

### Strumenti conservativi
`ops/economic-cutover-inventory.js` produce un inventario limitato e di sola lettura,
con hash e campi selezionati; non legge raw transaction/chiavi e non crea riserve.
`ops/economic-schema-review.js` distingue conservazione delle righe e modifiche dei
vincoli, senza indebolire il comparatore V2 originario. Il vincolo nullable richiesto
da CONTINUITA viene evidenziato come modifica DDL da approvare, non ignorato.
`scripts/rehearse-postgres-economy.js` prepara una prova su database vuoto esplicitamente
disposable, diverso da DATABASE_URL, con rollback completo. Il nome del database e
l'acknowledgement sono controllati prima di importare il driver. La prova reale NON
e' stata eseguita qui; sono passati soltanto i test delle sue protezioni.

## 5. Prove effettivamente eseguite
Ambiente: Node 22.16.0, npm 10.9.2. Log correnti:
`evidence/implementation-pass/final-run/`.

| Verifica | Risultato reale | Perimetro |
|---|---|---|
| npm test | 42 suite: 39 PASS, 0 FAIL, 3 BLOCKED_DEPENDENCY; exit 1 | Sorgente, unita', repository/RPC simulati |
| node --check | 102/102 PASS | Parser JavaScript, non risoluzione dipendenze |
| db:plan | 27 step, checksum verificati | Lettura file, nessuna esecuzione SQL |
| deploy:preflight static | PASS | Presenza/configurazione dei sorgenti |
| release:gate | Exit 1, deploy negato | Protezione intenzionale |
| SQL originarie + lockfile | 26 file byte-identici | Confronto hash con baseline dichiarata |
| Numerazione S0 | 70 tavole, ultimo numero 451 | table-manager reale, database in memoria |
| Comparazione/adattatori nuovi | PASS nei test dedicati | Nessun PG/RPC reale |
| npm ci | Timeout 25 secondi, exit 124 | Installazione NON completata |

I tre test bloccati sono `test-blockchain-cross-dynamic.js` (ethers),
`test-cross-forensic.js` (dotenv), `test-pharaoh-registry-v3.js` (ethers).
L'ispezione del lockfile trova 111 pacchetti mancanti, incluse tutte le otto dipendenze
dirette. Non sono stati installati sostituti di versione diversa da altri ZIP.

Le suite nuove esercitano il ledger reale su repository in memoria (15 casi), la
materializzazione finanziata (15), il dispatcher (21), il worker (10), i flussi economici
(19), le Carte Regalo prepagate (7), CONTINUITA (12), il controllo prove di trasferimento
(16) e la comparazione conservativa di snapshot (10). Il test delle radici autonome
riallineato esercita 13 casi. Sono conteggi di scenari nelle rispettive suite, non
certificazioni indipendenti del sistema completo. La prova dei logs ERC20 usa un parser
simulato: non verifica crittografia, firma o decodifica ABI della libreria mancante.

I primi cicli falliti NON sono stati cancellati: `first-run`, `second-run` e `third-run`
mostrano l'evoluzione. Il primo ha 21 PASS/8 FAIL/4 dipendenze; il secondo 33 PASS/1 FAIL/
3 dipendenze; il terzo 36 PASS/0 FAIL/3 dipendenze. Il ReferenceError sull'export legacy
`submitTransfer` e' stato rimosso. I test THOT/ISIDE ora raggiungono i nuovi percorsi.
Le aspettative obsolete sui rientri HUMAN sono state sostituite secondo le decisioni
confermate; le 21 suite originarie sono archiviate byte-identiche in
`evidence/legacy-tests-5oct`. Le modifiche alle fixture non vengono presentate come una
prova PostgreSQL o come la semplice esecuzione immutata dei test storici.

## 6. Cosa NON e' stato verificato
Nessun server PostgreSQL e nessuna immagine Docker sono stati usati. Nessuna applicazione
HTTP completa e' stata avviata con tutte le dipendenze. Nessun dato reale e' stato letto,
modificato o migrato. Nessuna riserva bancaria/on-chain o saldo disponibile di produzione
e' stato verificato. Nessun test ROG/URANUS receiver completo, pagamento Polygon,
reorg reale, migrazione di clone o ripristino backup e' stato eseguito. La serializzazione
in memoria non dimostra il comportamento dei lock in PostgreSQL.

## 7. Lavori backend ancora indispensabili
1. **Adozione dello stato esistente.** Costruire e testare il manifest di transizione:
classificazione degli account e delle posizioni storiche, H/P iniziali dimostrabili,
blocco di riferimento, riserve di apertura per doni pendenti/gift/cross/progressioni,
protezione delle prove gia' consumate e legami idempotenti con le operazioni precedenti.
L'inventario read-only non realizza questo passaggio e il runtime resta PENDING.
2. **CASSA e operazioni legacy.** Non cambiare i proprietari storici per adattarli al nuovo
wallet Progetti. La destinazione tecnica dei netti delle CASSA gia' esistenti e i record
pendenti prima del passaggio devono essere riconciliati esplicitamente. I blocchi
`LEGACY_CASSA_ECONOMIC_DESTINATION_REQUIRES_CUTOVER_REVIEW` e
`LEGACY_POST_COMMIT_CUTOVER_REVIEW_REQUIRED` sono ancora reali.
3. **Primo lotto multiplo da sistema vuoto.** Il caso che attraversa la prima tavola
prima del settlement 500/100 e' fermato con rollback atomico, non gestito da una coda
persistente completa. Va completata questa coda/risposta di attesa senza anticipare
capitale Progetti inesistente o perdere un ingresso gia' pagato.
4. **Certificazione integrata.** Installare il lockfile, provare le migrazioni e la
conservazione su un clone, concorrenza/crash reali, numerazione e cicli completi con
PERPETUO, DIRECT/GIFT e receiver ROG/URANUS. Verificare backup e ripristino prima di
un piano operativo di attivazione separato.

Questi sono lavori e prove ancora mancanti, non un elenco di regole economiche da
riconfermare. Il nuovo bootstrap 500/100 dalla tesoreria esistente non e' autorizzato
implicitamente e non deve rigiocare trasferimenti del passato. Non rimuovere il gate
per aggirare i problemi elencati.

## 8. Riproduzione e passaggio all'agente successivo
Nel backend: `npm ci --ignore-scripts --no-audit --no-fund`, poi `npm test`,
`npm run db:plan`, `npm run deploy:preflight`. Questi ultimi sono controlli locali;
`npm test` deve restituire zero soltanto quando tutte le suite passano realmente.
Per PostgreSQL usare soltanto lo script `test:postgres:isolated` con un database vuoto
separato e le variabili documentate nel suo header. Non puntarlo al database operativo.

L'handoff aggiornato conserva le decisioni precedenti e indica i blocchi realmente
aperti. I manifest chiamati SHA256_MANIFEST o FULL_SOURCE_SHA256_MANIFEST gia' presenti
nell'albero sono storici: il manifest corrente e' quello alla radice del nuovo pacchetto.
Il verificatore di integrita' non e' una certificazione funzionale. Conservare il nuovo
ZIP e non sostituire con esso il deploy del 5 ottobre.
