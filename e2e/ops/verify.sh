#!/usr/bin/env bash
# Check that a seeded ops instance still has everything in the manifest: logins,
# messages, files (sha256), encrypted provider config (decrypts, never returned),
# agent host, profiles and sessions, then that writes still work.
#   e2e/ops/verify.sh <project> <manifest in .state> [--no-write]
# The seeded passwords are read from the project's env file (a restore copies it).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ops_use "${1:?project}"
MANIFEST="$(state_path "${2:?manifest}")"
shift 2
ops_wait_api 60 || die "$OPS_PROJECT API not healthy at $OPS_BASE"
ops_api verify --base "$OPS_BASE" --env "$OPS_ENV_FILE" --manifest "$MANIFEST" \
  --report "$OPS_STATE_REAL/$OPS_PROJECT.verify-$(date +%H%M%S).json" "$@"
