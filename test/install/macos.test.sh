#!/bin/bash
# shellcheck disable=SC2034  # variables read inside check_true's eval
# The macOS installer's decisions (install/macos), with the Mac and Lima replaced by stubs:
# uname, sw_vers, sysctl, df, pmset, lsof, curl, brew, limactl, launchctl, sudo and open are
# fakes on PATH that log their calls (curl also serves a release for the upgrade checks). "Guest" commands run on this machine. No VM, no Homebrew,
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
stub curl "a=\"\$*\"; o=''; while [ \$# -gt 0 ]; do [ \"\$1\" = -o ] && o=\$2; shift; done; case \"\$a\" in *agora.tar.gz.sha256) cp \"$T/rel/agora.tar.gz.sha256\" \"\$o\" ;; *agora.tar.gz) cp \"$T/rel/agora.tar.gz\" \"\$o\" ;; *release-20261101/SHA256SUMS*) exit 22 ;; */releases/noble/) printf '<a href=\"release-20261017/\">x</a> <a href=\"release-20261101/\">y</a> <a href=\"release/\">z</a>' ;; *SHA256SUMS*) printf '%s *ubuntu-24.04-server-cloudimg-amd64.img\n%s *ubuntu-24.04-server-cloudimg-arm64.img\n' ffff$DIGEST $DIGEST ;; *health*) echo '{\"status\":\"ok\"}' ;; *) exit 22 ;; esac"
stub open ':'
stub tmutil 'case "$1" in isexcluded) echo "[Included] $2" ;; esac'
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
    create) n=\$(printf '%s\n' "\$@" | sed -n '/^--name$/{n;p;}'); f=\$(eval echo "\\\${\$#}"); cp "\$f" "\$L/\$n.yaml"; mkdir -p "\$HOME/.lima/\$n"; echo "\$n Stopped" >> "\$L/instances" ;;
    start) n=\$(eval echo "\\\${\$#}"); sed -i.bak "s/^\$n .*/\$n Running/" "\$L/instances" ;;
    stop) sed -i.bak "s/^\$2 .*/\$2 Stopped/" "\$L/instances" ;;
    delete) sed -i.bak "/^\$3 /d" "\$L/instances" ;;
    copy) s=\${2#*:}; d=\${3#*:}; [ "\$2" = "\${2#*:}" ] || s=\${2#*:}; cp "\$s" "\$d" ;;
    shell)
        shift; while [ "\${1#--}" != "\$1" ]; do [ "\$1" = --workdir ] && shift; shift; done; shift
        case "\$*" in
            *iptables*DOCKER-USER*) [ "\${FAKE_FW_MISSING:-}" = DOCKER-USER ] && exit 1; exit 0 ;;
            *iptables*) exit 0 ;;
            *getent*) [ "\${FAKE_DNS_FAIL:-0}" = 1 ] && exit 2; exit 0 ;;
            *systemctl*) exit 0 ;;
            *os-release*) printf '%s' "\${FAKE_GUEST:-ubuntu 24.04 aarch64}"; exit 0 ;;
            *working_dir*) echo "$T/guest/agora"; exit 0 ;;
            *install/linux/install.sh*)
                printf '%s\n' "\$@" > "$T/linux-args"
                pw=\$(printf '%s\n' "\$@" | sed -n '/^--admin-password-file$/{n;p;}')
                [ -z "\$pw" ] || cat "\$pw" > "$T/linux-saw-password"
                mkdir -p "\$HOME/.agora"; echo "https://localhost:\$(printf '%s\n' "\$@" | sed -n '/^--https-port$/{n;p;}')" > "\$HOME/.agora/last-install-url"
                exit "\${FAKE_LINUX_EXIT:-0}" ;;
            *install/backup.sh*) out=\$(printf '%s\n' "\$@" | sed -n '/^--out$/{n;p;}'); mkdir -p "\$(dirname "\$out")"; echo bundle > "\$out"; exit 0 ;;
            *install/upgrade.sh*) printf '%s\n' "\$@" > "$T/guest-script-args"; exit "\${FAKE_UPGRADE_EXIT:-0}" ;;
            "bash "*install/tailnet.sh*) printf '%s\n' "\$@" > "$T/guest-script-args"; exit "\${FAKE_TAILNET_EXIT:-0}" ;;
            *install/restore.sh*|*install/uninstall.sh*|*install/doctor.sh*) printf '%s\n' "\$@" > "$T/guest-script-args"; exit 0 ;;
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
    check 'version_ge 14 >= 13.5 (no minor in a)' 0 "$(version_ge 14 13.5; echo $?)"
    check 'version_ge 13 < 13.5 (cut -s: a missing field is 0)' 1 "$(version_ge 13 13.5; echo $?)"
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
    check_true 'template: the guest firewall runs at every boot (provision, mode system)' 'printf "%s" "$tpl" | grep -q "^provision:" && printf "%s" "$tpl" | grep -q "^  - mode: system" && printf "%s" "$tpl" | grep -q "^      ipt -N AGORA-HOST-NEW"'
    check_true 'template: the firewall accepts DNS (udp and tcp 53) before it rejects' '[ "$(printf "%s\n" "$tpl" | grep -n -e "--dport 53 -j ACCEPT" -e "-j REJECT" | sed "s/^[0-9]*: *ipt -A AGORA-HOST-NEW //; s/ ||.*//" | tr "\n" "|")" = "-p udp --dport 53 -j ACCEPT|-p tcp --dport 53 -j ACCEPT|-p tcp -j REJECT --reject-with tcp-reset|-j REJECT|" ]'
    if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' 2>/dev/null; then
        check 'template parses as YAML; the provision script is the file, unindented' ok "$(printf '%s' "$tpl" | python3 -c 'import sys,yaml; d=yaml.safe_load(sys.stdin); s=d["provision"][0]["script"]; f=open(sys.argv[1]).read(); print("ok" if s.strip()==f.strip() and d["mounts"]==[] else "bad")' "$ROOT/install/macos/guest/host-firewall.sh")"
    fi
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
check_true 'the image is a dated build; the newest without sums is skipped' 'grep -q "releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-arm64.img" "$T/lima/agora.yaml"'
probe="$T/permprobe"; mkdir -p "$probe"; chmod 700 "$probe"
if [ "$(ls -ld "$probe" | cut -c1-10)" = drwx------ ]; then
    check 'the VM folder ~/.lima/agora is 700' drwx------ "$(ls -ld "$T/home/.lima/agora" | cut -c1-10)"
