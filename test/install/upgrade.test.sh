#!/usr/bin/env bash
# install/upgrade.sh against a fake Docker (test/install/fake-docker.sh), from the layout of an
# install made before agent boxes: a git checkout with no install/ folder, no box services, no
# AGORA_EDGE_SECRET and a backend image without the backup tool. Then --rollback, which must
# put back exactly the old release: a migration only the new release has must be gone and not
# be applied again.
#
#   bash test/install/upgrade.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
n=0 failed=0
check() { n=$((n + 1)); if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi; }
yes_if() { if eval "$1"; then echo yes; else echo no; fi; }

mkdir -p "$T/bin"
cp "$ROOT/test/install/fake-docker.sh" "$T/bin/docker"
printf '#!/bin/sh\necho "{\\"status\\":\\"ok\\"}"\n' > "$T/bin/curl"
chmod +x "$T/bin/docker" "$T/bin/curl"
export PATH="$T/bin:$PATH"
export FAKE="$T/fake"
mkdir -p "$FAKE"
printf 'correct horse battery staple\n' > "$T/pass"
DBPW='old-db-password-Zq9'

# ─── The old install: 0.3.0, before agent boxes ───
OLD="$T/agora"
mkdir -p "$OLD/src/db/migrations" "$OLD/.git"
printf '{\n  "name": "agora",\n  "version": "0.3.0"\n}\n' > "$OLD/package.json"
printf 'services: {old: {}}\n' > "$OLD/docker-compose.prod.yml"
printf 'FROM node:22-alpine\n' > "$OLD/Dockerfile"
printf 'localhost\n' > "$OLD/Caddyfile"
printf -- '-- core\n' > "$OLD/src/db/migrations/001_core.sql"
printf 'ref: refs/heads/main\n' > "$OLD/.git/HEAD"
printf 'COMPOSE_PROJECT_NAME=agora\nAGORA_INSTANCE=agora\nDB_PASSWORD=%s\nJWT_SECRET=j\nAGORA_ENCRYPTION_KEY=k\nDOCKER_GID=999\n' "$DBPW" > "$OLD/.env.prod"
chmod 600 "$OLD/.env.prod"
cp "$OLD/.env.prod" "$T/env.before"

# ─── The new release: 0.9.0, with boxes ───
NEW="$T/new"
mkdir -p "$NEW/src/db/migrations" "$NEW/src/tools" "$NEW/box"
cp -r "$ROOT/install" "$NEW/"
printf '{\n  "name": "agora",\n  "version": "0.9.0"\n}\n' > "$NEW/package.json"
cat > "$NEW/docker-compose.prod.yml" <<'YML'
services:
  new: {}
networks:
  sandbox:
    internal: true
    # a mention of com.docker.network.bridge.inhibit_ipv4 in a comment doesn't count
    driver_opts:
      com.docker.network.bridge.inhibit_ipv4: "true"
YML
printf 'FROM node:22-alpine\n' > "$NEW/Dockerfile"
printf 'localhost\n' > "$NEW/Caddyfile"
printf -- '-- core\n' > "$NEW/src/db/migrations/001_core.sql"
printf -- '-- boxes\n' > "$NEW/src/db/migrations/080_agent_boxes.sql"
printf '// prep\n' > "$NEW/src/tools/box-restore-prep.ts"
printf '1\n' > "$NEW/box/VERSION"

# ─── The engine: the old stack running, its image without the backup tool ───
printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy migrate > "$FAKE/services"
printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy > "$FAKE/running"
printf 'agora-api\n' > "$FAKE/images"
: > "$FAKE/crypt_images"
echo f > "$FAKE/regclass"
# The old sandbox network, without inhibit_ipv4; a run container this install's runner left
# (from before the agora.instance label), a run of another install on the same engine, and an
# unlabelled run of an older install (also named agora-run-*) on that install's own network
printf 'agora_sandbox -\nagora2_sandbox -\nagora3_sandbox -\n' > "$FAKE/sandbox_nets"
printf '%s\n' 'agora-run-01jaaaaaaaaaaaaaaaaaaaaaaa||agora_sandbox' 'agora2-run-01jbbbbbbbbbbbbbbbbbbbbbbb|agora2|agora2_sandbox' \
    'agora-run-01jccccccccccccccccccccccc||agora3_sandbox' > "$FAKE/runs"

