#!/bin/bash
# Agora installer for macOS on Apple Silicon (docs/macos.md, docs/agent-boxes.md §12.3).
#
#   bash install/macos/install.sh                   # asks what it needs
#   bash install/macos/install.sh --non-interactive --allow-lima-install --agent claude \
#        --telemetry off --admin-password-file ./pw [--memory 8] [--at-boot]
#
# The Mac counterpart of install/windows/install.ps1. gVisor, which boxes and code runs need,
# runs only on a Linux kernel, so Agora runs in a Linux VM: Lima on Apple's Virtualization.
# framework with Canonical's Ubuntu 24.04 arm64 image. This script installs Lima with Homebrew
# (asking first), creates the VM (asking its size), copies the release in, runs
# install/linux/install.sh inside it, forwards Agora's three ports to 127.0.0.1 on the Mac and
# adds a launchd job that keeps the VM running. Nothing of the Mac is shared with the VM.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: install.sh [options]

This Mac:
  --non-interactive          never ask; every answer comes from these flags (or defaults)
  --allow-lima-install       with --non-interactive: install or upgrade Lima with Homebrew
  --vm NAME                  the Lima VM's name (default: agora)
  --cpus N --memory GIB --disk GIB   the VM's size (default: half the cores, 8 GiB on a Mac
                             with 16 GB or more and 6 otherwise, a 100 GiB disk that grows as used)
  --http-port N --https-port N --api-port N   ports on this Mac's 127.0.0.1, 1024 or above
                             (default: 8000, 8443, 3000, or the next free ones)
  --at-boot                  start the VM at boot, before anyone logs in (a LaunchDaemon; asks
                             for sudo once). Default: at login (a LaunchAgent, no sudo)
  --no-keepalive             don't add the launchd job
  --source DIR               install from this checkout (default: the one this script is in)
  --ref TAG                  when run on its own: the release to download (default: latest)

Passed to the Linux installer inside the VM (install/linux/install.sh --help):
  --instance NAME  --domain NAME  --admin-user NAME  --admin-email ADDRESS
  --admin-password-file F  --agent claude|codex|none  --agent-name NAME
  --agent-api-key-file F  --telemetry on|off  --existing upgrade|stop  --passphrase-file F
  --min-disk-gb N
  -h, --help
EOF
}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ARGS=("$@")
NON_INTERACTIVE=0 ALLOW_LIMA=0 VM=agora CPUS='' MEMORY='' DISK='' HTTP_PORT='' HTTPS_PORT='' API_PORT=''
AT_BOOT=0 NO_KEEPALIVE=0 SOURCE='' REF=latest TELEMETRY_ARG='' EXISTING=''
ADMIN_PW_FILE='' AGENT_KEY_FILE='' PASS_FILE_ARG=''
PASS=()
need() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "install.sh: $1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
    case "$1" in
        --non-interactive) NON_INTERACTIVE=1 ;;
        --allow-lima-install) ALLOW_LIMA=1 ;;
        --vm) need "$@"; VM=$2; shift ;;
        --cpus) need "$@"; CPUS=$2; shift ;;
        --memory) need "$@"; MEMORY=$2; shift ;;
        --disk) need "$@"; DISK=$2; shift ;;
        --http-port) need "$@"; HTTP_PORT=$2; shift ;;
        --https-port) need "$@"; HTTPS_PORT=$2; shift ;;
        --api-port) need "$@"; API_PORT=$2; shift ;;
        --at-boot) AT_BOOT=1 ;;
        --no-keepalive) NO_KEEPALIVE=1 ;;
        --source) need "$@"; SOURCE=$2; shift ;;
        --ref) need "$@"; REF=$2; shift ;;
        --telemetry) need "$@"; TELEMETRY_ARG=$2; shift ;;
        --existing) need "$@"; EXISTING=$2; shift ;;
        --admin-password-file) need "$@"; ADMIN_PW_FILE=$2; shift ;;
        --agent-api-key-file) need "$@"; AGENT_KEY_FILE=$2; shift ;;
        --passphrase-file) need "$@"; PASS_FILE_ARG=$2; shift ;;
        --instance|--domain|--admin-user|--admin-email|--agent|--agent-name|--min-disk-gb)
            need "$@"; PASS+=("$1" "$2"); shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "install.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

