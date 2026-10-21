#!/usr/bin/env bash
# OP-05.key-rotate and OP-04.strip-filenames on the disposable restored copy
# (agora-ops-restore, left running by backup-restore.sh). Never run against anything else.
#
#   e2e/ops/maintenance.sh [manifest in .state]
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

MANIFEST="$(state_path "${1:-$OPS_STATE/agora-ops.manifest.json}")"
ops_use agora-ops-restore
ops_validate
ops_wait_api 30 || die "agora-ops-restore is not running (run backup-restore.sh first)"
OLDKEY=$(env_get "$OPS_ENV_FILE" AGORA_ENCRYPTION_KEY)
NEWKEY=$(rnd 32)
fingerprint() {
  python3 -I -c 'import hmac,hashlib,sys; print(hmac.new(bytes.fromhex(sys.argv[1]), b"agora:encryption-key-fingerprint:v1", hashlib.sha256).hexdigest())' "$1"
}
LEAF="blob-$(fingerprint "$NEWKEY" | cut -c1-8)"

assert_eq() {  # assert_eq <what> <got> <want>
  if [ "$2" = "$3" ]; then echo "PASS $1: $2"; else die "FAIL $1: got '$2', want '$3'"; fi
}
# tool <script> [docker run args...]: the tool's output, then a last line "exit <code>"
tool() {
  local script="$1" rc=0; shift
  ocompose run --rm --no-deps -T "$@" api node "dist/src/tools/$script" 2>&1 || rc=$?
  echo "exit $rc"
}
live_files() { ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL"; }
done_files() { ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key LIKE '%/$LEAF'"; }
stored_fp() { ops_psql -c "SELECT value FROM instance_config WHERE key = 'encryption_key_fingerprint'"; }
named_paths() {
  ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL AND storage_key !~ '/blob(-[0-9a-f]{8})?\$'"
}
volume_leaves() {  # e.g. "3 blob,5 blob-1234abcd"
  ocompose run --rm --no-deps -T --user root --entrypoint sh api \
    -c 'find /data/files -type f | sed "s#.*/##" | sort | uniq -c | sed "s/^ *//" | paste -sd, -' | tr -d '\r'
}
# expect_refusal <log name>: with the current env the API must not start, and must log
# the fingerprint message
expect_refusal() {
  ops_up --no-deps --force-recreate api >/dev/null 2>&1
  if ops_wait_api 30; then die "FAIL the API started with the old key"; fi
  local f; f="$(state_path "$OPS_STATE/$1")" || exit 1
  ocompose logs --no-color api > "$f" 2>&1
  grep -m1 "does not match the key this instance was set up with" "$f" | sed 's/^/PASS refused at startup: /' \
    || die "FAIL no fingerprint message in $f"
  ocompose stop api >/dev/null 2>&1
}

# ================= OP-05.key-rotate =================
log "OP-05.key-rotate (new leaf $LEAF)"
N=$(live_files); echo "live files: $N"
[ "$N" -ge 5 ] || die "need at least 5 live files, have $N"
VICTIM=$(ops_psql -c "SELECT btrim(id) FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL ORDER BY id OFFSET 3 LIMIT 1")
TAG=$(ops_psql -c "SELECT encode(encryption_tag, 'hex') FROM files WHERE id = '$VICTIM'")
ocompose stop api >/dev/null 2>&1
ops_psql -c "UPDATE files SET encryption_tag = decode(repeat('00', 16), 'hex') WHERE id = '$VICTIM'" >/dev/null

echo "-- run 1 (interrupted at file $VICTIM, the 4th by id)"
OUT=$(tool rotate-encryption-key.js -e AGORA_NEW_ENCRYPTION_KEY="$NEWKEY"); echo "$OUT"
assert_eq "run 1 exit code" "$(echo "$OUT" | tail -1)" "exit 1"
echo "$OUT" | grep -q "File $VICTIM cannot be decrypted with the current key" || die "FAIL run 1 did not stop at $VICTIM"
assert_eq "run 1 files on the new key" "$(done_files)" 3
assert_eq "run 1 fingerprint still the old key" "$(stored_fp)" "$(fingerprint "$OLDKEY")"
ops_psql -c "UPDATE files SET encryption_tag = decode('$TAG', 'hex') WHERE id = '$VICTIM'" >/dev/null

echo "-- run 2 (tag restored, same two keys)"
OUT=$(tool rotate-encryption-key.js -e AGORA_NEW_ENCRYPTION_KEY="$NEWKEY"); echo "$OUT"
assert_eq "run 2 exit code" "$(echo "$OUT" | tail -1)" "exit 0"
assert_eq "run 2 summary" "$(echo "$OUT" | grep '^Rotated')" \
  "Rotated $((N - 3)) file(s) and 1 provider key(s); 3 file(s) were already done; 0 missing from storage."
assert_eq "run 2 files on the new key" "$(done_files)" "$N"
assert_eq "run 2 fingerprint is the new key" "$(stored_fp)" "$(fingerprint "$NEWKEY")"

echo "-- run 3"
OUT=$(tool rotate-encryption-key.js -e AGORA_NEW_ENCRYPTION_KEY="$NEWKEY"); echo "$OUT"
assert_eq "run 3" "$(echo "$OUT" | grep -E "^(This instance|Rotated)")" "This instance is already on the new key. Nothing to do."
assert_eq "blob leaves in the volume" "$(volume_leaves)" "$N $LEAF"
assert_eq "rows not on the new leaf" \
  "$(ops_psql -c "SELECT count(*) FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL AND storage_key NOT LIKE '%/$LEAF'")" 0

echo "-- start with the OLD key (must be refused)"
expect_refusal rotate-old-key.api.log

echo "-- start with the NEW key"
env_set "$OPS_ENV_FILE" AGORA_ENCRYPTION_KEY "$NEWKEY"
ops_up --no-deps --force-recreate api >/dev/null 2>&1
ops_wait_api 60 || { ocompose logs --tail 30 api; die "API did not start with the new key"; }
"$OPS_DIR/verify.sh" agora-ops-restore "$MANIFEST" --no-write
echo "OP-05.key-rotate: PASS"

# ================= OP-04.strip-filenames =================
log "OP-04.strip-filenames"
ocompose stop api >/dev/null 2>&1
moves=$(ops_psql -F' ' -c "SELECT btrim(id), btrim(storage_key), filename FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL ORDER BY id LIMIT 3")
script=""
while read -r id key name; do
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "unexpected file name '$name'"
  newkey="${key%/*}/$name"
  # exec reads stdin: keep it off the loop's input
  ops_psql -c "UPDATE files SET storage_key = '$newkey', path = '$newkey' WHERE id = '$id'" >/dev/null < /dev/null
  script+="mv '/data/files/$key' '/data/files/$newkey' && "
  echo "  $id: $key -> $newkey"
done <<< "$moves"
ocompose run --rm --no-deps -T --user root --entrypoint sh api -c "${script} echo moved"
assert_eq "storage paths carrying a file name (before)" "$(named_paths)" 3
OUT=$(tool strip-storage-filenames.js); echo "$OUT"
assert_eq "strip run 1" "$(echo "$OUT" | grep "^Done:")" "Done: 3 renamed, $((N - 3)) already without a file name, 0 missing from storage."
OUT=$(tool strip-storage-filenames.js); echo "$OUT"
assert_eq "strip run 2" "$(echo "$OUT" | grep "^Done:")" "Done: 0 renamed, $N already without a file name, 0 missing from storage."
assert_eq "storage paths carrying a file name (after)" "$(named_paths)" 0
assert_eq "blob leaves in the volume" "$(volume_leaves)" "3 blob,$((N - 3)) $LEAF"
ops_up --no-deps api >/dev/null 2>&1
ops_wait_api 60 || die "API did not start after strip-filenames"
"$OPS_DIR/verify.sh" agora-ops-restore "$MANIFEST" --no-write
echo "OP-04.strip-filenames: PASS"
