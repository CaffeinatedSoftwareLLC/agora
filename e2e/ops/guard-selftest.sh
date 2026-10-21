#!/usr/bin/env bash
# Negative checks for the e2e/ops guards. Each case must be REFUSED.
#   e2e/ops/guard-selftest.sh
#
# Touches nothing on the daemon: the compose cases only render config (and read
# `docker ps`). The exact live name `agora_pgdata` is only ever given to ops_validate,
# which never starts or removes anything. The ops_up / ops_down refusal cases use
# names that do not exist on the daemon (checked first), so even a guard that failed
# open could not reach a real live or e2e resource.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ST="$(state_path "$OPS_STATE/selftest")"
rm -rf "$ST"; ( umask 077; mkdir -p "$ST" )
pass=0; fail=0
refused() {  # refused <name> <expected message regex> <command...>
  local name="$1" want="$2" out rc=0; shift 2
  out=$( ( "$@" ) 2>&1 ) || rc=$?
  if [ "$rc" != 0 ] && echo "$out" | grep -qE "$want"; then
    echo "PASS refused: $name -> $(echo "$out" | grep -E "$want" | head -1)"; pass=$((pass + 1))
  else
    echo "FAIL not refused: $name (exit $rc) $out"; fail=$((fail + 1))
  fi
}
absent() { ! docker volume inspect "$1" >/dev/null 2>&1 && ! docker network inspect "$1" >/dev/null 2>&1; }

# ---- writable paths ----
got=$(OPS_ENV_FILE_OVERRIDE=/tmp/selftest-live.env OPS_STATE=/tmp OPS_STATE_REAL=/tmp \
  bash -c '. "$1/lib.sh"; ops_use agora-ops; echo "$OPS_ENV_FILE|$OPS_STATE_REAL"' _ "$OPS_DIR")
[ "$got" = "$OPS_STATE_REAL/agora-ops.env|$OPS_STATE_REAL" ] \
  && { echo "PASS ignored: inherited OPS_ENV_FILE_OVERRIDE / OPS_STATE -> ${got%%|*}"; pass=$((pass + 1)); } \
  || { echo "FAIL inherited override took effect: $got"; fail=$((fail + 1)); }
refused "state_path outside .state" "refusing path outside" state_path /tmp/selftest.env
refused "state_path with .. escape" "refusing path outside" state_path "$OPS_STATE/../../.env.prod"
OUTSIDE="$(mktemp -d /tmp/ops-selftest.XXXXXX)"
ln -s "$OUTSIDE" "$ST/escape"
refused "state_path through a symlink out of .state" "refusing path outside" state_path "$ST/escape/agora-ops.env"
refused "ops_gen_env through a symlink" "refusing path outside" ops_gen_env "$ST/escape/x.env"
refused "env_set outside .state" "refusing path outside" env_set "$OUTSIDE/x.env" K V
[ -z "$(ls -A "$OUTSIDE")" ] && { echo "PASS nothing was written outside .state"; pass=$((pass + 1)); } \
  || { echo "FAIL files written to $OUTSIDE"; fail=$((fail + 1)); }
# opsapi.py: the root is <its own dir>/.state, never the caller's. Nothing below reaches
# the network: every case is refused while the arguments are checked.
OPSAPI=(python3 -I "$OPS_DIR/opsapi.py")
TRACKED="$OPS_REPO/ops-selftest-tracked.json"   # would be a tracked path in the repo
refused "opsapi --manifest outside .state" "refusing --manifest" \
  "${OPSAPI[@]}" verify --base http://127.0.0.1:3300 --env "$ST/x.env" --manifest "$OUTSIDE/m.json"
refused "opsapi --report through a symlink" "refusing --report" \
  "${OPSAPI[@]}" verify --base http://127.0.0.1:3300 --env "$ST/x.env" --manifest "$ST/m.json" --report "$ST/escape/r.json"
refused "opsapi against the live API" "refusing base URL" \
  "${OPSAPI[@]}" verify --base http://127.0.0.1:3000 --env "$ST/x.env" --manifest "$ST/m.json"
