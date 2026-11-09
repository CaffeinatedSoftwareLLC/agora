#!/bin/bash
# shellcheck disable=SC2034  # variables read inside check_true's eval
# The macOS installer's decisions (install/macos), with the Mac and Lima replaced by stubs:
# uname, sw_vers, sysctl, df, pmset, lsof, curl, brew, limactl, launchctl, sudo and open are
# fakes on PATH that log their calls. "Guest" commands run on this machine. No VM, no Homebrew,
# nothing outside a temp folder is changed.
#
#   bash test/install/macos.test.sh        (CI: also /bin/bash on macOS, which is bash 3.2)
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
n=0 failed=0
check() { # check <name> <expected> <actual>
    n=$((n + 1))
    if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi
}
check_true() { n=$((n + 1)); if eval "$2"; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s (%s)\n' "$1" "$2"; failed=$((failed + 1)); fi; }

BIN="$T/bin"; mkdir -p "$BIN"
CALLS="$T/calls"
DIGEST=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
stub() { # stub <name> <body>
    printf '#!/bin/bash\nprintf "%%s %%s\\n" %s "$*" >> "%s"\n%s\n' "$1" "$CALLS" "$2" > "$BIN/$1"
    chmod +x "$BIN/$1"
}
REAL_UNAME=$(command -v uname) REAL_ID=$(command -v id) REAL_TAR=$(command -v tar)
stub uname "case \"\${1:-}\" in -s) echo \"\${FAKE_UNAME_S:-Darwin}\" ;; -m) echo \"\${FAKE_ARCH:-arm64}\" ;; *) exec $REAL_UNAME \"\$@\" ;; esac"
stub id "if [ \"\${1:-}\" = -u ] && [ \"\${FAKE_ROOT:-0}\" = 1 ]; then echo 0; else exec $REAL_ID \"\$@\"; fi"
stub sw_vers 'echo "${FAKE_MACOS:-15.1}"'
stub sysctl 'case "$2" in hw.memsize) echo "${FAKE_MEM_BYTES:-34359738368}" ;; hw.ncpu) echo "${FAKE_CPUS:-10}" ;; sysctl.proc_translated) echo "${FAKE_ROSETTA:-0}" ;; esac'
stub df 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/disk3 999999999 1 %s 1%% /\n" "${FAKE_FREE_KB:-209715200}"'
stub pmset 'printf " standby 1\n sleep %s\n" "${FAKE_SLEEP:-0}"'
# nc -z -w 1 127.0.0.1 <port>: "connects" (exit 0) to a busy port
stub nc 'p=$(eval echo "\${$#}"); for b in ${FAKE_BUSY_PORTS:-}; do [ "$b" = "$p" ] && exit 0; done; exit 1'
stub curl "case \"\$*\" in *SHA256SUMS*) printf '%s *ubuntu-24.04-server-cloudimg-amd64.img\n%s *ubuntu-24.04-server-cloudimg-arm64.img\n' ffff$DIGEST $DIGEST ;; *health*) echo '{\"status\":\"ok\"}' ;; *) exit 22 ;; esac"
stub open ':'
stub launchctl 'case "$1" in bootstrap) [ "${FAKE_NO_GUI:-0}" = 1 ] && [ "${2#gui/}" != "$2" ] && exit 5; exit 0 ;; *) exit 0 ;; esac'
# sudo: runs the command as this user; `install -o root -g wheel` without the owner
stub sudo 'if [ "$1" = -n ]; then shift; [ "${FAKE_SUDO:-0}" = 1 ] || exit 1; fi; if [ "$1" = install ]; then shift; a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) a+=("$1") ;; esac; shift; done; exec install "${a[@]}"; fi; exec "$@"'
stub brew "case \"\$1\" in install) cp \"$T/limactl.impl\" \"$BIN/limactl\"; chmod +x \"$BIN/limactl\" ;; list) [ -x \"$BIN/limactl\" ] ;; upgrade) echo 2.3.0 > \"$T/lima/version\" ;; esac"
rm -f "$BIN/brew.keep"

# limactl: instances in $T/lima/instances ("name status"); shell runs the command here
mkdir -p "$T/lima"
cat > "$T/limactl.impl" <<EOF
#!/bin/bash
printf 'limactl %s\n' "\$*" >> "$CALLS"
L="$T/lima"
case "\$1" in
    --version) echo "limactl version \$(cat "\$L/version" 2>/dev/null || echo 2.3.0)" ;;
    list) [ -f "\$L/instances" ] && awk '{print \$1, \$2}' "\$L/instances" ;;
    create) n=\$(printf '%s\n' "\$@" | sed -n '/^--name$/{n;p;}'); f=\$(eval echo "\\\${\$#}"); cp "\$f" "\$L/\$n.yaml"; echo "\$n Stopped" >> "\$L/instances" ;;
    start) n=\$(eval echo "\\\${\$#}"); sed -i.bak "s/^\$n .*/\$n Running/" "\$L/instances" ;;
    stop) sed -i.bak "s/^\$2 .*/\$2 Stopped/" "\$L/instances" ;;
    delete) sed -i.bak "/^\$3 /d" "\$L/instances" ;;
    copy) s=\${2#*:}; d=\${3#*:}; [ "\$2" = "\${2#*:}" ] || s=\${2#*:}; cp "\$s" "\$d" ;;
    shell)
        shift; while [ "\${1#--}" != "\$1" ]; do [ "\$1" = --workdir ] && shift; shift; done; shift
        case "\$*" in
            *os-release*) printf '%s' "\${FAKE_GUEST:-ubuntu 24.04 aarch64}"; exit 0 ;;
            *working_dir*) echo "$T/guest/agora"; exit 0 ;;
            *install/linux/install.sh*)
                printf '%s\n' "\$@" > "$T/linux-args"
                pw=\$(printf '%s\n' "\$@" | sed -n '/^--admin-password-file$/{n;p;}')
                [ -z "\$pw" ] || cat "\$pw" > "$T/linux-saw-password"
                mkdir -p "\$HOME/.agora"; echo "https://localhost:\$(printf '%s\n' "\$@" | sed -n '/^--https-port$/{n;p;}')" > "\$HOME/.agora/last-install-url"
                exit "\${FAKE_LINUX_EXIT:-0}" ;;
            *install/backup.sh*) out=\$(printf '%s\n' "\$@" | sed -n '/^--out$/{n;p;}'); mkdir -p "\$(dirname "\$out")"; echo bundle > "\$out"; exit 0 ;;
            *install/restore.sh*|*install/upgrade.sh*|*install/uninstall.sh*|*install/doctor.sh*) printf '%s\n' "\$@" > "$T/guest-script-args"; exit 0 ;;
        esac
        if [ "\$1" = tar ]; then shift; [ "\$1" = --warning=no-unknown-keyword ] && shift; exec $REAL_TAR "\$@"; fi
        exec "\$@" ;;
