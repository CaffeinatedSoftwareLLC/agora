#!/usr/bin/env bash
# OP-04.upgrade: start agora-ops from the previously deployed SHA, seed it, then rebuild
# the server from this checkout (the candidate) on the same volumes and assert that
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
MANIFEST="$(state_path "$OPS_STATE/agora-ops.manifest.json")"

if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=agora-ops)" ]; then
  die "agora-ops already has containers; run e2e/ops/down.sh agora-ops first"
fi
ops_gen_env "$OPS_ENV_FILE"

assert_eq() {  # assert_eq <what> <got> <want>
  if [ "$2" = "$3" ]; then echo "PASS $1: $2"; else die "FAIL $1: got '$2', want '$3'"; fi
}
versions_in() { ls "$1/src/db/migrations" | grep '\.sql$' | sed 's/\.sql$//' | sort; }
OLD_VERSIONS=$(versions_in "$OLD")
NEW_VERSIONS=$(versions_in "$OPS_REPO")
ADDED=$(comm -13 <(echo "$OLD_VERSIONS") <(echo "$NEW_VERSIONS") | paste -sd, -)
[ -z "$(comm -23 <(echo "$OLD_VERSIONS") <(echo "$NEW_VERSIONS"))" ] || die "the candidate drops migrations the old SHA had"
[ -n "$ADDED" ] || die "no new migrations between the two SHAs; nothing to check"
applied_count() { ops_psql -c "SELECT count(*) FROM schema_migrations"; }
applied_list() { ops_psql -c "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations"; }

log "OP-04.upgrade: old $OLD_SHA -> new $NEW_SHA (adds $ADDED)"
OPS_SERVER_IMAGE=agora-ops-server:old OPS_BUILD_CONTEXT="$OLD" OPS_BUILD=1 ops_up
OPS_SERVER_IMAGE=agora-ops-server:old OPS_BUILD_CONTEXT="$OLD" ops_wait_api 240 || { ocompose logs --tail 50 api; die "old API did not start"; }
assert_eq "old schema: migrations applied" "$(applied_list)" "$(echo "$OLD_VERSIONS" | paste -sd, -)"
"$OPS_DIR/seed.sh" agora-ops "$MANIFEST"
FP_BEFORE=$(ops_psql -c "SELECT value FROM instance_config WHERE key = 'encryption_key_fingerprint'")
[ -n "$FP_BEFORE" ] || die "old server recorded no key fingerprint"
log "verify on the old server (read-only; #155 makes /admin/storage fail there)"
"$OPS_DIR/verify.sh" agora-ops "$MANIFEST" --no-write || echo "ops: NOTE: verify on the old server had failures (see above)"
ocompose logs --no-color api > "$OPS_STATE/agora-ops.api-old.log" 2>&1

log "upgrade: rebuild the server from $NEW_SHA on the same volumes"
OPS_SERVER_IMAGE=agora-ops-server:new OPS_BUILD_CONTEXT="$OPS_REPO" OPS_BUILD=1 ops_up
ops_wait_api 240 || { ocompose logs --tail 80 api; die "new API did not start"; }
sleep 3
ocompose logs --no-color api > "$OPS_STATE/agora-ops.api-new.log" 2>&1
echo "migrate (new) log: $(ocompose logs --no-color migrate | tail -1)"
assert_eq "new schema: migrations applied" "$(applied_list)" "$(echo "$NEW_VERSIONS" | paste -sd, -)"
assert_eq "new schema: migration count" "$(applied_count)" "$(echo "$NEW_VERSIONS" | wc -l | tr -d ' ')"
WINDOW=$(ops_psql -c "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations WHERE applied_at > (SELECT max(applied_at) FROM schema_migrations WHERE version = '$(echo "$OLD_VERSIONS" | tail -1)')")
assert_eq "migrations applied by the upgrade" "$WINDOW" "$ADDED"
assert_eq "060_admin_instance_join rows" "$(ops_psql -c "SELECT count(*) FROM schema_migrations WHERE version = '060_admin_instance_join'")" 1
AT_060=$(ops_psql -c "SELECT applied_at FROM schema_migrations WHERE version = '060_admin_instance_join'")
assert_eq "fingerprint rows" "$(ops_psql -c "SELECT count(*) FROM instance_config WHERE key = 'encryption_key_fingerprint'")" 1
assert_eq "fingerprint unchanged by the upgrade" "$(ops_psql -c "SELECT value FROM instance_config WHERE key = 'encryption_key_fingerprint'")" "$FP_BEFORE"
REFUSALS=$(grep -c "does not match the key\|EncryptionKeyMismatch" "$OPS_STATE/agora-ops.api-new.log" || true)
assert_eq "fingerprint refusals in the new API log" "$REFUSALS" 0
assert_eq "new API restarts" "$(docker inspect -f '{{.RestartCount}}' "$(ocompose ps -q api)")" 0

log "re-run migrate (must be a no-op)"
ocompose run --rm --no-deps migrate >/dev/null
assert_eq "after re-run: migrations applied" "$(applied_list)" "$(echo "$NEW_VERSIONS" | paste -sd, -)"
assert_eq "after re-run: 060 rows" "$(ops_psql -c "SELECT count(*) FROM schema_migrations WHERE version = '060_admin_instance_join'")" 1
assert_eq "after re-run: 060 applied_at unchanged" "$(ops_psql -c "SELECT applied_at FROM schema_migrations WHERE version = '060_admin_instance_join'")" "$AT_060"

log "verify on the new server"
"$OPS_DIR/verify.sh" agora-ops "$MANIFEST"
log "migration 060 in use: approve a pending user"
ops_api approve-check --base "$OPS_BASE" --env "$OPS_ENV_FILE" --manifest "$MANIFEST"
echo "OP-04.upgrade: PASS"
