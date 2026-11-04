#!/usr/bin/env bash
# Restore an Agora backup bundle (docs/agent-boxes.md §9.4) into an install folder.
#
#   bash install/restore.sh <bundle> [--dir <install folder>] [--passphrase-file <file>] [--yes]
#                           [--crypt-image <image>]
#
# Checks the whole bundle and its manifest first, then replaces this install's database,
# files and every box home volume with the bundle's, and its .env.prod (keeping this
# machine's ports and DOCKER_GID). The database role gets the bundle's DB_PASSWORD (the cluster
# is this machine's, the password the bundle's). Before anything starts, box-restore-prep bumps every box's
# generation, revokes every box token and expires every pending or allowed edge request, so
# nothing minted or approved before the backup works afterwards. Then the stack starts and
# boxd rebuilds the boxes with their logins and repos.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/bundle.sh
. "$HERE/lib/bundle.sh"

DIR=$(cd "$HERE/.." && pwd) BUNDLE='' PASS_ARG='' YES=0 CRYPT_ARG=''
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        --passphrase-file) PASS_ARG=$2; shift ;;
        --yes) YES=1 ;;
        --crypt-image) CRYPT_ARG=$2; shift ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        -*) echo "restore.sh: unknown option $1" >&2; exit 2 ;;
        *) BUNDLE=$1 ;;
    esac
    shift
done
[ -n "$BUNDLE" ] && [ -r "$BUNDLE" ] || die "give the bundle to restore: restore.sh <file>"
BUNDLE=$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")
DIR=$(cd "$DIR" && pwd)
[ -f "$DIR/$COMPOSE_FILE_NAME" ] || die "$DIR is not an Agora folder"
pick_docker || die "Docker isn't reachable"
DOCTOR_SCRIPT="$HERE/doctor.sh" INSTALL_DIR=$DIR
trap 'forget_passphrase; on_exit $?' EXIT
WORK=$(mktemp -d)
chmod 700 "$WORK"

step restore.verify 'Checking the bundle'
get_passphrase "$PASS_ARG" 0
# Needs a backend image with backup-crypt; a fresh install folder builds one
[ -f "$DIR/$ENV_FILE_NAME" ] || die "$DIR has no $ENV_FILE_NAME yet: install Agora there first (install/linux/install.sh), then restore"
use_crypt_image "$DIR" "$CRYPT_ARG"
crypt verify < "$BUNDLE" > "$WORK/parts" || die "the bundle didn't verify (wrong passphrase, or damaged)"
crypt extract --name manifest.json < "$BUNDLE" > "$WORK/manifest.json"
mf() { tr -d '\n' < "$WORK/manifest.json" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n 1; }
B_INSTANCE=$(mf instance)
B_VERSION=$(mf version)
printf '%s' "$B_INSTANCE" | grep -Eq "$INSTANCE_NAME_RE" || die "the manifest has no valid instance name"
# Every part the manifest names is in the bundle with the same checksum
tr -d '\n' < "$WORK/manifest.json" | grep -Eo '"name":"[^"]+","sha256":"[0-9a-f]{64}"' \
    | sed 's/"name":"\([^"]*\)","sha256":"\([^"]*\)"/\1 \2/' > "$WORK/expected"
while read -r name sha; do
    grep -q "^part $name $sha " "$WORK/parts" || die "part $name is missing or differs from the manifest"
done < "$WORK/expected"
grep -q '^part postgres.sql ' "$WORK/parts" && grep -q '^part env.prod ' "$WORK/parts" || die "the bundle has no database or no env.prod"
ok "$(wc -l < "$WORK/parts") parts, instance $B_INSTANCE, Agora $B_VERSION"
HERE_VERSION=$(agora_version "$DIR")
[ "$HERE_VERSION" = "$B_VERSION" ] || warn "the bundle is from Agora $B_VERSION and this folder has $HERE_VERSION; migrations bring an older database forward, not back"

CUR_INSTANCE=$(env_get "$DIR/$ENV_FILE_NAME" AGORA_INSTANCE)
if [ -n "$CUR_INSTANCE" ] && [ "$CUR_INSTANCE" != "$B_INSTANCE" ]; then
    die "this folder is install $CUR_INSTANCE, the bundle is $B_INSTANCE. Restore into an install named $B_INSTANCE (install.sh --instance $B_INSTANCE)"
fi

say ''
say "  This replaces the database, the files and every box home of install $B_INSTANCE in $DIR."
if [ "$YES" = 0 ]; then
    [ "$NON_INTERACTIVE" = 0 ] && [ -t 0 ] || die "restoring replaces data: pass --yes to confirm without a terminal"
    ans=''
    ask ans "Type the install name ($B_INSTANCE) to go on:" ''
    [ "$ans" = "$B_INSTANCE" ] || die "not confirmed; nothing was changed"
fi

step restore.stop 'Stopping the stack and removing the box containers'
compose_in "$DIR" stop -t 60 >/dev/null 2>&1 || true
while read -r c; do [ -z "$c" ] || dk rm -f "$c" >/dev/null; done < <(box_containers "$B_INSTANCE")
ok stopped