esac
EOF
chmod +x "$T/limactl.impl"

reset() { # a fresh Mac: no Lima, no VM, empty home
    rm -rf "${T:?}/home" "$T/lima" "$T/daemons" "$CALLS" "$T/linux-args" "$T/linux-saw-password" "$T/guest-script-args" "$BIN/limactl"
    rm -rf "$T/guest"; mkdir -p "$T/home" "$T/lima" "$T/daemons" "$T/guest/agora"; : > "$CALLS"
    echo AGORA_INSTANCE=agora > "$T/guest/agora/.env.prod"
}
with_lima() { cp "$T/limactl.impl" "$BIN/limactl"; chmod +x "$BIN/limactl"; }
run() { # run <script> <args...>: exit code in RC, output in $T/out
    set +e
    env -i PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$T/home" TERM=dumb AGORA_LAUNCH_DAEMON_DIR="$T/daemons" \
        ${FAKE_ENV[@]+"${FAKE_ENV[@]}"} /bin/bash "$@" < /dev/null > "$T/out" 2>&1
    RC=$?
    set -e
}
called() { grep -c "^$1" "$CALLS" 2>/dev/null || true; }
FAKE_ENV=()
I="$ROOT/install/macos/install.sh"
printf 'hunter2hunter2\n' > "$T/pw"

