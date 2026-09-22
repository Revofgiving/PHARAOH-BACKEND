# PHARAOH — Deployment checklist

## Prima del deploy

- [ ] Backup PostgreSQL verificato.
- [ ] Verificare SHA-256 del ZIP e `SHA256_MANIFEST.txt`.
- [ ] Nessun `.env`, chiave privata, `node_modules`, backup DB o file temporaneo nel pacchetto.
- [ ] `DATABASE_URL` punta al DB PHARAOH corretto.
- [ ] `POLYGON_CHAIN_ID=137`.
- [ ] `USDC_CONTRACT_ADDRESS=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (Circle USDC nativo Polygon).
- [ ] Casse PHARAOH/ROG/URANUS verificate e tutte distinte.
- [ ] `PHARAOH_PAYOUT_PRIVATE_KEY` corrisponde alla Cassa PHARAOH.
- [ ] PharaohRegistry Treasury V3 address/CONTRACT_ID/versione/parent ROG/Cassa PHARAOH/BACKEND_ROLE/private key verificati.
- [ ] `PHARAOH_REGISTRY_WORKER_ENABLED=1` in produzione.
- [ ] confermato che PharaohRegistry NON richiede link on-chain con UranusRegistry; i flussi URANUS sono gestiti dal backend.
- [ ] ROG API/contract/treasury/USDC verificati.
- [ ] `ROG_REQUIRED_DONATION_USDC=2`.
- [ ] HMAC cross secret casuale >=32 byte.
- [ ] `ROG_CROSS_INGRESS_URL` e `URANUS_CROSS_INGRESS_URL` HTTPS e realmente predisposti a gestire il protocollo in `CROSS_PROTOCOL_PHARAOH.md`.

## Pre-deploy

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run db:plan`
- [ ] `npm run deploy:preflight`
- [ ] `npm run deploy:preflight:production`

## Migrazione

Il Dockerfile esegue automaticamente:

`npm run db:migrate && exec node api-server.js`

Dopo il deploy:

- [ ] `npm run db:verify`
- [ ] controllare che `0004_cross_movements` fino a `0013_pharaoh_treasury_registry_v3` siano APPLIED;
- [ ] se la migration segnala sessioni DIRECT legacy con importi diversi da 2/100, NON forzare: riconciliare prima i casi storici;
- [ ] verificare che la sequenza storica 0004 venga completata e che 0008/0009 rimuovano poi definitivamente crediti, 5.1/5.3 e campi omaggi staff;
- [ ] `npm run deploy:preflight:integrations` con env live.

## Smoke identita condivisa / rientri autonomi

- [ ] Primario, Perpetui e Gemelli dello stesso proprietario usano lo stesso wallet Ethereum reale.
- [ ] Nessun wallet operativo contiene suffissi `_P<n>` / `_G<n>`.
- [ ] Perpetuo/Gemello restano distinti tramite `account_id` + `sigla`.
- [ ] THOT: i 5 rientri creano 5 nuovi `account_id`, 5 ticket/sigle radice distinti, 5 posizioni ENTRATA e 5 tavole personali, tutti sul wallet reale del ricevente.
- [ ] ISIDE: i 50 rientri creano 50 nuovi `account_id`, 50 ticket/sigle radice distinti, 50 posizioni ENTRATA e 50 tavole personali, tutti sul wallet reale del ricevente.
- [ ] I nuovi percorsi di rientro, una volta avanzati, mantengono la propria identita e possono generare autonomamente Perpetui/Gemelli secondo la nomenclatura prevista.
- [ ] `node scripts/test-autonomous-reentry-roots.js` = PASS.
- [ ] `node scripts/test-secondary-shared-wallet-identity.js` = PASS.

## Smoke THOT / ISIDE

- [ ] THOT PERPETUO/GEMELLO: 10.000 L5 + 500 PROGETTI_UMANITARI + 5 rientri x100 + 4.000 netto.
- [ ] THOT retry: nessuna duplicazione dei 5 rientri.
- [ ] ISIDE PERPETUO/GEMELLO: 50 rientri x100 = 5.000.
- [ ] ISIDE: 19.000 netto base + 6.000 quota diretta = payout unico 25.000.
- [ ] ISIDE retry: nessuna duplicazione dei 50 rientri.
- [ ] ISIDE: nessuna tabella/flow `doni_credito`: sistema rimosso con migration 0008.

## Smoke DIRECT

- [ ] Community ROG presente.
- [ ] 2 USDC ROG esatti.
- [ ] `registerDonation(2)` esatto.
- [ ] ROG COMPLETED.
- [ ] 100 USDC PHARAOH esatti.
- [ ] movimento incoming PHARAOH registrato su PharaohRegistry Treasury V3 e prova salvata.
- [ ] una sola posizione.
- [ ] 200 USDC in una sessione DIRECT rifiutati.
- [ ] retry stesso evento non crea seconda posizione.

## Smoke Carta Regalo

- [ ] PAYER != BENEFICIARY.
- [ ] 2 USDC ROG dal PAYER.
- [ ] 1 RGX PAYER + 1 HUMAN BENEFICIARY.
- [ ] 100 USDC PHARAOH dal PAYER.
- [ ] posizione PHARAOH al BENEFICIARY.
- [ ] beneficiary non Community riceve comunque la posizione.
- [ ] Carta Regalo registrata come movimento incoming della Cassa PHARAOH su PharaohRegistry Treasury V3 e `registry_tx_hash/session_id` salvati.

## Smoke URANUS→PHARAOH

