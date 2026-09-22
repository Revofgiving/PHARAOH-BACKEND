-- 0019_direct_rog_position_mandatory
-- Una nuova posizione PHARAOH DIRECT richiede una nuova posizione HUMAN ROG.
-- La stessa posizione ROG non puo essere riutilizzata da due sessioni PHARAOH.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM direct_donation_sessions
     WHERE rog_human_position IS NOT NULL
     GROUP BY rog_human_position
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION '0019_DIRECT_ROG_POSITION_RECONCILIATION_REQUIRED: rog_human_position duplicata tra sessioni DIRECT';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sessions_rog_human_position
  ON direct_donation_sessions (rog_human_position)
  WHERE rog_human_position IS NOT NULL;