# ─── Run on its own (curl -O, then bash install.sh): fetch the release, then run its installer ───
if [ ! -f "$HERE/lib/macos.sh" ]; then
    [ -z "$SOURCE" ] || { echo "install.sh: --source $SOURCE has no install/macos/lib; use a full checkout" >&2; exit 2; }
    base=${AGORA_RELEASE_BASE:-https://github.com/CaffeinatedSoftwareLLC/agora/releases}
    if [ "$REF" = latest ]; then url="$base/download/agora-latest"; else url="$base/download/$REF"; fi
    tmp=$(mktemp -d)
    echo "Downloading Agora ($REF) from $url"
    curl -fsSL --proto '=https' -o "$tmp/agora.tar.gz" "$url/agora.tar.gz"
    curl -fsSL --proto '=https' -o "$tmp/agora.tar.gz.sha256" "$url/agora.tar.gz.sha256"
    (cd "$tmp" && shasum -a 256 -c agora.tar.gz.sha256 >/dev/null) || { echo "install.sh: the download doesn't match its SHA-256; not installing" >&2; exit 1; }
    mkdir "$tmp/src"
    tar -xzf "$tmp/agora.tar.gz" -C "$tmp/src" --strip-components=1
    exec /bin/bash "$tmp/src/install/macos/install.sh" ${ARGS[@]+"${ARGS[@]}"} --source "$tmp/src"
fi

# shellcheck source=../lib/common.sh
. "$HERE/../lib/common.sh"
# shellcheck source=lib/macos.sh
. "$HERE/lib/macos.sh"
# The install report's operating system is this Mac's, not the VM's
OS_NAME=macos
os_version() { mac_os_version; }
trap 'on_exit $?' EXIT

printf '%s' "$VM" | grep -Eq "$VM_NAME_RE" || die "--vm must be lowercase letters, digits and dashes, starting with a letter"
case "$TELEMETRY_ARG" in ''|on|off) ;; *) die "--telemetry must be on or off" ;; esac
case "$EXISTING" in ''|upgrade|stop) ;;
    alongside) die "one Agora install per VM on a Mac (the VM forwards that install's ports). For a second install, give it its own VM: --vm agora2" ;;
    *) die "--existing must be upgrade or stop" ;;
esac
for f in "$ADMIN_PW_FILE" "$AGENT_KEY_FILE" "$PASS_FILE_ARG"; do [ -z "$f" ] || [ -r "$f" ] || die "can't read $f"; done
for p in "$HTTP_PORT" "$HTTPS_PORT" "$API_PORT"; do [ -z "$p" ] || { r=$(check_port "$p"); [ -z "$r" ] || die "$r"; }; done

[ -n "$SOURCE" ] || SOURCE=$(cd "$HERE/../.." && pwd)
SOURCE=$(cd "$SOURCE" && pwd)
[ -f "$SOURCE/$COMPOSE_FILE_NAME" ] && [ -f "$SOURCE/install/linux/install.sh" ] || die "$SOURCE is not an Agora checkout"
AGORA_VERSION=$(agora_version "$SOURCE"); AGORA_VERSION=${AGORA_VERSION:-unknown}

say "${BOLD}Agora $AGORA_VERSION installer for macOS${RESET}"

# ─── 1. This Mac ───
step mac.preflight 'Checking this Mac'
problems=$(preflight_problems)
[ -z "$problems" ] || die "$(printf '%s' "$problems" | paste -sd ';' - | sed 's/;/; /g')"
MAC_MEM=$(mac_memory_gb) MAC_CPUS=$(mac_cpus)
ok "macOS $(mac_os_version) on Apple Silicon, $MAC_MEM GB, $MAC_CPUS CPUs, $(mac_free_gb "$HOME") GB free"
sleep_min=$(mac_sleep_minutes)
if [ -n "$sleep_min" ] && [ "$sleep_min" != 0 ]; then
    warn "this Mac sleeps after $sleep_min idle minutes, and a sleeping Mac stops Agora and its agents. To keep it awake: System Settings → Energy (on a laptop: Battery → Options) → Prevent automatic sleeping when the display is off, or: sudo pmset -a sleep 0"
fi

# ─── 2. Telemetry (asked here, once, and passed to the Linux installer) ───
step mac.telemetry 'Telemetry'
TELEMETRY=$TELEMETRY_ARG
if [ -z "$TELEMETRY" ]; then
    if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then TELEMETRY=off
    else
        say ''
        printf '%s\n' "$TELEMETRY_QUESTION" | sed 's/^/  /'
        if yes_no '>' n; then TELEMETRY=on; else TELEMETRY=off; fi
    fi
fi
ok "telemetry $TELEMETRY"

