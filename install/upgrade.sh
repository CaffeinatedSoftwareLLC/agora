#!/usr/bin/env bash
# Upgrade an Agora install, keeping every box's home folder (docs/agent-boxes.md §9.1).
#
#   bash <new release>/install/upgrade.sh --dir <install folder> [--passphrase-file <file>]
#   bash install/upgrade.sh [--dir <install folder>] [--source <checkout> | --ref <tag>] ...
#   bash install/upgrade.sh --rollback [--dir <install folder>] [--passphrase-file <file>]
#
# Run from a new release (or with --source / --ref) it upgrades the install in --dir to that
# release, also an install from before agent boxes that has no install/ folder and no backup
# tool of its own:
#   1. builds a maintenance image (agora/maintenance:<new version>) from the new release, before
#      touching the running stack; it carries the backup tool;
#   2. backs up with the new release's backup.sh and that image, reading the old stack;
#   3. moves the old release's files to .releases/<old version>-<time>/ and puts the new one in
#      their place (so nothing of either release is left in the other);
#   4. adds the settings the new release needs (AGORA_EDGE_SECRET, AGORA_BOX_VERSION), builds and
#      starts it. boxd then rebuilds boxes on an older image one at a time.
# --rollback moves the new release out the same way, puts the previous one back and restores
# the backup taken before the upgrade.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/bundle.sh
. "$HERE/lib/bundle.sh"
# shellcheck source=lib/release.sh
. "$HERE/lib/release.sh"

SELF=$(cd "$HERE/.." && pwd)
DIR='' SOURCE='' REF='' PASS_ARG='' ROLLBACK=0 NO_BACKUP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        --source) SOURCE=$2; shift ;;
        --ref) REF=$2; shift ;;
        --passphrase-file) PASS_ARG=$2; shift ;;
        --rollback) ROLLBACK=1 ;;
        --no-backup) NO_BACKUP=1 ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "upgrade.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
DIR=$(cd "${DIR:-$SELF}" && pwd)
ENV="$DIR/$ENV_FILE_NAME"
[ -f "$ENV" ] || die "no $ENV_FILE_NAME in $DIR"
pick_docker || die "Docker isn't reachable"
INSTALL_DIR=$DIR DOCTOR_SCRIPT="$SELF/install/doctor.sh"
trap 'on_exit $?' EXIT
TELEMETRY=$(env_get "$ENV" AGORA_TELEMETRY); TELEMETRY=${TELEMETRY:-off}
AGORA_TELEMETRY_URL=$(env_get "$ENV" AGORA_TELEMETRY_URL)
OLD_VERSION=$(agora_version "$DIR"); OLD_VERSION=${OLD_VERSION:-unknown}
STATE="$DIR/.agora-upgrade"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pass_args=(); [ -z "$PASS_ARG" ] || pass_args=(--passphrase-file "$PASS_ARG")
ni_args=(); [ "$NON_INTERACTIVE" = 0 ] || ni_args=(--non-interactive)
state_get() { sed -n "s/^$1=//p" "$STATE" 2>/dev/null | tail -n 1; }

wait_up() {
    local api deadline
    api=$(env_get "$ENV" AGORA_API_PORT)
    deadline=$(( $(date +%s) + 300 ))
    until curl -fsS -m 5 "http://127.0.0.1:${api:-3000}/health" 2>/dev/null | grep -q '"ok"'; do
        [ "$(date +%s)" -lt "$deadline" ] || die "the API didn't come back within 5 minutes"
        sleep 3
    done
}

if [ "$ROLLBACK" = 1 ]; then
    step upgrade.rollback 'Putting the previous release and its backup back'
    [ -f "$STATE" ] || die "no upgrade recorded in $DIR"
    prev=$(state_get previous)
    bundle=$(state_get backup)
    maint=$(state_get maintenance)
    [ -n "$prev" ] && [ -d "$prev" ] || die "the previous release ($prev) is gone"
    [ -n "$bundle" ] && [ -f "$bundle" ] || die "the backup taken before the upgrade (${bundle:-none}) is gone"
    cur="$DIR/.releases/$(tag_version "$OLD_VERSION")-rolled-back-$STAMP"
    compose_in "$DIR" stop -t 60 >/dev/null || die "could not stop the stack"
    stash_release "$DIR" "$cur"
    place_release "$prev" "$DIR"
    ok "release $(agora_version "$DIR") is back in place (the newer one is in $cur)"
    # The old release may have no backup tool or restore script: use the newer release's, with
    # the maintenance image it built (rebuilt from it if it was removed)
    if [ -z "$maint" ] || ! has_crypt_tool "$maint"; then maint=$(build_maintenance_image "$cur") || die "could not build the maintenance image"; fi
    compose_in "$DIR" build
    bash "$cur/install/restore.sh" "$bundle" --dir "$DIR" --yes --crypt-image "$maint" "${pass_args[@]}" "${ni_args[@]}"
    printf 'rolled_back=%s\n' "$STAMP" >> "$STATE"
    FINISHED=1
    ok "rolled back to $(agora_version "$DIR")"
    exit 0
fi

