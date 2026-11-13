#!/usr/bin/env bash
# shellcheck disable=SC2016  # snippets run later with bash -c
# Compose override files and Tailscale access (install/lib/common.sh, install/lib/tailnet.sh,
# install/tailnet.sh, install/upgrade.sh), against a fake Docker (fake-docker.sh), a fake
# tailscale (fake-tailscale.sh) and a fake curl that serves the health checks and a release.
# No Docker, no Tailscale and no network are touched: every program is a fake first on PATH.
#
#   bash test/install/tailnet.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
n=0 failed=0
check() { n=$((n + 1)); if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi; }
yes_if() { if eval "$1"; then echo yes; else echo no; fi; }

mkdir -p "$T/bin" "$T/rel"
cp "$ROOT/test/install/fake-docker.sh" "$T/bin/docker"
cp "$ROOT/test/install/fake-tailscale.sh" "$T/bin/tailscale"
# sudo: the command itself, as this user
printf '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n' > "$T/bin/sudo"
# curl: health on 127.0.0.1 (the tailnet web port only while the stack runs with the override),
# the tailnet address (exit $FAKE_TS_URL_EXIT), a release from $REL, Tailscale's installer
cat > "$T/bin/curl" <<'EOF'
#!/bin/bash
printf 'curl %s\n' "$*" >> "$FAKE/curl-log"
out='' url=''
while [ $# -gt 0 ]; do
    case "$1" in -o) out=$2; shift ;; -m|--proto) shift ;; -*) ;; *) url=$1 ;; esac
    shift
done
case "$url" in
    */agora.tar.gz) [ -f "$REL/agora.tar.gz" ] || exit 22; cp "$REL/agora.tar.gz" "$out" ;;
    */agora.tar.gz.sha256) [ -f "$REL/agora.tar.gz.sha256" ] || exit 22; cp "$REL/agora.tar.gz.sha256" "$out" ;;
    https://tailscale.com/install.sh) printf '#!/bin/sh\ncp "%s" "%s"\nchmod +x "%s"\n' "$TS_IMPL" "$TS_BIN" "$TS_BIN" > "$out" ;;
    http://127.0.0.1:8080/*|http://127.0.0.1:9090/*) grep -q tailnet "$FAKE/up_files" 2>/dev/null || exit 7; echo '{"status":"ok"}' ;;
    http://127.0.0.1:*) echo '{"status":"ok"}' ;;
    https://*.ts.net/*) exit "${FAKE_TS_URL_EXIT:-0}" ;;
    *) exit 22 ;;
esac
EOF
# systemctl: tailnet.sh starts tailscaled with it when tailscaled doesn't answer
printf '#!/bin/sh\nexit 0\n' > "$T/bin/systemctl"
chmod +x "$T/bin/docker" "$T/bin/tailscale" "$T/bin/sudo" "$T/bin/curl" "$T/bin/systemctl"
export PATH="$T/bin:$PATH"
export FAKE="$T/fake" FAKE_TS="$T/ts" REL="$T/rel" TS_IMPL="$ROOT/test/install/fake-tailscale.sh" TS_BIN="$T/bin/tailscale"
mkdir -p "$FAKE" "$FAKE_TS"
printf 'correct horse battery staple\n' > "$T/pass"
DBPW='db-password-Zq9-not-to-be-printed'

