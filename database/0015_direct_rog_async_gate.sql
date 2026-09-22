-- 0015_direct_rog_async_gate
-- DIRECT PHARAOH: il SOLO gate economico ROG e' il Transfer di 2 USDC
-- confermato on-chain verso la Cassa ROG. Il fulfillment ROG (registerDonation,
-- RGx, HUMAN) prosegue in modo asincrono e non blocca i 100 USDC PHARAOH.

ALTER TABLE direct_donation_sessions
  DROP CONSTRAINT IF EXISTS direct_donation_sessions_status_check;

ALTER TABLE direct_donation_sessions
  ADD CONSTRAINT direct_donation_sessions_status_check
  CHECK (status IN (
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

ALTER TABLE direct_donation_sessions
  ADD COLUMN IF NOT EXISTS rog_payment_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rog_registration_candidate_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS rog_registration_candidate_donation_id TEXT,
  ADD COLUMN IF NOT EXISTS rog_registration_candidate_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rog_fulfillment_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
  ADD COLUMN IF NOT EXISTS rog_human_position BIGINT,
  ADD COLUMN IF NOT EXISTS rog_fulfillment_retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rog_fulfillment_last_error TEXT,
  ADD COLUMN IF NOT EXISTS rog_fulfillment_next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rog_fulfillment_updated_at TIMESTAMPTZ;

ALTER TABLE direct_donation_sessions
  DROP CONSTRAINT IF EXISTS direct_donation_sessions_rog_fulfillment_status_check;

ALTER TABLE direct_donation_sessions
  ADD CONSTRAINT direct_donation_sessions_rog_fulfillment_status_check
  CHECK (rog_fulfillment_status IN (
    'WAITING_PAYMENT',
    'WAITING_REGISTRATION',
    'REGISTERED',
    'PROCESSING',
    'RETRY',
    'COMPLETED'
  ));

-- Recovery forense delle sessioni storiche: una sessione ROG_CONFIRMING che
-- possiede gia' una prova USDC verificata deve poter proseguire verso PHARAOH.
UPDATE direct_donation_sessions
   SET status = 'ROG_PAYMENT_CONFIRMED',
       rog_payment_confirmed_at = COALESCE(rog_payment_confirmed_at, updated_at, NOW()),
       rog_fulfillment_status = CASE
         WHEN rog_confirmed_at IS NOT NULL OR rog_result IS NOT NULL THEN 'COMPLETED'
         WHEN rog_register_tx_hash IS NOT NULL AND rog_donation_id IS NOT NULL THEN 'REGISTERED'
         ELSE 'WAITING_REGISTRATION'
       END,
       rog_fulfillment_updated_at = COALESCE(rog_fulfillment_updated_at, updated_at, NOW()),
       rog_fulfillment_next_retry_at = CASE
         WHEN rog_register_tx_hash IS NOT NULL AND rog_donation_id IS NOT NULL
              AND rog_confirmed_at IS NULL AND rog_result IS NULL
         THEN NOW()
         ELSE rog_fulfillment_next_retry_at
       END
 WHERE status = 'ROG_CONFIRMING'
   AND rog_usdc_tx_hash IS NOT NULL
   AND rog_proof IS NOT NULL
   AND (rog_proof::jsonb ? 'usdc');

-- Backfill delle sessioni gia' avanzate/completate.
UPDATE direct_donation_sessions
   SET rog_payment_confirmed_at = COALESCE(rog_payment_confirmed_at, rog_confirmed_at, updated_at, NOW()),
       rog_fulfillment_status = CASE
         WHEN rog_confirmed_at IS NOT NULL OR rog_result IS NOT NULL THEN 'COMPLETED'
         WHEN rog_register_tx_hash IS NOT NULL AND rog_donation_id IS NOT NULL THEN 'REGISTERED'
         WHEN rog_usdc_tx_hash IS NOT NULL THEN 'WAITING_REGISTRATION'
         ELSE 'WAITING_PAYMENT'
       END,
       rog_fulfillment_updated_at = COALESCE(rog_fulfillment_updated_at, updated_at, NOW()),
       rog_fulfillment_next_retry_at = CASE
         WHEN rog_register_tx_hash IS NOT NULL AND rog_donation_id IS NOT NULL
              AND rog_confirmed_at IS NULL AND rog_result IS NULL
         THEN NOW()
         ELSE rog_fulfillment_next_retry_at
       END
 WHERE status IN ('ROG_CONFIRMED','PHARAOH_VERIFIED','REGISTRY_SUBMITTED','REGISTRY_CONFIRMED','POSITION_ASSIGNED')
    OR rog_usdc_tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_direct_sessions_rog_fulfillment
  ON direct_donation_sessions (rog_fulfillment_status, rog_fulfillment_next_retry_at);

CREATE INDEX IF NOT EXISTS idx_direct_sessions_rog_human_position
  ON direct_donation_sessions (rog_human_position)
  WHERE rog_human_position IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sessions_rog_registration_candidate_tx_lower
  ON direct_donation_sessions ((LOWER(rog_registration_candidate_tx_hash)))
  WHERE rog_registration_candidate_tx_hash IS NOT NULL;
