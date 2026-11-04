#!/usr/bin/env bash
# A fake `docker` for the install script tests (backup.test.sh, upgrade.test.sh). It keeps a
# small machine state under $FAKE and logs every call to $FAKE/log. Nothing real runs.
#
# State files in $FAKE:
#   services        compose services an `up` starts (one per line)
#   running         compose services running now
#   boxes           box container names;  boxes_running  the running ones
#   volumes         volume names (box home volumes)
#   images          images that exist;    crypt_images   images that carry backup-crypt
#   regclass        "t" when the database has agent_boxes, else "f"
#   dbboxes         rows for the agent_boxes query (id|gen|imgv|desired|need)
#   fail            an extended regex: a call whose arguments match it fails (exit 1)
#   fail_once       the same, but only for the first matching call
# The fake backup-crypt keeps parts readable: "SEG <name>\n<base64>\n" per part.
set -u
F=${FAKE:?FAKE is not set}
ORIG_ARGS="$*"
args="$*"
printf '%s\n' "docker $args" >> "$F/log"

if [ -s "$F/fail" ] && printf '%s' "$args" | grep -Eq "$(cat "$F/fail")"; then echo "fake docker: injected failure" >&2; exit 1; fi
if [ -s "$F/fail_once" ] && printf '%s' "$args" | grep -Eq "$(cat "$F/fail_once")"; then : > "$F/fail_once"; echo "fake docker: injected failure" >&2; exit 1; fi

has() { grep -qx "$2" "$F/$1" 2>/dev/null; }
add() { has "$1" "$2" || printf '%s\n' "$2" >> "$F/$1"; }
del() { [ -f "$F/$1" ] && { grep -vx "$2" "$F/$1" > "$F/$1.tmp" || true; mv "$F/$1.tmp" "$F/$1"; }; return 0; }
touch "$F/running" "$F/boxes" "$F/boxes_running" "$F/volumes" "$F/images" "$F/crypt_images" "$F/services"

fake_crypt() { # fake_crypt encrypt|verify|extract [--name N]
    local cmd=$1 name='' tmp
    shift
    while [ $# -gt 0 ]; do [ "$1" = --name ] && name=$2; shift; done
    case "$cmd" in
        encrypt)
            tmp=$(mktemp); cat > "$tmp"
            printf 'SEG %s\n%s\n' "$name" "$(base64 -w0 < "$tmp")"
            printf 'part %s %s %s\n' "$name" "$(sha256sum < "$tmp" | cut -d' ' -f1)" "$(wc -c < "$tmp" | tr -d ' ')" >&2
            rm -f "$tmp" ;;
        verify)
            while read -r tag n && read -r b; do
                [ "$tag" = SEG ] || { echo 'fake: damaged' >&2; exit 1; }
                printf 'part %s %s %s\n' "$n" "$(printf '%s' "$b" | base64 -d | sha256sum | cut -d' ' -f1)" "$(printf '%s' "$b" | base64 -d | wc -c | tr -d ' ')"
            done ;;
        extract)
            local found=1
            while read -r tag n && read -r b; do
                [ "$n" = "$name" ] && { printf '%s' "$b" | base64 -d; found=0; }
            done
            exit "$found" ;;
    esac
}