mk_release() { # mk_release <dir> <version>: a release with the tailnet override
    mkdir -p "$1/src/db/migrations" "$1/src/tools" "$1/box"
    cp -r "$ROOT/install" "$1/"
    printf '{\n  "name": "agora",\n  "version": "%s"\n}\n' "$2" > "$1/package.json"
    printf 'services: {}\n' > "$1/docker-compose.prod.yml"
    cp "$ROOT/docker-compose.tailnet.yml" "$1/docker-compose.tailnet.yml"
    printf 'FROM node:22-alpine\n' > "$1/Dockerfile"
    printf -- '-- core\n' > "$1/src/db/migrations/001_core.sql"
    printf '// prep\n' > "$1/src/tools/box-restore-prep.ts"
    printf '1\n' > "$1/box/VERSION"
}
mk_env() { # mk_env <dir> <instance> [extra lines...]
    local d=$1 i=$2; shift 2
    { printf 'COMPOSE_PROJECT_NAME=%s\nAGORA_INSTANCE=%s\nDB_PASSWORD=%s\nAGORA_EDGE_SECRET=%s\nAGORA_BOX_VERSION=1\nDOCKER_GID=999\n' "$i" "$i" "$DBPW" "$(printf 'a%.0s' $(seq 1 64))"
      [ $# -eq 0 ] || printf '%s\n' "$@"; } > "$d/.env.prod"
    chmod 600 "$d/.env.prod"
}
engine() { # a running box-era stack, nothing else
    printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy box-socket-proxy box-edge boxd migrate > "$FAKE/services"
    printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy box-socket-proxy box-edge boxd > "$FAKE/running"
    echo t > "$FAKE/regclass"; : > "$FAKE/dbboxes"; : > "$FAKE/boxes"; : > "$FAKE/boxes_running"; : > "$FAKE/volumes"
    : > "$FAKE/log"; : > "$FAKE/curl-log"
}
# lib <dir> <bash code>: the code in a fresh shell with common.sh loaded and the fake Docker picked
lib() { D=$1 bash -c '. "$0/install/lib/common.sh"; . "$0/install/lib/tailnet.sh"; DOCKER=(docker); '"$2" "$ROOT"; }
last_compose() { grep '^docker compose ' "$FAKE/log" | tail -n 1; }

# ─── compose_in: which files it passes ───
A="$T/agora"
mk_release "$A" 0.9.0; mk_env "$A" agora
engine; : > "$FAKE/config_files"
lib "$A" 'compose_in "$D" config >/dev/null'
check 'compose_in: no record and no label, only the production file' 'docker compose -f docker-compose.prod.yml --env-file .env.prod config' "$(last_compose)"
check 'compose_in: nothing found, nothing recorded' no "$(yes_if '[ -e "$A/.agora-install" ]')"

printf 'instance=agora\ncompose_overrides=docker-compose.tailnet.yml\n' > "$A/.agora-install"
lib "$A" 'compose_in "$D" config >/dev/null'
check 'compose_in: the recorded override is added' 'docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod config' "$(last_compose)"
check 'compose_cmd_text: names it too' "cd $A && docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d" "$(lib "$A" 'compose_cmd_text "$D" "up -d"')"
check 'running_services goes through compose_in' yes "$(lib "$A" '. "$0/install/lib/bundle.sh"; running_services "$D" >/dev/null'; yes_if 'last_compose | grep -q -- "-f docker-compose.tailnet.yml --env-file .env.prod ps"')"

# From the containers' label: two services recreated with the override, the rest without
rm -f "$A/.agora-install"
printf '%s\n' "/home/x/agora/docker-compose.prod.yml" "/home/x/agora/docker-compose.prod.yml,/home/x/agora/docker-compose.tailnet.yml" '' > "$FAKE/config_files"
lib "$A" 'compose_in "$D" config >/dev/null'
check 'compose_in: an override found on the containers is added' 'docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod config' "$(last_compose)"
check 'compose_in: and written down' 'compose_overrides=docker-compose.tailnet.yml' "$(cat "$A/.agora-install")"
check 'detection asks for this install only (its Compose project)' yes "$(yes_if "grep -q 'docker ps -a --filter label=com.docker.compose.project=agora --format .*config_files' '$FAKE/log'")"
: > "$FAKE/config_files"
lib "$A" 'compose_in "$D" config >/dev/null'
check 'compose_in: a stack without containers still knows, from the record' 'docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod config' "$(last_compose)"

# An install with no COMPOSE_PROJECT_NAME is asked for by its folder
rm -f "$A/.agora-install"; printf 'DB_PASSWORD=x\n' > "$A/.env.prod"; : > "$FAKE/log"
lib "$A" 'compose_in "$D" config >/dev/null'
check 'detection without a project name filters on the install folder' yes "$(yes_if "grep -q 'docker ps -a --filter label=com.docker.compose.project.working_dir=$A --format' '$FAKE/log'")"
mk_env "$A" agora

# Unsafe or missing names are never used, from a label or from the record
mkdir -p "$T/elsewhere"; printf 'services: {}\n' > "$T/elsewhere/docker-compose.evil.yml"; printf 'services: {}\n' > "$T/evil.yml"
ln -s "$T/elsewhere/docker-compose.evil.yml" "$A/docker-compose.linked.yml" 2>/dev/null || true
printf '%s\n' "$A/docker-compose.prod.yml,$T/elsewhere/docker-compose.evil.yml,../evil.yml,$A/docker-compose.gone.yml,$A/docker-compose.linked.yml,$A/docker-compose.Tailnet.yml,$A/docker-compose.a b.yml,$A/Dockerfile" > "$FAKE/config_files"
rm -f "$A/.agora-install"
lib "$A" 'compose_in "$D" config >/dev/null'
check 'compose_in: a label naming files elsewhere, missing, linked or oddly named adds nothing' 'docker compose -f docker-compose.prod.yml --env-file .env.prod config' "$(last_compose)"
check 'compose_in: and records nothing' no "$(yes_if '[ -e "$A/.agora-install" ]')"
printf 'compose_overrides=../evil.yml /etc/passwd docker-compose.gone.yml docker-compose.prod.yml docker-compose.tailnet.yml\n' > "$A/.agora-install"
lib "$A" 'compose_in "$D" config >/dev/null'
check 'compose_in: of a tampered record only the safe, existing name is used' 'docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod config' "$(last_compose)"
check 'rejected_overrides lists the rest' '../evil.yml /etc/passwd docker-compose.gone.yml docker-compose.prod.yml' "$(lib "$A" 'rejected_overrides "$D" | tr "\n" " " | sed "s/ $//"')"
check 'override_ok: a path is refused even when the file exists' 1 "$(lib "$A" 'override_ok "$D" "../evil.yml"; echo $?')"

# An empty record means none, whatever the containers say (tailnet off)
printf '%s\n' "$A/docker-compose.prod.yml,$A/docker-compose.tailnet.yml" > "$FAKE/config_files"
printf 'compose_overrides=\n' > "$A/.agora-install"
lib "$A" 'compose_in "$D" config >/dev/null'
check 'compose_in: an empty record wins over the label' 'docker compose -f docker-compose.prod.yml --env-file .env.prod config' "$(last_compose)"

# ─── Origins ───
printf 'CORS_ORIGIN=https://localhost:8443,https://agora.example.com\nWEBAUTHN_ORIGINS=https://localhost:8443\n' > "$T/env1"
lib "$A" 'add_tailnet_origin "'"$T"'/env1" https://agora-home.tail1234.ts.net; echo "rc=$?"' > "$T/o1"
check 'add_tailnet_origin: appended to CORS_ORIGIN, existing values kept' 'CORS_ORIGIN=https://localhost:8443,https://agora.example.com,https://agora-home.tail1234.ts.net' "$(grep '^CORS_ORIGIN=' "$T/env1")"
check 'add_tailnet_origin: and to WEBAUTHN_ORIGINS when it is set' 'WEBAUTHN_ORIGINS=https://localhost:8443,https://agora-home.tail1234.ts.net' "$(grep '^WEBAUTHN_ORIGINS=' "$T/env1")"
check 'add_tailnet_origin: says it changed the file' 'rc=0' "$(cat "$T/o1")"
cp "$T/env1" "$T/env1.before"
check 'add_tailnet_origin: a second time changes nothing' 'rc=1|same' "$(lib "$A" 'add_tailnet_origin "'"$T"'/env1" https://agora-home.tail1234.ts.net; echo "rc=$?"')|$(cmp -s "$T/env1" "$T/env1.before" && echo same)"
printf 'DOMAIN=\nCORS_ORIGIN=\n' > "$T/env2"
lib "$A" 'add_tailnet_origin "'"$T"'/env2" https://agora-home.tail1234.ts.net' || true
check 'add_tailnet_origin: an empty CORS_ORIGIN keeps the default origin it stood for' 'CORS_ORIGIN=https://localhost,https://agora-home.tail1234.ts.net' "$(grep '^CORS_ORIGIN=' "$T/env2")"
check 'add_tailnet_origin: WEBAUTHN_ORIGINS stays unset' 0 "$(grep -c '^WEBAUTHN_ORIGINS=' "$T/env2" || true)"

# ─── Upgrade: an install set up by hand with the override keeps it ───
OLD="$T/home/agora"; NEW="$T/new"
mkdir -p "$T/home"
mk_release "$OLD" 0.9.0; mk_env "$OLD" agora 'CORS_ORIGIN=https://localhost,https://agora-home.tail1234.ts.net'
mk_release "$NEW" 1.0.0
engine
printf '%s\n' "$OLD/docker-compose.prod.yml" "$OLD/docker-compose.prod.yml,$OLD/docker-compose.tailnet.yml" > "$FAKE/config_files"
printf 'docker-compose.prod.yml\ndocker-compose.tailnet.yml\n' > "$FAKE/up_files"
echo Running > "$FAKE_TS/state"; echo agora-home.tail1234.ts.net > "$FAKE_TS/name"; echo 100.64.0.7 > "$FAKE_TS/ip"; echo 8080 > "$FAKE_TS/serve_port"; echo tail1234.ts.net > "$FAKE_TS/tailnet"
if bash "$NEW/install/upgrade.sh" --dir "$OLD" --passphrase-file "$T/pass" --non-interactive > "$T/up.log" 2>&1; then code=0; else code=$?; fi
check 'upgrade with the override: exit 0' 0 "$code"
[ "$code" = 0 ] || tail -n 30 "$T/up.log"
check 'upgrade: the new release is in place' 1.0.0 "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$OLD/package.json")"
check 'upgrade: the stack starts with the override' 'docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d --remove-orphans' "$(grep 'compose .* up -d --remove-orphans' "$FAKE/log" | tail -n 1)"
check 'upgrade: no compose command of the whole run leaves it out' 0 "$(grep '^docker compose ' "$FAKE/log" | grep -v '^docker compose version' | grep -vc -- '-f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file' || true)"
check 'upgrade: the override is recorded for next time' 'compose_overrides=docker-compose.tailnet.yml' "$(grep '^compose_overrides=' "$OLD/.agora-install")"
check 'upgrade: says it keeps it' yes "$(yes_if "grep -q 'keeping its compose override: docker-compose.tailnet.yml (found on its containers' '$T/up.log'")"
check 'upgrade: one line per check' yes "$(yes_if "grep -q '  ok      Agora answers on http://127.0.0.1:3000/health' '$T/up.log' && grep -q '  ok      the web port Tailscale forwards to answers on 127.0.0.1:8080' '$T/up.log' && grep -q '  ok      tailscale serve publishes https://agora-home.tail1234.ts.net (to 127.0.0.1:8080)' '$T/up.log' && grep -q '  ok      CORS_ORIGIN allows https://agora-home.tail1234.ts.net' '$T/up.log' && grep -q '  ok      https://agora-home.tail1234.ts.net answers from this machine' '$T/up.log'")"
check 'upgrade: no secret in its output' 0 "$(grep -c "$DBPW" "$T/up.log" || true)"
check 'upgrade: tailscale was only read, never changed' 0 "$(grep -Evc '^tailscale (status|ip|serve status)' "$FAKE_TS/log" || true)"

# A failed tailnet check tells what to run and rolls nothing back
NEW2="$T/new2"; mk_release "$NEW2" 1.1.0
engine; : > "$FAKE_TS/serve_port"
if bash "$NEW2/install/upgrade.sh" --dir "$OLD" --passphrase-file "$T/pass" --non-interactive > "$T/up2.log" 2>&1; then code=0; else code=$?; fi
check 'upgrade with tailscale serve gone: still exit 0' 0 "$code"
check 'upgrade with tailscale serve gone: the release stays upgraded' 1.1.0 "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$OLD/package.json")"
check 'upgrade with tailscale serve gone: says what to run' yes "$(yes_if "grep -q '  FAILED  tailscale serve doesn.t publish Agora. Run: sudo tailscale serve --bg http://127.0.0.1:8080' '$T/up2.log' && grep -q 'nothing is rolled back' '$T/up2.log'")"
check 'upgrade with tailscale serve gone: the override is still used' yes "$(yes_if "grep -q 'compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d --remove-orphans' '$FAKE/log'")"
echo 8080 > "$FAKE_TS/serve_port"

