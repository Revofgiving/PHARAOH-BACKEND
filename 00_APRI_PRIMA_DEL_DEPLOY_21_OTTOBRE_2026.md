# PHARAOH BACKEND V6 — release candidate Coolify — 21 ottobre 2026

Fonte: PHARAOH V6, unica fonte di verita del checkpoint 21 ottobre.

## Gate gia chiusi
- PostgreSQL staging separato: restore produzione PASS.
- Snapshot pre-migration PASS.
- Migration 0029 + 0030 su staging PASS.
- Ledger migration: 30 record; ultima `0030_direct_session_before_community`.
- 44 tabelle post-migration; account 21, posizioni 25, tavole 26, direct sessions 49, gift sessions 3.
- `direct_pharaoh_tx_candidates`: 18 righe create dalla 0029, atteso.
- Dati applicativi preesistenti preservati; variazione `pharaoh_schema_migrations` 28 -> 30 attesa.
- Produzione non migrata. ROG backend non modificato.
- Test canonici V6 del checkpoint: 53/53 PASS, 0 fail, 0 blocked, 0 timeout.
- Release gate riallineato a 30 migration / 53 test e verificato localmente.

## Stato
PACCHETTO TECNICAMENTE PRONTO PER STAGING/COOLIFY, ma NON dichiarato deploy finale certificato finche non sono completati i gate runtime residui del checkpoint: concorrenza PostgreSQL reale, backend V6 staging avviato, E2E coordinato e preflight produzione/integration.

## Regola produzione
Non eseguire deploy o migration produzione senza autorizzazione esplicita dell'utente. Eseguire prima i preflight inclusi nel pacchetto.
