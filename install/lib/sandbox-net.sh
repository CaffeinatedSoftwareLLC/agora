# Code runs and the sandbox network during an upgrade or rollback (sandbox-isolation-spec §6.1).
# Sourced after common.sh by upgrade.sh and sandbox-network.sh.
#
# The sandbox network (<instance>_sandbox) gained com.docker.network.bridge.inhibit_ipv4, which
# keeps the host off it. Docker can't change a network's options in place, and a network with
# containers on it can't be removed, so the upgrade:
#   0. before anything changes, refuses if the network must be recreated and a container that
#      isn't this install's is on it (check_sandbox_network);
#   1. drains code runs: stops the runner, which takes no new runs and finishes the ones in
#      progress (runs submitted meanwhile wait in the queue), then removes this install's run
#      containers that are somehow still there;
#   2. removes cap-gateway's container (the only service on the network; stateless);
#   3. removes the network, if its options differ from what the release in the folder declares.
# `compose up` then creates the network from the release's compose file and starts the runner
# and cap-gateway on it; verify_sandbox_network checks the result. A rollback runs the same
# steps with the old release in the folder, so the network goes back to what that release declares.

SANDBOX_INHIBIT_OPT=com.docker.network.bridge.inhibit_ipv4
# The longest code run is 10 minutes (src/runtime/limits.ts), plus the runner's own wrap-up.
# The same as the runner's stop_grace_period in docker-compose.prod.yml
RUNNER_DRAIN_SECONDS=${RUNNER_DRAIN_SECONDS:-660}

# run_containers <instance>: this install's code-run containers, running or not: those labelled
# agora.instance=<instance>, and unlabelled ones (from before the label) only when they sit on
# this install's sandbox network, so an older install's unlabelled runs are never taken for ours.
run_containers() {
    local out
    out=$(dk ps -a --filter label=agora.managed=runtime --format '{{.Names}}|{{.Label "agora.instance"}}|{{.Networks}}') || return 1
    printf '%s\n' "$out" | awk -F'|' -v want="$1" -v net="$1_sandbox" '
        NF >= 1 && $1 != "" {
            if ($2 == want) { print $1; next }
            if ($2 == "") { n = split($3, nets, ","); for (i = 1; i <= n; i++) if (nets[i] == net) { print $1; next } }
        }'
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

# release_wants_inhibit <dir>: whether the release in <dir> sets the option (a YAML key set to true,
# not a mention in a comment)
release_wants_inhibit() {
    grep -Eq "^[[:space:]]+${SANDBOX_INHIBIT_OPT//./\\.}:[[:space:]]*[\"']?true[\"']?[[:space:]]*(#.*)?$" "$1/$COMPOSE_FILE_NAME"
}

# sandbox_net_state <instance>: absent, inhibit or open. Fails (rather than say absent) when Docker can't be asked.
sandbox_net_state() {
    local net="$1_sandbox" names opt
    names=$(dk network ls --filter "name=^${net}\$" --format '{{.Name}}') || return 1
    printf '%s\n' "$names" | grep -qx "$net" || { echo absent; return 0; }
    opt=$(dk network inspect -f "{{index .Options \"$SANDBOX_INHIBIT_OPT\"}}" "$net") || return 1
    if [ "$opt" = true ]; then echo inhibit; else echo open; fi
}

# wanted_state <release dir>
wanted_state() { if release_wants_inhibit "$1"; then echo inhibit; else echo open; fi; }

# sandbox_net_strangers <instance>: containers on the network that are neither this install's
# cap-gateway nor its code runs
sandbox_net_strangers() {
    local net="$1_sandbox" attached ours c out=''
    attached=$(dk network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net") || return 1
    ours=$(run_containers "$1") || return 1
    for c in $attached; do
        printf '%s' "$c" | grep -Eqx "$1-cap-gateway-[0-9]+" && continue
        printf '%s\n' "$ours" | grep -qx "$c" && continue
        out="$out $c"
    done
    printf '%s' "${out# }"
}

# check_sandbox_network <release dir> <instance>: before anything changes. Refuses when the
# network will have to be recreated and something that isn't this install's is on it.
check_sandbox_network() {
    local rel=$1 inst=$2 state want strangers
    state=$(sandbox_net_state "$inst") || die "can't inspect the sandbox network ${inst}_sandbox"
    want=$(wanted_state "$rel")
    [ "$state" = absent ] || [ "$state" = "$want" ] && return 0
    strangers=$(sandbox_net_strangers "$inst") || die "can't inspect the sandbox network ${inst}_sandbox"
    [ -z "$strangers" ] || die "the sandbox network ${inst}_sandbox has to be recreated, but containers that aren't this install's are on it: $strangers. Disconnect them (docker network disconnect ${inst}_sandbox <name>) and run this again; nothing has been changed"
}

# prepare_sandbox_network <dir> <instance>: after drain_code_runs, before `compose up`
prepare_sandbox_network() {
    local dir=$1 inst=$2 net="$2_sandbox" state want strangers
    state=$(sandbox_net_state "$inst") || die "can't inspect the sandbox network $net"
    want=$(wanted_state "$dir")
    if [ "$state" = absent ] || [ "$state" = "$want" ]; then
        ok "sandbox network $net: nothing to change ($state)"
        return 0
    fi
    # Checked again: something may have joined since check_sandbox_network
    strangers=$(sandbox_net_strangers "$inst") || die "can't inspect the sandbox network $net"
    [ -z "$strangers" ] || die "containers that aren't this install's are on $net: $strangers. The runner is stopped. Disconnect them (docker network disconnect $net <name>), then run: bash $dir/install/sandbox-network.sh --dir $dir"
    compose_in "$dir" rm -f -s cap-gateway >/dev/null || die "could not remove the cap-gateway container"
    dk network rm "$net" >/dev/null || die "could not remove the sandbox network $net (the runner and cap-gateway are stopped; see docker network inspect $net, then run: bash $dir/install/sandbox-network.sh --dir $dir)"
    ok "sandbox network $net removed; it is created again with this release's settings ($want)"
}

# verify_sandbox_network <dir> <instance>: after `compose up`. The network must be what the release
# declares, or the runner refuses to start (and runs wait in the queue for nothing).
verify_sandbox_network() {
    local dir=$1 inst=$2 state want running i
    state=$(sandbox_net_state "$inst") || die "can't inspect the sandbox network ${inst}_sandbox"
    want=$(wanted_state "$dir")
    [ "$state" = "$want" ] || die "the sandbox network ${inst}_sandbox is '$state', but this release declares '$want'; code runs won't start. Run: bash $dir/install/sandbox-network.sh --dir $dir"
    for i in 1 2 3 4 5 6 7 8 9 10; do
        running=$(compose_in "$dir" ps --status running --services 2>/dev/null) || running=''
        printf '%s\n' "$running" | grep -qx runner && { ok "sandbox network ${inst}_sandbox ($state), runner running"; return 0; }
        [ "$i" = 10 ] || sleep 3
    done
    warn "the runner isn't running: code runs will wait in the queue. See: $(compose_cmd_text "$dir" 'logs runner')"
}