# The recorded override is missing from a release: the stack starts without it, and says so
NEW3="$T/new3"; mk_release "$NEW3" 1.2.0; rm "$NEW3/docker-compose.tailnet.yml"
engine
if bash "$NEW3/install/upgrade.sh" --dir "$OLD" --passphrase-file "$T/pass" --non-interactive > "$T/up3.log" 2>&1; then code=0; else code=$?; fi
check 'a release without the recorded override file: the upgrade finishes' 0 "$code"
check 'a release without the recorded override file: started without it, and said so' yes "$(yes_if "grep -q 'compose -f docker-compose.prod.yml --env-file .env.prod up -d --remove-orphans' '$FAKE/log' && grep -q 'FAILED  the compose override docker-compose.tailnet.yml is recorded' '$T/up3.log'")"

# ─── Upgrade with no release given, in the install folder: the latest, downloaded and checked ───
LATEST="$T/latest/agora"; mkdir -p "$T/latest"; mk_release "$LATEST" 2.0.0
tar -czf "$REL/agora.tar.gz" -C "$T/latest" agora
(cd "$REL" && sha256sum agora.tar.gz > agora.tar.gz.sha256)
engine
if bash "$OLD/install/upgrade.sh" --passphrase-file "$T/pass" --non-interactive > "$T/up4.log" 2>&1; then code=0; else code=$?; fi
check 'upgrade.sh in the install folder: exit 0' 0 "$code"
[ "$code" = 0 ] || tail -n 30 "$T/up4.log"
check 'upgrade.sh in the install folder: downloads the fixed agora-latest release and its checksum' 2 "$(grep -c 'releases/download/agora-latest/agora.tar.gz' "$FAKE/curl-log")"
check 'upgrade.sh in the install folder: now the latest release' 2.0.0 "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$OLD/package.json")"
check 'upgrade.sh in the install folder: the override is back (it was recorded)' yes "$(yes_if "grep -q 'compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d --remove-orphans' '$FAKE/log'")"
engine
if bash "$OLD/install/upgrade.sh" --ref v9.9.9 --passphrase-file "$T/pass" --non-interactive > "$T/up5.log" 2>&1; then code=0; else code=$?; fi
check 'upgrade.sh --ref: asks for that release' 2 "$(grep -c 'releases/download/v9.9.9/agora.tar.gz' "$FAKE/curl-log")"
# A download that doesn't match its checksum changes nothing
mk_release "$T/latest/agora" 3.0.0; tar -czf "$REL/agora.tar.gz" -C "$T/latest" agora
engine
if bash "$OLD/install/upgrade.sh" --passphrase-file "$T/pass" --non-interactive > "$T/up6.log" 2>&1; then code=0; else code=$?; fi
check 'a download that fails its SHA-256: refused' 1 "$code"
check 'a download that fails its SHA-256: says so' yes "$(yes_if "grep -q \"doesn't match its SHA-256\" '$T/up6.log'")"
check 'a download that fails its SHA-256: nothing stopped, nothing replaced' '0|2.0.0' "$(grep -c 'compose .* stop' "$FAKE/log" || true)|$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$OLD/package.json")"
rm -f "$REL/agora.tar.gz"
engine
if bash "$OLD/install/upgrade.sh" --passphrase-file "$T/pass" --non-interactive > "$T/up7.log" 2>&1; then code=0; else code=$?; fi
check 'a download that fails: refused, nothing stopped' '1|0' "$code|$(grep -c 'compose .* stop' "$FAKE/log" || true)"

