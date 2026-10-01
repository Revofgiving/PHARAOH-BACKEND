# PHARAOH — Patch forense 29 settembre 2026 — Cassa come posizione completa

## Regola definitiva

1. `numero_posizionale` e l'unico progressivo del movimento ENTRATA.
2. Formula: `((tavola - 1) * 6) + casella`.
3. Tavola 1: sei HUMAN, numeri 1..6.
4. Dalla Tavola 2: casella 1 e sempre CASSA PHARAOH; caselle 2..6 sono HUMAN/Funzioni secondo le prenotazioni.
5. La CASSA e una posizione completa, non un placeholder tecnico:
   - account PRIMARIO autonomo;
   - numero_posizionale e sigla propri;
   - tavola personale/sdoppiamento;
   - progressione ordinaria;
   - generazione Funzioni alle stesse condizioni di una posizione PRIMARIO;
   - ricezione doni quando la propria tavola diventa ricevente.
6. La CASSA ha precedenza assoluta sulla casella 1. Una Funzione prenotata in casella 1 slitta alla prima casella valida da 2 in poi.
7. `entry_rollovers` resta esclusivamente audit economico del riporto interno di 100 USDC; non definisce piu l'identita della posizione.

## Correzione live piccola base dati

Aggiunta migration `0022_cassa_posizione_completa.sql`.

La migration:
- trasforma le vecchie posizioni `ROLLOVER` in `CASSA`;
- crea un account PRIMARIO distinto per ogni Cassa gia esistente sullo stesso wallet;
- assegna `numero_posizionale` e sigla canonici;
- crea la tavola personale mancante della Cassa;
- riallinea le tavole personali ENTRATA ancora aperte alla regola deterministica `tavola personale = numero_posizionale + 1`;
- riallinea i contatori dei turni a 6 posizioni fisiche, Cassa compresa;
- elimina `ROLLOVER` dai tipi operativi finali;
- usa controlli fail-closed prima e dopo la riconciliazione.

Non viene cancellato alcun HUMAN e non viene azzerato il database.

## Caso attuale atteso

Con 14 HUMAN e sistema arrivato alla Tavola 3, la struttura logica attesa e:
- Tavola 1: HUMAN 1..6;
- Tavola 2: CASSA 7 + HUMAN 8..12;
- Tavola 3: CASSA 13 + HUMAN 14..16 se tre HUMAN sono gia entrati nella Tavola 3.

Le tavole personali attese sono:
- posizione 1 -> tavola 2;
- ...
- posizione 6 -> tavola 7;
- CASSA 7 -> tavola 8;
- HUMAN 8 -> tavola 9;
- ...
- HUMAN 12 -> tavola 13;
- CASSA 13 -> tavola 14;
- HUMAN 14 -> tavola 15; ecc.

La migration non hard-codifica il numero 14: ricostruisce dai dati reali presenti al momento del deploy, evitando una race se entra un altro utente prima dell'aggiornamento.

## Ticket

Nel runtime corrente non esiste piu `ticket_number`.
I riferimenti residui restano soltanto nei file storici della catena migration (incluso il baseline `database/init.sql`) perche quei file sono immutabili e protetti da checksum. La migration 0021 li converte al modello `numero_posizionale`; non vengono usati dal runtime corrente.

## Test eseguiti

- sintassi JS dei file modificati: PASS;
- `scripts/test-entry-rollover-100.js` aggiornato: PASS;
- Cassa #7 genera tavola personale #8: PASS;
- Cassa #13 genera tavola personale #14: PASS;
- Funzione prenotata in casella 1 slitta: PASS;
- `scripts/test-entry-global-position-static.js`: PASS;
- `scripts/test-migration-compat.js`: PASS, 22 migration;
- `ops/deploy-preflight.js`: PASS statico.

`npm test` completo continua a fermarsi sul test statico Gift/ROG gia noto e non collegato a questa patch; non e stato modificato per mascherare il problema.

## Deploy

Prima del deploy reale: backup PostgreSQL. La migration 0022 e deliberatamente fail-closed se incontra una topologia Cassa diversa da quella prevista, invece di modificare dati ambigui.
