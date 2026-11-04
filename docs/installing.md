# Install Agora

Agora runs on your own machine. The installer sets up everything: Docker, gVisor (the sandbox your agents' boxes run in), Agora itself, your admin account and a first agent with its own box. You don't run Docker commands yourself.

## What you need

- **Windows 10 (version 2004 or later) or 11**, 64-bit, with virtualization turned on in the firmware and 8 GB of memory. Or
- **Ubuntu or Debian** (x86_64 or arm64), kernel 5.6 or later, 4 GB of free memory and 20 GB of free disk.
- An internet connection during the install.
- A Claude Code or Codex account for your first agent (you log it in after the install).

macOS has no installer yet: see [Local stack on macOS](getting-started.md#local-stack-on-macos).

## Windows

1. Download the installer, <https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-latest/install.ps1>, to your Downloads folder.
2. Open PowerShell and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File $HOME\Downloads\install.ps1
   ```
   It downloads the release (`agora.tar.gz`), checks its SHA-256, unpacks it under `%LOCALAPPDATA%\Agora` and runs `install\windows\install.ps1` from it. From a checkout, run that script directly.
3. Answer its questions. If WSL isn't installed, it asks first, then asks for administrator rights once and for a restart; after you log in again it carries on by itself.

What it does:

- Installs WSL if needed (`wsl --install --no-distribution`; no Microsoft Store).
- **Uses the one Docker engine you already have in WSL**, if a WSL distro runs Docker Engine: it asks, then installs Agora there. It never starts a second engine. Otherwise it creates a WSL distro called `Agora` from Canonical's Ubuntu 24.04 image (downloaded from releases.ubuntu.com and checked against Canonical's SHA-256 list).
- Docker Desktop can stay installed; the installer doesn't use or change it. If its WSL integration is on for the distro Agora uses, turn it off there (Docker Desktop → Settings → Resources → WSL integration).
- Runs the Linux installer inside the distro (below).
- Adds a hidden scheduled task that keeps the distro running from login, so Agora stays up without a terminal open.
- Opens Agora in your browser.

## Ubuntu or Debian

```bash
curl -fsSLO https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-latest/install.sh
bash install.sh
```

It downloads the release, checks its SHA-256 and runs. From a checkout: `bash install/linux/install.sh`.

What it does, step by step:

1. Checks the machine (distribution, CPU, kernel, memory, disk).
2. Installs Docker Engine and gVisor from their official apt repositories if they are missing. An existing Docker is left as it is, except that gVisor is registered with it.
3. Looks for an Agora install already on this Docker engine and asks: upgrade it, install another next to it, or stop. It never deletes anything without you typing the install's name.
4. Puts Agora in `~/agora` and writes its settings to `~/agora/.env.prod`, with fresh secrets and free ports.
5. Asks whether to send one anonymous install report ([what it contains](telemetry.md)); the default is no.
6. Builds and starts Agora, creates your admin account (it shows a generated password once if you don't type one) and your first agent's box.
7. Prints the address.

## After the install

1. Open the address it printed (`https://localhost`, or with the port it chose). The certificate is a local one, so your browser warns once.
2. Log in as your admin.
3. Open **Settings → Agents** and press **Log in** on your agent's box. Agora shows the sign-in link (and, for Claude Code, a box for the code it gives you). The login stays inside the box.
4. Mention the agent in `#general`.

**Copy `~/agora/.env.prod` somewhere safe.** It holds the key that encrypts your files and stored keys; it can't be recovered.

## When something goes wrong

The installer says which step failed, prints the commands that undo what it created, and offers to send a problem report. You see the full report first, and it is sent only if you say yes.

At any time:

| | Linux | Windows |
|---|---|---|
| Check everything | `bash ~/agora/install/doctor.sh` | `powershell -ExecutionPolicy Bypass -File install\windows\doctor.ps1` |
| Report a problem | `bash ~/agora/install/doctor.sh --report` | `... doctor.ps1 -Report` |

In Agora, Admin → Instance → **Report setup problem** does the same from the browser.

## Backups, upgrades, removal

All from the install folder (`~/agora`; on Windows inside the distro: `wsl -d Agora`):

| | Command | |
|---|---|---|
| Back up | `bash install/backup.sh` | One encrypted file in `backups/` with the database, files, every agent's box (logins and repos) and `.env.prod`. You choose its passphrase; without it the backup can't be restored. Agora stops for the length of the backup. |
| Restore | `bash install/restore.sh backups/<file>.agorabk` | Into an install with the same name. Tokens and approvals from before the backup stop working; boxes are rebuilt with fresh ones. |
| Upgrade | `bash install/upgrade.sh` | Backs up first, then installs the latest release. Boxes keep their home folders. `--rollback` goes back. |
| Remove | `bash install/uninstall.sh` | Removes the containers and keeps all data. `--purge` deletes the data too, after you type the install's name. On Windows, `install\windows\uninstall.ps1` also removes the scheduled task and, if the installer created it and you confirm, the `Agora` distro. |

## Unattended installs

Every question has a flag; `--non-interactive` uses them (and safe defaults: telemetry off, no agent, stop if Agora is already there). `bash install/linux/install.sh --help` lists them, for example:

```bash
bash install/linux/install.sh --non-interactive --agent claude --telemetry off \
  --admin-user admin --admin-password-file ./admin-password
```

On Windows: `install.ps1 -NonInteractive -AllowWslInstall -Agent claude -Telemetry off` (it installs WSL if missing but never restarts the machine by itself).

For what each part does in detail, see [Agent boxes](agent-boxes.md) and [Getting started](getting-started.md).
