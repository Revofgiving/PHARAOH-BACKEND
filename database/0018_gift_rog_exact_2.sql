BEGIN;

-- Il percorso Carta Regalo PHARAOH e' economicamente fisso:
-- 2 USDC a ROG + 100 USDC a PHARAOH. Il beneficiario puo' essere
-- ancora NULL fino alla scelta/verifica su ROG, ma l'importo ROG non e' dinamico.
ALTER TABLE gift_sessions
  DROP CONSTRAINT IF EXISTS gift_sessions_rog_amount_usdc_check;

ALTER TABLE gift_sessions
  ADD CONSTRAINT gift_sessions_rog_amount_usdc_check
  CHECK (rog_amount_usdc IS NULL OR rog_amount_usdc = 2);

COMMIT;
