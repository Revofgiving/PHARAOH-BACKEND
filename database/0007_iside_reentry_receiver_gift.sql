-- PHARAOH migration 0007
-- Decisione recuperata 4 settembre 2026 (lavoro del 3 settembre):
-- uscita ISIDE di account SECONDARIO (PERPETUO/GEMELLO), 30.000 USDC:
--    5.000 USDC -> 50 rientri reali ENTRATA x 100, intestati al ricevente ISIDE
--   19.000 USDC -> netto base ricevente (invariato)
--    6.000 USDC -> dono aggiuntivo al ricevente ISIDE
--   25.000 USDC -> payout unico al ricevente (19.000 + 6.000)
-- I precedenti 110 doni/crediti ISIDE non vengono piu creati.
-- Questa migration NON modifica retroattivamente lo storico ISIDE esistente.

CREATE TABLE IF NOT EXISTS iside_exit_allocations (
  iside_event_key TEXT PRIMARY KEY,
  beneficiary_wallet TEXT NOT NULL,
  cassa_wallet TEXT NOT NULL,
  turno BIGINT NOT NULL CHECK (turno >= 1),

  protocol_version TEXT NOT NULL
    DEFAULT 'ISIDE_5000_REENTRY_6000_RECEIVER_GIFT_V1'
    CHECK (protocol_version = 'ISIDE_5000_REENTRY_6000_RECEIVER_GIFT_V1'),

  total_received_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 30000 CHECK (total_received_usdc = 30000),
  base_net_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 19000 CHECK (base_net_usdc = 19000),
  receiver_gift_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 6000 CHECK (receiver_gift_usdc = 6000),
  receiver_payout_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 25000 CHECK (receiver_payout_usdc = 25000),

  reentry_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 5000 CHECK (reentry_usdc = 5000),
  reentry_unit_usdc NUMERIC(12,2) NOT NULL
    DEFAULT 100 CHECK (reentry_unit_usdc = 100),
  reentry_positions_expected INTEGER NOT NULL
    DEFAULT 50 CHECK (reentry_positions_expected = 50),
  reentry_positions_created INTEGER NOT NULL
    DEFAULT 0 CHECK (reentry_positions_created BETWEEN 0 AND 50),
  position_result JSONB NOT NULL DEFAULT '[]'::jsonb,

  status TEXT NOT NULL DEFAULT 'ALLOCATED'
    CHECK (status IN ('ALLOCATED', 'MATERIALIZED')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  materialized_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_iside_allocation_total
    CHECK (reentry_usdc + receiver_payout_usdc = total_received_usdc),
  CONSTRAINT chk_iside_receiver_payout_breakdown
    CHECK (base_net_usdc + receiver_gift_usdc = receiver_payout_usdc),
  CONSTRAINT chk_iside_reentry_math
    CHECK (reentry_usdc = reentry_unit_usdc * reentry_positions_expected),
  CONSTRAINT chk_iside_materialization_state
    CHECK (
      (status = 'ALLOCATED' AND reentry_positions_created = 0 AND materialized_at IS NULL)
      OR
      (status = 'MATERIALIZED'
        AND reentry_positions_created = reentry_positions_expected
        AND materialized_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_iside_exit_allocations_beneficiary
  ON iside_exit_allocations (LOWER(beneficiary_wallet));

CREATE INDEX IF NOT EXISTS idx_iside_exit_allocations_created_at
  ON iside_exit_allocations (created_at);
