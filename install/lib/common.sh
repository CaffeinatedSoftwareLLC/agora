# Shared helpers for install/linux/install.sh, install/doctor.sh, backup, restore, upgrade and
# uninstall (docs/agent-boxes.md §9, §12). Sourced by bash scripts that run `set -euo pipefail`.
#
# Step ids (STEP) are what a failed install reports, to the user and, only with telemetry on,
# to the collector (docs/telemetry.md lists them). They match ^[a-z][a-z0-9.-]{0,63}$.

AGORA_RELEASE_BASE=${AGORA_RELEASE_BASE:-https://github.com/CaffeinatedSoftwareLLC/agora/releases}
AGORA_TELEMETRY_URL_DEFAULT=https://push.agora.host
COMPOSE_FILE_NAME=docker-compose.prod.yml
# Overridable so the box test suite can back up its own stack (.env.boxtest)
ENV_FILE_NAME=${AGORA_ENV_FILE_NAME:-.env.prod}

STEP=start
STEP_DESC=''
FINISHED=0
NON_INTERACTIVE=${NON_INTERACTIVE:-0}
# Commands that undo what this run created, printed (never run) when it fails
CLEANUP_CMDS=()

if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
else BOLD=''; DIM=''; RED=''; GREEN=''; RESET=''; fi

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %sok%s  %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %swarning:%s %s\n' "$BOLD" "$RESET" "$*" >&2; }
die()  { printf '\n  %serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# step <id> <what it does>: everything until the next step call fails as <id>
step() {
    STEP=$1
    STEP_DESC=$2
    printf '\n%s[%s]%s %s\n' "$BOLD" "$1" "$RESET" "$2"
}

add_cleanup() { CLEANUP_CMDS+=("$1"); }

# ─── Questions (every one has a flag for --non-interactive) ───

# ask <var> <prompt> <default>: the answer, or the default without a terminal
ask() {
    local __var=$1 __prompt=$2 __def=${3:-} __ans=''
    if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then
        printf -v "$__var" '%s' "$__def"
        return
    fi
    read -r -p "  $__prompt " __ans || true
    printf -v "$__var" '%s' "${__ans:-$__def}"
}

# yes_no <prompt> <default y|n>: exit status 0 for yes
yes_no() {
    local ans
    ask ans "$1" "$2"
    case "$ans" in [Yy]|[Yy][Ee][Ss]) return 0 ;; *) return 1 ;; esac
}

# ─── Machine ───

os_field() { (. /etc/os-release 2>/dev/null && eval "printf '%s' \"\${$1:-}\"") || true; }
os_id() { os_field ID; }
os_version() { os_field VERSION_ID; }

as_root() {
    if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# The docker command that works for this user: plain, or through sudo right after the
# installer added the user to the docker group (the group applies from the next login)
DOCKER=()
pick_docker() {
    if docker info >/dev/null 2>&1; then DOCKER=(docker)
    elif [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null && sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker)
    elif [ "$(id -u)" != 0 ] && have sudo && sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker)
    else return 1; fi
}

dk() { "${DOCKER[@]}" "$@"; }

# compose in an install's folder: compose_in <dir> <args...>
compose_in() {
    local dir=$1; shift
    (cd "$dir" && "${DOCKER[@]}" compose -f "$COMPOSE_FILE_NAME" --env-file "$ENV_FILE_NAME" "$@")
}

# An install's name: the Compose project and AGORA_INSTANCE are one name (#209). Installs made
# before #209 have neither in .env.prod, so Compose named their project after the install folder.
INSTANCE_NAME_RE='^[a-z0-9][a-z0-9_-]{0,62}$'
# install_project <dir>: the Compose project as Compose itself resolves it for that folder
install_project() {
    local dir=$1 p
    p=$(env_get "$dir/$ENV_FILE_NAME" COMPOSE_PROJECT_NAME)
    if [ -z "$p" ]; then
        p=$(compose_in "$dir" config 2>/dev/null | sed -n 's/^name: *//p' | head -n 1) || p=''
    fi
    [ -n "$p" ] || return 1
    printf '%s' "$p"
}
# install_instance <dir>: AGORA_INSTANCE, else the Compose project
install_instance() {
    local i
    i=$(env_get "$1/$ENV_FILE_NAME" AGORA_INSTANCE)
    if [ -n "$i" ]; then printf '%s' "$i"; else install_project "$1"; fi
}
# pin_identity <dir>: write COMPOSE_PROJECT_NAME and AGORA_INSTANCE into .env.prod when missing,
# from the project Compose uses now; refuse when they disagree. Run before the release changes.
pin_identity() {
    local dir=$1 env project inst
    env="$1/$ENV_FILE_NAME"
    project=$(install_project "$dir") || die "can't tell the Compose project name of the install in $dir"
    inst=$(env_get "$env" AGORA_INSTANCE)
    [ -z "$inst" ] || [ "$inst" = "$project" ] || die "AGORA_INSTANCE ($inst) and the Compose project ($project) differ in $env; make them the same, then upgrade"
    printf '%s' "$project" | grep -Eq "$INSTANCE_NAME_RE" || die "the Compose project name $project can't be used as an install name"
    [ -n "$(env_get "$env" COMPOSE_PROJECT_NAME)" ] || env_set "$env" COMPOSE_PROJECT_NAME "$project"
    [ -n "$inst" ] || env_set "$env" AGORA_INSTANCE "$project"
}

