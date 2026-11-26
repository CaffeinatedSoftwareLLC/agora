#!/usr/bin/env bash
# shellcheck disable=SC2034  # variables read inside yes_if's eval
# Where an upgrade's backup goes, how much room it needs and what is cleaned up after it
# (install/upgrade.sh, install/lib/backups.sh), against the fake Docker of upgrade.test.sh.
# A backup that stays inside the VM or WSL distro is lost with it: these are the cases that keep it
# outside, and that keep an upgrade from deleting anything when it fails.
#
#   bash test/install/upgrade-backup.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
n=0 failed=0
check() { n=$((n + 1)); if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi; }
yes_if() { if eval "$1"; then echo yes; else echo no; fi; }
REAL_CP=$(command -v cp)

mkdir -p "$T/bin" "$T/winbin"
cp "$ROOT/test/install/fake-docker.sh" "$T/bin/docker"
printf '#!/bin/sh\necho "{\\"status\\":\\"ok\\"}"\n' > "$T/bin/curl"
# df: one disk with FAKE_FREE_KB free (a lot unless a case says otherwise)
printf '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake 999999999 1 %%s 1%% /fake\\n" "${FAKE_FREE_KB:-209715200}"\n' > "$T/bin/df"
# cp: FAKE_CP_CORRUPT=size appends a byte to a ".part" copy, =sha changes its first byte, =fail refuses
cat > "$T/bin/cp" <<EOF
#!/bin/bash
last="\${@: -1}"
case "\$last" in
    *.part)
        case "\${FAKE_CP_CORRUPT:-}" in
            fail) echo "cp: error writing '\$last': No space left on device" >&2; exit 1 ;;
            size) $REAL_CP "\$@" && printf x >> "\$last"; exit \$? ;;
            sha) $REAL_CP "\$@" && printf 'Z' | dd of="\$last" bs=1 count=1 conv=notrunc 2>/dev/null; exit \$? ;;
        esac ;;
esac
exec $REAL_CP "\$@"
EOF
chmod +x "$T/bin/docker" "$T/bin/curl" "$T/bin/df" "$T/bin/cp"
# WSL's side: cmd.exe knows %USERPROFILE%, wslpath maps it
mkdir -p "$T/winhome"
printf '#!/bin/sh\nprintf "%s\\r\\n" "%s"\n' '%s' "$T/winhome" > "$T/winbin/cmd.exe"
printf '#!/bin/sh\n[ "$1" = -u ] && shift\nprintf "%%s\\n" "$1"\n' > "$T/winbin/wslpath"
chmod +x "$T/winbin/cmd.exe" "$T/winbin/wslpath"
export PATH="$T/bin:$PATH"
export FAKE="$T/fake"
mkdir -p "$FAKE"
printf 'correct horse battery staple\n' > "$T/pass"
DBPW='old-db-password-Zq9'

