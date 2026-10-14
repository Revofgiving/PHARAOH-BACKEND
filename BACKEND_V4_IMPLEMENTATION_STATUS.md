# BACKEND V4 IMPLEMENTATION STATUS — DEPLOYABLE

Current release state: **DEPLOYABLE SOURCE PACKAGE**.

- Registry ABI: 4.0.0
- Contract ID: PHARAOH_TREASURY_REGISTRY_V4
- Migration plan: 28, historical SQL preserved
- No migration 0029
- Release gate: fail-closed ALLOW for certified state, no env override
- Docker build: static preflight required
- Container startup: production + read-only integration preflights before DB migration
- ROG code not modified by this release
- PHARAOH economic/runtime logic not altered by the release-gate correction

Production activation still requires ISA's real environment variables, Registry V4 address/roles, PostgreSQL backup/snapshot and passing live read-only preflights.
