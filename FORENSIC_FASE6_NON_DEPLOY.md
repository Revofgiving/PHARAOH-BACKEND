# PHARAOH — FASE 6 FORENSE / NON DEPLOY

Data: 23 novembre 2026. Fonte **esclusiva**: `PHARAOH_BACKEND_FASE5_FORENSE_NON_DEPLOY_23_NOV_2026.zip`.

## Modifiche rispetto alla Fase 5

- Aggiunta `0034_conversion_dual_control_attestations.sql`: tabella PostgreSQL additiva con firme individuali, hash evidenza, nonce, timestamp e audit append-only, senza cancellazione dello storico.
- Aggiunto `gas-cancellation-dual-control.js`: attestazioni Ed25519 di operatori individuati esclusivamente da chiavi pubbliche approvate (`PHARAOH_GAS_ADMIN_PUBLIC_KEYS_JSON`), durata massima firma 5 minuti, firme legate a ID conversione e SHA-256 della documentazione. Due operatori distinti, stesso hash evidenza; replay esatto idempotente, contenuto diverso rifiutato.
- Nuovo endpoint amministrativo (protetto anche dalla chiave amministrativa preesistente): `POST /api/admin/gas-reserve/conversions/:id/cancellation-attestation`. L'endpoint accetta una firma individuale sul testo deterministico prodotto da `statement()` e **non** sblocca fondi.
- Aggiornato il piano migrazioni a 34, manifest checksum, test di compatibilità e stato di rilascio esplicitamente DENY.
- Test specifici per firma valida, identità falsa, evidenza alterata, replay, separazione operatori, stato conversione non ammesso e impossibilità di rilascio.

## Invariante di sicurezza

**La doppia approvazione NON dimostra che lo swap non sia avvenuto.** Le approvazioni conservano soltanto evidenze e nominativi. Nessun endpoint, modulo o migrazione di questa fase libera USDC, cancella allocazioni o autorizza un trasferimento. `fundsReleased=false` anche dopo due attestazioni; la riconciliazione indipendente dei movimenti blockchain e della cassa resta obbligatoria prima di progettare un eventuale rilascio.

## Risultati osservati, limiti

- Suite `node scripts/run-forensic-tests.js`: **54 PASS, 0 FAIL, 4 BLOCKED_DEPENDENCY, 0 TIMEOUT**, totale 58, `NOT_PASS`.
- `node scripts/test-gas-dual-control.js`: PASS, **mock** PostgreSQL.
- `node scripts/test-migration-compat.js`: PASS 34 checksum.
- `node scripts/test-migration-atomic-envelope.js`: PASS; SQL recording double, **non PostgreSQL nativo**.
- `node ops/db-migrate.js plan`: 34 migrazioni; `PLAN_OK`. Non applicate.
- `node ops/v4-release-gate.js`: uscita nonzero, `PHARAOH_V4_RELEASE_DENIED`.
- `node --check`: PASS sui moduli editati.

**BLOCCANTI:** il container di analisi non ha `postgres`, `initdb`, `psql` o Docker; nessuna connessione al DB, nessuna migrazione eseguita contro PostgreSQL nativo, nessuna prova reale di multi-client/rollback PostgreSQL. Nessun RPC Polygon autorizzato: il verificatore delle prove USDC/POL e' stato esercitato solo tramite fixture locali, non su una transazione live. L'identita' degli operatori non e' integrata con il gestore degli utenti admin; e' una firma Ed25519 individuale autenticata dalla chiave pubblica configurata, soggetta alla corretta custodia delle private key. L'endpoint conserva la chiave ADMIN_API_KEY condivisa come controllo perimetrale, non come prova di identita'.

## Requisiti per la prossima fase

1. Portare il checkpoint in un ambiente di test realmente isolato con PostgreSQL nativo, senza collegamenti o variabili del database produttivo; backup e controllo degli endpoint di rete.
2. Applicare tutte le migrazioni in transazione; testare client concorrenti e rollback reale, inclusi vincoli di univocita' e trigger append-only.
3. Integrare identita'/ruoli per persona e custodia delle chiavi pubbliche, verificare impossibilita' di autoapprovazione o sostituzione della stessa persona con un secondo account.
4. Riconciliare su RPC di sola lettura e saldo treasury: il doppio assenso da solo non libera i fondi.
5. Eseguire l'intera suite con dipendenze effettivamente installate, correggere i blocchi e solo poi considerare un eventuale processo di certificazione per il deploy.

Non sono stati eseguiti deploy, swap, trasferimenti, migrazioni su server o modifiche alla produzione.
