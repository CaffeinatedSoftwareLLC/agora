#!/bin/bash
# Remove Agora from a Mac (docs/macos.md). The counterpart of install/windows/uninstall.ps1.
#
#   bash install/macos/uninstall.sh [--vm NAME] [--purge] [--delete-vm]
#
# Runs install/uninstall.sh inside the VM (the containers; with --purge also the data, after you
# type the install's name), removes the launchd keep-alive, and with --delete-vm deletes the VM
# itself (everything in it, after you type its name) if this installer created it. Lima and
# Homebrew stay.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$HERE/../lib/common.sh"
# shellcheck source=lib/macos.sh
. "$HERE/lib/macos.sh"

VM=agora PURGE=0 DELETE_VM=0
while [ $# -gt 0 ]; do
    case "$1" in
        --vm) VM=${2:?--vm needs a name}; shift ;;
        --purge) PURGE=1 ;;
        --delete-vm) DELETE_VM=1 ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "uninstall.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
printf '%s' "$VM" | grep -Eq "$VM_NAME_RE" || die "--vm must be lowercase letters, digits and dashes"

s=$(vm_status "$VM")
created=$(state_get "$VM" created)
# Confirmed before anything is removed, so a "no" leaves the VM with its keep-alive
if [ "$DELETE_VM" = 1 ] && [ -n "$s" ]; then
    [ "$created" = 1 ] || die "this installer didn't create the VM $VM; it is left alone (limactl delete $VM removes it)"
    say ''
    say "  This deletes the VM $VM and everything in it: Agora's database, files and every agent's box."
    ans=''
    [ -t 0 ] || die "deleting the VM needs a terminal to confirm"
    ask ans "Type the VM's name ($VM) to delete it:" ''
    [ "$ans" = "$VM" ] || die "not confirmed; the VM stays"
fi
if [ "$s" = Running ] && [ "$DELETE_VM" = 0 ]; then
    dirs=$(guest_install_dirs "$VM")
    for d in $dirs; do
        say "Removing the install in $VM:$d"
        a=(--dir "$d"); [ "$PURGE" = 0 ] || a+=(--purge)
        vm_sh "$VM" bash "$d/install/uninstall.sh" "${a[@]}" || die "install/uninstall.sh failed in $VM ($d)"
    done
fi

for kind in agent daemon; do
    if [ "$kind" = agent ] && [ -f "$(keepalive_agent_plist "$VM")" ]; then remove_keepalive_agent "$VM"; ok "removed $(keepalive_agent_plist "$VM")"; fi
    if [ "$kind" = daemon ] && [ -f "$(keepalive_daemon_plist "$VM")" ]; then remove_keepalive_daemon "$VM"; ok "removed $(keepalive_daemon_plist "$VM")"; fi
done

if [ "$DELETE_VM" = 1 ] && [ -n "$s" ]; then
    limactl delete --force "$VM"
    ok "deleted the VM $VM"
fi
if [ "$DELETE_VM" = 1 ] || [ -z "$s" ]; then
    rm -f "$(state_file "$VM")" "$MAC_STATE_DIR/$VM.yaml" "$MAC_STATE_DIR/$VM-keepalive.log"
fi
say 'Done. Lima stays installed (brew uninstall lima removes it).'
