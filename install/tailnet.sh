#!/usr/bin/env bash
# Reach an Agora install over Tailscale, in one command (docs/remote-access.md).
#
#   bash install/tailnet.sh on [--hostname NAME] [--dir <install folder>]
#   bash install/tailnet.sh off [--dir <install folder>]
#   bash install/tailnet.sh status [--dir <install folder>]
#   Options for on: --install-tailscale (don't ask before installing Tailscale), --non-interactive
#
# on:  1. installs Tailscale with its official script if it is missing, after asking;
#      2. logs this machine in (`tailscale up`, never --ssh): it prints a link, you approve it;
#      3. adds https://<machine>.<tailnet>.ts.net to CORS_ORIGIN (and to WEBAUTHN_ORIGINS when
#         that is set), keeping what is there;
#      4. records docker-compose.tailnet.yml as this install's compose override, so upgrades,
#         restores and backups keep it, and starts the stack with it;
#      5. publishes the web port on the tailnet (`tailscale serve`, never Funnel);
#      6. checks the result. Run again on an install that has all this, it changes nothing.
# off: stops publishing, takes the override out and starts the stack without it. Tailscale stays
#      installed and logged in.
# status: the checks alone; exit 1 when one of them failed.
#
# Two things only you can do, in Tailscale's admin console: approve the login link, and keep the
# `hosts` entry of your policy on this machine's address (the script prints it).
# On Windows run it inside the distro (wsl -d Agora), on a Mac through install/macos/agora-vm.sh tailnet.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/tailnet.sh
. "$HERE/lib/tailnet.sh"

SELF=$(cd "$HERE/.." && pwd)
CMD=${1:-}
[ $# -eq 0 ] || shift
DIR='' TS_HOSTNAME='' INSTALL_TS=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=${2:?--dir needs a folder}; shift ;;
        --hostname) TS_HOSTNAME=${2:?--hostname needs a name}; shift ;;
        --install-tailscale) INSTALL_TS=1 ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
        *) echo "tailnet.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
case "$CMD" in
    on|off|status) ;;
    ''|-h|--help) sed -n '2,23p' "$0"; [ -n "$CMD" ]; exit $? ;;
    *) echo "tailnet.sh: on, off or status" >&2; exit 2 ;;
esac
[ -z "$TS_HOSTNAME" ] || printf '%s' "$TS_HOSTNAME" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' || die "--hostname must be lowercase letters, digits and dashes"
DIR=$(cd "${DIR:-$SELF}" && pwd)
ENV="$DIR/$ENV_FILE_NAME"
[ -f "$ENV" ] || die "no $ENV_FILE_NAME in $DIR"
pick_docker || die "Docker isn't reachable"

wait_api() {
    local api deadline
    api=$(env_get "$ENV" AGORA_API_PORT)
    deadline=$(( $(date +%s) + 300 ))
    until curl -fsS -m 5 "http://127.0.0.1:${api:-3000}/health" 2>/dev/null | grep -q '"ok"'; do
        [ "$(date +%s)" -lt "$deadline" ] || die "the API didn't come back within 5 minutes ($(compose_cmd_text "$DIR" 'logs api'))"
        sleep 3
    done
}

# status_report: prints the state and the checks; returns 1 when a check failed
status_report() {
    local fails=0 bad
    for bad in $(rejected_overrides "$DIR"); do
        chk_fail "the compose override $bad is recorded in $DIR/$INSTALL_RECORD_NAME but this release has no such file"; fails=1
    done
    if ! tailnet_on "$DIR"; then
        say "Tailscale access: off (this install doesn't use $TAILNET_OVERRIDE)"
        say "  Turn it on with: bash $DIR/install/tailnet.sh on"
        return "$fails"
    fi
    say "Tailscale access: on ($TAILNET_OVERRIDE, $([ "$OVERRIDES_SOURCE" = record ] && printf 'recorded in %s' "$INSTALL_RECORD_NAME" || printf 'found on the running containers'))"
    local_health_check "$DIR" || fails=1
    tailnet_checks "$DIR" || fails=1
    return "$fails"
}

case "$CMD" in
status)
    status_report
    ;;

off)
    if ! tailnet_on "$DIR"; then
        say "Tailscale access is already off for the install in $DIR; nothing was changed."
        exit 0
    fi
    port=$(tailnet_port "$DIR")
    step tailnet.unserve 'Taking Agora off the tailnet'
    if have tailscale && [ -n "$(ts_serve_url "$port")" ]; then
        if as_root tailscale serve --https=443 off >/dev/null 2>&1; then ok 'tailscale serve no longer publishes Agora'
        else warn "couldn't turn tailscale serve off; do it yourself: sudo tailscale serve reset (it removes everything this machine serves)"; fi
    else
        ok 'tailscale serve was not publishing Agora'
    fi
    step tailnet.stack "Starting the stack without $TAILNET_OVERRIDE"
    keep=()
    for f in $OVERRIDES; do [ "$f" = "$TAILNET_OVERRIDE" ] || keep+=("$f"); done
    set_overrides "$DIR" ${keep[@]+"${keep[@]}"}
    compose_in "$DIR" up -d
    wait_api
    FINISHED=1
    say ''
    say "  Tailscale access is off. Caddy listens on every address of this machine again, as before."
    say "  Tailscale itself is still installed and logged in (to remove this machine from your tailnet: sudo tailscale logout), and the tailnet address stays in CORS_ORIGIN, where it does no harm."
    ;;