# ─── tailnet.sh on: a fresh install, Tailscale missing ───
F="$T/fresh/agora"; mkdir -p "$T/fresh"
mk_release "$F" 1.0.0; mk_env "$F" fresh 'CORS_ORIGIN=https://localhost:8443,https://agora.example.com' 'WEBAUTHN_ORIGINS=https://localhost:8443' 'AGORA_HTTPS_PORT=8443'
engine; : > "$FAKE/config_files"; printf 'docker-compose.prod.yml\n' > "$FAKE/up_files"
rm -rf "$FAKE_TS"; mkdir -p "$FAKE_TS"; echo tail1234.ts.net > "$FAKE_TS/tailnet"
rm -f "$T/bin/tailscale"
if PATH="$T/bin:/usr/bin:/bin" bash "$F/install/tailnet.sh" status > "$T/s0.log" 2>&1; then code=0; else code=$?; fi
check 'status on a fresh install: off, exit 0' '0|yes' "$code|$(yes_if "grep -q '^Tailscale access: off' '$T/s0.log'")"
cp "$F/.env.prod" "$T/fresh.env.before"
if PATH="$T/bin:/usr/bin:/bin" bash "$F/install/tailnet.sh" on --non-interactive < /dev/null > "$T/on0.log" 2>&1; then code=0; else code=$?; fi
check 'on without Tailscale and nobody to ask: refused' 1 "$code"
check 'on without Tailscale and nobody to ask: nothing installed, nothing changed' 'no|same|0' "$(yes_if '[ -e "$T/bin/tailscale" ]')|$(cmp -s "$F/.env.prod" "$T/fresh.env.before" && echo same)|$(grep -c 'compose .* up' "$FAKE/log" || true)"
if PATH="$T/bin:/usr/bin:/bin" bash "$F/install/tailnet.sh" on --hostname agora-home --install-tailscale --non-interactive < /dev/null > "$T/on1.log" 2>&1; then code=0; else code=$?; fi
ts_installed=$(yes_if '[ -x "$T/bin/tailscale" ]')
# Whatever happened above, the fake is first on PATH again: no later step may reach a real tailscale
cp "$ROOT/test/install/fake-tailscale.sh" "$T/bin/tailscale"; chmod +x "$T/bin/tailscale"
check 'on: exit 0' 0 "$code"
[ "$code" = 0 ] || tail -n 30 "$T/on1.log"
check 'on: Tailscale installed from its official script, over HTTPS only' yes "$(yes_if "grep -q 'curl -fsSL --proto =https -o .* https://tailscale.com/install.sh' '$FAKE/curl-log' && [ '$ts_installed' = yes ]")"
check 'on: tailscale up with the name, without --ssh' 'tailscale up --hostname agora-home' "$(grep '^tailscale up' "$FAKE_TS/log")"
check 'on: the login link is shown' yes "$(yes_if "grep -q 'https://login.tailscale.com/a/fake0000' '$T/on1.log'")"
check 'on: CORS_ORIGIN keeps its values and gains the tailnet address' 'CORS_ORIGIN=https://localhost:8443,https://agora.example.com,https://agora-home.tail1234.ts.net' "$(grep '^CORS_ORIGIN=' "$F/.env.prod")"
check 'on: WEBAUTHN_ORIGINS too' 'WEBAUTHN_ORIGINS=https://localhost:8443,https://agora-home.tail1234.ts.net' "$(grep '^WEBAUTHN_ORIGINS=' "$F/.env.prod")"
check 'on: .env.prod stays 0600' 600 "$(stat -c %a "$F/.env.prod")"
check 'on: the override is recorded' 'compose_overrides=docker-compose.tailnet.yml' "$(grep '^compose_overrides=' "$F/.agora-install")"
check 'on: the stack is started with it' 'docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d' "$(grep 'compose .* up -d' "$FAKE/log" | tail -n 1)"
check 'on: tailscale serve publishes the web port, in the background' 'tailscale serve --bg http://127.0.0.1:8080' "$(grep '^tailscale serve --bg' "$FAKE_TS/log")"
check 'on: never Funnel, never --ssh' 0 "$(grep -Ec 'funnel (--bg|on|[0-9])|--ssh' "$FAKE_TS/log" || true)"
check 'on: ends with the checks, the address and the policy address' yes "$(yes_if "grep -q '  ok      tailscale serve publishes https://agora-home.tail1234.ts.net (to 127.0.0.1:8080)' '$T/on1.log' && grep -q 'Agora on your tailnet: https://agora-home.tail1234.ts.net' '$T/on1.log' && grep -q \"'hosts' entry for this machine must be 100.64.0.7\" '$T/on1.log'")"
check 'on: no secret in its output' 0 "$(grep -c "$DBPW" "$T/on1.log" || true)"

