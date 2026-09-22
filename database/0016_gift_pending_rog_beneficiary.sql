BEGIN;

ALTER TABLE gift_sessions
  ALTER COLUMN beneficiary_wallet DROP NOT NULL;

COMMIT;