# ─── Pure decisions ───
. "$ROOT/install/lib/common.sh"
. "$ROOT/install/macos/lib/macos.sh"
{
    check 'version_ge 2.3.0 >= 2.0.0' 0 "$(version_ge 2.3.0 2.0.0; echo $?)"
    check 'version_ge 1.10 >= 1.9' 0 "$(version_ge 1.10 1.9; echo $?)"
    check 'version_ge 13.4 < 13.5' 1 "$(version_ge 13.4 13.5; echo $?)"
    check 'default CPUs: half of 10' 5 "$(default_vm_cpus 10)"
    check 'default CPUs: at least 2' 2 "$(default_vm_cpus 2)"
    check 'default CPUs: at most 8' 8 "$(default_vm_cpus 24)"
    check 'default memory on a 16 GB Mac: 8 GiB' 8 "$(default_vm_memory 16)"
    check 'default memory on an 8 GB Mac: 6 GiB' 6 "$(default_vm_memory 8)"
    check 'a sane size passes' '' "$(check_vm_size 4 8 100 10 16)"
    check 'an 8 GB Mac can give the VM its 6 GiB' '' "$(check_vm_size 2 6 100 8 8)"
    check 'a 32 GB Mac can give the VM 24 GiB' '' "$(check_vm_size 4 24 100 10 32)"
    check_true 'memory below 6 GiB is refused' '[ -n "$(check_vm_size 4 4 100 10 16)" ]'
    check_true 'memory that leaves macOS under 2 GB is refused' '[ -n "$(check_vm_size 4 15 100 10 16)" ]'
    check_true 'more CPUs than the Mac has is refused' '[ -n "$(check_vm_size 12 8 100 10 16)" ]'
    check_true 'a non-number size is refused' '[ -n "$(check_vm_size 4 8GiB 100 10 16)" ]'
    check_true 'a port below 1024 is refused' '[ -n "$(check_port 443)" ]'
    check 'port 8443 is fine' '' "$(check_port 8443)"
    tpl=$(lima_template 4 8 100 "$DIGEST" 8000 8443 3000)
    check_true 'template: vz, aarch64, the given size' 'printf "%s" "$tpl" | grep -q "^vmType: vz" && printf "%s" "$tpl" | grep -q "^cpus: 4" && printf "%s" "$tpl" | grep -q "^memory: \"8GiB\""'
    check_true 'template: no mounts, no containerd, no agent forwarding' 'printf "%s" "$tpl" | grep -q "^mounts: \[\]" && printf "%s" "$tpl" | grep -q "system: false" && printf "%s" "$tpl" | grep -q "forwardAgent: false"'
    check 'template: three forwards to 127.0.0.1, everything else ignored' '3 1' "$(printf '%s\n' "$tpl" | grep -c 'hostIP: "127.0.0.1"') $(printf '%s\n' "$tpl" | grep -c 'ignore: true')"
    check_true 'template: the image pinned by digest' 'printf "%s" "$tpl" | grep -q "digest: \"sha256:$DIGEST\""'
    plist=$(keepalive_plist agora daemon eryk '/opt/homebrew/bin:/usr/bin:/bin')
    check_true 'daemon plist: UserName, interval, abandons its process group' 'printf "%s" "$plist" | grep -q "<key>UserName</key><string>eryk</string>" && printf "%s" "$plist" | grep -q "<integer>300</integer>" && printf "%s" "$plist" | grep -q "<key>AbandonProcessGroup</key><true/>"'
    check_true 'agent plist has no UserName' '! keepalive_plist agora agent eryk /usr/bin | grep -q UserName'
    if command -v plutil >/dev/null 2>&1; then
        printf '%s' "$plist" > "$T/p.plist"; check 'plutil -lint accepts the plist' 0 "$(plutil -lint "$T/p.plist" >/dev/null; echo $?)"
    elif command -v python3 >/dev/null 2>&1; then
        check 'the plist parses (python plistlib)' agora "$(printf '%s' "$plist" | python3 -c 'import plistlib,sys; print(plistlib.loads(sys.stdin.buffer.read())["ProgramArguments"][2])')"
    fi
    check 'xml_escape' 'a&amp;b&lt;c' "$(printf 'a&b<c' | xml_escape)"
    # The release copied into the VM: what setup-env.js needs stays, secrets and junk don't
    mkdir -p "$T/src/.git" "$T/src/node_modules/x" "$T/src/agora-host/node_modules/y" "$T/src/docs"
    for f in .env.prod.example .env.prod .env.prod.before-restore .env docker-compose.prod.yml docs/a.md .git/HEAD node_modules/x/i agora-host/node_modules/y/i; do echo x > "$T/src/$f"; done
    source_tarball "$T/src" "$T/src.tgz"
    list=$(tar -tzf "$T/src.tgz" | sed 's#^\./##' | sort | tr '\n' ' ')
    check_true 'tarball keeps .env.prod.example (setup-env.js reads it)' 'case " $list" in *" .env.prod.example "*) true ;; *) false ;; esac'
    check_true 'tarball has no .env, .env.prod, its restore backup, .git or node_modules' '! printf "%s" " $list" | grep -Eq " (\.env|\.env\.prod|\.env\.prod\.before-restore) |\.git/|node_modules"'
    rm -rf "$T/src" "$T/src.tgz"
}

