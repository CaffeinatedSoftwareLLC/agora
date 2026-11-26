#!/usr/bin/env bash
# Where an upgrade's backup lives, how much room an upgrade needs, and what is cleaned up after it.
# Sourced by install/upgrade.sh and by install/macos/agora-vm.sh, so it must run on bash 3.2 (the
# Mac's own) and use no GNU-only options. Needs install/lib/common.sh first.
#
# The rule behind it (docs/installing.md, "Backups"): a backup that sits in the same VM, WSL
# distro or disk as the install is lost with it. An upgrade's backup is copied out of the VM or
# distro, and the copy checked, before the upgrade changes anything.

# shellcheck disable=SC2034  # the constants are read by the scripts that source this file
# Upgrade backups are named agora-<instance>-before-<version>-<time>.agorabk; one made with the
# backup command is agora-<instance>-<time>.agorabk and is never removed by retention.
DEFAULT_KEEP_BACKUPS=3
# What an upgrade needs for the new images and their build, when nothing says otherwise (GB)
UPGRADE_BUILD_GB=${AGORA_UPGRADE_BUILD_GB:-6}
# The backup's size when no earlier bundle exists to go by (GB); the data is not measured
UPGRADE_BACKUP_FALLBACK_GB=${AGORA_UPGRADE_BACKUP_GB:-2}

