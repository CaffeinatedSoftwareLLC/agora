#!/bin/bash
# Day-to-day commands for Agora in its Lima VM on a Mac (docs/macos.md). Each one runs the
# Linux install's own script inside the VM and moves files in or out with limactl copy.
#
#   agora-vm.sh status                       the VM, its ports, the keep-alive, the URL
#   agora-vm.sh shell [command...]           a shell in the VM (in the install folder)
#   agora-vm.sh doctor [--report]            this Mac's checks, then install/doctor.sh inside
#   agora-vm.sh backup [--out FILE]          install/backup.sh inside, then the bundle to this Mac
#                                            (default ~/Agora Backups/<name>.agorabk)
#   agora-vm.sh restore FILE [--yes]         a bundle from this Mac into the VM's install
#   agora-vm.sh upgrade                      to the latest release: downloads it, checks its SHA-256,
#                                            copies it in and runs its install/upgrade.sh inside
#                                            (--ref TAG: that release; --source DIR: a checkout).
#                                            First: checks the room, takes the backup, copies it to
#                                            ~/Agora Backups and checks the copy; stops if any fails.
#                                            Then keeps the newest 3 upgrade backups (--keep-backups N,
#                                            0: all), cleans Docker (--no-prune: not), --force: go on
#                                            despite little room, --backup-in-vm-only: the backup stays
#                                            in the VM (lost with it)
#   agora-vm.sh tailnet on|off|status        Tailscale access (docs/remote-access.md): runs the
#                                            install's install/tailnet.sh inside ([--hostname NAME]
#                                            [--install-tailscale] for on)
#   agora-vm.sh stop | start                 stop the VM (and its keep-alive) / start both again
#   agora-vm.sh keepalive agent|daemon|off   start the VM at login (LaunchAgent), at boot
#                                            (LaunchDaemon, sudo once), or not at all
#   Options for all: --vm NAME (default agora), --passphrase-file F (backup, restore, upgrade)
#
# An upgrade keeps the compose override files the install runs with (the tailnet override), and
# ends with checks: Agora's health and, with Tailscale access on, that it is still published.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$HERE/../lib/common.sh"
# shellcheck source=lib/macos.sh
. "$HERE/lib/macos.sh"
# shellcheck source=../lib/backups.sh
. "$HERE/../lib/backups.sh"
# Copies of a passphrase or bundle in the VM go however this ends
FETCHED=''
trap 'guest_cleanup; [ -z "$FETCHED" ] || rm -rf "$FETCHED"' EXIT

CMD=${1:-}
[ $# -eq 0 ] || shift
VM=agora OUT='' FILE='' YES=0 REPORT=0 SRC='' PASS_FILE='' REF='' TS_ARGS=() NI=()
KEEP='' FORCE=0 NO_PRUNE=0 VM_ONLY=0
REST=()
while [ $# -gt 0 ]; do
    case "$1" in
        --vm) VM=${2:?--vm needs a name}; shift ;;
        --out) OUT=${2:?--out needs a file}; shift ;;
        --yes) YES=1 ;;
        --report) REPORT=1 ;;
        --source) SRC=${2:?--source needs a folder}; shift ;;
        --ref) REF=${2:?--ref needs a release tag}; shift ;;
        --hostname) TS_ARGS+=(--hostname "${2:?--hostname needs a name}"); shift ;;
        --install-tailscale) TS_ARGS+=("$1") ;;
        --non-interactive) NI=(--non-interactive) ;;
        --keep-backups) KEEP=${2:?--keep-backups needs a number}; shift ;;
        --force) FORCE=1 ;;
        --no-prune) NO_PRUNE=1 ;;
        --backup-in-vm-only) VM_ONLY=1 ;;
        --passphrase-file) PASS_FILE=${2:?--passphrase-file needs a file}; shift ;;
        -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
        *) if [ "$CMD" = restore ] && [ -z "$FILE" ]; then FILE=$1; else REST+=("$1"); fi ;;
    esac
    shift
