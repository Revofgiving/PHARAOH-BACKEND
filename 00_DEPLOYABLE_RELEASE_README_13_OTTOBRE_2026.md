# PHARAOH BACKEND V4 — DEPLOYABLE RELEASE

Release: `PHARAOH_BACKEND_11_OTTOBRE_2026_REGISTRY_V4_PROJECTS_DEPLOYABLE_FINAL`

This package supersedes the earlier 11 October package whose release gate still deliberately denied deployment.

## What was corrected

- `ops/v4-release-gate.js` is now fail-closed but ALLOWS only this certified V4 release state.
- No environment variable can override the release decision.
- `release-state.json` is V4 (`4.0.0`) and marked deployable.
- Docker build runs the release gate plus static deploy preflight.
- Container startup runs: release gate -> production preflight -> read-only integration preflight -> idempotent DB migrations -> API server.
- Existing PostgreSQL data must be preserved; no reset is part of this release.

## Deployment order

1. Deploy/verify PharaohRegistry V4.
2. Configure Coolify production environment variables.
3. Confirm a current PostgreSQL backup/snapshot exists.
4. Build this Docker package.
5. Startup preflights must pass before migrations/API startup.

## Important scope

`deployable` means the source/package is no longer intentionally blocked and contains fail-closed deployment checks. Live environment correctness is still verified at deployment time by the packaged preflights. No production deploy or real USDC transfer was executed during package preparation.
