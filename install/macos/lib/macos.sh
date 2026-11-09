# shellcheck shell=bash disable=SC2034  # sourced; its variables are used by the scripts that source it
# Decision logic of the macOS installer (docs/agent-boxes.md §12.3, docs/macos.md), sourced by
# install/macos/install.sh, agora-vm.sh and uninstall.sh after install/lib/common.sh.
#
# The design is the Windows installer's: the Linux stack runs in a Linux VM, here a Lima VM on
# Apple's Virtualization.framework with Canonical's Ubuntu 24.04 arm64 cloud image, and the
# Linux installer runs inside it unchanged. gVisor needs a Linux kernel, so it can't run on
# macOS itself, and Docker Desktop's or OrbStack's VM can't take a runtime of your own; a Lima
# VM is a plain Ubuntu machine that install/linux/install.sh owns like any other.
#
# Rules this file keeps:
#   - Written for /bin/bash 3.2 (macOS's own bash): no mapfile, no associative arrays, and no
#     "${a[@]}" of an array that may be empty under set -u.
#   - Every program that changes the Mac (brew, limactl, launchctl, sudo, curl) runs through a
#     function or a command looked up in PATH, so test/install/macos.test.sh can replace it.
#   - Nothing of the Mac is shared with the VM: no mounts, no SSH agent. The release goes in
#     with limactl copy. Ports are forwarded to 127.0.0.1 on the Mac only.
#   - Lima is installed, a VM created, a LaunchDaemon written, only with the user's consent.

