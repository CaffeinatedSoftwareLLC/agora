# macOS release: test on a real Mac

The checks CI can't run: CI has no Mac that can start a VM (GitHub's macOS runners have no nested virtualization), so the macOS installer is tested there with Lima and launchd replaced by stubs, and gVisor, the box images and the sandbox on arm64 **Linux**. This plan runs the real thing on an Apple Silicon Mac. A Claude Code session on that Mac can run it from a fresh clone of `main`; the owner does the steps marked **(owner)**: anything with a password, a passphrase, a sign-in or sudo.

Write down, for every step: passed, failed (with the output), or not run. A step you couldn't run is open, not passed. Never paste a password, passphrase, token or `.env.prod` value into the results.

## 0. The machine

```bash
sw_vers; uname -m; sysctl -n hw.memsize hw.ncpu; df -h ~; pmset -g | grep -E ' sleep |autorestart'
brew --version; limactl --version || echo 'no lima'
limactl list; ls ~/.agora/macos 2>/dev/null
```

Expect arm64, macOS 13.5 or later. If `limactl list` shows a VM named `agora`, or `~/.agora/macos` exists, an earlier attempt is there: ask the owner whether to remove it (`bash install/macos/uninstall.sh --delete-vm`) before going on. Note what else runs on the Mac (Hermes, Ollama and its models, Docker Desktop): the VM takes memory from them.

## 1. Clean install, interactive (owner)

```bash
git clone https://github.com/CaffeinatedSoftwareLLC/agora.git ~/agora-src && cd ~/agora-src
bash install/macos/install.sh
```

Answer: telemetry **n**, install Lima **y** (if asked), VM size: defaults, create **y**, then in the Linux installer: admin `admin`, Enter for a generated password, agent `claude`.

Expect, in order: `[mac.preflight]` ok; `[mac.lima]` ok with Lima 2.x; `[mac.keepalive]` LaunchAgent (written before the VM exists, so the sudo of `--at-boot` is still fresh); `[mac.vm]` ports `https 8443, http 8000, api 3000`, the image download, `created and started agora`, `inside: ubuntu 24.04 aarch64`; the Linux installer's steps, including `[gvisor.check] ... runsc works` (**the first proof that gVisor runs in a Lima VM on Apple Silicon**), `[box.start] box claude is running`; then the browser opens `https://localhost:8443`.

Record: total time, and the time of the stack build alone.

```bash
bash install/macos/agora-vm.sh status
bash install/macos/agora-vm.sh doctor          # every line ok, or note what isn't
cat ~/.agora/macos/agora.yaml                  # no mounts, three forwards, then ignore
limactl shell agora sh -c 'sudo docker info --format "{{json .Runtimes}}"; sudo docker run --rm --runtime=runsc alpine uname -r'
```

