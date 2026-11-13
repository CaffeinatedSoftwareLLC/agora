# shellcheck shell=bash disable=SC2034  # sourced; its variables are used by the scripts that source it
# Tailscale access to an install (docs/remote-access.md): what install/tailnet.sh does and what
# install/upgrade.sh and install/restore.sh check afterwards. Sourced after common.sh.
#
# The install's side is the compose override docker-compose.tailnet.yml (web on
# 127.0.0.1:<TAILNET_WEB_PORT>, Caddy on 127.0.0.1 only), recorded in .agora-install so every
# script keeps it (common.sh, install_overrides). The machine's side is `tailscale serve`, which
# publishes that port at https://<machine>.<tailnet>.ts.net. Nothing here turns Funnel on, passes
# --ssh or prints a key.

TS_INSTALL_URL=https://tailscale.com/install.sh
# The override replaces Caddy's ports with `!override`, which Compose reads from this version on
TAILNET_MIN_COMPOSE=2.24.4

# ver_ge <a> <b>: a >= b for dotted versions
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

chk_ok()   { printf '  ok      %s\n' "$*"; }
chk_fail() { printf '  FAILED  %s\n' "$*"; }
chk_note() { printf '  note    %s\n' "$*"; }

# tailnet_port <dir>: the port the override gives the web container on 127.0.0.1
tailnet_port() { local p; p=$(env_get "$1/$ENV_FILE_NAME" TAILNET_WEB_PORT); printf '%s' "${p:-8080}"; }

# tailnet_on <dir>: the install uses the tailnet override
tailnet_on() {
    install_overrides "$1"
    case " $OVERRIDES " in *" $TAILNET_OVERRIDE "*) return 0 ;; esac
    return 1
}

# ─── What Tailscale says about this machine (reads only) ───

ts_status_json() { tailscale status --peers=false --json 2>/dev/null | tr -d '\n' || true; }
# ts_field <json> <key>: the first string value of that key (this machine's own entry comes first)
ts_field() { printf '%s' "$1" | grep -Eo "\"$2\": *\"[^\"]*\"" | head -n 1 | sed 's/^[^:]*: *"\(.*\)"$/\1/' || true; }
# Running, NeedsLogin, Stopped, ...; empty when tailscaled doesn't answer
ts_state() { ts_field "$(ts_status_json)" BackendState; }
# <machine>.<tailnet>.ts.net; empty until the machine is logged in with MagicDNS on
ts_name() { local n; n=$(ts_field "$(ts_status_json)" DNSName); printf '%s' "${n%.}"; }
ts_ip() { tailscale ip -4 2>/dev/null | head -n 1 | tr -d '\r' || true; }
# ts_serve_url <port>: the https address `tailscale serve` publishes 127.0.0.1:<port> at, or nothing
ts_serve_url() {
    local s
    s=$(tailscale serve status 2>/dev/null || true)
    printf '%s\n' "$s" | grep -Eq "127\.0\.0\.1:$1([^0-9]|\$)" || return 0
    printf '%s\n' "$s" | grep -Eo 'https://[A-Za-z0-9.-]+' | head -n 1 || true
}
ts_funnel_on() { tailscale serve status 2>/dev/null | grep -qi 'funnel on'; }

# origin_in_list <comma list> <origin>
origin_in_list() { [ "$(origin_list_add "$1" "$2")" = "$1" ] && [ -n "$1" ]; }

