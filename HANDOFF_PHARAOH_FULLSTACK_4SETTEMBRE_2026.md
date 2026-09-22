# HANDOFF PHARAOH - 4 SETTEMBRE 2026

## Baseline operativa

Questa cartella backend e allineata con `PHARAOH FRONTEND 4 SETTEMBRE` e `PHARAOH SMART CONTRACT 4 SETTEMBRE`.

## Architettura wallet e percorsi

Una persona utilizza sempre una sola stringa wallet MetaMask. Primario, Perpetuo, Gemello e rientri sono posizioni/percorsi differenti dello stesso wallet. Le chiavi `account_id/percorso_id` distinguono la progressione tecnica e non rappresentano wallet diversi.

## Regole principali correnti

- DIRECT: Community ROG -> 2 USDC ROG -> registrazione ROG -> 100 USDC PHARAOH -> una posizione.
- Carta Regalo: il pagatore esegue ROG + PHARAOH; la posizione nasce sul wallet del beneficiario.
- RHA: 300 USDC verso ROG / 150 dual + 200 USDC verso URANUS / 10 dual.
- THOT: 10.000 verso ISIDE + 500 progetti umanitari + 500 = 5 rientri Entrata + 4.000 al ricevente.
- ISIDE: 5.000 = 50 rientri Entrata + payout 25.000 (19.000 base + 6.000 quota diretta).
- Doni a Credito, Dono al Volo, lista 5.1/5.3 e omaggi staff eliminati.
- Rientri THOT/ISIDE: nuove posizioni/radici numerate con lo stesso wallet del ricevente.
- Entrata: prima tavola Fondo A con 6 donatori; 500 per progressione e 100 riportati alla tavola successiva. Dalla tavola 2: riporto Cassa PHARAOH 100 + 5 nuovi ingressi. Prenotazioni Funzioni protette.

## Smart contract PHARAOH

Il contratto corrente e `PHARAOH_TREASURY_REGISTRY_V3`, versione `3.0.0`.

ROG e l'unico parent contract. URANUS e PHARAOH sono sibling/satelliti di ROG. PharaohRegistry NON richiede `URANUS_REGISTRY_ADDRESS` e non chiama UranusRegistry.

Il contratto non custodisce token e non esegue la logica economica. Registra soltanto prove immutabili di movimenti USDC verificati dal backend:

- `registerIncoming(...)`: fondi entrati nella Cassa PHARAOH;
- `registerOutgoing(...)`: fondi usciti dalla Cassa PHARAOH.

DIRECT, Gift, payout e cross sono categorie backend; sul contratto sono soltanto etichette `txType` di audit.

Il backend verifica prima di scrivere: chainId, bytecode, CONTRACT_ID, versione 3.0.0, parent ROG, Cassa PHARAOH e BACKEND_ROLE.

## Database

Piano corrente aggiornato: 14 migration fino a `0014_rog_rha_registration_evidence.sql`. La 0013 resta dedicata alle prove Treasury Registry V3; la 0014 aggiunge nonce/hash/donationId/prova durevole di `registerDonation()` ROG per le uscite RHA PHARAOH -> ROG.

## Frontend

Il frontend corrente contiene DIRECT allineato al backend, Carta Regalo, Area Personale multi-percorso sullo stesso wallet, refresh delle posizioni e prove Registry quando disponibili. Doni a Credito/Dono al Volo/dono in prestito sono rimossi e Papiro/Tempio sono riaperti.

## Cosa resta live

Prima dell'apertura pubblica: deploy del nuovo PharaohRegistry su Polygon, configurazione Coolify, backup/migration DB, preflight live, build Pinata nuova e smoke test reali controllati. Nessuna di queste verifiche live va dichiarata PASS finche non viene eseguita realmente.


## Aggiornamento ROG bridge 5 settembre 2026

Per RHA -> ROG il backend PHARAOH ora esegue, dopo il Transfer USDC e la prova PharaohRegistry, anche `ROG.registerDonation(importo)` dalla stessa Cassa PHARAOH. La notifica HMAC a ROG include `register_tx_hash` e `donation_id`. ROG deve attribuire RGx alla Cassa PHARAOH e le HUMAN/posizioni SMALL al wallet ricevente RHA. Il percorso e fail-closed e non ripete automaticamente ne fondi ne registerDonation quando una tx e gia nota.