# ─── Upgrade, run from the new release ───
if bash "$NEW/install/upgrade.sh" --dir "$OLD" --passphrase-file "$T/pass" --non-interactive > "$T/up.log" 2>&1; then code=0; else code=$?; fi
check 'upgrade: exit 0' 0 "$code"
[ "$code" = 0 ] || tail -n 30 "$T/up.log"
l_build=$(grep -n 'build -q -t agora/maintenance:0.9.0' "$FAKE/log" | head -n 1 | cut -d: -f1)
l_stop=$(grep -n ' stop ' "$FAKE/log" | head -n 1 | cut -d: -f1)
check 'upgrade: the maintenance image is built from the new release before the old stack is touched' yes "$(yes_if '[ -n "$l_build" ] && [ -n "$l_stop" ] && [ "$l_build" -lt "$l_stop" ]')"
check 'upgrade: the maintenance image is built from the staged new release' yes "$(yes_if "grep -q 'maintenance:0.9.0 -f $OLD/.releases/incoming-[0-9TZ]*/Dockerfile' '$FAKE/log'")"
check 'upgrade: every backup part goes through the maintenance image' yes "$(yes_if "grep -q 'agora/maintenance:0.9.0 node dist/src/tools/backup-crypt.js encrypt --name postgres.sql' '$FAKE/log'")"
check 'upgrade: never the old image' 0 "$(grep -c 'agora-api node dist/src/tools/backup-crypt.js' "$FAKE/log" || true)"
bundle=$(ls "$OLD"/backups/*.agorabk 2>/dev/null | head -n 1)
check 'upgrade: the backup bundle is there' yes "$(yes_if '[ -s "$bundle" ]')"
check 'upgrade: the new release is in place' 0.9.0 "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$OLD/package.json")"
check 'upgrade: with its scripts' yes "$(yes_if '[ -f "$OLD/install/upgrade.sh" ]')"
check 'upgrade: and its migration' yes "$(yes_if '[ -f "$OLD/src/db/migrations/080_agent_boxes.sql" ]')"
check 'upgrade: .git is left alone' yes "$(yes_if '[ -f "$OLD/.git/HEAD" ]')"
check 'upgrade: AGORA_EDGE_SECRET is generated' 1 "$(grep -Ec '^AGORA_EDGE_SECRET=[0-9a-f]{64}$' "$OLD/.env.prod")"
check 'upgrade: AGORA_BOX_VERSION follows box/VERSION' 1 "$(grep -c '^AGORA_BOX_VERSION=1$' "$OLD/.env.prod")"
check 'upgrade: the database password is unchanged' 1 "$(grep -c "^DB_PASSWORD=$DBPW\$" "$OLD/.env.prod")"
check 'upgrade: .env.prod stays 0600' 600 "$(stat -c %a "$OLD/.env.prod")"
prev=$(sed -n 's/^previous=//p' "$OLD/.agora-upgrade")
check 'upgrade: the old release is kept aside, whole' yes "$(yes_if '[ -f "$prev/src/db/migrations/001_core.sql" ] && [ -f "$prev/package.json" ] && [ ! -e "$prev/install" ]')"
check 'upgrade: nothing of the old release is mixed in' 'no' "$(yes_if "grep -q '0.3.0' '$OLD/package.json'")"
check 'upgrade: the staging folder is gone' 0 "$(ls -d "$OLD"/.releases/incoming-* 2>/dev/null | wc -l | tr -d ' ')"
check 'upgrade: the stack was started' yes "$(yes_if "grep -q 'compose .* up -d --remove-orphans' '$FAKE/log'")"
# Sandbox network (sandbox-isolation-spec §6.1): drained, recreated with inhibit_ipv4, no other install touched
line_of() { grep -n -- "$1" "$FAKE/log" | tail -n 1 | cut -d: -f1; }
l_drain=$(line_of 'compose .* stop -t 660 runner')
l_gw=$(line_of 'compose .* rm -f -s cap-gateway')
l_netrm=$(line_of 'docker network rm agora_sandbox')
l_up=$(line_of 'compose .* up -d --remove-orphans')
check 'upgrade: the backup lets code runs finish (runner stop timeout 660 s)' yes "$(yes_if "grep -q 'compose .* stop -t 660 runner' '$FAKE/log'")"
check 'upgrade: runner drained, then cap-gateway removed, then the network, then up' yes \
    "$(yes_if '[ -n "$l_drain" ] && [ -n "$l_gw" ] && [ -n "$l_netrm" ] && [ "$l_drain" -lt "$l_gw" ] && [ "$l_gw" -lt "$l_netrm" ] && [ "$l_netrm" -lt "$l_up" ]')"
check 'upgrade: the sandbox network now has inhibit_ipv4' 'agora_sandbox true' "$(grep '^agora_sandbox ' "$FAKE/sandbox_nets")"
check "upgrade: this install's leftover run container is removed" 0 "$(grep -c '^agora-run-01ja' "$FAKE/runs" || true)"
check "upgrade: another install's run and network are left alone" 'agora2-run-01jbbbbbbbbbbbbbbbbbbbbbbb|agora2|agora2_sandbox|agora2_sandbox -' \
    "$(grep agora2 "$FAKE/runs")|$(grep '^agora2_sandbox ' "$FAKE/sandbox_nets")"
check "upgrade: an older install's unlabelled agora-run-* on its own network is left alone" 1 "$(grep -c '^agora-run-01jc' "$FAKE/runs")"
check 'upgrade: the runner is checked after the start' yes "$(yes_if "grep -q 'runner running' '$T/up.log'")"
check 'upgrade: never a network other than its own removed' 0 "$(grep 'network rm' "$FAKE/log" | grep -vc 'network rm agora_sandbox$' || true)"

# ─── Rollback, with the scripts now in the install ───
: > "$FAKE/log"
if bash "$OLD/install/upgrade.sh" --rollback --dir "$OLD" --passphrase-file "$T/pass" --non-interactive > "$T/rb.log" 2>&1; then code=0; else code=$?; fi
check 'rollback: exit 0' 0 "$code"
[ "$code" = 0 ] || tail -n 30 "$T/rb.log"
check 'rollback: the old release is back' 0.3.0 "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$OLD/package.json")"
check 'rollback: the new migration is gone' no "$(yes_if '[ -e "$OLD/src/db/migrations/080_agent_boxes.sql" ]')"
check 'rollback: the new scripts are gone from the release' no "$(yes_if '[ -e "$OLD/install" ]')"
check 'rollback: the old migration is there' yes "$(yes_if '[ -f "$OLD/src/db/migrations/001_core.sql" ]')"
check 'rollback: the image is rebuilt from the old migrations only' '001_core.sql' "$(grep "^build in $OLD:" "$FAKE/log" | tail -n 1 | sed 's/.*: //; s/ *$//')"
check 'rollback: migrate runs with the old migrations only' '001_core.sql' "$(grep "^migrate applied in $OLD:" "$FAKE/log" | tail -n 1 | sed 's/.*: //; s/ *$//')"
check 'rollback: the restore reads the bundle through the maintenance image' yes "$(yes_if "grep -q 'agora/maintenance:0.9.0 node dist/src/tools/backup-crypt.js extract --name postgres.sql' '$FAKE/log'")"
check 'rollback: .env.prod is the one from before the upgrade (no edge secret)' 0 "$(grep -c '^AGORA_EDGE_SECRET=' "$OLD/.env.prod" || true)"
check 'rollback: same database password' 1 "$(grep -c "^DB_PASSWORD=$DBPW\$" "$OLD/.env.prod")"
check 'rollback: the role gets a SCRAM verifier on psql stdin' yes "$(yes_if "grep -q 'ALTER ROLE accord PASSWORD :.verifier.;' '$FAKE/psql-stdin' && grep -q 'SCRAM-SHA-256' '$FAKE/psql-stdin'")"
check 'rollback: psql never sees the password itself' 0 "$(grep -c "$DBPW" "$FAKE/psql-stdin" || true)"
check 'rollback: the password itself is never in a docker command line' 0 "$(grep -c "$DBPW" "$FAKE/log" || true)"
check 'rollback: no box-restore-prep for a release without boxes' 0 "$(grep -c 'node dist/src/tools/box-restore-prep.js' "$FAKE/log" || true)"
check 'rollback: the newer release is kept aside' yes "$(yes_if 'ls -d "$OLD"/.releases/0.9.0-rolled-back-*/src/db/migrations/080_agent_boxes.sql >/dev/null 2>&1')"
check 'rollback: .git is left alone' yes "$(yes_if '[ -f "$OLD/.git/HEAD" ]')"
check 'rollback: code runs drained before the stack stops' yes "$(yes_if "grep -q 'compose .* stop -t 660 runner' '$FAKE/log'")"
check 'rollback: the sandbox network is back to what the old release declares' 'agora_sandbox -' "$(grep '^agora_sandbox ' "$FAKE/sandbox_nets")"

# ─── Sandbox network: already right, or a stranger on it ───
SN="$T/agora-sn"
mkdir -p "$SN"
cp -r "$NEW"/. "$SN"/
printf 'COMPOSE_PROJECT_NAME=agora-sn\nAGORA_INSTANCE=agora-sn\nDB_PASSWORD=x\n' > "$SN/.env.prod"
printf '%s\n' postgres redis api runner cap-gateway > "$FAKE/running"
printf 'agora-sn_sandbox true\n' > "$FAKE/sandbox_nets"; : > "$FAKE/runs"; : > "$FAKE/log"
if bash "$SN/install/sandbox-network.sh" --dir "$SN" > "$T/sn1.log" 2>&1; then code=0; else code=$?; fi
check 'sandbox-network.sh: exit 0 on a network that is already right' 0 "$code"
check 'sandbox-network.sh: leaves a right network alone' 0 "$(grep -c 'network rm' "$FAKE/log" || true)"
printf 'agora-sn_sandbox -\n' > "$FAKE/sandbox_nets"; printf 'stranger\n' > "$FAKE/sandbox_attached"; : > "$FAKE/log"
if bash "$SN/install/sandbox-network.sh" --dir "$SN" > "$T/sn2.log" 2>&1; then code=0; else code=$?; fi
check 'sandbox-network.sh: refuses while another container is on the network' 1 "$code"
check 'sandbox-network.sh: says which' yes "$(yes_if "grep -q 'stranger' '$T/sn2.log'")"
check 'sandbox-network.sh: refuses before stopping anything' 0 "$(grep -c 'compose .* stop\|compose .* rm' "$FAKE/log" || true)"
check 'sandbox-network.sh: the network is still there' 'agora-sn_sandbox -' "$(cat "$FAKE/sandbox_nets")"
: > "$FAKE/sandbox_attached"; : > "$FAKE/log"
if bash "$SN/install/sandbox-network.sh" --dir "$SN" > "$T/sn3.log" 2>&1; then code=0; else code=$?; fi
check 'sandbox-network.sh: recreates the network once it is free' '0|agora-sn_sandbox true' "$code|$(cat "$FAKE/sandbox_nets")"

# An upgrade that would have to recreate a network with a stranger on it refuses before the backup
ST="$T/agora-st"
mkdir -p "$ST/src/db/migrations"
printf '{\n  "name": "agora",\n  "version": "0.3.0"\n}\n' > "$ST/package.json"
printf 'services: {old: {}}\n' > "$ST/docker-compose.prod.yml"
printf 'FROM node:22-alpine\n' > "$ST/Dockerfile"
printf 'COMPOSE_PROJECT_NAME=agora-st\nAGORA_INSTANCE=agora-st\nDB_PASSWORD=x\n' > "$ST/.env.prod"
printf '%s\n' postgres redis api runner cap-gateway > "$FAKE/running"
printf 'agora-st_sandbox -\n' > "$FAKE/sandbox_nets"; printf 'stranger\n' > "$FAKE/sandbox_attached"; : > "$FAKE/log"
if bash "$NEW/install/upgrade.sh" --dir "$ST" --passphrase-file "$T/pass" --non-interactive > "$T/st.log" 2>&1; then code=0; else code=$?; fi
check 'upgrade with a stranger on the network: refused' 1 "$code"
check 'upgrade with a stranger on the network: nothing stopped, nothing replaced' '0|0.3.0' \
    "$(grep -c 'compose .* stop' "$FAKE/log" || true)|$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$ST/package.json")"
