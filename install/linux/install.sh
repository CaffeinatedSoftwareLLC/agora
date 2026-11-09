#!/usr/bin/env bash
# Agora installer for Debian and Ubuntu (docs/agent-boxes.md §12.1, docs/installing.md).
#
#   bash install/linux/install.sh                    # asks what it needs
#   bash install/linux/install.sh --non-interactive --agent claude --telemetry off \
#        --admin-user admin --admin-password-file ./pw [--instance agora2] [--source .]
#
# It installs Docker Engine and gVisor from their apt repositories when they are missing,
# writes .env.prod, starts the stack, creates the first admin and the first agent's box, and
# prints the URL. On failure it prints the failed step, how to remove what this run created,
# and offers a problem report (sent only if you say yes after reading it).
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: install.sh [options]

  --non-interactive          never ask; every answer comes from these flags (or defaults)
  --instance NAME            install name (default: agora, or the next free agoraN)
  --dir DIR                  where to put it (default: ~/agora, or ~/agora-<instance>)
  --source DIR               install from this checkout instead of downloading a release
  --ref TAG                  release to download (default: latest)
  --domain NAME              your domain (default: none, https://localhost)
  --http-port N --https-port N --api-port N   ports (default: 80, 443, 3000, or free ones)
  --admin-user NAME          first admin's username (default: admin)
  --admin-email ADDRESS      first admin's email (default: <user>@localhost.localdomain)
  --admin-password-file F    first admin's password (default: generated and shown once)
  --agent claude|codex|none  the first agent's CLI (default: ask; none without a terminal)
  --agent-name NAME          its name (default: the CLI's name)
  --agent-api-key-file F     run it on an API key instead of a subscription login
  --telemetry on|off         send one anonymous install report (default: ask; off)
  --existing upgrade|alongside|stop   what to do when this engine already has Agora
                             (default: ask; stop without a terminal)
  --passphrase-file F        backup passphrase, for --existing upgrade without a terminal
  --wsl                      running inside WSL (the Windows installer passes this)
  --lima                     running inside the macOS installer's Lima VM (it passes this)
  --box-image-target box|test   test: the box image with fake CLIs (CI only)
  --box-insecure-dev         run boxes with runc instead of gVisor (dev only, never production)
  --min-disk-gb N            free disk required (default 20)
  -h, --help
EOF
}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# ─── Arguments ───
ARGS=("$@")
NON_INTERACTIVE=0 INSTANCE='' INSTALL_DIR='' SOURCE='' REF=latest DOMAIN=''
HTTP_PORT='' HTTPS_PORT='' API_PORT='' ADMIN_USER='' ADMIN_EMAIL='' ADMIN_PW_FILE=''
AGENT='' AGENT_NAME='' AGENT_KEY_FILE='' TELEMETRY_ARG='' EXISTING='' WSL=0 LIMA=0 PASS_FILE_ARG='' DOCKER_INSTALLED=0
BOX_TARGET=box BOX_INSECURE=0 MIN_DISK_GB=${AGORA_MIN_DISK_GB:-20}
need() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "install.sh: $1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
    case "$1" in
        --non-interactive) NON_INTERACTIVE=1 ;;
        --instance) need "$@"; INSTANCE=$2; shift ;;
        --dir) need "$@"; INSTALL_DIR=$2; shift ;;
        --source) need "$@"; SOURCE=$2; shift ;;
        --ref) need "$@"; REF=$2; shift ;;
        --domain) need "$@"; DOMAIN=$2; shift ;;
        --http-port) need "$@"; HTTP_PORT=$2; shift ;;
        --https-port) need "$@"; HTTPS_PORT=$2; shift ;;
        --api-port) need "$@"; API_PORT=$2; shift ;;
        --admin-user) need "$@"; ADMIN_USER=$2; shift ;;
        --admin-email) need "$@"; ADMIN_EMAIL=$2; shift ;;
        --admin-password-file) need "$@"; ADMIN_PW_FILE=$2; shift ;;
        --agent) need "$@"; AGENT=$2; shift ;;
        --agent-name) need "$@"; AGENT_NAME=$2; shift ;;
        --agent-api-key-file) need "$@"; AGENT_KEY_FILE=$2; shift ;;
        --telemetry) need "$@"; TELEMETRY_ARG=$2; shift ;;
        --existing) need "$@"; EXISTING=$2; shift ;;
        --passphrase-file) need "$@"; PASS_FILE_ARG=$2; shift ;;
        --wsl) WSL=1 ;;
        --lima) LIMA=1 ;;
        --box-image-target) need "$@"; BOX_TARGET=$2; shift ;;
        --box-insecure-dev) BOX_INSECURE=1 ;;
        --min-disk-gb) need "$@"; MIN_DISK_GB=$2; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "install.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

