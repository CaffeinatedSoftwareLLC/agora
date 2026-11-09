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

install -d -m 755 /etc/agora /usr/local/sbin
[ -f /etc/agora/host-allow-ports ] || printf '# One TCP port per line that the VM may reach on the Mac (192.168.5.2)\n' > /etc/agora/host-allow-ports

cat > /usr/local/sbin/agora-host-firewall <<'EOF'
#!/bin/sh
# Written by Agora's Lima provision script. Rebuilds the AGORA-HOST chain and makes OUTPUT (the
# VM itself) and DOCKER-USER (containers) send traffic for the Mac's loopback through it.
set -eu
HOST=192.168.5.2
command -v iptables >/dev/null 2>&1 || { echo "agora-host-firewall: no iptables yet"; exit 0; }
iptables -w -N AGORA-HOST 2>/dev/null || iptables -w -F AGORA-HOST
for p in $(grep -Eo '^[0-9]{1,5}' /etc/agora/host-allow-ports 2>/dev/null || true); do
    iptables -w -A AGORA-HOST -p tcp --dport "$p" -j ACCEPT
done
iptables -w -A AGORA-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A AGORA-HOST -p tcp -j REJECT --reject-with tcp-reset
iptables -w -A AGORA-HOST -j REJECT
for chain in OUTPUT DOCKER-USER; do
    iptables -w -n -L "$chain" >/dev/null 2>&1 || continue
    iptables -w -C "$chain" -d "$HOST" -j AGORA-HOST 2>/dev/null || iptables -w -I "$chain" 1 -d "$HOST" -j AGORA-HOST
done
echo "agora-host-firewall: new connections to $HOST refused"
EOF
chmod 755 /usr/local/sbin/agora-host-firewall

# At boot, and again each time Docker starts (it makes DOCKER-USER; Docker is installed after the
# first boot)
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
systemctl daemon-reload
systemctl enable agora-host-firewall.service >/dev/null 2>&1
systemctl restart agora-host-firewall.service || /usr/local/sbin/agora-host-firewall