AGORA_VERSION=$OLD_VERSION
# Before anything changes: an install from before #209 gets its Compose project name written
# down as COMPOSE_PROJECT_NAME and AGORA_INSTANCE, so the new release keeps the same containers,
# volumes and networks and boxd finds the edge under that name
pin_identity "$DIR"
say "${BOLD}Upgrading $(env_get "$ENV" AGORA_INSTANCE) from $OLD_VERSION${RESET}"

step upgrade.fetch 'Getting the new release'
STAGE="$DIR/.releases/incoming-$STAMP"
mkdir -p "$DIR/.releases"
if [ -z "$SOURCE" ] && [ -z "$REF" ] && [ "$SELF" != "$DIR" ]; then SOURCE=$SELF; fi
if [ -n "$SOURCE" ]; then
    SOURCE=$(cd "$SOURCE" && pwd)
    [ -f "$SOURCE/$COMPOSE_FILE_NAME" ] || die "$SOURCE is not an Agora checkout"
    [ "$SOURCE" != "$DIR" ] || die "--source is this install folder; give the new release"
    mkdir -p "$STAGE"
    place_release "$SOURCE" "$STAGE"
else
    if [ -z "$REF" ] || [ "$REF" = latest ]; then url="$AGORA_RELEASE_BASE/latest/download"; else url="$AGORA_RELEASE_BASE/download/$REF"; fi
    dl=$(mktemp -d)
    curl -fsSL -o "$dl/agora.tar.gz" "$url/agora.tar.gz"
    curl -fsSL -o "$dl/agora.tar.gz.sha256" "$url/agora.tar.gz.sha256"
    (cd "$dl" && sha256sum -c agora.tar.gz.sha256 >/dev/null) || die "the download doesn't match its SHA-256"
    mkdir -p "$STAGE"
    tar -xzf "$dl/agora.tar.gz" -C "$STAGE" --strip-components=1
    rm -rf "$dl"
fi
[ -f "$STAGE/install/backup.sh" ] || die "the new release has no install/backup.sh"
NEW_VERSION=$(agora_version "$STAGE")
ok "Agora $NEW_VERSION (box image $(box_version "$STAGE"))"

step upgrade.maintenance 'Building the maintenance image from the new release'
MAINT=$(build_maintenance_image "$STAGE") || die "could not build the maintenance image from the new release"
has_crypt_tool "$MAINT" || die "$MAINT has no backup tool"
ok "$MAINT"

if [ "$NO_BACKUP" = 1 ]; then
    warn "--no-backup: there is nothing to roll back to"
    bundle=''
else
    step upgrade.backup 'Backing up the running install first (the new release'"'"'s backup, the old stack)'
    mkdir -p "$DIR/backups"
    chmod 700 "$DIR/backups"
    bundle="$DIR/backups/agora-$(env_get "$ENV" AGORA_INSTANCE)-before-$(tag_version "$NEW_VERSION")-$STAMP.agorabk"
    bash "$STAGE/install/backup.sh" --dir "$DIR" --out "$bundle" --crypt-image "$MAINT" "${pass_args[@]}" "${ni_args[@]}"
fi

step upgrade.replace 'Moving the old release aside and putting the new one in place'
PREV="$DIR/.releases/$(tag_version "$OLD_VERSION")-$STAMP"
stash_release "$DIR" "$PREV"
place_release "$STAGE" "$DIR"
rm -rf "$STAGE"
printf 'from=%s\nto=%s\nbackup=%s\nprevious=%s\nmaintenance=%s\nat=%s\n' \
    "$OLD_VERSION" "$NEW_VERSION" "$bundle" "$PREV" "$MAINT" "$STAMP" > "$STATE"
# Only the release just replaced is kept for --rollback
for old in "$DIR"/.releases/*; do
    [ -d "$old" ] && [ "$old" != "$PREV" ] && rm -rf "$old"
done
AGORA_VERSION=$NEW_VERSION
ok "the previous release is in $PREV"

step upgrade.config 'Adding settings this release needs'
# Installs from before agent boxes have no edge secret; compose refuses to start without one
[ -n "$(env_get "$ENV" AGORA_EDGE_SECRET)" ] || { env_set "$ENV" AGORA_EDGE_SECRET "$(hex64)"; ok 'generated AGORA_EDGE_SECRET'; }
env_set "$ENV" AGORA_BOX_VERSION "$(box_version "$DIR")"
[ -n "$(env_get "$ENV" AGORA_TELEMETRY)" ] || env_set "$ENV" AGORA_TELEMETRY off
[ -n "$(env_get "$ENV" DOCKER_GID)" ] || { g=$(getent group docker | cut -d: -f3 || true); [ -z "$g" ] || env_set "$ENV" DOCKER_GID "$g"; }
ok "AGORA_BOX_VERSION=$(box_version "$DIR")"

step upgrade.build 'Building the new images'
compose_in "$DIR" build

step upgrade.start 'Starting the new release'
compose_in "$DIR" up -d --remove-orphans
wait_up
FINISHED=1
send_install_report ok null
say ''
say "  Upgraded to $NEW_VERSION. boxd rebuilds boxes on an older image one at a time; each posts a notice in its home channel."
say "  To go back: bash $DIR/install/upgrade.sh --rollback --dir $DIR"
