#!/usr/bin/env bash
# Run the sandbox test suite (test/sandbox, including the negative security suite of
# sandbox-isolation-spec §14, WBS 3.9) against real gVisor containers.
#
# For a Linux Docker engine with runsc registered; a WSL2 distro with its own Docker
# Engine works. The host needs only Docker: the tests run in a Node container.
#
#   scripts/test-sandbox-gvisor.sh                              # the whole suite
#   scripts/test-sandbox-gvisor.sh test/sandbox/negative.sandbox.test.ts
#
# It starts its own Postgres, Redis, socket proxy and internal network, as an install named
# sbxtest (runs sbxtest-run-*, network sbxtest_sandbox, the proxy rules of
# docker-compose.prod.yml for that name), and removes them when it finishes.
#
# CAUTION: since #126 the suite's runner can't touch another install's runs, but its harness
# uses the host Docker CLI (probe containers, test proxies, networks). So it still refuses to
# run on an engine that hosts any Agora stack or runtime container, running or stopped. There
# is no override: run it on a dedicated engine.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTANCE=sbxtest
NET=${INSTANCE}_sandbox
PG=agora-sbxtest-postgres
REDIS=agora-sbxtest-redis
PROXY=agora-sbxtest-socket-proxy
RUNNER=agora-sbxtest-runner
IMAGE=agora/sandbox-deno:test
PG_PORT=15432
REDIS_PORT=16379
PROXY_PORT=12375

# Refuses unless this engine has gVisor and no Agora containers (no override).
source scripts/lib/engine-guard.sh

cleanup() {
    docker rm -f "$RUNNER" "$PG" "$REDIS" "$PROXY" agora-test-cap-forwarder agora-neg-target agora-neg-host-listener \
        agora-neg-other-run agora-pxa-test-socket-proxy agora-pxb-test-socket-proxy >/dev/null 2>&1 || true
    # Run containers of this suite's installs (sbxtest, and the proxy test's two)
    for i in "$INSTANCE" agora-pxa agora-pxb; do
        docker ps -aq --filter "label=agora.instance=$i" | xargs -r docker rm -f >/dev/null 2>&1 || true
    done
    docker network rm "$NET" agora-neg-other_sandbox >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "==> network, sandbox image, test services"
# As docker-compose.prod.yml creates it: internal, and the host has no address on it (spec §6.1)
docker network create --internal -o com.docker.network.bridge.inhibit_ipv4=true "$NET" >/dev/null
docker build -q -t "$IMAGE" sandbox >/dev/null
docker run -d --name "$PG" -e POSTGRES_USER=accord -e POSTGRES_PASSWORD=accord -e POSTGRES_DB=accord_test \
    -p "127.0.0.1:$PG_PORT:5432" postgres:16-alpine >/dev/null
docker run -d --name "$REDIS" -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine >/dev/null
# The restricted Docker API the runner uses in production: the rules of docker-compose.prod.yml
# for this install name, open to the test process on the host network
mapfile -t PROXY_ARGS < <(docker run --rm -v "$PWD":/src:ro -w /src node:22-bookworm \
    node scripts/lib/socket-proxy-rules.js "$INSTANCE" --allowfrom 0.0.0.0/0)
[ "${#PROXY_ARGS[@]}" -gt 3 ] || { echo "could not read the socket proxy rules from docker-compose.prod.yml" >&2; exit 1; }
docker run -d --name "$PROXY" --user 0:0 --read-only --cap-drop ALL --security-opt no-new-privileges \
    -v /var/run/docker.sock:/var/run/docker.sock:ro -p "127.0.0.1:$PROXY_PORT:2375" \
    wollomatic/socket-proxy:1.13.1 "${PROXY_ARGS[@]}" >/dev/null

for _ in $(seq 1 60); do
    docker exec "$PG" pg_isready -U accord -d accord_test >/dev/null 2>&1 && break
    sleep 1
done

echo "==> sandbox suite under runsc ($(docker info --format '{{.ServerVersion}}'), $(runsc --version 2>/dev/null | head -1 || echo 'runsc'))"
# Host networking: the tests reach the services above on 127.0.0.1, and the forwarder
# container reaches the tests' gateway server on the host. The Docker CLI and socket
# are for the test harness (forwarder, network probes); runs use the socket proxy.
docker run --rm --name "$RUNNER" --network host \
    -v "$PWD":/src:ro \
    -v agora-sbxtest-npm-cache:/root/.npm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$(command -v docker)":/usr/local/bin/docker:ro \
    -e DATABASE_URL="postgres://accord:accord@127.0.0.1:$PG_PORT/accord_test" \
    -e TEST_DATABASE_URL="postgres://accord:accord@127.0.0.1:$PG_PORT/accord_test" \
    -e REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
    -e AGORA_DOCKER_HOST="http://127.0.0.1:$PROXY_PORT" \
    -e AGORA_SANDBOX_IMAGE="$IMAGE" \
    -e AGORA_SANDBOX_NETWORK="$NET" \
    -e AGORA_INSTANCE="$INSTANCE" \
    -e SANDBOX_TEST_RUNTIME=runsc \
    -e STORAGE_DIR=/tmp/agora-test-files \
    node:22-bookworm bash -c '
        set -e
        mkdir /work && cd /src
        cp -r package.json package-lock.json tsconfig.json vitest.config.ts vitest.sandbox.config.ts docker-compose.prod.yml src test sandbox scripts /work/
        cd /work
        echo "==> npm ci"
        npm ci --no-audit --no-fund --loglevel=error >/dev/null
        npx vitest run --config vitest.sandbox.config.ts "$@"
    ' -- "$@"