# ─── preflight refusals (before anything is installed) ───
reset; FAKE_ENV=(FAKE_ARCH=x86_64); run "$I" --non-interactive --allow-lima-install
check 'Intel Mac: refused' 1 "$RC"; check_true '... saying Apple Silicon only' 'grep -q "Apple Silicon only" "$T/out"'
check 'Intel Mac: brew never ran' 0 "$(called brew)"
reset; FAKE_ENV=(FAKE_ROSETTA=1); run "$I" --non-interactive
check_true 'a Rosetta shell: refused, says so' '[ "$RC" = 1 ] && grep -q Rosetta "$T/out"'
reset; FAKE_ENV=(FAKE_MACOS=12.7); run "$I" --non-interactive
check_true 'macOS 12: refused' '[ "$RC" = 1 ] && grep -q "older than 13.5" "$T/out"'
reset; FAKE_ENV=(FAKE_MEM_BYTES=4294967296); run "$I" --non-interactive
check_true 'a 4 GB Mac: refused' '[ "$RC" = 1 ] && grep -q "4 GB of memory" "$T/out"'
reset; FAKE_ENV=(FAKE_ROOT=1); run "$I" --non-interactive
check_true 'as root: refused' '[ "$RC" = 1 ] && grep -q "as root" "$T/out"'
reset; FAKE_ENV=(); run "$I" --non-interactive --existing alongside
check_true '--existing alongside: refused (one install per VM)' '[ "$RC" = 1 ] && grep -q "one Agora install per VM" "$T/out"'
reset; run "$I" --non-interactive --https-port 443
check_true 'a port below 1024: refused' '[ "$RC" = 1 ] && grep -q "below 1024" "$T/out"'

# ─── Lima missing ───
reset; run "$I" --non-interactive
check 'no Lima, no consent: stops cleanly' 0 "$RC"
check 'no Lima, no consent: brew never ran' 0 "$(called brew)"
check_true '... and says how to do it' 'grep -q "brew install lima" "$T/out"'

