#!/usr/bin/env bash
# Recreate an install's sandbox network with the settings its release declares, without losing a
# code run (sandbox-isolation-spec §6.1). install/upgrade.sh does this on its own; run this after
# updating an install some other way (git pull + `compose up`), when the runner refuses to start
# with "lets runs reach the host on its gateway address".
#
#   bash install/sandbox-network.sh [--dir <install folder>]
#
# Stops the runner (it finishes runs in progress, up to 11 minutes; new runs wait in the queue),
# removes the cap-gateway container and the network, then starts the stack again.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/sandbox-net.sh
. "$HERE/lib/sandbox-net.sh"

DIR=''
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR=$2; shift ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "sandbox-network.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
DIR=$(cd "${DIR:-$HERE/..}" && pwd)
[ -f "$DIR/$ENV_FILE_NAME" ] || die "no $ENV_FILE_NAME in $DIR"
pick_docker || die "Docker isn't reachable"
INSTANCE=$(install_instance "$DIR") || die "can't tell the install name of $DIR"

check_sandbox_network "$DIR" "$INSTANCE"
step sandbox.drain 'Letting code runs in progress finish'
drain_code_runs "$DIR" "$INSTANCE"
step sandbox.network 'Recreating the sandbox network'
prepare_sandbox_network "$DIR" "$INSTANCE"
step sandbox.start 'Starting the stack'
compose_in "$DIR" up -d
verify_sandbox_network "$DIR" "$INSTANCE"
FINISHED=1
ok done
