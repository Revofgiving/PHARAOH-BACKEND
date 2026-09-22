# PATCH 19 SETTEMBRE 2026 — ROG payment gate asincrono

## Obiettivo
Separare il gate economico ROG dal fulfillment ROG per i percorsi PHARAOH DIRECT e CARTA REGALO.

## DIRECT — regola definitiva
1. Il wallet deve essere membro della Community ROG prima dell'ingresso DIRECT.
2. Il percorso economico e' fisso: 2 USDC a ROG, poi 100 USDC a PHARAOH.
3. PHARAOH apre il gate dei 100 USDC appena il Transfer ROG da 2 USDC e' verificato on-chain (receipt success, sender, destinatario ufficiale, importo esatto, anti-replay).
4. registerDonation ROG, HUMAN, PILETTA, molecola e livello H non bloccano il donatore: proseguono in background.
5. Il frontend PHARAOH non genera piu' autonomamente registerDonation(2) nel percorso Papiro: manda l'utente al frontend ROG e conserva la stessa sessione PHARAOH.

## CARTA REGALO — regola definitiva
1. Il wallet collegato e' il donatore/pagatore.
2. Il beneficiario e' distinto dal pagatore ed e' il titolare delle posizioni generate dal regalo.
3. Il percorso economico PHARAOH Gift e' fisso: 2 USDC a ROG + 100 USDC a PHARAOH.
4. La Community del beneficiario NON viene verificata durante l'acquisto del regalo.
5. Il pagamento ROG verificato apre subito il gate PHARAOH; il fulfillment ROG continua in background.
6. La posizione PHARAOH viene assegnata al beneficiario, mentre la prova di pagamento resta legata al wallet del donatore.
7. Il beneficiario effettuera' la propria registrazione Community al momento del primo accesso personale.

## Area personale
L'endpoint /api/account/:wallet/cross espone anche le assegnazioni ROG DIRECT/GIFT associate al wallet beneficiario. Se la HUMAN ROG non e' ancora disponibile, il frontend mostra:

`Assegnazione ancora non avvenuta.`

Quando disponibile espone posizione HUMAN, molecola e generazione/livello H ricavati dal risultato ROG.

## Database
Aggiunta migration 0018_gift_rog_exact_2.sql, che restringe di nuovo il percorso Carta Regalo PHARAOH a 2 USDC esatti su ROG. La migration 0017 resta nella storia e 0018 applica la regola corrente.

## Test eseguiti
- node --check su direct-donation-manager.js, gift-flow-manager.js, gift-session-manager.js, api-server.js
- scripts/test-direct-rog-external-gate.js: PASS
- scripts/test-direct-gift-dynamic.js: PASS
- scripts/test-migration-compat.js: PASS (18 migrations)

## Dipendenza esterna ancora necessaria
Il repository corrente NON contiene il frontend ROG in produzione (`community-new.html`, `register.html`, `donation.html`, `carta-regalo.html`). Per completare il percorso browser end-to-end, il frontend ROG deve implementare:

- `community-new.html`: il tasto finale REGISTER deve preservare `source=pharaoh` e `returnUrl` nel passaggio a `register.html`.
- `register.html`: dopo registrazione Community confermata, se `source=pharaoh`, ritorna al `returnUrl` PHARAOH; PHARAOH verifica membership, crea la sessione e apre `donation.html`.
- `donation.html`: se `source=pharaoh`, importo bloccato a 2 USDC; dopo receipt valida mostra `TORNA A PHARAOH` e ritorna `sessionRef` + `rogUsdcTxHash` (register/donationId possono arrivare dopo o essere opzionali).
- `carta-regalo.html`: per il percorso PHARAOH Gift usa 2 USDC e ritorna al PHARAOH appena il pagamento e' confermato; il beneficiario non deve essere bloccato dalla Community.

Non modificare le pagine ROG alla cieca: applicare questi punti al sorgente ROG effettivamente pubblicato.
