# PHARAOH - FASE 7 FORENSE (NON DEPLOY)

Baseline: ESCLUSIVAMENTE `PHARAOH_BACKEND_FASE6_FORENSE_NON_DEPLOY_23_NOV_2026.zip` (SHA-256 registrata nel report esterno), 281 entry ZIP originali. La cartella estratta e' stata copiata, senza modificare lo ZIP FASE6.

## Modifiche

- Corretti i due test di rehearsal PostgreSQL `scripts/rehearse-postgres-economy.js` e `scripts/rehearse-postgres-concurrency.js`, precedentemente obsoleti e ancorati a **31** migrazioni; ora richiedono il piano effettivo di **34** migrazioni.
- Rafforzata la validazione del laboratorio: `PHARAOH_TEST_DATABASE_URL` deve puntare esclusivamente a loopback (`localhost`, `127.0.0.1` o `::1`), oltre ai controlli preesistenti sul database vuoto e sul nome disposable.
- Aggiunto `scripts/test-fase7-native-lab-static.js` con controlli su piano SHA-256, stato NON DEPLOY, trigger append-only e divieto di rilascio fondi. Nessun contatto con PostgreSQL da questo test.
- Aggiunta la procedura di laboratorio `forensic/fase7/POSTGRESQL_LAB_PROCEDURA.md`.
- **Nessuna modifica** a moduli runtime (payout, riserva, Registry, API, smart contract), migrazioni storiche o logiche economiche. Nessuna nuova migrazione.

## Evidenze verificate in questo ambiente

- ZIP FASE6: `testzip() = None`, 281 entry.
- `loadPlan()` ricalcola e verifica hash delle 34 migrazioni: PASS.
- Test locale dedicato FASE7: PASS (controlli statici, non SQL eseguito).
- `node scripts/run-forensic-tests.js`: 59 casi, 55 PASS, 0 FAIL, 4 BLOCKED_DEPENDENCY, 0 TIMEOUT, esito globale NOT_PASS.
- `node ops/v4-release-gate.js`: EXIT 1 / `PHARAOH_V4_RELEASE_DENIED`, atteso e mantenuto.

## NON ESEGUITO / NON CERTIFICATO

Il container non include `postgres`, `initdb`, `psql`, Docker o `pg` installato. Tentativo `apt-get update` interrotto per timeout: impossibile attivare un PostgreSQL nativo. Di conseguenza nessun SQL e' stato applicato su un server e nessuna concorrenza multi-client e' stata certificata. Il piano e' staticamente verificato, **non** applicato. Nessun endpoint Polygon RPC autorizzato e' disponibile per confermare trasferimenti reali: verifica on-chain LIVE NON ESEGUITA. La distinzione fra due firme e due individui fisici richiede procedura esterna di onboarding, non deducibile dalle sole firme Ed25519.

## Go / no-go

**NO-GO / NON DEPLOY**. I fondi restano bloccati quando l'annullamento e' richiesto. Non attivare release, migration o swap. Le verifiche riportate non costituiscono certificazione PostgreSQL/on-chain.
