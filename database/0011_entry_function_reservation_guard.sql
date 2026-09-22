-- PHARAOH 0011 - protezione ticket/caselle riservate alle Funzioni
-- Recovery 4 settembre 2026.
--
-- Scopo:
-- 1) impedire agli allocator ordinari/rientri di consumare ticket gia riservati;
-- 2) rendere efficiente il controllo delle caselle Entrata eventualmente riservate
--    a Funzioni future, cosi che donatori/rientri/riporto non le occupino.

CREATE INDEX IF NOT EXISTS idx_prenotazioni_funzioni_ticket_stato
  ON prenotazioni_funzioni(ticket_number, stato)
  WHERE ticket_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prenotazioni_funzioni_entry_slot
  ON prenotazioni_funzioni(
    turno_destinazione,
    livello_destinazione,
    tavola_numero,
    tavola_relativa,
    casella,
    stato
  );

CREATE INDEX IF NOT EXISTS idx_funzioni_ticket_prenotato_status
  ON funzioni(ticket_prenotato, status)
  WHERE ticket_prenotato IS NOT NULL;