: > "$FAKE/sandbox_attached"

# ─── A legacy install in a custom folder, with neither COMPOSE_PROJECT_NAME nor AGORA_INSTANCE ───
# Compose named its project after the folder (agora-prod); the upgrade must keep that name, or
# the new stack's containers and boxd's edge name would no longer match (Codex review #4).
LEG="$T/agora-prod"
mkdir -p "$LEG/src/db/migrations" "$LEG/.git"
cp "$T/agora/.releases"/0.3.0-*/package.json "$LEG/package.json" 2>/dev/null || printf '{\n  "name": "agora",\n  "version": "0.3.0"\n}\n' > "$LEG/package.json"
printf 'services: {old: {}}\n' > "$LEG/docker-compose.prod.yml"
printf 'FROM node:22-alpine\n' > "$LEG/Dockerfile"
printf -- '-- core\n' > "$LEG/src/db/migrations/001_core.sql"
printf 'DB_PASSWORD=%s\nJWT_SECRET=j\nAGORA_ENCRYPTION_KEY=k\nDOCKER_GID=999\n' "$DBPW" > "$LEG/.env.prod"
chmod 600 "$LEG/.env.prod"
printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy migrate > "$FAKE/services"
printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy > "$FAKE/running"
: > "$FAKE/log"
if bash "$NEW/install/upgrade.sh" --dir "$LEG" --passphrase-file "$T/pass" --non-interactive > "$T/leg.log" 2>&1; then code=0; else code=$?; fi
check 'legacy folder: exit 0' 0 "$code"
[ "$code" = 0 ] || tail -n 30 "$T/leg.log"
check 'legacy folder: COMPOSE_PROJECT_NAME pinned to the folder project' 1 "$(grep -c '^COMPOSE_PROJECT_NAME=agora-prod$' "$LEG/.env.prod")"
check 'legacy folder: AGORA_INSTANCE pinned to the same name' 1 "$(grep -c '^AGORA_INSTANCE=agora-prod$' "$LEG/.env.prod")"

