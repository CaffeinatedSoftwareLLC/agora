#!/usr/bin/env bash
# OP-05.key-rotate and OP-04.strip-filenames on the disposable restored copy
# (agora-ops-restore, left running by backup-restore.sh). Never run against anything else.
#
#   e2e/ops/maintenance.sh [manifest]
#
# key-rotate: an "interrupted" first run (one file's auth tag is corrupted, so the tool
# stops partway, as a crash would), the tag is put back and the tool re-run, then run a
# third time (nothing to do). The old key must then be refused at startup and, under the
# new key, every file must download byte for byte and the provider key must decrypt.
# strip-filenames: some blobs are moved back to pre-0.2.0 storage names
# (<channel>/<file>/<file name>), the tool renames them, a re-run renames 0, and the
# downloads are unchanged.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MANIFEST="${1:-$OPS_STATE/agora-ops.manifest.json}"
ops_use agora-ops-restore
ops_wait_api 30 || die "agora-ops-restore is not running (run backup-restore.sh first)"
OLDKEY=$(env_get "$OPS_ENV_FILE" AGORA_ENCRYPTION_KEY)
NEWKEY=$(rnd 32)
LEAF="blob-$(python3 -I -c 'import hmac,hashlib,sys; print(hmac.new(bytes.fromhex(sys.argv[1]), b"agora:encryption-key-fingerprint:v1", hashlib.sha256).hexdigest()[:8])' "$NEWKEY")"

tool() {  # tool <script> [extra docker run args...]
  local script="$1"; shift
  ocompose run --rm --no-deps -T "$@" api node "dist/src/tools/$script"
}
live_files() { ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL"; }
done_files() { ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key LIKE '%/$LEAF'"; }
volume_leaves() {
  ocompose run --rm --no-deps -T --user root --entrypoint sh api -c 'find /data/files -type f | sed "s#.*/##" | sort | uniq -c'
}

# ================= OP-05.key-rotate =================
log "OP-05.key-rotate (new leaf $LEAF)"
N=$(live_files); echo "live files: $N"
VICTIM=$(ops_psql -c "SELECT btrim(id) FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL ORDER BY id OFFSET 3 LIMIT 1")
TAG=$(ops_psql -c "SELECT encode(encryption_tag, 'hex') FROM files WHERE id = '$VICTIM'")
ocompose stop api >/dev/null 2>&1
ops_psql -c "UPDATE files SET encryption_tag = decode(repeat('00', 16), 'hex') WHERE id = '$VICTIM'" >/dev/null
echo "-- run 1 (interrupted at file $VICTIM, the 4th by id)"
set +e; tool rotate-encryption-key.js -e AGORA_NEW_ENCRYPTION_KEY="$NEWKEY"; rc=$?; set -e
echo "run 1 exit $rc; files done: $(done_files)/$N; fingerprint is old key: $(ops_psql -c "SELECT value FROM instance_config WHERE key='encryption_key_fingerprint'" | python3 -I -c 'import hmac,hashlib,sys; print(sys.stdin.read().strip()==hmac.new(bytes.fromhex(sys.argv[1]), b"agora:encryption-key-fingerprint:v1", hashlib.sha256).hexdigest())' "$OLDKEY")"
ops_psql -c "UPDATE files SET encryption_tag = decode('$TAG', 'hex') WHERE id = '$VICTIM'" >/dev/null
echo "-- run 2 (tag restored, same two keys)"
tool rotate-encryption-key.js -e AGORA_NEW_ENCRYPTION_KEY="$NEWKEY"
echo "files done: $(done_files)/$N"
echo "-- run 3"
tool rotate-encryption-key.js -e AGORA_NEW_ENCRYPTION_KEY="$NEWKEY"
echo "blob leaves in the volume:"; volume_leaves
echo "rows not on the new leaf: $(ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL AND storage_key NOT LIKE '%/$LEAF'")"

echo "-- start with the OLD key (must be refused)"
ocompose up -d --no-deps --no-build api >/dev/null 2>&1
if ops_wait_api 30; then echo "old key after rotation: FAIL, API started"; ROT=fail; else ROT=pass; fi
ocompose logs --no-color api > "$OPS_STATE/rotate-old-key.api.log" 2>&1
grep -m1 "does not match the key this instance was set up with" "$OPS_STATE/rotate-old-key.api.log" | sed 's/^/  api log: /' \
  || { echo "old key: no fingerprint message"; ROT=fail; }
ocompose stop api >/dev/null 2>&1

echo "-- start with the NEW key"
env_set "$OPS_ENV_FILE" AGORA_ENCRYPTION_KEY "$NEWKEY"
ocompose up -d --no-deps --no-build --force-recreate api >/dev/null 2>&1
ops_wait_api 60 || { ocompose logs --tail 30 api; die "API did not start with the new key"; }
"$OPS_DIR/verify.sh" agora-ops-restore "$MANIFEST" --no-write || ROT=fail
echo "OP-05.key-rotate: $ROT"

# ================= OP-04.strip-filenames =================
log "OP-04.strip-filenames"
ocompose stop api >/dev/null 2>&1
moves=$(ops_psql -F' ' -c "SELECT btrim(id), btrim(storage_key), filename FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL ORDER BY id LIMIT 3")
script=""
while read -r id key name; do
  newkey="${key%/*}/$name"
  # exec reads stdin: keep it off the loop's input
  ops_psql -c "UPDATE files SET storage_key = '$newkey', path = '$newkey' WHERE id = '$id'" >/dev/null < /dev/null
  script+="mv '/data/files/$key' '/data/files/$newkey' && "
  echo "  $id: $key -> $newkey"
done <<< "$moves"
ocompose run --rm --no-deps -T --user root --entrypoint sh api -c "${script} echo moved"
echo "storage paths carrying a file name (before): $(ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key !~ '/blob(-[0-9a-f]{8})?\$'")"
echo "-- run 1"; tool strip-storage-filenames.js
echo "-- run 2"; tool strip-storage-filenames.js
echo "storage paths carrying a file name (after): $(ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key !~ '/blob(-[0-9a-f]{8})?\$'")"
echo "blob leaves in the volume:"; volume_leaves
ocompose up -d --no-deps --no-build api >/dev/null 2>&1
ops_wait_api 60 || die "API did not start after strip-filenames"
"$OPS_DIR/verify.sh" agora-ops-restore "$MANIFEST" --no-write
[ "$ROT" = pass ] || die "OP-05.key-rotate failed"
echo "maintenance: done"