set -- "$@"
case "$1" in
    info) [ $# -eq 1 ] && exit 0; echo 'Ubuntu 24.04 LTS'; exit 0 ;;
    version) echo 29.0.0; exit 0 ;;
    image) [ "$2" = inspect ] && { has images "$3"; exit $?; } ;;
    build)
        # build -q -t TAG -f FILE CONTEXT
        while [ $# -gt 0 ]; do [ "$1" = -t ] && tag=$2; shift; done
        add images "$tag"; add crypt_images "$tag"; echo "sha256:fake"; exit 0 ;;
    ps)
        # docker ps -a --filter label=org.agora.instance=I --format {{.Names}}
        cat "$F/boxes"; exit 0 ;;
    inspect)
        c=${*: -1}
        has boxes "$c" || exit 1
        if has boxes_running "$c"; then echo true; else echo false; fi; exit 0 ;;
    stop) c=${*: -1}; del boxes_running "$c"; exit 0 ;;
    start) c=${*: -1}; add boxes_running "$c"; exit 0 ;;
    rm) c=${*: -1}; del boxes "$c"; del boxes_running "$c"; exit 0 ;;
    volume)
        case "$2" in
            ls) cat "$F/volumes"; exit 0 ;;
            inspect) v=${*: -1}; case "$v" in *_files-data) exit 0 ;; esac; has volumes "$v" || exit 1; echo 'org.agora.instance=agora;org.agora.box=x;'; exit 0 ;;
            create) add volumes "${*: -1}"; exit 0 ;;
            rm) del volumes "${*: -1}"; exit 0 ;;
        esac ;;
    run)
        # docker run ... IMAGE cmd...: find the image (first non-option after run's options)
        shift
        img=''
        while [ $# -gt 0 ]; do
            case "$1" in
                --rm|-i|-t) shift ;;
                --network|--user|-v|-e|-w|--entrypoint) shift 2 ;;
                *) img=$1; shift; break ;;
            esac
        done
        case "$*" in
            "test -f dist/src/tools/backup-crypt.js") has crypt_images "$img"; exit $? ;;
            "node dist/src/tools/backup-crypt.js "*) shift 2; fake_crypt "$@"; exit $? ;;
            tar*-cf*) echo "tar of a volume"; exit 0 ;;
            *tar*-x*) cat > /dev/null; exit 0 ;;
            "node scripts/setup-env.js"*) exit 0 ;;
            "node -e "*) cat > /dev/null; printf 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy'; exit 0 ;;
        esac
        exit 0 ;;
    compose)
        # docker compose -f F --env-file E <sub> ...
        shift 5
        sub=$1; shift
        case "$sub" in
            ps)
                case "$*" in
                    *"--status running"*) cat "$F/running" ;;
                    *) while read -r s; do echo "$s|running|Up"; done < "$F/running" ;;
                esac; exit 0 ;;
            stop)
                svcs=()
                while [ $# -gt 0 ]; do case "$1" in -t) shift 2 ;; *) svcs+=("$1"); shift ;; esac; done
                if [ "${#svcs[@]}" -eq 0 ]; then : > "$F/running"; else for s in "${svcs[@]}"; do del running "$s"; done; fi
                exit 0 ;;
            start) for s in "$@"; do add running "$s"; done; exit 0 ;;
            up)
                if printf '%s ' "$@" | grep -q 'postgres'; then add running postgres
                else cp "$F/services" "$F/running"; fi
                exit 0 ;;
            build) printf 'build in %s: %s\n' "$PWD" "$(ls "$PWD/src/db/migrations" 2>/dev/null | tr '\n' ' ')" >> "$F/log"; exit 0 ;;
            # Compose's own project name: COMPOSE_PROJECT_NAME from the env file, else the folder's name
            config)
                envf=$(printf '%s\n' "$ORIG_ARGS" | sed -n 's/.*--env-file \([^ ]*\).*/\1/p')
                p=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$envf" 2>/dev/null | tail -n 1)
                [ -n "$p" ] || p=$(basename "$PWD" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-')
                printf 'name: %s\nservices: {}\n' "$p"; exit 0 ;;
            logs) exit 0 ;;
            exec)
                # exec -T postgres <cmd...>
                shift 2
                case "$*" in
                    pg_dump*) echo '-- fake dump of agora'; exit 0 ;;
                    *to_regclass*) cat "$F/regclass" 2>/dev/null || echo f; exit 0 ;;
                    *"FROM agent_boxes"*) cat "$F/dbboxes" 2>/dev/null; exit 0 ;;
                    *"-f -"*) cat > "$F/psql-stdin"; exit 0 ;;
                    *" -c "*) exit 0 ;;
                    *) cat > /dev/null; exit 0 ;;
                esac ;;
            run)
                # run --rm --no-deps -T [-e X] migrate [cmd...]
                while [ $# -gt 0 ]; do case "$1" in --rm|--no-deps|-T) shift ;; -e) shift 2 ;; *) break ;; esac; done
                shift   # the service
                case "$*" in
                    '') printf 'migrate applied in %s: %s\n' "$PWD" "$(ls "$PWD/src/db/migrations" 2>/dev/null | tr '\n' ' ')" >> "$F/log"; exit 0 ;;
                    "test -f dist/src/tools/box-restore-prep.js") [ -f "$PWD/src/tools/box-restore-prep.ts" ]; exit $? ;;
                    *) exit 0 ;;
                esac ;;
        esac
        exit 0 ;;
esac
exit 0