# add_tailnet_origin <env file> <origin>: makes sure CORS_ORIGIN (and WEBAUTHN_ORIGINS when it is
# set) allows the tailnet address, keeping every value already there. An empty CORS_ORIGIN starts
# from compose's default, https://<DOMAIN or localhost>, so setting it drops nothing. Returns 0
# when the file changed, 1 when it already had the origin.
add_tailnet_origin() {
    local env=$1 origin=$2 host v new changed=1
    host=$(env_get "$env" DOMAIN); host=${host#http*://}; host=${host%%/*}
    v=$(env_get "$env" CORS_ORIGIN)
    new=$(origin_list_add "${v:-https://${host:-localhost}}" "$origin")
    if [ "$new" != "$v" ]; then env_set "$env" CORS_ORIGIN "$new"; changed=0; fi
    v=$(env_get "$env" WEBAUTHN_ORIGINS)
    if [ -n "$v" ]; then
        new=$(origin_list_add "$v" "$origin")
        if [ "$new" != "$v" ]; then env_set "$env" WEBAUTHN_ORIGINS "$new"; changed=0; fi
    fi
    return "$changed"
}

# ─── Checks: one line each; the return value is the number of FAILED lines ───

# local_health_check <dir>
local_health_check() {
    local api
    api=$(env_get "$1/$ENV_FILE_NAME" AGORA_API_PORT); api=${api:-3000}
    if curl -fsS -m 5 "http://127.0.0.1:$api/health" 2>/dev/null | grep -q '"ok"'; then chk_ok "Agora answers on http://127.0.0.1:$api/health"; return 0; fi
    chk_fail "nothing answers on http://127.0.0.1:$api/health. Look at: $(compose_cmd_text "$1" 'ps') and bash $1/install/doctor.sh"
    return 1
}

# tailnet_checks <dir>: for an install with the tailnet override on
tailnet_checks() {
    local dir=$1 port url name ip state fails=0 rc=0 fix
    port=$(tailnet_port "$dir")
    fix="bash $dir/install/tailnet.sh on"
    if curl -fsS -m 5 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q '"ok"'; then chk_ok "the web port Tailscale forwards to answers on 127.0.0.1:$port"
    else chk_fail "nothing answers on 127.0.0.1:$port (the port $TAILNET_OVERRIDE gives the web container). Run: $fix"; fails=$((fails + 1)); fi
    if ! have tailscale; then
        chk_fail "this install uses $TAILNET_OVERRIDE, but tailscale isn't installed on this machine. Run: $fix"
        return $((fails + 1))
    fi
    state=$(ts_state)
    if [ "$state" != Running ]; then
        chk_fail "Tailscale is ${state:-not answering} on this machine. Run: $fix"
        return $((fails + 1))
    fi
    name=$(ts_name); ip=$(ts_ip)
    url=$(ts_serve_url "$port")
    if [ -n "$url" ]; then chk_ok "tailscale serve publishes $url (to 127.0.0.1:$port)"
    else
        chk_fail "tailscale serve doesn't publish Agora. Run: sudo tailscale serve --bg http://127.0.0.1:$port (or: $fix)"
        fails=$((fails + 1))
        [ -z "$name" ] || url="https://$name"
    fi
    if ts_funnel_on; then chk_fail "Tailscale Funnel is on: something on this machine is open to the internet. Look at: tailscale funnel status; turn it off with: sudo tailscale funnel reset"; fails=$((fails + 1)); fi
    [ -n "$url" ] || return "$fails"
    if origin_in_list "$(env_get "$dir/$ENV_FILE_NAME" CORS_ORIGIN)" "$url"; then chk_ok "CORS_ORIGIN allows $url"
    else chk_fail "CORS_ORIGIN doesn't allow $url, so the browser can't log in there. Run: $fix"; fails=$((fails + 1)); fi
    # From this machine itself. A machine reaches its own tailnet address without the tailnet's
    # access rules, so an answer here doesn't prove the phone gets in, and no answer isn't
    # counted as a failure: the lines above are the ones an upgrade can break.
    curl -fsS -m 10 -o /dev/null "$url/health" 2>/dev/null || rc=$?
    if [ "$rc" = 0 ]; then chk_ok "$url answers from this machine"
    elif [ "$rc" = 28 ]; then chk_note "$url timed out from this machine. Try it from your phone"
    else chk_note "$url didn't answer from this machine (curl exit $rc). Try it from your phone"; fi
    chk_note "if it times out from another device while 'tailscale ping ${name:-this machine}' answers there, the 'hosts' entry in your Tailscale policy (admin console, Access controls) probably holds an old address. This machine's address is ${ip:-unknown (tailscale ip -4)}"
    return "$fails"
}

# post_start_checks <dir>: after an upgrade or a restore started the stack. Prints the lines;
# never fails the caller.
post_start_checks() {
    local dir=$1 bad name
    say ''
    say "${BOLD}Checks${RESET}"
    local_health_check "$dir" || true
    for bad in $(rejected_overrides "$dir"); do
        chk_fail "the compose override $bad is recorded in $dir/$INSTALL_RECORD_NAME but this release has no such file, so the stack runs without it"
    done
    if tailnet_on "$dir"; then
        tailnet_checks "$dir" || say "  Tailscale access needs a hand (the lines marked FAILED say what to run). The upgrade itself is done; nothing is rolled back."
    else
        for name in $(detected_overrides "$dir" 2>/dev/null || true); do
            [ "$name" != "$TAILNET_OVERRIDE" ] || chk_note "some containers were started with $TAILNET_OVERRIDE, but it is turned off in $dir/$INSTALL_RECORD_NAME"
        done
    fi
}
