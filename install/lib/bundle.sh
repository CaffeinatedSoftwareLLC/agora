# Backup bundles (docs/agent-boxes.md §9.4), shared by backup.sh, restore.sh and upgrade.sh.
# Every part is streamed through dist/src/tools/backup-crypt.js, so no plain-text copy of the
# database, the files or a box's home is ever written to disk.
#
# The crypt tool runs from CRYPT_IMAGE: the install's own backend image by default, or (for an
# upgrade, whose old image may predate the tool) a maintenance image built from the new release.

PASS_FILE=''
PASS_TMP=''
CRYPT_IMAGE=${CRYPT_IMAGE:-}

# The backend image of this install (compose names a built service's image <project>-<service>)
backend_image() {
    local dir=$1 project img
    project=$(env_get "$dir/$ENV_FILE_NAME" COMPOSE_PROJECT_NAME)
    project=${project:-$(env_get "$dir/$ENV_FILE_NAME" AGORA_INSTANCE)}
    project=${project:-agora}
    img="$project-api"
    dk image inspect "$img" >/dev/null 2>&1 || compose_in "$dir" build api >/dev/null
    printf '%s' "$img"
}

# A tag-safe version string
tag_version() { printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9_.-' '-' | head -c 100; }

# build_maintenance_image <checkout>: the backend image of that checkout, tagged
# agora/maintenance:<version>, built without touching any running stack. Prints the tag.
build_maintenance_image() {
    local src=$1 v tag
    v=$(tag_version "$(agora_version "$src")")
    tag="agora/maintenance:${v:-unknown}"
    dk build -q -t "$tag" -f "$src/Dockerfile" "$src" >/dev/null || return 1
    printf '%s' "$tag"
}

# The image has the crypt tool (images from before agent boxes don't)
has_crypt_tool() { dk run --rm --network none "$1" test -f dist/src/tools/backup-crypt.js >/dev/null 2>&1; }

# use_crypt_image <install dir> [given image]: sets CRYPT_IMAGE or dies
use_crypt_image() {
    local img=${2:-}
    [ -n "$img" ] || img=$(backend_image "$1") || die "can't find or build this install's backend image"
    has_crypt_tool "$img" || die "$img has no backup tool (an install from before agent boxes). Upgrade with the new release's script, which builds one: bash <new release>/install/upgrade.sh --dir $1"
    CRYPT_IMAGE=$img
}

# get_passphrase <given file> <confirm 0|1>: sets PASS_FILE (a 0600 file only this run reads)
get_passphrase() {
    if [ -n "$1" ]; then
        [ -r "$1" ] || die "can't read the passphrase file $1"
        PASS_FILE=$1
        return
    fi
    [ "$NON_INTERACTIVE" = 0 ] && [ -t 0 ] || die "no terminal to ask for the backup passphrase: pass --passphrase-file"
    local a b
    read -r -s -p '  Backup passphrase (at least 12 characters; without it the backup cannot be restored): ' a; printf '\n'
    if [ "$2" = 1 ]; then
        read -r -s -p '  Again: ' b; printf '\n'
        [ "$a" = "$b" ] || die "the passphrases differ"
    fi
    [ "${#a}" -ge 12 ] || die "the passphrase must be at least 12 characters"
    PASS_TMP=$(mktemp)
    chmod 600 "$PASS_TMP"
    printf '%s' "$a" > "$PASS_TMP"
    unset a b
    PASS_FILE=$PASS_TMP
}

forget_passphrase() { [ -z "$PASS_TMP" ] || rm -f "$PASS_TMP"; PASS_TMP=''; }

# crypt <args...>: backup-crypt in CRYPT_IMAGE, no network, as this user
crypt() {
    [ -n "$CRYPT_IMAGE" ] || die "internal: no crypt image chosen"
    dk run --rm -i --network none --user "$(id -u):$(id -g)" \
        -v "$(cd "$(dirname "$PASS_FILE")" && pwd)/$(basename "$PASS_FILE"):/run/agora-backup-pass:ro" \
        "$CRYPT_IMAGE" node dist/src/tools/backup-crypt.js "$@" --passphrase-file /run/agora-backup-pass
}

# Box home volumes of an instance, "<volume>|<box id>" per line. Fails when Docker can't list:
# an empty answer must mean "no boxes", never "couldn't look".
box_volumes() {
    local out v id
    out=$(dk volume ls --filter "label=org.agora.instance=$1" --format '{{.Name}}') || return 1
    while read -r v; do
        case "$v" in "$1-box-"*-home) ;; *) continue ;; esac
        id=${v#"$1-box-"}; id=${id%-home}
        printf '%s' "$id" | grep -Eq '^[0-9a-z]{26}$' || continue
        printf '%s|%s\n' "$v" "$id"
    done <<< "$out"
}

