#!/bin/bash
# Agora's VM keep-alive (docs/macos.md): launchd runs this at login (or at boot with --at-boot)
# and every 5 minutes. It starts the Lima VM when it isn't running; inside the VM, systemd starts
# Docker and the stack's restart policies start Agora. The installer copies it to
# ~/.agora/macos/keepalive.sh, so it doesn't depend on where the checkout is.
#
#   keepalive.sh <vm name>
#
# To stop the VM for a while without this starting it again: install/macos/agora-vm.sh stop.
set -u
VM=${1:-}
case "$VM" in ''|*[!a-z0-9-]*) echo "keepalive.sh: give the VM's name" >&2; exit 2 ;; esac
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
command -v limactl >/dev/null 2>&1 || { echo "$(now) limactl isn't in PATH ($PATH)"; exit 0; }
status=$(limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | awk -v n="$VM" '$1 == n {print $2; exit}')
case "$status" in
    Running) exit 0 ;;
    '') echo "$(now) there is no Lima VM named $VM"; exit 0 ;;
    *)
        echo "$(now) $VM is ${status}; starting it"
        if limactl start --tty=false "$VM"; then echo "$(now) $VM started"
        else echo "$(now) limactl start $VM failed; trying again in 5 minutes"; fi
        ;;
esac
exit 0
