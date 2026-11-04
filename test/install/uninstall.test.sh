#!/usr/bin/env bash
# install/uninstall.sh against a fake Docker (test/install/fake-docker.sh) in which boxd, while
# running, recreates box containers that are removed, box networks can't be removed while the
# edge runs and a box's home volume can't be removed while its container exists. Uninstall must
# stop boxd first, and with --purge delete the stack's own volumes (the database) last.
#
#   bash test/install/uninstall.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
n=0 failed=0
check() { n=$((n + 1)); if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi; }
line_of() { grep -nE "$1" "$FAKE/log" | head -n 1 | cut -d: -f1; }

mkdir -p "$T/bin"
cp "$ROOT/test/install/fake-docker.sh" "$T/bin/docker"
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH"
BOX1=01jaaaaaaaaaaaaaaaaaaaaaaa
BOX2=01jbbbbbbbbbbbbbbbbbbbbbbb

setup() {
    export FAKE="$T/fake-$1"
    rm -rf "$FAKE" "$T/inst"; mkdir -p "$FAKE" "$T/inst"
    cp -r "$ROOT/install" "$T/inst/"
    printf '{\n  "name": "agora",\n  "version": "0.9.0"\n}\n' > "$T/inst/package.json"
    printf 'services: {}\n' > "$T/inst/docker-compose.prod.yml"
    printf 'COMPOSE_PROJECT_NAME=agora\nAGORA_INSTANCE=agora\nDB_PASSWORD=x\n' > "$T/inst/.env.prod"
    printf '%s\n' postgres redis api runner cap-gateway web caddy box-socket-proxy box-edge boxd > "$FAKE/services"
    cp "$FAKE/services" "$FAKE/running"
    printf 'agora-box-%s\nagora-box-%s\n' "$BOX1" "$BOX2" > "$FAKE/boxes"
    cp "$FAKE/boxes" "$FAKE/boxes_running"
    printf 'agora-box-%s-home\nagora-box-%s-home\n' "$BOX1" "$BOX2" > "$FAKE/volumes"
    printf 'agora_box_%s\nagora_box_%s\n' "$BOX1" "$BOX2" > "$FAKE/networks"
    echo agora > "$FAKE/projects"; echo agora > "$FAKE/pgdata"
}

# ─── --purge with boxd running ───
setup purge
if bash "$T/inst/install/uninstall.sh" --dir "$T/inst" --purge --confirm agora --non-interactive > "$T/out.log" 2>&1; then code=0; else code=$?; fi
check 'purge: exit 0' 0 "$code"
[ "$code" = 0 ] || cat "$T/out.log"
check 'purge: boxd stopped before any box is removed' yes "$([ "$(line_of 'stop -t 90 boxd$')" -lt "$(line_of '^docker rm -f agora-box-')" ] && echo yes || echo no)"
check 'purge: boxd never recreated a box' 0 "$(grep -c 'boxd recreated' "$FAKE/log" || true)"
check 'purge: no box container left' 0 "$(wc -l < "$FAKE/boxes" | tr -d ' ')"
check 'purge: no box network left' 0 "$(wc -l < "$FAKE/networks" | tr -d ' ')"
check 'purge: no box volume left' 0 "$(wc -l < "$FAKE/volumes" | tr -d ' ')"
check 'purge: the database volume goes last' yes "$([ "$(line_of 'compose .* down -v')" -gt "$(line_of '^docker volume rm agora-box-01jb')" ] && echo yes || echo no)"
check 'purge: the stack volumes are deleted' 1 "$(grep -c 'compose volumes deleted' "$FAKE/log")"
check 'purge: the folder stays' yes "$([ -f "$T/inst/.env.prod" ] && echo yes || echo no)"

# ─── Without --purge: containers and networks go, every volume stays ───
setup keep
if bash "$T/inst/install/uninstall.sh" --dir "$T/inst" --non-interactive > "$T/out.log" 2>&1; then code=0; else code=$?; fi
check 'keep: exit 0' 0 "$code"
check 'keep: the box volumes stay' 2 "$(wc -l < "$FAKE/volumes" | tr -d ' ')"
check 'keep: the stack volumes stay' 0 "$(grep -c 'compose volumes deleted' "$FAKE/log" || true)"
check 'keep: no box container left' 0 "$(wc -l < "$FAKE/boxes" | tr -d ' ')"

# ─── boxd won't stop: nothing is removed ───
setup boxd-stuck
printf '%s' 'stop -t 90 boxd$' > "$FAKE/fail"
if bash "$T/inst/install/uninstall.sh" --dir "$T/inst" --purge --confirm agora --non-interactive > "$T/out.log" 2>&1; then code=0; else code=$?; fi
: > "$FAKE/fail"
check 'boxd stuck: refused' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
check 'boxd stuck: no box removed' 2 "$(wc -l < "$FAKE/boxes" | tr -d ' ')"
check 'boxd stuck: no data deleted' 0 "$(grep -c 'compose volumes deleted' "$FAKE/log" || true)"

# ─── --purge needs the name ───
setup no-confirm
if bash "$T/inst/install/uninstall.sh" --dir "$T/inst" --purge --non-interactive > "$T/out.log" 2>&1; then code=0; else code=$?; fi
check 'purge without --confirm: refused' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
check 'purge without --confirm: nothing stopped' 0 "$(grep -c ' stop ' "$FAKE/log" || true)"

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