# ─── 3. Lima ───
step mac.lima 'Lima (runs the Linux VM)'
lima_consent() { # lima_consent <question>
    if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then [ "$ALLOW_LIMA" = 1 ]; else yes_no "$1" y; fi
}
LIMA_V=$(lima_version)
if [ -z "$LIMA_V" ]; then
    find_brew >/dev/null || die "Lima isn't installed, and neither is Homebrew. Install Homebrew from https://brew.sh (this installer doesn't run its install script for you), or Lima itself (https://lima-vm.io/docs/installation/), then run this again"
    if ! lima_consent 'Lima is not installed. Install it now with Homebrew (brew install lima)? [Y/n]'; then
        FINISHED=1
        say '  Not installing Lima; nothing was changed. To do it yourself: brew install lima, then run this again.'
        exit 0
    fi
    brew_install_lima || die "brew install lima failed"
    add_cleanup 'brew uninstall lima   # Lima was installed by this run'
    LIMA_V=$(lima_version)
    [ -n "$LIMA_V" ] || die "Lima was installed but limactl doesn't answer (is $(brew_bin_dir) in your PATH?)"
elif ! version_ge "$LIMA_V" "$LIMA_MIN_VERSION"; then
    if find_brew >/dev/null && "$(find_brew)" list lima >/dev/null 2>&1 \
        && lima_consent "Lima $LIMA_V is older than $LIMA_MIN_VERSION. Upgrade it with Homebrew (brew upgrade lima)? Running VMs keep running. [Y/n]"; then
        brew_upgrade_lima || die "brew upgrade lima failed"
        LIMA_V=$(lima_version)
    fi
    version_ge "$LIMA_V" "$LIMA_MIN_VERSION" || die "Lima $LIMA_V is older than $LIMA_MIN_VERSION; upgrade it (brew upgrade lima) and run this again"
fi
ok "Lima $LIMA_V"
if [ -d /Applications/Docker.app ] || [ -d /Applications/OrbStack.app ] || command -v colima >/dev/null 2>&1; then
    info 'Docker Desktop, OrbStack or Colima can stay installed; Agora does not use or change them, and its ports avoid theirs.'
fi

# ─── 4. The VM ───
step mac.vm "The VM ($VM)"
STATUS=$(vm_status "$VM")
if [ -n "$STATUS" ]; then
    [ "$(state_get "$VM" created)" = 1 ] || die "a Lima VM named $VM already exists, and this installer didn't create it. Agora needs a VM of its own (no mounts, only its ports forwarded): run again with --vm <another name>"
    for k in http_port https_port api_port; do [ -n "$(state_get "$VM" "$k")" ] || die "the record of $VM ($(state_file "$VM")) has no $k; remove the VM (bash install/macos/uninstall.sh --vm $VM --delete-vm) and install again"; done
    old_h=$(state_get "$VM" http_port) old_s=$(state_get "$VM" https_port) old_a=$(state_get "$VM" api_port)
    if { [ -n "$HTTP_PORT" ] && [ "$HTTP_PORT" != "$old_h" ]; } || { [ -n "$HTTPS_PORT" ] && [ "$HTTPS_PORT" != "$old_s" ]; } || { [ -n "$API_PORT" ] && [ "$API_PORT" != "$old_a" ]; }; then
        warn "VM $VM already forwards ports $old_h, $old_s and $old_a; the ports given are not used"
    fi
    HTTP_PORT=$old_h HTTPS_PORT=$old_s API_PORT=$old_a
    if [ "$STATUS" != Running ]; then
        info "starting $VM (it was $STATUS)"
        limactl start --tty=false "$VM" || die "limactl start $VM failed (limactl list; ~/.lima/$VM/ha.stderr.log)"
    fi
    ok "using $VM, made by an earlier run"
    # Agora is already in it: upgrade or stop, never a second install the VM doesn't forward
    if [ "$(state_get "$VM" installed)" = 1 ] && [ -z "$EXISTING" ]; then
        if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then EXISTING=stop
        else ask EXISTING "Agora is already installed in $VM. Upgrade it to $AGORA_VERSION (upgrade), or stop (stop)? [stop]" stop; fi
        case "$EXISTING" in upgrade) ;; *) EXISTING=stop ;; esac
    fi
    if [ "$EXISTING" = stop ] && [ "$(state_get "$VM" installed)" = 1 ]; then
        FINISHED=1
        say "  Stopped; nothing was changed. Agora in $VM: bash $HERE/agora-vm.sh status"
        exit 0
    fi