compose_cmd_text() { printf 'cd %s && docker compose -f %s --env-file %s %s' "$1" "$COMPOSE_FILE_NAME" "$ENV_FILE_NAME" "$2"; }

# env_get <file> <KEY>: a value from .env.prod, for the installer's own use. Never printed.
env_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1 | tr -d '\r'; }

# env_set <file> <KEY> <value>: replace or append one line, keeping the file's mode
env_set() {
    local file=$1 key=$2 value=$3 tmp
    tmp=$(mktemp "${file}.XXXXXX")
    if grep -q "^$key=" "$file"; then
        awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} index($0, k"=")==1 {print k"="v; next} {print}' "$file" > "$tmp"
    else
        cat "$file" > "$tmp"
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
    fi
    chmod 600 "$tmp"
    mv "$tmp" "$file"
}

agora_version() {
    sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n 1
}

box_version() { tr -dc '0-9' < "$1/box/VERSION" 2>/dev/null || printf '1'; }

hex64() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

# A password for the first admin: 20 characters from [A-Za-z0-9]
gen_password() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20; }

port_free() {
    if have ss; then
        ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
    else
        ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
    fi
}

# Host ports any container on this engine publishes, running or not (one per line). A stopped
# install keeps its ports: they must not go to another install.
published_ports() {
    local ids
    ids=$(dk ps -aq 2>/dev/null) || return 0
    [ -n "$ids" ] || return 0
    # shellcheck disable=SC2086 # one argument per container id
    dk inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' $ids 2>/dev/null \
        | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -un || true
}

# free_port <start> <step> <taken...>
free_port() {
    local p=$1 st=$2 i; shift 2
    for i in $(seq 1 50); do
        if port_free "$p" && ! printf '%s\n' "$@" | grep -qx "$p"; then printf '%s' "$p"; return 0; fi
        p=$((p + st))
    done
    return 1
}

# Agora installs on this engine: compose projects with an api service or a pgdata volume, and
# instances that own boxes
agora_instances() {
    {
        dk ps -a --filter label=com.docker.compose.service=api --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null || true
        dk volume ls --filter label=com.docker.compose.volume=pgdata --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null || true
        dk ps -a --filter label=org.agora.instance --format '{{.Label "org.agora.instance"}}' 2>/dev/null || true
    } | sed '/^$/d' | sort -u
}

# The folder an install was started from (compose records it on every container)
instance_dir() {
    dk ps -a --filter "label=com.docker.compose.project=$1" --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sed '/^$/d' | head -n 1
}

# Removes anything shaped like a credential (the same rules as src/lib/doctor.ts)
redact() {
    sed -E \
        -e 's#([a-z][a-z0-9+.-]*://)[^[:space:]/:@]+:[^[:space:]/@]+@#\1<redacted>@#g' \
        -e 's/Bearer[[:space:]]+[^[:space:]]+/Bearer <redacted>/g' \
        -e 's/\b(ah|bot|sk|sk-ant|ghp|gho|ghs|ghu|github_pat|xox[abp])[_-][A-Za-z0-9._-]{8,}/<redacted-token>/g' \
        -e 's/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/<redacted-jwt>/g' \
        -e 's/\b[0-9a-fA-F]{32,}\b/<redacted-hex>/g' \
        -e 's/[A-Za-z0-9+_]{40,}={0,2}/<redacted>/g' \
        -e 's/\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]*)=[^[:space:]]+/\1=<redacted>/g'
}

# ─── JSON without jq ───

# A JSON string literal for arbitrary text
json_str() {
    awk 'BEGIN { ORS = ""; print "\"" }
         { if (NR > 1) print "\\n"
           gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r")
           gsub(/[\001-\010\013\014\016-\037]/, "")
           print }
         END { print "\"" }'
}

# json_get <key>: the first string (or bare number/boolean) value of key in a flat JSON reply on stdin
json_get() {
    tr -d '\n' | sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p; t; s/.*\"$1\" *: *\([0-9a-z.-]*\).*/\1/p" | head -n 1
}

# ─── Telemetry (docs/telemetry.md) ───

TELEMETRY_QUESTION='Send one anonymous report when this install finishes? It contains only:
  - whether the install succeeded, or the step it failed at
  - the Agora version
  - the operating system name and version

