# Backup bundles (docs/agent-boxes.md §9.4), shared by backup.sh, restore.sh and upgrade.sh.
# Every part is streamed through dist/src/tools/backup-crypt.js in the backend image, so no
# plain-text copy of the database, the files or a box's home is ever written to disk.

PASS_FILE=''
PASS_TMP=''

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

# crypt <image> <args...>: backup-crypt in the backend image, no network, as this user
crypt() {
    local img=$1; shift
    dk run --rm -i --network none --user "$(id -u):$(id -g)" \
        -v "$(cd "$(dirname "$PASS_FILE")" && pwd)/$(basename "$PASS_FILE"):/run/agora-backup-pass:ro" \
        "$img" node dist/src/tools/backup-crypt.js "$@" --passphrase-file /run/agora-backup-pass
}

# Box home volumes of an instance: "<volume>|<box id>"
box_volumes() {
    dk volume ls --filter "label=org.agora.instance=$1" --format '{{.Name}}' 2>/dev/null \
        | grep -E "^$1-box-[0-9a-z]{26}-home\$" | while read -r v; do
            id=${v#"$1-box-"}; id=${id%-home}
            printf '%s|%s\n' "$v" "$id"
        done
}

# Running box containers of an instance
box_containers() {
    dk ps -a --filter "label=org.agora.instance=$1" --format '{{.Names}}' 2>/dev/null | grep -E "^$1-box-[0-9a-z]{26}\$" || true
}
