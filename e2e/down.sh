#!/usr/bin/env bash
# Tear down ONLY the disposable agora-e2e project: its containers, its volumes, its
# network and its :e2e images. Refuses any other project name. Never prunes.
set -euo pipefail

PROJECT="${1:-agora-e2e}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$HERE/docker-compose.e2e.yml"
ENV_FILE="$HERE/.env.e2e"

if [ "$PROJECT" != "agora-e2e" ]; then
  echo "down.sh: refusing: project '$PROJECT' is not agora-e2e" >&2
  exit 1
fi
grep -q '^name: agora-e2e$' "$COMPOSE_FILE" || { echo "down.sh: compose file is not the agora-e2e file" >&2; exit 1; }

# Compose needs the variables to parse the file; use dummies if the env is already gone.
if [ -f "$ENV_FILE" ]; then
  envargs=(--env-file "$ENV_FILE")
else
  export DB_PASSWORD=x JWT_SECRET=x AGORA_ENCRYPTION_KEY=x AGORA_SETUP_TOKEN=x
  envargs=()
fi

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "${envargs[@]}" down -v --remove-orphans
if [ "${E2E_KEEP_IMAGES:-0}" != 1 ]; then
  for img in agora-e2e-server:e2e agora-e2e-web:e2e; do
    docker image rm "$img" >/dev/null 2>&1 && echo "removed image $img" || true
  done
fi
if [ "${KEEP_ENV:-0}" != 1 ]; then rm -f "$ENV_FILE"; echo "removed $ENV_FILE"; fi
echo "agora-e2e removed. Live stack:"
docker ps --filter label=com.docker.compose.project=agora --format '  {{.Names}} {{.Status}}'
