#!/usr/bin/env bash
# Unit checks for install/lib/*.sh: JSON helpers, .env.prod editing, redaction, the telemetry
# switch and the problem report's consent. No Docker needed; curl is replaced by a fake that
# records its calls.
#
#   bash test/install/lib.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../../install/lib/common.sh
. "$ROOT/install/lib/common.sh"
# shellcheck source=../../install/lib/stack.sh
. "$ROOT/install/lib/stack.sh"

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
n=0 failed=0
check() { # check <name> <expected> <actual>
    n=$((n + 1))
    if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi
}
check_true() { n=$((n + 1)); if eval "$2"; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s (%s)\n' "$1" "$2"; failed=$((failed + 1)); fi; }

# ─── JSON ───
check 'json_str escapes quotes, backslashes, tabs and newlines' '"a \"b\" \\c\td\ne"' "$(printf 'a "b" \\c\td\ne' | json_str)"
check 'json_str drops other control characters' '"xy"' "$(printf 'x\001y' | json_str)"
check 'json_get reads a string' 'tok123' "$(printf '{"user":{"id":"1"},"accessToken":"tok123"}' | json_get accessToken)"
check 'json_get reads a boolean' 'true' "$(printf '{"initialized":true,"x":1}' | json_get initialized)"
check 'json_get on a missing key is empty' '' "$(printf '{"a":"b"}' | json_get nope)"

# ─── .env.prod ───
printf 'A=1\nAGORA_EDGE_SECRET=\n# B=2\nC=x=y\n' > "$T/env"
env_set "$T/env" AGORA_EDGE_SECRET abc
env_set "$T/env" NEW_KEY v
env_set "$T/env" C z
check 'env_set replaces, appends and keeps other lines' $'A=1\nAGORA_EDGE_SECRET=abc\n# B=2\nC=z\nNEW_KEY=v' "$(cat "$T/env")"
check 'env_set leaves the file 0600' 600 "$(stat -c %a "$T/env")"
check 'env_get reads one key' abc "$(env_get "$T/env" AGORA_EDGE_SECRET)"
check 'env_get ignores commented keys' '' "$(env_get "$T/env" B)"
check 'hex64 is 64 hex characters' 1 "$(hex64 | grep -Ec '^[0-9a-f]{64}$')"
check 'gen_password is 20 characters' 20 "$(gen_password | wc -c | tr -d ' ')"
# Under the installer's own `set -euo pipefail` it must succeed every time (it used to die of SIGPIPE, exit 141)
gp_fails=0
for _ in $(seq 1 50); do
    bash -c 'set -euo pipefail; . "$1/install/lib/common.sh"; p=$(gen_password); [ "${#p}" = 20 ] && [[ "$p" =~ ^[A-Za-z0-9]+$ ]]' _ "$ROOT" || gp_fails=$((gp_fails + 1))
done
check 'gen_password succeeds under pipefail, 20 alphanumerics, 50 runs' 0 "$gp_fails"

# ─── Versions ───
mkdir -p "$T/src/box"
printf '{\n  "name": "agora",\n  "version": "1.2.3",\n  "deps": { "x": { "version": "9" } }\n}\n' > "$T/src/package.json"
printf '4\n' > "$T/src/box/VERSION"
check 'agora_version reads the top-level version' 1.2.3 "$(agora_version "$T/src")"
check 'box_version reads box/VERSION' 4 "$(box_version "$T/src")"

# ─── Redaction (same rules as src/lib/doctor.ts) ───
SECRET=$(printf 'f%.0s' $(seq 1 16))0123456789abcdef0123456789abcdef
out=$(printf '%s\n' \
    'Authorization: Bearer abc.def.ghi' \
    'host ah_01JABCDEFGHJKMNPQRSTVWXYZ0.s3cr3tS3cr3tS3cr3t' \
    "hex $SECRET" \
    'url postgres://accord:hunter2@postgres:5432/agora' \
    'JWT_SECRET=topsecretvalue' \
    'agora-box-01jabcdefghjkmnpqrstvwxyz0 Up 3 minutes' \
    '/var/lib/docker/volumes/agora_pgdata/_data' | redact)
for s in abc.def.ghi s3cr3t "$SECRET" hunter2 topsecretvalue; do
    check_true "redact removes $s" "! printf '%s' \"\$out\" | grep -qF '$s'"
done
check_true 'redact keeps container names' "printf '%s' \"\$out\" | grep -qF 'agora-box-01jabcdefghjkmnpqrstvwxyz0 Up 3 minutes'"
check_true 'redact keeps paths' "printf '%s' \"\$out\" | grep -qF '/var/lib/docker/volumes/agora_pgdata/_data'"

# ─── Telemetry: off sends nothing, on sends exactly the five fields once ───
mkdir -p "$T/bin"
cat > "$T/bin/curl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$T/curl.log"
case "\$*" in *telemetry/v1/problem*) cat >/dev/null; printf '{"reportId":"pr_ABCDEFGHIJKLMNOP"}' ;; esac
exit 0
EOF
chmod +x "$T/bin/curl"
PATH="$T/bin:$PATH"
: > "$T/curl.log"
TELEMETRY=off TELEMETRY_SENT=0
send_install_report failed docker.install
check 'telemetry off: no request' 0 "$(wc -l < "$T/curl.log" | tr -d ' ')"
TELEMETRY=on TELEMETRY_SENT=0 AGORA_VERSION=1.2.3 OS_NAME=ubuntu
send_install_report failed docker.install
send_install_report failed docker.install
check 'telemetry on: one request' 1 "$(grep -c 'telemetry/v1/install' "$T/curl.log")"
body=$(sed -n 's/.*-d \({.*}\) https.*/\1/p' "$T/curl.log")
check_true 'the body has exactly the five keys' "printf '%s' '$body' | grep -Eq '^\\{\"result\":\"failed\",\"step\":\"docker.install\",\"version\":\"1.2.3\",\"os\":\"ubuntu\",\"osVersion\":\"[^\"]*\"\\}\$'"
check_true 'no user agent is sent' "grep -q 'User-Agent:' '$T/curl.log'"
: > "$T/curl.log"
TELEMETRY=on TELEMETRY_SENT=0
send_install_report ok null
check_true 'success sends step null' "grep -q '\"result\":\"ok\",\"step\":null' '$T/curl.log'"

