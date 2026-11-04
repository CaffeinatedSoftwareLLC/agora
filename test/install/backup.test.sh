#!/usr/bin/env bash
# install/backup.sh against a fake Docker (test/install/fake-docker.sh): a failed stop, a failed
# listing or a box the database knows without a volume leaves no bundle, and whatever the backup
# stopped is started again. A good run leaves a verified bundle and the same running set.
#
#   bash test/install/backup.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
n=0 failed=0
check() { n=$((n + 1)); if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi; }

mkdir -p "$T/bin"
cp "$ROOT/test/install/fake-docker.sh" "$T/bin/docker"
printf '#!/bin/sh\necho "{\\"status\\":\\"ok\\"}"\n' > "$T/bin/curl"
chmod +x "$T/bin/docker" "$T/bin/curl"
export PATH="$T/bin:$PATH"
printf 'correct horse battery staple\n' > "$T/pass"

BOX1=01jaaaaaaaaaaaaaaaaaaaaaaa
BOX2=01jbbbbbbbbbbbbbbbbbbbbbbb
SVCS='postgres redis api runner cap-gateway web caddy socket-proxy box-socket-proxy box-edge boxd'

# setup: a fresh install folder and a fake engine with the stack and two boxes running
setup() {
    export FAKE="$T/fake-$1"
    rm -rf "$FAKE" "$T/inst"
    mkdir -p "$FAKE" "$T/inst"
    cp -r "$ROOT/install" "$T/inst/"
    printf '{\n  "name": "agora",\n  "version": "0.9.0"\n}\n' > "$T/inst/package.json"
    printf 'services: {}\n' > "$T/inst/docker-compose.prod.yml"
    printf 'COMPOSE_PROJECT_NAME=agora\nAGORA_INSTANCE=agora\nDB_PASSWORD=x\n' > "$T/inst/.env.prod"
    printf '%s\n' $SVCS > "$FAKE/services"
    cp "$FAKE/services" "$FAKE/running"
    printf 'agora-box-%s\nagora-box-%s\n' "$BOX1" "$BOX2" > "$FAKE/boxes"
    cp "$FAKE/boxes" "$FAKE/boxes_running"
    printf 'agora-box-%s-home\nagora-box-%s-home\n' "$BOX1" "$BOX2" > "$FAKE/volumes"
    printf 'agora-api\n' > "$FAKE/images"
    printf 'agora-api\n' > "$FAKE/crypt_images"
    echo t > "$FAKE/regclass"
    printf '%s|3|1|running|true\n%s|1|1|running|true\n' "$BOX1" "$BOX2" > "$FAKE/dbboxes"
}
run_backup() { bash "$T/inst/install/backup.sh" --dir "$T/inst" --out "$T/out.agorabk" --passphrase-file "$T/pass" --non-interactive > "$T/out.log" 2>&1; }
same_running() { sort "$FAKE/running" | tr '\n' ' '; }
want_running=$(printf '%s\n' $SVCS | sort | tr '\n' ' ')

# ─── A good run ───
setup good
rm -f "$T/out.agorabk"
if run_backup; then code=0; else code=$?; fi
check 'good run: exit 0' 0 "$code"
[ "$code" = 0 ] || cat "$T/out.log"
check 'good run: the bundle exists' yes "$([ -s "$T/out.agorabk" ] && echo yes || echo no)"
check 'good run: every part is there' 'boxes/01jaaaaaaaaaaaaaaaaaaaaaaa-home.tar boxes/01jbbbbbbbbbbbbbbbbbbbbbbb-home.tar env.prod files-data.tar manifest.json postgres.sql' \
    "$(grep '^SEG ' "$T/out.agorabk" | cut -d' ' -f2 | sort | tr '\n' ' ' | sed 's/ $//')"
check 'good run: the same services run afterwards' "$want_running" "$(same_running)"
check 'good run: both boxes run afterwards' 2 "$(wc -l < "$FAKE/boxes_running" | tr -d ' ')"
line_of() { grep -nE "$1" "$FAKE/log" | head -n 1 | cut -d: -f1; }
l_boxd=$(line_of 'stop -t 90 boxd$'); l_box=$(line_of '^docker stop -t 30 agora-box-'); l_api=$(line_of 'stop -t 30 api$'); l_dump=$(line_of 'pg_dump')
check 'good run: boxd, then the boxes, then api are stopped, all before the dump' yes     "$([ "$l_boxd" -lt "$l_box" ] && [ "$l_box" -lt "$l_api" ] && [ "$l_api" -lt "$l_dump" ] && echo yes || echo no)"
check 'good run: boxd started last of the services' boxd "$(grep -Eo 'compose .* start [a-z-]+' "$FAKE/log" | awk '{print $NF}' | tail -n 1)"
check 'good run: crypt ran from the install image' yes "$(grep -q 'agora-api node dist/src/tools/backup-crypt.js encrypt' "$FAKE/log" && echo yes || echo no)"

