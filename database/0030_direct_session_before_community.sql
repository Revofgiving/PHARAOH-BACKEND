-- 0030_direct_session_before_community
-- Regola canonica DIRECT V5:
-- il ciclo nasce in PHARAOH e riceve un sessionRef PRIMA del controllo Community.
-- La sola apertura di SESSION_OPEN non autorizza ROG ne PHARAOH e non muove fondi.
-- Il requisito Community resta obbligatorio e viene verificato prima di accettare
-- la prova economica ROG; authorize/intent/reconcile continuano a verificarlo fail-closed.

ALTER TABLE direct_donation_sessions
  DROP CONSTRAINT IF EXISTS direct_donation_sessions_status_check;

ALTER TABLE direct_donation_sessions
  ALTER COLUMN status SET DEFAULT 'SESSION_OPEN';

ALTER TABLE direct_donation_sessions
  ADD CONSTRAINT direct_donation_sessions_status_check
  CHECK (status IN (
    'SESSION_OPEN',
    'COMMUNITY_CONFIRMED',
    'ROG_CONFIRMING',
    'ROG_PAYMENT_CONFIRMED',
    'ROG_CONFIRMED',
    'PHARAOH_VERIFIED',
    'REGISTRY_SUBMITTED',
    'REGISTRY_CONFIRMED',
    'POSITION_ASSIGNED',
    'CANCELLED'
  ));

COMMENT ON COLUMN direct_donation_sessions.status IS
  'DIRECT state. SESSION_OPEN = ciclo PHARAOH aperto prima della verifica Community; nessun diritto economico o pagamento autorizzato.';
