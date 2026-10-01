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
# It starts its own Postgres, Redis, socket proxy and internal network (all named
# agora-sbxtest-* / agora_sandbox_test) and removes them when it finishes.
#
# CAUTION: the suite removes every container named agora-run-* on this engine. If an
# Agora stack shares the engine, a code run in progress there is killed. The script
# stops if it sees one; set FORCE=1 to run anyway.
set -euo pipefail
cd "$(dirname "$0")/.."

NET=agora_sandbox_test
PG=agora-sbxtest-postgres
REDIS=agora-sbxtest-redis
PROXY=agora-sbxtest-socket-proxy
RUNNER=agora-sbxtest-runner
IMAGE=agora/sandbox-deno:test
PG_PORT=15432
REDIS_PORT=16379
PROXY_PORT=12375

if ! docker info --format '{{range $name, $_ := .Runtimes}}{{$name}} {{end}}' | grep -qw runsc; then
    echo "gVisor (runsc) is not registered with this Docker engine. See docs/getting-started.md." >&2
    exit 1
fi
if [ -n "$(docker ps -q --filter name=agora-run-)" ] && [ "${FORCE:-}" != "1" ]; then
    echo "A sandbox run (agora-run-*) is in progress on this engine and the suite would kill it." >&2
    echo "Wait for it to finish, or set FORCE=1." >&2
    exit 1
fi

cleanup() {
    docker rm -f "$RUNNER" "$PG" "$REDIS" "$PROXY" agora-test-cap-forwarder agora-neg-target >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "==> network, sandbox image, test services"
docker network create --internal "$NET" >/dev/null
docker build -q -t "$IMAGE" sandbox >/dev/null
docker run -d --name "$PG" -e POSTGRES_USER=accord -e POSTGRES_PASSWORD=accord -e POSTGRES_DB=accord_test \
    -p "127.0.0.1:$PG_PORT:5432" postgres:16-alpine >/dev/null
docker run -d --name "$REDIS" -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine >/dev/null
# The same restricted Docker API the runner uses in production (docker-compose.yml)
docker run -d --name "$PROXY" --user 0:0 --read-only --cap-drop ALL --security-opt no-new-privileges \
    -v /var/run/docker.sock:/var/run/docker.sock:ro -p "127.0.0.1:$PROXY_PORT:2375" \
    wollomatic/socket-proxy:1.13.1 \
    -loglevel=info -listenip=0.0.0.0 -allowfrom=0.0.0.0/0 \
    -allowbindmountfrom=/nonexistent-agora-no-bind-mounts \
    '-allowHEAD=(/v1\.[0-9]+)?/_ping' \
    '-allowGET=(/v1\.[0-9]+)?/(_ping|version|info|containers/json|containers/agora-run-[0-9a-z]{26}/(json|logs)|networks/agora_sandbox[a-z0-9_]*|images/.+/json)' \
    '-allowPOST=(/v1\.[0-9]+)?/containers/(create|agora-run-[0-9a-z]{26}/(start|wait|kill))' \
    '-allowDELETE=(/v1\.[0-9]+)?/containers/agora-run-[0-9a-z]{26}' >/dev/null

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
    -e SANDBOX_TEST_RUNTIME=runsc \
    -e STORAGE_DIR=/tmp/agora-test-files \
    node:22-bookworm bash -c '
        set -e
        mkdir /work && cd /src
        cp -r package.json package-lock.json tsconfig.json vitest.config.ts vitest.sandbox.config.ts src test sandbox /work/
        cd /work
        echo "==> npm ci"
        npm ci --no-audit --no-fund --loglevel=error >/dev/null
        npx vitest run --config vitest.sandbox.config.ts "$@"
    ' -- "$@"