# ─── A clean install ───
reset; FAKE_ENV=(FAKE_BUSY_PORTS=8443); run "$I" --non-interactive --allow-lima-install --agent claude --telemetry off --admin-password-file "$T/pw" --memory 8 --cpus 4
check 'clean install: exit 0' 0 "$RC"
[ "$RC" = 0 ] || sed 's/^/      | /' "$T/out"
check 'brew install lima ran once' 1 "$(grep -c '^brew install lima' "$CALLS")"
check 'the VM was created from the generated template' 1 "$(grep -c '^limactl create --tty=false --name agora .*/.agora/macos/agora.yaml' "$CALLS")"
check_true 'the template forwards the free ports (8443 busy: 8444)' 'grep -q "guestPort: 8444" "$T/lima/agora.yaml" && grep -q "guestPort: 8000" "$T/lima/agora.yaml" && grep -q "guestPort: 3000" "$T/lima/agora.yaml"'
check_true 'the template pins the arm64 digest from SHA256SUMS' 'grep -q "sha256:$DIGEST" "$T/lima/agora.yaml"'
args=$(tr '\n' ' ' < "$T/linux-args")
check_true 'Linux installer: --lima, the Mac ports, telemetry, non-interactive, the agent' 'case "$args" in *"--lima "*"--http-port 8000 --https-port 8444 --api-port 3000 --telemetry off --non-interactive"*"--agent claude"*) true ;; *) false ;; esac'
check 'Linux installer read the admin password from its copy in the VM' hunter2hunter2 "$(cat "$T/linux-saw-password" 2>/dev/null)"
check_true '... and that copy is gone afterwards' 'p=$(sed -n "/^--admin-password-file$/{n;p;}" "$T/linux-args"); [ -n "$p" ] && [ ! -e "$p" ]'
S="$T/home/.agora/macos/agora.conf"
check 'state: created, ports, installed, folder' "created=1 http_port=8000 https_port=8444 api_port=3000 installed=1 install_dir=$T/guest/agora" \
    "$(for k in created http_port https_port api_port installed install_dir; do printf '%s=%s ' "$k" "$(sed -n "s/^$k=//p" "$S")"; done | sed 's/ $//')"
check 'state: the URL the Linux installer wrote' 'https://localhost:8444' "$(sed -n 's/^url=//p' "$S")"
A="$T/home/Library/LaunchAgents/com.agora.vm.agora.plist"
check_true 'keep-alive: a LaunchAgent, loaded into the login session' '[ -f "$A" ] && grep -q "^launchctl bootstrap gui/$(id -u) $A" "$CALLS"'
check_true 'keep-alive: runs the copy in ~/.agora/macos' 'grep -q "$T/home/.agora/macos/keepalive.sh" "$A" && [ -x "$T/home/.agora/macos/keepalive.sh" ]'
check 'no sudo for a LaunchAgent' 0 "$(called sudo)"
check 'the VM is running' 'agora Running' "$(cat "$T/lima/instances")"

# ─── Run again: the VM is reused, nothing is created ───
: > "$CALLS"; rm -f "$T/linux-args"; FAKE_ENV=(); run "$I" --non-interactive --telemetry off
check_true 'second run without --existing: stops, the Linux installer never runs' '[ "$RC" = 0 ] && grep -q "Stopped; Agora in agora was not changed" "$T/out" && [ ! -f "$T/linux-args" ]'
: > "$CALLS"; run "$I" --non-interactive --telemetry off --existing upgrade
check 'second run --existing upgrade: exit 0' 0 "$RC"
check 'second run: no limactl create' 0 "$(grep -c '^limactl create' "$CALLS")"
check_true 'second run: the same ports, and --existing upgrade passed on' 'tr "
" " " < "$T/linux-args" | grep -q -- "--https-port 8444 .*--existing upgrade"'

# ─── A VM someone else made ───
reset; with_lima; echo 'agora Running' > "$T/lima/instances"; run "$I" --non-interactive --telemetry off
check_true 'a foreign VM named agora: refused, nothing created' '[ "$RC" = 1 ] && grep -q "didn.t create it" "$T/out" && [ "$(grep -c "^limactl create" "$CALLS")" = 0 ]'

