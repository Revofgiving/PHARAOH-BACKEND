# PHARAOH BACKEND V4 — COOLIFY DEPLOY

This package is structured with `Dockerfile` and `package.json` at repository root.

## Required order
1. Deploy and verify PharaohRegistry V4 first.
2. Put this backend source at repository root.
3. Configure all production variables from `.env.example` in Coolify; do not commit secrets.
4. Ensure a current PostgreSQL backup/snapshot exists.
5. Build/deploy through the Dockerfile.

## Fail-closed pipeline
During Docker build:
`node ops/v4-release-gate.js && node ops/deploy-preflight.js static`

At container startup:
`release gate -> production preflight -> read-only integration preflight -> db:migrate -> api-server`

If Registry V4 identity/version/parent/treasuries/BACKEND_ROLE, chain, URLs, environment or migration integrity are incoherent, startup stops before the API is activated.

The package contains no real private keys. No production deploy was executed while producing it.
