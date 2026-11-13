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

# ─── Compose override files an install uses (docker-compose.tailnet.yml, docs/remote-access.md) ───
#
# An install started with `-f docker-compose.prod.yml -f docker-compose.tailnet.yml` must come
# back with both from an upgrade, a restore or a backup's restart, or its tailnet address stops
# answering. The list is this machine's own record, in .agora-install (compose_overrides=...):
# not in .env.prod, because a backup carries .env.prod to other machines and a restore replaces
# it, while Tailscale belongs to the machine. install/tailnet.sh writes it. An install without
# the record (set up by hand) is read once from its containers: Compose labels each one with the
# files it was started with (com.docker.compose.project.config_files), and what is found is
# written down, so a stopped or removed stack still knows.
INSTALL_RECORD_NAME=.agora-install
OVERRIDES_RECORD_KEY=compose_overrides
# Only a file name of this shape that exists in the install folder is ever used: never a path
OVERRIDE_NAME_RE='^docker-compose\.[a-z0-9][a-z0-9_-]{0,40}\.yml$'
TAILNET_OVERRIDE=docker-compose.tailnet.yml

record_has() { grep -q "^$2=" "$1/$INSTALL_RECORD_NAME" 2>/dev/null; }
record_get() { sed -n "s/^$2=//p" "$1/$INSTALL_RECORD_NAME" 2>/dev/null | tail -n 1 | tr -d '\r'; }
# record_set <dir> <key> <value>: replace or append one line of .agora-install
record_set() {
    local f="$1/$INSTALL_RECORD_NAME" tmp
    tmp=$(mktemp "$f.XXXXXX") || return 1
    { [ ! -f "$f" ] || grep -v "^$2=" "$f" || true; printf '%s=%s\n' "$2" "$3"; } > "$tmp" || { rm -f "$tmp"; return 1; }
    chmod 644 "$tmp"
    mv "$tmp" "$f"
}

# override_ok <dir> <name>: a safe override file name that is a file in the install folder
override_ok() {
    printf '%s' "$2" | grep -Eq "$OVERRIDE_NAME_RE" || return 1
    [ "$2" != "$COMPOSE_FILE_NAME" ] || return 1
    [ -f "$1/$2" ] && [ ! -L "$1/$2" ]
}

# detected_overrides <dir>: the compose file names this install's containers were started with,
# one per line, not yet checked. Only the names: the folder in a label is never used. Fails when
# Docker can't be asked.
detected_overrides() {
    local dir=$1 project filter out
    [ "${#DOCKER[@]}" -gt 0 ] || return 1
    project=$(env_get "$dir/$ENV_FILE_NAME" COMPOSE_PROJECT_NAME)
    if [ -n "$project" ]; then filter="label=com.docker.compose.project=$project"
    else filter="label=com.docker.compose.project.working_dir=$dir"; fi
    out=$(dk ps -a --filter "$filter" --format '{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null) || return 1
    # Containers of one project can differ (after `up` with another file list only the changed
    # services are recreated), so every file any of them names counts
    printf '%s\n' "$out" | tr ',' '\n' | sed -e 's/[[:space:]]*$//' -e 's#.*/##' -e '/^$/d' | awk '!seen[$0]++'
}

# install_overrides <dir>: sets OVERRIDES to the install's override files (space-separated, each
# one checked with override_ok). The record wins, also an empty one (tailnet off); without a
# record the containers are asked, and a find is recorded.
OVERRIDES=''
OVERRIDES_SOURCE=none
_OVR_DIR='' _OVR_DETECTED=''
install_overrides() {
    local dir=$1 raw='' name keep=''
    OVERRIDES='' OVERRIDES_SOURCE=none
    if record_has "$dir" "$OVERRIDES_RECORD_KEY"; then
        raw=$(record_get "$dir" "$OVERRIDES_RECORD_KEY")
        OVERRIDES_SOURCE=record
    else
        if [ "$_OVR_DIR" != "$dir" ]; then
            _OVR_DETECTED=$(detected_overrides "$dir" | tr '\n' ' ') || _OVR_DETECTED=''
            _OVR_DIR=$dir
        fi
        raw=$_OVR_DETECTED
    fi
    for name in $raw; do
        override_ok "$dir" "$name" || continue
        case " $keep " in *" $name "*) ;; *) keep="$keep${keep:+ }$name" ;; esac
    done
    OVERRIDES=$keep
    if [ "$OVERRIDES_SOURCE" = none ] && [ -n "$keep" ]; then
        OVERRIDES_SOURCE=detected
        # Best effort: a folder this user can't write to still gets the override from the labels
        record_set "$dir" "$OVERRIDES_RECORD_KEY" "$keep" 2>/dev/null || true
    fi
}

# set_overrides <dir> <names...>: record the install's override files (none: an empty record,
# which also stops the containers being asked)
set_overrides() {
    local dir=$1; shift
    record_set "$dir" "$OVERRIDES_RECORD_KEY" "$*"
}

# rejected_overrides <dir>: recorded names that can't be used (unsafe, or not in this release)
rejected_overrides() {
    local name
    for name in $(record_get "$1" "$OVERRIDES_RECORD_KEY"); do override_ok "$1" "$name" || printf '%s\n' "$name"; done
}

