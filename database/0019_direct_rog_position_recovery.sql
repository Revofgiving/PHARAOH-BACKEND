-- 0019_direct_rog_position_recovery
-- Compatibility marker for the historical production migration applied on 2026-09-21.
-- The persistent DIRECT ROG columns required by the recovery flow are already
-- created by 0015_direct_rog_async_gate. Runtime verification/recovery logic is
-- carried by the application code. This marker intentionally performs no DDL.
--
-- Existing production databases may contain the original historical checksum
-- 86a670e94f01a3ae2fbbd48156dc1ac36f73c520d48e22d79a46d49d62c12f1f;
-- migration-plan.json explicitly accepts that checksum without rewriting history.

DO $$
BEGIN
  NULL;
END $$;
