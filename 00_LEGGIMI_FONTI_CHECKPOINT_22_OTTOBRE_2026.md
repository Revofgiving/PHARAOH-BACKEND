# PHARAOH BACKEND - FONTE UFFICIALE MAC 22 OTTOBRE 2026

**STATO: CHECKPOINT NON_DEPLOY. NON CARICARE IN COOLIFY COME RELEASE CERTIFICATA.**

Questo pacchetto deriva ESCLUSIVAMENTE dallo ZIP `PHARAOH_BACKEND_22_OTTOBRE_REGISTRY_FIX_NON_DEPLOY.zip` esportato dal Mac e fornito dall'utente. Questa e' la base ufficiale di riferimento per il backend PHARAOH, NON i pacchetti storici del 21 ottobre.

## Delta sullo ZIP del Mac
- `scripts/rehearse-postgres-economy.js`: piano QA atteso 30 anziche 28; conteggio report dinamico.
- `scripts/rehearse-postgres-concurrency.js`: validazione piano di 30 migrazioni; conteggio report dinamico.
- Documentazione aggiunta: questo LEGGIMI e `RAPPORTO_QA_POSTGRES_30_MIGRAZIONI_22_OTTOBRE_NON_DEPLOY.md`.
- Nessun'altra modifica al codice applicativo, ai file SQL, al piano migrazioni, allo stato release o alle logiche di wallet/posizioni.

## Verifiche effettuate nel contesto di analisi
- ZIP Mac: integrita' archivio OK.
- `node --check` sui due script aggiornati: OK.
- `node ops/db-migrate.js plan`: MIGRATION_PLAN_OK: 30.
- `node scripts/test-migration-compat.js`: PASS.
- `node scripts/test-migration-atomic-envelope.js`: PASS, 89 verifiche con driver simulato (NON PostgreSQL nativo).
- `node scripts/test-direct-1to1-golden-e2e.js`: PASS, 17 controlli con adattatori in memoria (NON rete reale).
- Confronto byte per byte contro lo ZIP Mac: solo due file JS QA modificati; gli altri file originali invariati.

## Test e validazioni non concluse
- Non sono stati eseguiti qui i test PostgreSQL nativi di concorrenza o integrazioni blockchain/ROG live.
- L'utente ha precedentemente riferito esito `MIGRAZIONI_APPLICATE: 30` e `DATABASE_SCHEMA_VERIFIED: 30` sul proprio Mac nel database di prova `pharaoh_rehearsal_22ott` (NON nella produzione).
- L'esito di un release gate basato su `release-state.json` non equivale da solo ad una nuova certificazione completa.

## Regole
- Preservare registrazioni, wallet, posizioni e il database esistente.
- Vietato migrare o distribuire in produzione senza autorizzazione esplicita.
- Eventuali test PostgreSQL disposable devono usare un database nuovo e distinto da `pharaoh_rehearsal_22ott`.