done
case "$KEEP" in ''|[0-9]|[0-9][0-9]) ;; *) die "--keep-backups needs a number (0 keeps every upgrade backup)" ;; esac
printf '%s' "$VM" | grep -Eq "$VM_NAME_RE" || die "--vm must be lowercase letters, digits and dashes"
[ -z "$PASS_FILE" ] || [ -r "$PASS_FILE" ] || die "can't read $PASS_FILE"

need_vm() {
    local s; s=$(vm_status "$VM")
    [ -n "$s" ] || die "there is no Lima VM named $VM (limactl list). Install with: bash $HERE/install.sh"
    [ "$s" = Running ] || die "$VM is $s; start it with: bash $0 start --vm $VM"
}
# The install's folder in the VM: the installer's record, else what Compose recorded on its api
install_dir() {
    local d; d=$(state_get "$VM" install_dir)
    [ -n "$d" ] || d=$(guest_install_dirs "$VM" | head -n 1)
    [ -n "$d" ] || die "no Agora install found in $VM"
    printf '%s' "$d"
}
# A 0700 folder in the VM for files that hold secrets; removed by the caller
guest_tmp() { vm_sh "$VM" mktemp -d /tmp/agora-in.XXXXXX | tr -d '\r'; }
pass_args() { # prints nothing; fills GPASS with the passphrase file's path in the VM
    GPASS=()
    [ -z "$PASS_FILE" ] || GPASS=(--passphrase-file "$(copy_secret_in "$VM" "$1" "$PASS_FILE")")
}

