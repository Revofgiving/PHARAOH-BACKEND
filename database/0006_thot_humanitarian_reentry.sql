-- PHARAOH migration 0006
-- Decisione recuperata 4 settembre 2026 (lavoro del 3 settembre):
-- uscita THOT di account SECONDARIO (PERPETUO/GEMELLO), 15.000 USDC:
--   10.000 USDC -> ingresso L5 ISIDE (invariato)
--      500 USDC -> Cassa PHARAOH, riserva PROGETTI_UMANITARI
--      500 USDC -> 5 rientri reali ENTRATA x 100, intestati al ricevente THOT
--    4.000 USDC -> netto ricevente (invariato)
-- I precedenti 10 doni/crediti THOT non vengono piu creati.
-- Questa migration NON modifica retroattivamente lo storico THOT esistente.

CREATE TABLE IF NOT EXISTS thot_exit_allocations (
  thot_event_key TEXT PRIMARY KEY,
  beneficiary_wallet TEXT NOT NULL,
  cassa_wallet TEXT NOT NULL,
  turno BIGINT NOT NULL CHECK (turno >= 1),

  protocol_version TEXT NOT NULL
    DEFAULT 'THOT_500_HUMANITARIAN_500_REENTRY_V1'
    CHECK (protocol_version = 'THOT_500_HUMANITARIAN_500_REENTRY_V1'),

  humanitarian_reserved_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 500 CHECK (humanitarian_reserved_usdc = 500),
  humanitarian_destination TEXT NOT NULL
    DEFAULT 'PROGETTI_UMANITARI'
    CHECK (humanitarian_destination = 'PROGETTI_UMANITARI'),

  reentry_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 500 CHECK (reentry_usdc = 500),
  reentry_unit_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 100 CHECK (reentry_unit_usdc = 100),
  reentry_positions_expected INTEGER NOT NULL
    DEFAULT 5 CHECK (reentry_positions_expected = 5),
  reentry_positions_created INTEGER NOT NULL
    DEFAULT 0 CHECK (reentry_positions_created BETWEEN 0 AND 5),
  position_result JSONB NOT NULL DEFAULT '[]'::jsonb,

  status TEXT NOT NULL DEFAULT 'ALLOCATED'
    CHECK (status IN ('ALLOCATED', 'MATERIALIZED')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  materialized_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_thot_allocations_total_reserved
    CHECK (humanitarian_reserved_usdc + reentry_usdc = 1000),
  CONSTRAINT chk_thot_allocations_reentry_math
    CHECK (reentry_usdc = reentry_unit_usdc * reentry_positions_expected),
  CONSTRAINT chk_thot_allocations_materialization_state
    CHECK (
      (status = 'ALLOCATED' AND reentry_positions_created = 0 AND materialized_at IS NULL)
      OR
      (status = 'MATERIALIZED'
        AND reentry_positions_created = reentry_positions_expected
        AND materialized_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_thot_exit_allocations_beneficiary
  ON thot_exit_allocations (LOWER(beneficiary_wallet));

CREATE INDEX IF NOT EXISTS idx_thot_exit_allocations_created_at
  ON thot_exit_allocations (created_at);
