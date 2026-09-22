-- PHARAOH migration 0009
-- Rimozione definitiva di Dono al Volo, lista 5.1 e campi legacy omaggi staff RHA.
-- Le migration storiche restano immutate per preservare i checksum applicati.

-- Nessuna lista di utenti "senza dono" deve restare operativa.
DELETE FROM contenitori
WHERE tipo = '5.1' OR UPPER(COALESCE(provenienza, '')) = 'DICHIARAZIONE_SENZA_DONO';

DROP INDEX IF EXISTS uq_contenitori_attesa_wallet;
ALTER TABLE contenitori DROP CONSTRAINT IF EXISTS chk_contenitori_tipo;
ALTER TABLE contenitori
  ADD CONSTRAINT chk_contenitori_tipo CHECK (tipo IN ('5','5.2'));

-- Il protocollo storico V1 resta classificabile tramite protocol_version e importi cross,
-- ma non conserva piu alcun campo/concetto di omaggio staff.
ALTER TABLE rha_exit_allocations
  DROP CONSTRAINT IF EXISTS chk_rha_exit_allocation_protocol;

ALTER TABLE rha_exit_allocations
  DROP COLUMN IF EXISTS staff_omaggi_reserved_usdc,
  DROP COLUMN IF EXISTS staff_omaggi_status;

ALTER TABLE rha_exit_allocations
  ADD CONSTRAINT chk_rha_exit_allocation_protocol CHECK (
    (protocol_version = 'RHA_200_ROG_100_URANUS_V1'
      AND rog_usdc = 200 AND uranus_usdc = 100)
    OR
    (protocol_version = 'RHA_300_ROG_200_URANUS_V2'
      AND rog_usdc = 300 AND uranus_usdc = 200)
  );
