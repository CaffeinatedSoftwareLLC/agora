#!/usr/bin/env bash
# Back up an Agora install, every box included (docs/agent-boxes.md §9.4).
#
#   bash install/backup.sh [--dir <install folder>] [--out <file>] [--passphrase-file <file>]
#                          [--crypt-image <image>]
#
# Quiesces what changes box state (boxd and the edge, then every box, then api, runner and
# cap-gateway), checks that they really are stopped, dumps the database and archives
# files-data and every box home volume, checks that every box the database knows has its
# volume in the bundle, then starts again exactly what it stopped (also when it fails). The
# result is one bundle, encrypted with a passphrase you choose: postgres.sql, files-data.tar,
# boxes/<boxId>-home.tar, env.prod and manifest.json. Without the passphrase it can't be
# restored. Any failure (a stop, a listing, a dump) leaves no bundle.
#
# --crypt-image: the image with dist/src/tools/backup-crypt.js (default: this install's backend
# image). install/upgrade.sh passes one built from the new release.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/bundle.sh
. "$HERE/lib/bundle.sh"

DIR=$(cd "$HERE/.." && pwd) OUT='' PASS_ARG='' CRYPT_ARG=''
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        --out) OUT=$2; shift ;;
        --passphrase-file) PASS_ARG=$2; shift ;;
        --crypt-image) CRYPT_ARG=$2; shift ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        *) echo "backup.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
DIR=$(cd "$DIR" && pwd)
ENV="$DIR/$ENV_FILE_NAME"
[ -f "$ENV" ] || die "no $ENV_FILE_NAME in $DIR"
pick_docker || die "Docker isn't reachable"
PROJECT=$(install_project "$DIR") || die "can't tell the Compose project name of the install in $DIR"
INSTANCE=$(install_instance "$DIR")
VERSION=$(agora_version "$DIR"); VERSION=${VERSION:-unknown}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
[ -n "$OUT" ] || { mkdir -p "$DIR/backups"; chmod 700 "$DIR/backups"; OUT="$DIR/backups/agora-$INSTANCE-$STAMP.agorabk"; }
[ ! -e "$OUT" ] || die "$OUT already exists"

# The writers, in the order they are stopped; started again in the reverse order
QUIESCE=(boxd box-edge api runner cap-gateway)
STOPPED_SVCS=()
STOPPED_BOXES=()
WORK=$(mktemp -d)
BUNDLE_DONE=0
RESTARTED=0

