#!/usr/bin/env bash
# Run the box suites (test/boxes: isolation, recovery; docs/agent-boxes.md §14) against a real
# stack: docker-compose.prod.yml under its own instance name (#209), with the box test image
# (fake CLIs: the `test` target of box/Dockerfile). Needs Docker with Compose and Node 22 with `npm ci` done.
#
#   scripts/test-boxes.sh                                  # both suites
#   scripts/test-boxes.sh test/boxes/isolation.box.test.ts
#
# With gVisor (runsc) on the engine the boxes run under it; without it (Docker Desktop) they
# run under runc with AGORA_BOX_INSECURE_DEV=1 and the kernel check is skipped.
#
# The stack is named agora-boxtest: it never touches another install's containers, networks
# or volumes, and it is removed at the end (BOXTEST_KEEP=1 keeps it for debugging).
# BOXTEST_ALLOW_DAEMON_RESTART=1 adds the reboot test, which restarts the Docker daemon: only
# on a machine that runs nothing else (CI).
set -euo pipefail
cd "$(dirname "$0")/.."

INSTANCE=agora-boxtest
ENV_FILE=.env.boxtest
export BOXTEST_INSTANCE="$INSTANCE"
export BOXTEST_COMPOSE="docker compose -p $INSTANCE -f docker-compose.prod.yml --env-file $ENV_FILE"
export BOXTEST_API="http://127.0.0.1:${BOXTEST_API_PORT:-13000}"
DC=(docker compose -p "$INSTANCE" -f docker-compose.prod.yml --env-file "$ENV_FILE")
# The box image's build label (boxd rebuilds boxes on an older build)
export AGORA_BOX_BUILD="${AGORA_BOX_BUILD:-$(sh scripts/box-build-id.sh)}"

if docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
    export BOXTEST_RUNTIME=runsc; INSECURE=
else
    export BOXTEST_RUNTIME=runc; INSECURE=1
    echo "==> no gVisor on this engine: boxes run under runc (AGORA_BOX_INSECURE_DEV=1)"
fi

hex() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
# The socket proxies need the group that owns the Docker socket on the engine's side (on Docker
# Desktop that isn't the host's docker group), so ask the engine
gid=$(MSYS_NO_PATHCONV=1 docker run --rm -v /var/run/docker.sock:/s:ro alpine:3 stat -c %g /s 2>/dev/null || getent group docker 2>/dev/null | cut -d: -f3 || true)
cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=$INSTANCE
AGORA_INSTANCE=$INSTANCE
AGORA_HTTP_PORT=${BOXTEST_HTTP_PORT:-18080}
AGORA_HTTPS_PORT=${BOXTEST_HTTPS_PORT:-18443}
AGORA_API_PORT=${BOXTEST_API_PORT:-13000}
CORS_ORIGIN=https://localhost:${BOXTEST_HTTPS_PORT:-18443}
DB_PASSWORD=$(hex)
JWT_SECRET=$(hex)
AGORA_ENCRYPTION_KEY=$(hex)
AGORA_EDGE_SECRET=$(hex)
DOCKER_GID=${gid:-999}
AGORA_BOX_VERSION=$(tr -d "[:space:]" < box/VERSION)
AGORA_BOX_TAG_SUFFIX=-test
AGORA_BOX_INSECURE_DEV=$INSECURE
AGORA_BOX_SUBNETS=${BOXTEST_SUBNETS:-10.214.0.0/20}
DOMAIN=
EOF

remove_stack() {
    # Boxes are boxd's, not compose's: remove them by their instance label
    docker ps -aq --filter "label=org.agora.instance=$INSTANCE" | xargs -r docker rm -f >/dev/null 2>&1 || true
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    docker network ls -q --filter "label=org.agora.instance=$INSTANCE" | xargs -r docker network rm >/dev/null 2>&1 || true
    docker volume ls -q --filter "label=org.agora.instance=$INSTANCE" | xargs -r docker volume rm >/dev/null 2>&1 || true
}
cleanup() {
    if [ "${BOXTEST_KEEP:-}" = 1 ]; then echo "==> BOXTEST_KEEP=1: leaving $INSTANCE up"; return; fi
    echo "==> removing $INSTANCE"
    remove_stack
    rm -f "$ENV_FILE"
}
# A stack left by an earlier BOXTEST_KEEP=1 run goes first
remove_stack
trap cleanup EXIT

echo "==> images"
BOX_VERSION=$(tr -d "[:space:]" < box/VERSION)
docker build -q -f box/Dockerfile --target test --build-arg BOX_VERSION="$BOX_VERSION" --build-arg BOX_BUILD="$AGORA_BOX_BUILD" -t "agora/box:$BOX_VERSION-test" . >/dev/null
"${DC[@]}" build -q api migrate files-perms boxd box-edge

echo "==> stack $INSTANCE ($BOXTEST_RUNTIME)"
"${DC[@]}" up -d --no-build postgres redis migrate files-perms box-image api box-socket-proxy box-edge
"${DC[@]}" up -d --no-build --no-deps boxd
for _ in $(seq 1 90); do
    curl -fsS "$BOXTEST_API/health" >/dev/null 2>&1 && break
    sleep 2
done
curl -fsS "$BOXTEST_API/health" >/dev/null

echo "==> box suites"
status=0
npx vitest run --config vitest.box.config.ts "$@" || status=$?
if [ "$status" != 0 ]; then
    # A suite that times out waiting for a box says nothing about why: show what the stack said
    echo "==> the suites failed; the stack's last log lines"
    docker ps -a --filter "label=org.agora.instance=$INSTANCE" --format '{{.Names}} {{.Status}}' || true
    for service in boxd box-edge api; do
        echo "--- $service"
        "${DC[@]}" logs --no-color --tail 80 "$service" 2>&1 | cut -c1-300 || true
    done
    # The boxes' own agora-host output: a box that never checks in says why here
    for box in $(docker ps -aq --filter "label=org.agora.instance=$INSTANCE" --filter "label=org.agora.box"); do
        echo "--- box $(docker inspect -f '{{.Name}} {{.State.Status}} restarts={{.RestartCount}}' "$box")"
        docker logs --tail 25 "$box" 2>&1 | cut -c1-300 || true
    done
fi
exit "$status"