# ─── Problem report: nothing without a yes ───
: > "$T/curl.log"
printf '#!/bin/sh\necho doctor output\n' > "$T/doctor.sh"
NON_INTERACTIVE=1
offer_problem_report "$T/doctor.sh" '' > "$T/offer.out"
check 'non-interactive: no report is sent' 0 "$(wc -l < "$T/curl.log" | tr -d ' ')"
check_true 'non-interactive: says how to send one' "grep -q -- '--report' '$T/offer.out'"
printf 'report text "quoted"\n' > "$T/report"
check 'send_problem_report returns the report id' pr_ABCDEFGHIJKLMNOP "$(send_problem_report "$T/report")"

# ─── API helpers ───
check 'status_of takes the last line' 201 "$(printf '{"a":1}\n201' | status_of)"
check 'body_of drops it' '{"a":1}' "$(printf '{"a":1}\n201' | body_of)"

# Telemetry is off until the person says yes: an exported TELEMETRY=on is not consent
check 'telemetry ignores a TELEMETRY variable from the environment' off "$(TELEMETRY=on bash -c '. "$1/install/lib/common.sh"; printf %s "$TELEMETRY"' _ "$ROOT")"

# ─── apt waits for the first-boot update instead of failing on the dpkg lock ───
# (found on a clean Windows 11 VM: a new WSL distro's apt-get held the lock as gVisor installed)
(
    # shellcheck source=../../install/lib/docker.sh
    . "$ROOT/install/lib/docker.sh"
    mkdir -p "$T/aptbin"
    printf '0\n' > "$T/apt-busy-left"
    # pgrep reports apt busy for as many calls as apt-busy-left says, then idle
    cat > "$T/aptbin/pgrep" <<EOF
#!/bin/sh
left=\$(cat "$T/apt-busy-left")
[ "\$left" -gt 0 ] || exit 1
echo \$((left - 1)) > "$T/apt-busy-left"; exit 0
EOF
    chmod +x "$T/aptbin/pgrep"
    PATH="$T/aptbin:$PATH"
    as_root() { printf '%s\n' "$*" >> "$T/apt.log"; }
    sleep() { :; }
    : > "$T/apt.log"
    printf '3\n' > "$T/apt-busy-left"
    apt_install runsc > "$T/apt.out"
    check 'apt_install waits while apt or dpkg runs, then installs' 'yes' "$(grep -q 'install -y --no-install-recommends runsc' "$T/apt.log" && echo yes || echo no)"
    check 'apt_install says why it waits' 'yes' "$(grep -q 'waiting for another apt' "$T/apt.out" && echo yes || echo no)"
    check 'apt_install passes a dpkg lock timeout' 'yes' "$(grep -q 'DPkg::Lock::Timeout=' "$T/apt.log" && echo yes || echo no)"
    : > "$T/apt.log"
    apt_update > /dev/null
    check 'apt_update runs apt-get update with the lock timeout' 'yes' "$(grep -q 'DPkg::Lock::Timeout=.* update -qq' "$T/apt.log" && echo yes || echo no)"
    printf '999\n' > "$T/apt-busy-left"
    if (APT_WAIT_SECONDS=10; wait_for_apt) > /dev/null 2>&1; then r=returned; else r=stopped; fi
    check 'wait_for_apt stops with an error when apt never finishes' stopped "$r"
    printf 'n=%s\nfailed=%s\n' "$n" "$failed" > "$T/apt.counts"
)
. "$T/apt.counts"

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
