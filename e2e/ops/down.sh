#!/usr/bin/env bash
# Remove ONLY an ops project (agora-ops or agora-ops-restore): containers, volumes,
# network, after the same compose validation as an up. With `all`, also the
# agora-ops-* image tags. Never prunes.
#   e2e/ops/down.sh <agora-ops|agora-ops-restore|all>
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

targets=("${1:?project or all}")
[ "$1" = all ] && targets=(agora-ops agora-ops-restore)
for p in "${targets[@]}"; do
  ops_use "$p"
  ops_down
  rm -f "$OPS_ENV_FILE"   # always .state/<project>.env, checked by state_path in ops_use
done
if [ "$1" = all ] && [ "${OPS_KEEP_IMAGES:-0}" != 1 ]; then
  for img in agora-ops-server:old agora-ops-server:new agora-ops-web:new; do
    docker image rm "$img" >/dev/null 2>&1 && echo "removed image $img" || true
  done
fi
echo "remaining containers:"
docker ps -a --format '  {{.Names}} {{.Status}}'