# A disagreement is refused before anything changes
CON="$T/agora-x"
mkdir -p "$CON"
cp "$LEG/docker-compose.prod.yml" "$LEG/Dockerfile" "$CON/"
printf '{\n  "name": "agora",\n  "version": "0.3.0"\n}\n' > "$CON/package.json"
printf 'COMPOSE_PROJECT_NAME=agora-x\nAGORA_INSTANCE=other\nDB_PASSWORD=x\n' > "$CON/.env.prod"
: > "$FAKE/log"
if bash "$NEW/install/upgrade.sh" --dir "$CON" --passphrase-file "$T/pass" --non-interactive > "$T/con.log" 2>&1; then code=0; else code=$?; fi
check 'conflicting names: refused' 1 "$code"
check 'conflicting names: nothing stopped' 0 "$(grep -c 'compose .* stop' "$FAKE/log" || true)"

# ─── Two box-era releases with different box/VERSION: upgrade, then roll back ───
# The fake `compose build` refuses an AGORA_BOX_VERSION that isn't the folder's box/VERSION, as
# box/Dockerfile does, so a rollback that kept the newer tag would fail here.
mk_release() { # mk_release <dir> <version> <box version>
    mkdir -p "$1/src/db/migrations" "$1/src/tools" "$1/box"
    cp -r "$ROOT/install" "$1/"
    printf '{\n  "name": "agora",\n  "version": "%s"\n}\n' "$2" > "$1/package.json"
    printf 'services: {}\n' > "$1/docker-compose.prod.yml"
    printf 'FROM node:22-alpine\n' > "$1/Dockerfile"
    printf -- '-- core\n' > "$1/src/db/migrations/001_core.sql"
    printf -- '-- boxes\n' > "$1/src/db/migrations/080_agent_boxes.sql"
    printf '// prep\n' > "$1/src/tools/box-restore-prep.ts"
    printf '%s\n' "$3" > "$1/box/VERSION"
}
BE="$T/agora-be"
mk_release "$BE" 0.9.0 1
printf 'COMPOSE_PROJECT_NAME=agora-be\nAGORA_INSTANCE=agora-be\nDB_PASSWORD=%s\nAGORA_EDGE_SECRET=%s\nAGORA_BOX_VERSION=1\nDOCKER_GID=999\n' "$DBPW" "$(printf 'a%.0s' $(seq 1 64))" > "$BE/.env.prod"
chmod 600 "$BE/.env.prod"
NEW2="$T/new2"
mk_release "$NEW2" 1.0.0 2
printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy box-socket-proxy box-edge boxd migrate > "$FAKE/services"
printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy box-socket-proxy box-edge boxd > "$FAKE/running"
echo t > "$FAKE/regclass"; : > "$FAKE/dbboxes"; : > "$FAKE/boxes"; : > "$FAKE/boxes_running"; : > "$FAKE/volumes"
: > "$FAKE/log"
if bash "$NEW2/install/upgrade.sh" --dir "$BE" --passphrase-file "$T/pass" --non-interactive > "$T/be-up.log" 2>&1; then code=0; else code=$?; fi
check 'box-era upgrade: exit 0' 0 "$code"
[ "$code" = 0 ] || tail -n 30 "$T/be-up.log"
check 'box-era upgrade: AGORA_BOX_VERSION=2' 1 "$(grep -c '^AGORA_BOX_VERSION=2$' "$BE/.env.prod")"
check 'box-era upgrade: the record is finished' 1 "$(grep -c '^state=done$' "$BE/.agora-upgrade")"
: > "$FAKE/log"
if bash "$BE/install/upgrade.sh" --rollback --dir "$BE" --passphrase-file "$T/pass" --non-interactive > "$T/be-rb.log" 2>&1; then code=0; else code=$?; fi
check 'box-era rollback: exit 0' 0 "$code"
[ "$code" = 0 ] || tail -n 30 "$T/be-rb.log"
check 'box-era rollback: AGORA_BOX_VERSION back to 1' 1 "$(grep -c '^AGORA_BOX_VERSION=1$' "$BE/.env.prod")"
check 'box-era rollback: the images built' 0 "$(grep -c 'fake build: BOX_VERSION' "$T/be-rb.log" || true)"
check 'box-era rollback: the old release is back' 0.9.0 "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$BE/package.json")"
check 'box-era rollback: box-restore-prep ran' 1 "$(grep -c 'migrate node dist/src/tools/box-restore-prep.js' "$FAKE/log")"