else
    # Ports on the Mac, clear of every other Agora VM's (running or not) and of what listens now
    taken=''
    for f in "$MAC_STATE_DIR"/*.conf; do
        [ -f "$f" ] || continue
        taken="$taken $(sed -n -e 's/^http_port=//p' -e 's/^https_port=//p' -e 's/^api_port=//p' "$f" | tr '\n' ' ')"
    done
    pick() { # pick <given> <default start>
        local t
        if [ -n "$1" ]; then
            for t in $RESERVED_PORTS $taken; do [ "$t" = "$1" ] && die "port $1 is used by another Agora VM (or kept for the tailnet override)"; done
            mac_port_free "$1" || die "port $1 is in use on this Mac (lsof -nP -iTCP:$1 -sTCP:LISTEN)"
            echo "$1"; return
        fi
        # shellcheck disable=SC2086 # one argument per port
        mac_free_port "$2" $taken || die "no free port from $2"
    }
    HTTP_PORT=$(pick "$HTTP_PORT" 8000); taken="$taken $HTTP_PORT"
    HTTPS_PORT=$(pick "$HTTPS_PORT" 8443); taken="$taken $HTTPS_PORT"
    API_PORT=$(pick "$API_PORT" 3000); taken="$taken $API_PORT"
    ok "ports on this Mac: https $HTTPS_PORT, http $HTTP_PORT, api $API_PORT (127.0.0.1 only)"

    [ -n "$CPUS" ] || { CPUS=$(default_vm_cpus "$MAC_CPUS"); ask CPUS "CPUs for the VM [$CPUS]:" "$CPUS"; }
    [ -n "$MEMORY" ] || { MEMORY=$(default_vm_memory "$MAC_MEM"); ask MEMORY "Memory for the VM in GiB (this Mac has $MAC_MEM GB; each running agent box takes about 1) [$MEMORY]:" "$MEMORY"; }
    [ -n "$DISK" ] || { DISK=$(default_vm_disk); ask DISK "Disk for the VM in GiB (it takes space on the Mac only as it fills) [$DISK]:" "$DISK"; }
    r=$(check_vm_size "$CPUS" "$MEMORY" "$DISK" "$MAC_CPUS" "$MAC_MEM"); [ -z "$r" ] || die "$r"
    if [ "$NON_INTERACTIVE" = 0 ] && [ -t 0 ]; then
        if ! yes_no "Create the VM $VM (Ubuntu 24.04, $CPUS CPUs, $MEMORY GiB memory, $DISK GiB disk)? [Y/n]" y; then
            FINISHED=1; say '  Stopped; nothing was changed.'; exit 0
        fi
    fi
    DIGEST=$(image_digest) || die "can't read the SHA-256 of Canonical's image from $UBUNTU_IMAGE_BASE/SHA256SUMS"
    mkdir -p "$MAC_STATE_DIR"; chmod 700 "$MAC_STATE_DIR"
    TEMPLATE="$MAC_STATE_DIR/$VM.yaml"
    lima_template "$CPUS" "$MEMORY" "$DISK" "$DIGEST" "$HTTP_PORT" "$HTTPS_PORT" "$API_PORT" > "$TEMPLATE"
    state_set "$VM" created 1
    state_set "$VM" http_port "$HTTP_PORT"; state_set "$VM" https_port "$HTTPS_PORT"; state_set "$VM" api_port "$API_PORT"
    add_cleanup "rm -f $(state_file "$VM") $TEMPLATE"
    info "downloading Ubuntu 24.04 (about 600 MB, checked against sha256:${DIGEST:0:12}…) and creating $VM"
    limactl create --tty=false --name "$VM" "$TEMPLATE" || die "limactl create failed"
    add_cleanup "limactl delete --force $VM   # the VM this run created, with everything in it"
    limactl start --tty=false "$VM" || die "limactl start $VM failed (~/.lima/$VM/ha.stderr.log)"
    ok "created and started $VM"
fi
guest=$(vm_sh "$VM" sh -c '. /etc/os-release; printf "%s %s %s" "$ID" "$VERSION_ID" "$(uname -m)"' | tr -d '\r') || die "can't run a command in $VM (limactl shell $VM)"
case "$guest" in "ubuntu "*" aarch64") ok "inside: $guest" ;; *) die "$VM runs $guest, not Ubuntu on aarch64" ;; esac

# ─── 5. The release, into the VM ───
step mac.source 'Copying Agora into the VM'
GSRC=$(copy_source_in "$VM" "$SOURCE") || die "copying $SOURCE into $VM failed"
GIN=$(vm_sh "$VM" mktemp -d /tmp/agora-in.XXXXXX | tr -d '\r') || die "can't make a folder in $VM"
add_cleanup "limactl shell $VM rm -rf $GSRC $GIN   # the copy of the release in the VM"
LINUX_ARGS=(--lima --source "$GSRC" --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT" --api-port "$API_PORT" --telemetry "$TELEMETRY")
[ "$NON_INTERACTIVE" = 0 ] || LINUX_ARGS+=(--non-interactive)
[ -z "$EXISTING" ] || LINUX_ARGS+=(--existing "$EXISTING")
[ -z "$ADMIN_PW_FILE" ] || LINUX_ARGS+=(--admin-password-file "$(copy_secret_in "$VM" "$GIN" "$ADMIN_PW_FILE")")
[ -z "$AGENT_KEY_FILE" ] || LINUX_ARGS+=(--agent-api-key-file "$(copy_secret_in "$VM" "$GIN" "$AGENT_KEY_FILE")")
[ -z "$PASS_FILE_ARG" ] || LINUX_ARGS+=(--passphrase-file "$(copy_secret_in "$VM" "$GIN" "$PASS_FILE_ARG")")
ok "$AGORA_VERSION in $VM:$GSRC"

# ─── 6. The Linux installer, inside ───
step mac.linux "Running the Linux installer inside $VM"
set +e
vm_sh "$VM" bash "$GSRC/install/linux/install.sh" "${LINUX_ARGS[@]}" ${PASS[@]+"${PASS[@]}"}
code=$?
set -e
vm_sh "$VM" rm -rf "$GSRC" "$GIN" >/dev/null 2>&1 || true
if [ "$code" != 0 ]; then
    # It reported its own failure (and offered a problem report); don't send a second one
    TELEMETRY_SENT=1
    CLEANUP_CMDS=()
    add_cleanup "bash $HERE/uninstall.sh --vm $VM --delete-vm   # remove the VM and this Mac's records of it"
    die "the Linux installer failed (exit $code); its message above names the step. The VM stays: fix what it says and run this installer again, or look inside with: limactl shell $VM"
fi
CLEANUP_CMDS=()
GDIR=$(guest_install_dirs "$VM" | head -n 1)
state_set "$VM" installed 1
[ -z "$GDIR" ] || state_set "$VM" install_dir "$GDIR"

# ─── 7. Keep-alive ───
step mac.keepalive 'Keeping the VM running (launchd)'
if [ "$NO_KEEPALIVE" = 1 ]; then
    info "skipped (--no-keepalive): start it after a restart with limactl start $VM"
else
    if [ "$AT_BOOT" = 1 ]; then
        if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then sudo -n true 2>/dev/null || die "--at-boot writes /Library/LaunchDaemons and needs sudo: run sudo -v first, then this again"
        else info 'starting at boot needs a LaunchDaemon in /Library/LaunchDaemons; sudo asks for your password once'; fi
        install_keepalive "$VM" daemon "$HERE/keepalive.sh"
        ok "LaunchDaemon $(keepalive_daemon_plist "$VM") (runs as $(id -un), from boot)"
    else
        install_keepalive "$VM" agent "$HERE/keepalive.sh"
        ok "LaunchAgent $(keepalive_agent_plist "$VM") (from login, every $((KEEPALIVE_INTERVAL / 60)) minutes)"
    fi
fi

# ─── 8. Done ───
step 'mac.done' 'Done'
FINISHED=1
URL=$(vm_sh "$VM" sh -c 'cat "$HOME/.agora/last-install-url"' 2>/dev/null | tr -d '\r' | grep -E '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' | tail -n 1 || true)
[ -n "$URL" ] || URL="https://localhost:$HTTPS_PORT"
state_set "$VM" url "$URL"
say ''
say "${BOLD}Agora is running in the VM $VM.${RESET}"
say "  Open:     $URL   (a local certificate: your browser warns once)"
say "  Agents on this Mac: http://localhost:$API_PORT"
say "  The VM:   bash $HERE/agora-vm.sh status|shell|doctor|backup|restore|upgrade|stop|start"
say "  Back it up now: bash $HERE/agora-vm.sh backup   (one encrypted file: database, files, boxes and"
say "            .env.prod, whose AGORA_ENCRYPTION_KEY can't be recovered; keep the file and its passphrase apart)"
if [ "$NON_INTERACTIVE" = 0 ] && [ -t 0 ] && [ -z "${SSH_CONNECTION:-}" ]; then open "$URL" >/dev/null 2>&1 || true; fi
