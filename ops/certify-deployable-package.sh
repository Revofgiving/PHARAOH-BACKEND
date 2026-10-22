#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

echo '=== PHARAOH V4 DEPLOYABLE PACKAGE CERTIFICATION ==='
node -v
npm -v

echo '--- release gate ---'
node ops/v4-release-gate.js

echo '--- static preflight ---'
node ops/deploy-preflight.js static

echo '--- clean dependencies ---'
npm ci --ignore-scripts --no-audit --no-fund

echo '--- full forensic suite ---'
npm test

echo '--- Docker build path ---'
if ! command -v docker >/dev/null 2>&1; then
  echo 'DOCKER_NOT_FOUND' >&2
  exit 20
fi
docker version >/dev/null
docker build --progress=plain -t pharaoh-backend-v4-release-check .

echo 'PHARAOH_BACKEND_V4_DEPLOYABLE_CERTIFICATION=PASS'
echo 'DEPLOY_EXECUTED=NO'
