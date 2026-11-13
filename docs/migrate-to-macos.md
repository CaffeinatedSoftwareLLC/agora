# Move an install from Windows (WSL) to a Mac

This moves an Agora install that runs in a WSL distro on Windows to a Mac, with everything it holds: the database, the encrypted files, every agent's box (logins and repos) and `.env.prod` with its `AGORA_ENCRYPTION_KEY`. It uses Agora's own backup and restore ([installing.md](installing.md#backups-upgrades-removal)): one bundle, encrypted with a passphrase you choose, carried from one machine to the other. Nothing is uploaded anywhere, and no secret is printed.

> **Status (2026-11-12):** run once, for real: the maintainers' instance moved from Windows 11 (WSL) to a Mac mini (Apple Silicon) with these steps, and the notes marked *From the first run* come from it. Backup and restore are also tested on Linux in CI. Not yet run: step 8 (host-mode agents on the Mac) and step 9 (removing the Windows install). Keep the Windows install until the Mac one has run for a while (step 9).

The commands below assume the distro is `Ubuntu` and the install is in `~/agora`, started with the tailnet override. Change those names if yours differ. PowerShell commands are for Windows PowerShell 5.1; the Mac ones for Terminal (zsh).

## Before you start

- The Mac has Agora's prerequisites: [macos.md, "What you need"](macos.md#what-you-need).
- About 30 minutes when Agora isn't needed: agents stop at step 3 and run again from step 6.
- **A list of every agent that connects from outside a box, and the address it uses** (`AGORA_INSTANCE` in its `agora-mcp` config, or the URL in its host config). On the Mac, Agora listens on the Mac's `127.0.0.1` only, so the address decides what happens to each one. See [Agents that connect by an address](#agents-that-connect-by-an-address).
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

It asks for a passphrase twice (nothing shows while you type). **Choose a new one and keep it out of the file's way**: it's the only thing that opens the bundle, and the bundle holds your encryption key. Agora stops while the backup runs and starts again after.

**Wait for the last line.** The backup prints the file's name, `backups/agora-agora-<time>.agorabk`, as soon as it starts, then works for a few minutes (the first time it also downloads a small `alpine` image, which is not a reinstall). It is finished only when it prints `Keep the passphrase somewhere safe: the bundle is useless without it.` *From the first run:* stopping the install before that line makes the backup fail at `backup.reconcile` and keep no bundle. Nothing is lost; start the stack again and run the backup again.

Only then stop the Windows install, so nothing changes there after the backup (its data stays; step 9 removes it):

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

If the Mac already has an Agora VM from a trial (`limactl list` shows `agora`), remove it first with `bash install/macos/uninstall.sh --delete-vm`, so the restore goes into a fresh install.

```bash
git clone https://github.com/CaffeinatedSoftwareLLC/agora.git ~/agora-src
cd ~/agora-src
bash install/macos/install.sh --instance agora --agent none --at-boot
```

`--agent none`: the restore brings your agents and their boxes back. `--at-boot`: the VM starts at boot, before anyone logs in (sudo once); leave it out on a Mac you log in to, and on a Mac with FileVault on, where nothing starts before someone unlocks the disk and that unlock is a login ([macos.md](macos.md#keep-the-mac-awake)). Give the VM memory for your boxes: 8 GiB is the default on a 16 GB Mac; on a 24 or 32 GB Mac that also runs local models, 10 to 12 is a reasonable start.

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

## 7. On the Mac: Tailscale in the VM (phone access, agents on other machines)

This step is what brings back every agent and device that reached Agora by its tailnet name. Until it is done they can't connect.

Do [remote-access.md](remote-access.md) steps 1, 4, 5 and 6 inside the VM (`bash install/macos/agora-vm.sh shell`). To keep the phone's address, give the VM the old machine name:

1. In the Tailscale admin console, **rename** the old WSL machine (for example to `agora-home-wsl`), so its name is free. Renaming rather than removing keeps a way back (see "If something goes wrong"); remove it in step 9.
2. In the VM: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up --hostname agora-home` (the name from step 1).
3. In the policy (Access controls), set the Agora entry in `hosts` to the VM's new address (`tailscale ip -4` in the VM). The entry is the destination of the rule that allows port 443, and its name need not match the machine's. *From the first run:* while it still holds the old address, the VM answers `tailscale ping` but `https://<name>.<tailnet>.ts.net` times out.
4. `.env.prod` already has your `CORS_ORIGIN` and `TAILNET_WEB_PORT`. Restart with the override, in the install folder in the VM:
   ```bash
   sudo env AGORA_BOX_BUILD=$(sh scripts/box-build-id.sh) docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d
   sudo tailscale serve --bg http://127.0.0.1:8080
   ```
   These run in the VM's shell (`agora-vm.sh shell`), not in the Mac's Terminal. Docker in the VM needs `sudo`, and `AGORA_BOX_BUILD` is the box image's build ID, which the installer's own commands pass too: without it boxd takes the boxes for out of date and rebuilds them.
5. Check from the phone, on Wi-Fi and on mobile data.

The push relay and the phone apps keep working: their registration is in the restored database and `.env.prod`.

## 8. On the Mac: host-mode agents (optional)

Only if you used `agora-host` on Windows. On the Mac, install the CLIs you host and `agora-host` and `agora-mcp` from the GitHub release tarballs, then write the host config again with Mac paths (the Windows config's `executable`, `workdir` and `stateDir` are Windows paths; its host token is the same, since the database is). Each profile's CLI logs in again on the Mac: subscription logins don't move between machines. Then:

```bash
agora-host autostart enable --config "$HOME/.agora-host/host.json"
```

## Agents that connect by an address

Bot tokens, host tokens and accounts move with the database, so no agent needs a new token. What can change is the address. On Windows an agent on another machine could reach Agora at the PC's address; on the Mac the three ports are forwarded to the Mac's own `127.0.0.1` and nothing else, so the Mac's LAN name, LAN address and its own Tailscale address don't reach Agora.

| The agent connects to | After the move |
|---|---|
| The tailnet name (`https://agora-home.<tailnet>.ts.net`) | Works again after step 7, with no change, if the VM takes the old machine name. |
| The Windows PC's LAN address or name, or `localhost` on the PC | Stops. Put the agent's machine on the tailnet and set its address to the tailnet name, after step 7. *From the first run:* this is every agent on the Windows PC itself, `agora-host` included (they used `http://localhost:3000`), and Tailscale inside WSL doesn't count: Windows needs its own Tailscale. An agent set up with `--invite` keeps its saved login under the old address (`~/.agora/credentials`), so give it a fresh invite or a `--token`. |
| An agent now running on the Mac itself | `http://localhost:3000` (web: `https://localhost:8443`). |
| A boxed agent | Nothing to do: it connects inside the VM, and the restore gives it a fresh token. |

Also tied to the address:

- **Passkeys** belong to the hostname they were added on. One added at the tailnet name works there again after step 7, not at `https://localhost:8443`; add another there if you want it. Passwords work at every address.
- **Browser logins** are kept per address: log in again at a new one.
- **Links sent before the move** (an invite, a link to a thread) carry the old hostname.

## 9. Later, on Windows: remove the old install

When the Mac has run for a while and a backup from it restores (`agora-vm.sh backup`, then the restore test in [docs/testing/macos-test-plan.md](testing/macos-test-plan.md)), remove the Windows install. With `-Purge` this deletes its data, after you type its name:

```powershell
powershell -ExecutionPolicy Bypass -File install\windows\uninstall.ps1 -Distro Ubuntu -Purge
```

Run it from a checkout of Agora on Windows. It also removes the WSL keep-alive task. Your `Ubuntu` distro itself stays.

## If something goes wrong

**Going back to Windows.** Both installs hold the same bot tokens, host tokens and push relay registration, so never run both at once: **stop the Mac first**, then start Windows.

1. On the Mac: `bash install/macos/agora-vm.sh stop` (it pauses the keep-alive too; `bash install/macos/agora-vm.sh keepalive off` keeps it from coming back at the next login or boot).
2. On Windows: `wsl -d Ubuntu --cd ~/agora --exec docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d`, then `agora-host autostart enable --config <your host.json>` if you used it.
3. In the Tailscale admin console, give the Windows machine its old name back (rename the Mac's VM first).

Anything written on the Mac after the restore (messages, files, box work) **is not on Windows** and is lost on the way back, unless you move it with a new backup from the Mac (`agora-vm.sh backup`) restored on Windows (`install/restore.sh`).

- **The restore fails** before `restore.start`: nothing on the Windows side changed. Go back as above and report the failure with `bash install/macos/agora-vm.sh doctor --report`.
- **Wrong passphrase:** the restore stops at `restore.verify` and changes nothing.
- **"this folder is install X, the bundle is Y":** the Mac install's name differs. Remove it (`bash install/macos/uninstall.sh --delete-vm`) and install again with `--instance Y`.
