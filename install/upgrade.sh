#!/usr/bin/env bash
# Upgrade an Agora install, keeping every box's home folder (docs/agent-boxes.md §9.1).
#
#   bash <new release>/install/upgrade.sh --dir <install folder> [--passphrase-file <file>]
#   bash install/upgrade.sh [--dir <install folder>] [--source <checkout> | --ref <tag>] ...
#     (in the install folder, with neither: the latest release. It is downloaded, checked against
#     its SHA-256, and its own upgrade.sh then does the upgrade)
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
#   4. adds the settings the new release needs (AGORA_EDGE_SECRET, AGORA_BOX_VERSION), builds it;
#   5. lets code runs in progress finish, recreates the sandbox network when the new release
#      declares other settings for it (lib/sandbox-net.sh), and starts the new release.
#      boxd then rebuilds boxes on an older image one at a time.
# --rollback moves the new release out the same way, puts the previous one back, sets the
# sandbox network back to what that release declares and restores the backup taken before the
# upgrade.
#
# Where the backup goes (docs/installing.md, "Backups"): a backup inside the VM or WSL distro the
# install runs in is lost with it, so it is also copied out, checked, before anything changes:
#   --copy-backup-to DIR   copy the bundle to DIR and check its size and SHA-256; stop if that fails.
#                          In WSL, with no option, the Windows user's "Agora Backups" folder
#   --backup-dir DIR       write the backup to DIR (another disk) instead of <install>/backups
#   --backup-in-vm-only    accept a backup that stays where the install is (WSL; the Mac wrapper)
#   --backup-only          take the backup (and copy it) and stop; --backup-result-file F gets its path
#   --use-backup FILE      continue with a backup already taken and copied out, take none
#   --keep-backups N       keep the newest N upgrade backups per location (default 3; 0: keep all;
#                          remembered as AGORA_KEEP_BACKUPS in .env.prod). The backup command's
#                          bundles are never removed; nothing is removed when the upgrade fails
#   --force                start although the free-space check says there is too little room
#   --no-prune             keep Docker's build cache and old box images after the upgrade
#   --check-space          only run the free-space check
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/bundle.sh
. "$HERE/lib/bundle.sh"
# shellcheck source=lib/release.sh
. "$HERE/lib/release.sh"
# shellcheck source=lib/sandbox-net.sh
. "$HERE/lib/sandbox-net.sh"
# shellcheck source=lib/tailnet.sh
. "$HERE/lib/tailnet.sh"
# shellcheck source=lib/backups.sh
. "$HERE/lib/backups.sh"

SELF=$(cd "$HERE/.." && pwd)
DIR='' SOURCE='' REF='' PASS_ARG='' ROLLBACK=0 NO_BACKUP=0
BACKUP_DIR='' COPY_TO='' KEEP='' FORCE=0 NO_PRUNE=0 BACKUP_ONLY=0 USE_BACKUP='' RESULT_FILE='' CHECK_SPACE=0 VM_ONLY=0
FWD=()
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        --source) SOURCE=$2; shift ;;
        --ref) REF=$2; shift ;;
        --passphrase-file) PASS_ARG=$2; shift ;;
        --rollback) ROLLBACK=1 ;;
        --no-backup) NO_BACKUP=1 ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        --backup-dir) BACKUP_DIR=${2:?--backup-dir needs a folder}; FWD+=("$1" "$2"); shift ;;
        --copy-backup-to) COPY_TO=${2:?--copy-backup-to needs a folder}; FWD+=("$1" "$2"); shift ;;
        --keep-backups) KEEP=${2:?--keep-backups needs a number}; FWD+=("$1" "$2"); shift ;;
        --force) FORCE=1; FWD+=("$1") ;;
        --no-prune) NO_PRUNE=1; FWD+=("$1") ;;
        --backup-in-vm-only) VM_ONLY=1; FWD+=("$1") ;;
        --backup-only) BACKUP_ONLY=1 ;;
        --use-backup) USE_BACKUP=${2:?--use-backup needs a bundle}; shift ;;
        --backup-result-file) RESULT_FILE=${2:?--backup-result-file needs a file}; shift ;;
        --check-space) CHECK_SPACE=1 ;;
        -h|--help) sed -n '2,41p' "$0"; exit 0 ;;
        *) echo "upgrade.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
