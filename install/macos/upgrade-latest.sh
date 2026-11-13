#!/bin/bash
# Upgrade Agora on a Mac to the latest release, from any release (docs/macos.md). One file with
# no checkout behind it: published on every release as upgrade-macos.sh.
#
#   curl -fsSLO https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-latest/upgrade-macos.sh
#   bash upgrade-macos.sh [--vm NAME] [--passphrase-file FILE] [--ref TAG] [--yes]
#
# For an install whose own install/macos/agora-vm.sh is too old to do this in one command (from
# before `agora-vm.sh upgrade` downloaded the release itself). It:
#   1. downloads agora.tar.gz and its SHA-256 from the release and refuses a mismatch;
#   2. unpacks it in a temporary folder;
#   3. runs that release's `install/macos/agora-vm.sh upgrade --source <that folder>`, which copies
#      it into the VM and runs its install/upgrade.sh there: a backup first (it asks for a
#      passphrase unless you pass --passphrase-file), then the new release, keeping the compose
#      override the install runs with (Tailscale access), then checks;
#   4. keeps the new release's Mac commands in ~/.agora/macos/release and removes the temporary
#      folder. On failure it prints the command that goes back.
# Written for /bin/bash 3.2 (macOS's own).
set -euo pipefail

VM=agora PASS_FILE='' REF=latest YES=0
while [ $# -gt 0 ]; do
    case "$1" in
        --vm) VM=${2:?--vm needs a name}; shift ;;
        --passphrase-file) PASS_FILE=${2:?--passphrase-file needs a file}; shift ;;
        --ref) REF=${2:?--ref needs a release tag}; shift ;;
        --yes) YES=1 ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) echo "upgrade-macos.sh: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
fail() { echo "upgrade-macos.sh: $1" >&2; exit 1; }
printf '%s' "$VM" | grep -Eq '^[a-z][a-z0-9-]{0,30}$' || fail "--vm must be lowercase letters, digits and dashes"
printf '%s' "$REF" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$' || fail "--ref must be a release tag such as v0.5.0"
[ -z "$PASS_FILE" ] || [ -r "$PASS_FILE" ] || fail "can't read $PASS_FILE"
command -v limactl >/dev/null 2>&1 || fail "limactl not found: this upgrades an Agora that runs in a Lima VM on this Mac"
status=$(limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | awk -v n="$VM" '$1 == n {print $2; exit}' || true)
[ -n "$status" ] || fail "there is no Lima VM named $VM (limactl list)"
[ "$status" = Running ] || fail "the VM $VM is $status; start it first (limactl start $VM)"

base=${AGORA_RELEASE_BASE:-https://github.com/CaffeinatedSoftwareLLC/agora/releases}
if [ "$REF" = latest ]; then url="$base/download/agora-latest"; else url="$base/download/$REF"; fi
state_dir=${AGORA_MAC_STATE_DIR:-$HOME/.agora/macos}

cat <<EOF
This upgrades the Agora install in the Lima VM "$VM" to the $([ "$REF" = latest ] && echo 'latest release' || echo "release $REF"):

  1. download the release from $url and check its SHA-256
  2. back up the running install inside the VM (encrypted; you choose or give its passphrase)
  3. replace the release, keeping your settings, data, boxes and Tailscale access
  4. start it and check that it answers

Agora and its agents stop for a few minutes while this runs.
EOF
if [ "$YES" != 1 ]; then
    [ -t 0 ] || fail "no terminal to ask in; run it in Terminal, or pass --yes"
    printf 'Go ahead? [y/N] '
    read -r answer || answer=''
    case "$answer" in [Yy]|[Yy][Ee][Ss]) ;; *) echo 'Nothing was changed.'; exit 0 ;; esac
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Agora ($REF)"
proto=()
case "$url" in https://*) proto=(--proto '=https') ;; esac
curl -fsSL ${proto[@]+"${proto[@]}"} -o "$tmp/agora.tar.gz" "$url/agora.tar.gz" || fail "can't download $url/agora.tar.gz; nothing was changed"
curl -fsSL ${proto[@]+"${proto[@]}"} -o "$tmp/agora.tar.gz.sha256" "$url/agora.tar.gz.sha256" || fail "can't download the release's SHA-256; nothing was changed"
if command -v shasum >/dev/null 2>&1; then (cd "$tmp" && shasum -a 256 -c agora.tar.gz.sha256 >/dev/null 2>&1) || fail "the download doesn't match its SHA-256; nothing was changed"
else (cd "$tmp" && sha256sum -c agora.tar.gz.sha256 >/dev/null 2>&1) || fail "the download doesn't match its SHA-256; nothing was changed"; fi
mkdir "$tmp/release"
tar -xzf "$tmp/agora.tar.gz" -C "$tmp/release" --strip-components=1 || fail "can't unpack the release; nothing was changed"
vm_tool="$tmp/release/install/macos/agora-vm.sh"
[ -f "$vm_tool" ] || fail "the release has no install/macos/agora-vm.sh; nothing was changed"
version=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$tmp/release/package.json" 2>/dev/null | head -n 1)
echo "Agora ${version:-?}, checked against its SHA-256"

# Where the install is in the VM, for the way back (the release's own record of it)
install_dir=$(/bin/bash "$vm_tool" status --vm "$VM" 2>/dev/null | sed -n 's/^Install: *//p' | head -n 1 || true)

args=(upgrade --source "$tmp/release" --vm "$VM")
[ -z "$PASS_FILE" ] || args+=(--passphrase-file "$PASS_FILE")
rc=0
/bin/bash "$vm_tool" "${args[@]}" || rc=$?
if [ "$rc" != 0 ]; then
    cat >&2 <<EOF

The upgrade did not finish (exit $rc). The lines above say at which step.
If it failed before "Moving the old release aside", nothing was replaced and Agora runs as before
(if it isn't running: limactl shell --workdir ${install_dir:-<the install folder>} $VM bash install/doctor.sh).
If it failed after that, go back to the release and the data you had with:

  limactl shell --workdir ${install_dir:-<the install folder>} $VM bash install/upgrade.sh --rollback

It asks for the passphrase of the backup this upgrade took.
EOF
    exit "$rc"
fi

# Keep the new release's Mac commands where a stand-alone install has them
rel="$state_dir/release"
mkdir -p "$state_dir"; chmod 700 "$state_dir"
rm -rf "$rel.new"
if mv "$tmp/release" "$rel.new" && rm -rf "$rel" && mv "$rel.new" "$rel"; then
    cat <<EOF

Done. From now on one command upgrades this install:
  bash $rel/install/macos/agora-vm.sh upgrade
Tailscale access:  bash $rel/install/macos/agora-vm.sh tailnet status
To go back to the release you had:
  limactl shell --workdir ${install_dir:-<the install folder>} $VM bash install/upgrade.sh --rollback
EOF
else
    echo "Done. (Couldn't keep the release's Mac commands in $rel; the upgrade itself is finished.)"
fi
