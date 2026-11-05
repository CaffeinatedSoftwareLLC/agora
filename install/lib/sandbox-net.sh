# Code runs and the sandbox network during an upgrade or rollback (sandbox-isolation-spec §6.1).
# Sourced after common.sh by upgrade.sh and sandbox-network.sh.
#
# The sandbox network (<instance>_sandbox) gained com.docker.network.bridge.inhibit_ipv4, which
# keeps the host off it. Docker can't change a network's options in place, and a network with
# containers on it can't be removed, so the upgrade:
#   1. drains code runs: stops the runner, which takes no new runs and finishes the ones in
#      progress (runs submitted meanwhile wait in the queue), then removes this install's run
#      containers that are somehow still there;
#   2. removes cap-gateway's container (the only service on the network; stateless);
#   3. removes the network, if its options differ from what the release in the folder declares.
# `compose up` then creates the network from the release's compose file and starts the runner
# and cap-gateway on it. A rollback runs the same steps with the old release in the folder, so
# the network goes back to what that release declares.

SANDBOX_INHIBIT_OPT=com.docker.network.bridge.inhibit_ipv4
# The longest code run is 10 minutes (src/runtime/limits.ts), plus the runner's own wrap-up.
# The same as the runner's stop_grace_period in docker-compose.prod.yml
RUNNER_DRAIN_SECONDS=${RUNNER_DRAIN_SECONDS:-660}

# run_containers <instance>: this install's code-run containers, running or not. Containers from
# before the agora.instance label belong to the default install, as the runner always treated them.
run_containers() {
    local out
    out=$(dk ps -a --filter label=agora.managed=runtime --format '{{.Names}} {{.Label "agora.instance"}}') || return 1
    printf '%s\n' "$out" | awk -v want="$1" 'NF { inst = ($2 == "" ? "agora" : $2); if (inst == want) print $1 }'
}

# drain_code_runs <dir> <instance>
drain_code_runs() {
    local dir=$1 inst=$2 left
    info "letting code runs in progress finish (up to $((RUNNER_DRAIN_SECONDS / 60)) minutes); new ones wait in the queue"
    compose_in "$dir" stop -t "$RUNNER_DRAIN_SECONDS" runner >/dev/null || die "could not stop the runner"
    left=$(run_containers "$inst") || die "can't list this install's code-run containers"
    if [ -n "$left" ]; then
        # The runner is gone, so nothing would collect these runs' results; the next runner
        # start marks them as interrupted
        warn "removing code-run containers the runner left: $(printf '%s' "$left" | tr '\n' ' ')"
        # shellcheck disable=SC2086 # one name per word
        dk rm -f $left >/dev/null || die "could not remove this install's leftover code-run containers"
    fi
    ok 'no code run in progress'
}

# release_wants_inhibit <dir>: whether the release in <dir> declares the option on its sandbox network
release_wants_inhibit() { grep -q "$SANDBOX_INHIBIT_OPT" "$1/$COMPOSE_FILE_NAME"; }

# sandbox_net_state <instance>: absent, inhibit or open
sandbox_net_state() {
    local net="$1_sandbox" opt
    dk network inspect "$net" >/dev/null 2>&1 || { echo absent; return 0; }
    opt=$(dk network inspect -f "{{index .Options \"$SANDBOX_INHIBIT_OPT\"}}" "$net") || return 1
    if [ "$opt" = true ]; then echo inhibit; else echo open; fi
}

# prepare_sandbox_network <dir> <instance>: after drain_code_runs, before `compose up`
prepare_sandbox_network() {
    local dir=$1 inst=$2 net="$2_sandbox" state want attached
    state=$(sandbox_net_state "$inst") || die "can't inspect the sandbox network $net"
    if release_wants_inhibit "$dir"; then want=inhibit; else want=open; fi
    if [ "$state" = absent ] || [ "$state" = "$want" ]; then
        ok "sandbox network $net: nothing to change ($state)"
        return 0
    fi
    compose_in "$dir" rm -f -s cap-gateway >/dev/null || die "could not remove the cap-gateway container"
    attached=$(dk network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net") || die "can't inspect the sandbox network $net"
    attached=$(printf '%s' "$attached" | tr -s ' ' | sed 's/^ //; s/ $//')
    # Only this install's services and runs belong on it; anything else is the operator's to move
    [ -z "$attached" ] || die "containers are still on $net: $attached. Disconnect them (docker network disconnect $net <name>), then run bash $dir/install/sandbox-network.sh --dir $dir"
    dk network rm "$net" >/dev/null || die "could not remove the sandbox network $net"
    ok "sandbox network $net removed; it is created again with this release's settings ($want)"
}
