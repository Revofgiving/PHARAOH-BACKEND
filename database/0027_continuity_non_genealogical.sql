-- Forward-only schema change. No historical account, wallet, position or history
-- row is rewritten. The only nullable-wallet role is non-genealogical CONTINUITY.
ALTER TABLE posizioni DROP CONSTRAINT IF EXISTS chk_posizioni_tipo;
ALTER TABLE posizioni DROP CONSTRAINT IF EXISTS posizioni_tipo_check;
ALTER TABLE posizioni ADD CONSTRAINT chk_posizioni_tipo CHECK(tipo IN
 ('DONATORE','EREDE','FARAONE','SIMBIONTE','PERPETUO','GEMELLO','PROGREDITO','CASSA','CONTINUITA_RHA'));
ALTER TABLE posizioni ALTER COLUMN wallet DROP NOT NULL;
ALTER TABLE posizioni ADD CONSTRAINT chk_continuity_has_no_identity CHECK(
 (tipo='CONTINUITA_RHA' AND wallet IS NULL AND account_id IS NULL AND account_sigla IS NULL
  AND numero_posizionale IS NULL AND sdoppiamento_tavola_id IS NULL AND dono_importo=500 AND casella=2)
 OR (tipo<>'CONTINUITA_RHA' AND wallet IS NOT NULL));
ALTER TABLE prenotazioni_funzioni DROP CONSTRAINT IF EXISTS prenotazioni_funzioni_tipo_funzione_check;
ALTER TABLE prenotazioni_funzioni ADD CONSTRAINT prenotazioni_funzioni_tipo_funzione_check
 CHECK(tipo_funzione IN ('SIMBIONTE','PERPETUO','GEMELLO','CONTINUITA_RHA'));
ALTER TABLE prenotazioni_funzioni ADD CONSTRAINT chk_continuity_reservation CHECK(
 tipo_funzione<>'CONTINUITA_RHA' OR
 (funzione_id IS NULL AND account_destinazione_id IS NULL AND account_destinazione_wallet IS NULL
  AND numero_posizionale IS NULL AND livello_destinazione=3 AND tavola_relativa=7 AND casella=2));
