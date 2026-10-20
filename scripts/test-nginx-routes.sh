#!/usr/bin/env bash
# Runs agora-ui/nginx.conf in a real nginx against a stub API and checks the
# response headers that #127 depends on: the /admin page and API share URLs, so
# the Accept header picks the representation and both must send Vary: Accept.
#
# Needs Docker and the nginx:alpine image. Uses throwaway containers and a
# throwaway network named agora-nginx-test-<pid>; removes them on exit.
#   bash scripts/test-nginx-routes.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="agora-nginx-test-$$"
NET="$TAG"
API="$TAG-api"
WEB="$TAG-web"
PORT="${NGINX_TEST_PORT:-18089}"
TMPD="$(mktemp -d)"

# On Git Bash, docker.exe needs Windows host paths and untouched container paths.
dk() { MSYS_NO_PATHCONV=1 docker "$@"; }
hostpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

cleanup() {
    dk rm -f "$WEB" "$API" >/dev/null 2>&1 || true
    dk network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$TMPD"
}
trap cleanup EXIT

dk network create "$NET" >/dev/null

# Stub API: every path answers JSON, so a proxied response is recognisable.
dk create --name "$API" --network "$NET" --network-alias api nginx:alpine >/dev/null
cat > "$TMPD/api.conf" <<'EOF'
server {
    listen 3000;
    default_type application/json;
    location / { return 200 '{"stub":"api"}'; }
}
EOF
dk cp "$(hostpath "$TMPD/api.conf")" "$API:/etc/nginx/conf.d/default.conf" >/dev/null
dk start "$API" >/dev/null

dk create --name "$WEB" --network "$NET" -p "127.0.0.1:$PORT:80" nginx:alpine >/dev/null
dk cp "$(hostpath "$ROOT/agora-ui/nginx.conf")" "$WEB:/etc/nginx/conf.d/default.conf" >/dev/null
echo '<!doctype html><title>app shell</title>' > "$TMPD/index.html"
dk cp "$(hostpath "$TMPD/index.html")" "$WEB:/usr/share/nginx/html/index.html" >/dev/null
dk start "$WEB" >/dev/null

for _ in $(seq 1 50); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
    sleep 0.2
done

PASS=0
FAIL=0
HTML='text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

# check <name> <path> <accept> <expected content-type> <expect vary: yes|no>
check() {
    local name="$1" path="$2" accept="$3" want_type="$4" want_vary="$5"
    local headers type vary ok=1
    headers="$(curl -sS -D - -o /dev/null -H "Accept: $accept" "http://127.0.0.1:$PORT$path" | tr -d '\r')"
    type="$(printf '%s\n' "$headers" | grep -i '^content-type:' | head -1 | cut -d' ' -f2- || true)"
    vary="$(printf '%s\n' "$headers" | grep -i '^vary:' | cut -d' ' -f2- | tr '\n' ',' || true)"
    [[ "$type" == "$want_type"* ]] || ok=0
    if [[ "$want_vary" == yes ]]; then
        [[ "$vary" == *Accept* ]] || ok=0
    fi
    if (( ok )); then
        PASS=$((PASS + 1)); echo "PASS $name"
    else
        FAIL=$((FAIL + 1)); echo "FAIL $name: content-type='$type' vary='$vary'"
    fi
}

for p in /admin /admin/users /admin/storage /admin/pending /admin/settings /admin/provider-terms; do
    check "page $p is the app shell with Vary" "$p" "$HTML" text/html yes
done
for p in /admin/users /admin/storage; do
    check "fetch $p is API JSON with Vary" "$p" '*/*' application/json yes
done
check "fetch /admin/users with Accept: application/json" /admin/users application/json application/json yes
check "API prefix /admin/users/123 is proxied" /admin/users/123 "$HTML" application/json no
check "API prefix /servers is proxied" /servers '*/*' application/json no
check "/administrator is not an API route" /administrator "$HTML" text/html no
check "/files-page is not an API route" /files-page "$HTML" text/html no
check "SPA route /settings/agents is the app shell" /settings/agents "$HTML" text/html no

echo "$PASS passed, $FAIL failed"
(( FAIL == 0 ))