No names, addresses, IPs or IDs are kept. [y/N]'

TELEMETRY=${TELEMETRY:-off}
TELEMETRY_SENT=0
AGORA_VERSION=${AGORA_VERSION:-unknown}
OS_NAME=${OS_NAME:-}

# send_install_report ok|failed <step|null>: one POST when telemetry is on; never anything else
send_install_report() {
    [ "$TELEMETRY" = on ] || return 0
    [ "$TELEMETRY_SENT" = 0 ] || return 0
    TELEMETRY_SENT=1
    have curl || return 0
    local step_json=null os ver
    [ "$2" = null ] || step_json="\"$2\""
    os=${OS_NAME:-$(os_id)}
    ver=$(os_version)
    # Keep to what the collector accepts: printable ASCII, at most 64 characters
    os=$(printf '%s' "${os:-linux}" | LC_ALL=C tr -cd ' -~' | head -c 64)
    ver=$(printf '%s' "${ver:-unknown}" | LC_ALL=C tr -cd ' -~' | head -c 64)
    local v; v=$(printf '%s' "$AGORA_VERSION" | LC_ALL=C tr -cd ' -~' | head -c 64)
    curl -fsS -m 10 -o /dev/null -H 'User-Agent:' -H 'Content-Type: application/json' \
        -d "{\"result\":\"$1\",\"step\":$step_json,\"version\":\"$v\",\"os\":\"$os\",\"osVersion\":\"$ver\"}" \
        "${AGORA_TELEMETRY_URL:-$AGORA_TELEMETRY_URL_DEFAULT}/telemetry/v1/install" 2>/dev/null || true
}

# ─── Problem report (§12.5): shown in full, sent only on an explicit yes ───

# send_problem_report <file>: prints the report id
send_problem_report() {
    local file=$1 body reply id
    body="{\"report\":$(json_str < "$file"),\"version\":\"$(printf '%s' "$AGORA_VERSION" | LC_ALL=C tr -cd ' -~' | head -c 64)\",\"os\":\"$(printf '%s' "${OS_NAME:-$(os_id)}" | LC_ALL=C tr -cd ' -~' | head -c 64)\"}"
    reply=$(printf '%s' "$body" | curl -sS -m 30 -H 'User-Agent:' -H 'Content-Type: application/json' --data-binary @- \
        "${AGORA_TELEMETRY_URL:-$AGORA_TELEMETRY_URL_DEFAULT}/telemetry/v1/problem") || return 1
    id=$(printf '%s' "$reply" | json_get reportId)
    [ -n "$id" ] || return 1
    printf '%s' "$id"
}

# offer_problem_report <doctor script> <install dir or ''>
offer_problem_report() {
    local doctor=$1 dir=$2 file id
    [ -x "$doctor" ] || [ -f "$doctor" ] || return 0
    if [ "$NON_INTERACTIVE" = 1 ] || [ ! -t 0 ]; then
        say "  To report this problem: bash $doctor${dir:+ --dir $dir} --report"
        return 0
    fi
    yes_no 'Report this problem? You will see the full report first. [y/N]' n || return 0
    file=$(mktemp)
    {
        printf 'install step: %s (%s)\n' "$STEP" "$STEP_DESC"
        printf 'agora: %s\n\n' "$AGORA_VERSION"
        bash "$doctor" ${dir:+--dir "$dir"} 2>&1 || true
    } > "$file"
    say ''
    say '----- report -----'
    cat "$file"
    say '----- end of report -----'
    if yes_no "Send this report to ${AGORA_TELEMETRY_URL:-$AGORA_TELEMETRY_URL_DEFAULT}? [y/N]" n; then
        if id=$(send_problem_report "$file"); then
            say "  Sent. Report id: $id (quote it in an issue)"
        else
            say '  Could not send it. The report is above; paste it into an issue instead.'
        fi
    fi
    rm -f "$file"
}

# Installed as the EXIT trap by scripts that report failures
on_exit() {
    local code=$1
    [ "$FINISHED" = 1 ] && return 0
    [ "$code" = 0 ] && return 0
    printf '\n%sFailed at step %s%s: %s\n' "$RED" "$STEP" "$RESET" "$STEP_DESC" >&2
    if [ "${#CLEANUP_CMDS[@]}" -gt 0 ]; then
        # Newest first: the stack goes before its folder, the folder before Docker itself
        printf '\n  To remove what this run created, in this order:\n' >&2
        local i
        for (( i=${#CLEANUP_CMDS[@]}-1; i>=0; i-- )); do printf '    %s\n' "${CLEANUP_CMDS[$i]}" >&2; done
    fi
    send_install_report failed "$STEP"
    if [ -n "${DOCTOR_SCRIPT:-}" ]; then offer_problem_report "$DOCTOR_SCRIPT" "${INSTALL_DIR:-}"; fi
}
