# PHARAOH BACKEND — HOTFIX DIRECT DONATION — 19 OTTOBRE 2026

## Scope
Correzione chirurgica del raccordo ROG -> PHARAOH nel flusso DIRECT 1:1.

## Bug corretto
`rog-donation-manager.js::finalizeRogDonation()` effettuava una seconda POST a `/api/donation/register` forzando `donationType: 'standard'`.
Per un wallet ROG gia esistente la nuova operazione e invece classificata da ROG come `rientro`; la seconda registrazione PHARAOH poteva quindi produrre `DONATION_TYPE_CONFLICT`.

## Regola definitiva
- ROG registra e classifica la propria donazione (`standard` / `rientro`).
- PHARAOH verifica on-chain `Transfer` + `DonationRegistered` tramite le prove gia presenti nel DIRECT manager.
- In finalizzazione PHARAOH chiama soltanto `/api/donation/verify` e read-back `/api/donation/status/:wallet`.
- PHARAOH NON richiama `/api/donation/register`.

## Invarianti non modificati
- 1 nuova donazione ROG da 2 USDC -> 1 nuova HUMAN ROG -> 1 posizione PHARAOH.
- Nessuna HUMAN storica puo essere riutilizzata.
- PHARAOH 100 USDC resta bloccato finche ROG non e `COMPLETED` con HUMAN valida/fresca.
- Smart contract, matematica PHARAOH, database e migrazioni invariati.

## QA specifica hotfix
PASS:
- `test-direct-1to1-golden-e2e.js`
- `test-direct-gift-dynamic.js`
- `test-direct-gift-static.js`
- `test-direct-rog-external-gate.js`
- test dedicato `finalizeRogDonation`: nessuna chiamata `/api/donation/register`.

Nota ambiente di certificazione: la suite completa ha eseguito 48/52 test; 4 sono risultati `BLOCKED_DEPENDENCY` per installazione npm incompleta/offline (`ethers`/`dotenv` non scaricabili). Nessun FAIL applicativo nei test eseguiti. Isa deve rieseguire `npm ci` + `npm test` in ambiente con dipendenze disponibili prima del deploy.
