-- PHARAOH migration 0008
-- Rimozione definitiva del sistema Doni a Credito dal modello operativo.
-- Le migration storiche 0001/0004 restano immutate per evitare checksum drift.

-- Elimina soltanto record appartenenti al meccanismo credito ormai dismesso.
DELETE FROM contenitori
WHERE tipo = '5.3' OR UPPER(COALESCE(provenienza, '')) = 'CREDITO';

-- Fail-safe: neutralizza eventuali FK nullable verso funzioni legacy CREDITO
-- prima della cancellazione. Nel modello corrente queste righe non dovrebbero
-- esistere, ma la migration resta applicabile anche a database con storico sporco.
UPDATE prenotazioni_funzioni
SET funzione_id = NULL
WHERE funzione_id IN (SELECT id FROM funzioni WHERE tipo = 'CREDITO');

DELETE FROM funzioni WHERE tipo = 'CREDITO';
DELETE FROM donazioni WHERE tipo = 'CREDITO';

DROP INDEX IF EXISTS uq_contenitori_credito;
ALTER TABLE contenitori DROP COLUMN IF EXISTS credito_id;
DROP TABLE IF EXISTS doni_credito;

-- 5.3 non esiste piu; 5.1 resta temporaneamente fino alla migration 0009.
ALTER TABLE contenitori DROP CONSTRAINT IF EXISTS chk_contenitori_tipo;
ALTER TABLE contenitori
  ADD CONSTRAINT chk_contenitori_tipo CHECK (tipo IN ('5','5.1','5.2'));

-- I tipi CREDITO non sono piu validi nel runtime.
ALTER TABLE funzioni DROP CONSTRAINT IF EXISTS funzioni_tipo_check;
ALTER TABLE funzioni DROP CONSTRAINT IF EXISTS chk_funzioni_tipo_no_credit;
ALTER TABLE funzioni
  ADD CONSTRAINT chk_funzioni_tipo_no_credit
  CHECK (tipo IN ('PERPETUO','GEMELLO','SIMBIONTE'));

ALTER TABLE donazioni DROP CONSTRAINT IF EXISTS donazioni_tipo_check;
ALTER TABLE donazioni DROP CONSTRAINT IF EXISTS chk_donazioni_tipo_no_credit;
ALTER TABLE donazioni
  ADD CONSTRAINT chk_donazioni_tipo_no_credit
  CHECK (tipo IN ('DONO','FUNZIONE'));
