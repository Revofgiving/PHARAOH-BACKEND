PHARAOH backend patch 15 settembre 2026
Applicare questi file sopra il clone pulito del repository, preservando le directory.
Prima del commit eseguire: npm ci, npm test (se disponibile), node scripts/test-direct-gift-static.js, node scripts/test-migration-compat.js, node ops/deploy-preflight.js static.
Non contiene node_modules, .env, chiavi o segreti.
