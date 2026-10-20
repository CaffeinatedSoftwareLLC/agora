#!/usr/bin/env bash
# Tests scripts/lib/engine-guard.sh against a fake `docker` on PATH. Never calls real Docker.
#   bash scripts/test-engine-guard.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Fake docker. FAIL=<info|label|name|project> makes that call exit 77.
# OUT_LABEL / OUT_NAME / OUT_PROJECT set what each listing prints. Listings without -a exit 99.
cat > "$TMP/docker" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  info) [ "${FAIL:-}" = info ] && exit 77; echo "${RUNTIMES-io.containerd.runc.v2 runc runsc }"; exit 0 ;;
  ps)
    [ "$2" = -a ] || { echo "fake docker: ps without -a" >&2; exit 99; }
    case "$*" in
      *label=agora.managed=runtime*) [ "${FAIL:-}" = label ] && exit 77; printf '%b' "${OUT_LABEL:-}" ;;
      *name=agora-run-*)             [ "${FAIL:-}" = name ] && exit 77; printf '%b' "${OUT_NAME:-}" ;;
      *com.docker.compose.project*)  [ "${FAIL:-}" = project ] && exit 77; printf '%b' "${OUT_PROJECT:-}" ;;
      *) exit 98 ;;
    esac ;;
  *) echo "fake docker: unexpected $*" >&2; exit 97 ;;
esac
FAKE
chmod +x "$TMP/docker"

pass=0; fail=0
# expect <allowed|refused> <description> [VAR=value ...]
expect() {
    local want="$1" desc="$2"; shift 2
    local got
    if env PATH="$TMP:$PATH" "$@" bash -c "source '$HERE/lib/engine-guard.sh'; echo GUARD_ALLOWED" >"$TMP/out" 2>&1 \
        && grep -q GUARD_ALLOWED "$TMP/out"; then got=allowed; else got=refused; fi
    if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   $desc"
    else fail=$((fail+1)); echo "FAIL $desc (wanted $want, got $got)"; sed 's/^/     /' "$TMP/out"; fi
}

expect allowed "empty engine with runsc"
expect refused "docker info fails"                 FAIL=info
expect refused "no runsc runtime"                  RUNTIMES="runc "
expect refused "runtime-label listing fails"       FAIL=label
expect refused "agora-run-* listing fails"         FAIL=name
expect refused "compose listing fails"             FAIL=project
expect refused "running runtime container"         OUT_LABEL='agora-run-01abc\n'
expect refused "stopped agora-run-* (listed by -a)" OUT_NAME='agora-run-01xyz\n'
expect refused "live compose project agora"        OUT_PROJECT='agora-api-1 agora\n'
expect refused "e2e compose project agora-e2e"     OUT_PROJECT='agora-e2e-web-1 agora-e2e\n'
expect allowed "unrelated compose project"         OUT_PROJECT='pg-1 myapp\nloose \n'

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