# Start again exactly what this backup stopped; runs once, also when the backup fails.
# Returns non-zero if anything didn't start.
restart_stack() {
    [ "$RESTARTED" = 0 ] || return 0
    RESTARTED=1
    local i s c bad=0
    [ "${#STOPPED_SVCS[@]}" -eq 0 ] && [ "${#STOPPED_BOXES[@]}" -eq 0 ] && return 0
    say "  starting again what the backup stopped"
    for (( i=${#STOPPED_SVCS[@]}-1; i>=0; i-- )); do
        s=${STOPPED_SVCS[$i]}
        # boxd starts after the writers and the edge it attaches to
        [ "$s" = boxd ] && continue
        compose_in "$DIR" start "$s" >/dev/null 2>&1 || { warn "could not start $s"; bad=1; }
    done
    for s in "${STOPPED_SVCS[@]}"; do
        [ "$s" = boxd ] || continue
        compose_in "$DIR" start boxd >/dev/null 2>&1 || { warn "could not start boxd"; bad=1; }
    done
    for c in "${STOPPED_BOXES[@]}"; do dk start "$c" >/dev/null 2>&1 || { warn "could not start $c"; bad=1; }; done
    [ "$bad" = 0 ]
}
cleanup() {
    local code=$1
    set +e
    if ! restart_stack; then
        say "  Some of the stack didn't start again; start it with: $(compose_cmd_text "$DIR" 'up -d')" >&2
        [ "$code" != 0 ] || code=1
    fi
    forget_passphrase
    rm -rf "$WORK"
    if [ "$BUNDLE_DONE" = 0 ] && [ -n "$OUT" ]; then rm -f "$OUT"; say "  no bundle was kept" >&2; fi
    on_exit "$code"
    exit "$code"
}
trap 'cleanup $?' EXIT

mapfile -t RUNNING < <(running_services "$DIR" || echo '__list_failed__')
printf '%s\n' "${RUNNING[@]}" | grep -qx '__list_failed__' && die "can't list this install's containers (docker compose ps failed)"
printf '%s\n' "${RUNNING[@]}" | grep -qx postgres || die "postgres isn't running; start the stack first ($(compose_cmd_text "$DIR" 'up -d'))"
is_running() { printf '%s\n' "${RUNNING[@]}" | grep -qx "$1"; }

get_passphrase "$PASS_ARG" 1
use_crypt_image "$DIR" "$CRYPT_ARG"

say "${BOLD}Backing up $INSTANCE ($VERSION) to $OUT${RESET}"

step backup.quiesce 'Stopping boxd and the edge, then every box, then the writers'
stop_svc() {
    # Recorded before the call: a stop that fails half way still gets a start afterwards
    STOPPED_SVCS+=("$1")
    compose_in "$DIR" stop -t "$2" "$1" >/dev/null || die "could not stop $1; nothing was backed up"
}
# boxd finishes the operation it is in on SIGTERM (stop_grace_period 90s)
if is_running boxd; then stop_svc boxd 90; fi
if is_running box-edge; then stop_svc box-edge 30; fi
boxes=$(box_containers "$INSTANCE") || die "can't list this install's box containers"
while read -r c; do
    [ -n "$c" ] || continue
    st=$(dk inspect -f '{{.State.Running}}' "$c") || die "can't inspect box container $c"
    if [ "$st" = true ]; then
        STOPPED_BOXES+=("$c")
        dk stop -t 30 "$c" >/dev/null || die "could not stop box container $c"
    fi
done <<< "$boxes"
for s in api runner cap-gateway; do if is_running "$s"; then stop_svc "$s" 30; fi; done

# Quiet means quiet: none of the writers and no box may still run
still=$(running_services "$DIR") || die "can't list this install's containers after stopping them"
for s in "${QUIESCE[@]}"; do
    printf '%s\n' "$still" | grep -qx "$s" && die "$s is still running after the stop"
done
boxes=$(box_containers "$INSTANCE") || die "can't list this install's box containers"
while read -r c; do
    [ -n "$c" ] || continue
    [ "$(dk inspect -f '{{.State.Running}}' "$c")" = false ] || die "box container $c is still running"
done <<< "$boxes"
ok "quiet: ${#STOPPED_SVCS[@]} service(s) and ${#STOPPED_BOXES[@]} box(es) stopped"

: > "$OUT"
chmod 600 "$OUT"
PARTS="$WORK/parts"
: > "$PARTS"

# add_part <name>: stdin → one encrypted segment appended to the bundle
add_part() {
    crypt encrypt --name "$1" >> "$OUT" 2>> "$PARTS.err" || { cat "$PARTS.err" >&2; die "encrypting $1 failed"; }
    grep "^part $1 " "$PARTS.err" | tail -n 1 >> "$PARTS"
    grep -q "^part $1 " "$PARTS" || die "encrypting $1 reported no checksum"
}

step backup.database 'Dumping the database'
compose_in "$DIR" exec -T postgres pg_dump -U accord -d agora --clean --if-exists --no-owner | add_part postgres.sql
ok postgres.sql

step backup.files 'Archiving files-data'
dk volume inspect "${PROJECT}_files-data" >/dev/null || die "no ${PROJECT}_files-data volume"
dk run --rm --network none -v "${PROJECT}_files-data:/v:ro" alpine:3.20 tar -C /v -cf - . | add_part files-data.tar
ok files-data.tar

step backup.boxes 'Archiving every box home volume'
vols=$(box_volumes "$INSTANCE") || die "can't list this install's volumes"
BOXES_JSON=''
ARCHIVED=()
while IFS='|' read -r vol id; do
    [ -n "$vol" ] || continue
    # shellcheck disable=SC2016 # a Go template, not shell
    labels=$(dk volume inspect -f '{{range $k, $v := .Labels}}{{$k}}={{$v}};{{end}}' "$vol") || die "can't inspect $vol"
    dk run --rm --network none -v "$vol:/v:ro" alpine:3.20 tar -C /v --numeric-owner -cf - . | add_part "boxes/$id-home.tar"
    BOXES_JSON="$BOXES_JSON${BOXES_JSON:+,}{\"id\":\"$id\",\"volume\":\"$vol\",\"labels\":$(printf '%s' "$labels" | json_str)}"
    ARCHIVED+=("$id")
    ok "boxes/$id-home.tar"
done <<< "$vols"

step backup.reconcile "Checking every box the database knows is in the bundle"
DBBOXES=''
has=0
db_has_boxes && has=1 || { r=$?; [ "$r" = 1 ] || die "can't ask the database about its boxes"; }
if [ "$has" = 1 ]; then
    # Every box boxd has created a container for (image_version set) has a home volume, unless it
    # was deleted and its 7 days are over
    ROWS=$(compose_in "$DIR" exec -T postgres psql -U accord -d agora -At -F '|' -v ON_ERROR_STOP=1 \
        -c "SELECT lower(trim(id)), generation, coalesce(image_version, 0), desired_state,
                   (image_version IS NOT NULL AND (deleted_at IS NULL OR volume_purge_after > now()))::text
            FROM agent_boxes ORDER BY id") || die "can't read the boxes from the database"
    missing=()
    while IFS='|' read -r id gen imgv desired need; do
        [ -n "$id" ] || continue
        DBBOXES="$DBBOXES${DBBOXES:+,}{\"id\":\"$id\",\"generation\":$gen,\"imageVersion\":$imgv,\"desiredState\":\"$desired\"}"
        if [ "$need" = true ] && ! printf '%s\n' "${ARCHIVED[@]:-}" | grep -qx "$id"; then missing+=("$id"); fi
    done <<< "$ROWS"
    [ "${#missing[@]}" -eq 0 ] || die "box(es) ${missing[*]} have no home volume to back up; the bundle would be incomplete"
    ok "${#ARCHIVED[@]} box volume(s) match the database"
else
    [ "${#ARCHIVED[@]}" -eq 0 ] || die "box volumes exist but the database has no box tables"
    ok 'no agent boxes in this install'
fi

step backup.env 'Adding .env.prod (it holds AGORA_ENCRYPTION_KEY)'
add_part env.prod < "$ENV"

step backup.manifest 'Writing the manifest'
PARTS_JSON=''
while read -r _ name sha bytes; do
    PARTS_JSON="$PARTS_JSON${PARTS_JSON:+,}{\"name\":\"$name\",\"sha256\":\"$sha\",\"bytes\":$bytes}"
done < "$PARTS"
printf '{"format":1,"instance":"%s","version":"%s","boxVersion":%s,"created":"%s","boxes":[%s],"volumes":[%s],"parts":[%s]}\n' \
    "$INSTANCE" "$VERSION" "$(box_version "$DIR")" "$STAMP" "$DBBOXES" "$BOXES_JSON" "$PARTS_JSON" | add_part manifest.json

step backup.verify 'Checking the bundle'
n=$(crypt verify < "$OUT" | grep -c '^part ') || die "the bundle didn't verify"
[ "$n" = "$(( $(wc -l < "$PARTS") ))" ] || die "the bundle has $n parts, $(wc -l < "$PARTS") were written"
BUNDLE_DONE=1
ok "$n parts verified"

step backup.restart 'Starting again what was stopped'
restart_stack || die "the backup is complete ($OUT), but part of the stack didn't start again"
FINISHED=1
say ''
say "  Backup: $OUT ($(du -h "$OUT" | cut -f1))"
say '  Keep the passphrase somewhere safe: the bundle is useless without it.'