on)
    was_on=0; tailnet_on "$DIR" && was_on=1
    [ -f "$DIR/$TAILNET_OVERRIDE" ] || die "this release has no $TAILNET_OVERRIDE; upgrade first (bash $DIR/install/upgrade.sh)"
    cv=$(dk compose version --short 2>/dev/null | sed 's/^v//' || true)
    if [ -n "$cv" ] && ! ver_ge "$cv" "$TAILNET_MIN_COMPOSE"; then die "Docker Compose $cv is older than $TAILNET_MIN_COMPOSE, which $TAILNET_OVERRIDE needs; update Docker first"; fi
    port=$(tailnet_port "$DIR")

    step tailnet.install 'Tailscale on this machine'
    if have tailscale; then
        ok "tailscale $(tailscale version 2>/dev/null | head -n 1 || true)"
    else
        info "Tailscale isn't installed. Its official installer is $TS_INSTALL_URL (it adds Tailscale's package repository and installs the tailscale package, with sudo)."
        if [ "$INSTALL_TS" != 1 ]; then
            if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then die "Tailscale isn't installed and there is nobody to ask. Run it again with --install-tailscale, or install Tailscale yourself"; fi
            yes_no 'Install Tailscale that way now? [y/N]' n || die "not installing Tailscale; nothing was changed"
        fi
        have curl || die "curl is missing"
        ts_tmp=$(mktemp)
        curl -fsSL --proto '=https' -o "$ts_tmp" "$TS_INSTALL_URL" || { rm -f "$ts_tmp"; die "can't download $TS_INSTALL_URL"; }
        sh "$ts_tmp" || { rm -f "$ts_tmp"; die "Tailscale's installer failed"; }
        rm -f "$ts_tmp"
        have tailscale || die "Tailscale's installer finished, but there is no tailscale command"
        ok 'Tailscale installed'
    fi

    step tailnet.login 'Logging this machine in to your tailnet'
    state=$(ts_state)
    if [ -z "$state" ] && have systemctl; then as_root systemctl enable --now tailscaled >/dev/null 2>&1 || true; state=$(ts_state); fi
    if [ "$state" = Running ]; then
        name=$(ts_name)
        if [ -n "$TS_HOSTNAME" ] && [ "${name%%.*}" != "$TS_HOSTNAME" ]; then
            as_root tailscale set --hostname "$TS_HOSTNAME" || die "couldn't rename this machine to $TS_HOSTNAME (is the name taken? rename the other machine in the admin console first)"
            ok "this machine is now $TS_HOSTNAME"
        else
            ok "logged in as ${name:-this machine}"
        fi
    else
        if [ -z "$TS_HOSTNAME" ] && [ "$NON_INTERACTIVE" != 1 ] && [ -t 0 ]; then
            ask TS_HOSTNAME "This machine's name on your tailnet [agora-home]:" agora-home
            printf '%s' "$TS_HOSTNAME" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' || die "the name must be lowercase letters, digits and dashes"
        fi
        info 'Tailscale prints a link: open it, sign in and approve this machine. This waits until you have.'
        up_args=(up); [ -z "$TS_HOSTNAME" ] || up_args+=(--hostname "$TS_HOSTNAME")
        as_root tailscale "${up_args[@]}" || die "tailscale up failed; nothing in Agora was changed"
        [ "$(ts_state)" = Running ] || die "Tailscale still isn't logged in; nothing in Agora was changed"
        ok "logged in as $(ts_name)"
    fi
    name=$(ts_name)
    [ -n "$name" ] || die "this machine has no tailnet name yet. In Tailscale's admin console, under DNS, turn on MagicDNS and HTTPS Certificates, then run this again; nothing in Agora was changed"
    origin="https://$name"

    step tailnet.origin "Letting the browser log in at $origin"
    env_changed=0
    if add_tailnet_origin "$ENV" "$origin"; then env_changed=1; ok 'added to CORS_ORIGIN (and to WEBAUTHN_ORIGINS if you had set it); the values already there are kept'
    else ok 'already allowed'; fi

    step tailnet.stack "The stack with $TAILNET_OVERRIDE"
    running_has=0
    detected_overrides "$DIR" 2>/dev/null | grep -qx "$TAILNET_OVERRIDE" && running_has=1
    if [ "$was_on" = 0 ]; then
        install_overrides "$DIR"
        # shellcheck disable=SC2086 # a list of file names
        set_overrides "$DIR" $OVERRIDES "$TAILNET_OVERRIDE"
    fi
    if [ "$running_has" = 1 ] && [ "$env_changed" = 0 ] && curl -fsS -m 5 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q '"ok"'; then
        ok "already running with it (web on 127.0.0.1:$port)"
    else
        compose_in "$DIR" up -d
        wait_api
        ok "started (web on 127.0.0.1:$port, Caddy on 127.0.0.1 only)"
    fi

    step tailnet.serve 'Publishing Agora on your tailnet'
    if ts_funnel_on; then warn "Tailscale Funnel is on for something on this machine (tailscale funnel status). Agora is never published with Funnel; turn it off with: sudo tailscale funnel reset"; fi
    if [ -n "$(ts_serve_url "$port")" ]; then
        ok "tailscale serve already publishes it"
    else
        as_root tailscale serve --bg "http://127.0.0.1:$port" || die "tailscale serve failed. If it asked you to turn on HTTPS certificates, do that in the admin console (DNS) and run this again"
        ok "tailscale serve --bg http://127.0.0.1:$port"
    fi

    step tailnet.check 'Checking'
    FINISHED=1
    rc=0
    status_report || rc=1
    say ''
    say "  Agora on your tailnet: $origin"
    say "  In your Tailscale policy (admin console, Access controls), the 'hosts' entry for this machine must be $(ts_ip); only the devices you name there should reach it on port 443 (docs/remote-access.md, step 3)."
    exit "$rc"
    ;;
esac