refused "opsapi seed --state <repo> --manifest <repo>/tracked.json" "unrecognized arguments: --state" \
  "${OPSAPI[@]}" seed --state "$OPS_REPO" --base http://127.0.0.1:3300 --env "$ST/x.env" --manifest "$TRACKED"
refused "opsapi seed --manifest <repo>/tracked.json" "refusing --manifest" \
  "${OPSAPI[@]}" seed --base http://127.0.0.1:3300 --env "$ST/x.env" --manifest "$TRACKED"
[ ! -e "$TRACKED" ] && { echo "PASS nothing was written to the repo"; pass=$((pass + 1)); } \
  || { echo "FAIL $TRACKED was written"; fail=$((fail + 1)); }
# A copy of opsapi.py next to a .state symlink (pointing at the real .state) is refused
cp "$OPS_DIR/opsapi.py" "$OUTSIDE/opsapi.py"
ln -s "$OPS_STATE_REAL" "$OUTSIDE/.state"
refused "opsapi with a symlinked .state" "refusing state directory .*: missing or a symlink" \
  python3 -I "$OUTSIDE/opsapi.py" verify --base http://127.0.0.1:3300 --env "$OUTSIDE/.state/x.env" --manifest "$OUTSIDE/.state/m.json"
rm -f "$OUTSIDE/opsapi.py" "$OUTSIDE/.state"
# verify.sh forwards nothing but --no-write (refused before it contacts any API)
refused "verify.sh with a trailing --report=" "unknown argument '--report=" \
  bash "$OPS_DIR/verify.sh" agora-ops "$ST/m.json" --report="$OUTSIDE/r.json"
refused "verify.sh with a trailing --state=" "unknown argument '--state=" \
  bash "$OPS_DIR/verify.sh" agora-ops "$ST/m.json" --state="$OPS_REPO"
refused "verify.sh with a trailing --report <path>" "usage: verify.sh" \
  bash "$OPS_DIR/verify.sh" agora-ops "$ST/m.json" --report "$OUTSIDE/r.json"
refused "verify.sh with --no-write plus more" "usage: verify.sh" \
  bash "$OPS_DIR/verify.sh" agora-ops "$ST/m.json" --no-write --report "$OUTSIDE/r.json"
[ -z "$(ls -A "$OUTSIDE")" ] && { echo "PASS nothing was written outside .state (opsapi/verify cases)"; pass=$((pass + 1)); } \
  || { echo "FAIL files written to $OUTSIDE"; fail=$((fail + 1)); }
rm -f "$ST/escape"; rmdir "$OUTSIDE"
refused "a project that is not ops" "refusing project" ops_use agora-e2e

# ---- compose overrides (throwaway files in .state/selftest) ----
ops_use agora-ops
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=agora-ops)" ] || die "agora-ops must be empty for the self-test"
DUMMY="$ST/agora-ops.env"
printf 'DB_PASSWORD=x\nJWT_SECRET=x\nAGORA_ENCRYPTION_KEY=x\nAGORA_SETUP_TOKEN=x\n' > "$DUMMY"
OPS_ENV_FILE="$DUMMY"
ops_validate && { echo "PASS baseline: the plain ops compose file validates"; pass=$((pass + 1)); }

override() {  # override <name> <yaml>: run the following check with this extra compose file
  printf '%s\n' "$2" > "$ST/$1.yml"
  OPS_COMPOSE_ARGS=(-f "$OPS_COMPOSE_FILE" -f "$ST/$1.yml")
}
reset() { OPS_COMPOSE_ARGS=(-f "$OPS_COMPOSE_FILE"); }

