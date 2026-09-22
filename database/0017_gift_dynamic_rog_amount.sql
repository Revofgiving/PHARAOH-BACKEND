BEGIN;

ALTER TABLE gift_sessions
  DROP CONSTRAINT IF EXISTS gift_sessions_rog_amount_usdc_check;

ALTER TABLE gift_sessions
  ALTER COLUMN rog_amount_usdc DROP DEFAULT,
  ALTER COLUMN rog_amount_usdc DROP NOT NULL;

ALTER TABLE gift_sessions
  ADD CONSTRAINT gift_sessions_rog_amount_usdc_check
  CHECK (
    rog_amount_usdc IS NULL OR (
      rog_amount_usdc >= 2
      AND rog_amount_usdc = TRUNC(rog_amount_usdc)
      AND MOD(rog_amount_usdc, 2) = 0
    )
  );

COMMIT;