step restore.env 'Restoring .env.prod'
crypt extract --name env.prod < "$BUNDLE" > "$WORK/env.prod"
chmod 600 "$WORK/env.prod"
cp -p "$DIR/$ENV_FILE_NAME" "$DIR/$ENV_FILE_NAME.before-restore"
# This machine's ports and docker group stay; everything else (secrets, the key) is the bundle's
for k in AGORA_HTTP_PORT AGORA_HTTPS_PORT AGORA_API_PORT DOCKER_GID AGORA_BOX_VERSION AGORA_BOX_TARGET AGORA_BOX_TAG_SUFFIX AGORA_BOX_INSECURE_DEV AGORA_SANDBOX_INSECURE_DEV; do
    v=$(env_get "$DIR/$ENV_FILE_NAME" "$k")
    [ -z "$v" ] || env_set "$WORK/env.prod" "$k" "$v"
done
mv "$WORK/env.prod" "$DIR/$ENV_FILE_NAME"
PROJECT=$(env_get "$DIR/$ENV_FILE_NAME" COMPOSE_PROJECT_NAME); PROJECT=${PROJECT:-$B_INSTANCE}
ok ".env.prod (the previous one is $ENV_FILE_NAME.before-restore)"

step restore.database 'Restoring the database'
compose_in "$DIR" up -d --wait postgres >/dev/null
# pg_dump doesn't carry the role's password: give the role the restored DB_PASSWORD before any
# client connects over the network with it
set_db_password "$DIR/$ENV_FILE_NAME" || die "could not set the database password from the restored $ENV_FILE_NAME"
compose_in "$DIR" exec -T postgres psql -U accord -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE IF EXISTS agora WITH (FORCE)' -c 'CREATE DATABASE agora OWNER accord' >/dev/null
crypt extract --name postgres.sql < "$BUNDLE" \
    | compose_in "$DIR" exec -T postgres psql -U accord -d agora -v ON_ERROR_STOP=1 -q >/dev/null
ok database

step restore.files 'Restoring files-data'
dk volume inspect "${PROJECT}_files-data" >/dev/null 2>&1 || dk volume create --label "com.docker.compose.project=$PROJECT" --label com.docker.compose.volume=files-data "${PROJECT}_files-data" >/dev/null
crypt extract --name files-data.tar < "$BUNDLE" \
    | dk run --rm -i --network none -v "${PROJECT}_files-data:/v" alpine:3.20 sh -c 'find /v -mindepth 1 -delete && tar -C /v -xpf -'
ok files-data

step restore.boxes 'Restoring every box home volume'
tr -d '\n' < "$WORK/manifest.json" | grep -Eo '\{"id":"[0-9a-z]{26}","volume":"[^"]+","labels":"[^"]*"\}' > "$WORK/volumes" || true
while read -r entry; do
    [ -n "$entry" ] || continue
    id=$(printf '%s' "$entry" | sed 's/.*"id":"\([^"]*\)".*/\1/')
    vol="$B_INSTANCE-box-$id-home"
    labels=$(printf '%s' "$entry" | sed 's/.*"labels":"\([^"]*\)".*/\1/')
    label_args=()
    IFS=';' read -r -a pairs <<< "$labels"
    for kv in "${pairs[@]}"; do [ -z "$kv" ] || label_args+=(--label "$kv"); done
    dk volume rm -f "$vol" >/dev/null 2>&1 || true
    dk volume create "${label_args[@]}" "$vol" >/dev/null
    crypt extract --name "boxes/$id-home.tar" < "$BUNDLE" \
        | dk run --rm -i --network none -v "$vol:/v" alpine:3.20 tar -C /v --numeric-owner -xpf -
    ok "box $id"
done < "$WORK/volumes"

step restore.prep 'Migrations, new box generations, revoked box tokens, expired approvals'
# Over the network with the restored password, as api and migrate will connect
compose_in "$DIR" run --rm --no-deps -T migrate node -e "const{Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query('SELECT 1')).then(()=>c.end()).then(()=>process.exit(0),e=>{console.error('database login failed: '+(e.code||'error'));process.exit(1)})"     || die "the database refuses the restored DB_PASSWORD over the network"
compose_in "$DIR" run --rm --no-deps -T migrate >/dev/null
if compose_in "$DIR" run --rm --no-deps -T migrate test -f dist/src/tools/box-restore-prep.js >/dev/null 2>&1; then
    compose_in "$DIR" run --rm --no-deps -T -e "AGORA_INSTANCE=$B_INSTANCE" migrate node dist/src/tools/box-restore-prep.js
elif [ -s "$WORK/volumes" ] || tr -d '
' < "$WORK/manifest.json" | grep -q '"boxes":\[{'; then
    die "this release has no box-restore-prep, but the bundle has boxes"
else
    info 'no agent boxes: nothing to re-key (a release from before agent boxes)'
fi
ok 'ready to start'

step restore.start 'Starting the stack'
compose_in "$DIR" up -d --remove-orphans
api=$(env_get "$DIR/$ENV_FILE_NAME" AGORA_API_PORT)
deadline=$(( $(date +%s) + 300 ))
until curl -fsS -m 5 "http://127.0.0.1:${api:-3000}/health" 2>/dev/null | grep -q '"ok"'; do
    [ "$(date +%s)" -lt "$deadline" ] || die "the API didn't come back within 5 minutes"
    sleep 3
done
rm -rf "$WORK"
FINISHED=1
ok "restored; boxd now rebuilds the boxes with fresh tokens"
