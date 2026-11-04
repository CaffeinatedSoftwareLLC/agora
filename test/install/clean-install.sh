#!/usr/bin/env bash
# Clean-install test (docs/agent-boxes.md §12.3). Runs the Linux installer non-interactively
# from this checkout on a machine with Docker and nothing of Agora, then checks the result:
#
#   1. /health answers 200
#   2. the admin can log in
#   3. the first box runs under runsc (docker inspect)
#   4. the box answers a mention (the test image's fake CLI posts "fake-claude reply")
#   5. install/doctor.sh exits 0
#
# Uses the box test image (box/Dockerfile target `test`, tag agora/box:<N>-test) and an API key
# profile with a dummy key, so no real login is needed.
#
#   bash test/install/clean-install.sh            # from the repo root; removes the install afterwards
#   KEEP=1 bash test/install/clean-install.sh     # leave it running
#
# CI: a job on a fresh ubuntu-latest runner (Docker preinstalled; the installer adds gVisor)
# runs exactly `bash test/install/clean-install.sh` from the checkout. Needs sudo without a
# password (GitHub runners have it) and free ports 18080, 18443 and 13000.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
WORK=$(mktemp -d)
INSTANCE=${INSTANCE:-agora}
API_PORT=13000 HTTP_PORT=18080 HTTPS_PORT=18443
API="http://127.0.0.1:$API_PORT"
DOCKER=(docker); docker info >/dev/null 2>&1 || DOCKER=(sudo docker)
compose() { "${DOCKER[@]}" compose -f docker-compose.prod.yml --env-file .env.prod "$@"; }

pass() { printf 'PASS  %s\n' "$*"; }
fail() {
    printf 'FAIL  %s\n' "$*" >&2
    if [ -f .env.prod ]; then
        compose ps -a >&2 || true
        for s in api boxd box-edge runner; do printf '\n--- %s ---\n' "$s" >&2; compose logs --no-color --tail 60 "$s" >&2 || true; done
        "${DOCKER[@]}" ps -a --filter "label=org.agora.instance=$INSTANCE" >&2 || true
        for c in $("${DOCKER[@]}" ps -aq --filter "label=org.agora.instance=$INSTANCE" --filter label=org.agora.box); do
            printf '\n--- box %s ---\n' "$c" >&2; "${DOCKER[@]}" logs --tail 60 "$c" >&2 || true
        done
    fi
    exit 1
}
cleanup() {
    rm -rf "$WORK"
    if [ "${KEEP:-0}" != 1 ] && [ -f .env.prod ]; then
        bash install/uninstall.sh --dir "$ROOT" --purge --confirm "$INSTANCE" --non-interactive >/dev/null 2>&1 || true
        rm -f .env.prod .agora-install .agora-url
    fi
}
trap cleanup EXIT

[ ! -f .env.prod ] || fail ".env.prod already exists in $ROOT; this test needs a clean checkout"
printf 'clean-install-%s\n' "$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" > "$WORK/pw"
printf 'fake-api-key-for-the-test-image\n' > "$WORK/key"

# ─── Install ───
bash install/linux/install.sh --non-interactive --source . --dir "$ROOT" --instance "$INSTANCE" \
    --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT" --api-port "$API_PORT" \
    --admin-user admin --admin-password-file "$WORK/pw" --agent claude --agent-api-key-file "$WORK/key" \
    --telemetry off --box-image-target test --min-disk-gb "${MIN_DISK_GB:-10}" \
    || fail "install.sh exited with $?"
pass 'installer finished'

# ─── 1. Health ───
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
[ "$code" = 200 ] || fail "/health answered $code"
pass '/health 200'

# ─── 2. Admin login ───
login=$(printf '{"login":"admin","password":"%s"}' "$(cat "$WORK/pw")" \
    | curl -sS -H 'Content-Type: application/json' --data-binary @- "$API/auth/login")
TOKEN=$(printf '%s' "$login" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || fail "admin login failed: $(printf '%s' "$login" | head -c 200)"
pass 'admin login'
auth=(-H "Authorization: Bearer $TOKEN")

# ─── 3. The box under gVisor ───
SERVER=$(curl -fsS "$API/instance/status" | sed -n 's/.*"instanceServerId":"\([^"]*\)".*/\1/p')
CHANNEL=$(curl -fsS "${auth[@]}" "$API/servers/$SERVER/channels" | tr '{' '\n' | grep '"name":"general"' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1)
BOX=$(curl -fsS "${auth[@]}" "$API/servers/$SERVER/boxes" | tr '{' '\n' | grep '"name":"claude"' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$BOX" ] || fail 'no box named claude'
CONTAINER="$INSTANCE-box-$(printf '%s' "$BOX" | tr 'A-Z' 'a-z')"
runtime=$("${DOCKER[@]}" inspect -f '{{.HostConfig.Runtime}}' "$CONTAINER" 2>/dev/null || true)
[ "$runtime" = runsc ] || fail "box container $CONTAINER runtime is '${runtime:-missing}', not runsc"
kernel=$("${DOCKER[@]}" exec "$CONTAINER" uname -r 2>/dev/null || true)
pass "box $CONTAINER under runsc (kernel ${kernel:-?})"

# ─── 4. The box answers a mention ───
# A mention wakes an agent that has a live session in the channel: start it, as the owner would
started=$(printf '{"command":"start","profile":"claude"}' \
    | curl -sS -o /dev/null -w '%{http_code}' "${auth[@]}" -H 'Content-Type: application/json' --data-binary @- "$API/channels/$CHANNEL/agent-commands")
[ "$started" = 201 ] || [ "$started" = 200 ] || fail "/start claude answered $started"
pass '/start claude'
since=$(date +%s)
printf '{"content":"@claude hello from the clean-install test"}' \
    | curl -fsS "${auth[@]}" -H 'Content-Type: application/json' --data-binary @- "$API/channels/$CHANNEL/messages" >/dev/null \
    || fail 'posting the mention failed'
answered=0
while [ $(( $(date +%s) - since )) -lt "${MENTION_TIMEOUT:-300}" ]; do
    if curl -fsS "${auth[@]}" "$API/channels/$CHANNEL/messages?limit=20" | tr '{' '\n' | grep '"authorUsername":"claude"' | grep -q 'fake-claude reply'; then
        answered=1; break
    fi
    sleep 5
done
[ "$answered" = 1 ] || fail "the box did not answer the mention within ${MENTION_TIMEOUT:-300} s"
pass "box answered the mention in $(( $(date +%s) - since )) s"

# ─── 5. The doctor ───
bash install/doctor.sh --dir "$ROOT" > "$WORK/doctor.txt" 2>&1 || { cat "$WORK/doctor.txt" >&2; fail 'install/doctor.sh exited non-zero'; }
grep -q 'result: every check passed' "$WORK/doctor.txt" || { cat "$WORK/doctor.txt" >&2; fail 'doctor did not pass'; }
! grep -Eq "$(cat "$WORK/pw")|fake-api-key" "$WORK/doctor.txt" || fail 'the doctor printed a secret'
pass 'doctor exit 0, no secrets in its output'

printf '\nclean install: all checks passed\n'
