-- PHARAOH migration 0005
-- Decisione 3 settembre 2026: ad OGNI uscita RHA (primari e secondari),
-- l'intera quota da 500 USDC dei 3.000 trattenuti viene destinata a:
--   300 USDC -> ROG = 150 dual HUMAN + PILETTA, beneficiario = ricevente RHA
--   200 USDC -> URANUS = 10 dual CASSA URANUS + HUMAN, beneficiario = ricevente RHA
-- Nessuna quota omaggi fa parte della nuova allocazione V2.
-- Le eventuali operazioni V1 gia persistite restano storiche e processabili senza riscrivere importi/tx.

ALTER TABLE rha_exit_allocations
  ADD COLUMN IF NOT EXISTS protocol_version TEXT;

UPDATE rha_exit_allocations
SET protocol_version = CASE
  WHEN staff_omaggi_reserved_usdc = 200 AND rog_usdc = 200 AND uranus_usdc = 100
    THEN 'RHA_200_ROG_100_URANUS_V1'
  WHEN staff_omaggi_reserved_usdc = 0 AND rog_usdc = 300 AND uranus_usdc = 200
    THEN 'RHA_300_ROG_200_URANUS_V2'
  ELSE protocol_version
END
WHERE protocol_version IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rha_exit_allocations WHERE protocol_version IS NULL) THEN
    RAISE EXCEPTION 'rha_exit_allocations contiene righe non classificabili: migrazione 0005 interrotta';
  END IF;
END $$;

ALTER TABLE rha_exit_allocations
  DROP CONSTRAINT IF EXISTS rha_exit_allocations_staff_omaggi_reserved_usdc_check,
  DROP CONSTRAINT IF EXISTS rha_exit_allocations_rog_usdc_check,
  DROP CONSTRAINT IF EXISTS rha_exit_allocations_uranus_usdc_check,
  ALTER COLUMN staff_omaggi_reserved_usdc SET DEFAULT 0,
  ALTER COLUMN rog_usdc SET DEFAULT 300,
  ALTER COLUMN uranus_usdc SET DEFAULT 200,
  ALTER COLUMN protocol_version SET DEFAULT 'RHA_300_ROG_200_URANUS_V2',
  ALTER COLUMN protocol_version SET NOT NULL;

ALTER TABLE rha_exit_allocations
  DROP CONSTRAINT IF EXISTS chk_rha_exit_allocation_protocol;
ALTER TABLE rha_exit_allocations
  ADD CONSTRAINT chk_rha_exit_allocation_protocol CHECK (
    (protocol_version = 'RHA_200_ROG_100_URANUS_V1'
      AND staff_omaggi_reserved_usdc = 200 AND rog_usdc = 200 AND uranus_usdc = 100)
    OR
    (protocol_version = 'RHA_300_ROG_200_URANUS_V2'
      AND staff_omaggi_reserved_usdc = 0 AND rog_usdc = 300 AND uranus_usdc = 200)
  );

ALTER TABLE cross_outbound_operations
  ADD COLUMN IF NOT EXISTS protocol_version TEXT;

UPDATE cross_outbound_operations
SET protocol_version = CASE
  WHEN target_platform = 'ROG' AND amount_usdc = 200 AND positions_expected = 100
    THEN 'RHA_200_ROG_100_URANUS_V1'
  WHEN target_platform = 'URANUS' AND amount_usdc = 100 AND positions_expected = 5
    THEN 'RHA_200_ROG_100_URANUS_V1'
  WHEN target_platform = 'ROG' AND amount_usdc = 300 AND positions_expected = 150
    THEN 'RHA_300_ROG_200_URANUS_V2'
  WHEN target_platform = 'URANUS' AND amount_usdc = 200 AND positions_expected = 10
    THEN 'RHA_300_ROG_200_URANUS_V2'
  ELSE protocol_version
END
WHERE protocol_version IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cross_outbound_operations WHERE protocol_version IS NULL) THEN
    RAISE EXCEPTION 'cross_outbound_operations contiene righe non classificabili: migrazione 0005 interrotta';
  END IF;
END $$;

ALTER TABLE cross_outbound_operations
  DROP CONSTRAINT IF EXISTS chk_cross_outbound_protocol_spec,
  ALTER COLUMN protocol_version SET DEFAULT 'RHA_300_ROG_200_URANUS_V2',
  ALTER COLUMN protocol_version SET NOT NULL;

ALTER TABLE cross_outbound_operations
  ADD CONSTRAINT chk_cross_outbound_protocol_spec CHECK (
    (protocol_version = 'RHA_200_ROG_100_URANUS_V1' AND (
      (target_platform = 'ROG' AND amount_usdc = 200 AND positions_expected = 100) OR
      (target_platform = 'URANUS' AND amount_usdc = 100 AND positions_expected = 5)
    ))
    OR
    (protocol_version = 'RHA_300_ROG_200_URANUS_V2' AND (
      (target_platform = 'ROG' AND amount_usdc = 300 AND positions_expected = 150) OR
      (target_platform = 'URANUS' AND amount_usdc = 200 AND positions_expected = 10)
    ))
  );
