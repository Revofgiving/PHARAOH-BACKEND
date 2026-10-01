# PHARAOH — Patch forense 29 settembre 2026

## Obiettivo

Eliminazione del concetto operativo legacy di ticket e consolidamento di `numero_posizionale` come unico numero valido del movimento PHARAOH.

## Regola canonica ENTRATA

`numero_posizionale = ((tavola - 1) * 6) + casella`

Quindi:

- Tavola 1: caselle 1..6 = posizioni 1..6, tutte HUMAN.
- Tavola 2: Cassa PHARAOH obbligatoriamente in casella 1 = posizione 7; caselle 2..6 = posizioni 8..12.
- Tavola 3: Cassa PHARAOH obbligatoriamente in casella 1 = posizione 13; caselle 2..6 = posizioni 14..18.
- La sequenza prosegue senza reset da 1 a infinito.

La Cassa/ROLLOVER e una vera posizione numerata ma non crea un account, non si sdoppia e non crea un percorso autonomo.

## Precedenza Funzioni

Le prenotazioni Funzioni restano valide. Se una Funzione risulta prenotata nella casella 1 di una tavola ENTRATA dalla Tavola 2 in poi, la Cassa mantiene la precedenza assoluta sulla casella 1 e la prenotazione Funzione viene spostata alla prima casella libera a partire dalla 2. Nessun ingresso ordinario puo invadere una casella Funzione riservata/materializzata.

## Modifiche runtime

- `table-manager.js`: posizione globale canonica, Cassa forzata in casella 1, shift della prenotazione Funzione confliggente.
- `db-manager.js`: campi correnti rinominati a `numero_posizionale`; persistenza del numero canonico sulle `posizioni` ENTRATA; helper di sincronizzazione account/posizione/tavola personale.
- `account-manager.js`: Area Personale usa esclusivamente `numero_posizionale`.
- `api-server.js`: rimosso endpoint legacy `/api/account/ticket/:...`; endpoint corrente `/api/account/posizione/:numeroPosizionale`; nessuna esposizione `ticket_number`.
- `reentry-manager.js`: THOT/ISIDE ricevono il numero solo dalla posizione fisica realmente assegnata, non da un contatore parallelo.
- `function-manager.js`, `rules-engine.js`, `container-manager.js`, `security-manager.js`, `admin-routes.js`: nomenclatura riallineata senza concetto operativo ticket.

## Migration 0021

`database/0021_numero_posizionale_unico.sql`:

- rinomina in modo compatibile le colonne legacy presenti nel database;
- aggiunge `posizioni.numero_posizionale`;
- ricostruisce il numero ENTRATA da tavola/casella;
- riallinea gli account alla prima posizione ENTRATA reale;
- conserva le prenotazioni Funzioni con nomenclatura posizionale;
- crea indici univoci sul numero canonico;
- si ferma con `0021_ENTRY_ROLLOVER_SLOT1_RECONCILIATION_REQUIRED` se trova un rollover storico fuori dalla casella 1, evitando una correzione automatica distruttiva.

Le migration storiche precedenti restano immutabili per non introdurre checksum drift; gli unici riferimenti legacy residui sono quindi quelli necessari dentro `0021` per rinominare lo schema gia esistente.

## Test mirati eseguiti

PASS:

- `test-entry-global-position-static.js`
- `test-entry-rollover-100.js`
- `test-autonomous-reentry-roots.js`
- `test-secondary-shared-wallet-identity.js`
- `test-thot-humanitarian-reentry.js`
- `test-iside-reentry-receiver-gift.js`
- `test-wallet-person-paths-static.js`
- `test-migration-compat.js` (21 migration)
- sintassi JavaScript completa.

La suite globale `npm test` resta bloccata da due test DIRECT/Gift gia falliti identicamente nella baseline originale del 22 settembre (`test-direct-gift-static.js` e `test-direct-gift-dynamic.js`): non e una regressione introdotta da questa patch. Prima del deploy pubblico va comunque chiusa anche quella anomalia di baseline.
