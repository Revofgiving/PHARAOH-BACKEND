#!/bin/sh
# Run on an ISOLATED TEST HOST, not in the production application container.
# No production DATABASE_URL, volume, .env or signing key is imported.
set -eu
umask 077
if [ "${PHARAOH_QA_HOST_ACK:-}" != "ISOLATED_TEST_HOST" ]; then
  echo "Set PHARAOH_QA_HOST_ACK=ISOLATED_TEST_HOST on a separate test host." >&2
  exit 2
fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v docker >/dev/null 2>&1 || { echo "QA_BLOCKED_DOCKER_UNAVAILABLE" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "QA_BLOCKED_NODE_UNAVAILABLE" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "QA_BLOCKED_OPENSSL_UNAVAILABLE" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "QA_BLOCKED_DOCKER_DAEMON_UNAVAILABLE" >&2; exit 2; }
ID=$(openssl rand -hex 12)
NETWORK="pharaoh-qa-$ID"
PG_CONTAINER="pharaoh-qa-pg-$ID"
QA_CONTAINER="pharaoh-qa-node-$ID"
DB="pharaoh_test_$ID"
PASS=$(openssl rand -hex 24)
NODE_IMAGE=${PHARAOH_QA_NODE_IMAGE:-node:22-bookworm-slim}
PG_IMAGE=${PHARAOH_QA_PG_IMAGE:-postgres:16-bookworm}
OUT=${PHARAOH_QA_OUTPUT:-"$(pwd)/PHARAOH_QA_$ID"}
[ ! -e "$OUT" ] || { echo "QA_OUTPUT_MUST_BE_NEW" >&2; exit 2; }
mkdir -m 700 "$OUT"
OUT=$(CDPATH= cd -- "$OUT" && pwd)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/pharaoh-qa.XXXXXXXX")
NET_CREATED=0
PG_CREATED=0
cleanup() {
  docker rm -f "$QA_CONTAINER" >/dev/null 2>&1 || true
  if [ "$PG_CREATED" = 1 ]; then docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ "$NET_CREATED" = 1 ]; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
node "$ROOT/ops/prepare-isolated-qa.js" "$STAGE/work" > "$OUT/source-copy.log"
cp "$STAGE/work/QA_INPUT_MANIFEST.json" "$OUT/QA_INPUT_MANIFEST.json"
docker pull "$NODE_IMAGE" > "$OUT/node-image-pull.log" 2>&1
docker pull "$PG_IMAGE" > "$OUT/postgres-image-pull.log" 2>&1
docker image inspect "$NODE_IMAGE" "$PG_IMAGE" --format '{{.Id}} {{json .RepoDigests}}' > "$OUT/image-digests.txt"
# Dependency installation is the only phase with external network access.
# Lifecycle scripts are disabled. No app, RPC, receiver or database is started.
docker run --rm --name "$QA_CONTAINER" --user "$(id -u):$(id -g)" \
  -v "$STAGE/work:/work" -w /work -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
  "$NODE_IMAGE" sh -c 'npm --version; node --version; npm ci --ignore-scripts --no-audit --no-fund' \
  > "$OUT/npm-ci.log" 2>&1
# The actual tests have ONLY an internal network. No published ports or host DB.
docker network create --internal "$NETWORK" > "$OUT/network-created.log"
NET_CREATED=1
docker run -d --name "$PG_CONTAINER" --network "$NETWORK" --network-alias postgres \
  --tmpfs /var/lib/postgresql/data \
  -e "POSTGRES_USER=qa" -e "POSTGRES_PASSWORD=$PASS" -e "POSTGRES_DB=$DB" \
  "$PG_IMAGE" > "$OUT/postgres-container-created.log"
PG_CREATED=1
READY=0
for n in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U qa -d "$DB" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" = 1 ] || { docker logs "$PG_CONTAINER" > "$OUT/postgres-startup.log" 2>&1; echo "QA_POSTGRES_NOT_READY" >&2; exit 1; }
set +e
docker run --rm --name "$QA_CONTAINER" --network "$NETWORK" --user "$(id -u):$(id -g)" \
  -v "$STAGE/work:/work" -v "$OUT:/evidence" -w /work -e NODE_ENV=test -e DATABASE_URL= \
  -e PHARAOH_QA_ACK=ISOLATED_NO_PRODUCTION \
  -e PHARAOH_DISPOSABLE_PG_ACK=DISPOSABLE_EMPTY_DATABASE \
  -e "PHARAOH_TEST_DATABASE_URL=postgres://qa:$PASS@postgres:5432/$DB" \
  "$NODE_IMAGE" node ops/run-isolated-qa-inner.js > "$OUT/runner.log" 2>&1
RC=$?
set -e
docker logs "$PG_CONTAINER" > "$OUT/postgres-server.log" 2>&1
printf '%s\n' "$RC" > "$OUT/runner.exit"
printf 'QA evidence: %s\nThis does NOT authorize production deployment.\n' "$OUT"
exit "$RC"