MAC_STATE_DIR=${AGORA_MAC_STATE_DIR:-$HOME/.agora/macos}
VM_NAME_RE='^[a-z][a-z0-9-]{0,30}$'
LIMA_MIN_VERSION=2.0.0
MACOS_MIN_VERSION=13.5
# A Mac smaller than this can't give the VM the 6 GiB the Linux installer needs (4 GB free inside)
MAC_MIN_MEMORY_GB=8
VM_MIN_MEMORY_GB=6
VM_MIN_DISK_GB=40
# The Linux installer wants 20 GB free inside the VM; the VM's disk is a sparse file on the Mac
MAC_MIN_FREE_DISK_GB=30
# Canonical's Ubuntu 24.04 (noble) cloud images, with SHA256SUMS next to them (checked 2026-11-09)
UBUNTU_IMAGE_BASE=${AGORA_UBUNTU_IMAGE_BASE:-https://cloud-images.ubuntu.com/releases/noble/release}
UBUNTU_IMAGE_FILE=ubuntu-24.04-server-cloudimg-arm64.img
KEEPALIVE_LABEL_PREFIX=com.agora.vm
KEEPALIVE_INTERVAL=300
# The tailnet override (docker-compose.tailnet.yml) gives the web container 127.0.0.1:8080 inside
# the VM; the Mac-side ports keep clear of it
RESERVED_PORTS='8080'

# ─── The Mac ───

mac_os_version() { sw_vers -productVersion 2>/dev/null; }
mac_arch() { uname -m; }
# An x86_64 shell under Rosetta on Apple Silicon reports x86_64 from uname
mac_rosetta() { [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; }
mac_memory_gb() { local b; b=$(sysctl -n hw.memsize 2>/dev/null); echo $(( ${b:-0} / 1073741824 )); }
mac_cpus() { sysctl -n hw.ncpu 2>/dev/null || echo 2; }
mac_free_gb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print int($4 / 1048576)}' || true; }
# pmset's "sleep" minutes (0: never); empty when pmset says nothing
mac_sleep_minutes() { pmset -g 2>/dev/null | awk '$1 == "sleep" {print $2; exit}' || true; }

# version_ge <a> <b>: a >= b for dotted numeric versions (1.10 > 1.9)
version_ge() {
    local a=$1 b=$2 i x y
    for i in 1 2 3 4; do
        x=$(printf '%s' "$a" | cut -d. -f"$i"); y=$(printf '%s' "$b" | cut -d. -f"$i")
        x=${x%%[!0-9]*}; y=${y%%[!0-9]*}; x=${x:-0}; y=${y:-0}
        [ "$x" -gt "$y" ] && return 0
        [ "$x" -lt "$y" ] && return 1
    done
    return 0
}

# preflight_problems: one line per reason this Mac can't run the installer (none: it can)
preflight_problems() {
    local arch ver mem free
    [ "$(uname -s)" = Darwin ] || { echo "this is $(uname -s), not macOS; on Linux run install/linux/install.sh"; return; }
    [ "$(id -u)" != 0 ] || echo "don't run it as root (or with sudo): Lima runs the VM as your own user"
    arch=$(mac_arch)
    if [ "$arch" != arm64 ] || mac_rosetta; then
        if mac_rosetta; then echo "this shell runs under Rosetta (x86_64); open a native arm64 Terminal and run it again"
        else echo "this Mac has an Intel CPU ($arch); the macOS installer supports Apple Silicon only. Run Agora on a Linux machine instead (docs/getting-started.md)"; fi
    fi
    ver=$(mac_os_version)
    if [ -z "$ver" ]; then echo "can't read the macOS version (sw_vers)"
    elif ! version_ge "$ver" "$MACOS_MIN_VERSION"; then echo "macOS $ver is older than $MACOS_MIN_VERSION (Lima's Virtualization.framework VMs need it)"; fi
    mem=$(mac_memory_gb)
    [ "$mem" -ge "$MAC_MIN_MEMORY_GB" ] || echo "this Mac has ${mem} GB of memory; Agora's VM needs ${VM_MIN_MEMORY_GB} GB of a Mac with at least ${MAC_MIN_MEMORY_GB} GB"
    free=$(mac_free_gb "$HOME")
    [ "${free:-0}" -ge "$MAC_MIN_FREE_DISK_GB" ] || echo "${free:-0} GB free in $HOME; the VM needs ${MAC_MIN_FREE_DISK_GB} GB"
}

# ─── VM size: defaults the owner can change ───

# Half the cores, 2 to 8
default_vm_cpus() { local n=$(( $1 / 2 )); [ "$n" -ge 2 ] || n=2; [ "$n" -le 8 ] || n=8; echo "$n"; }
# 8 GiB (room for the stack and a few boxes) on a Mac with 16 GB or more, else the 6 GiB minimum
default_vm_memory() { if [ "$1" -ge 16 ]; then echo 8; else echo "$VM_MIN_MEMORY_GB"; fi; }
# What the VM may take at most: the Mac keeps 4 GB for itself
max_vm_memory() { echo $(( $1 - 4 )); }
default_vm_disk() { echo 100; }

# check_vm_size <cpus> <memory> <disk> <mac cpus> <mac memory>: a reason, or nothing
check_vm_size() {
    local c=$1 m=$2 d=$3 mc=$4 mm=$5
    printf '%s %s %s' "$c" "$m" "$d" | grep -Eq '^[0-9]+ [0-9]+ [0-9]+$' || { echo "CPUs, memory and disk are whole numbers (memory and disk in GiB)"; return; }
    [ "$c" -ge 2 ] || { echo "the VM needs at least 2 CPUs"; return; }
    [ "$c" -le "$mc" ] || { echo "this Mac has $mc CPUs; the VM can't have $c"; return; }
    [ "$m" -ge "$VM_MIN_MEMORY_GB" ] || { echo "the VM needs at least $VM_MIN_MEMORY_GB GiB of memory (the Linux installer wants 4 GB free inside it)"; return; }
    [ "$m" -le "$(max_vm_memory "$mm")" ] || { echo "this Mac has $mm GB; give the VM at most $(max_vm_memory "$mm") GiB so macOS keeps 4"; return; }
    [ "$d" -ge "$VM_MIN_DISK_GB" ] || { echo "the VM needs a disk of at least $VM_MIN_DISK_GB GiB"; return; }
}

# ─── Lima and Homebrew ───

find_brew() {
    if command -v brew >/dev/null 2>&1; then command -v brew
    elif [ -x /opt/homebrew/bin/brew ]; then echo /opt/homebrew/bin/brew
    else return 1; fi
}
# The bin folder of Homebrew's prefix (/opt/homebrew/bin), for launchd's PATH
brew_bin_dir() { local b; b=$(find_brew) || return 1; dirname "$b"; }

# Helpers that read state print nothing (and succeed) when there is nothing to read, so that
# `x=$(helper)` doesn't end a `set -eo pipefail` script
lima_version() {
    command -v limactl >/dev/null 2>&1 || return 0
    limactl --version 2>/dev/null | sed -n 's/.*version \([0-9][0-9.]*\).*/\1/p' | head -n 1 || true
}

brew_install_lima() { "$(find_brew)" install lima; }
brew_upgrade_lima() { "$(find_brew)" upgrade lima; }

# vm_status <name>: Running, Stopped, Broken, ...; empty when there is no such instance
vm_status() {
    command -v limactl >/dev/null 2>&1 || return 0
    limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | awk -v n="$1" '$1 == n {print $2; exit}' || true
}

# vm_sh <name> <command...>: run a command in the VM (limactl quotes each argument)
vm_sh() { local n=$1; shift; limactl shell --workdir /tmp "$n" "$@"; }

# vm_copy_in <name> <mac file> <guest path>
vm_copy_in() { limactl copy "$2" "$1:$3"; }
vm_copy_out() { limactl copy "$1:$2" "$3"; }

# ─── Ports on the Mac (127.0.0.1; macOS lets a normal user bind a port below 1024 only on 0.0.0.0) ───

mac_port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# mac_free_port <start> <taken...>: the first free port from start, counting up
mac_free_port() {
    local p=$1 i t busy; shift
    for i in $(seq 1 50); do
        busy=0
        for t in $RESERVED_PORTS "$@"; do [ "$t" = "$p" ] && busy=1; done
        if [ "$busy" = 0 ] && mac_port_free "$p"; then echo "$p"; return 0; fi
        p=$((p + 1))
    done
    return 1
}

# check_port <port>: a reason it can't be used for a forward, or nothing
check_port() {
    printf '%s' "$1" | grep -Eq '^[0-9]{1,5}$' || { echo "ports must be numbers"; return; }
    [ "$1" -ge 1024 ] || { echo "port $1 is below 1024: macOS lets a normal user listen there only on every network address, and Agora's ports stay on 127.0.0.1. Use 1024 or above"; return; }
    [ "$1" -le 65535 ] || echo "port $1 is above 65535"
}

# ─── The VM's Lima config ───

# image_digest: the arm64 image's SHA-256 from Canonical's SHA256SUMS (64 hex), or fail
image_digest() {
    local sums d
    sums=$(curl -fsSL --proto '=https' -m 60 "$UBUNTU_IMAGE_BASE/SHA256SUMS") || return 1
    d=$(printf '%s\n' "$sums" | awk -v f="$UBUNTU_IMAGE_FILE" '$2 == f || $2 == "*" f {print $1; exit}')
    printf '%s' "$d" | grep -Eq '^[0-9a-f]{64}$' || return 1
    printf '%s' "$d"
}

# lima_template <cpus> <memory GiB> <disk GiB> <digest> <http> <https> <api>
lima_template() {
    cat <<EOF
# Agora's VM, written by install/macos/install.sh (docs/macos.md). Lima reads it at every start.
# Port forwards: the three ports below reach the Mac on 127.0.0.1 only; nothing else in the VM
# is forwarded. Change them with install/macos/agora-vm.sh, not here, so the install agrees.
minimumLimaVersion: "$LIMA_MIN_VERSION"
vmType: vz
arch: aarch64
cpus: $1
memory: "$2GiB"
disk: "$3GiB"
images:
  - location: "$UBUNTU_IMAGE_BASE/$UBUNTU_IMAGE_FILE"
    arch: aarch64
    digest: "sha256:$4"
# Nothing of the Mac is shared with the VM: the installer copies the release in with limactl copy
mounts: []
# The Linux installer installs Docker Engine and gVisor itself; Lima's own containerd stays off
containerd:
  system: false
  user: false
ssh:
  forwardAgent: false
  loadDotSSHPubKeys: false
portForwards:
  - guestPort: $5
    hostIP: "127.0.0.1"
  - guestPort: $6
    hostIP: "127.0.0.1"
  - guestPort: $7
    hostIP: "127.0.0.1"
  - guestPortRange: [1, 65535]
    proto: any
    ignore: true
EOF
}

# ─── The installer's record of its VM (~/.agora/macos/<vm>.conf), read without sourcing it ───

state_file() { echo "$MAC_STATE_DIR/$1.conf"; }
state_get() { local f; f=$(state_file "$1"); [ -f "$f" ] || return 0; sed -n "s/^$2=//p" "$f" | tail -n 1; }
state_set() {
    local f tmp; f=$(state_file "$1")
    mkdir -p "$MAC_STATE_DIR"; chmod 700 "$MAC_STATE_DIR"
    touch "$f"
    tmp=$(mktemp "$f.XXXXXX")
    grep -v "^$2=" "$f" > "$tmp" || true
    printf '%s=%s\n' "$2" "$3" >> "$tmp"
    mv "$tmp" "$f"
}

# ─── Keep-alive (the counterpart of the Windows scheduled task) ───

keepalive_label() { echo "$KEEPALIVE_LABEL_PREFIX.$1"; }
keepalive_agent_plist() { echo "$HOME/Library/LaunchAgents/$(keepalive_label "$1").plist"; }
# Overridable for test/install/macos.test.sh only
LAUNCH_DAEMON_DIR=${AGORA_LAUNCH_DAEMON_DIR:-/Library/LaunchDaemons}
keepalive_daemon_plist() { echo "$LAUNCH_DAEMON_DIR/$(keepalive_label "$1").plist"; }
keepalive_script() { echo "$MAC_STATE_DIR/keepalive.sh"; }

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

# keepalive_plist <vm> <agent|daemon> <user> <path for launchd>: the property list
keepalive_plist() {
    local vm=$1 kind=$2 user=$3 path=$4 label script log home
    label=$(keepalive_label "$vm")
    script=$(keepalive_script | xml_escape)
    log=$(printf '%s' "$MAC_STATE_DIR/$vm-keepalive.log" | xml_escape)
    home=$(printf '%s' "$HOME" | xml_escape)
    path=$(printf '%s' "$path" | xml_escape)
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script</string>
    <string>$vm</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$home</string>
    <key>PATH</key><string>$path</string>
  </dict>
EOF
    if [ "$kind" = daemon ]; then
        printf '  <key>UserName</key><string>%s</string>\n' "$(printf '%s' "$user" | xml_escape)"
    fi
    cat <<EOF
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>$KEEPALIVE_INTERVAL</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
}

launchd_path() {
    local b
    b=$(brew_bin_dir 2>/dev/null || true)
    printf '%s' "${b:+$b:}/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# install_keepalive <vm> <agent|daemon> <source keepalive.sh>
install_keepalive() {
    local vm=$1 kind=$2 src=$3 plist tmp uid
    uid=$(id -u)
    mkdir -p "$MAC_STATE_DIR"; chmod 700 "$MAC_STATE_DIR"
    cp "$src" "$(keepalive_script)"; chmod 755 "$(keepalive_script)"
    if [ "$kind" = daemon ]; then
        plist=$(keepalive_daemon_plist "$vm")
        tmp=$(mktemp)
        keepalive_plist "$vm" daemon "$(id -un)" "$(launchd_path)" > "$tmp"
        sudo launchctl bootout "system/$(keepalive_label "$vm")" >/dev/null 2>&1 || true
        sudo install -m 644 -o root -g wheel "$tmp" "$plist"
        rm -f "$tmp"
        sudo launchctl bootstrap system "$plist"
        # One way to start it, not two
        remove_keepalive_agent "$vm"
    else
        plist=$(keepalive_agent_plist "$vm")
        mkdir -p "$(dirname "$plist")"
        keepalive_plist "$vm" agent "$(id -un)" "$(launchd_path)" > "$plist"
        launchctl bootout "gui/$uid/$(keepalive_label "$vm")" >/dev/null 2>&1 || true
        if ! launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1; then
            # Over SSH there is no login session to load it into; launchd loads it at the next login
            warn "no login session to load the keep-alive into (over SSH?). It starts at your next login; for a Mac nobody logs in to, run the installer again with --at-boot."
        fi
    fi
}

remove_keepalive_agent() {
    local plist; plist=$(keepalive_agent_plist "$1")
    launchctl bootout "gui/$(id -u)/$(keepalive_label "$1")" >/dev/null 2>&1 || true
    rm -f "$plist"
}

remove_keepalive_daemon() {
    local plist; plist=$(keepalive_daemon_plist "$1")
    [ -f "$plist" ] || return 0
    sudo launchctl bootout "system/$(keepalive_label "$1")" >/dev/null 2>&1 || true
    sudo rm -f "$plist"
}

# keepalive_kind <vm>: agent, daemon or none (what is installed)
keepalive_kind() {
    if [ -f "$(keepalive_daemon_plist "$1")" ]; then echo daemon
    elif [ -f "$(keepalive_agent_plist "$1")" ]; then echo agent
    else echo none; fi
}

# ─── The release, copied into the VM ───

# source_tarball <checkout> <out file>: the release without what never belongs in it
source_tarball() {
    COPYFILE_DISABLE=1 tar -C "$1" \
        --exclude ./.git --exclude ./.worktrees --exclude '*/node_modules' --exclude ./node_modules \
        --exclude ./dist --exclude ./.env --exclude ./.env.prod --exclude './.env.prod.*' --exclude ./.claude \
        --exclude ./.releases --exclude ./backups --exclude ./data --exclude '.DS_Store' \
        -czf "$2" .
}

# copy_source_in <vm> <checkout>: prints the release's folder in the VM
copy_source_in() {
    local vm=$1 src=$2 tmp gdir
    tmp=$(mktemp -d)
    source_tarball "$src" "$tmp/src.tgz" || { rm -rf "$tmp"; return 1; }
    gdir=$(vm_sh "$vm" mktemp -d /tmp/agora-src.XXXXXX | tr -d '\r') || { rm -rf "$tmp"; return 1; }
    vm_copy_in "$vm" "$tmp/src.tgz" "$gdir.tgz" >/dev/null || { rm -rf "$tmp"; return 1; }
    rm -rf "$tmp"
    vm_sh "$vm" tar --warning=no-unknown-keyword -xzf "$gdir.tgz" -C "$gdir" || return 1
    vm_sh "$vm" rm -f "$gdir.tgz"
    printf '%s' "$gdir"
}

# copy_secret_in <vm> <guest dir> <mac file>: copies a file into a 0700 folder in the VM, prints its path
copy_secret_in() {
    local g
    g="$2/$(basename "$3")"
    vm_copy_in "$1" "$3" "$g" >/dev/null || return 1
    vm_sh "$1" chmod 600 "$g"
    printf '%s' "$g"
}

# guest_install_dirs <vm>: the folder of every Agora install in the VM (Compose's record on api)
guest_install_dirs() {
    vm_sh "$1" sh -c 'f="{{.Label \"com.docker.compose.project.working_dir\"}}"; if docker info >/dev/null 2>&1; then docker ps -a --filter label=com.docker.compose.service=api --format "$f"; else sudo -n docker ps -a --filter label=com.docker.compose.service=api --format "$f"; fi 2>/dev/null | sed "/^\$/d" | sort -u' | tr -d '\r'
}
