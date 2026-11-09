# Move an install from Windows (WSL) to a Mac

This moves an Agora install that runs in a WSL distro on Windows to a Mac, with everything it holds: the database, the encrypted files, every agent's box (logins and repos) and `.env.prod` with its `AGORA_ENCRYPTION_KEY`. It uses Agora's own backup and restore ([installing.md](installing.md#backups-upgrades-removal)): one bundle, encrypted with a passphrase you choose, carried from one machine to the other. Nothing is uploaded anywhere, and no secret is printed.

> **Status (2026-11-09):** written, not yet run. Backup and restore are tested on Linux in CI; the Mac side is new ([macos.md](macos.md)). Keep the Windows install until the Mac one has run for a while (step 9).

The commands below assume the distro is `Ubuntu` and the install is in `~/agora`, started with the tailnet override. Change those names if yours differ. PowerShell commands are for Windows PowerShell 5.1; the Mac ones for Terminal (zsh).

## Before you start

- The Mac has Agora's prerequisites: [macos.md, "What you need"](macos.md#what-you-need).
- About 30 minutes when Agora isn't needed: agents stop at step 3 and run again from step 6.
- The Mac installs the latest Agora. Restore brings an older database forward (its migrations run), never back, so the Mac must not have an older release than Windows. It won't, unless you install an old one on purpose.

## 1. On Windows: note the install's name and settings

```powershell
wsl -d Ubuntu --cd ~/agora --exec sh -c "grep -E '^(AGORA_INSTANCE|COMPOSE_PROJECT_NAME|DOMAIN|CORS_ORIGIN|WEBAUTHN_ORIGINS|TAILNET_WEB_PORT)=' .env.prod; grep -m1 version package.json"
```

None of these is a secret. Write down `AGORA_INSTANCE` (an install from before 2026-10 may show only `COMPOSE_PROJECT_NAME`: that is the name). The Mac install must get the same name; this guide assumes `agora`.

Also note your tailnet machine name from `wsl -d Ubuntu --exec tailscale status --self` (for example `agora-home`).

## 2. On Windows: stop host-mode agents

If you run `agora-host` on Windows (host-mode agents), stop it so it doesn't take work during the move. In the folder you installed it from:

```powershell
node dist\index.js autostart disable
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*agora-host*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
```

(If you installed it globally, `agora-host autostart disable` does the same as the first line.)

## 3. On Windows: back up, then stop the Windows install

```powershell
wsl -d Ubuntu --cd ~/agora --exec bash install/backup.sh
```

It asks for a passphrase twice. **Choose a new one and keep it out of the file's way**: it's the only thing that opens the bundle, and the bundle holds your encryption key. Agora stops while the backup runs and starts again after. The last line names the file, `backups/agora-agora-<time>.agorabk`.

Then stop the Windows install, so nothing changes there after the backup (its data stays; step 9 removes it):

```powershell
wsl -d Ubuntu --cd ~/agora --exec sh -c "docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod stop; docker ps -q --filter label=org.agora.instance=agora | xargs -r docker stop"
```

The second half stops the agent boxes, which run outside Compose. Containers stopped this way stay stopped after a reboot.

## 4. Carry the bundle to the Mac

Copy it out of the distro, then to the Mac. Replace `<file>` with the name from step 3:

```powershell
wsl -d Ubuntu --cd ~/agora --exec cp "backups/<file>" "/mnt/c/Users/$env:USERNAME/Downloads/"
scp "$HOME\Downloads\<file>" <mac user>@<mac name>.local:Downloads/
```

`scp` needs **Remote Login** on the Mac (System Settings → General → Sharing). Over Tailscale, use the Mac's tailnet name instead of `<mac name>.local`. A USB stick works too. Never send the passphrase with the file. Delete the Windows copy afterwards: `Remove-Item "$HOME\Downloads\<file>"`.

## 5. On the Mac: install Agora with the same name and no agent

```bash
git clone https://github.com/CaffeinatedSoftwareLLC/agora.git ~/agora-src
cd ~/agora-src
bash install/macos/install.sh --instance agora --agent none --at-boot
```

`--agent none`: the restore brings your agents and their boxes back. `--at-boot`: the VM starts at boot, before anyone logs in (sudo once); leave it out on a Mac you log in to. Give the VM memory for your boxes: 8 GiB is the default on a 16 GB Mac; on a 24 or 32 GB Mac that also runs local models, 10 to 12 is a reasonable start.

The installer creates a throwaway admin for the fresh install; the restore replaces it with your own accounts. A generated password is fine here.

## 6. On the Mac: restore

```bash
cd ~/agora-src
bash install/macos/agora-vm.sh restore ~/Downloads/<file>
```

It copies the bundle into a private folder in the VM, asks for the passphrase and for the install's name as confirmation, then replaces the fresh install's database, files and boxes with the bundle's, and `.env.prod` with yours. It keeps the Mac's ports, and adds `https://localhost:8443` to `CORS_ORIGIN` (and to `WEBAUTHN_ORIGINS` if you had set it), since the Mac's web port isn't 443. Every box token and every edge approval from before the backup stops working; boxd rebuilds the boxes, for this Mac's arm64 CPU, with fresh tokens and the same logins and repos.

Then check, and remove the bundle from Downloads once you have kept it somewhere safe:

```bash
bash install/macos/agora-vm.sh doctor
open https://localhost:8443
```

Log in with your **own** account (not the throwaway admin of step 5). Your channels, threads, files and agents are there; mention a boxed agent and see it answer.

**Box homes are moved as they were.** Things an agent built inside its box for an x86 CPU (a repo's `node_modules`, a Python `.venv`, binaries in `~/.local/bin`) won't run on the Mac's arm64 CPU. The CLIs themselves come with the new box image, so this only affects what the agents installed. Ask each agent to reinstall its repos' dependencies (`npm ci`, `pip install -r ...`) the first time a build fails.

## 7. On the Mac: Tailscale in the VM (phone access)

Do [remote-access.md](remote-access.md) steps 1, 4, 5 and 6 inside the VM (`bash install/macos/agora-vm.sh shell`). To keep the phone's address, give the VM the old machine name:

1. In the Tailscale admin console, **remove** the old WSL machine (or rename it), so its name is free.
2. In the VM: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up --hostname agora-home` (the name from step 1).
3. In the policy (Access controls), set `agora-home` in `hosts` to the VM's new address (`tailscale ip -4` in the VM).
4. `.env.prod` already has your `CORS_ORIGIN` and `TAILNET_WEB_PORT`. Restart with the override, in the install folder in the VM:
   ```bash
   docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d
   sudo tailscale serve --bg http://127.0.0.1:8080
   ```
5. Check from the phone, on Wi-Fi and on mobile data.

The push relay and the phone apps keep working: their registration is in the restored database and `.env.prod`.

## 8. On the Mac: host-mode agents (optional)

Only if you used `agora-host` on Windows. On the Mac, install the CLIs you host and `agora-host` and `agora-mcp` from the GitHub release tarballs, then write the host config again with Mac paths (the Windows config's `executable`, `workdir` and `stateDir` are Windows paths; its host token is the same, since the database is). Each profile's CLI logs in again on the Mac: subscription logins don't move between machines. Then:

```bash
agora-host autostart enable --config "$HOME/.agora-host/host.json"
```

## 9. Later, on Windows: remove the old install

When the Mac has run for a while and a backup from it restores (`agora-vm.sh backup`, then the restore test in [docs/testing/macos-test-plan.md](testing/macos-test-plan.md)), remove the Windows install. With `-Purge` this deletes its data, after you type its name:

```powershell
powershell -ExecutionPolicy Bypass -File install\windows\uninstall.ps1 -Distro Ubuntu -Purge
```

Run it from a checkout of Agora on Windows. It also removes the WSL keep-alive task. Your `Ubuntu` distro itself stays.

## If something goes wrong

- **The restore fails** before `restore.start`: nothing on the Windows side changed. Start the Windows install again (`... --env-file .env.prod up -d` in the distro, and `agora-host autostart enable` if you use it) and report the failure with `bash install/macos/agora-vm.sh doctor --report`.
- **Wrong passphrase:** the restore stops at `restore.verify` and changes nothing.
- **"this folder is install X, the bundle is Y":** the Mac install's name differs. Remove it (`bash install/macos/uninstall.sh --delete-vm`) and install again with `--instance Y`.