# ─── Standalone run: fetch the release, then run its own installer ───
if [ ! -f "$HERE/../lib/common.sh" ]; then
    [ -z "$SOURCE" ] || { echo "install.sh: --source $SOURCE has no install/lib; use a full checkout" >&2; exit 2; }
    command -v curl >/dev/null || { echo "install.sh: needs curl (sudo apt-get install -y curl)" >&2; exit 1; }
    base=${AGORA_RELEASE_BASE:-https://github.com/CaffeinatedSoftwareLLC/agora/releases}
    if [ "$REF" = latest ]; then url="$base/download/agora-latest"; else url="$base/download/$REF"; fi
    tmp=$(mktemp -d)
    echo "Downloading Agora ($REF) from $url"
    curl -fsSL -o "$tmp/agora.tar.gz" "$url/agora.tar.gz"
    curl -fsSL -o "$tmp/agora.tar.gz.sha256" "$url/agora.tar.gz.sha256"
    (cd "$tmp" && sha256sum -c agora.tar.gz.sha256) || { echo "install.sh: the download doesn't match its SHA-256; not installing" >&2; exit 1; }
    mkdir "$tmp/src"
    tar -xzf "$tmp/agora.tar.gz" -C "$tmp/src" --strip-components=1
    exec bash "$tmp/src/install/linux/install.sh" "${ARGS[@]}" --source "$tmp/src"
fi

# shellcheck source=../lib/common.sh
. "$HERE/../lib/common.sh"
# shellcheck source=../lib/docker.sh
. "$HERE/../lib/docker.sh"
# shellcheck source=../lib/stack.sh
. "$HERE/../lib/stack.sh"

DOCTOR_SCRIPT="$HERE/../doctor.sh"
trap 'on_exit $?' EXIT

case "$AGENT" in ''|claude|codex|none) ;; *) die "--agent must be claude, codex or none" ;; esac
case "$TELEMETRY_ARG" in ''|on|off) ;; *) die "--telemetry must be on or off" ;; esac
case "$EXISTING" in ''|upgrade|alongside|stop) ;; *) die "--existing must be upgrade, alongside or stop" ;; esac
case "$BOX_TARGET" in box|test) ;; *) die "--box-image-target must be box or test" ;; esac
[ -z "$INSTANCE" ] || printf '%s' "$INSTANCE" | grep -Eq '^[a-z][a-z0-9-]{0,30}$' || die "--instance must be lowercase letters, digits and dashes, starting with a letter"
[ -z "$ADMIN_PW_FILE" ] || [ -r "$ADMIN_PW_FILE" ] || die "can't read --admin-password-file $ADMIN_PW_FILE"
[ -z "$AGENT_KEY_FILE" ] || [ -r "$AGENT_KEY_FILE" ] || die "can't read --agent-api-key-file $AGENT_KEY_FILE"
[ -z "$PASS_FILE_ARG" ] || [ -r "$PASS_FILE_ARG" ] || die "can't read --passphrase-file $PASS_FILE_ARG"
for p in "$HTTP_PORT" "$HTTPS_PORT" "$API_PORT"; do [ -z "$p" ] || printf '%s' "$p" | grep -Eq '^[0-9]{1,5}$' || die "ports must be numbers"; done

SRC_ROOT=$(cd "$HERE/../.." && pwd)
[ -n "$SOURCE" ] || SOURCE=$SRC_ROOT
SOURCE=$(cd "$SOURCE" && pwd)
[ -f "$SOURCE/$COMPOSE_FILE_NAME" ] || die "$SOURCE has no $COMPOSE_FILE_NAME; is it an Agora checkout?"
AGORA_VERSION=$(agora_version "$SOURCE")
AGORA_VERSION=${AGORA_VERSION:-unknown}
OS_NAME=$(os_id)
[ "$WSL" = 1 ] && OS_NAME="${OS_NAME}-wsl"
[ "$LIMA" = 1 ] && OS_NAME="${OS_NAME}-lima"

