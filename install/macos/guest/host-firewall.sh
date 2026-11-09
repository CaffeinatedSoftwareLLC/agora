#!/bin/bash
# Lima provision script (mode: system) for Agora's VM: Lima runs it as root at every boot
# (docs/macos.md, "What the VM can reach on the Mac"). install/macos/lib/macos.sh copies it into
# the VM's Lima config.
#
# In Lima's user-mode network, 192.168.5.2 (host.lima.internal) is the Mac's own 127.0.0.1.
# Without this, anything in the VM (root, the stack's containers, a box that got past its edge)
# could reach services that listen only on the Mac's loopback: Ollama, dev servers, agora-host's
# sign-in callback. This drops every NEW connection from the VM and its containers to that
# address. Untouched: DNS (192.168.5.3), traffic through the gateway to the internet (its
# destination isn't 192.168.5.2), Lima's own channel (the Mac connects in), the port forwards
# (inside the VM they connect to 127.0.0.1) and replies to the Mac's connections.
#
# To let the VM reach one port on the Mac (an Ollama for Agora's model agents, say), put the port
# on a line of its own in /etc/agora/host-allow-ports and run: sudo systemctl restart agora-host-firewall
set -eu

install -d -m 755 /etc/agora /usr/local/sbin /etc/systemd/system/docker.service.d
[ -f /etc/agora/host-allow-ports ] || printf '# One TCP port per line that the VM may reach on the Mac (192.168.5.2)\n' > /etc/agora/host-allow-ports

cat > /usr/local/sbin/agora-host-firewall <<'EOF'
#!/bin/sh
# Written by Agora's Lima provision script. Makes OUTPUT (the VM itself) and DOCKER-USER (its
# containers) send traffic for the Mac's loopback through the AGORA-HOST chain, which refuses new
# connections except to the ports in /etc/agora/host-allow-ports.
#
# It never fails open: the new rules are built in AGORA-HOST-NEW and swapped in only when
# complete, so any error leaves the rules that were there before. Bad lines in the allow list are
# skipped with a log line.
set -u
HOST=192.168.5.2
ALLOW=/etc/agora/host-allow-ports
log() { echo "agora-host-firewall: $*"; }
ipt() { iptables -w "$@"; }
command -v iptables >/dev/null 2>&1 || { log "no iptables yet; nothing done"; exit 0; }

# Containers: Docker sends their traffic through DOCKER-USER, and keeps a DOCKER-USER chain that
# already exists when it starts. Making it now means containers are covered from Docker's first
# start, also on the boot before Docker is installed.
ipt -n -L DOCKER-USER >/dev/null 2>&1 || ipt -N DOCKER-USER || { log "can't create DOCKER-USER"; exit 1; }
if grep -Eqs '"firewall-backend"[[:space:]]*:[[:space:]]*"nftables"' /etc/docker/daemon.json; then
    log "warning: Docker uses its nftables backend, which doesn't use DOCKER-USER: containers are NOT kept from the Mac's loopback"
fi

ports=''
if [ -f "$ALLOW" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        line=$(printf '%s' "$line" | sed -e 's/#.*//' -e 's/[[:space:]]//g')
        [ -n "$line" ] || continue
        case "$line" in *[!0-9]*) log "skipping '$line' in $ALLOW: not a port number"; continue ;; esac
        if [ "${#line}" -gt 5 ] || [ "$line" -lt 1 ] || [ "$line" -gt 65535 ]; then log "skipping '$line' in $ALLOW: not a port from 1 to 65535"; continue; fi
        ports="$ports $line"
    done < "$ALLOW"
fi

fail() { log "$1; the rules from before stay"; ipt -F AGORA-HOST-NEW 2>/dev/null; ipt -X AGORA-HOST-NEW 2>/dev/null; exit 1; }
ipt -N AGORA-HOST-NEW 2>/dev/null || ipt -F AGORA-HOST-NEW || fail "can't make AGORA-HOST-NEW"
for p in $ports; do ipt -A AGORA-HOST-NEW -p tcp --dport "$p" -j ACCEPT || fail "can't allow port $p"; done
ipt -A AGORA-HOST-NEW -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN || fail "can't add the conntrack rule"
ipt -A AGORA-HOST-NEW -p tcp -j REJECT --reject-with tcp-reset || fail "can't add the TCP reject"
ipt -A AGORA-HOST-NEW -j REJECT || fail "can't add the reject"

# Swap: the complete new chain goes in front, then the old one comes out
for chain in OUTPUT DOCKER-USER; do
    ipt -I "$chain" 1 -d "$HOST" -j AGORA-HOST-NEW || fail "can't send $chain through AGORA-HOST-NEW"
    while ipt -D "$chain" -d "$HOST" -j AGORA-HOST 2>/dev/null; do :; done
done
if ipt -n -L AGORA-HOST >/dev/null 2>&1; then ipt -F AGORA-HOST && ipt -X AGORA-HOST || { log "can't remove the old AGORA-HOST; the new rules are in AGORA-HOST-NEW"; exit 1; }; fi
# A rename keeps the jumps: they now point at AGORA-HOST
ipt -E AGORA-HOST-NEW AGORA-HOST || { log "can't rename AGORA-HOST-NEW; its rules are in force under that name"; exit 1; }
log "new connections to $HOST refused${ports:+ (allowed:$ports)}"
EOF
chmod 755 /usr/local/sbin/agora-host-firewall

# At boot, and after every start of Docker (the drop-in; a failure there never stops Docker)
cat > /etc/systemd/system/agora-host-firewall.service <<'EOF'
[Unit]
Description=Agora: no new connections from this VM to the Mac's loopback (host.lima.internal)
After=network-pre.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/agora-host-firewall

[Install]
WantedBy=multi-user.target docker.service
EOF
cat > /etc/systemd/system/docker.service.d/agora-host-firewall.conf <<'EOF'
# Agora: re-apply the rules that keep containers from the Mac's loopback after Docker starts
[Service]
ExecStartPost=-/usr/local/sbin/agora-host-firewall
EOF
systemctl daemon-reload
systemctl enable agora-host-firewall.service >/dev/null 2>&1
systemctl restart agora-host-firewall.service || /usr/local/sbin/agora-host-firewall
