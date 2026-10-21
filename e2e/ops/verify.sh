#!/usr/bin/env bash
# Check that a seeded ops instance still has everything in the manifest: logins,
# messages, files (sha256), encrypted provider config (decrypts, never returned),
# agent host, profiles and sessions, then that writes still work.
#   e2e/ops/verify.sh <project> <manifest in .state> [--no-write]
# The seeded passwords are read from the project's env file (a restore copies it).
# No other arguments are accepted or forwarded.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ $# -ge 2 ] && [ $# -le 3 ] || die "usage: verify.sh <project> <manifest> [--no-write]"
WRITE=()
if [ $# = 3 ]; then
  [ "$3" = --no-write ] || die "verify.sh: unknown argument '$3' (only --no-write)"
  WRITE=(--no-write)
fi
ops_use "$1"
MANIFEST="$(state_path "$2")"
ops_wait_api 60 || die "$OPS_PROJECT API not healthy at $OPS_BASE"
ops_api verify --base "$OPS_BASE" --env "$OPS_ENV_FILE" --manifest "$MANIFEST" \
  --report "$OPS_STATE_REAL/$OPS_PROJECT.verify-$(date +%H%M%S).json" "${WRITE[@]}"
