-- 0024 - Carta Regalo Smartbox: 102 USDC prepagati, attivazione Community entro 3 mesi,
-- fallback automatico al regalante alla scadenza.
ALTER TABLE gift_sessions ALTER COLUMN beneficiary_wallet DROP NOT NULL;
ALTER TABLE gift_sessions ALTER COLUMN rog_amount_usdc SET DEFAULT 2;

ALTER TABLE gift_sessions
  ADD COLUMN IF NOT EXISTS gift_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS gift_code_hint TEXT,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activation_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activation_source TEXT,
  ADD COLUMN IF NOT EXISTS fallback_assigned_at TIMESTAMPTZ;

-- Il beneficiario normale deve essere diverso dal regalante, ma dopo 3 mesi
-- il fallback intenzionale assegna HUMAN + posizione PHARAOH al regalante.
ALTER TABLE gift_sessions DROP CONSTRAINT IF EXISTS gift_distinct_wallets_check;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gift_activation_source_check') THEN
    ALTER TABLE gift_sessions ADD CONSTRAINT gift_activation_source_check
      CHECK (activation_source IS NULL OR activation_source IN ('BENEFICIARY','PURCHASER_FALLBACK'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_sessions_code_hash
  ON gift_sessions (gift_code_hash) WHERE gift_code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gift_sessions_activation_expiry
  ON gift_sessions (activation_expires_at)
  WHERE status = 'PAID_AWAITING_ACTIVATION' AND completed_at IS NULL;

ALTER TABLE gift_sessions DROP CONSTRAINT IF EXISTS gift_sessions_status_check;
ALTER TABLE gift_sessions ADD CONSTRAINT gift_sessions_status_check CHECK (
  status IN ('CREATED','ROG_PAYMENT_CONFIRMED','ROG_REGISTERED','ROG_COMPLETED',
             'PHARAOH_VERIFIED','PAID_AWAITING_ACTIVATION','ACTIVATING',
             'POSITION_ASSIGNED','CANCELLED')
);

-- Recovery sicuro di eventuali Smartbox gia completamente pagate dalla patch
-- precedente: i 3 mesi partono dalla verifica dei 100 USDC PHARAOH.
UPDATE gift_sessions
SET activation_expires_at = pharaoh_verified_at + INTERVAL '3 months'
WHERE status IN ('PHARAOH_VERIFIED','PAID_AWAITING_ACTIVATION','ACTIVATING')
  AND pharaoh_verified_at IS NOT NULL
  AND activation_expires_at IS NULL;
