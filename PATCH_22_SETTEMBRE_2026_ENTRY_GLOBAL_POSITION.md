# PATCH 22 SETTEMBRE 2026 — POSIZIONE GLOBALE ENTRATA

Regola confermata:

- ogni tavola ENTRATA contiene esattamente 6 posizioni fisiche;
- posizione globale = `(tavola_numero - 1) * 6 + casella`;
- Tavola 1 = 1-6, Tavola 2 = 7-12, Tavola 3 = 13-18, ecc.;
- dalla Tavola 2 il riporto Cassa PHARAOH occupa la prima casella lecita, normalmente casella 1;
- se una Funzione prenota la casella 1, la Cassa usa la successiva casella lecita;
- le prenotazioni Funzione consumano comunque il proprio valore posizionale fisico;
- `ticket_number` resta un identificatore interno e non viene piu esposto come `numero_posizionale`;
- l'Area Personale espone `numero_posizionale` derivato dalla posizione ENTRATA originaria dell'account, oltre a `entrata_tavola_numero`, `entrata_casella` e `ticket_number` separato.

La patch non richiede una nuova migration SQL: il valore globale e deterministico e viene derivato dalla struttura fisica gia persistita (`tavole.numero` + `posizioni.casella`).
