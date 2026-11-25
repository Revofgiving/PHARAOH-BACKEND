# PHARAOH — FASE 5 FORENSE — NON DEPLOY

Data: 23 novembre 2026. Baseline ESCLUSIVA FASE 4 NON DEPLOY.
SHA-256 ZIP sorgente fase 4: `70393242c1101f062c338d280bdc1782fd6814e3681cceadc5f311343b0b55b5`.

## Codice introdotto
- Migrazione **0033_manual_conversion_cancellation_hold.sql**, additiva, senza modificare le migrazioni precedenti.
- Stato `ANNULLAMENTO_RICHIESTO`: conservazione delle allocazioni della conversione e del loro vincolo. NON e' uno storno o rilascio.
- Endpoint `POST /api/admin/gas-reserve/conversions/:id/cancellation-request` protetto con `requireAdminKey`; JSON `{"reason":"descrizione documentata di almeno 12 caratteri"}`.
- Idempotenza della richiesta di annullamento; blocco su transazioni gia' verificate; conferma on-chain consentita anche dopo richiesta di annullamento.
- Saldo disponibile esclude anche le conversioni `ANNULLAMENTO_RICHIESTO`; la colonna `reservedUsdc` le include.
- Test per richieste duplicate, prevenzione doppio impegno, saldo fermo e successiva verifica on-chain.
- Il saldo non viene mai liberato automaticamente: la sola assenza di hash NON e' una prova che lo swap non sia avvenuto.

## Test osservati
- Test suite locale: {'PASS': 53, 'FAIL': 0, 'BLOCKED_DEPENDENCY': 4, 'TIMEOUT': 0}, totale 57, allPassed=False.
- Piano migrazioni: 33, checksum validi; compatibilita' mock e envelope SQL: PASS.
- Gate release: DENY (intenzionale).
- Evidenze: `FORENSIC_EVIDENCE/FASE5/`.

## Limitazioni non risolte / stop di sicurezza
1. PostgreSQL server locale non disponibile: nessuna prova di applicazione migrazione 0033 su database nativo, nessuna prova reale di concorrenza e rollback.
2. RPC Polygon autorizzato non disponibile, nessuna transazione reale sottoposta a verifica. I test di `swap-proof-verifier` sono fixture locali.
3. Nessun meccanismo per liberare gli USDC dopo cancellazione: serve procedura indipendente di riconciliazione fondi on-chain e autorizzazioni per-persona, da progettare e certificare in una fase successiva.
4. API amministrative Fase 4/5 usano ADMIN_API_KEY condivisa: non prova identita' individuale del richiedente, quindi non supporta approvazione dual control auditabile.
5. Quattro test della suite sono BLOCKED_DEPENDENCY: la suite non e' certificata, il pacchetto non e' deployabile.
6. Il saldo Cassa PHARAOH non e' segregato on-chain: la riserva e' una passivita'/vincolo contabile, non fondi protetti da smart contract.
7. Non sono stati modificati il DB live, le chiavi private, gli indirizzi reali, ROG/URANUS o i fondi.

## Prossima verifica necessaria
Eseguire la migrazione su PostgreSQL esclusivamente isolato, con test multi-client reali. Attestare singoli operatori e doppia approvazione prima di consentire un rilascio di fondi a seguito di annullamento. Eseguire verifica RPC read-only in un ambiente autorizzato. Non usare questa versione in produzione.
