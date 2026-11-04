#!/usr/bin/env bash
# Upgrade an Agora install, keeping every box's home folder (docs/agent-boxes.md §9.1).
#
#   bash install/upgrade.sh [--dir <install folder>] [--source <checkout> | --ref <tag>]
#                           [--passphrase-file <file>] [--non-interactive]
#   bash install/upgrade.sh --rollback [--dir <install folder>] [--passphrase-file <file>]
#
# Backs up first (install/backup.sh), puts the new release in the folder, rebuilds and starts
# the stack. boxd then rebuilds boxes whose image is older than box/VERSION, one at a time.
# The previous release stays in .previous-release.tar and its backup in backups/, so
# --rollback puts both back.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

DIR=$(cd "$HERE/.." && pwd) SOURCE='' REF=latest PASS_ARG='' ROLLBACK=0 NO_BACKUP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        --source) SOURCE=$2; shift ;;
        --ref) REF=$2; shift ;;
        --passphrase-file) PASS_ARG=$2; shift ;;
        --rollback) ROLLBACK=1 ;;
        --no-backup) NO_BACKUP=1 ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "upgrade.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
DIR=$(cd "$DIR" && pwd)
ENV="$DIR/$ENV_FILE_NAME"
[ -f "$ENV" ] || die "no $ENV_FILE_NAME in $DIR"
pick_docker || die "Docker isn't reachable"
INSTALL_DIR=$DIR DOCTOR_SCRIPT="$DIR/install/doctor.sh"
trap 'on_exit $?' EXIT
TELEMETRY=$(env_get "$ENV" AGORA_TELEMETRY); TELEMETRY=${TELEMETRY:-off}
AGORA_TELEMETRY_URL=$(env_get "$ENV" AGORA_TELEMETRY_URL)
OLD_VERSION=$(agora_version "$DIR")
STATE="$DIR/.agora-upgrade"
pass_args=(); [ -z "$PASS_ARG" ] || pass_args=(--passphrase-file "$PASS_ARG")
ni_args=(); [ "$NON_INTERACTIVE" = 0 ] || ni_args=(--non-interactive)

copy_tree() { # copy_tree <from> <to>: a release over an install, never its config, data or backups
    tar -C "$1" --exclude=./.git --exclude='*/node_modules' --exclude=./node_modules --exclude=./dist \
        --exclude=./.env --exclude=./.env.prod --exclude='./.env.prod.*' --exclude=./backups --exclude=./.claude \
        --exclude=./.previous-release.tar --exclude=./.agora-upgrade --exclude=./.agora-install --exclude=./.agora-url \
        -cf - . | tar -C "$2" -xf -
}

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
    [ -f "$DIR/.previous-release.tar" ] && [ -f "$STATE" ] || die "no previous release recorded in $DIR"
    bundle=$(sed -n 's/^backup=//p' "$STATE")
    [ -n "$bundle" ] && [ -f "$bundle" ] || die "the backup taken before the upgrade ($bundle) is gone"
    tar -C "$DIR" -xf "$DIR/.previous-release.tar"
    compose_in "$DIR" build
    bash "$DIR/install/restore.sh" "$bundle" --dir "$DIR" --yes "${pass_args[@]}" "${ni_args[@]}"
    FINISHED=1
    ok "rolled back to $(agora_version "$DIR")"
    exit 0
fi

AGORA_VERSION=$OLD_VERSION
say "${BOLD}Upgrading $(env_get "$ENV" AGORA_INSTANCE) from $OLD_VERSION${RESET}"

step upgrade.fetch 'Getting the new release'
NEW=$(mktemp -d)
if [ -n "$SOURCE" ]; then
    SOURCE=$(cd "$SOURCE" && pwd)
    [ -f "$SOURCE/$COMPOSE_FILE_NAME" ] || die "$SOURCE is not an Agora checkout"
    [ "$SOURCE" != "$DIR" ] || die "--source is this install folder; give the new checkout"
    copy_tree "$SOURCE" "$NEW"
else
    if [ "$REF" = latest ]; then url="$AGORA_RELEASE_BASE/download/agora-latest"; else url="$AGORA_RELEASE_BASE/download/$REF"; fi
    curl -fsSL -o "$NEW/agora.tar.gz" "$url/agora.tar.gz"
    curl -fsSL -o "$NEW/agora.tar.gz.sha256" "$url/agora.tar.gz.sha256"
    (cd "$NEW" && sha256sum -c agora.tar.gz.sha256 >/dev/null) || die "the download doesn't match its SHA-256"
    mkdir "$NEW/src"
    tar -xzf "$NEW/agora.tar.gz" -C "$NEW/src" --strip-components=1
    rm -f "$NEW/agora.tar.gz" "$NEW/agora.tar.gz.sha256"
    mv "$NEW/src" "$NEW.src"; rm -rf "$NEW"; NEW="$NEW.src"
fi
NEW_VERSION=$(agora_version "$NEW")
ok "Agora $NEW_VERSION (box image $(box_version "$NEW"))"

if [ "$NO_BACKUP" = 1 ]; then
    warn "--no-backup: there is nothing to roll back to"
    bundle=''
else
    step upgrade.backup 'Backing up first'
    mkdir -p "$DIR/backups"
    bundle="$DIR/backups/agora-$(env_get "$ENV" AGORA_INSTANCE)-before-$NEW_VERSION-$(date -u +%Y%m%dT%H%M%SZ).agorabk"
    bash "$DIR/install/backup.sh" --dir "$DIR" --out "$bundle" "${pass_args[@]}" "${ni_args[@]}"
fi

step upgrade.replace 'Putting the new release in place'
tar -C "$DIR" --exclude=./.env --exclude=./.env.prod --exclude='./.env.prod.*' --exclude=./backups \
    --exclude=./.previous-release.tar --exclude=./.agora-upgrade -cf "$DIR/.previous-release.tar.new" .
mv "$DIR/.previous-release.tar.new" "$DIR/.previous-release.tar"
printf 'from=%s\nto=%s\nbackup=%s\nat=%s\n' "$OLD_VERSION" "$NEW_VERSION" "$bundle" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE"
copy_tree "$NEW" "$DIR"
rm -rf "$NEW"
AGORA_VERSION=$NEW_VERSION

step upgrade.config 'Adding settings this release needs'
# Installs from before agent boxes have no edge secret; compose refuses to start without one
[ -n "$(env_get "$ENV" AGORA_EDGE_SECRET)" ] || { env_set "$ENV" AGORA_EDGE_SECRET "$(hex64)"; ok 'generated AGORA_EDGE_SECRET'; }
env_set "$ENV" AGORA_BOX_VERSION "$(box_version "$DIR")"
[ -n "$(env_get "$ENV" AGORA_TELEMETRY)" ] || env_set "$ENV" AGORA_TELEMETRY off
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
say "  To go back: bash install/upgrade.sh --rollback --dir $DIR"
