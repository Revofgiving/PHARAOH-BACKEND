# PHARAOH | Rapporto forense Fase 3: registro commissioni USDC

**Data:** 23 novembre 2026. **Stato:** NON DEPLOY (copia isolata, nessun intervento su Coolify, GitHub o PostgreSQL di produzione).

## Provenienza e controllo versioni
- Baseline: `PHARAOH-BACKEND-pharaoh-backend-22-ottobre-2026.zip` (GitHub fornito dall'utente); SHA-256 `8cfc380caf1f2c4561e8ce42d212a3cdf6ee358aa200f5526532de29b58f03f7`.
- Patch economica Fase 2: `PHARAOH_BACKEND_5_USDC_FORENSIC_CHECKPOINT_NON_DEPLOY_23_NOV_2026.zip`; SHA-256 `a07432bce516f8a43904ac3dc159b5e3f7ae05c3b62a13c465edf4ede325cacc`.
- Il pacchetto del 24 ottobre conteneva uno ZIP del 21 ottobre; non sostituisce automaticamente GitHub 22.
- Non è stato verificato che questa baseline coincida con il commit effettivo in Coolify.

## Funzionalità implementate
1. Esce un dono RHA primario da 6.000 USDC lordi: 5.995 al beneficiario, 5 nel bucket `GAS_RESERVE_PENDING` nella Cassa PHARAOH, univoco per evento/posizione. Esclusi RHA secondario, PILETTA, THOT, ISIDE.
2. La nuova migrazione additiva `0031_rha_gas_reserve_registry.sql` crea `pharaoh_gas_reserve_entries`, referenziando payout, evento economico, account e bucket; importo atomico esatto 5.000.000, vincoli SQL univoci e stati PENDING/AVAILABLE/REVIEW_REQUIRED. Nessuna migrazione storica alterata, nessun backfill automatico.
3. `gas-reserve-manager.js` crea o recupera la registrazione nella stessa transazione che crea il payout. Un conflitto di identità/fondi interrompe l'operazione, senza secondo accredito.
4. Il saldo passa a AVAILABLE soltanto quando il payout è SENT e il movimento di tesoreria risulta CONFIRMED/REGISTERED con prova memorizzata, hash e dati del trasferimento coerenti (importo 5.995, destinatario e bucket di payout). Le ripetizioni sono idempotenti.
5. `payout-manager.js` aggancia registrazione e conferma; `payout-economic-adapter.js` aggancia anche il ramo di riconciliazione. Alla scadenza non firmata la quota va in REVIEW_REQUIRED, non è silenziosamente spendibile e richiede politica di rilascio manualmente verificata.
6. `balances(client)` espone al codice backend i totali contabili per stato, ma **non** esiste ancora una route admin pubblica: è un'interfaccia interna.
7. `release-state.json` porta deployable=false, migrationAllowed=false, gate.status=DENY. Docker/API restano bloccati dal release gate. I vecchi controlli di certificazione 30-step non sono riutilizzati.

## Esiti tecnici
- `node scripts/test-gas-reserve-registry.js`: PASS (replay, importi, saldo, pending, proof hash, errore, scadenza e revisione).
- `node scripts/test-rha-gas-reserve-policy.js`: PASS.
- `node scripts/test-confirmed-economics.js`: PASS, 23 scenari.
- `node scripts/test-migration-compat.js`: PASS, 31 checksum verificati.
- `node scripts/test-migration-atomic-envelope.js`: PASS (simulatore SQL, non PostgreSQL nativo).
- `node ops/db-migrate.js plan`: MIGRATION_PLAN_OK: 31.
- Suite completa: **52 PASS, 0 FAIL, 4 BLOCKED_DEPENDENCY, 0 TIMEOUT** (56 test). Esito complessivo NOT_PASS.
- `node ops/v4-release-gate.js`: rifiuto del rilascio con tre blocchi espliciti.
- Non disponibili `psql`/server PostgreSQL/Docker nell'ambiente di verifica; nessun test DB reale eseguito, nessuna migration eseguita in produzione o staging.
- Dipendenze Node mancanti bloccano 4 test: non è una certificazione E2E.

## Rischi e controlli ancora necessari
- Collegamento all'assetto PostgreSQL effettivo: rollback su failure, vincoli, lock e concorrenza reale, query runtime su DB isolato e preflight completo con dipendenze installate.
- Riconciliazione e decisione di cutover su eventuali payout storici/pendenti già accettati prima della patch, specialmente con transazioni firmate o ricevute incomplete.
- Fondo USDC nella stessa cassa significa destinazione contabile, non segregazione fisica. Per dichiarare davvero spendibile una quota occorre riconciliare anche la liquidità on-chain e gli altri impegni.
- Mancano conversioni manuali USDC/POL, verifica on-chain swap, registri commissioni di transazione, autorizzazione/admin e frontend amministrativo. Il saldo AVAILABLE non è ancora movimentabile con il software nuovo.
- Manca la nuova certificazione di release, identificazione della revisione in Coolify e backup verificato.

## Nessuna azione sulla produzione
Modifiche esclusivamente nella cartella sorgente isolata. Nessun deploy, push, transazione, database live, wallet o posizione storica aggiornati.

## Prossima istruzione operativa da inviare in chat
`PHARAOH — FASE 4 FORENSE: usando esclusivamente il checkpoint FASE3 NON DEPLOY, implementa su copia isolata il registro append-only delle conversioni manuali USDC/POL con stato PREPARATA/DA_RICONCILIARE/VERIFICATA, vincolo fondi, prove on-chain di USDC spesi e POL ricevuti, unicità degli hash per chain, autorizzazioni backend amministratore e test di doppia registrazione e concorrenza. Non attivare swap automatici, non distribuire, non modificare database live. Consegna nuovo ZIP NON DEPLOY e rapporto SHA-256.`

**Risultato atteso dal prossimo comando:** codice backend del registro swap su nuova copia, test e relazione; il frontend admin resta successivo.