fi
check 'Time Machine: no exclusion without consent (non-interactive)' 0 "$(grep -c '^tmutil addexclusion' "$CALLS")"
check_true 'after the Linux installer, the firewall is re-applied (Docker exists now)' 'grep -q "agora sudo -n systemctl restart agora-host-firewall" "$CALLS"'
check_true '... but it says how' 'grep -q "tmutil addexclusion" "$T/out"'
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
check_true '... and no keep-alive written for it' '[ ! -f "$T/home/Library/LaunchAgents/com.agora.vm.agora.plist" ]'

# ─── Nobody to ask, --domain, Time Machine with consent ───
reset; run "$I" --telemetry off
check_true 'no terminal and no --non-interactive: refused before anything is made' '[ "$RC" = 1 ] && grep -q "pass --non-interactive" "$T/out" && [ "$(called brew)" = 0 ] && [ ! -d "$T/home/Library" ]'
reset; run "$I" --non-interactive --domain chat.example.com
check_true '--domain: refused (the forwards are loopback-only)' '[ "$RC" = 2 ] && grep -q "Tailscale" "$T/out"'
reset; with_lima; run "$I" --non-interactive --telemetry off --exclude-from-time-machine
check_true '--exclude-from-time-machine: tmutil addexclusion ~/.lima/agora' '[ "$RC" = 0 ] && grep -q "^tmutil addexclusion $T/home/.lima/agora" "$CALLS"'

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
echo 'agora Stopped' > "$T/lima/instances"; mkdir -p "$T/home/.agora/macos"
echo $$ > "$T/home/.agora/macos/agora.installing"; : > "$CALLS"; run "$K" agora
check 'keep-alive leaves the VM alone while the installer (a live PID in the lock) runs' 0 "$(grep -c '^limactl start' "$CALLS")"
echo 999999 > "$T/home/.agora/macos/agora.installing"; run "$K" agora
check 'keep-alive ignores a stale lock' 1 "$(grep -c '^limactl start' "$CALLS")"
rm -f "$T/home/.agora/macos/agora.installing"
FAKE_ENV=(FAKE_FREE_KB=5242880); run "$K" agora
check_true 'keep-alive logs a nearly full Mac disk' 'grep -q "only 5 GB free" "$T/out"'
run "$K" agora
check_true '... once a day' '! grep -q "GB free" "$T/out"'
FAKE_ENV=()