The `uname -r` must end in `-gvisor`. (`sudo`: Lima keeps one SSH connection to the VM open, so the `docker` group the installer gave your user applies only after `limactl stop agora && limactl start agora`; the installer's own scripts fall back to sudo by themselves.) Note the runsc version (`limactl shell agora runsc --version`) and the platform (`limactl shell agora sh -c 'cat /etc/docker/daemon.json'`, no `--platform` means systrap).

**The VM can't reach the Mac's loopback:** start something on the Mac's 127.0.0.1 only, then try it from the VM and from a container in it. Both must fail at once (connection refused), and the internet must still work:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 &          # on the Mac
limactl shell agora curl -m3 -sS http://host.lima.internal:8765/ && echo 'FAIL: reachable'
limactl shell agora sudo docker run --rm alpine:3.20 wget -T3 -qO- http://192.168.5.2:8765/ && echo 'FAIL: reachable'
limactl shell agora curl -m5 -sS -o /dev/null -w '%{http_code}\n' https://github.com   # 200
kill %1
limactl shell agora sudo iptables -S AGORA-HOST
```

Run this right after the install, **before any reboot**: the containers' rule must already be there (`limactl shell agora sudo iptables -S DOCKER-USER` shows `-j AGORA-HOST`). After the reboot in step 4, run the first two again: still refused. Then check a bad allow line fails closed: `limactl shell agora sh -c 'echo 99999 | sudo tee -a /etc/agora/host-allow-ports; sudo systemctl restart agora-host-firewall; sudo journalctl -u agora-host-firewall -n 3'` logs a skipped line, and the two checks above are still refused. Remove the line afterwards.

**The VM's files are private:** `stat -f '%Sp %N' ~/.lima/agora ~/.lima/agora/*disk*` shows `drwx------` for the folder; no disk file is readable by others (`-rw-------` or under the 700 folder). `tmutil isexcluded ~/.lima/agora` says `[Excluded]` if the owner said yes to the Time Machine question.

**Nothing outside 127.0.0.1:** `lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8000|8443|3000) '` shows only `127.0.0.1`. From another machine on the network, `https://<mac's LAN address>:8443` must not load.

## 2. A code run

In Agora (owner): Settings → the bot's **Code runs** on; ask the agent in `#general` to run a short script (for example, print `uname -a` and 2+2 with the run code tool).

Expect the result in the thread, and in the VM:

```bash
limactl shell agora sh -c 'cd ~/agora && sudo docker compose -f docker-compose.prod.yml --env-file .env.prod logs runner | grep -m3 -i runtime'
```

shows `runtime=runsc`, with no `INSECURE` flag. If the run's output shows a kernel, it ends in `-gvisor`.

## 3. A box: login and wake (owner)

1. Settings → Agents → **Log in** on the `claude` box; follow the link, paste the code. Expect **Logged in**.
2. Mention the agent in `#general` with a small task (for example: "list the files in your home and say hello"). Expect an answer within a minute or two.
3. Make a second box with Codex (Settings → Agents → New agent, boxed, Codex), log it in with the device code, wake it the same way.
4. In the VM, check each box runs under gVisor:
   ```bash
   limactl shell agora sh -c 'for c in $(sudo docker ps -q --filter label=org.agora.instance=agora); do sudo docker inspect -f "{{.Name}} {{.HostConfig.Runtime}}" $c; done'
   ```
   Every box shows `runsc`.
5. If the owner has them: opencode, omp and Devin boxes the same way (each one's `--version` ran when the image was built, so the image itself works on arm64; this checks login and a wake).

## 4. Restart recovery

1. **Reboot the Mac** (owner), log in, wait 5 minutes. Then `bash install/macos/agora-vm.sh status` shows `Running`, `doctor` passes, and an agent answers a mention. Record how long until `http://localhost:3000/health` answered after login.
2. **The keep-alive heals:** `limactl stop agora`; within 5 minutes `limactl list` shows it `Running` again (`tail ~/.agora/macos/agora-keepalive.log` says it started it).
3. **A paused keep-alive stays paused:** `bash install/macos/agora-vm.sh stop`, wait 6 minutes, still `Stopped`. Then `bash install/macos/agora-vm.sh start`.
4. **At boot, without a login** (owner, sudo): `bash install/macos/agora-vm.sh keepalive daemon`. Check `/Library/LaunchDaemons/com.agora.vm.agora.plist` exists and `~/Library/LaunchAgents/com.agora.vm.agora.plist` is gone. Turn off automatic login if it is on, reboot, **don't log in**, and from another device (SSH to the Mac, or Tailscale once step 7 of the migration guide is done) check that `curl -fsS http://127.0.0.1:3000/health` on the Mac answers within 5 minutes of the boot. Afterwards keep whichever mode the owner wants (`keepalive agent` goes back).

## 5. Backup and restore

```bash
bash install/macos/agora-vm.sh backup                       # (owner: passphrase)
ls -l ~/Agora\ Backups/
```

The file is mode `-rw-------`. Then post a message `before-restore-marker` in `#general`, and restore the backup (owner: passphrase, type `agora`):

```bash
bash install/macos/agora-vm.sh restore ~/Agora\ Backups/<file>
```

Expect the restore to finish with `restored; boxd now rebuilds the boxes with fresh tokens`, the marker message gone, the boxes `running` again within a few minutes, still logged in, and an agent answering a mention. `bash install/macos/agora-vm.sh shell grep -c localhost:8443 .env.prod` prints at least 1 (CORS_ORIGIN kept the Mac's port).

## 6. Migration from Windows (owner, when moving for real)

Follow [docs/migrate-to-macos.md](../migrate-to-macos.md) and record each step's result the same way. After step 6 there, also check: files uploaded on Windows open on the Mac (the encryption key moved), an old thread's history is there, and a boxed agent answers.

## 7. Removal

```bash
bash install/macos/uninstall.sh                 # containers only; the VM stays
bash install/macos/uninstall.sh --delete-vm     # owner: type agora
limactl list; ls ~/Library/LaunchAgents/com.agora.vm.* /Library/LaunchDaemons/com.agora.vm.* 2>&1
```

Expect no VM and no plist. Lima stays (`brew uninstall lima` is up to the owner).

## Report

Put the results in an issue titled "macOS release: real-Mac test <date>", or hand them back to the session that asked for the test. Include: macOS version, chip, memory, Lima version, runsc version, each step's result, the timings, and the output of every failed step (run it through `install/macos/agora-vm.sh doctor --report`'s redaction if it might hold a secret).