say "${BOLD}Agora $AGORA_VERSION installer${RESET}"

# ─── 1. Preflight ───
step preflight.os 'Checking this machine'
case "$(os_id)" in
    ubuntu|debian) ok "$(os_field PRETTY_NAME)" ;;
    *)
        cat >&2 <<EOF

  This installer supports Debian and Ubuntu. On $(os_field PRETTY_NAME || uname -s), install by hand:
    1. Docker Engine with the compose plugin: https://docs.docker.com/engine/install/
    2. gVisor (runsc), registered with Docker: https://gvisor.dev/docs/user_guide/install/
    3. Follow docs/getting-started.md from "1. Configure secrets".
EOF
        die "unsupported distribution: $(os_id)"
        ;;
esac
case "$(uname -m)" in x86_64|aarch64) ok "$(uname -m)" ;; *) die "unsupported CPU architecture $(uname -m) (x86_64 or arm64 only)" ;; esac

step preflight.kernel 'Checking the kernel'
kver=$(uname -r)
kmaj=${kver%%.*}; krest=${kver#*.}; kmin=${krest%%[!0-9]*}
if [ "$kmaj" -lt 5 ] || { [ "$kmaj" -eq 5 ] && [ "$kmin" -lt 6 ]; }; then die "kernel $kver is older than 5.6"; fi
ok "kernel $kver"

step preflight.memory 'Checking memory'
mem_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
[ "${mem_kb:-0}" -ge $((4 * 1024 * 1024)) ] || die "$((mem_kb / 1024)) MB of memory available; Agora needs 4 GB free"
ok "$((mem_kb / 1024 / 1024)) GB available"

if [ "$WSL" = 1 ]; then
    step preflight.wsl 'Checking WSL'
    grep -qi microsoft /proc/version || die "--wsl given, but this isn't WSL"
    [ -d /run/systemd/system ] || die "systemd is off in this distro. Add [boot] systemd=true to /etc/wsl.conf, run wsl --terminate <distro> from Windows, and start again"
    ok "WSL with systemd"
fi
if [ "$LIMA" = 1 ]; then
    step preflight.lima 'Checking the Lima VM'
    [ -d /run/systemd/system ] || die "--lima given, but systemd isn't running in this VM"
    ok "Lima VM with systemd"
fi

# ─── 3. Docker Engine (before 2: listing installs needs Docker; gVisor after the question) ───
step docker.install 'Docker Engine'
if have docker && pick_docker; then
    if docker_is_desktop; then
        die "this docker is Docker Desktop's (WSL integration), which can't run gVisor. Turn it off for this distro: Docker Desktop → Settings → Resources → WSL integration"
    fi
    ok "Docker $(dk version --format '{{.Server.Version}}') already installed; its settings are left as they are"
    dk compose version >/dev/null 2>&1 || die "Docker is installed without the compose plugin: sudo apt-get install docker-compose-plugin"
else
    if have docker; then die "docker is installed but not reachable (is the daemon running? sudo systemctl start docker)"; fi
    install_docker_engine
    DOCKER_INSTALLED=1
    add_cleanup 'Docker Engine was installed by this run; to remove it: sudo apt-get purge docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
    pick_docker || die "Docker was installed but doesn't answer"
    ok "Docker $(dk version --format '{{.Server.Version}}')"
fi

# ─── 2. Existing installs ───
step existing 'Looking for Agora installs on this Docker engine'
mapfile -t found < <(agora_instances)
if [ "${#found[@]}" -gt 0 ]; then
    info "this engine already has: ${found[*]}"
    partial=()
    for f in "${found[@]}"; do
        d=$(instance_dir "$f" || true)
        if [ -n "$d" ] && [ -f "$d/.agora-install-pending" ]; then
            info "  $f: $d (an install that didn't finish)"
            partial+=("$f")
        else
            info "  $f: ${d:-folder unknown}"
        fi
    done
    choice=$EXISTING
    if [ -z "$choice" ]; then
        if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then choice=stop
        else ask choice 'Upgrade an existing one (upgrade), install another alongside (alongside), or stop (stop)? [stop]' stop; fi
    fi
    case "$choice" in
        upgrade)
            target=${INSTANCE:-${found[0]}}
            tdir=$(instance_dir "$target")
            [ -n "$tdir" ] && [ -f "$tdir/$ENV_FILE_NAME" ] || die "can't find the folder of install $target; run install/upgrade.sh in it"
            [ ! -f "$tdir/.agora-install-pending" ] || die "install $target didn't finish (it has no admin yet); remove it with: bash $tdir/install/uninstall.sh --dir $tdir --purge --confirm $target, then install again"
            up_args=(--dir "$tdir" --source "$SOURCE")
            [ "$NON_INTERACTIVE" = 0 ] || up_args+=(--non-interactive)
            [ -z "$PASS_FILE_ARG" ] || up_args+=(--passphrase-file "$PASS_FILE_ARG")
            FINISHED=1
            exec bash "$HERE/../upgrade.sh" "${up_args[@]}"
            ;;
        alongside)
            if [ -z "$INSTANCE" ]; then
                INSTANCE=agora; n=2
                while printf '%s\n' "${found[@]}" | grep -qx "$INSTANCE"; do INSTANCE="agora$n"; n=$((n + 1)); done
            fi
            printf '%s\n' "${found[@]}" | grep -qx "$INSTANCE" && die "an install named $INSTANCE already exists; choose another --instance"
            ok "installing alongside as $INSTANCE"
            ;;
        *)
            FINISHED=1
            if [ "$DOCKER_INSTALLED" = 1 ]; then say '  Stopped. This run installed Docker Engine; nothing else was changed.'
            else say '  Stopped; nothing was changed.'; fi
            if [ "${#partial[@]}" -gt 0 ]; then
                for f in "${partial[@]}"; do
                    d=$(instance_dir "$f")
                    say "  Install $f didn't finish. Remove it with: bash $d/install/uninstall.sh --dir $d --purge --confirm $f"
                done
                exit 1
            fi
            exit 0 ;;
    esac
