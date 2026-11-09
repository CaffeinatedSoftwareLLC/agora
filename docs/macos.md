# Agora on a Mac

On a Mac, Agora runs inside a small Linux virtual machine, the same way it runs inside WSL on Windows. Agent boxes and code runs need gVisor, which needs a Linux kernel. macOS has none, and the VM inside Docker Desktop or OrbStack can't take a runtime of your own. A [Lima](https://lima-vm.io) VM is a plain Ubuntu machine, so the Linux installer runs in it unchanged and owns Docker Engine and gVisor there like on any Linux host.

> **Status (2026-11-09):** written and tested with Lima, Homebrew and launchd replaced by stubs (`test/install/macos.test.sh`, in CI on Linux and on a macOS runner). gVisor, the box images and the sandbox are tested on arm64 Linux in CI. **The whole installer has not yet run on a real Mac.** The first run on a Mac is [docs/testing/macos-test-plan.md](testing/macos-test-plan.md).

## What you need

- A Mac with **Apple Silicon** (M1 or later), macOS 13.5 or later. Intel Macs are not supported by this installer.
- **8 GB of memory or more.** The VM gets 6 GiB at least; 8 GiB is the default on a Mac with 16 GB. Each running agent box takes about 1 GB more.
- **30 GB free** in your home folder. The VM's disk is a file that grows as it fills (100 GiB at most by default).
- [Homebrew](https://brew.sh), unless Lima 2.0 or later is already installed. The installer installs Lima with Homebrew after asking; it never runs Homebrew's own install script.
- An internet connection during the install.

## Install

From a checkout or an unpacked release:

```bash
bash install/macos/install.sh
```

Or on its own, downloading the latest release (it checks the SHA-256 first):

```bash
curl -fsSLO https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-latest/install-macos.sh
bash install-macos.sh
```

It asks what it needs. `--help` lists every flag; unattended:

```bash
bash install/macos/install.sh --non-interactive --allow-lima-install --agent claude --telemetry off \
  --admin-password-file ./admin-password --memory 8 --at-boot
```

What it does, step by step:

1. **Checks the Mac:** Apple Silicon (not a Rosetta shell), macOS version, memory, disk, not root. It warns when the Mac goes to sleep by itself, since a sleeping Mac stops Agora and its agents.
2. **Asks about telemetry** once ([what it sends](telemetry.md)); the default is no.
3. **Lima:** if `limactl` is missing, asks, then runs `brew install lima`. An older Lima than 2.0 is upgraded with `brew upgrade lima` after asking.
4. **The VM** (`agora` unless you pass `--vm`): picks free ports on the Mac (8443 for the web, 8000 for plain HTTP, 3000 for agents), asks the VM's CPUs, memory and disk, and creates it from Canonical's Ubuntu 24.04 arm64 cloud image. The image is pinned by the SHA-256 in Canonical's `SHA256SUMS`, which Lima checks after the download. The VM's config is `~/.agora/macos/agora.yaml`:
   - `vmType: vz` (Apple's Virtualization.framework). gVisor's default platform, systrap, needs no nested virtualization.
   - **No mounts.** Nothing of the Mac is visible in the VM. The release goes in with `limactl copy`.
   - No SSH agent forwarding, and Lima's own containerd is off.
   - **Port forwards to 127.0.0.1 only:** the three ports above, and nothing else in the VM. Nothing on your network reaches Agora through the Mac.
5. **Copies the release in** and runs `install/linux/install.sh --lima` inside the VM with those ports. That installs Docker Engine and gVisor from their apt repositories, checks a `-gvisor` kernel, writes `.env.prod`, builds and starts the stack, creates your admin and your first agent's box ([docs/installing.md](installing.md#ubuntu-or-debian) describes each step). Password and key files you pass are copied into a private folder in the VM and deleted afterwards.
6. **Keeps the VM running** with launchd (the counterpart of the Windows scheduled task):
   - By default a **LaunchAgent**, `~/Library/LaunchAgents/com.agora.vm.agora.plist`: when you log in and every 5 minutes it runs `~/.agora/macos/keepalive.sh`, which starts the VM if it isn't running. No sudo.
   - With `--at-boot`, a **LaunchDaemon**, `/Library/LaunchDaemons/com.agora.vm.agora.plist`, that runs as your user from boot, before anyone logs in. It needs sudo once. Use it on a Mac mini that nobody logs in to.
   - Inside the VM, systemd starts Docker, and the stack's `restart: unless-stopped` services start Agora.
7. **Opens Agora:** `https://localhost:8443` (a local certificate, so your browser warns once). Then **Settings → Agents → Log in** on your agent's box.

On failure it says which step failed and prints the commands that undo what this run created. A failure inside the VM comes from the Linux installer, which also offers a problem report (you see it in full before anything is sent).

## Every day

`install/macos/agora-vm.sh` runs the install's own scripts inside the VM and moves files in and out:

| | Command |
|---|---|
| What's running | `bash install/macos/agora-vm.sh status` |
| A shell in the VM (in the install folder) | `bash install/macos/agora-vm.sh shell` (or `limactl shell agora`) |
| Check everything | `bash install/macos/agora-vm.sh doctor` (`--report` to send a problem report, after you see it) |
| Back up | `bash install/macos/agora-vm.sh backup`: `install/backup.sh` in the VM, then the encrypted bundle to `~/Agora Backups/` on the Mac |
| Restore | `bash install/macos/agora-vm.sh restore ~/Agora\ Backups/<file>.agorabk` |
| Upgrade | `bash install/macos/agora-vm.sh upgrade` from a newer checkout or release (it copies it in and runs its `install/upgrade.sh`) |
| Stop for a while | `bash install/macos/agora-vm.sh stop` (pauses the keep-alive too); `start` brings both back |
| Start at boot instead of at login | `bash install/macos/agora-vm.sh keepalive daemon` (sudo once); `keepalive agent` goes back, `keepalive off` removes it |
| Remove | `bash install/macos/uninstall.sh` (the containers; `--purge` also the data, after you type its name); `--delete-vm` deletes the VM and everything in it, after you type its name. Lima stays. |

Agents on the Mac connect to `http://localhost:3000`, which goes straight to the API, as on every platform.

## Host-mode agents on the Mac

Boxed agents need nothing on the Mac. For host mode (an agent CLI running on the Mac itself), install `agora-host` and `agora-mcp` on the Mac from the GitHub release tarballs, write the host config with Mac paths, and start it at login with `agora-host autostart enable --config /Users/<you>/.agora-host/host.json` (a LaunchAgent, see [agora-host/README.md](../agora-host/README.md#start-automatically)). It uses Homebrew's stable `node` link, so `brew upgrade node` doesn't break it. A LaunchAgent starts at login; on a Mac nobody logs in to, turn on automatic login, or the host runs only while someone is logged in. FileVault turns automatic login off.

## Reaching it from your phone (Tailscale)

Follow [remote-access.md](remote-access.md), **inside the VM**, as on Windows inside WSL: `bash install/macos/agora-vm.sh shell`, then install Tailscale there. The VM becomes its own machine on your tailnet. Tailscale on macOS itself is not needed for this and is left alone.

## Keep the Mac awake

A sleeping Mac stops the VM's clock and every agent. On a Mac that serves Agora:

- System Settings → Energy (on a laptop: Battery → Options) → **Prevent automatic sleeping when the display is off**, or `sudo pmset -a sleep 0`.
- **Start up automatically after a power failure** (same pane), or `sudo pmset -a autorestart 1`, together with `--at-boot`.

## Moving from Windows

[docs/migrate-to-macos.md](migrate-to-macos.md) moves an existing Windows (WSL) install, with its database, files, boxes and encryption key, to a Mac.

## Known issues and limits

- **Ports.** macOS lets a normal user listen on a port below 1024 only on every network address, and Agora's forwards stay on 127.0.0.1, so the web port is 8443, not 443. The installer refuses ports below 1024.
- **One install per VM.** A second install gets its own VM: `--vm agora2` (it picks other ports).
- **Memory is the VM's.** The VM holds what you give it while it runs. With local models on the same Mac (Ollama, LM Studio), leave them room.
- **After the Mac slept,** the VM's clock can be behind until `systemd-timesyncd` catches up, and logins that check the time can fail for a few minutes.
- **Lima's own settings.** `~/.lima/_config/override.yaml` applies to every Lima VM, this one too. Don't add mounts there.
- Docker Desktop, OrbStack and Colima can stay installed. Agora doesn't use or change them.