# ─── agora-vm.sh ───
V="$ROOT/install/macos/agora-vm.sh"
reset; with_lima; run "$I" --non-interactive --telemetry off
FAKE_ENV=(FAKE_BUSY_PORTS='8443 3000'); run "$V" doctor
check_true 'doctor: forwards, health, the VM firewall and the Mac disk pass' '[ "$RC" = 0 ] && grep -q "ok      the VM can.t reach this Mac.s loopback" "$T/out" && grep -q "ok      the VM resolves names" "$T/out" && grep -q "GB free on this Mac" "$T/out"'
FAKE_ENV=(FAKE_BUSY_PORTS='8443 3000' FAKE_FREE_KB=5242880); run "$V" doctor
check_true 'doctor: fails on a nearly full Mac disk' '[ "$RC" = 1 ] && grep -q "FAILED  only 5 GB free" "$T/out"'
FAKE_ENV=(FAKE_BUSY_PORTS='8443 3000' FAKE_FW_MISSING=DOCKER-USER); run "$V" doctor
check_true 'doctor: fails when containers can reach the Mac (no DOCKER-USER jump)' '[ "$RC" = 1 ] && grep -q "FAILED  the VM.s containers can reach" "$T/out" && grep -q "ok      the VM can.t reach this Mac.s loopback (192.168.5.2, OUTPUT)" "$T/out"'
FAKE_ENV=(FAKE_BUSY_PORTS='8443 3000' FAKE_DNS_FAIL=1); run "$V" doctor
check_true 'doctor: fails when the VM can.t resolve names (the firewall must leave DNS open)' '[ "$RC" = 1 ] && grep -q "FAILED  the VM can.t resolve names" "$T/out" && grep -q "ok      the VM can.t reach this Mac.s loopback (192.168.5.2, OUTPUT)" "$T/out"'
FAKE_ENV=()
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

