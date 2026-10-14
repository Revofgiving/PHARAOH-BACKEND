# PATCH 1 OTTOBRE 2026 - PROGRESSIVO GLOBALE ENTRATA, FUNZIONI E CASSA

## Obiettivo

Allineare l'assegnazione delle posizioni ENTRATA alla sequenza operativa verificata:

- `numero_posizionale` unico e progressivo da 1 a infinito;
- i numeri prenotati alle Funzioni/Gemelli consumano il progressivo globale ma NON una casella fisica ENTRATA;
- la prima tavola contiene 6 HUMAN;
- dalla seconda tavola in poi la casella 1 e una posizione CASSA completa e le caselle 2..6 sono 5 HUMAN;
- la CASSA riceve il prossimo numero globale libero solo dopo i 5 HUMAN effettivamente materializzati della tavola precedente.

Sequenze di riferimento verificate:

- Gemelli/Funzioni riservati: `26, 40, 54, 68, 82, 96, 110, ...`;
- Cassa: `7, 13, 19, 25, 32, 38, 45, 51, 58, 64, 71, 77, 84, 90, 97, 103, 109, 116, 122, ...`.

Esempio decisivo:

`CASSA #25 -> #26 PRENOTATO FUNZIONE -> HUMAN #27..#31 -> CASSA #32`.

## Modifica runtime

### db-manager.js

- introdotto `entry_position_counter`;
- introdotto allocatore transazionale `allocateNextEntryNumeroPosizionale()`;
- advisory lock PostgreSQL per serializzare le assegnazioni concorrenti;
- salto automatico dei numeri Gemello `26 + 14*n`;
- salto automatico delle prenotazioni persistite in `prenotazioni_funzioni` e `funzioni`;
- controllo di collisione contro numeri gia materializzati in `posizioni` e `accounts`;
- `createPosizione()` richiede il numero globale esplicito per ENTRATA.

### table-manager.js

- eliminata dal runtime la derivazione `((tavola - 1) * 6) + casella`;
- le prenotazioni Funzione non occupano piu caselle fisiche ENTRATA;
- HUMAN e CASSA usano lo stesso allocatore globale;
- la CASSA resta una posizione completa, sempre in casella 1 dalla Tavola 2;
- la tavola ENTRATA si chiude soltanto quando esistono 6 posizioni fisiche reali.

### api-server.js

- Area Personale legge il `numero_posizionale` canonico persistito;
- rimosso il fallback che ricostruiva il numero dalla formula tavola/casella.

## Migration 0025

Aggiunta:

`database/0025_entry_global_progressive_with_function_reservations.sql`

La migration:

1. crea il contatore globale persistente;
2. verifica fail-closed eventuali prenotazioni attive duplicate;
3. riallinea le posizioni ENTRATA esistenti in ordine fisico, saltando i numeri riservati;
4. riallinea `accounts.numero_posizionale` e le sigle dei percorsi PRIMARIO;
5. riallinea le identita CASSA al nuovo numero globale;
6. mantiene indipendente la numerazione tecnica delle tavole personali di sdoppiamento;
7. inizializza il contatore al massimo numero ENTRATA realmente materializzato;
8. verifica invarianti finali e fallisce il deploy se trova collisioni o numeri riservati occupati.

Le migration storiche non sono state riscritte. La `0025` rappresenta la correzione forward dello schema, mentre `0022` conserva la precedente correzione live basata su `sdoppiamento_tavola_id`.

## Test eseguiti

PASS:

- sintassi JavaScript completa;
- `test-entry-global-position-static.js`;
- `test-entry-rollover-100.js` con simulazione fino alla CASSA #122;
- `test-autonomous-reentry-roots.js`;
- `test-function-reservations-65-human.js`;
- regressioni RHA, THOT, ISIDE, identita shared-wallet e no-credit/no-dono-al-volo;
- `test-migration-compat.js`: 25 migration/checksum validi;
- `npm run db:plan`: `MIGRATION_PLAN_OK: 25`;
- `npm run deploy:preflight`: `PREFLIGHT_STATICO: OK`.

Il PostgreSQL live non e stato modificato in questo ambiente. La migration 0025 deve essere applicata da Coolify dopo backup e deve completarsi integralmente prima di considerare il deploy concluso.

## Perimetro non modificato

Nessuna modifica funzionale a:

- DIRECT Community/ROG/HUMAN 60 minuti;
- Carta Regalo Smartbox 3 mesi;
- ROG backend/frontend;
- RHA, THOT, ISIDE (salvo l'uso condiviso del nuovo allocatore ENTRATA quando generano rientri);
- smart contract;
- importi economici;
- logiche Perpetuo/Gemello diverse dalla prenotazione del numero globale.