# ─── Injected failures: no bundle, and what was stopped runs again ───
for case in \
    'stop api|compose .* stop -t 30 api$' \
    'stop boxd|compose .* stop -t 90 boxd$' \
    'stop a box|^stop -t 30 agora-box-01jb' \
    'list box containers|^ps -a --filter label=org.agora.instance' \
    'list box volumes|^volume ls' \
    'list services|ps --status running' \
    'dump the database|pg_dump' \
    'archive a box volume|agora-box-01jbbbbbbbbbbbbbbbbbbbbbbb-home:/v:ro'; do
    name=${case%%|*}; re=${case#*|}
    setup "fail-$(printf '%s' "$name" | tr ' ' '-')"
    rm -f "$T/out.agorabk"
    printf '%s' "$re" > "$FAKE/fail"
    # The docker log lines start with "docker "; the regex is applied to the arguments
    if run_backup; then code=0; else code=$?; fi
    : > "$FAKE/fail"
    check "$name fails: exit non-zero" 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
    check "$name fails: no bundle" no "$([ -e "$T/out.agorabk" ] && echo yes || echo no)"
    if [ "$name" != 'list services' ]; then
        check "$name fails: the same services run afterwards" "$want_running" "$(same_running)"
        check "$name fails: both boxes run afterwards" 2 "$(wc -l < "$FAKE/boxes_running" | tr -d ' ')"
    fi
done

# ─── A service that won't stop is caught by the quiescence check ───
setup still-running
rm -f "$T/out.agorabk"
# stop "succeeds" but runner keeps running: fake a compose whose stop leaves it
sed -i 's/del running "\$s"; done/[ "$s" = runner ] || del running "$s"; done/' "$T/bin/docker"
if run_backup; then code=0; else code=$?; fi
cp "$ROOT/test/install/fake-docker.sh" "$T/bin/docker"
check 'a writer still running: exit non-zero' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
check 'a writer still running: no bundle' no "$([ -e "$T/out.agorabk" ] && echo yes || echo no)"
check 'a writer still running: says which' yes "$(grep -q 'runner is still running' "$T/out.log" && echo yes || echo no)"

# ─── The database knows a box with no volume ───
setup missing-volume
rm -f "$T/out.agorabk"
printf 'agora-box-%s-home\n' "$BOX1" > "$FAKE/volumes"
if run_backup; then code=0; else code=$?; fi
check 'missing box volume: exit non-zero' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
check 'missing box volume: no bundle' no "$([ -e "$T/out.agorabk" ] && echo yes || echo no)"
check 'missing box volume: names the box' yes "$(grep -q "$BOX2" "$T/out.log" && echo yes || echo no)"
check 'missing box volume: the same services run afterwards' "$want_running" "$(same_running)"

# A deleted box past its 7 days (need=false) may have no volume
setup purged-box
rm -f "$T/out.agorabk"
printf 'agora-box-%s-home\n' "$BOX1" > "$FAKE/volumes"
printf '%s|3|1|running|true\n%s|1|1|deleted|false\n' "$BOX1" "$BOX2" > "$FAKE/dbboxes"
if run_backup; then code=0; else code=$?; fi
check 'a purged box without a volume is fine' 0 "$code"

# ─── An install from before agent boxes ───
setup pre-box
rm -f "$T/out.agorabk"
: > "$FAKE/boxes"; : > "$FAKE/boxes_running"; : > "$FAKE/volumes"; echo f > "$FAKE/regclass"
printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy > "$FAKE/services"; cp "$FAKE/services" "$FAKE/running"
if run_backup; then code=0; else code=$?; fi
check 'pre-box install: exit 0' 0 "$code"
check 'pre-box install: never asks for agent_boxes rows' 0 "$(grep -c 'FROM agent_boxes' "$FAKE/log" || true)"

# ─── The install image has no crypt tool (an old release) ───
setup no-tool
rm -f "$T/out.agorabk"
: > "$FAKE/crypt_images"
if run_backup; then code=0; else code=$?; fi
check 'no crypt tool: refuses' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
check 'no crypt tool: says to use the new release' yes "$(grep -q 'new release' "$T/out.log" && echo yes || echo no)"
check 'no crypt tool: stopped nothing' 0 "$(grep -c ' stop ' "$FAKE/log" || true)"

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
