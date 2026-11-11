# Docker Engine and gVisor for the Linux installer (docs/agent-boxes.md §12.1 step 3).
# Both come from their projects' own apt repositories, and only when missing. An existing
# engine's configuration is left alone except for registering the runsc runtime.

APT_PREREQS='ca-certificates curl gnupg'

# A fresh Ubuntu (a new WSL distro especially) runs apt's daily update or unattended-upgrades
# on first boot; wait for it instead of failing on the dpkg lock
APT_WAIT_SECONDS=${APT_WAIT_SECONDS:-600}
# unattended-upgrade is matched by its command line, not its name: every Ubuntu also keeps
# "unattended-upgrade-shutdown --wait-for-signal" running for as long as it is up, and both show
# as unattended-upgr in the process table
APT_UU_RE='/unattended-upgrade( |$)'
apt_busy() { pgrep -x 'apt|apt-get|dpkg' >/dev/null 2>&1 || pgrep -f "$APT_UU_RE" >/dev/null 2>&1; }
wait_for_apt() {
    local waited=0
    apt_busy || return 0
    info "waiting for another apt or dpkg process (often the first-boot update) to finish"
    while apt_busy; do
        [ "$waited" -ge "$APT_WAIT_SECONDS" ] && die "another apt or dpkg process is still running after ${APT_WAIT_SECONDS}s. Wait for it to finish (ps -ef | grep -E 'apt|dpkg|unattended-upgrade ') and run the installer again."
        sleep 5; waited=$((waited + 5))
    done
}

apt_update() {
    wait_for_apt
    as_root apt-get -o DPkg::Lock::Timeout="$APT_WAIT_SECONDS" update -qq
}

apt_install() {
    wait_for_apt
    as_root env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout="$APT_WAIT_SECONDS" install -y --no-install-recommends "$@"
}

ensure_prereqs() {
    local missing=() p
    for p in curl gpg; do have "$p" || missing+=("$p"); done
    [ -e /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
    [ "${#missing[@]}" -eq 0 ] && return 0
    info "installing $APT_PREREQS"
    apt_update
    # shellcheck disable=SC2086
    apt_install $APT_PREREQS
}


# Docker Desktop's WSL integration puts its own `docker` in the distro; that engine can't run gVisor
docker_is_desktop() {
    local osname
    osname=$(dk info --format '{{.OperatingSystem}}' 2>/dev/null || true)
    case "$osname" in *"Docker Desktop"*) return 0 ;; esac
    return 1
}

install_docker_engine() {
    local id codename arch
    id=$(os_id)
    codename=$(os_field VERSION_CODENAME)
    [ -n "$codename" ] || codename=$(os_field UBUNTU_CODENAME)
    [ -n "$codename" ] || die "can't tell this $id release's codename from /etc/os-release"
    arch=$(dpkg --print-architecture)
    ensure_prereqs
    info "adding Docker's apt repository (download.docker.com/linux/$id $codename)"
    as_root install -m 0755 -d /etc/apt/keyrings
    as_root curl -fsSL "https://download.docker.com/linux/$id/gpg" -o /etc/apt/keyrings/docker.asc
    as_root chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$arch" "$id" "$codename" \
        | as_root tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt_update
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    if [ -d /run/systemd/system ]; then as_root systemctl enable --now docker >/dev/null
    else as_root service docker start >/dev/null; fi
    if [ "$(id -u)" != 0 ]; then
        as_root usermod -aG docker "$(id -un)"
        info "added $(id -un) to the docker group (it applies from your next login; this run uses sudo)"
    fi
}

runsc_registered() { dk info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; }

# Makes dockerd re-read daemon.json without stopping containers: runtimes are reloadable
reload_docker() {
    if [ -d /run/systemd/system ]; then as_root systemctl reload docker
    elif have service; then as_root service docker reload || as_root kill -HUP "$(pidof dockerd)"
    else as_root kill -HUP "$(pidof dockerd)"; fi
}

install_gvisor() {
    local arch
    arch=$(dpkg --print-architecture)
    if ! have runsc; then
        ensure_prereqs
        info "adding gVisor's apt repository (storage.googleapis.com/gvisor/releases)"
        curl -fsSL https://gvisor.dev/archive.key | as_root gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
        printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n' "$arch" \
            | as_root tee /etc/apt/sources.list.d/gvisor.list > /dev/null
        apt_update
        apt_install runsc
    fi
    if ! runsc_registered; then
        # Adds the runsc runtime to /etc/docker/daemon.json; nothing else in it changes
        as_root runsc install
        reload_docker
        local i
        for i in 1 2 3 4 5 6 7 8 9 10; do runsc_registered && break; sleep 1; done
        runsc_registered || die "runsc is installed but Docker doesn't list it. Restart Docker (sudo systemctl restart docker; it stops running containers) and run the installer again."
    fi
}

# Boxes and code runs need a kernel that is gVisor's, not the host's
check_gvisor() {
    local out
    out=$(dk run --rm --runtime=runsc --network none alpine:3.20 sh -c 'uname -r; dmesg 2>/dev/null | head -n 3' 2>&1) || die "a test container under runsc failed: $(printf '%s' "$out" | tail -n 3)"
    printf '%s' "$out" | grep -qi gvisor || die "a runsc container didn't report a gVisor kernel: $(printf '%s' "$out" | head -n 1)"
}
