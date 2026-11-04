#!/usr/bin/env bash
# install/linux/install.sh against a fake Docker (test/install/fake-docker.sh), up to the point a
# fake can take it: the admin password is checked before anything starts, a failed start prints
# its cleanup newest first and that cleanup lets the next run go ahead, an install that didn't
# finish makes a non-interactive run fail instead of "nothing was changed", ports published by a
# stopped install are not reused, and --existing upgrade forwards the passphrase file.
#
#   bash test/install/install.test.sh     (as root in a scratch Linux container: it adds a docker group)
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
n=0 failed=0
check() { n=$((n + 1)); if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi; }
yes_if() { if eval "$1"; then echo yes; else echo no; fi; }

getent group docker >/dev/null || groupadd docker
mkdir -p "$T/bin"
cp "$ROOT/test/install/fake-docker.sh" "$T/bin/docker"
printf '#!/bin/sh\necho "{\\"status\\":\\"ok\\"}"\n' > "$T/bin/curl"
chmod +x "$T/bin/docker" "$T/bin/curl"
export PATH="$T/bin:$PATH"
export HOME="$T/home"; mkdir -p "$HOME"
SRC="$T/src"
mkdir -p "$SRC"
cp -r "$ROOT/install" "$SRC/"
printf '{\n  "name": "agora",\n  "version": "0.9.0"\n}\n' > "$SRC/package.json"
printf 'services: {}\n' > "$SRC/docker-compose.prod.yml"
mkdir -p "$SRC/box"; printf '1\n' > "$SRC/box/VERSION"
printf 'short\n' > "$T/short-pw"
printf 'long-enough-password\n' > "$T/pw"
printf 'correct horse battery staple\n' > "$T/pass"

fresh() {
    export FAKE="$T/fake-$1"
    rm -rf "$FAKE" "$HOME/agora"; mkdir -p "$FAKE"
    printf '%s\n' postgres redis api runner cap-gateway web caddy box-socket-proxy box-edge boxd > "$FAKE/services"
}
install() { # install <log> <args...>
    local log=$1; shift
    if bash "$SRC/install/linux/install.sh" --non-interactive --box-insecure-dev --telemetry off --agent none --min-disk-gb 0 "$@" > "$log" 2>&1; then echo 0; else echo $?; fi
}

# ─── A short admin password is refused before the stack starts ───
fresh short-pw
code=$(install "$T/a.log" --admin-password-file "$T/short-pw")
check 'short password: refused' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
check 'short password: at the password step' yes "$(yes_if "grep -q 'Failed at step admin.password' '$T/a.log'")"
check 'short password: nothing was started' 0 "$(grep -c 'up -d --build' "$FAKE/log" || true)"

# ─── A failed start: cleanup newest first, and it clears the way for the next run ───
fresh start-fails
printf '%s' 'up -d --build' > "$FAKE/fail"
code=$(install "$T/b.log" --admin-password-file "$T/pw")
: > "$FAKE/fail"
check 'failed start: exit non-zero' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
cleanup_lines=$(sed -n '/To remove what this run created/,/^$/p' "$T/b.log" | grep '^    ' | sed 's/^    //')
first=$(printf '%s\n' "$cleanup_lines" | sed -n 1p)
second=$(printf '%s\n' "$cleanup_lines" | sed -n 2p)
case "$first" in "bash $HOME/agora/install/uninstall.sh --dir $HOME/agora --purge --confirm agora"*) f_ok=yes ;; *) f_ok=no ;; esac
check 'failed start: uninstall comes first' yes "$f_ok"
check 'failed start: then the folder' "rm -rf $HOME/agora" "$second"
# Run the printed cleanup as printed, then install again
uninstall_cmd=${first%%   #*}
eval "$uninstall_cmd --non-interactive" > "$T/b-un.log" 2>&1 || { cat "$T/b-un.log"; }
eval "$second"
code=$(install "$T/b2.log" --admin-password-file "$T/short-pw")
check 'after the cleanup: the next run gets past the existing-install check' yes "$(yes_if "grep -q 'Failed at step admin.password' '$T/b2.log'")"

# ─── An install that didn't finish is not "nothing was changed" ───
fresh partial
mkdir -p "$T/old-agora"; date > "$T/old-agora/.agora-install-pending"
echo agora > "$FAKE/projects"; echo "$T/old-agora" > "$FAKE/dir_agora"
code=$(install "$T/c.log" --admin-password-file "$T/pw")
check 'unfinished install: exit non-zero' 1 "$([ "$code" != 0 ] && echo 1 || echo 0)"
check 'unfinished install: says how to remove it' yes "$(yes_if "grep -q \"didn't finish. Remove it with: bash $T/old-agora/install/uninstall.sh\" '$T/c.log'")"
check 'unfinished install: gVisor step not reached' 0 "$(grep -c 'gvisor.install' "$T/c.log" || true)"
# A finished one: stop is exit 0 and true to its word
rm -f "$T/old-agora/.agora-install-pending"
code=$(install "$T/c2.log" --admin-password-file "$T/pw")
check 'finished install: stop exits 0' 0 "$code"
check 'finished install: nothing was changed' yes "$(yes_if "grep -q 'Stopped; nothing was changed' '$T/c2.log'")"
check 'finished install: gVisor step not reached' 0 "$(grep -c 'gvisor.install' "$T/c2.log" || true)"

# ─── --existing upgrade forwards the passphrase file ───
fresh forward
echo agora > "$FAKE/projects"; echo "$T/old-agora" > "$FAKE/dir_agora"
printf 'COMPOSE_PROJECT_NAME=agora\n' > "$T/old-agora/.env.prod"
cp "$SRC/install/upgrade.sh" "$T/upgrade.sh.real"
printf '#!/bin/sh\necho "upgrade.sh $*"\n' > "$SRC/install/upgrade.sh"
code=$(install "$T/d.log" --existing upgrade --passphrase-file "$T/pass")
cp "$T/upgrade.sh.real" "$SRC/install/upgrade.sh"
check 'existing upgrade: hands over to upgrade.sh' 0 "$code"
check 'existing upgrade: with the passphrase file' yes "$(yes_if "grep -q -- 'upgrade.sh --dir $T/old-agora --source $SRC --non-interactive --passphrase-file $T/pass' '$T/d.log'")"

# ─── Ports a stopped install publishes are not taken ───
fresh ports
printf '80\n443\n3000\n' > "$FAKE/published"
code=$(install "$T/e.log" --admin-password-file "$T/short-pw")
check 'published ports: skipped' yes "$(yes_if "grep -q 'http 8080, https 8443, api 3001' '$T/e.log'")"
code=$(install "$T/e2.log" --admin-password-file "$T/short-pw" --api-port 3000)
check 'published ports: an explicit one is refused outside WSL' yes "$(yes_if "grep -q 'port 3000 is in use (or published by another install)' '$T/e2.log'")"

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
