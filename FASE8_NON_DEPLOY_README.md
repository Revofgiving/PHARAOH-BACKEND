# PHARAOH FASE 8 — AUDIT FORENSE — 23 NOVEMBRE 2026

**STATO: NON DEPLOY / NON CERTIFICATO PER PRODUZIONE**

## Fonti realmente esaminate
- Backend FASE7: `PHARAOH_BACKEND_FASE7_FORENSE_NON_DEPLOY_23_NOV_2026.zip` (sorgente integrale, 34 migrazioni).
- `PHARAOH_ADMIN_SUBDOMAIN_FORENSIC_FINAL_V2_BLOCK_DONI.zip`: **build statico Next.js**, non sorgente modificabile. Include bundle `/_next/` e pagine HTML.
- `PHARAOH_FRONTEND_PINATA_BUILD_SOURCE.zip`: contiene il **sorgente modificabile** Next.js in `src/app/admin` e le API frontend. E' la base della patch, ma **non esiste prova che corrisponda alla build amministrativa attualmente distribuita**. Non sovrascrivere il pannello live senza un merge e una nuova build certificata.
- `PHARAOH_FRONTEND_24 OTTOBRE_ULTIMA_VERSIONE.zip` e `PHARAOH_FRONTEND_PINATA_COMPLETO_FIX_RECOVERY_04_NOV_2026 (2).zip`: artefatti frontend successivi; NON assunti come base sorgente admin senza equivalenza dimostrata.

## Modifiche backend (delta su Fase7)
- `admin-routes.js`: aggiunge due endpoint GET **protetti da `security.requireAdminKey`**:
  - `/api/admin/gas-reserve/entries`: ultime 200 quote accantonate con stato e payout hash.
  - `/api/admin/gas-reserve/conversions/:id/events`: ultimi 200 eventi append-only della conversione, con ID validato e query parametrizzata.
- API preesistenti Fase7 riusate per balance, lista conversioni, prepare, verify, reconcile e cancellation-request.
- **Nessuna migrazione nuova**: 34 su 34 SQL identici, piano identico; rilascio dei fondi NON abilitato.

## Modifiche frontend (delta sul sorgente Pinata)
- Nuova pagina `src/app/admin/riserva-commissioni/page.tsx`.
- Nuove funzioni tipizzate in `src/lib/admin-api.ts`.
- Link nella navigazione `src/app/admin/layout.tsx`.
- Rimossa eccezione locale `localhost` che in precedenza aggirava la verifica di accesso nel layout (resta la verifica server-side del backend per ogni API).
- Dashboard: saldi accantonati, disponibili, impegnati, usati, pendenti e da revisionare; ultimi 200 accantonamenti; ultime 100 conversioni; eventi fino a 200 per singola conversione.
- Prep conversione: input USDC fino a 6 decimali, POL a 18 decimali convertiti con BigInt; requestKey idempotente; conferma esplicita. Non esegue swap.
- Verifica on-chain: hash tx passato al backend esistente, senza indicare successo se il backend rifiuta la prova.
- Riconciliazione e richiesta di annullamento (non rilascio); nessuna firma privata o attivazione attestazioni Ed25519 dal browser.

## LIMITI NON RISOLTI — IMPORTANTI
1. La build admin corrente e' presente solo come HTML + bundle compilati: **il nuovo sorgente non e' stato integrato ne' confrontato byte-per-byte con quella build**. Una sostituzione live farebbe rischiare regressioni.
2. Le API Fase7 autenticano tramite **X-Admin-Key condivisa**. Il backend etichetta gli attori `ADMIN_KEY_AUTHENTICATED`; NON costituisce identificazione individuale. Le attestazioni Ed25519 richiedono strumenti esterni al browser.
3. `getGasConversions` restituisce ultime 100, `getGasReserveEntries` ultime 200: il totale POL visualizzato e' **solo per le ultime 100 conversioni verificate**, non totale storico e non saldo del wallet.
4. L'importo POL atteso richiesto dal backend deve coincidere esattamente con la prova on-chain; conversioni con output variabile richiedono una riconciliazione/procedura dedicata, non auto-approvazione.
5. **Nessuna compilazione completa `next build` o typecheck concluso:** le dipendenze frontend non sono state installate nell'ambiente corrente. Il tentativo `npm ci` e' scaduto per timeout. La validazione TypeScript eseguita e' di parsing sintattico, non semantico.
6. **Nessun test HTTP E2E, nessun RPC Polygon live, nessuna prova su database produzione, nessun deploy.** PostgreSQL nativo Fase7 era stato testato sul Mac dall'operatore (19 PASS su dati sintetici); tale esito non certifica questa modifica delle API/UI.
7. Nessun backfill degli accantonamenti storici; nessuna migration in Fase8.

## Test eseguiti nel checkpoint
- 16 controlli mirati superati: parsing TS di 3 file, autenticazione routes, SQL parametrizzato, limiti record, conferma operazioni, POL senza floating point, niente firma privata browser, niente rilascio fondi, login locale non esentato, corrispondenza API e piano migrazioni invariato.
- `node --check` di `admin-routes.js`: PASS.
- Release gate originale e backend Fase8: entrambi terminano con errore (DENY intenzionale).
- SHA256 degli originali e dei nuovi ZIP in manifest allegato.

## Procedura raccomandata
1. Acquisire repository sorgente **attualmente distribuito** del sottodominio admin, non soltanto ZIP statico.
2. Merge chirurgico dei file `src/app/admin/riserva-commissioni/page.tsx`, `src/lib/admin-api.ts`, `src/app/admin/layout.tsx` nella baseline aggiornata; preservare i fix successivi.
3. Eseguire `npm ci`, `npm run typecheck`, `npm run test:integration`, `npm run build` in ambiente isolato con Node 22 e dipendenze disponibili.
4. Eseguire test HTTP con amministratore di prova e PostgreSQL sintetico; confermare che le credenziali condivise non consentano escalation e che gli endpoint restino nascosti agli utenti.
5. Confrontare asset e configurazione della release admin corrente, predisporre rollback, backup e smoke E2E prima di considerare il deploy.

**Comandi di deploy non autorizzati. NON DEPLOY.**