# ─── agora-vm.sh upgrade: the latest release, downloaded and checked on the Mac ───
mkdir -p "$T/relsrc/agora" "$T/rel" "$T/tmp"
cp -R "$ROOT/install" "$T/relsrc/agora/"
printf '{\n  "name": "agora",\n  "version": "9.9.9"\n}\n' > "$T/relsrc/agora/package.json"
printf 'services: {}\n' > "$T/relsrc/agora/docker-compose.prod.yml"
mk_rel() { # the release the curl stub serves, with a matching checksum
    $REAL_TAR -czf "$T/rel/agora.tar.gz" -C "$T/relsrc" agora
    if command -v sha256sum >/dev/null 2>&1; then (cd "$T/rel" && sha256sum agora.tar.gz > agora.tar.gz.sha256)
    else (cd "$T/rel" && shasum -a 256 agora.tar.gz > agora.tar.gz.sha256); fi
}
mk_rel
guest_args() { tr '\n' ' ' < "$T/guest-script-args" 2>/dev/null || true; }
FAKE_ENV=(TMPDIR="$T/tmp")
rm -f "$T/guest-script-args"; : > "$CALLS"; run "$V" upgrade --passphrase-file "$T/pp"
ga=$(guest_args)
check 'upgrade with no release given: exit 0' 0 "$RC"
check_true 'upgrade: downloads agora.tar.gz and its SHA-256 from the fixed agora-latest release, over HTTPS only' 'grep -q "^curl -fsSL --proto =https -o .*/agora.tar.gz https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-latest/agora.tar.gz$" "$CALLS" && grep -q "^curl .*releases/download/agora-latest/agora.tar.gz.sha256$" "$CALLS"'
check_true 'upgrade: runs the downloaded release.s upgrade.sh in the VM, on the install, with the passphrase file' 'case "$ga" in "bash /tmp/agora-src."*"/install/upgrade.sh --dir $T/guest/agora --passphrase-file /tmp/agora-in."*"/pp "*) true ;; *) false ;; esac'
check_true 'upgrade: checks Agora from the Mac afterwards' 'grep -q "ok      Agora answers on this Mac at http://127.0.0.1:3000/health" "$T/out"'
check 'upgrade: the downloaded release becomes this Mac.s copy of the commands' 9.9.9 "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$T/home/.agora/macos/release/package.json" 2>/dev/null)"
check_true 'upgrade: says where they are' 'grep -q "Mac commands are in $T/home/.agora/macos/release" "$T/out"'
check 'upgrade: nothing left in the temporary folder' '' "$(ls "$T/tmp")"
rm -f "$T/guest-script-args"; : > "$CALLS"; run "$V" upgrade --ref v9.9.9
check_true 'upgrade --ref: that release' '[ "$RC" = 0 ] && grep -q "releases/download/v9.9.9/agora.tar.gz$" "$CALLS" && ! grep -q agora-latest "$CALLS"'
rm -f "$T/guest-script-args"; : > "$CALLS"; run "$V" upgrade --source "$T/relsrc/agora"
check_true 'upgrade --source: a checkout, nothing downloaded' '[ "$RC" = 0 ] && ! grep -q "agora.tar.gz" "$CALLS" && [ -s "$T/guest-script-args" ]'
run "$V" upgrade --source "$T/relsrc/agora" --ref v9.9.9
check 'upgrade --source with --ref: refused' 1 "$RC"
echo "0000000000000000000000000000000000000000000000000000000000000000  agora.tar.gz" > "$T/rel/agora.tar.gz.sha256"
rm -f "$T/guest-script-args"; : > "$CALLS"; run "$V" upgrade
check_true 'upgrade: a download that fails its SHA-256 is refused before anything reaches the VM' '[ "$RC" = 1 ] && grep -q "doesn.t match its SHA-256" "$T/out" && [ ! -e "$T/guest-script-args" ] && ! grep -q "^limactl copy" "$CALLS"'
check 'upgrade: a refused download leaves nothing in the temporary folder' '' "$(ls "$T/tmp")"
mk_rel
FAKE_ENV=(TMPDIR="$T/tmp" FAKE_UPGRADE_EXIT=4); run "$V" upgrade
check_true 'upgrade: a failure in the VM is reported with the way back, and the Mac.s copy is not replaced' '[ "$RC" = 1 ] && grep -q "install/upgrade.sh failed in agora (exit 4)" "$T/out" && grep -q -- "--rollback" "$T/out"'
FAKE_ENV=()

# ─── agora-vm.sh tailnet ───
rm -f "$T/guest-script-args"; run "$V" tailnet on
check_true 'tailnet with an install from before the command: says to upgrade first' '[ "$RC" = 1 ] && grep -q "upgrade it first" "$T/out" && [ ! -e "$T/guest-script-args" ]'
mkdir -p "$T/guest/agora/install"; : > "$T/guest/agora/install/tailnet.sh"
run "$V" tailnet on --hostname agora-home --install-tailscale
check 'tailnet on: runs the install.s tailnet.sh in the VM with the name' "bash $T/guest/agora/install/tailnet.sh on --dir $T/guest/agora --hostname agora-home --install-tailscale " "$(guest_args)"
run "$V" tailnet status
check 'tailnet status: passed on' "bash $T/guest/agora/install/tailnet.sh status --dir $T/guest/agora " "$(guest_args)"
FAKE_ENV=(FAKE_TAILNET_EXIT=1); run "$V" tailnet status
check 'tailnet status: a failed check is this command.s exit code' 1 "$RC"
FAKE_ENV=()
run "$V" tailnet sideways
check 'tailnet with another word: refused' 1 "$RC"

