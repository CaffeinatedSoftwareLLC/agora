#!/usr/bin/env bash
# Seed a running ops instance through its HTTP API and write a manifest (inside .state/).
#   e2e/ops/seed.sh <agora-ops|agora-ops-restore> [manifest]
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ops_use "${1:?project}"
MANIFEST="$(state_path "${2:-$OPS_STATE/$OPS_PROJECT.manifest.json}")"
ops_wait_api 60 || die "$OPS_PROJECT API not healthy at $OPS_BASE"
ops_api seed --base "$OPS_BASE" --env "$OPS_ENV_FILE" --manifest "$MANIFEST"
echo "manifest: $MANIFEST"
