# PHARAOH - FIX MIGRATION 0022 SDOPPIAMENTO TAVOLA

Data: 1 ottobre 2026

## Problema verificato sul database live
La migration `0022_cassa_posizione_completa.sql` identificava le tavole personali ENTRATA aperte tramite il solo `t.faraone_account_id = p.account_id`. Nel database live uno stesso account puo possedere piu posizioni ENTRATA e quindi piu tavole personali. Questo rendeva il join ambiguo e poteva assegnare lo stesso numero finale a tavole diverse, facendo scattare `uq_tavole_sezione_numero`.

Caso live comunicato e verificato: `account_id = 8`, posizione 6 -> `sdoppiamento_tavola_id = 7`, posizione 25 -> `sdoppiamento_tavola_id = 23`.

## Correzione
La tavola personale viene ora identificata esclusivamente dalla relazione univoca gia presente nel modello:

`p.sdoppiamento_tavola_id = t.id`

La stessa relazione e usata sia nel controllo fail-closed sia nella rinumerazione delle tavole personali aperte.

## Cosa NON e stato fatto
- non e stato rimosso o indebolito `uq_tavole_sezione_numero`;
- non sono stati corretti manualmente dati live;
- non e stata aggiunta una migration successiva per nascondere il problema;
- non sono state modificate altre regole PHARAOH.

Poiche il deploy fallito e andato in rollback e 0022 non risulta applicata, la migration originale e stata corretta prima della sua applicazione.
