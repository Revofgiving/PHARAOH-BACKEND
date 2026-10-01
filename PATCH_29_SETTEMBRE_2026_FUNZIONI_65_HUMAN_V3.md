# PHARAOH — PATCH 29 SETTEMBRE 2026 — FUNZIONI / 65 HUMAN V3

## Regola consolidata
- Le Funzioni vengono generate all'uscita dal livello RHA (L3).
- Il Faraone uscente genera 5 posizioni per il turno successivo: 3 Simbionti, 1 Perpetuo, 1 Gemello.
- Le 5 posizioni sono prenotate a priori e non possono essere occupate dagli HUMAN ordinari.
- Il fabbisogno strutturale del turno successivo passa da 18 a 13 sacerdoti da formare.
- Dalla Tavola Entrata 2 in poi la casella 1 e sempre una vera posizione CASSA PHARAOH; restano 5 HUMAN per tavola.
- Le 13 tavole del calcolo successivo alla Tavola 1 richiedono quindi 13 x 5 = 65 HUMAN.

## Ordine di precedenza
1. CASSA PHARAOH in casella 1 delle tavole Entrata T2+.
2. Funzioni prenotate nelle posizioni Pharaoh del turno successivo.
3. HUMAN ordinari.

## Database
Non viene aggiunta una migration 0023: questa correzione non cambia lo schema e non richiede riscrittura dei dati. Le prenotazioni sono gia persistite in `prenotazioni_funzioni` e la CASSA completa e gestita dalla migration 0022. Aggiungere una migration vuota o cosmetica aumenterebbe il rischio di drift senza beneficio.

## Codice
- `rules-engine.js`: esplicitate le costanti 5 Funzioni, 13 sacerdoti residui, 5 HUMAN/tavola e 65 HUMAN; aggiunto controllo di invariante.
- `donation-flow-manager.js`: rimossi i commenti legacy 78/72 e documentata la progressione corrente a 65 HUMAN.
- `scripts/test-function-reservations-65-human.js`: nuovo test forense della geometria delle 5 prenotazioni e del calcolo 65.
- `scripts/run-forensic-tests.js`: inclusa la nuova suite.
