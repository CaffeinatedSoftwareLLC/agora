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
printf 'services: {new: {}}\n' > "$NEW/docker-compose.prod.yml"
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

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
