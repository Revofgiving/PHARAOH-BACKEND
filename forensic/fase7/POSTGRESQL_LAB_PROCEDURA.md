# PHARAOH FASE 7 - protocollo laboratorio PostgreSQL nativo (NON ESEGUITO)

Questo documento descrive una procedura di laboratorio, **non** una certificazione ottenuta. Non usare database o credenziali Coolify/produzione. Non eseguire le migrazioni PHARAOH in produzione.

## Requisiti di isolamento

- PostgreSQL nativo su macchina/container di prova, raggiungibile **solo** a `127.0.0.1` tramite una porta non condivisa.
- Database dedicato, vuoto, nominato `pharaoh_test_abcdefgh` (o equivalente con prefisso obbligatorio); utente limitato al database test.
- Nessun `DATABASE_URL` applicativo: la suite usa solo `PHARAOH_TEST_DATABASE_URL`.
- L'ack `PHARAOH_DISPOSABLE_PG_ACK=DISPOSABLE_EMPTY_DATABASE` e' obbligatorio.
- Prima dell'esecuzione: `npm ci --ignore-scripts` in ambiente di prova, verificando l'integrita' del lockfile.

## Comandi da utilizzare SOLO dopo creazione del database locale di prova

```sh
export PHARAOH_DISPOSABLE_PG_ACK=DISPOSABLE_EMPTY_DATABASE
export PHARAOH_TEST_DATABASE_URL='postgres://<utente-test>:<password-test>@127.0.0.1:5432/pharaoh_test_abcdefgh'
node scripts/rehearse-postgres-economy.js
node scripts/rehearse-postgres-concurrency.js
```

**NON impostare** `DATABASE_URL` con valori della produzione. Il primo script verifica database vuoto, applica le 34 migrazioni in una transazione e ne esegue rollback. Il secondo usa uno schema QA privato marcato e lo rimuove a fine test; l'eventuale interruzione richiede verifica manuale dello schema. Entrambi necessitano di riesame e prova su un server PostgreSQL prima di essere considerati certificati.

## Prove ancora necessarie

1. Applicazione effettiva di tutte le 34 migrazioni e trigger append-only via PostgreSQL.
2. Multi-client: concorrenza, idempotenza e rollback del **registro conversioni** (non soltanto del ledger economico preesistente).
3. Vincolo di doppia approvazione con identita' individuali indipendenti, autorizzazione amministrativa e storicizzazione verificata.
4. Verifica RPC Polygon in sola lettura con endpoint autorizzato e hash reale di test, incluso rilevamento di trace incomplete.
5. Test end-to-end in staging prima di qualsiasi rilascio. Nessun rilascio fondi da annullamento finche' prova insufficiente.

**Evidenze obbligatorie:** versione PostgreSQL, timestamp, hash sorgenti, comando eseguito (senza password), output completo, DB fingerprint pre/post e prova che nessuna connessione ha raggiunto produzione.