case "$CMD" in
    status)
        s=$(vm_status "$VM")
        say "VM:         $VM ${s:-(none)}"
        [ -z "$s" ] && exit 1
        say "Ports:      https $(state_get "$VM" https_port), http $(state_get "$VM" http_port), api $(state_get "$VM" api_port) on 127.0.0.1"
        say "URL:        $(state_get "$VM" url)"
        say "Install:    $(state_get "$VM" install_dir)"
        say "Keep-alive: $(keepalive_kind "$VM")"
        m=$(mac_sleep_minutes); [ -z "$m" ] || say "Mac sleep:  ${m} minutes idle (0: never)"
        ;;
    shell)
        need_vm
        d=$(install_dir)
        if [ "${#REST[@]}" -gt 0 ]; then limactl shell --workdir "$d" "$VM" "${REST[@]}"
        else limactl shell --workdir "$d" "$VM"; fi
        ;;
    doctor)
        fails=0
        say "${BOLD}This Mac${RESET}"
        v=$(lima_version); if [ -n "$v" ]; then say "  ok      Lima $v"; else say "  FAILED  limactl not found"; fails=1; fi
        s=$(vm_status "$VM"); if [ "$s" = Running ]; then say "  ok      VM $VM running"; else say "  FAILED  VM $VM: ${s:-missing}"; fails=1; fi
        k=$(keepalive_kind "$VM"); if [ "$k" != none ]; then say "  ok      keep-alive ($k)"; else say "  note    no keep-alive: the VM won't start by itself after a restart"; fi
        m=$(mac_sleep_minutes); if [ -n "$m" ] && [ "$m" != 0 ]; then say "  note    the Mac sleeps after $m idle minutes, which stops Agora"; fi
        f=$(mac_free_gb "$HOME")
        if [ -n "$f" ] && [ "$f" -lt "$MAC_LOW_DISK_GB" ]; then say "  FAILED  only $f GB free on this Mac: the VM's disk grows into it, and when it is full the VM and Agora stop"; fails=1
        else say "  ok      ${f:-?} GB free on this Mac"; fi
        if [ -d "$HOME/.lima/$VM" ]; then
            perm=$(stat -f %Lp "$HOME/.lima/$VM" 2>/dev/null || stat -c %a "$HOME/.lima/$VM" 2>/dev/null || echo ?)
            if [ "$perm" = 700 ]; then say "  ok      ~/.lima/$VM is yours only (700)"; else say "  note    ~/.lima/$VM is $perm, not 700: its disks hold the install's secrets (chmod 700 ~/.lima/$VM)"; fi
            if command -v tmutil >/dev/null 2>&1 && ! tmutil isexcluded "$HOME/.lima/$VM" 2>/dev/null | grep -q '\[Excluded\]'; then
                say "  note    Time Machine may copy ~/.lima/$VM, secrets included (tmutil addexclusion ~/.lima/$VM; back up with agora-vm.sh backup)"
            fi
        fi
        if [ "$s" = Running ]; then
            # The VM itself (OUTPUT) and its containers (DOCKER-USER); a VM made before the firewall
            # existed has neither, and needs a new VM (uninstall.sh --delete-vm after a backup)
            for chain in OUTPUT DOCKER-USER; do
                who='the VM'; [ "$chain" = OUTPUT ] || who="the VM's containers"
                if vm_sh "$VM" sudo -n iptables -w -C "$chain" -d 192.168.5.2 -j AGORA-HOST >/dev/null 2>&1; then say "  ok      $who can't reach this Mac's loopback (192.168.5.2, $chain)"
                else say "  FAILED  $who can reach this Mac's 127.0.0.1: no AGORA-HOST jump in $chain (in the VM: sudo systemctl restart agora-host-firewall; journalctl -u agora-host-firewall)"; fails=1; fi
            done
            # Port 53 on that address is the VM's DNS server, the one port the firewall leaves open
            if vm_sh "$VM" getent hosts github.com >/dev/null 2>&1; then say "  ok      the VM resolves names (DNS)"
            else say "  FAILED  the VM can't resolve names (in the VM: resolvectl dns; sudo iptables -S AGORA-HOST must accept port 53; sudo systemctl restart agora-host-firewall)"; fails=1; fi
        fi
        for p in "$(state_get "$VM" https_port)" "$(state_get "$VM" api_port)"; do
            [ -n "$p" ] || continue
            if mac_port_free "$p"; then say "  FAILED  nothing listens on 127.0.0.1:$p (Lima's port forward)"; fails=1; else say "  ok      127.0.0.1:$p forwarded"; fi
        done
        a=$(state_get "$VM" api_port)
        if [ -n "$a" ] && curl -fsS -m 5 "http://127.0.0.1:$a/health" 2>/dev/null | grep -q '"ok"'; then say "  ok      http://127.0.0.1:$a/health"
        else say "  FAILED  http://127.0.0.1:${a:-?}/health doesn't answer from the Mac"; fails=1; health_bad=1; fi
        if [ "$s" != Running ] || [ "${health_bad:-0}" = 1 ]; then
            # Only when something is already failing: Lima's log keeps its start-up lines for good
            [ -z "$s" ] || vm_wont_start_report "$VM" "$HOME/Agora Backups"
        fi
        [ "$s" = Running ] || exit 1
        say ''
        say "${BOLD}Inside $VM${RESET}"
        d=$(install_dir)
        r=(); [ "$REPORT" = 0 ] || r=(--report)
        set +e; vm_sh "$VM" bash "$d/install/doctor.sh" --dir "$d" ${r[@]+"${r[@]}"}; g=$?; set -e
        [ "$fails" = 0 ] && [ "$g" = 0 ]
        ;;
    backup)
        need_vm
        d=$(install_dir)
        inst=$(vm_sh "$VM" sh -c 'sed -n "s/^AGORA_INSTANCE=//p" "$1/.env.prod" | tail -n 1' _ "$d" | tr -d '\r' || true)
        name="agora-${inst:-agora}-$(date -u +%Y%m%dT%H%M%SZ).agorabk"
        if [ -z "$OUT" ]; then mkdir -p "$HOME/Agora Backups"; chmod 700 "$HOME/Agora Backups"; OUT="$HOME/Agora Backups/$name"; fi
        [ ! -e "$OUT" ] || die "$OUT already exists"
        g=$(guest_tmp); guest_tmp_add "$VM" "$g"; pass_args "$g"
        vm_sh "$VM" sh -c 'mkdir -p "$1/backups" && chmod 700 "$1/backups"' _ "$d"
        set +e; vm_sh "$VM" bash "$d/install/backup.sh" --dir "$d" --out "$d/backups/$name" ${GPASS[@]+"${GPASS[@]}"}; c=$?; set -e
        guest_cleanup
        [ "$c" = 0 ] || die "install/backup.sh failed in $VM (exit $c)"
        fetch_bundle_verified "$VM" "$d/backups/$name" "$OUT" || die "the backup is in $VM:$d/backups/$name, but copying it to $OUT failed or doesn't match the original"
        ok "$OUT (size and SHA-256 match the copy in $VM:$d/backups/). Without its passphrase it can't be restored."
        ;;
    restore)
        need_vm
        [ -n "$FILE" ] && [ -r "$FILE" ] || die "give the bundle to restore: agora-vm.sh restore <file>.agorabk"
        d=$(install_dir)
        g=$(guest_tmp); guest_tmp_add "$VM" "$g"; pass_args "$g"
        info "copying $(basename "$FILE") into $VM"
        gb=$(copy_secret_in "$VM" "$g" "$FILE") || die "copying the bundle into $VM failed"
        y=(); [ "$YES" = 0 ] || y=(--yes)
        set +e; vm_sh "$VM" bash "$d/install/restore.sh" "$gb" --dir "$d" ${y[@]+"${y[@]}"} ${GPASS[@]+"${GPASS[@]}"}; c=$?; set -e
        guest_cleanup
        [ "$c" = 0 ] || die "install/restore.sh failed in $VM (exit $c)"
        ;;
    upgrade)
        need_vm
        d=$(install_dir)
        [ -z "$SRC" ] || [ -z "$REF" ] || die "give --source or --ref, not both"
        if [ -z "$SRC" ]; then
            # No checkout given: the latest release (or --ref TAG), checked against its SHA-256
            REF=${REF:-latest}
            info "downloading Agora ($REF) from $AGORA_RELEASE_BASE"
            FETCHED=$(mktemp -d)
            fetch_release_or_die "$REF" "$FETCHED"
            SRC=$FETCHED
        fi
        SRC=$(cd "$SRC" && pwd)
        [ -f "$SRC/install/upgrade.sh" ] || die "$SRC is not an Agora release"
        info "copying $(agora_version "$SRC") into $VM"
        gs=$(copy_source_in "$VM" "$SRC") || die "copying $SRC into $VM failed (limactl's message is above)"
        guest_tmp_add "$VM" "$gs"
        g=$(guest_tmp); guest_tmp_add "$VM" "$g"; pass_args "$g"
        inst=$(vm_sh "$VM" sh -c 'sed -n "s/^AGORA_INSTANCE=//p" "$1/.env.prod" | tail -n 1' _ "$d" | tr -d '\r' || true); inst=${inst:-agora}
        keep=${KEEP:-$(state_get "$VM" keep_backups)}; keep=${keep:-$DEFAULT_KEEP_BACKUPS}
        UPX=(); [ "$FORCE" = 0 ] || UPX+=(--force)
        [ "$NO_PRUNE" = 0 ] || UPX+=(--no-prune)
        [ -z "$KEEP" ] || UPX+=(--keep-backups "$KEEP")

        # 1. Room, in the VM and on this Mac, before anything is stopped or copied
        step mac.space "Checking there is room for the upgrade"
        set +e; sp=$(vm_sh "$VM" bash "$gs/install/upgrade.sh" --dir "$d" --check-space ${GPASS[@]+"${GPASS[@]}"} ${NI[@]+"${NI[@]}"} $([ "$FORCE" = 0 ] || echo --force) ${REST[@]+"${REST[@]}"}); c=$?; set -e
        printf '%s\n' "$sp" | sed '/^AGORA_BACKUP_EST_KB=/d'
        [ "$c" = 0 ] || die "not enough room in $VM for the upgrade; nothing was changed (the lines above say where). --force goes on anyway"
        est=$(printf '%s\n' "$sp" | sed -n 's/^AGORA_BACKUP_EST_KB=//p' | tail -n 1); est=${est:-0}
        bdir="$HOME/Agora Backups"
        if [ "$VM_ONLY" = 0 ]; then
            SPACE_NEEDS=''
            space_need "$bdir" "$est" 'the copy of the backup on this Mac'
            space_need "$HOME/.lima/$VM" "$((est + UPGRADE_BUILD_GB * 1048576))" "the VM's disk file, which only grows (the backup and the new images)"
            if ! space_check "  Free some room on this Mac and run it again: remove old backups in $bdir, or other big files. The VM's disk file never shrinks by itself, so the room has to be on the Mac. To go ahead anyway: --force."; then
                if [ "$FORCE" = 1 ]; then warn "--force: starting although there is little room on this Mac"
                else die "not enough room on this Mac for the upgrade; nothing was changed"; fi
            fi
        fi
        ok "enough room (the backup is expected to be about $(kb_text "$est"))"

        # 2. The backup, copied out of the VM and checked, before the upgrade changes anything
        UPB=()
        if [ "$VM_ONLY" = 0 ]; then
            step mac.backup "Backing up first, then copying the backup to this Mac"
            res="$g/backup-result"
            set +e; vm_sh "$VM" bash "$gs/install/upgrade.sh" --dir "$d" --backup-only --backup-result-file "$res" ${GPASS[@]+"${GPASS[@]}"} ${NI[@]+"${NI[@]}"} ${REST[@]+"${REST[@]}"} ${UPX[@]+"${UPX[@]}"}; c=$?; set -e
            if [ "$c" != 0 ]; then guest_cleanup; die "the backup failed in $VM (exit $c); nothing was changed"; fi
            gb=$(vm_sh "$VM" sed -n 's/^bundle=//p' "$res" | tr -d '\r' | tail -n 1 || true)
            [ -n "$gb" ] || { guest_cleanup; die "the backup step didn't say where the bundle is; nothing was changed"; }
            mkdir -p "$bdir"; chmod 700 "$bdir"
            OUT="$bdir/$(basename "$gb")"
            if ! fetch_bundle_verified "$VM" "$gb" "$OUT"; then
                guest_cleanup
                die "the backup was taken, but it could not be copied to $OUT, or the copy doesn't match, so the upgrade was stopped before it changed anything. The backup is still in $VM at $gb. Nothing was changed; make room or fix the problem above and run the upgrade again. (--backup-in-vm-only goes on with the backup only inside the VM.)"
            fi
            ok "backup on this Mac: $OUT (size and SHA-256 match the original in $VM)"
            UPB=(--use-backup "$gb")
        else
            warn "--backup-in-vm-only: this upgrade's backup stays inside $VM. If the VM stops working it is lost with it."
            UPB=(--backup-in-vm-only)
        fi

        # 3. The upgrade itself
        set +e; vm_sh "$VM" bash "$gs/install/upgrade.sh" --dir "$d" ${GPASS[@]+"${GPASS[@]}"} ${NI[@]+"${NI[@]}"} ${REST[@]+"${REST[@]}"} ${UPB[@]+"${UPB[@]}"} ${UPX[@]+"${UPX[@]}"}; c=$?; set -e
        guest_cleanup
        [ "$c" = 0 ] || die "install/upgrade.sh failed in $VM (exit $c). Nothing was deleted. To go back: bash $0 shell bash install/upgrade.sh --rollback${OUT:+ (the backup is also on this Mac: $OUT)}"
        # 4. Only now: old upgrade backups on this Mac beyond the newest N (never one made with the backup command)
        [ -z "$KEEP" ] || state_set "$VM" keep_backups "$KEEP"
        if [ "$keep" != 0 ] && [ -d "$bdir" ]; then
            PRUNED_BYTES=0
            prune_upgrade_backups "$bdir" "$inst" "$keep" "${OUT:-}"
            [ "${PRUNED_BYTES:-0}" = 0 ] || say "  freed $(awk -v b="$PRUNED_BYTES" 'BEGIN { printf "%.1f GB", b / 1073741824 }') of old upgrade backups in $bdir (keeping the newest $keep; --keep-backups N changes it, 0 keeps all)"
        fi
        if [ -n "${OUT:-}" ]; then say "  This upgrade's backup is on this Mac: $OUT"; fi
        # From the Mac's side: Lima's forward to the API (the checks above ran inside the VM)
        a=$(state_get "$VM" api_port)
        if [ -n "$a" ]; then
            if curl -fsS -m 10 "http://127.0.0.1:$a/health" 2>/dev/null | grep -q '"ok"'; then say "  ok      Agora answers on this Mac at http://127.0.0.1:$a/health"
            else say "  FAILED  nothing answers on this Mac at http://127.0.0.1:$a/health, though the upgrade in $VM finished. Run: bash $0 doctor"; fi
        fi
        if [ -n "$FETCHED" ]; then
            # The downloaded release becomes this Mac's copy of the scripts (where a stand-alone
            # install keeps them), so agora-vm.sh is the new release's from now on
            rel="$MAC_STATE_DIR/release"
            mkdir -p "$MAC_STATE_DIR"; chmod 700 "$MAC_STATE_DIR"
            rm -rf "$rel.new"
            if mv "$FETCHED" "$rel.new" && rm -rf "$rel" && mv "$rel.new" "$rel"; then
                FETCHED=''
                [ "$(cd "$HERE/../.." && pwd -P)" = "$(cd "$rel" && pwd -P)" ] || info "this release's Mac commands are in $rel (the copy you ran is $(agora_version "$HERE/../..")): bash $rel/install/macos/agora-vm.sh"
            fi
        fi
        ;;
    tailnet)
        sub=${REST[0]:-}
        case "$sub" in on|off|status) ;; *) die "tailnet on, off or status" ;; esac
        need_vm
        d=$(install_dir)
        vm_sh "$VM" test -f "$d/install/tailnet.sh" || die "the install in $VM is from before this command; upgrade it first: bash $0 upgrade"
        set +e; vm_sh "$VM" bash "$d/install/tailnet.sh" "$sub" --dir "$d" ${TS_ARGS[@]+"${TS_ARGS[@]}"} ${NI[@]+"${NI[@]}"}; c=$?; set -e
        [ "$c" = 0 ] || exit "$c"
        ;;
    stop)
        k=$(keepalive_kind "$VM")
        case "$k" in
            agent) launchctl bootout "gui/$(id -u)/$(keepalive_label "$VM")" >/dev/null 2>&1 || true ;;
            daemon) sudo launchctl bootout "system/$(keepalive_label "$VM")" >/dev/null 2>&1 || true ;;
        esac
        limactl stop "$VM"
        ok "$VM stopped; the keep-alive is paused until: bash $0 start --vm $VM (or the next login/boot)"
        ;;
    start)
        s=$(vm_status "$VM"); [ -n "$s" ] || die "there is no Lima VM named $VM"
        [ "$s" = Running ] || limactl start --tty=false "$VM"
        case "$(keepalive_kind "$VM")" in
            agent) launchctl bootstrap "gui/$(id -u)" "$(keepalive_agent_plist "$VM")" >/dev/null 2>&1 || true ;;
            daemon) sudo launchctl bootstrap system "$(keepalive_daemon_plist "$VM")" >/dev/null 2>&1 || true ;;
        esac
        ok "$VM running"
        ;;
    keepalive)
        [ -n "$(vm_status "$VM")" ] || die "there is no Lima VM named $VM"
        case "${REST[0]:-}" in
            agent) remove_keepalive_daemon "$VM"; install_keepalive "$VM" agent "$HERE/keepalive.sh"; ok "LaunchAgent $(keepalive_agent_plist "$VM")" ;;
            daemon) install_keepalive "$VM" daemon "$HERE/keepalive.sh"; ok "LaunchDaemon $(keepalive_daemon_plist "$VM") (runs as $(id -un), from boot)" ;;
            off) remove_keepalive_agent "$VM"; remove_keepalive_daemon "$VM"; ok "no keep-alive: start the VM yourself after a restart (bash $0 start)" ;;
            *) die "keepalive agent, daemon or off" ;;
        esac
        ;;
    ''|-h|--help) sed -n '2,29p' "$0"; [ -n "$CMD" ] ;;
    *) die "unknown command $CMD (status, shell, doctor, backup, restore, upgrade, tailnet, stop, start, keepalive)" ;;
esac