# ─── on again: nothing changes ───
printf '%s\n' "$F/docker-compose.prod.yml,$F/docker-compose.tailnet.yml" > "$FAKE/config_files"
cp "$F/.env.prod" "$T/fresh.env.on"; cp "$F/.agora-install" "$T/fresh.record.on"
: > "$FAKE/log"; : > "$FAKE_TS/log"; : > "$FAKE/curl-log"
if bash "$F/install/tailnet.sh" on --hostname agora-home --non-interactive < /dev/null > "$T/on2.log" 2>&1; then code=0; else code=$?; fi
check 'on again: exit 0' 0 "$code"
check 'on again: .env.prod and the record are untouched' 'same|same' "$(cmp -s "$F/.env.prod" "$T/fresh.env.on" && echo same)|$(cmp -s "$F/.agora-install" "$T/fresh.record.on" && echo same)"
check 'on again: the stack is not restarted' 0 "$(grep -c 'compose .* \(up\|stop\|restart\|down\)' "$FAKE/log" || true)"
check 'on again: tailscale is only read' 0 "$(grep -Evc '^tailscale (version|status|ip|serve status)' "$FAKE_TS/log" || true)"
check 'on again: nothing downloaded' 0 "$(grep -c 'tailscale.com' "$FAKE/curl-log" || true)"
check 'on again: reports the status' yes "$(yes_if "grep -q '^Tailscale access: on (docker-compose.tailnet.yml, recorded in .agora-install)' '$T/on2.log' && grep -q 'already running with it' '$T/on2.log' && grep -q 'tailscale serve already publishes it' '$T/on2.log'")"

