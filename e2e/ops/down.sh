#!/usr/bin/env bash
# Remove ONLY an ops project (agora-ops or agora-ops-restore): containers, volumes,
# network. With both projects gone, also the agora-ops-server images. Never prunes.
#   e2e/ops/down.sh <agora-ops|agora-ops-restore|all>
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

targets=("${1:?project or all}")
[ "$1" = all ] && targets=(agora-ops agora-ops-restore)
for p in "${targets[@]}"; do
  ops_use "$p"
  ops_down
  rm -f "$OPS_ENV_FILE"
done
if [ "$1" = all ] && [ "${OPS_KEEP_IMAGES:-0}" != 1 ]; then
  for img in agora-ops-server:old agora-ops-server:new agora-ops-web:new; do
    docker image rm "$img" >/dev/null 2>&1 && echo "removed image $img" || true
  done
fi
echo "remaining containers:"
docker ps -a --format '  {{.Names}} {{.Status}}'
