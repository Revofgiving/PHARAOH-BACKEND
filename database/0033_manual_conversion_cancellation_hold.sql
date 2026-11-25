-- Phase 5: conservative cancellation request. Never release allocations without
-- independent reconciliation of external USDC movements and POL receipts.
ALTER TABLE pharaoh_gas_conversions DROP CONSTRAINT IF EXISTS pharaoh_gas_conversions_status_check;
ALTER TABLE pharaoh_gas_conversions ADD CONSTRAINT pharaoh_gas_conversions_status_check
 CHECK(status IN ('PREPARATA','DA_RICONCILIARE','ANNULLAMENTO_RICHIESTO','VERIFICATA'));
ALTER TABLE pharaoh_gas_conversion_events DROP CONSTRAINT IF EXISTS pharaoh_gas_conversion_events_event_type_check;
ALTER TABLE pharaoh_gas_conversion_events ADD CONSTRAINT pharaoh_gas_conversion_events_event_type_check
 CHECK(event_type IN ('PREPARATA','DA_RICONCILIARE','ANNULLAMENTO_RICHIESTO','VERIFICATA'));
-- No destructive edits to prior migrations, events, allocations, or payout history.