bk_size() { wc -c < "$1" | tr -d ' '; }
bk_sha256() {
    if have sha256sum; then sha256sum "$1" | awk '{print $1}'
    else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# kb_text <kb>: "3.4 GB"
kb_text() { awk -v k="${1:-0}" 'BEGIN { printf "%.1f GB", k / 1048576 }'; }

# free_kb <path>: free space where the path is (or would be created: the nearest folder above it)
free_kb() {
    local p=$1
    while [ -n "$p" ] && [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done
    df -Pk "$p" 2>/dev/null | awk 'NR==2 {print $4}'
}
# device_of <path>: what the path's free space is shared with (two folders on one disk add up)
device_of() {
    local p=$1
    while [ -n "$p" ] && [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done
    df -Pk "$p" 2>/dev/null | awk 'NR==2 {print $1 ":" $6}'
}

# ─── Where the backup goes ───

# Lima's guest has its cloud-init ISO at /mnt/lima-cidata and its agent in /usr/local/bin
is_lima() { [ "${AGORA_ASSUME_LIMA:-0}" = 1 ] || [ -d /mnt/lima-cidata ] || [ -e /usr/local/bin/lima-guestagent ]; }
is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; }

# windows_backup_dir: the Windows user's "Agora Backups" folder as WSL sees it (/mnt/c/...),
# through the Windows side's own %USERPROFILE%. Fails when it can't be resolved.
windows_backup_dir() {
    local up wp
    have cmd.exe && have wslpath || return 1
    up=$(cd / && cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r' | tail -n 1) || return 1
    [ -n "$up" ] && [ "$up" != '%USERPROFILE%' ] || return 1
    wp=$(wslpath -u "$up" 2>/dev/null) || return 1
    [ -d "$wp" ] || return 1
    printf '%s/Agora Backups' "$wp"
}

# copy_bundle_verified <bundle> <folder>: copies it into the folder (0700) and checks the copy's
# size and SHA-256 against the original. Prints the copy's path. On any failure removes the
# partial copy, says why on stderr and fails.
copy_bundle_verified() {
    local src=$1 dir=$2 dest part err s1 s2 h1 h2
    dest="$dir/$(basename "$src")"
    part="$dest.part"
    if ! mkdir -p "$dir" 2>/dev/null; then echo "can't create $dir" >&2; return 1; fi
    chmod 700 "$dir" 2>/dev/null || true
    if ! err=$(cp "$src" "$part" 2>&1); then rm -f "$part"; echo "copying to $dir failed: $err" >&2; return 1; fi
    s1=$(bk_size "$src"); s2=$(bk_size "$part")
    if [ "$s1" != "$s2" ]; then rm -f "$part"; echo "the copy in $dir is $s2 bytes, the backup is $s1 bytes" >&2; return 1; fi
    h1=$(bk_sha256 "$src"); h2=$(bk_sha256 "$part")
    if [ "$h1" != "$h2" ]; then rm -f "$part"; echo "the copy in $dir has another SHA-256 than the backup ($h2, expected $h1)" >&2; return 1; fi
    chmod 600 "$part" 2>/dev/null || true
    mv "$part" "$dest" || { rm -f "$part"; echo "can't put the copy in place in $dir" >&2; return 1; }
    printf '%s' "$dest"
}

# ─── Retention ───

# prune_upgrade_backups <folder> <instance> <keep> <protect file>: removes the "before-<version>"
# bundles of this instance beyond the newest <keep> (0: all are kept). Never touches a bundle made
# with the backup command, and never the protected file. Prints one line per removal, then a total.
prune_upgrade_backups() {
    local dir=$1 inst=$2 keep=$3 protect=${4:-} f b n=0 freed=0 sz list=''
    [ "$keep" != 0 ] && [ -d "$dir" ] || return 0
    # newest first; the bundle's own name carries the time, so sort by name's stamp, not by mtime
    for f in "$dir"/agora-"$inst"-before-*.agorabk; do
        [ -f "$f" ] || continue
        b=$(basename "$f")
        printf '%s' "$b" | grep -Eq -- '-[0-9]{8}T[0-9]{6}Z\.agorabk$' || continue
        list="$list$(printf '%s' "$b" | sed 's/\.agorabk$//; s/.*-//') $b
"
    done
    list=$(printf '%s' "$list" | sort -r | awk '{print $2}')
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        n=$((n + 1))
        [ "$n" -gt "$keep" ] || continue
        [ "$dir/$f" != "$protect" ] || continue
        sz=$(bk_size "$dir/$f")
        if rm -f "$dir/$f"; then
            freed=$((freed + sz))
            say "  removed old upgrade backup $dir/$f ($(awk -v b="$sz" 'BEGIN { printf "%.1f GB", b / 1073741824 }'))"
        else
            warn "could not remove $dir/$f"
        fi
    done <<< "$list"
    PRUNED_BYTES=$((${PRUNED_BYTES:-0} + freed))
}

# ─── Space ───

# newest_backup_kb <folder>: the size of the largest bundle in the folder (what the next is expected to be)
largest_backup_kb() {
    local dir=$1 f best=0 s
    for f in "$dir"/*.agorabk; do
        [ -f "$f" ] || continue
        s=$(( $(bk_size "$f") / 1024 + 1 ))
        [ "$s" -le "$best" ] || best=$s
    done
    echo "$best"
}

# expected_backup_kb <folder...>: the largest bundle already in any of the folders, else the fallback
expected_backup_kb() {
    local best=0 d s
    for d in "$@"; do
        s=$(largest_backup_kb "$d")
        [ "$s" -le "$best" ] || best=$s
    done
    [ "$best" -gt 0 ] || best=$((UPGRADE_BACKUP_FALLBACK_GB * 1048576))
    echo "$best"
}

# SPACE_NEEDS: lines "<path>|<kb>|<what it is for>", filled by space_need, checked by space_check
SPACE_NEEDS=''
space_need() { SPACE_NEEDS="${SPACE_NEEDS}$1|$2|$3
"; }

# space_check <hint>: for each disk the needs land on (needs on one disk are added up), is there
# room? Prints one refusal line per disk that has too little and fails if there was any. A path
# whose free space can't be read is not refused: a check that can't look doesn't block.
space_check() {
    local hint=$1 path dev free total seen='' bad=0 pth
    while IFS='|' read -r path _ _; do
        [ -n "$path" ] || continue
        dev=$(device_of "$path"); [ -n "$dev" ] || continue
        case " $seen " in *" $dev "*) continue ;; esac
        seen="$seen $dev"
        total=0; pth=''; local whats=''
        while IFS='|' read -r p2 k2 w2; do
            [ -n "$p2" ] || continue
            [ "$(device_of "$p2")" = "$dev" ] || continue
            total=$((total + k2)); whats="${whats:+$whats, }$w2"; pth=${pth:-$p2}
        done <<< "$SPACE_NEEDS"
        free=$(free_kb "$path"); [ -n "$free" ] || continue
        if [ "$free" -lt "$total" ]; then
            bad=1
            printf '  %s: %s free, the upgrade needs about %s here (%s)\n' "$pth" "$(kb_text "$free")" "$(kb_text "$total")" "$whats" >&2
        fi
    done <<< "$SPACE_NEEDS"
    if [ "$bad" = 1 ]; then
        printf '%s\n' "$hint" >&2
        return 1
    fi
    return 0
}

# ─── Cleaning up after a good upgrade ───

# prune_docker_after_upgrade <install dir> <env file> <keep image tag>...: removes build cache,
# dangling images, and box and maintenance images of versions nothing uses (never an image a
# container uses, never a volume). Prints what Docker says it freed.
prune_docker_after_upgrade() {
    local dir=$1 envf=$2 keep=' ' t out img used
    shift 2
    for t in "$@"; do keep="$keep$t "; done
    keep="$keep$(printf 'agora/box:%s%s' "$(env_get "$envf" AGORA_BOX_VERSION)" "$(env_get "$envf" AGORA_BOX_TAG_SUFFIX)") "
    if out=$(dk builder prune -f 2>&1); then
        printf '%s\n' "$out" | sed -n 's/^Total:/  build cache freed:/p;s/^Total reclaimed space:/  build cache freed:/p'
    else warn "docker builder prune failed: $out"; fi
    if out=$(dk image prune -f 2>&1); then
        printf '%s\n' "$out" | sed -n 's/^Total reclaimed space:/  unused image layers freed:/p'
    else warn "docker image prune failed: $out"; fi
    used=$(dk ps -a --format '{{.Image}}' 2>/dev/null | sort -u || true)
    while IFS= read -r img; do
        [ -n "$img" ] || continue
        case "$img" in agora/box:*|agora/maintenance:*) ;; *) continue ;; esac
        case "$keep" in *" $img "*) continue ;; esac
        printf '%s\n' "$used" | grep -qxF "$img" && { info "kept $img: a box still runs on it (boxd rebuilds them one at a time)"; continue; }
        if out=$(dk image rm "$img" 2>&1); then say "  removed old image $img"
        else info "kept $img: $out"; fi
    done <<< "$(dk image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)"
    return 0
}
