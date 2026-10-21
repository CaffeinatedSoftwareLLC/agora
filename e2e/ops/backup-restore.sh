#!/usr/bin/env bash
# OP-05.restore / OP-05.wrong-key: back up the running, seeded agora-ops instance
# (pg_dump, the files volume, the env file) and restore it into an EMPTY
# agora-ops-restore project.
#
#   e2e/ops/backup-restore.sh [manifest in .state]
#
# Three restores, each into a freshly created agora-ops-restore:
#   1. docs   - what docs/storage-and-encryption.md#backups describes: pg_dump + volume + env.
#               pg_dump does not carry roles; this mode is expected to break and is reported,
#               and it is the only mode where pg_restore errors are tolerated.
#   2. wrong  - roles included, but a different AGORA_ENCRYPTION_KEY: the API must refuse to
#               start with the fingerprint message.
#   3. roles  - pg_dumpall --roles-only + pg_dump + volume + env: a clean restore and
#               verify.sh must pass; then a negative control for the decryption proof.
# agora-ops-restore is left running after step 3 for maintenance.sh.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MANIFEST="$(state_path "${1:-$OPS_STATE/agora-ops.manifest.json}")"
[ -f "$MANIFEST" ] || die "no manifest $MANIFEST (run upgrade.sh or seed.sh agora-ops first)"
BK="$(state_path "$OPS_STATE/backup-$(date -u +%Y%m%dT%H%M%SZ)")"
( umask 077; mkdir -p "$BK" )

# ---- backup (source: agora-ops) ----
ops_use agora-ops
ops_validate
ops_wait_api 30 || die "agora-ops is not running"
log "backup agora-ops -> $BK"
( umask 077
  ocompose exec -T postgres pg_dump -U accord -d agora -Fc > "$BK/agora.dump"
  ocompose exec -T postgres pg_dumpall -U accord --roles-only > "$BK/roles.sql" )
SRC_TABLES=$(ops_psql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
SRC_POLICIES=$(ops_psql -c "SELECT count(*) FROM pg_policies")
SRC_FILES=$(ocompose run --rm --no-deps -T --user root --entrypoint sh -v "$BK:/backup" api \
  -c 'umask 077; tar -C /data/files -czf /backup/files.tgz . && find /data/files -type f | wc -l' | tail -1 | tr -d '\r ')
ops_copy "$OPS_ENV_FILE" "$BK/env"
echo "source: $SRC_TABLES tables, $SRC_POLICIES policies, $SRC_FILES blobs"
( cd "$BK" && sha256sum agora.dump roles.sql files.tgz )

# ---- restore (target: agora-ops-restore) ----
# restore <docs|roles> <env-file>: sets RESTORE_RC, RESTORE_ERRORS, RESTORE_POLICIES
restore() {
  local mode="$1" env="$2" log_file
  ops_use agora-ops-restore
  ops_down >/dev/null
  [ -z "$(docker ps -aq --filter label=com.docker.compose.project=agora-ops-restore)" ] || die "agora-ops-restore not empty"
  ops_copy "$env" "$OPS_ENV_FILE"
  ops_up postgres
  for _ in $(seq 1 30); do ocompose exec -T postgres pg_isready -U accord -d agora >/dev/null 2>&1 && break; sleep 2; done
  sleep 2
  local before; before=$(ops_psql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
  [ "$before" = 0 ] || die "restore target is not empty ($before tables)"
  if [ "$mode" = roles ]; then
    local roles_log; roles_log="$(state_path "$OPS_STATE/restore-$mode.roles.log")"
    ocompose exec -T postgres psql -U accord -d postgres -q < "$BK/roles.sql" > "$roles_log" 2>&1 || true
    local unexpected; unexpected=$(grep ERROR "$roles_log" | grep -vc 'role "accord" already exists' || true)
    [ "$unexpected" = 0 ] || { cat "$roles_log"; die "roles.sql: $unexpected unexpected error(s)"; }
    echo "roles.sql applied (only 'role \"accord\" already exists' reported)"
  fi
  log_file="$(state_path "$OPS_STATE/restore-$mode.pg_restore.log")"
  RESTORE_RC=0
  ocompose exec -T postgres pg_restore -U accord -d agora < "$BK/agora.dump" > "$log_file" 2>&1 || RESTORE_RC=$?
  RESTORE_ERRORS=$(grep -c 'error:' "$log_file" || true)
  RESTORE_POLICIES=$(ops_psql -c "SELECT count(*) FROM pg_policies")
  echo "pg_restore exit $RESTORE_RC; $RESTORE_ERRORS error(s)"
  grep 'error:' "$log_file" | sort | uniq -c | sed 's/^/  /' | head -5 || true
  echo "after restore: $(ops_psql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")/$SRC_TABLES tables; $RESTORE_POLICIES/$SRC_POLICIES policies; app_user role: $(ops_psql -c "SELECT count(*) FROM pg_roles WHERE rolname = 'app_user'")"
  if [ "$mode" = roles ]; then
    [ "$RESTORE_RC" = 0 ] && [ "$RESTORE_ERRORS" = 0 ] || die "pg_restore failed in roles mode (exit $RESTORE_RC, $RESTORE_ERRORS errors)"
    [ "$RESTORE_POLICIES" = "$SRC_POLICIES" ] || die "restored $RESTORE_POLICIES policies, source has $SRC_POLICIES"
    [ "$(ops_psql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" = "$SRC_TABLES" ] || die "table count differs from the source"
  fi
  local restored
  restored=$(ocompose run --rm --no-deps -T --user root --entrypoint sh -v "$BK:/backup:ro" api \
    -c 'tar -C /data/files -xzf /backup/files.tgz && find /data/files -type f | wc -l' | tail -1 | tr -d '\r ')
  [ "$restored" = "$SRC_FILES" ] || die "restored $restored blobs, source has $SRC_FILES"
  echo "blobs restored: $restored/$SRC_FILES"
  ops_up migrate api
}

# ---- 1. docs: pg_dump only (expected to break; reported, not required) ----
log "OP-05.restore (docs procedure: pg_dump + volume + env, no roles)"
restore docs "$BK/env"
DOCS=broken
if ops_wait_api 120; then
  "$OPS_DIR/verify.sh" agora-ops-restore "$MANIFEST" --no-write && DOCS=works || true
else
  echo "docs restore: API did not become healthy"
fi
ocompose logs --no-color api > "$OPS_STATE/restore-docs.api.log" 2>&1
echo "docs restore: pg_restore exit $RESTORE_RC, $RESTORE_ERRORS errors, $RESTORE_POLICIES/$SRC_POLICIES policies; result: $DOCS"
echo "  api log 500s for role app_user: $(grep -c 'role \\"app_user\\" does not exist' "$OPS_STATE/restore-docs.api.log" || true)"

# ---- 2. wrong key ----
log "OP-05.wrong-key"
WRONG_ENV="$(state_path "$OPS_STATE/wrong-key.env")"
ops_copy "$BK/env" "$WRONG_ENV"
env_set "$WRONG_ENV" AGORA_ENCRYPTION_KEY "$(rnd 32)"
restore roles "$WRONG_ENV"
WRONG=pass
if ops_wait_api 40; then echo "wrong key: the API started and answers /health"; WRONG=fail; fi
ocompose logs --no-color api > "$OPS_STATE/restore-wrong-key.api.log" 2>&1
echo "api state: $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$(ocompose ps -aq api)")"
grep -m1 "AGORA_ENCRYPTION_KEY does not match the key this instance was set up with" "$OPS_STATE/restore-wrong-key.api.log" \
  | sed 's/^/  api log: /' || { echo "wrong key: fingerprint message NOT in the API log"; WRONG=fail; }