- [ ] Evento HMAC URANUS valido.
- [ ] `wallet_origine` = Cassa URANUS.
- [ ] `wallet_beneficiario` = utente economico originale.
- [ ] tx Circle USDC Cassa URANUS→Cassa PHARAOH.
- [ ] 100→1 posizione; 200→2; 150 rifiutato.
- [ ] stesso `event_key`/tx retry idempotente.
- [ ] evento ROG sul medesimo endpoint rifiutato.
- [ ] ingresso URANUS->PHARAOH registrato su PharaohRegistry Treasury V3 soltanto come movimento verso la Cassa PHARAOH.

## Smoke uscita RHA

Prima di abilitare il worker usare un'uscita controllata o un ambiente di staging.

- [ ] In DB nascono esattamente due operazioni V2: ROG 300/150 dual e URANUS 200/10 dual.
- [ ] beneficiario = wallet ricevente/uscito da RHA, verificato sia su account PRIMARIO sia su account SECONDARIO.
- [ ] nessuna quota/campo omaggi staff: migration 0009 rimuove i campi legacy; il totale cross RHA corrente è 300+200=500.
- [ ] receiver ROG accetta evento firmato senza creare posizioni alla Cassa PHARAOH.
- [ ] receiver URANUS accetta evento firmato senza creare posizioni alla Cassa PHARAOH.
- [ ] entrambe le operazioni RHA sono registrate su PharaohRegistry Treasury V3 soltanto come uscite dalla Cassa PHARAOH; nessun UranusRegistry viene chiamato.
- [ ] failure notifica dopo fondi produce `NOTIFY_PENDING` e NON seconda tx.
- [ ] caso nonce/tx ambiguo produce `RECONCILIATION_REQUIRED` e NON reinvio.
- [ ] simulare/verificare una `post_commit_operation` `PENDING/FAILED` e recuperarla con `POST /api/admin/post-commit/recover`.

Solo dopo questi controlli:

- [ ] impostare `CROSS_OUTBOUND_WORKER_ENABLED=1`.

## Rollback

Non eliminare `0004` manualmente dopo che sono esistite operazioni cross. Un rollback applicativo deve conservare le tabelle e ignorarle in modo compatibile. Prima di rollback: backup, stato delle operazioni `TRANSFER_SUBMITTING/FUNDS_CONFIRMED/NOTIFY_PENDING/RECONCILIATION_REQUIRED`, tx hash e receiver response.


## Cleanup 0008/0009 — obbligatorio prima del deploy applicativo

- [ ] `0008_remove_doni_credito` applicata: `doni_credito` assente, `credito_id` assente, nessun tipo `CREDITO`, nessun contenitore 5.3.
- [ ] `0009_remove_dono_al_volo_staff_legacy` applicata: nessun contenitore 5.1, nessuna lista d'attesa Dono al Volo, nessun campo `staff_omaggi_*` su `rha_exit_allocations`.
- [ ] `npm run test:no-credito-no-dono-al-volo` = PASS.
- [ ] RHA corrente = 300 ROG + 200 URANUS; THOT e ISIDE invariati rispetto alle migration 0006/0007.

## ENTRATA rollover 100 / guard Funzioni — obbligatorio

- [ ] `0011_entry_function_reservation_guard` APPLIED.
- [ ] `0012_entry_rollover_100` APPLIED.
- [ ] Tavola ENTRATA 1: 6 donatori reali x100, nessun ROLLOVER iniziale.
- [ ] Alla chiusura Tavola 1: 100 USDC restano in Cassa PHARAOH e sono materializzati nella Tavola 2.
- [ ] Tavola 2+: esattamente 1 posizione `ROLLOVER` Cassa PHARAOH da 100 + 5 nuovi ingressi/rientri.
- [ ] ROLLOVER non possiede account_id/ticket e non genera tavola di sdoppiamento.
- [ ] ROLLOVER idempotente: retry non crea una seconda posizione.
- [ ] ROLLOVER, DIRECT/Gift/cross ENTRATA e rientri THOT/ISIDE non occupano caselle riservate alle Funzioni.
- [ ] I ticket ordinari/rientro non consumano ticket prenotati a Funzioni/Gemelli.
- [ ] `npm run test:entry-rollover` = PASS.
- [ ] Nessuna env `PHARAOH_ENTRY_RESERVE_WALLET` e nessun endpoint legacy `entry-reserve/process`.
- [ ] Se 0012 fallisce con `0012_ENTRY_ROLLOVER_RECONCILIATION_REQUIRED`, riconciliare gli stati legacy prima del deploy.

## Blocco full-stack prima del deploy pubblico

- [x] Frontend DIRECT usa Community ROG + sessione + 2 USDC ROG + registerDonation + conferma ROG + 100 USDC PHARAOH + `sessionRef`; una sessione = una posizione.
- [x] Carta Regalo esposta dal frontend e collegata ai flussi backend payer/beneficiary.
- [x] Area Personale usa il modello una persona/un wallet/multi-posizione e associa correttamente sigla/numero/percorso tecnico.
- [x] Area Personale verifica Community ROG prima di caricare i dati personali; beneficiario Gift puo registrarsi al primo accesso.
- [x] Area Personale mostra operazioni RHA cross verso ROG/URANUS.
- [x] Rimossi dal sorgente frontend attivo Doni a Credito, Dono al Volo, dono in prestito e lista attesa.
- [x] Papiro e Tempio Personale riaperti; aggiunta navigazione Carta Regalo.
- [x] Test cucitura frontend/backend rafforzato: 58 controlli, 0 fallimenti nello snapshot corrente.
- [ ] Build Next production aggiornata da eseguire su host con dipendenze native SWC/accesso npm; non pubblicare il vecchio `out`.
- [ ] Smoke E2E reale con wallet controllati e backend/ROG/Polygon live.
