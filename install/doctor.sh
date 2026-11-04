#!/usr/bin/env bash
# Agora doctor (docs/agent-boxes.md §12.5): checks Docker, gVisor, ports, the stack's
# containers, health, the runner's runtime, boxd, the edge and every box, as plain lines.
#
#   bash install/doctor.sh [--dir <install folder>] [--report] [--quick]
#
# No secrets: of .env.prod it reads only the install name and the three ports, and for every
# other key says whether it is set. Every line is passed through a filter that removes
# anything shaped like a token. --report shows the result and asks before sending it.
# Exit code 0 when every check passed, 1 when any FAILED.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

DIR=$(cd "$HERE/.." && pwd)
REPORT=0 QUICK=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        --report) REPORT=1 ;;
        --quick) QUICK=1 ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "doctor.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done

if [ "$REPORT" = 1 ]; then
    AGORA_VERSION=$(agora_version "$DIR" || true)
    AGORA_VERSION=${AGORA_VERSION:-unknown}
    DOCTOR_SCRIPT="$HERE/doctor.sh"
    STEP=doctor STEP_DESC='problem report from install/doctor.sh'
    offer_problem_report "$DOCTOR_SCRIPT" "$DIR"
    exit 0
fi

FAILS=0
line() { printf '%s\n' "$*" | redact; }
pass() { line "ok    $*"; }
fail() { line "FAIL  $*"; FAILS=$((FAILS + 1)); }
note() { line "      $*"; }
head_() { printf '\n## %s\n' "$1"; }

ENV="$DIR/$ENV_FILE_NAME"
INSTANCE=agora HTTP=80 HTTPS=443 APIP=3000
if [ -f "$ENV" ]; then
    INSTANCE=$(env_get "$ENV" AGORA_INSTANCE); INSTANCE=${INSTANCE:-agora}
    HTTP=$(env_get "$ENV" AGORA_HTTP_PORT); HTTP=${HTTP:-80}
    HTTPS=$(env_get "$ENV" AGORA_HTTPS_PORT); HTTPS=${HTTPS:-443}
    APIP=$(env_get "$ENV" AGORA_API_PORT); APIP=${APIP:-3000}
fi
printf '%s\n' "$INSTANCE$HTTP$HTTPS$APIP" | grep -Eq '^[a-z0-9-]+$' || { INSTANCE=agora; HTTP=80; HTTPS=443; APIP=3000; }

printf '# Agora doctor\n'
line "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
line "agora: $(agora_version "$DIR" || echo unknown)  box image version: $(box_version "$DIR")"
line "os: $(os_field PRETTY_NAME)  kernel: $(uname -r)  arch: $(uname -m)"
grep -qi microsoft /proc/version 2>/dev/null && line "wsl: yes  systemd: $([ -d /run/systemd/system ] && echo on || echo off)"
line "folder: $DIR  instance: $INSTANCE"

head_ 'Machine'
mem_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
line "memory available: $((mem_kb / 1024)) MB"
line "disk free here: $(df -Ph "$DIR" 2>/dev/null | awk 'NR==2 {print $4}')"

head_ 'Docker'
if ! have docker; then
    fail 'docker: not installed'
elif ! pick_docker; then
    fail 'docker: installed but not reachable (daemon stopped, or this user is not in the docker group)'
else
    pass "docker $(dk version --format '{{.Server.Version}}' 2>/dev/null) on $(dk info --format '{{.OperatingSystem}}' 2>/dev/null)"
    dk compose version >/dev/null 2>&1 && pass "$(dk compose version 2>/dev/null | head -n 1)" || fail 'docker compose plugin missing'
    case "$(dk info --format '{{.OperatingSystem}}' 2>/dev/null)" in *"Docker Desktop"*) note 'this is Docker Desktop: no gVisor, so boxes and code runs need AGORA_BOX_INSECURE_DEV / AGORA_SANDBOX_INSECURE_DEV' ;; esac
    if dk info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; then
        pass 'runsc registered with Docker'
        if [ "$QUICK" = 0 ]; then
            k=$(dk run --rm --runtime=runsc --network none alpine:3.20 uname -r 2>&1 | tail -n 1 || true)
            case "$k" in *gvisor*|4.4.0) pass "runsc container kernel: $k" ;; *) fail "runsc container did not start or reported kernel '$k'" ;; esac
        fi
    else
        fail 'runsc is not registered with Docker (sudo runsc install && sudo systemctl reload docker)'
    fi
fi

