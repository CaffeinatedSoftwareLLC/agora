#!/usr/bin/env bash
# A fake `tailscale` for test/install/tailnet.test.sh. It keeps a machine's state under $FAKE_TS
# and logs every call to $FAKE_TS/log. Nothing real runs and nothing leaves this machine.
#
# State files in $FAKE_TS:
#   state        BackendState: Running, NeedsLogin, ... (missing: tailscaled doesn't answer)
#   name         the machine's tailnet name, without the trailing dot (agora-home.tail1234.ts.net)
#   ip           its 100.x address
#   serve_port   the 127.0.0.1 port `serve` publishes on https 443 (empty: nothing served)
#   funnel       "on" when serve status should show Funnel
#   tailnet      the tailnet's suffix a login gives the machine (default tail1234.ts.net)
set -u
T=${FAKE_TS:?FAKE_TS is not set}
mkdir -p "$T"
printf 'tailscale %s\n' "$*" >> "$T/log"
get() { cat "$T/$1" 2>/dev/null || true; }

case "${1:-}" in
    version) echo '1.90.6'; exit 0 ;;
    status)
        [ -f "$T/state" ] || { echo 'failed to connect to local tailscaled' >&2; exit 1; }
        n=$(get name)
        # The shape of `tailscale status --json`: this machine's entry (Self) before any peer
        printf '{\n  "Version": "1.90.6",\n  "BackendState": "%s",\n  "TailscaleIPs": ["%s"],\n  "Self": {\n    "HostName": "%s",\n    "DNSName": "%s",\n    "Online": true\n  },\n  "MagicDNSSuffix": "%s",\n  "Peer": {"k": {"DNSName": "my-phone.%s."}}\n}\n' \
            "$(get state)" "$(get ip)" "${n%%.*}" "${n:+$n.}" "$(get tailnet)" "$(get tailnet)"
        exit 0 ;;
    ip) get ip; exit 0 ;;
    up)
        host=''
        while [ $# -gt 0 ]; do [ "$1" = --hostname ] && host=$2; shift; done
        echo 'To authenticate, visit:'
        echo '        https://login.tailscale.com/a/fake0000'
        tn=$(get tailnet); tn=${tn:-tail1234.ts.net}
        echo Running > "$T/state"; echo "${host:-vm}.$tn" > "$T/name"; echo 100.64.0.7 > "$T/ip"
        exit 0 ;;
    set)
        while [ $# -gt 0 ]; do [ "$1" = --hostname ] && { n=$(get name); echo "$2.${n#*.}" > "$T/name"; }; shift; done
        exit 0 ;;
    serve)
        case "$*" in
            'serve status')
                p=$(get serve_port)
                [ -n "$p" ] || { echo 'No serve config'; exit 0; }
                if [ "$(get funnel)" = on ]; then printf 'https://%s (Funnel on)\n' "$(get name)"; else printf 'https://%s (tailnet only)\n' "$(get name)"; fi
                printf '|-- / proxy http://127.0.0.1:%s\n' "$p"
                exit 0 ;;
            'serve --bg http://127.0.0.1:'*) all="$*"; echo "${all##*:}" > "$T/serve_port"; echo 'Serve started and running in the background.'; exit 0 ;;
            'serve --https=443 off'|'serve reset') : > "$T/serve_port"; exit 0 ;;
        esac
        exit 1 ;;
    funnel) [ "$(get funnel)" = on ] && echo 'Funnel on'; exit 0 ;;
esac
exit 0