# ─── upgrade-latest.sh (published as upgrade-macos.sh): one file, no checkout ───
UL="$T/alone/upgrade-macos.sh"; mkdir -p "$T/alone"; cp "$ROOT/install/macos/upgrade-latest.sh" "$UL"
rm -rf "$T/home/.agora/macos/release"; rm -f "$T/guest-script-args"; : > "$CALLS"
FAKE_ENV=(TMPDIR="$T/tmp"); run "$UL"
check_true 'upgrade-macos.sh without a terminal or --yes: explains, then stops before downloading' '[ "$RC" = 1 ] && grep -q "This upgrades the Agora install in the Lima VM" "$T/out" && ! grep -q "^curl" "$CALLS" && [ ! -e "$T/guest-script-args" ]'
run "$UL" --yes --passphrase-file "$T/pp"
ga=$(guest_args)
check 'upgrade-macos.sh --yes: exit 0' 0 "$RC"
check_true 'upgrade-macos.sh: downloads the latest release and its SHA-256' 'grep -q "^curl -fsSL --proto =https -o .*/agora.tar.gz https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-latest/agora.tar.gz$" "$CALLS" && grep -q "agora-latest/agora.tar.gz.sha256$" "$CALLS"'
check_true 'upgrade-macos.sh: that release.s upgrade.sh runs in the VM with the passphrase file' 'case "$ga" in "bash /tmp/agora-src."*"/install/upgrade.sh --dir $T/guest/agora --passphrase-file /tmp/agora-in."*"/pp "*) true ;; *) false ;; esac'
check 'upgrade-macos.sh: keeps the release.s Mac commands' 9.9.9 "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$T/home/.agora/macos/release/package.json" 2>/dev/null)"
check_true 'upgrade-macos.sh: ends with the one command for next time and the way back' 'grep -q "bash $T/home/.agora/macos/release/install/macos/agora-vm.sh upgrade" "$T/out" && grep -q "limactl shell --workdir $T/guest/agora agora bash install/upgrade.sh --rollback" "$T/out"'
check 'upgrade-macos.sh: the temporary folder is gone' '' "$(ls "$T/tmp")"
echo "0000000000000000000000000000000000000000000000000000000000000000  agora.tar.gz" > "$T/rel/agora.tar.gz.sha256"
rm -f "$T/guest-script-args"; run "$UL" --yes
check_true 'upgrade-macos.sh: a download that fails its SHA-256 changes nothing' '[ "$RC" = 1 ] && grep -q "doesn.t match its SHA-256; nothing was changed" "$T/out" && [ ! -e "$T/guest-script-args" ] && [ -z "$(ls "$T/tmp")" ]'
mk_rel
FAKE_ENV=(TMPDIR="$T/tmp" FAKE_UPGRADE_EXIT=4); run "$UL" --yes
check_true 'upgrade-macos.sh: a failed upgrade prints the rollback command and cleans up' '[ "$RC" != 0 ] && grep -q "limactl shell --workdir $T/guest/agora agora bash install/upgrade.sh --rollback" "$T/out" && [ -z "$(ls "$T/tmp")" ]'
FAKE_ENV=(TMPDIR="$T/tmp"); run "$UL" --yes --vm nosuch
check_true 'upgrade-macos.sh: a VM that isn.t there is refused before anything is asked or downloaded' '[ "$RC" = 1 ] && grep -q "no Lima VM named nosuch" "$T/out"'
FAKE_ENV=()

# ─── uninstall.sh ───
reset; with_lima; run "$I" --non-interactive --telemetry off; sed -i.bak 's/^agora .*/agora Stopped/' "$T/lima/instances"
run "$ROOT/install/macos/uninstall.sh"
check_true 'uninstall with the VM stopped: says the install inside stays' '[ "$RC" = 0 ] && grep -q "install inside it stays" "$T/out" && ! grep -q "install/uninstall.sh" "$CALLS"'
reset; with_lima; run "$I" --non-interactive --telemetry off
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