# Box containers of an instance. Fails when Docker can't list.
box_containers() {
    local out
    out=$(dk ps -a --filter "label=org.agora.instance=$1" --format '{{.Names}}') || return 1
    printf '%s\n' "$out" | grep -E "^$1-box-[0-9a-z]{26}\$" || true
}

# Running compose services of an install. Fails when compose can't list.
running_services() {
    local out
    out=$(compose_in "$1" ps --status running --format '{{.Service}}') || return 1
    printf '%s\n' "$out" | sed '/^$/d'
}

# psql in the install's postgres container over the local socket (no password), script on stdin
pg_psql_stdin() { compose_in "$DIR" exec -T postgres psql -U accord -d postgres -v ON_ERROR_STOP=1 -q -f -; }

# db_has_boxes: the database has the agent box tables (installs from before them don't)
db_has_boxes() {
    local r
    r=$(compose_in "$DIR" exec -T postgres psql -U accord -d agora -At -c "SELECT to_regclass('public.agent_boxes') IS NOT NULL") || return 2
    [ "$(printf '%s' "$r" | tr -d '[:space:]')" = t ]
}

# scram_verifier <node image>: the SCRAM-SHA-256 verifier (what Postgres stores in pg_authid) of
# the password on stdin, computed in a container with no network. Postgres takes a verifier in
# ALTER ROLE ... PASSWORD as is, so the password itself never reaches the server: not in a
# statement, not in a log line even with log_statement=all.
scram_verifier() {
    dk run --rm -i --network none "$1" node -e 'const c=require("crypto");let p=Buffer.alloc(0);process.stdin.on("data",d=>{p=Buffer.concat([p,d])}).on("end",()=>{const s=c.randomBytes(16),i=4096,sp=c.pbkdf2Sync(p,s,i,32,"sha256"),ck=c.createHmac("sha256",sp).update("Client Key").digest(),sk=c.createHmac("sha256",sp).update("Server Key").digest(),st=c.createHash("sha256").update(ck).digest();process.stdout.write("SCRAM-SHA-256$"+i+":"+s.toString("base64")+"$"+st.toString("base64")+":"+sk.toString("base64"))})'
}

# set_db_password <env file>: gives the accord role the env file's DB_PASSWORD (pg_dump doesn't
# carry role passwords, and the cluster is this machine's). The password goes to a node
# container on stdin; only its SCRAM verifier goes to psql, on stdin, quoted by psql (:'v').
set_db_password() {
    local verifier
    [ -n "$(env_get "$1" DB_PASSWORD)" ] || die "the restored $ENV_FILE_NAME has no DB_PASSWORD"
    verifier=$(env_get "$1" DB_PASSWORD | tr -d '\n' | scram_verifier "${CRYPT_IMAGE:?internal: no node image}") || return 1
    printf '%s' "$verifier" | grep -Eq '^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' || { warn 'could not compute the password verifier'; return 1; }
    printf '%s\n' \
        "\set verifier '$verifier'" \
        "ALTER ROLE accord PASSWORD :'verifier';" \
        | pg_psql_stdin >/dev/null
}
