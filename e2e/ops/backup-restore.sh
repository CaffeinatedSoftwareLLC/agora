#!/usr/bin/env bash
# OP-05.restore / OP-05.wrong-key: back up the running, seeded agora-ops instance
# (pg_dump, the files volume, the env file) and restore it into an EMPTY
# agora-ops-restore project.
#
#   e2e/ops/backup-restore.sh [manifest]
#
# Three restores, each into a freshly created agora-ops-restore:
#   1. docs   - what docs/storage-and-encryption.md#backups describes: pg_dump + volume + env.
#               pg_dump does not carry roles, so the result is reported, not required to pass.
#   2. wrong  - roles included, but a different AGORA_ENCRYPTION_KEY: the API must refuse to
#               start with the fingerprint message.
#   3. roles  - pg_dumpall --roles-only + pg_dump + volume + env: verify.sh must pass.
# agora-ops-restore is left running after step 3 for maintenance.sh.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MANIFEST="${1:-$OPS_STATE/agora-ops.manifest.json}"
[ -f "$MANIFEST" ] || die "no manifest $MANIFEST (run upgrade.sh or seed.sh agora-ops first)"
BK="$OPS_STATE/backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BK"; chmod 700 "$BK"

# ---- backup (source: agora-ops) ----
ops_use agora-ops
ops_wait_api 30 || die "agora-ops is not running"
log "backup agora-ops -> $BK"
ocompose exec -T postgres pg_dump -U accord -d agora -Fc > "$BK/agora.dump"
ocompose exec -T postgres pg_dumpall -U accord --roles-only > "$BK/roles.sql"
ocompose run --rm --no-deps -T --user root --entrypoint sh -v "$BK:/backup" api \
  -c 'tar -C /data/files -czf /backup/files.tgz . && echo "files in volume: $(find /data/files -type f | wc -l)"'
cp "$OPS_ENV_FILE" "$BK/env"; chmod 600 "$BK/env"
( cd "$BK" && ls -l && sha256sum agora.dump roles.sql files.tgz )

# ---- restore helpers (target: agora-ops-restore) ----
restore() {  # restore <docs|roles> <env-file>
  local mode="$1" env="$2"
  ops_use agora-ops-restore
  ops_down >/dev/null 2>&1 || true
  [ -z "$(docker ps -aq --filter label=com.docker.compose.project=agora-ops-restore)" ] || die "agora-ops-restore not empty"
  cp "$env" "$OPS_ENV_FILE"; chmod 600 "$OPS_ENV_FILE"
  ops_up postgres
  for _ in $(seq 1 30); do ocompose exec -T postgres pg_isready -U accord -d agora >/dev/null 2>&1 && break; sleep 2; done
  sleep 2
  echo "tables before restore: $(ops_psql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
  if [ "$mode" = roles ]; then
    echo "roles.sql: $(ocompose exec -T postgres psql -U accord -d postgres -q < "$BK/roles.sql" 2>&1 | grep -c ERROR || true) error line(s) (role accord already exists is expected)"
  fi
  set +e
  ocompose exec -T postgres pg_restore -U accord -d agora < "$BK/agora.dump" > "$OPS_STATE/restore-$mode.pg_restore.log" 2>&1
  local rc=$?
  set -e
  echo "pg_restore exit $rc; $(grep -c 'error:' "$OPS_STATE/restore-$mode.pg_restore.log" || true) error(s)"
  grep 'error:' "$OPS_STATE/restore-$mode.pg_restore.log" | sed 's/^/  /' | head -8 || true
  echo "tables after restore: $(ops_psql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"); policies: $(ops_psql -c "SELECT count(*) FROM pg_policies"); app_user role: $(ops_psql -c "SELECT count(*) FROM pg_roles WHERE rolname = 'app_user'")"
  ocompose run --rm --no-deps -T --user root --entrypoint sh -v "$BK:/backup:ro" api \
    -c 'tar -C /data/files -xzf /backup/files.tgz && echo "files restored: $(find /data/files -type f | wc -l)"'
  ops_up migrate api
}

# ---- 1. docs: pg_dump only ----
log "OP-05.restore (docs procedure: pg_dump + volume + env, no roles)"
restore docs "$BK/env"
if ops_wait_api 120; then
  "$OPS_DIR/verify.sh" agora-ops-restore "$MANIFEST" --no-write && echo "docs restore: verify PASSED" || echo "docs restore: verify FAILED"
else
  echo "docs restore: API did not become healthy"; ocompose logs --tail 30 api
fi
ocompose logs --no-color api > "$OPS_STATE/restore-docs.api.log" 2>&1
grep -m3 -i "app_user\|error" "$OPS_STATE/restore-docs.api.log" | sed 's/^/  api log: /' || true

# ---- 2. wrong key ----
log "OP-05.wrong-key"
cp "$BK/env" "$OPS_STATE/wrong-key.env"
env_set "$OPS_STATE/wrong-key.env" AGORA_ENCRYPTION_KEY "$(rnd 32)"
restore roles "$OPS_STATE/wrong-key.env"
if ops_wait_api 40; then
  echo "wrong key: FAIL, the API started and answers /health"
  WRONG=fail
else
  WRONG=pass
fi
ocompose logs --no-color api > "$OPS_STATE/restore-wrong-key.api.log" 2>&1
echo "api state: $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$(ocompose ps -aq api)")"
grep -m1 "AGORA_ENCRYPTION_KEY does not match the key this instance was set up with" "$OPS_STATE/restore-wrong-key.api.log" \
  | sed 's/^/  api log: /' || { echo "wrong key: fingerprint message NOT in the API log"; WRONG=fail; }
echo "OP-05.wrong-key: $WRONG"

# ---- 3. roles + pg_dump + volume + env ----
log "OP-05.restore (pg_dumpall --roles-only + pg_dump + volume + env)"
restore roles "$BK/env"
ops_wait_api 120 || { ocompose logs --tail 40 api; die "restored API did not start"; }
ocompose logs --no-color api > "$OPS_STATE/restore-roles.api.log" 2>&1
grep -q "does not match the key" "$OPS_STATE/restore-roles.api.log" && die "fingerprint refusal with the right key"
echo "migrate on restore: $(ocompose logs --no-color migrate | tail -1)"
"$OPS_DIR/verify.sh" agora-ops-restore "$MANIFEST"
echo "backup: $BK"
[ "$WRONG" = pass ] || die "OP-05.wrong-key failed"