fi
INSTANCE=${INSTANCE:-agora}
printf '%s\n' "${found[@]:-}" | grep -qx "$INSTANCE" && die "an install named $INSTANCE already exists on this engine"

# ─── 3b. gVisor ───
step gvisor.install 'gVisor (runsc)'
if [ "$BOX_INSECURE" = 1 ]; then
    warn "--box-insecure-dev: boxes and code runs share this machine's kernel. Never use this in production."
else
    install_gvisor
    step gvisor.check 'A test container under gVisor'
    check_gvisor
    ok "runsc works"
fi


if [ -z "$INSTALL_DIR" ]; then
    if [ "$INSTANCE" = agora ]; then INSTALL_DIR="$HOME/agora"; else INSTALL_DIR="$HOME/agora-$INSTANCE"; fi
fi

step preflight.disk 'Checking disk space'
mkdir -p "$(dirname "$INSTALL_DIR")"
free_kb=$(df -Pk "$(dirname "$INSTALL_DIR")" | awk 'NR==2 {print $4}')
docker_root=$(dk info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
dfree_kb=$(df -Pk "$docker_root" 2>/dev/null | awk 'NR==2 {print $4}' || echo "$free_kb")
[ "${dfree_kb:-0}" -ge $((MIN_DISK_GB * 1024 * 1024)) ] || die "$((dfree_kb / 1024 / 1024)) GB free for Docker ($docker_root); Agora needs ${MIN_DISK_GB} GB"
ok "$((dfree_kb / 1024 / 1024)) GB free"

step preflight.ports 'Choosing ports'
# Ports other installs publish count as taken even while those installs are stopped
mapfile -t taken < <(published_ports)
pick() { # pick <given> <default> <step>
    if [ -n "$1" ]; then
        if port_free "$1" && ! printf '%s\n' "${taken[@]:-}" | grep -qx "$1"; then printf '%s' "$1"; return; fi
        # The Windows installer picks ports that are free on Windows; inside WSL take the next free one
        [ "$WSL" = 1 ] || die "port $1 is in use (or published by another install)"
        warn "port $1 is in use here; choosing another"
        free_port "$(( $1 + $3 ))" "$3" "${taken[@]:-}" || die "no free port after $1"
        return
    fi
    free_port "$2" "$3" "${taken[@]:-}" || die "no free port from $2"
}
HTTP_PORT=$(pick "$HTTP_PORT" 80 8000); taken+=("$HTTP_PORT")
HTTPS_PORT=$(pick "$HTTPS_PORT" 443 8000); taken+=("$HTTPS_PORT")
API_PORT=$(pick "$API_PORT" 3000 1); taken+=("$API_PORT")
ok "http $HTTP_PORT, https $HTTPS_PORT, api $API_PORT"

# ─── 4. Agora itself ───
step source.copy "Putting Agora in $INSTALL_DIR"
if [ "$(cd "$INSTALL_DIR" 2>/dev/null && pwd)" = "$SOURCE" ]; then
    ok "installing in place in $SOURCE"
else
    [ ! -e "$INSTALL_DIR/$ENV_FILE_NAME" ] || die "$INSTALL_DIR already has an install ($ENV_FILE_NAME); use install/upgrade.sh there, or choose --dir"
    created_dir=0
    [ -d "$INSTALL_DIR" ] || created_dir=1
    mkdir -p "$INSTALL_DIR"
    [ "$created_dir" = 0 ] || add_cleanup "rm -rf $INSTALL_DIR"
    tar -C "$SOURCE" --exclude=./.git --exclude='*/node_modules' --exclude=./node_modules --exclude='./dist' \
        --exclude=./.env --exclude=./.env.prod --exclude=./.claude -cf - . | tar -C "$INSTALL_DIR" -xf -
    ok "copied $AGORA_VERSION"
fi

# ─── 6. Telemetry question (asked before config so the answer goes into .env.prod) ───
step telemetry 'Telemetry'
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

# ─── 5. Config ───
step config 'Writing .env.prod'
DOCKER_GID=$(getent group docker | cut -d: -f3 || true)
[ -n "$DOCKER_GID" ] || die "no docker group on this machine (getent group docker)"
setup_args=(--prod --non-interactive --instance "$INSTANCE" --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT"
    --api-port "$API_PORT" --docker-gid "$DOCKER_GID" --telemetry "$TELEMETRY")
[ -z "$DOMAIN" ] || setup_args+=(--domain "$DOMAIN")
[ "$BOX_TARGET" = box ] || setup_args+=(--box-target "$BOX_TARGET")
# No Node on the host: setup-env runs in a node:22 container, with no network and as this user
dk run --rm --network none --user "$(id -u):$(id -g)" -v "$INSTALL_DIR:/w" -w /w node:22-slim \
    node scripts/setup-env.js "${setup_args[@]}" > "$INSTALL_DIR/.setup-env.log" 2>&1 \
    || { cat "$INSTALL_DIR/.setup-env.log" >&2; die "setup-env.js failed"; }
rm -f "$INSTALL_DIR/.setup-env.log"
ENV_FILE="$INSTALL_DIR/$ENV_FILE_NAME"
chmod 600 "$ENV_FILE"
[ "$BOX_INSECURE" = 0 ] || env_set "$ENV_FILE" AGORA_BOX_INSECURE_DEV 1
[ "$BOX_INSECURE" = 0 ] || env_set "$ENV_FILE" AGORA_SANDBOX_INSECURE_DEV 1
[ -z "${AGORA_TELEMETRY_URL:-}" ] || env_set "$ENV_FILE" AGORA_TELEMETRY_URL "$AGORA_TELEMETRY_URL"
ok "$ENV_FILE (keep a copy somewhere safe: AGORA_ENCRYPTION_KEY can't be recovered)"
# Until the end: another run sees this as an install that didn't finish
date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.agora-install-pending"

# ─── 8a. The first admin's name and password, checked before anything starts ───
step admin.password 'The first admin'
[ -n "$ADMIN_USER" ] || ask ADMIN_USER 'Admin username [admin]:' admin
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_EMAIL=${ADMIN_EMAIL:-$ADMIN_USER@localhost.localdomain}
pw_tmp=''
if [ -z "$ADMIN_PW_FILE" ]; then
    pw_tmp=$(mktemp)
    chmod 600 "$pw_tmp"
    typed=''
    if [ "$NON_INTERACTIVE" = 0 ] && [ -t 0 ]; then
        read -r -s -p '  Admin password (Enter generates one): ' typed || true
        printf '\n'
    fi
    if [ -n "$typed" ]; then printf '%s' "$typed" > "$pw_tmp"; GENERATED_PW=0; else gen_password > "$pw_tmp"; GENERATED_PW=1; fi
    unset typed
    ADMIN_PW_FILE=$pw_tmp
fi
[ "$(wc -c < "$ADMIN_PW_FILE")" -ge 8 ] || die "the admin password must be at least 8 characters"

# ─── 7. Start ───
step start 'Building and starting the stack (the first build takes a while)'
add_cleanup "bash $INSTALL_DIR/install/uninstall.sh --dir $INSTALL_DIR --purge --confirm $INSTANCE   # this install's containers, boxes and data"
compose_in "$INSTALL_DIR" up -d --build
api_base "$API_PORT"

step health 'Waiting for the API'
wait_health 300 || die "the API didn't answer on $API/health within 5 minutes ($(compose_cmd_text "$INSTALL_DIR" 'logs api'))"
ok "$API/health"

# ─── 8. First admin ───
step admin 'Creating the first admin'
token=$(setup_token "$INSTALL_DIR") || die "no setup token in the API's log ($(compose_cmd_text "$INSTALL_DIR" 'logs api'))"
ACCESS=$(instance_setup "$token" "$ADMIN_USER" "$ADMIN_EMAIL" "$ADMIN_PW_FILE")
unset token
[ -n "$ACCESS" ] || die "instance setup returned no access token"
ok "admin $ADMIN_USER"

# ─── 9. First box ───
step box 'The first agent'
if [ -z "$AGENT" ]; then
    if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then AGENT=none
    else ask AGENT 'Which agent should get the first box: claude (Claude Code), codex (Codex) or none? [claude]' claude; fi
fi
case "$AGENT" in claude|codex|none) ;; *) die "agent must be claude, codex or none" ;; esac
BOX_ID=''
if [ "$AGENT" != none ]; then
    AGENT_NAME=${AGENT_NAME:-$AGENT}
    [ "$AGENT_NAME" != "$ADMIN_USER" ] || AGENT_NAME="$AGENT-box"
    SERVER=$(server_id); [ -n "$SERVER" ] || die "the instance has no default server"
    CHANNEL=$(general_channel "$SERVER" "$ACCESS"); [ -n "$CHANNEL" ] || die "the default server has no #general"
    BOX_ID=$(create_box "$SERVER" "$CHANNEL" "$ACCESS" "$AGENT_NAME" "$AGENT" "$AGENT_KEY_FILE")
    ok "box $AGENT_NAME ($BOX_ID) created; its home channel is #general"
    step box.start 'Waiting for the box to start'
    wait_box_running "$SERVER" "$ACCESS" "$BOX_ID" 600
    ok "box $AGENT_NAME is running"