case "$KEEP" in ''|[0-9]|[0-9][0-9]) ;; *) echo "upgrade.sh: --keep-backups needs a number (0 keeps every backup)" >&2; exit 2 ;; esac
[ -z "$BACKUP_DIR" ] || case "$BACKUP_DIR" in /*) ;; *) echo "upgrade.sh: --backup-dir needs an absolute path" >&2; exit 2 ;; esac
[ -z "$USE_BACKUP" ] || [ -f "$USE_BACKUP" ] || { echo "upgrade.sh: --use-backup: $USE_BACKUP isn't a file" >&2; exit 2; }
DIR=$(cd "${DIR:-$SELF}" && pwd)
ENV="$DIR/$ENV_FILE_NAME"
[ -f "$ENV" ] || die "no $ENV_FILE_NAME in $DIR"
pick_docker || die "Docker isn't reachable"
pass_args=(); [ -z "$PASS_ARG" ] || pass_args=(--passphrase-file "$PASS_ARG")
ni_args=(); [ "$NON_INTERACTIVE" = 0 ] || ni_args=(--non-interactive)

# No release given (run in the install folder itself), or --ref: download it, check it, and let
# that release's own upgrade.sh do the upgrade, as when it is run from an unpacked release. The
# scripts in the install folder are the old release's and know nothing the new one needs.
if [ "$ROLLBACK" = 0 ] && [ -z "$SOURCE" ] && { [ -n "$REF" ] || [ "$SELF" = "$DIR" ]; }; then
    REF=${REF:-latest}
    say "${BOLD}Getting Agora ($REF)${RESET}"
    FETCHED=$(mktemp -d)
    trap 'rm -rf "$FETCHED"' EXIT
    fetch_release_or_die "$REF" "$FETCHED"
    [ -f "$FETCHED/install/upgrade.sh" ] && [ -f "$FETCHED/$COMPOSE_FILE_NAME" ] || die "the download is not an Agora release; nothing was changed"
    ok "Agora $(agora_version "$FETCHED"), checked against its SHA-256"
    nb_args=(); [ "$NO_BACKUP" = 0 ] || nb_args=(--no-backup)
    rc=0
    bash "$FETCHED/install/upgrade.sh" --dir "$DIR" --source "$FETCHED" "${pass_args[@]}" "${ni_args[@]}" "${nb_args[@]}" "${FWD[@]}" || rc=$?
    exit "$rc"
fi

INSTALL_DIR=$DIR DOCTOR_SCRIPT="$SELF/install/doctor.sh"
trap 'on_exit $?' EXIT
TELEMETRY=$(env_get "$ENV" AGORA_TELEMETRY); TELEMETRY=${TELEMETRY:-off}
AGORA_TELEMETRY_URL=$(env_get "$ENV" AGORA_TELEMETRY_URL)
OLD_VERSION=$(agora_version "$DIR"); OLD_VERSION=${OLD_VERSION:-unknown}
STATE="$DIR/.agora-upgrade"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
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
    # The record must be the upgrade that put this release here: a finished one names this
    # folder's version as its target; a pending one is the upgrade that failed half way
    rec_state=$(state_get state)
    rec_to=$(state_get to)
    case "$rec_state" in
        done) [ "$rec_to" = "$OLD_VERSION" ] || die "the recorded upgrade went to $rec_to, but this folder has $OLD_VERSION; not rolling back with a stale record" ;;
        pending) warn "the last upgrade (to $rec_to) didn't finish; putting back the release it replaced" ;;
        *) die "the upgrade record in $STATE is unreadable" ;;
    esac
    prev=$(state_get previous)
    bundle=$(state_get backup)
    maint=$(state_get maintenance)
    [ -n "$prev" ] && [ -d "$prev" ] || die "the previous release ($prev) is gone"
    [ -n "$bundle" ] && [ -f "$bundle" ] || die "the backup taken before the upgrade (${bundle:-none}) is gone"
    cur="$DIR/.releases/$(tag_version "$OLD_VERSION")-rolled-back-$STAMP"
    INST=$(env_get "$ENV" AGORA_INSTANCE); INST=${INST:-agora}
    # Before anything changes: the network must be free to go back to the previous release's settings
    check_sandbox_network "$prev" "$INST"
    drain_code_runs "$DIR" "$INST"
    compose_in "$DIR" stop -t 60 >/dev/null || die "could not stop the stack"
    stash_release "$DIR" "$cur"
    place_release "$prev" "$DIR"
    # Back to the sandbox network the previous release declares (restore.sh starts the stack)
    prepare_sandbox_network "$DIR" "$INST"
    # The box image tag follows the release in the folder: box/Dockerfile refuses another BOX_VERSION
    if [ -f "$DIR/box/VERSION" ]; then env_set "$ENV" AGORA_BOX_VERSION "$(box_version "$DIR")"; fi
    ok "release $(agora_version "$DIR") is back in place (the newer one is in $cur)"
    # The old release may have no backup tool or restore script: use the newer release's, with
    # the maintenance image it built (rebuilt from it if it was removed)
    if [ -z "$maint" ] || ! has_crypt_tool "$maint"; then maint=$(build_maintenance_image "$cur") || die "could not build the maintenance image"; fi
    compose_in "$DIR" build
    bash "$cur/install/restore.sh" "$bundle" --dir "$DIR" --yes --crypt-image "$maint" "${pass_args[@]}" "${ni_args[@]}"
    verify_sandbox_network "$DIR" "$INST"
    printf 'rolled_back=%s\n' "$STAMP" >> "$STATE"
    FINISHED=1
    ok "rolled back to $(agora_version "$DIR")"
    exit 0
fi

AGORA_VERSION=$OLD_VERSION
BK_DIR=${BACKUP_DIR:-$DIR/backups}
WSL_UNRESOLVED=0 COPIED=''
# In WSL the install and its backup die together with the distro: the Windows side gets a copy
if [ "$NO_BACKUP" = 0 ] && [ -z "$COPY_TO" ] && [ "$VM_ONLY" = 0 ] && [ -z "$USE_BACKUP" ] && is_wsl; then
    if COPY_TO=$(windows_backup_dir); then info "WSL: the backup is also copied to $COPY_TO (on Windows)"
    else COPY_TO=''; WSL_UNRESOLVED=1; fi
fi
# In the Mac's Lima VM only the Mac can take the backup out: agora-vm.sh upgrade does that and passes
# --use-backup. Started any other way (an older agora-vm.sh, a shell in the VM) it would keep the
# backup only inside the VM, which is what lost an install's data once.
if is_lima && [ "$NO_BACKUP" = 0 ] && [ -z "$USE_BACKUP" ] && [ -z "$COPY_TO" ] && [ "$VM_ONLY" = 0 ] && [ "$CHECK_SPACE" = 0 ] && [ "$BACKUP_ONLY" = 0 ]; then
    die "this is the Lima VM on a Mac, and a backup taken here stays inside the VM: it is lost if the VM won't start. Nothing was changed. Upgrade from the Mac instead: bash install/macos/agora-vm.sh upgrade (or upgrade-macos.sh from the release page), which copies the backup to ~/Agora Backups first. To keep the backup in the VM anyway: --backup-in-vm-only"
fi
KEEP_GIVEN=$KEEP
[ -n "$KEEP" ] || KEEP=$(env_get "$ENV" AGORA_KEEP_BACKUPS)
KEEP=${KEEP:-$DEFAULT_KEEP_BACKUPS}
case "$KEEP" in ''|*[!0-9]*) KEEP=$DEFAULT_KEEP_BACKUPS ;; esac

# Room for the upgrade, before anything changes: the backup, its copy, the new images and their build
BACKUP_EST_KB=$(expected_backup_kb "$BK_DIR" "$DIR/backups")
BUILD_KB=$((UPGRADE_BUILD_GB * 1048576))
DOCKER_ROOT=$(dk info --format '{{.DockerRootDir}}' 2>/dev/null || true)
[ -d "$DOCKER_ROOT" ] || DOCKER_ROOT=$DIR
SPACE_NEEDS=''
if [ "$NO_BACKUP" = 0 ] && [ -z "$USE_BACKUP" ]; then
    space_need "$BK_DIR" "$BACKUP_EST_KB" 'the backup'
    [ -z "$COPY_TO" ] || space_need "$COPY_TO" "$BACKUP_EST_KB" 'the copy of the backup outside'
fi
space_need "$DOCKER_ROOT" "$BUILD_KB" 'the new images and their build'
space_need "$DIR" 512000 "the new release's files"
if ! space_check "  Free some room and run the upgrade again: delete old backups in $DIR/backups, run 'docker builder prune', remove old box images ('docker image ls agora/box', then 'docker image rm <tag>'). To go ahead anyway: --force."; then
    if [ "$FORCE" = 1 ]; then warn "--force: starting although there is little room"
    else die "not enough free space for the upgrade; nothing was changed"; fi
fi
if [ "$CHECK_SPACE" = 1 ]; then
    say "AGORA_BACKUP_EST_KB=$BACKUP_EST_KB"
    ok "enough room for the upgrade (the backup is expected to be about $(kb_text "$BACKUP_EST_KB"))"
    FINISHED=1
    exit 0
fi
# Before anything changes: an install from before #209 gets its Compose project name written
# down as COMPOSE_PROJECT_NAME and AGORA_INSTANCE, so the new release keeps the same containers,
# volumes and networks and boxd finds the edge under that name
pin_identity "$DIR"
say "${BOLD}Upgrading $(env_get "$ENV" AGORA_INSTANCE) from $OLD_VERSION${RESET}"
# Also before anything changes: the compose override files the install runs with (the tailnet
# override), read from its record or, the first time, from its containers, and written down
install_overrides "$DIR"
[ -z "$OVERRIDES" ] || info "keeping its compose override: $OVERRIDES ($([ "$OVERRIDES_SOURCE" = record ] && printf 'recorded' || printf 'found on its containers, now recorded') in $INSTALL_RECORD_NAME)"

step upgrade.fetch 'Getting the new release'
STAGE="$DIR/.releases/incoming-$STAMP"
mkdir -p "$DIR/.releases"
[ -n "$SOURCE" ] || SOURCE=$SELF
SOURCE=$(cd "$SOURCE" && pwd)
[ -f "$SOURCE/$COMPOSE_FILE_NAME" ] || die "$SOURCE is not an Agora checkout"
[ "$SOURCE" != "$DIR" ] || die "--source is this install folder; give the new release"
mkdir -p "$STAGE"
place_release "$SOURCE" "$STAGE"
[ -f "$STAGE/install/backup.sh" ] || die "the new release has no install/backup.sh"
NEW_VERSION=$(agora_version "$STAGE")
ok "Agora $NEW_VERSION (box image $(box_version "$STAGE"))"

step upgrade.maintenance 'Building the maintenance image from the new release'
MAINT=$(build_maintenance_image "$STAGE") || die "could not build the maintenance image from the new release"
has_crypt_tool "$MAINT" || die "$MAINT has no backup tool"
ok "$MAINT"
# Before the backup stops anything: the sandbox network must be free to be recreated if needed
INST=$(env_get "$ENV" AGORA_INSTANCE)
check_sandbox_network "$STAGE" "$INST"

if [ "$NO_BACKUP" = 1 ]; then
    warn "--no-backup: there is nothing to roll back to"
    bundle=''
else
    if [ -n "$USE_BACKUP" ]; then
        step upgrade.backup 'Using the backup taken (and copied out) before'
        bundle=$USE_BACKUP
        ok "$bundle"
    else
        step upgrade.backup 'Backing up the running install first (the new release'"'"'s backup, the old stack)'
        mkdir -p "$BK_DIR"
        chmod 700 "$BK_DIR"
        bundle="$BK_DIR/agora-$(env_get "$ENV" AGORA_INSTANCE)-before-$(tag_version "$NEW_VERSION")-$STAMP.agorabk"
        bash "$STAGE/install/backup.sh" --dir "$DIR" --out "$bundle" --crypt-image "$MAINT" "${pass_args[@]}" "${ni_args[@]}"
        if [ -n "$COPY_TO" ]; then
            step upgrade.backup-copy "Copying the backup out to $COPY_TO and checking the copy"
            if COPIED=$(copy_bundle_verified "$bundle" "$COPY_TO"); then ok "$COPIED (size and SHA-256 match)"
            else die "the backup could not be copied to $COPY_TO, so nothing was changed. The backup itself is $bundle. Fix the folder (space, permissions) and run the upgrade again, or pass --backup-in-vm-only to go on with the backup staying where Agora is"; fi
        fi
    fi
fi
if [ "$BACKUP_ONLY" = 1 ]; then
    [ -z "$RESULT_FILE" ] || printf 'bundle=%s\n' "$bundle" > "$RESULT_FILE"
    rm -rf "$STAGE"
    FINISHED=1
    say ''
    say "  Backup taken: $bundle. Nothing else was changed."
    exit 0
fi

step upgrade.replace 'Moving the old release aside and putting the new one in place'
PREV="$DIR/.releases/$(tag_version "$OLD_VERSION")-$STAMP"
write_state() {
    printf 'state=%s\nfrom=%s\nto=%s\nbackup=%s\nprevious=%s\nmaintenance=%s\nat=%s\n' \
        "$1" "$OLD_VERSION" "$NEW_VERSION" "$bundle" "$PREV" "$MAINT" "$STAMP" > "$STATE.tmp"
    mv "$STATE.tmp" "$STATE"
}
# Recorded before anything moves, so a --rollback after a failure here finds this upgrade, never an older one
write_state pending
stash_release "$DIR" "$PREV"
place_release "$STAGE" "$DIR"
rm -rf "$STAGE"
write_state 'done'
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

step upgrade.drain 'Letting code runs in progress finish'
drain_code_runs "$DIR" "$INST"

step upgrade.network 'Checking the sandbox network'
prepare_sandbox_network "$DIR" "$INST"

step upgrade.start 'Starting the new release'
compose_in "$DIR" up -d --remove-orphans
wait_up
warn_missing_box_clis "$DIR"
verify_sandbox_network "$DIR" "$INST"
FINISHED=1
send_install_report ok null
say ''
say "  Upgraded to $NEW_VERSION. boxd rebuilds boxes on an older image one at a time; each posts a notice in its home channel."
say "  To go back: bash $DIR/install/upgrade.sh --rollback --dir $DIR"

# Only now, with the new release running: say where the backup is, remove what is no longer needed
if [ -n "$bundle" ]; then
    say ''
    say "${BOLD}Backup${RESET}"
    if [ -n "$COPIED" ]; then
        say "  A copy outside where Agora runs is in $COPIED"
    elif [ "$WSL_UNRESOLVED" = 1 ]; then
        warn "THIS UPGRADE'S BACKUP IS ONLY INSIDE THE WSL DISTRO ($bundle). If the distro is lost or will not start, the backup is lost with it. Windows' folder could not be found from here. Copy it out now, for example: cp $bundle /mnt/c/Users/<you>/ (install/windows/install.ps1 -Existing upgrade copies it to %USERPROFILE%\\Agora Backups itself)."
    elif [ "$VM_ONLY" = 1 ]; then
        warn "the backup stays where Agora runs ($bundle), as --backup-in-vm-only asked: if this VM, distro or disk is lost, so is the backup."
    elif [ -n "$USE_BACKUP" ]; then
        say "  Taken and copied out before this step; the copy inside is $bundle"
    elif [ -n "$BACKUP_DIR" ]; then
        say "  $bundle, in the folder --backup-dir named. It is safe from a lost install folder only if that folder is on another disk."
    else
        say "  $bundle is on the same disk as Agora: if that disk fails, both are lost."
        say "  For a backup on another disk: --backup-dir <folder on that disk>, or copy the file there."
    fi
fi
if [ "$KEEP" != 0 ]; then
    PRUNED_BYTES=0
    prune_upgrade_backups "$BK_DIR" "$INST" "$KEEP" "$bundle"
    [ -z "$COPY_TO" ] || prune_upgrade_backups "$COPY_TO" "$INST" "$KEEP" "$COPIED"
    [ "${PRUNED_BYTES:-0}" = 0 ] || say "  freed $(awk -v b="$PRUNED_BYTES" 'BEGIN { printf "%.1f GB", b / 1073741824 }') of old upgrade backups (keeping the newest $KEEP; --keep-backups N changes it, 0 keeps all)"
fi
[ -z "$KEEP_GIVEN" ] || env_set "$ENV" AGORA_KEEP_BACKUPS "$KEEP"
if [ "$NO_PRUNE" = 0 ]; then
    say "${BOLD}Cleaning up Docker${RESET}"
    prune_docker_after_upgrade "$DIR" "$ENV" "$MAINT"
fi
post_start_checks "$DIR" || true
