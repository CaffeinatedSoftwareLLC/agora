#!/usr/bin/env bash
# Back up an Agora install, every box included (docs/agent-boxes.md §9.4).
#
#   bash install/backup.sh [--dir <install folder>] [--out <file>] [--passphrase-file <file>]
#
# Quiesces what changes box state (boxd and the edge, then every box, then api, runner and
# cap-gateway), dumps the database and archives files-data and every box home volume, then
# starts everything again. The result is one bundle, encrypted with a passphrase you choose:
# postgres.sql, files-data.tar, boxes/<boxId>-home.tar, env.prod and manifest.json. Without
# the passphrase it can't be restored.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/bundle.sh
. "$HERE/lib/bundle.sh"

DIR=$(cd "$HERE/.." && pwd) OUT='' PASS_ARG=''
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        --out) OUT=$2; shift ;;
        --passphrase-file) PASS_ARG=$2; shift ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "backup.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
DIR=$(cd "$DIR" && pwd)
ENV="$DIR/$ENV_FILE_NAME"
[ -f "$ENV" ] || die "no $ENV_FILE_NAME in $DIR"
pick_docker || die "Docker isn't reachable"
INSTANCE=$(env_get "$ENV" AGORA_INSTANCE); INSTANCE=${INSTANCE:-agora}
PROJECT=$(env_get "$ENV" COMPOSE_PROJECT_NAME); PROJECT=${PROJECT:-$INSTANCE}
VERSION=$(agora_version "$DIR"); VERSION=${VERSION:-unknown}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
[ -n "$OUT" ] || { mkdir -p "$DIR/backups"; chmod 700 "$DIR/backups"; OUT="$DIR/backups/agora-$INSTANCE-$STAMP.agorabk"; }
[ ! -e "$OUT" ] || die "$OUT already exists"

get_passphrase "$PASS_ARG" 1
IMG=$(backend_image "$DIR")
WORK=$(mktemp -d)
STOPPED_BOXES=()
RUNNING=()

RESTARTED=0
# Start again what this backup stopped; runs once, also when the backup fails
restart_stack() {
    [ "$RESTARTED" = 0 ] || return 0
    RESTARTED=1
    [ "${#RUNNING[@]}" -gt 0 ] || return 0
    say "  starting the stack again"
    local s c
    # Writers first, then the edge, then boxd, then the boxes it would start anyway
    for s in postgres redis api runner cap-gateway web caddy socket-proxy box-socket-proxy box-edge boxd; do
        if printf '%s
' "${RUNNING[@]}" | grep -qx "$s"; then compose_in "$DIR" start "$s" >/dev/null 2>&1 || warn "could not start $s"; fi
    done
    for c in "${STOPPED_BOXES[@]:-}"; do [ -z "$c" ] || dk start "$c" >/dev/null 2>&1 || warn "could not start $c"; done
}
cleanup() {
    local code=$1
    set +e
    restart_stack
    forget_passphrase
    rm -rf "$WORK"
    if [ "$code" != 0 ]; then rm -f "$OUT"; say "  no bundle was kept" >&2; fi
    on_exit "$code"
}
trap 'cleanup $?' EXIT

mapfile -t RUNNING < <(compose_in "$DIR" ps --status running --format '{{.Service}}' 2>/dev/null || true)
printf '%s\n' "${RUNNING[@]:-}" | grep -qx postgres || die "postgres isn't running; start the stack first ($(compose_cmd_text "$DIR" 'up -d'))"

say "${BOLD}Backing up $INSTANCE ($VERSION) to $OUT${RESET}"