fi

# ─── 10. Done ───
step 'done' 'Done'
FINISHED=1
send_install_report ok null
host=${DOMAIN:-localhost}
URL="https://$host$([ "$HTTPS_PORT" = 443 ] || printf ':%s' "$HTTPS_PORT")"
rm -f "$INSTALL_DIR/.agora-install-pending"
cat > "$INSTALL_DIR/.agora-install" <<EOF
instance=$INSTANCE
version=$AGORA_VERSION
installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
wsl=$WSL
lima=$LIMA
EOF
say ''
say "${BOLD}Agora is running.${RESET}"
say "  Open:      $URL   (a local certificate: your browser will warn once)"
say "  Log in as: $ADMIN_USER"
if [ "${GENERATED_PW:-0}" = 1 ]; then
    say "  Password:  $(cat "$ADMIN_PW_FILE")   (shown once; change it in Settings)"
fi
[ -z "$pw_tmp" ] || rm -f "$pw_tmp"
if [ -n "$BOX_ID" ]; then say "  Then open Settings → Agents and press Log in on $AGENT_NAME's box."; fi
say "  Agents on this machine: http://localhost:$API_PORT"
say "  Folder:    $INSTALL_DIR   (doctor: bash install/doctor.sh, backup: bash install/backup.sh)"
if have xdg-open && [ "$WSL" = 0 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
printf 'AGORA_URL=%s\n' "$URL" > "$INSTALL_DIR/.agora-url"
# The Windows installer opens this (the ports may differ from the ones it suggested)
mkdir -p "$HOME/.agora" && printf '%s\n' "$URL" > "$HOME/.agora/last-install-url"