# compose in an install's folder: compose_in <dir> <args...>
compose_in() {
    local dir=$1; shift
    # The box image's build ID (scripts/box-build-id.sh): boxd rebuilds boxes on an older build
    local build='' f files
    [ -f "$dir/scripts/box-build-id.sh" ] && build=$(sh "$dir/scripts/box-build-id.sh" 2>/dev/null || true)
    files=(-f "$COMPOSE_FILE_NAME")
    install_overrides "$dir"
    for f in $OVERRIDES; do files+=(-f "$f"); done
    (cd "$dir" && AGORA_BOX_BUILD="${AGORA_BOX_BUILD:-$build}" "${DOCKER[@]}" compose "${files[@]}" --env-file "$ENV_FILE_NAME" "$@")
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

# The same command as text, for a message (with the install's override files)
compose_cmd_text() {
    local f flist="-f $COMPOSE_FILE_NAME"
    install_overrides "$1" 2>/dev/null || true
    for f in $OVERRIDES; do flist="$flist -f $f"; done
    printf 'cd %s && docker compose %s --env-file %s %s' "$1" "$flist" "$ENV_FILE_NAME" "$2"
}

# ─── A release from GitHub ───

# sha256_ok <dir>: agora.tar.gz in <dir> matches agora.tar.gz.sha256 (sha256sum, or macOS's shasum)
sha256_ok() {
    if have sha256sum; then (cd "$1" && sha256sum -c agora.tar.gz.sha256 >/dev/null 2>&1)
    else (cd "$1" && shasum -a 256 -c agora.tar.gz.sha256 >/dev/null 2>&1); fi
}

# fetch_release <tag|latest> <dest>: downloads agora.tar.gz and its SHA-256 from that release
# (latest: the fixed agora-latest release), checks it and unpacks it into <dest>, an existing
# empty folder. Returns 1 when the download fails, 2 when it doesn't match its SHA-256 (nothing
# is unpacked), 3 when it can't be unpacked.
fetch_release() {
    local ref=${1:-latest} dest=$2 url dl proto=()
    printf '%s' "$ref" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$' || return 1
    if [ "$ref" = latest ]; then url="$AGORA_RELEASE_BASE/download/agora-latest"; else url="$AGORA_RELEASE_BASE/download/$ref"; fi
    case "$url" in https://*) proto=(--proto '=https') ;; esac
    dl=$(mktemp -d) || return 1
    if ! curl -fsSL ${proto[@]+"${proto[@]}"} -o "$dl/agora.tar.gz" "$url/agora.tar.gz" \
        || ! curl -fsSL ${proto[@]+"${proto[@]}"} -o "$dl/agora.tar.gz.sha256" "$url/agora.tar.gz.sha256"; then
        rm -rf "$dl"; return 1
    fi
    sha256_ok "$dl" || { rm -rf "$dl"; return 2; }
    tar -xzf "$dl/agora.tar.gz" -C "$dest" --strip-components=1 || { rm -rf "$dl"; return 3; }
    rm -rf "$dl"
}
# fetch_release_or_die <tag|latest> <dest>
fetch_release_or_die() {
    local rc=0
    fetch_release "$1" "$2" || rc=$?
    case "$rc" in
        0) ;;
        2) die "the download of Agora ($1) doesn't match its SHA-256; nothing was changed" ;;
        3) die "the download of Agora ($1) can't be unpacked; nothing was changed" ;;
        *) die "can't download Agora ($1) from $AGORA_RELEASE_BASE; nothing was changed" ;;
    esac
}

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

# origin_list_add <comma list> <origin>: the list with origin appended once
origin_list_add() {
    local list=$1 o=$2 item
    local IFS=,
    for item in $list; do
        item=$(printf '%s' "$item" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's#/*$##')
        [ "$item" = "$o" ] && { printf '%s' "$list"; return; }
    done
    if [ -n "$list" ]; then printf '%s,%s' "$list" "$o"; else printf '%s' "$o"; fi
}

# add_origins_for_port <env file>: with AGORA_HTTPS_PORT other than 443, makes sure CORS_ORIGIN
# (and WEBAUTHN_ORIGINS when it is set, since it then replaces the defaults) allows
# https://localhost:<port>, and https://<DOMAIN>:<port> when DOMAIN is set (it may be the
# bundle's, from another machine). An empty CORS_ORIGIN starts from compose's default,
# https://<DOMAIN or localhost>, so setting it drops nothing. src/config.ts adds only
# https://localhost (no port) by itself.
add_origins_for_port() {
    local env=$1 port host o v new
    port=$(env_get "$env" AGORA_HTTPS_PORT)
    [ -n "$port" ] && [ "$port" != 443 ] || return 0
    host=$(env_get "$env" DOMAIN); host=${host#http*://}; host=${host%%/*}
    v=$(env_get "$env" CORS_ORIGIN)
    new=${v:-https://${host:-localhost}}
    for o in "https://localhost:$port" ${host:+"https://$host:$port"}; do new=$(origin_list_add "$new" "$o"); done
    [ "$new" = "$v" ] || env_set "$env" CORS_ORIGIN "$new"
    v=$(env_get "$env" WEBAUTHN_ORIGINS)
    [ -n "$v" ] || return 0
    new=$v
    for o in "https://localhost:$port" ${host:+"https://$host:$port"}; do new=$(origin_list_add "$new" "$o"); done
    [ "$new" = "$v" ] || env_set "$env" WEBAUTHN_ORIGINS "$new"
}

agora_version() {
    sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n 1
}

box_version() { tr -dc '0-9' < "$1/box/VERSION" 2>/dev/null || printf '1'; }

hex64() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

# A password for the first admin: 20 characters from [A-Za-z0-9]. A bounded read: with
# `tr < /dev/urandom | head -c 20`, head closes the pipe while tr still writes, tr dies of
# SIGPIPE and, under pipefail, the whole install stopped at admin.password with exit 141.
gen_password() {
    local chars
    chars=$(head -c 256 /dev/urandom | base64 | LC_ALL=C tr -dc 'A-Za-z0-9')
    printf '%s' "${chars:0:20}"
}

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

# Off until the person says yes: never taken from the caller's environment (a variable named
# TELEMETRY someone happened to export is not consent)
TELEMETRY=off
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