rm -f "$WRONG_ENV"
echo "OP-05.wrong-key: $WRONG"
[ "$WRONG" = pass ] || die "OP-05.wrong-key failed"

# ---- 3. roles + pg_dump + volume + env ----
log "OP-05.restore (pg_dumpall --roles-only + pg_dump + volume + env)"
restore roles "$BK/env"
ops_wait_api 120 || { ocompose logs --tail 40 api; die "restored API did not start"; }
ocompose logs --no-color api > "$OPS_STATE/restore-roles.api.log" 2>&1
if grep -q "does not match the key" "$OPS_STATE/restore-roles.api.log"; then die "fingerprint refusal with the right key"; fi
echo "migrate on restore: $(ocompose logs --no-color migrate | tail -1)"
"$OPS_DIR/verify.sh" agora-ops-restore "$MANIFEST"

log "negative control: a corrupted provider auth tag must give the decrypt error"
PID=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["provider"]["id"])' "$MANIFEST")
TAG=$(ops_psql -c "SELECT api_key_tag FROM ai_providers WHERE id = '$PID'")
[[ "$TAG" =~ ^[0-9a-f]{32}$ ]] || die "unexpected api_key_tag format"
ops_psql -c "UPDATE ai_providers SET api_key_tag = repeat('0', 32) WHERE id = '$PID'" >/dev/null
CONTROL=pass
ops_api provider-test --base "$OPS_BASE" --env "$OPS_ENV_FILE" --manifest "$MANIFEST" --expect decrypt-error || CONTROL=fail
ops_psql -c "UPDATE ai_providers SET api_key_tag = '$TAG' WHERE id = '$PID'" >/dev/null
ops_api provider-test --base "$OPS_BASE" --env "$OPS_ENV_FILE" --manifest "$MANIFEST" --expect decrypts || CONTROL=fail
[ "$CONTROL" = pass ] || die "decryption proof negative control failed"
echo "OP-05.restore: PASS (roles procedure); docs procedure: $DOCS"
echo "backup: $BK"