# ─── status ───
if bash "$F/install/tailnet.sh" status > "$T/s1.log" 2>&1; then code=0; else code=$?; fi
check 'status: exit 0 when every check passes' 0 "$code"
check 'status: its lines' "Tailscale access: on (docker-compose.tailnet.yml, recorded in .agora-install)
  ok      Agora answers on http://127.0.0.1:3000/health
  ok      the web port Tailscale forwards to answers on 127.0.0.1:8080
  ok      tailscale serve publishes https://agora-home.tail1234.ts.net (to 127.0.0.1:8080)
  ok      CORS_ORIGIN allows https://agora-home.tail1234.ts.net
  ok      https://agora-home.tail1234.ts.net answers from this machine
  note    if it times out from another device while 'tailscale ping agora-home.tail1234.ts.net' answers there, the 'hosts' entry in your Tailscale policy (admin console, Access controls) probably holds an old address. This machine's address is 100.64.0.7" "$(cat "$T/s1.log")"
if FAKE_TS_URL_EXIT=28 bash "$F/install/tailnet.sh" status > "$T/s2.log" 2>&1; then code=0; else code=$?; fi
check 'status: a timeout of the tailnet address from the machine itself is a note, with the policy address' '0|yes' "$code|$(yes_if "grep -q '  note    https://agora-home.tail1234.ts.net timed out from this machine' '$T/s2.log' && grep -q 'probably holds an old address. This machine.s address is 100.64.0.7' '$T/s2.log'")"
: > "$FAKE_TS/serve_port"
if bash "$F/install/tailnet.sh" status > "$T/s3.log" 2>&1; then code=0; else code=$?; fi
check 'status: tailscale serve gone is a failure with the command to run' '1|yes' "$code|$(yes_if "grep -q '  FAILED  tailscale serve doesn.t publish Agora. Run: sudo tailscale serve --bg http://127.0.0.1:8080' '$T/s3.log'")"
echo 8080 > "$FAKE_TS/serve_port"; echo on > "$FAKE_TS/funnel"
if bash "$F/install/tailnet.sh" status > "$T/s4.log" 2>&1; then code=0; else code=$?; fi
check 'status: Funnel on is a failure' '1|yes' "$code|$(yes_if "grep -q '  FAILED  Tailscale Funnel is on' '$T/s4.log'")"
rm -f "$FAKE_TS/funnel"
sed -i 's/^CORS_ORIGIN=.*/CORS_ORIGIN=https:\/\/localhost:8443/' "$F/.env.prod"
if bash "$F/install/tailnet.sh" status > "$T/s5.log" 2>&1; then code=0; else code=$?; fi
check 'status: a CORS_ORIGIN without the tailnet address is a failure' '1|yes' "$code|$(yes_if "grep -q '  FAILED  CORS_ORIGIN doesn.t allow https://agora-home.tail1234.ts.net' '$T/s5.log'")"
cp "$T/fresh.env.on" "$F/.env.prod"
echo NeedsLogin > "$FAKE_TS/state"
if bash "$F/install/tailnet.sh" status > "$T/s6.log" 2>&1; then code=0; else code=$?; fi
check 'status: Tailscale logged out is a failure' '1|yes' "$code|$(yes_if "grep -q '  FAILED  Tailscale is NeedsLogin on this machine' '$T/s6.log'")"
echo Running > "$FAKE_TS/state"

