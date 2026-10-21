#!/usr/bin/env bash
# OP-04.upgrade: start agora-ops from the previously deployed SHA, seed it, then rebuild
# the server from this checkout (the candidate) on the same volumes and check that
# migrations apply exactly once, the seeded data is all usable, and the key
# fingerprint check passes.
#
#   OPS_OLD_CONTEXT=/path/to/worktree-of-old-sha e2e/ops/upgrade.sh
#
# Leaves agora-ops running for backup-restore.sh; remove it with e2e/ops/down.sh agora-ops.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OLD="${OPS_OLD_CONTEXT:?set OPS_OLD_CONTEXT to a checkout of the previously deployed SHA}"
[ -f "$OLD/Dockerfile" ] || die "$OLD has no Dockerfile"
OLD_SHA=${OPS_OLD_SHA:-$(git -C "$OLD" rev-parse --short HEAD 2>/dev/null || echo unknown)}
NEW_SHA=${OPS_NEW_SHA:-$(git -C "$OPS_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)}
ops_use agora-ops
MANIFEST="$OPS_STATE/agora-ops.manifest.json"

if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=agora-ops)" ]; then
  die "agora-ops already has containers; run e2e/ops/down.sh agora-ops first"
fi
ops_gen_env "$OPS_ENV_FILE"

migrations() { ops_psql -c "SELECT count(*) || ' applied, latest ' || max(version) FROM schema_migrations"; }

log "OP-04.upgrade: old $OLD_SHA -> new $NEW_SHA"
OPS_SERVER_IMAGE=agora-ops-server:old OPS_BUILD_CONTEXT="$OLD" OPS_BUILD=1 ops_up
OPS_SERVER_IMAGE=agora-ops-server:old OPS_BUILD_CONTEXT="$OLD" ops_wait_api 240 || { ocompose logs --tail 50 api; die "old API did not start"; }
echo "old schema: $(migrations)"
"$OPS_DIR/seed.sh" agora-ops "$MANIFEST"
log "verify on the old server (read-only)"
"$OPS_DIR/verify.sh" agora-ops "$MANIFEST" --no-write || echo "ops: NOTE: verify on the old server had failures (see above)"
ocompose logs --no-color api > "$OPS_STATE/agora-ops.api-old.log" 2>&1

log "upgrade: rebuild the server from $NEW_SHA on the same volumes"
OPS_SERVER_IMAGE=agora-ops-server:new OPS_BUILD_CONTEXT="$OPS_REPO" OPS_BUILD=1 ops_up
ops_wait_api 240 || { ocompose logs --tail 80 api; die "new API did not start"; }
sleep 3
ocompose logs --no-color api > "$OPS_STATE/agora-ops.api-new.log" 2>&1
echo "migrate (new) log:"; ocompose logs --no-color migrate | tail -5
echo "new schema: $(migrations)"
echo "060 rows: $(ops_psql -c "SELECT count(*) FROM schema_migrations WHERE version = '060_admin_instance_join'")"
echo "migrations applied in the upgrade window: $(ops_psql -c "SELECT string_agg(version, ',') FROM schema_migrations WHERE applied_at > (SELECT max(applied_at) FROM schema_migrations WHERE version = '059_live_tool_requests')")"
echo "fingerprint rows: $(ops_psql -c "SELECT count(*) FROM instance_config WHERE key = 'encryption_key_fingerprint'")"
if grep -q "does not match the key\|EncryptionKeyMismatch" "$OPS_STATE/agora-ops.api-new.log"; then
  die "new API logged a key fingerprint refusal"
fi
echo "fingerprint refusal in new API log: none"
echo "api restarts: $(docker inspect -f '{{.RestartCount}}' "$(ocompose ps -q api)")"

log "re-run migrate (must be a no-op)"
ocompose run --rm --no-deps migrate >/dev/null
echo "after re-run: $(migrations); 060 rows: $(ops_psql -c "SELECT count(*) FROM schema_migrations WHERE version = '060_admin_instance_join'")"

log "verify on the new server"
"$OPS_DIR/verify.sh" agora-ops "$MANIFEST"
log "migration 060 in use: approve a pending user"
ops_api approve-check --base "$OPS_BASE" --env "$OPS_ENV_FILE" --manifest "$MANIFEST"
echo "OP-04.upgrade: done"