# ─── The Linux installer fails ───
reset; with_lima; FAKE_ENV=(FAKE_LINUX_EXIT=3); run "$I" --non-interactive --telemetry off --admin-password-file "$T/pw"
check 'Linux installer failed: exit 1' 1 "$RC"
check_true '... names it and keeps the VM' 'grep -q "the Linux installer failed (exit 3)" "$T/out" && grep -q "agora Running" "$T/lima/instances"'
check_true '... the keep-alive stays with the VM' '[ -f "$T/home/Library/LaunchAgents/com.agora.vm.agora.plist" ]'
check_true '... the password copy in the VM is gone' 'p=$(sed -n "/^--admin-password-file$/{n;p;}" "$T/linux-args"); [ -n "$p" ] && [ ! -e "$p" ]'
check_true '... and it offers to remove the VM it created' 'grep -q "uninstall.sh --vm agora --delete-vm" "$T/out"'
: > "$CALLS"; FAKE_ENV=(FAKE_LINUX_EXIT=3); run "$I" --non-interactive --telemetry off --existing upgrade
check_true 'a failed upgrade of an earlier VM: never offers to delete it' '[ "$RC" = 1 ] && ! grep -q -- "--delete-vm" "$T/out"'
FAKE_ENV=()

# ─── Over SSH (no login session): the LaunchAgent waits for the next login ───
reset; with_lima; FAKE_ENV=(FAKE_NO_GUI=1); run "$I" --non-interactive --telemetry off
check_true 'no GUI session: still exit 0, with a warning' '[ "$RC" = 0 ] && grep -q "next login" "$T/out"'

# ─── --at-boot ───
reset; with_lima; FAKE_ENV=(); run "$I" --non-interactive --telemetry off --at-boot
check_true '--at-boot without sudo: refused in preflight, before a VM' '[ "$RC" = 1 ] && grep -q "sudo -v" "$T/out" && [ ! -e "$T/daemons/com.agora.vm.agora.plist" ] && [ "$(grep -c "^limactl create" "$CALLS")" = 0 ]'
reset; with_lima; FAKE_ENV=(FAKE_SUDO=1); run "$I" --non-interactive --telemetry off --at-boot
D="$T/daemons/com.agora.vm.agora.plist"
check_true '--at-boot: a LaunchDaemon that runs as this user' '[ "$RC" = 0 ] && grep -q "<key>UserName</key><string>$(id -un)</string>" "$D" && grep -q "^sudo launchctl bootstrap system $D" "$CALLS"'
check_true '--at-boot: no LaunchAgent as well' '[ ! -f "$T/home/Library/LaunchAgents/com.agora.vm.agora.plist" ]'
check_true '--at-boot: the LaunchDaemon is in before the Linux installer runs' '[ "$(grep -n "^sudo launchctl bootstrap system" "$CALLS" | head -n 1 | cut -d: -f1)" -lt "$(grep -n "install/linux/install.sh" "$CALLS" | head -n 1 | cut -d: -f1)" ]'
: > "$CALLS"; run "$I" --non-interactive --telemetry off
check_true 'a re-run without --at-boot keeps the LaunchDaemon, adds no LaunchAgent' '[ "$RC" = 0 ] && [ -f "$D" ] && [ ! -f "$T/home/Library/LaunchAgents/com.agora.vm.agora.plist" ]'
FAKE_ENV=()

# ─── keepalive.sh ───
K="$ROOT/install/macos/keepalive.sh"
reset; with_lima; echo 'agora Stopped' > "$T/lima/instances"; run "$K" agora
check_true 'keep-alive starts a stopped VM' '[ "$RC" = 0 ] && grep -q "^limactl start --tty=false agora" "$CALLS" && grep -q "agora Running" "$T/lima/instances"'
: > "$CALLS"; run "$K" agora
check 'keep-alive leaves a running VM alone' 0 "$(grep -c '^limactl start' "$CALLS")"
rm -f "$T/lima/instances"; run "$K" agora
check_true 'keep-alive with no VM: logs it, exits 0' '[ "$RC" = 0 ] && grep -q "no Lima VM named agora" "$T/out"'
run "$K" 'a;b'
check 'keep-alive refuses a bad name' 2 "$RC"

