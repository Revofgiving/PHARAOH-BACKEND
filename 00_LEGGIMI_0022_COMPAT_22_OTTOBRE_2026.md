# PHARAOH BACKEND - CHECKPOINT 0022 (22 ottobre 2026)

**NON_DEPLOY**: sorgente completo del backend 21 ottobre con esclusiva compatibilita storica 0022 e test aggiornati.

Non fare deploy e non eseguire migrazioni su database live. Preserva wallet, posizioni, sessioni e dati. Eseguire `npm ci --ignore-scripts --no-audit --no-fund`, `env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test npm test`, `npm run deploy:preflight` e `npm run db:plan` in un ambiente isolato. Per la certificazione servono 53 test PASS senza blocchi e restore/rehearsal PostgreSQL su clone isolato con audit prima/dopo, in particolare per 0029/0030.

Differenze rispetto al sorgente 21 ottobre: database/migration-plan.json; scripts/test-migration-compat.js; scripts/test-v4-release-and-source.js. Nessun SQL o runtime di business modificato. Vedi `FORENSIC_0022_CHECKSUM_COMPAT_22_OTTOBRE_2026.md`.