mk_release() { # mk_release <dir> <version> <box version>
    mkdir -p "$1/src/db/migrations" "$1/src/tools" "$1/box"
    cp -r "$ROOT/install" "$1/"
    printf '{\n  "name": "agora",\n  "version": "%s"\n}\n' "$2" > "$1/package.json"
    printf 'services: {}\n' > "$1/docker-compose.prod.yml"
    printf 'FROM node:22-alpine\n' > "$1/Dockerfile"
    printf -- '-- core\n' > "$1/src/db/migrations/001_core.sql"
    printf -- '-- boxes\n' > "$1/src/db/migrations/080_agent_boxes.sql"
    printf '// prep\n' > "$1/src/tools/box-restore-prep.ts"
    printf '%s\n' "$3" > "$1/box/VERSION"
}
NEW="$T/new"
mk_release "$NEW" 1.0.0 2
inst=0
fresh() { # fresh: a box-era install 0.9.0 in $OLD, the engine running it
    inst=$((inst + 1))
    OLD="$T/inst$inst"
    NAME="agora-t$inst"
    mk_release "$OLD" 0.9.0 1
    printf 'COMPOSE_PROJECT_NAME=%s\nAGORA_INSTANCE=%s\nDB_PASSWORD=%s\nAGORA_EDGE_SECRET=%s\nAGORA_BOX_VERSION=1\nDOCKER_GID=999\n' "$NAME" "$NAME" "$DBPW" "$(printf 'a%.0s' $(seq 1 64))" > "$OLD/.env.prod"
    chmod 600 "$OLD/.env.prod"
    printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy box-socket-proxy box-edge boxd migrate > "$FAKE/services"
    printf '%s\n' postgres redis api runner cap-gateway web caddy socket-proxy box-socket-proxy box-edge boxd > "$FAKE/running"
    echo t > "$FAKE/regclass"
    : > "$FAKE/dbboxes"; : > "$FAKE/boxes"; : > "$FAKE/boxes_running"; : > "$FAKE/volumes"; : > "$FAKE/log"; : > "$FAKE/fail"
    : > "$FAKE/image_list"; : > "$FAKE/used_images"
    printf 'agora-api\n' > "$FAKE/images"; : > "$FAKE/crypt_images"
    : > "$FAKE/sandbox_nets"; : > "$FAKE/runs"
}
up() { # up [args]: the upgrade from the new release; exit code in code, output in $T/up.log
    if bash "$NEW/install/upgrade.sh" --dir "$OLD" --passphrase-file "$T/pass" --non-interactive "$@" > "$T/up.log" 2>&1; then code=0; else code=$?; fi
}
version_of() { sed -n 's/.*"version": "\(.*\)".*/\1/p' "$1/package.json"; }
cnt() { local c=0 f; for f in "$1"/$2; do [ -e "$f" ] && c=$((c + 1)); done; echo "$c"; }
nbk() { ls "$1"/*.agorabk 2>/dev/null | wc -l | tr -d ' '; }
mkbk() { # mkbk <dir> <name>: a bundle of 1 KB
    mkdir -p "$1"; head -c 1024 /dev/zero > "$1/$2"
}

# ─── Linux: the backup stays on the disk, and the summary says so ───
fresh; up
check 'linux: exit 0' 0 "$code"; [ "$code" = 0 ] || tail -n 30 "$T/up.log"
check 'linux: the backup is in <install>/backups' 1 "$(nbk "$OLD/backups")"
check 'linux: the summary says it is on the same disk' yes "$(yes_if "grep -q 'is on the same disk as Agora: if that disk fails, both are lost' '$T/up.log'")"
check 'linux: and suggests --backup-dir' yes "$(yes_if "grep -q 'backup-dir <folder on that disk>' '$T/up.log'")"

fresh; mkdir -p "$T/other-disk"; up --backup-dir "$T/other-disk"
check '--backup-dir: exit 0' 0 "$code"; [ "$code" = 0 ] || tail -n 30 "$T/up.log"
check '--backup-dir: the bundle is there' 1 "$(nbk "$T/other-disk")"
check '--backup-dir: and not in <install>/backups' 0 "$(nbk "$OLD/backups")"
check '--backup-dir: the rollback record names it' yes "$(yes_if "grep -q '^backup=$T/other-disk/' '$OLD/.agora-upgrade'")"
check '--backup-dir: no same-disk warning' 0 "$(grep -c 'same disk as Agora' "$T/up.log" || true)"
fresh; up --backup-dir relative/path
check '--backup-dir: a relative path is refused' 2 "$code"

# ─── Copy out: before anything changes, checked ───
fresh; up --copy-backup-to "$T/outside"
check 'copy-out: exit 0' 0 "$code"; [ "$code" = 0 ] || tail -n 30 "$T/up.log"
b_in=$(ls "$OLD"/backups/*.agorabk | head -n 1); b_out="$T/outside/$(basename "$b_in")"
check 'copy-out: the copy is byte for byte the backup' yes "$(yes_if 'cmp -s "$b_in" "$b_out"')"
check 'copy-out: says its size and SHA-256 match' yes "$(yes_if "grep -q 'size and SHA-256 match' '$T/up.log'")"
l_copy=$(grep -n 'Copying the backup out to' "$T/up.log" | head -n 1 | cut -d: -f1)
l_move=$(grep -n 'Moving the old release aside' "$T/up.log" | head -n 1 | cut -d: -f1)
check 'copy-out: the copy happens before the old release is moved aside' yes "$(yes_if '[ -n "$l_copy" ] && [ -n "$l_move" ] && [ "$l_copy" -lt "$l_move" ]')"
check 'copy-out: the summary names the copy' yes "$(yes_if "grep -q 'A copy outside where Agora runs is in $b_out' '$T/up.log'")"

fresh; : > "$T/notadir"
up --copy-backup-to "$T/notadir/x"
check 'copy-out to an unusable folder: stops' yes "$(yes_if '[ "$code" != 0 ]')"
check 'copy-out failure: nothing replaced' "0.9.0|no" "$(version_of "$OLD")|$(yes_if "[ -f '$OLD/.agora-upgrade' ]")"
check 'copy-out failure: says the backup could not be copied and nothing was changed' yes "$(yes_if "grep -q 'could not be copied to' '$T/up.log' && grep -q 'nothing was changed' '$T/up.log'")"

fresh; FAKE_CP_CORRUPT=fail up --copy-backup-to "$T/outside2"
check 'copy-out, the copy fails: stops, with cp'"'"'s own message' yes "$(yes_if "[ '$code' != 0 ] && grep -q 'No space left on device' '$T/up.log'")"
check 'copy-out, the copy fails: nothing replaced, no partial copy left' "0.9.0|0" "$(version_of "$OLD")|$(ls "$T/outside2" 2>/dev/null | wc -l | tr -d ' ')"
fresh; FAKE_CP_CORRUPT=size up --copy-backup-to "$T/outside3"
check 'copy-out, a size mismatch: stops' yes "$(yes_if "[ '$code' != 0 ] && grep -q 'bytes, the backup is' '$T/up.log'")"
check 'copy-out, a size mismatch: nothing replaced, no copy kept' "0.9.0|0" "$(version_of "$OLD")|$(ls "$T/outside3" 2>/dev/null | wc -l | tr -d ' ')"
fresh; FAKE_CP_CORRUPT=sha up --copy-backup-to "$T/outside4"
check 'copy-out, a checksum mismatch: stops' yes "$(yes_if "[ '$code' != 0 ] && grep -q 'another SHA-256 than the backup' '$T/up.log'")"
check 'copy-out, a checksum mismatch: nothing replaced, no copy kept' "0.9.0|0" "$(version_of "$OLD")|$(ls "$T/outside4" 2>/dev/null | wc -l | tr -d ' ')"
fresh; FAKE_CP_CORRUPT=sha up --copy-backup-to "$T/outside5" --backup-in-vm-only
check '--backup-in-vm-only does not skip an explicit --copy-backup-to' yes "$(yes_if '[ "$code" != 0 ]')"

# ─── WSL: the Windows user's folder, through /mnt/c ───
fresh
if PATH="$T/winbin:$PATH" WSL_DISTRO_NAME=Agora bash "$NEW/install/upgrade.sh" --dir "$OLD" --passphrase-file "$T/pass" --non-interactive > "$T/up.log" 2>&1; then code=0; else code=$?; fi
check 'wsl: exit 0' 0 "$code"; [ "$code" = 0 ] || tail -n 30 "$T/up.log"
check 'wsl: the backup is copied to the Windows user'"'"'s Agora Backups folder' 1 "$(nbk "$T/winhome/Agora Backups")"
check 'wsl: said before the upgrade started' yes "$(yes_if "grep -q 'WSL: the backup is also copied to $T/winhome/Agora Backups (on Windows)' '$T/up.log'")"
fresh
if WSL_DISTRO_NAME=Agora bash "$NEW/install/upgrade.sh" --dir "$OLD" --passphrase-file "$T/pass" --non-interactive > "$T/up.log" 2>&1; then code=0; else code=$?; fi
check 'wsl, Windows folder not found: the upgrade still goes on' 0 "$code"
check 'wsl, Windows folder not found: says loudly the backup is only inside the distro' yes "$(yes_if "grep -q \"THIS UPGRADE'S BACKUP IS ONLY INSIDE THE WSL DISTRO\" '$T/up.log'")"
fresh
if PATH="$T/winbin:$PATH" WSL_DISTRO_NAME=Agora bash "$NEW/install/upgrade.sh" --dir "$OLD" --passphrase-file "$T/pass" --non-interactive --backup-in-vm-only > "$T/up.log" 2>&1; then code=0; else code=$?; fi
check 'wsl --backup-in-vm-only: no copy to Windows, and a warning' "0|yes" "$(nbk "$T/winhome/Agora Backups" | sed 's/^[0-9]*$/0/')|$(yes_if "grep -q 'stays where Agora runs' '$T/up.log'")"

# ─── Lima: only the Mac can take the backup out ───
fresh
AGORA_ASSUME_LIMA=1 up
check 'lima, started without the Mac wrapper: refused' yes "$(yes_if '[ "$code" != 0 ] && grep -q "stays inside the VM" "$T/up.log"')"
check 'lima, refused: nothing changed' "0.9.0|0" "$(version_of "$OLD")|$(grep -c 'compose .* stop\b' "$FAKE/log" | tr -d ' ' || true)"
fresh
AGORA_ASSUME_LIMA=1 up --backup-only --backup-result-file "$T/result"
check '--backup-only: exit 0' 0 "$code"; [ "$code" = 0 ] || tail -n 20 "$T/up.log"
bo=$(sed -n 's/^bundle=//p' "$T/result")
check '--backup-only: the bundle exists and the result file names it' yes "$(yes_if '[ -n "$bo" ] && [ -s "$bo" ]')"
check '--backup-only: nothing replaced' "0.9.0|no" "$(version_of "$OLD")|$(yes_if "[ -f '$OLD/.agora-upgrade' ]")"
check '--backup-only: the staging folder is gone' 0 "$(ls -d "$OLD"/.releases/incoming-* 2>/dev/null | wc -l | tr -d ' ')"
: > "$FAKE/log"
AGORA_ASSUME_LIMA=1 up --use-backup "$bo"
check '--use-backup: exit 0 in the Lima VM' 0 "$code"; [ "$code" = 0 ] || tail -n 20 "$T/up.log"
check '--use-backup: no second backup is taken' 0 "$(grep -c 'backup-crypt.js encrypt' "$FAKE/log" || true)"
check '--use-backup: the rollback record names the backup that was passed' yes "$(yes_if "grep -q '^backup=$bo\$' '$OLD/.agora-upgrade'")"
check '--use-backup: the new release is in place' 1.0.0 "$(version_of "$OLD")"

# ─── Retention ───
fresh
for d in 01 02 03 04; do mkbk "$OLD/backups" "agora-$NAME-before-0.8.0-202601${d}T000000Z.agorabk"; done
mkbk "$OLD/backups" "agora-$NAME-20260101T000000Z.agorabk"     # made with the backup command
mkbk "$OLD/backups" "agora-other-before-0.8.0-20260101T000000Z.agorabk"   # another install's
up
check 'retention: exit 0' 0 "$code"; [ "$code" = 0 ] || tail -n 30 "$T/up.log"
check 'retention: keeps the newest 3 upgrade backups (the new one and 2 older)' 3 "$(cnt "$OLD/backups" "agora-$NAME-before-*")"
check 'retention: the two oldest are gone' "no|no" "$(yes_if "[ -e '$OLD/backups/agora-$NAME-before-0.8.0-20260101T000000Z.agorabk' ]")|$(yes_if "[ -e '$OLD/backups/agora-$NAME-before-0.8.0-20260102T000000Z.agorabk' ]")"
check 'retention: the newer old ones stay' "yes|yes" "$(yes_if "[ -e '$OLD/backups/agora-$NAME-before-0.8.0-20260103T000000Z.agorabk' ]")|$(yes_if "[ -e '$OLD/backups/agora-$NAME-before-0.8.0-20260104T000000Z.agorabk' ]")"
check 'retention: a bundle made with the backup command is never removed' yes "$(yes_if "[ -e '$OLD/backups/agora-$NAME-20260101T000000Z.agorabk' ]")"
check 'retention: another install'"'"'s bundle is never removed' yes "$(yes_if "[ -e '$OLD/backups/agora-other-before-0.8.0-20260101T000000Z.agorabk' ]")"
check 'retention: prints what it removed' 2 "$(grep -c 'removed old upgrade backup' "$T/up.log")"
check 'retention: and what it freed' yes "$(yes_if "grep -q 'of old upgrade backups (keeping the newest 3' '$T/up.log'")"

fresh
for d in 01 02 03; do mkbk "$OLD/backups" "agora-$NAME-before-0.8.0-202601${d}T000000Z.agorabk"; done
up --keep-backups 1
check '--keep-backups 1: only the new upgrade backup is left' 1 "$(cnt "$OLD/backups" "agora-$NAME-before-*")"
check '--keep-backups: remembered in .env.prod' 1 "$(grep -c '^AGORA_KEEP_BACKUPS=1$' "$OLD/.env.prod")"
fresh
for d in 01 02 03; do mkbk "$OLD/backups" "agora-$NAME-before-0.8.0-202601${d}T000000Z.agorabk"; done
echo 'AGORA_KEEP_BACKUPS=2' >> "$OLD/.env.prod"
up
check 'a remembered setting is used by a later upgrade (2: the new one and one old)' 2 "$(cnt "$OLD/backups" "agora-$NAME-before-*")"
fresh
for d in 01 02 03 04; do mkbk "$OLD/backups" "agora-$NAME-before-0.8.0-202601${d}T000000Z.agorabk"; done
up --keep-backups 0
check '--keep-backups 0: keeps all of them' 5 "$(cnt "$OLD/backups" "agora-$NAME-before-*")"
fresh; up --keep-backups x
check '--keep-backups with a non-number: refused' 2 "$code"

# the copy outside is pruned too
fresh
for d in 01 02 03 04; do mkbk "$T/outside6" "agora-$NAME-before-0.8.0-202601${d}T000000Z.agorabk"; done
up --copy-backup-to "$T/outside6" --keep-backups 2
check 'retention applies to the copy outside, keeping the new one' 2 "$(cnt "$T/outside6" "agora-$NAME-before-*")"

# a failed upgrade deletes nothing
fresh
for d in 01 02 03 04; do mkbk "$OLD/backups" "agora-$NAME-before-0.8.0-202601${d}T000000Z.agorabk"; done
echo 'compose .* up -d' > "$FAKE/fail"
up --keep-backups 1
check 'a failed upgrade: fails' yes "$(yes_if '[ "$code" != 0 ]')"
check 'a failed upgrade: every old backup is still there, and the new one' 5 "$(cnt "$OLD/backups" "agora-$NAME-before-*")"
check 'a failed upgrade: the setting is not stored either' 0 "$(grep -c '^AGORA_KEEP_BACKUPS=' "$OLD/.env.prod" || true)"
check 'a failed upgrade: no image removed' 0 "$(grep -c 'image rm' "$FAKE/log" || true)"
: > "$FAKE/fail"

# ─── Room, checked before anything starts ───
fresh
FAKE_FREE_KB=1000 up
check 'space: refused' yes "$(yes_if '[ "$code" != 0 ]')"
check 'space: names the path, the free space and the need' yes "$(yes_if "grep -q '/inst$inst.*free, the upgrade needs about' '$T/up.log' || grep -q 'free, the upgrade needs about' '$T/up.log'")"
check 'space: says what to remove' yes "$(yes_if "grep -q 'docker builder prune' '$T/up.log' && grep -q 'old backups' '$T/up.log' && grep -q 'old box images\|docker image ls agora/box' '$T/up.log'")"
check 'space: mentions --force' yes "$(yes_if "grep -q -- '--force' '$T/up.log'")"
check 'space: nothing stopped, nothing replaced, no backup taken' "0.9.0|0|0" "$(version_of "$OLD")|$(grep -c 'compose .* stop\b' "$FAKE/log" | tr -d ' ' || true)|$(nbk "$OLD/backups")"
FAKE_FREE_KB=1000 up --force
check 'space --force: goes on' 0 "$code"; [ "$code" = 0 ] || tail -n 20 "$T/up.log"
check 'space --force: says it went on anyway' yes "$(yes_if "grep -q 'force: starting although there is little room' '$T/up.log'")"
fresh
FAKE_FREE_KB=1000 up --check-space
check '--check-space: refuses by itself, changes nothing' "yes|0.9.0" "$(yes_if '[ "$code" != 0 ]')|$(version_of "$OLD")"
fresh; mkbk "$OLD/backups" "agora-$NAME-before-0.8.0-20260101T000000Z.agorabk"
up --check-space
check '--check-space: prints the backup size to expect (the last bundle: 2 KB rounded)' yes "$(yes_if "grep -q '^AGORA_BACKUP_EST_KB=[0-9]' '$T/up.log'")"
check '--check-space: changes nothing' "0|0.9.0" "$code|$(version_of "$OLD")"

# ─── Prune after a good upgrade ───
fresh
printf '%s\n' agora/box:0 agora/box:1 agora/box:2 agora/maintenance:0.8.0 agora/maintenance:1.0.0 postgres:16 > "$FAKE/image_list"
printf 'agora/box:1\n' > "$FAKE/used_images"
up
check 'prune: exit 0' 0 "$code"; [ "$code" = 0 ] || tail -n 30 "$T/up.log"
check 'prune: removes the build cache and says what it freed' yes "$(yes_if "grep -q 'builder prune' '$FAKE/log' && grep -q 'build cache freed:' '$T/up.log'")"
check 'prune: removes a box image no box uses' yes "$(yes_if "grep -q 'image rm agora/box:0' '$FAKE/log'")"
check 'prune: removes an old maintenance image' yes "$(yes_if "grep -q 'image rm agora/maintenance:0.8.0' '$FAKE/log'")"
check 'prune: never an image a box runs on' 0 "$(grep -c 'image rm agora/box:1$' "$FAKE/log" || true)"
check 'prune: never the new box image' 0 "$(grep -c 'image rm agora/box:2$' "$FAKE/log" || true)"
check 'prune: never the new maintenance image, never another image' 0 "$(grep -c 'image rm agora/maintenance:1.0.0\|image rm postgres' "$FAKE/log" || true)"
check 'prune: never a volume' 0 "$(grep -c 'volume rm\|volume prune\|system prune' "$FAKE/log" || true)"
fresh
printf '%s\n' agora/box:0 > "$FAKE/image_list"
up --no-prune
check '--no-prune: nothing pruned' 0 "$(grep -c 'prune\|image rm' "$FAKE/log" || true)"

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
