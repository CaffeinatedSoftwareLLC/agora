#!/usr/bin/env bash
# set_db_password (install/lib/bundle.sh) against a real Postgres 16: a cluster created with one
# DB_PASSWORD accepts the restored .env.prod's password over the network afterwards, and no
# longer the old one. The password goes in on stdin only; it must not show up in the server's
# log. Needs Docker (any engine; runc is fine). Uses names starting agora-boxtest-dbpw- and
# removes them.
#
#   bash test/install/db-password.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../../install/lib/common.sh
. "$ROOT/install/lib/common.sh"
# shellcheck source=../../install/lib/bundle.sh
. "$ROOT/install/lib/bundle.sh"
pick_docker || { echo 'Docker is not reachable' >&2; exit 1; }
# Any image with node computes the verifier; restore.sh uses the backup tool's image
CRYPT_IMAGE=${CRYPT_IMAGE:-node:22-alpine}

ID=agora-boxtest-dbpw-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
T=$(mktemp -d)
cleanup() { dk rm -f "$ID-pg" >/dev/null 2>&1 || true; dk network rm "$ID" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
n=0 failed=0
check() { n=$((n + 1)); if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi; }

OLD_PW='target-install-password'
# Quotes, a backslash, a dollar, a space, a semicolon: everything a naive quoting would break on
NEW_PW="restored'pw\"with\\odd \$chars;--"

dk network create "$ID" >/dev/null
dk run -d --name "$ID-pg" --network "$ID" -e POSTGRES_USER=accord -e POSTGRES_DB=agora -e "POSTGRES_PASSWORD=$OLD_PW" \
    -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 postgres:16-alpine -c log_statement=all >/dev/null
for _ in $(seq 1 60); do dk exec "$ID-pg" pg_isready -U accord -d agora -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done

# The install's postgres container, over its local socket (as compose exec does in restore.sh)
pg_psql_stdin() { dk exec -i "$ID-pg" psql -U accord -d postgres -v ON_ERROR_STOP=1 -q -f -; }

net_login() { # net_login <password>: a client on the network, as migrate and api connect
    printf '%s' "$1" | dk run --rm -i --network "$ID" postgres:16-alpine \
        sh -c 'PGPASSWORD="$(cat)" psql -h '"$ID-pg"' -U accord -d agora -Atc "SELECT 1"' 2>/dev/null
}

check 'before: the old password works over the network' 1 "$(net_login "$OLD_PW" || echo no)"

printf 'DB_PASSWORD=%s\nOTHER=x\n' "$NEW_PW" > "$T/env.prod"
set_db_password "$T/env.prod"

check 'after: the restored password works over the network' 1 "$(net_login "$NEW_PW" || echo no)"
check 'after: the old password no longer does' no "$(net_login "$OLD_PW" || echo no)"
logs=$(dk logs "$ID-pg" 2>&1)
check 'the password is not in the server log (log_statement=all)' 0 "$(printf '%s' "$logs" | grep -cF "restored'pw" || true)"
check 'the server log shows only the verifier' 1 "$([ "$(printf '%s' "$logs" | grep -c "ALTER ROLE accord PASSWORD 'SCRAM-SHA-256")" -ge 1 ] && echo 1 || echo 0)"

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