# ─── Stale and pending upgrade records ───
# The record still says "to 1.0.0, done", but the folder is at 0.9.0 now: a second rollback must refuse
: > "$FAKE/log"
if bash "$NEW2/install/upgrade.sh" --rollback --dir "$BE" --passphrase-file "$T/pass" --non-interactive > "$T/be-rb2.log" 2>&1; then code=0; else code=$?; fi
check 'stale record: rollback refused' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
check 'stale record: says why' yes "$(yes_if "grep -q 'stale record' '$T/be-rb2.log'")"
check 'stale record: nothing stopped' 0 "$(grep -c 'compose .* stop' "$FAKE/log" || true)"
# A pending record (an upgrade that failed after writing it) is used: it names the release it replaced
prevdir=$(sed -n 's/^previous=//p' "$BE/.agora-upgrade")
mkdir -p "$prevdir"
cp -r "$BE"/. "$prevdir"/ 2>/dev/null || true
rm -rf "$prevdir/.releases" "$prevdir/backups" "$prevdir/.env.prod" "$prevdir/.agora-upgrade"
sed -i 's/^state=done$/state=pending/; s/^to=.*/to=9.9.9/' "$BE/.agora-upgrade"
: > "$FAKE/log"
if bash "$NEW2/install/upgrade.sh" --rollback --dir "$BE" --passphrase-file "$T/pass" --non-interactive > "$T/be-rb3.log" 2>&1; then code=0; else code=$?; fi
check 'pending record: rollback goes ahead' 0 "$code"
[ "$code" = 0 ] || tail -n 20 "$T/be-rb3.log"
check 'pending record: says the upgrade did not finish' yes "$(yes_if "grep -q \"didn't finish\" '$T/be-rb3.log'")"

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
