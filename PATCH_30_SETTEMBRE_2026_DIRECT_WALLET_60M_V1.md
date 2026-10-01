# PHARAOH — PATCH 30 SETTEMBRE 2026 — DIRECT WALLET 60M V1

Perimetro esclusivo: flusso DIRECT Community ROG -> nuova HUMAN ROG -> 100 USDC PHARAOH.

## Regole implementate
- Stato ricostruito dal wallet, non dalla sessione browser.
- Community ROG riverificata server-side.
- Nuova posizione HUMAN ROG obbligatoria e monouso.
- T0 = `created_at` della HUMAN ROG verificata dal backend ROG.
- Finestra = 60 minuti da T0.
- Stato ROG esposto come NOT_FOUND / PROCESSING / ELIGIBLE / CLAIMED / USED / EXPIRED.
- PROCESSING non invita a ripagare: l'utente deve attendere.
- Seconda verifica obbligatoria immediatamente prima del pagamento PHARAOH tramite `/api/donazione/diretta/authorize`.
- Claim atomico temporaneo per impedire due pagamenti concorrenti sulla stessa HUMAN.
- Anti-replay mantenuto tramite indice univoco già esistente su `rog_human_position`.
- Rimossi dal DIRECT i vincoli storici di 120 secondi rispetto alla creazione della sessione PHARAOH.
- Sessione DIRECT mantenuta solo come audit/idempotenza interna e come contenitore della prova, non come fonte di verità del browser.

## Nuovi endpoint
- `GET /api/donazione/diretta/eligibility/:wallet`
- `POST /api/donazione/diretta/authorize`
- `POST /api/donazione/diretta/authorize/release`

## Nuova migration
- `0023_direct_rog_wallet_eligibility_60m.sql`

## File runtime modificati
- `api-server.js`
- `direct-donation-manager.js`
- `direct-donation-session-manager.js`
- `direct-rog-eligibility-manager.js` (nuovo)

## Aree intenzionalmente NON modificate
Carta Regalo, numerazione posizionale, Cassa PHARAOH, Funzioni/65 HUMAN, Perpetuo/Gemello, RHA, THOT, ISIDE, Area Personale, smart contract e importi economici.

## Verifiche statiche eseguite
- sintassi di tutti i file JS backend: PASS
- migration compatibility con 23 migration: PASS
- test HUMAN ROG obbligatoria / anti-replay: PASS
- deploy preflight statico: PASS
- database reale: NON CONTATTATO
- E2E wallet reale: DA ESEGUIRE in staging/produzione controllata

Nota: `scripts/test-direct-gift-static.js` fallisce già sulla baseline originale del 29 settembre con l'asserzione Carta Regalo `Gift deve fare read-back ROG COMPLETED prima di creare valore`. Il flusso Gift non è stato toccato da questa patch.