# Another web port (TAILNET_WEB_PORT) is the one served and checked
echo 'TAILNET_WEB_PORT=9090' >> "$F/.env.prod"
if bash "$F/install/tailnet.sh" status > "$T/s7.log" 2>&1; then code=0; else code=$?; fi
check 'status: TAILNET_WEB_PORT is the port checked' yes "$(yes_if "grep -q 'answers on 127.0.0.1:9090' '$T/s7.log' && grep -q 'FAILED  tailscale serve doesn.t publish Agora. Run: sudo tailscale serve --bg http://127.0.0.1:9090' '$T/s7.log'")"
cp "$T/fresh.env.on" "$F/.env.prod"

# ─── off ───
: > "$FAKE/log"; : > "$FAKE_TS/log"
if bash "$F/install/tailnet.sh" off > "$T/off.log" 2>&1; then code=0; else code=$?; fi
check 'off: exit 0' 0 "$code"
check 'off: only Agora is taken off tailscale serve' 'tailscale serve --https=443 off' "$(grep -E '^tailscale serve (--https|reset)' "$FAKE_TS/log")"
check 'off: the record is empty, not gone' 'compose_overrides=' "$(grep '^compose_overrides' "$F/.agora-install")"
check 'off: the stack is started without the override' 'docker compose -f docker-compose.prod.yml --env-file .env.prod up -d' "$(grep 'compose .* up -d' "$FAKE/log" | tail -n 1)"
check 'off: Tailscale is not logged out' 0 "$(grep -Ec '^tailscale (logout|down)' "$FAKE_TS/log" || true)"
# The containers' label still names the override until they are recreated: the record decides
if bash "$F/install/tailnet.sh" status > "$T/s8.log" 2>&1; then code=0; else code=$?; fi
check 'status after off: off' '0|yes' "$code|$(yes_if "grep -q '^Tailscale access: off' '$T/s8.log'")"
: > "$FAKE/log"
if bash "$F/install/tailnet.sh" off > "$T/off2.log" 2>&1; then code=0; else code=$?; fi
check 'off again: nothing changes' '0|0' "$code|$(grep -c 'compose .* up' "$FAKE/log" || true)"

