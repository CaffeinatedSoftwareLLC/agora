#!/usr/bin/env bash
# Remove an Agora install from this Docker engine (docs/agent-boxes.md §9.5).
#
#   bash install/uninstall.sh [--dir <install folder>]            # containers and networks
#   bash install/uninstall.sh [--dir <install folder>] --purge    # and every volume (all data)
#
# Without --purge every volume stays: the database, files and every box's home folder, so
# installing again in the same folder brings them back. --purge asks you to type the install
# name first (--confirm <name> without a terminal). The folder itself, with .env.prod and
# backups/, is never deleted.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/bundle.sh
. "$HERE/lib/bundle.sh"

DIR=$(cd "$HERE/.." && pwd) PURGE=0 CONFIRM=''
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        --purge) PURGE=1 ;;
        --confirm) CONFIRM=$2; shift ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "uninstall.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
DIR=$(cd "$DIR" && pwd)
ENV="$DIR/$ENV_FILE_NAME"
[ -f "$ENV" ] || die "no $ENV_FILE_NAME in $DIR"
pick_docker || die "Docker isn't reachable"
INSTANCE=$(install_instance "$DIR" 2>/dev/null) || INSTANCE=agora
trap 'on_exit $?' EXIT

if [ "$PURGE" = 1 ]; then
    say "  --purge deletes every volume of install $INSTANCE: its database, files and every box's home folder."
    if [ -z "$CONFIRM" ]; then
        [ "$NON_INTERACTIVE" = 0 ] && [ -t 0 ] || die "without a terminal, confirm with --confirm $INSTANCE"
        ask CONFIRM "Type the install name ($INSTANCE) to delete them:" ''
    fi
    [ "$CONFIRM" = "$INSTANCE" ] || die "not confirmed; nothing was removed"
fi

step uninstall.boxes 'Removing the box containers'
n=0
while read -r c; do [ -z "$c" ] || { dk rm -f "$c" >/dev/null; n=$((n + 1)); }; done < <(box_containers "$INSTANCE")
ok "$n box container(s)"

step uninstall.stack 'Removing the stack'
if [ "$PURGE" = 1 ]; then compose_in "$DIR" down -v --remove-orphans; else compose_in "$DIR" down --remove-orphans; fi

step uninstall.networks 'Removing the box networks'
n=0
while read -r net; do
    [ -n "$net" ] || continue
    printf '%s' "$net" | grep -Eq "^${INSTANCE}_box_[0-9a-z]{26}\$" || continue
    dk network rm "$net" >/dev/null && n=$((n + 1))
done < <(dk network ls --filter "label=org.agora.instance=$INSTANCE" --format '{{.Name}}')
ok "$n network(s)"

if [ "$PURGE" = 1 ]; then
    step uninstall.volumes 'Deleting the box home volumes'
    n=0
    while IFS='|' read -r vol _; do [ -z "$vol" ] || { dk volume rm -f "$vol" >/dev/null; n=$((n + 1)); }; done < <(box_volumes "$INSTANCE")
    ok "$n volume(s)"
fi

FINISHED=1
say ''
if [ "$PURGE" = 1 ]; then
    say "  Install $INSTANCE is gone from Docker. $DIR is still there (with .env.prod and any backups); delete it yourself if you don't need it."
else
    say "  Install $INSTANCE is stopped and removed; its volumes are kept. Start it again with: $(compose_cmd_text "$DIR" 'up -d')"
fi