# ─── agora-vm.sh ───
V="$ROOT/install/macos/agora-vm.sh"
reset; with_lima; run "$I" --non-interactive --telemetry off
run "$V" status
check_true 'status: ports and keep-alive' '[ "$RC" = 0 ] && grep -q "https 8443, http 8000, api 3000" "$T/out" && grep -q "Keep-alive: agent" "$T/out"'
run "$V" backup
f=$(ls "$T/home/Agora Backups/" 2>/dev/null | head -n 1)
check_true 'backup: the bundle comes out to ~/Agora Backups' '[ "$RC" = 0 ] && case "$f" in agora-agora-*.agorabk) true ;; *) false ;; esac'
check_true 'backup: ran backup.sh in the install folder with --out' 'grep -q "^limactl shell --workdir /tmp agora bash $T/guest/agora/install/backup.sh --dir $T/guest/agora --out $T/guest/agora/backups/agora-agora-" "$CALLS"'
printf 'pass phrase\n' > "$T/pp"
run "$V" restore "$T/home/Agora Backups/$f" --yes --passphrase-file "$T/pp"
ga=$(tr '\n' ' ' < "$T/guest-script-args" 2>/dev/null || true)
check_true 'restore: restore.sh gets the copy, --yes and the passphrase file' '[ "$RC" = 0 ] && case "$ga" in *"/tmp/agora-in."*"/$f --dir $T/guest/agora --yes --passphrase-file /tmp/agora-in."*"/pp "*) true ;; *) false ;; esac'
run "$V" restore
check 'restore without a file: refused' 1 "$RC"
run "$V" stop
check_true 'stop: keep-alive paused, then the VM stopped' '[ "$RC" = 0 ] && grep -q "^launchctl bootout gui/" "$CALLS" && grep -q "agora Stopped" "$T/lima/instances"'
run "$V" start
check_true 'start: VM and keep-alive back' '[ "$RC" = 0 ] && grep -q "agora Running" "$T/lima/instances"'

FAKE_ENV=(FAKE_SUDO=1); run "$V" keepalive daemon
check_true 'keepalive daemon: LaunchDaemon in, LaunchAgent out' '[ "$RC" = 0 ] && [ -f "$T/daemons/com.agora.vm.agora.plist" ] && [ ! -f "$T/home/Library/LaunchAgents/com.agora.vm.agora.plist" ]'
run "$V" keepalive agent
check_true 'keepalive agent: back to the LaunchAgent, no LaunchDaemon' '[ "$RC" = 0 ] && [ ! -f "$T/daemons/com.agora.vm.agora.plist" ] && [ -f "$T/home/Library/LaunchAgents/com.agora.vm.agora.plist" ]'
run "$V" keepalive sometimes
check 'keepalive with a bad mode: refused' 1 "$RC"
FAKE_ENV=()

# ─── uninstall.sh ───
U="$ROOT/install/macos/uninstall.sh"
run "$U"
check_true 'uninstall: the guest uninstall ran, the LaunchAgent is gone, the VM stays' '[ "$RC" = 0 ] && grep -q "install/uninstall.sh" "$CALLS" && [ ! -f "$T/home/Library/LaunchAgents/com.agora.vm.agora.plist" ] && grep -q "agora Running" "$T/lima/instances"'
run "$U" --delete-vm
check_true 'uninstall --delete-vm without a terminal: refused, the VM stays' '[ "$RC" = 1 ] && grep -q "agora Running" "$T/lima/instances"'
reset; with_lima; run "$I" --non-interactive --telemetry off; run "$U" --delete-vm
check_true '... and keeps its keep-alive (asked before anything is removed)' '[ "$RC" = 1 ] && [ -f "$T/home/Library/LaunchAgents/com.agora.vm.agora.plist" ]'

# ─── bash 3.2: nothing the Mac's own /bin/bash can't parse ───
for f in "$ROOT"/install/macos/*.sh "$ROOT"/install/macos/lib/macos.sh; do
    check "no bash 4 syntax in $(basename "$f")" '' "$(grep -nE '\bmapfile\b|\breadarray\b|declare -A|local -n|\$\{[A-Za-z_]+(,,|\^\^)\}|&>>' "$f" | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
done

printf '\n%d checks, %d failed\n' "$n" "$failed"
[ "$failed" = 0 ]