# ─── on, for an install set up by hand that already has everything (no record yet) ───
rm -f "$F/.agora-install"
printf '%s\n' "$F/docker-compose.prod.yml,$F/docker-compose.tailnet.yml" > "$FAKE/config_files"
printf 'docker-compose.prod.yml\ndocker-compose.tailnet.yml\n' > "$FAKE/up_files"
echo 8080 > "$FAKE_TS/serve_port"
: > "$FAKE/log"; : > "$FAKE_TS/log"
if bash "$F/install/tailnet.sh" on --non-interactive < /dev/null > "$T/on3.log" 2>&1; then code=0; else code=$?; fi
check 'on, for a hand-made tailnet install: exit 0, only the record is written' '0|compose_overrides=docker-compose.tailnet.yml|0|0' \
    "$code|$(grep '^compose_overrides=' "$F/.agora-install")|$(grep -c 'compose .* up' "$FAKE/log" || true)|$(grep -Evc '^tailscale (version|status|ip|serve status)' "$FAKE_TS/log" || true)"

# An old Docker Compose can't read the override
if FAKE_COMPOSE_VERSION=2.20.0 bash "$F/install/tailnet.sh" on --non-interactive < /dev/null > "$T/on4.log" 2>&1; then code=0; else code=$?; fi
check 'on with Docker Compose older than 2.24.4: refused' '1|yes' "$code|$(yes_if "grep -q 'older than 2.24.4' '$T/on4.log'")"

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