override live-pgdata $'volumes:\n  ops-pgdata:\n    name: agora_pgdata'
refused "ops_validate: volume renamed to agora_pgdata" "volume ops-pgdata: resolved name 'agora_pgdata'" ops_validate
override live-pgdata-v2 $'volumes:\n  ops-pgdata:\n    name: agora_pgdata_v2'
refused "ops_validate: volume agora_pgdata_v2" "agora_pgdata_v2" ops_validate
override data2 $'services:\n  api:\n    volumes:\n      - extra:/x\nvolumes:\n  extra:\n    name: agora_data2'
refused "ops_validate: extra volume agora_data2" "agora_data2" ops_validate
override external $'volumes:\n  ops-files:\n    external: true\n    name: agora-ops_ops-files'
refused "ops_validate: external volume" "external volumes are not allowed" ops_validate
override bind $'services:\n  api:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock'
refused "ops_validate: bind mount" "is not a project volume" ops_validate
# A safely named volume that binds a host directory through driver_opts (render only)
override indirect-bind $'volumes:\n  ops-files:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /var/lib/docker/volumes/agora_files-data/_data'
refused "ops_validate: volume with driver_opts bind to a live volume's directory" "volume ops-files: driver_opts are not allowed" ops_validate
override vol-driver $'volumes:\n  ops-pgdata:\n    driver: rexray/ebs'
refused "ops_validate: non-default volume driver" "volume ops-pgdata: driver 'rexray/ebs' is not allowed" ops_validate
override net-opts $'networks:\n  ops:\n    driver_opts:\n      com.docker.network.bridge.name: docker0'
refused "ops_validate: network with driver_opts" "network ops: driver_opts are not allowed" ops_validate
override net-driver $'networks:\n  ops:\n    driver: macvlan'
refused "ops_validate: non-bridge network driver" "network ops: driver 'macvlan' is not allowed" ops_validate
override net-external $'networks:\n  ops:\n    external: true\n    name: agora-ops_net'
refused "ops_validate: external network" "network ops: external networks are not allowed" ops_validate
override live-net $'networks:\n  ops:\n    name: agora_default'
refused "ops_validate: network renamed to agora_default" "network ops: resolved name 'agora_default'" ops_validate
override second-net $'services:\n  api:\n    networks: [ops, other]\nnetworks:\n  other:\n    name: agora-e2e_net'
refused "ops_validate: second network agora-e2e_net" "agora-e2e_net" ops_validate
override port $'services:\n  web:\n    ports:\n      - "127.0.0.1:3000:80"'
refused "ops_validate: web also publishes 3000" "port 3000 belongs to the live or e2e stack" ops_validate
override port-any $'services:\n  redis:\n    ports:\n      - "6390:6379"'
refused "ops_validate: redis published on all interfaces" "not bound to 127.0.0.1" ops_validate
override runner $'services:\n  runner:\n    image: agora-ops-server:new'
refused "ops_validate: forbidden service runner" "service 'runner' is not allowed" ops_validate
override image $'services:\n  api:\n    image: agora-e2e-server:e2e'
refused "ops_validate: api image retagged to agora-e2e" "image 'agora-e2e-server:e2e' is not allowed" ops_validate

# up/down refusals: names that do not exist on the daemon
NX_VOL=agora_pgdata_selftest_nx
NX_NET=agora-e2e_selftest_nx
absent "$NX_VOL" && absent "$NX_NET" || die "self-test names unexpectedly exist on the daemon"
override down-vol "volumes:
  ops-pgdata:
    name: $NX_VOL"
refused "ops_down with an agora_* volume" "compose guard refused agora-ops" ops_down
refused "ops_up with an agora_* volume" "compose guard refused agora-ops" ops_up postgres
override down-net "networks:
  ops:
    name: $NX_NET"
refused "ops_down with an agora-e2e network" "compose guard refused agora-ops" ops_down
reset
absent "$NX_VOL" && absent "$NX_NET" && [ -z "$(docker ps -aq --filter label=com.docker.compose.project=agora-ops)" ] \
  && { echo "PASS nothing was created or removed by the refused up/down"; pass=$((pass + 1)); } \
  || { echo "FAIL the daemon changed during the self-test"; fail=$((fail + 1)); }

rm -rf "$ST"
echo "guard self-test: $pass passed, $fail failed"
[ "$fail" = 0 ]