step backup.quiesce 'Stopping boxd and the edge, then every box, then the writers'
# boxd finishes the operation it is in on SIGTERM; give it time to
compose_in "$DIR" stop -t 90 boxd >/dev/null 2>&1 || true
compose_in "$DIR" stop -t 30 box-edge >/dev/null 2>&1 || true
while read -r c; do
    [ -n "$c" ] || continue
    if [ "$(dk inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ]; then
        dk stop -t 30 "$c" >/dev/null
        STOPPED_BOXES+=("$c")
    fi
done < <(box_containers "$INSTANCE")
compose_in "$DIR" stop -t 30 api runner cap-gateway >/dev/null 2>&1 || true
ok "quiet: ${#STOPPED_BOXES[@]} box(es) stopped"

: > "$OUT"
chmod 600 "$OUT"
PARTS="$WORK/parts"
: > "$PARTS"

# add_part <name>: stdin → one encrypted segment appended to the bundle
add_part() {
    crypt "$IMG" encrypt --name "$1" >> "$OUT" 2>> "$PARTS.err" || { cat "$PARTS.err" >&2; die "encrypting $1 failed"; }
    grep "^part $1 " "$PARTS.err" | tail -n 1 >> "$PARTS"
}

step backup.database 'Dumping the database'
compose_in "$DIR" exec -T postgres pg_dump -U accord -d agora --clean --if-exists --no-owner | add_part postgres.sql
ok postgres.sql

step backup.files 'Archiving files-data'
dk run --rm --network none -v "${PROJECT}_files-data:/v:ro" alpine:3.20 tar -C /v -cf - . | add_part files-data.tar
ok files-data.tar

step backup.boxes 'Archiving every box home volume'
BOXES_JSON=''
while IFS='|' read -r vol id; do
    [ -n "$vol" ] || continue
    # shellcheck disable=SC2016 # a Go template, not shell
    labels=$(dk volume inspect -f '{{range $k, $v := .Labels}}{{$k}}={{$v}};{{end}}' "$vol")
    dk run --rm --network none -v "$vol:/v:ro" alpine:3.20 tar -C /v --numeric-owner -cf - . | add_part "boxes/$id-home.tar"
    BOXES_JSON="$BOXES_JSON${BOXES_JSON:+,}{\"id\":\"$id\",\"volume\":\"$vol\",\"labels\":$(printf '%s' "$labels" | json_str)}"
    ok "boxes/$id-home.tar"
done < <(box_volumes "$INSTANCE")

step backup.env 'Adding .env.prod (it holds AGORA_ENCRYPTION_KEY)'
add_part env.prod < "$ENV"

step backup.manifest 'Writing the manifest'
# Box generations and image versions as the database has them (postgres is still up)
ROWS=$(compose_in "$DIR" exec -T postgres psql -U accord -d agora -At -F '|' \
    -c "SELECT lower(trim(id)), generation, coalesce(image_version, 0), desired_state FROM agent_boxes ORDER BY id" 2>/dev/null || true)
DBBOXES=''
while IFS='|' read -r id gen imgv desired; do
    [ -n "$id" ] || continue
    DBBOXES="$DBBOXES${DBBOXES:+,}{\"id\":\"$id\",\"generation\":$gen,\"imageVersion\":$imgv,\"desiredState\":\"$desired\"}"
done <<< "$ROWS"
PARTS_JSON=''
while read -r _ name sha bytes; do
    PARTS_JSON="$PARTS_JSON${PARTS_JSON:+,}{\"name\":\"$name\",\"sha256\":\"$sha\",\"bytes\":$bytes}"
done < "$PARTS"
printf '{"format":1,"instance":"%s","version":"%s","boxVersion":%s,"created":"%s","boxes":[%s],"volumes":[%s],"parts":[%s]}\n' \
    "$INSTANCE" "$VERSION" "$(box_version "$DIR")" "$STAMP" "$DBBOXES" "$BOXES_JSON" "$PARTS_JSON" | add_part manifest.json

step backup.restart 'Starting everything again'
restart_stack

step backup.verify 'Checking the bundle'
n=$(crypt "$IMG" verify < "$OUT" | wc -l) || die "the bundle didn't verify"
FINISHED=1
ok "$n parts verified"
say ''
say "  Backup: $OUT ($(du -h "$OUT" | cut -f1))"
say '  Keep the passphrase somewhere safe: the bundle is useless without it.'