head_ 'Configuration (.env.prod: set or not set, values never shown)'
if [ -f "$ENV" ]; then
    for k in COMPOSE_PROJECT_NAME AGORA_INSTANCE DB_PASSWORD JWT_SECRET AGORA_ENCRYPTION_KEY AGORA_EDGE_SECRET DOCKER_GID DOMAIN \
             AGORA_BOX_VERSION AGORA_TELEMETRY AGORA_BOX_INSECURE_DEV AGORA_SANDBOX_INSECURE_DEV; do
        if grep -Eq "^$k=.+" "$ENV"; then line "$k: set"; else line "$k: not set"; fi
    done
    perm=$(stat -c %a "$ENV" 2>/dev/null || echo '?')
    [ "$perm" = 600 ] && pass ".env.prod mode 600" || note ".env.prod mode $perm (600 recommended)"
    [ "$(env_get "$ENV" AGORA_BOX_VERSION)" = "$(box_version "$DIR")" ] && pass 'AGORA_BOX_VERSION matches box/VERSION' || note 'AGORA_BOX_VERSION differs from box/VERSION (install/upgrade.sh sets it)'
else
    fail "no .env.prod in $DIR"
fi

head_ 'Ports'
for p in "$HTTP" "$HTTPS" "$APIP"; do
    if port_free "$p"; then note "port $p: nothing listening"; else pass "port $p: in use (expected while the stack runs)"; fi
done

head_ 'Stack'
if [ "${#DOCKER[@]}" -gt 0 ] && [ -f "$ENV" ]; then
    ps_out=$(compose_in "$DIR" ps -a --format '{{.Service}}|{{.State}}|{{.Status}}' 2>/dev/null || true)
    if [ -z "$ps_out" ]; then fail 'no containers for this install (not started?)'; fi
    while IFS='|' read -r svc state status; do
        [ -n "$svc" ] || continue
        case "$svc:$state" in
            migrate:exited|files-perms:exited|sandbox-image:exited|box-image:exited)
                case "$status" in *"(0)"*) pass "$svc: $status" ;; *) fail "$svc: $status" ;; esac ;;
            *:running) pass "$svc: $status" ;;
            *) fail "$svc: $state $status" ;;
        esac
    done <<< "$ps_out"
    if curl -fsS -m 5 "http://127.0.0.1:$APIP/health" 2>/dev/null | grep -q '"ok"'; then pass "api health on 127.0.0.1:$APIP"; else fail "api health on 127.0.0.1:$APIP"; fi
    code=$(curl -ks -o /dev/null -m 5 -w '%{http_code}' "https://localhost:$HTTPS/" 2>/dev/null || true)
    [ "$code" = 200 ] && pass "web on https://localhost:$HTTPS" || fail "web on https://localhost:$HTTPS answered '${code:-nothing}'"

    head_ 'Runner (code runs)'
    rl=$(compose_in "$DIR" logs --no-color --tail 300 runner 2>/dev/null | grep -Eo 'runtime=[a-z]+.*' | tail -n 1 || true)
    if [ -n "$rl" ]; then
        case "$rl" in runtime=runsc*) pass "runner $rl" ;; *) note "runner $rl (not gVisor)" ;; esac
    else
        fail 'runner has not logged its runtime (not started, or refusing without gVisor)'
        compose_in "$DIR" logs --no-color --tail 5 runner 2>/dev/null | sed 's/^/      /' | redact || true
    fi

    head_ 'Boxes'
    if compose_in "$DIR" exec -T box-edge node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then
        pass 'box-edge /healthz'
    else
        fail 'box-edge /healthz'
    fi
    for svc in boxd box-edge; do
        note "last lines of $svc:"
        compose_in "$DIR" logs --no-color --tail 5 "$svc" 2>/dev/null | sed 's/^/        /' | redact || true
    done
    boxes=$(dk ps -a --filter "label=org.agora.instance=$INSTANCE" --filter label=org.agora.box --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Label "org.agora.box.version"}}|{{.Label "org.agora.box.generation"}}' 2>/dev/null || true)
    if [ -z "$boxes" ]; then note 'no box containers'; fi
    while IFS='|' read -r name state status ver gen; do
        [ -n "$name" ] || continue
        rt=$(dk inspect -f '{{.HostConfig.Runtime}}' "$name" 2>/dev/null || echo '?')
        msg="$name: $status, image v$ver, generation $gen, runtime $rt"
        if [ "$state" = running ]; then pass "$msg"; else fail "$msg"; fi
        [ "$rt" = runsc ] || [ "$(env_get "$ENV" AGORA_BOX_INSECURE_DEV)" = 1 ] || fail "$name is not under gVisor"
    done <<< "$boxes"
    line "box networks: $(dk network ls --filter "name=${INSTANCE}_box_" -q 2>/dev/null | wc -l)  box home volumes: $(dk volume ls --filter "label=org.agora.instance=$INSTANCE" -q 2>/dev/null | wc -l)"
fi

printf '\n'
if [ "$FAILS" = 0 ]; then line 'result: every check passed'; else line "result: $FAILS check(s) FAILED"; fi
[ "$FAILS" = 0 ]
