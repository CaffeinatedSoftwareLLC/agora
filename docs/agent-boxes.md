# Agent boxes: the boundary contract

Status: **design for review** (2026-11-04). Nothing here is built yet; sections marked *verify live* need a real login or a real machine that CI can't give.

Each agent that writes files or runs commands gets its own **box**: a persistent gVisor container that holds the agent's CLI, its login, its home folder and its clones of the repos it works on. Inside the box the agent runs without per-command prompts. Agora asks the owner only at the box's edges:

1. a network domain the box hasn't been allowed to reach,
2. a `git push` or a pull request (auto-allow per channel),
3. host mode: running an agent unboxed, on the machine itself.

This document is the contract the box runner, the edge, agora-host and the installer are built against, and what the isolation tests check. It builds on the code-run sandbox ([planning/sandbox-isolation-spec.md](planning/sandbox-isolation-spec.md)), which stays as it is: a run is a throwaway container with no network; a box is a long-lived container with a brokered network.

## 1. Terms

| Term | Meaning |
|---|---|
| **Box** | One persistent container for one agent profile: `<instance>-box-<boxId>`. |
| **Instance** | One Agora install on one Docker engine. `AGORA_INSTANCE` (default `agora`) prefixes every container, network and volume it creates (#209). |
| **boxd** | The box runner: a stack service that creates, starts, upgrades and removes boxes. The only box component with Docker access. |
| **edge** | The box edge: a stack service on every box network. The box's only way out: to Agora's API, to allowed domains, and to the git and GitHub brokers. |
| **Edge request** | A pending approval for a domain, a push or a pull request. Shown as a card in the box's home channel and as a phone notification. |
| **Host mode** | An agent run by agora-host directly on the machine, as today. Marked **unboxed**, owner-only, opt-in per agent. |

## 2. Components and trust

```
                        internet
                           ▲
                           │ allowed domains only (CONNECT), SSRF-guarded
┌──────── default network ─┼────────────────────────────────────────┐
│ api ── postgres ── redis │   boxd ──► box-socket-proxy ──► docker │
│  ▲                       │    (reconciler, provisioning)          │
│  │ http (X-Agora-Edge-*) │                                        │
│  └──────────────────── edge ◄──────────────────────────────────┐  │
└──────────────────────────┼─────────────────────────────────────┼──┘
              ┌────────────┴───────┐                  ┌──────────┴─────────┐
              │ <inst>_box_A (/28, │                  │ <inst>_box_B (/28, │
              │ internal: true)    │                  │ internal: true)    │
              │ edge .2   box A .3 │                  │ edge .2   box B .3 │
              └────────────────────┘                  └────────────────────┘
              volume <inst>-box-A-home                volume <inst>-box-B-home
```

| Zone | Trust | Holds | Never holds |
|---|---|---|---|
| `api`, `postgres`, `redis` | High | everything Agora stores | Docker access |
| `boxd` | High (Docker access through its own socket proxy) | DB access to box rows, host and bot token minting | untrusted input: it reads only DB rows and Docker API replies, never traffic from a box |
| `box-socket-proxy` | — | a Docker API allowlist for `<instance>-box-*` names | anything else (see §7.2) |
| `edge` | Medium: parses traffic from boxes | DB access (box rows, allowlists, edge requests), `AGORA_ENCRYPTION_KEY` (to decrypt the owner's GitHub token for one request), `AGORA_EDGE_SECRET` | Docker access |
| a box | **Untrusted** (yeet mode) | its own bot token, its own host token, its own CLI login, its home folder | any other box's anything; any Agora secret; any GitHub or registry credential |

boxd and edge are separate services on purpose: the component that talks to Docker never parses what a box sends, and the component that parses it can't touch Docker. This mirrors `runner` and `cap-gateway` in the sandbox spec.

## 3. The per-box boundary

### 3.1 Storage and writable mounts

| Path in the box | Backed by | Writable | Survives |
|---|---|---|---|
| `/home/agent` | named volume `<instance>-box-<boxId>-home` | yes | restart, rebuild, upgrade. Removed only by **Reset** or uninstall with `--purge` |
| `/tmp` | tmpfs, 1 GB | yes | nothing |
| everything else (image) | read-only root filesystem | no | replaced on upgrade |

- The home folder holds the CLI state (`~/.agora/state/<profile>`: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`), the repos (`~/work/<repo>`), session worktrees (as agora-host makes them today), and anything the agent installs for itself (`~/.local`, `~/.npm-global`, `~/.cache`).
- **No bind mounts, ever.** boxd's socket proxy rejects them (§7.2). No host path, no Docker socket, no other box's volume is visible in a box.
- Nothing is shared between boxes: no common cache volume. Two boxes that both need a package download it twice; that is the price of not having a channel between them.
- Tools an agent installs system-wide don't exist: the root filesystem is read-only and there's no `sudo`. The box's `AGENTS.md`/`CLAUDE.md` says to install under the home folder.

### 3.2 Credentials

| Credential | Where it lives | Who can read it | Lifetime |
|---|---|---|---|
| **Host token** (`ah_…`, one per box) | env of the box's container, set by boxd at create | the box (its own token only); anyone with Docker access | until the box is rebuilt or deleted, then revoked |
| **Bot token** (`bot_…`, one per box) | same | same | same; also bound to the box at the API (§4.1) |
| **CLI login** (Claude, Codex) | `/home/agent/.agora/state/<profile>` | the box | until logout or Reset |
| API key (`api_key` profiles) | env of the container, from an encrypted per-box secret in the DB | the box | until changed or the box is rebuilt |
| Owner's GitHub token | `box_github_credentials`, encrypted with `AGORA_ENCRYPTION_KEY` | edge, for one upstream request at a time | until the owner replaces or removes it |
| `AGORA_EDGE_SECRET` | edge and api env | edge, api | rotated by restarting both with a new value |

Rules:
- A box gets exactly one bot token and one host token, both minted by boxd for that box. **Rebuild mints new ones and revokes the old ones in the same transaction** that records the new container.
- The host token's host has exactly one profile: the box's. It can claim only that profile's runs.
- Inside the box, agora-host and the CLI run as the same user (`agent`, uid 1000). So **the agent can read its own box's host and bot token**. That is accepted: both are scoped to its own identity, and the edge refuses them from any other box (§4.1). The evidence contract (later) must treat anything the box reports, including verify results, as "agent says", not as trusted-runner evidence.
- The CLI never sees the host token: agora-host builds the child's environment from an allowlist (as today, `childEnv`), plus the proxy variables (§4.2).
- No GitHub, registry or provider credential other than the profile's own API key enters a box. Git and pull requests go through brokers that add the owner's token on the way out (§5).
- CLI logins happen inside the box (§8.2). agora-host never copies a login between boxes or from the host.

### 3.3 Network identity

- Each box has **its own Docker network** `<instance>_box_<boxId>`: `internal: true`, a /28 subnet that boxd picks from `AGORA_BOX_SUBNETS` (default `10.213.0.0/16`), skipping every subnet any network on the engine already uses, so a second install on the same engine never overlaps (#209). The edge is `.2`, the box is `.3`.
- Members: the edge and that one box. No other box, no `api`, no `postgres`.
- **Identity is the network the connection arrived on**: the edge maps its own local address on that network to the box. A source address check (`.3`) is a second layer. A box has no `NET_ADMIN`, so it can't change its address.
- Under gVisor a box has no DNS (gVisor issue 7469, sandbox spec §6). boxd pins `edge` to the edge's `.2` address in the box's `/etc/hosts` (`ExtraHosts`). Everything else is resolved by the edge.
- The box reaches:
  - Agora at `http://edge:8080` (reverse proxy to `api:3000`, REST and WebSocket),
  - the internet through `HTTPS_PROXY=http://edge:3128` (CONNECT) for allowed domains only,
  - git at `http://edge:8080/git/<host>/<owner>/<repo>.git`,
  - GitHub's REST API, read-only and for attached repos, at `http://edge:8080/github/…`, and pull requests through it (§5.3).

## 4. The edge

### 4.1 Agora traffic

- The edge forwards `http://edge:8080/*` (except `/git/` and `/github/`) to `api:3000`, WebSocket upgrades included.
- It **removes** any incoming `X-Agora-Edge-*` and `X-Forwarded-*` headers and adds:
  - `X-Forwarded-For: <box address>`,
  - `X-Agora-Edge-Box: <boxId>`,
  - `X-Agora-Edge-Sig: HMAC-SHA256(AGORA_EDGE_SECRET, boxId + "\n" + timestamp)` and `X-Agora-Edge-Ts`.
- The API checks those headers in its auth step. On a request that carries a valid edge signature, **the authenticated principal must be the box's own bot or host**; any other bot token, host token or user token is refused with `403 token_not_for_this_box`, written to the bot's audit trail and posted to the owner once per hour per box. This is what makes a stolen token useless from another box, and it covers the WebSocket handshake, which the edge can't parse.
- A request without edge headers is an ordinary request (a host-mode agent, the browser). A request with headers that don't verify is refused (`403 bad_edge_signature`).

### 4.2 The internet: domain allowlist

- The box's CLI, `git`, `npm`, `pip` and `curl` use `HTTPS_PROXY`/`HTTP_PROXY=http://edge:3128` (`NO_PROXY=edge`). Node's own `fetch` in agora-host and agora-mcp doesn't use a proxy, and doesn't need one: they only talk to `edge`.
- The edge allows `CONNECT host:port` (port 443, or 80 for plain HTTP requests) when `host` matches the box's allowlist: exact names or `*.example.com` suffixes, no IPs, no wildcard-all.
- **Default allowlist**, set when the box is created:
  - the adapter's provider: Claude `api.anthropic.com`, `claude.ai`, `console.anthropic.com`, `statsig.anthropic.com`; Codex `api.openai.com`, `chatgpt.com`, `auth.openai.com`,
  - package registries: `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`.
- `github.com` is **not** on it: git goes through the git broker (§5.1), which is the only path with credentials.
- **SSRF guard:** after resolving `host`, the edge refuses private, loopback, link-local and Docker-internal addresses (the existing `src/lib/url-guard.ts` rules), so an allowed name that resolves to `postgres` or another box can't be used to reach it.
- **Unknown domain:** the edge answers `403` with `X-Agora-Edge-Request: <requestId>` and a one-line body (`domain example.com needs the owner's approval; request <id> was sent`). It records a pending `domain` edge request (deduplicated per box and domain while pending) and posts the card. **Allow** adds the domain to that box's allowlist; **Deny** keeps it out and suppresses new cards for that domain for 24 hours. The agent retries after approval; nothing is held open.
- Search: boxes get no open web. An agent searches through Agora (the assistant's search route, screened by the decision model where it's on) using its Agora tools, as today.

### 4.3 Edge requests and approvals

- Table `box_edge_requests`: `kind` (`domain`, `push`, `pr`), `box_id`, `subject` (domain; `repo ref old..new`; `repo head→base`), `status` (`pending`, `allowed`, `denied`, `expired`), `decided_by`, timestamps.
- The card goes to the box's **home channel** (chosen when the box is created; the channel its agent works in) and as a notification to the owner's phone. Only the **server owner** decides edge requests. Pending requests expire after 24 hours.
- Every decision is in the audit log (`box_edge_allow`, `box_edge_deny`).

## 5. Git and pull requests: the brokers

Repos are attached to a box when it's created or later in its settings (`owner/repo` on github.com in v1). boxd's first start of the box clones each one into `~/work/<repo>` through the git broker. GitHub stays the remote.

### 5.1 Fetch and clone

- The box's `origin` is `http://edge:8080/git/github.com/<owner>/<repo>.git`.
- `GET …/info/refs?service=git-upload-pack` and `POST …/git-upload-pack` are forwarded to `https://github.com/<owner>/<repo>.git` with the owner's GitHub token added (`Authorization: Basic x-access-token:<token>`). No approval: reading is allowed for attached repos.
- A repo that isn't attached to the box: `404`.

### 5.2 Push

- `GET …/info/refs?service=git-receive-pack` is forwarded with the token (git needs the remote's refs before it pushes).
- `POST …/git-receive-pack`: the edge reads the command pkt-lines at the start of the body (`<old> <new> <ref>`), then:
  - **Allowed** if the home channel's policy auto-allows pushes for this box, or there's an `allowed` push request for exactly this box, repo, ref and new SHA. The body (the buffered head plus the rest of the stream) is forwarded upstream with the token, and the reply streamed back.
  - **Otherwise** the edge drains the body, records a pending `push` request and answers with a valid receive-pack report: `ng <ref> push needs the owner's approval (request <id>); push again after it's approved`. git prints that as `! [remote rejected]`.
- An approval is for **one ref at one SHA**. New commits need a new approval: approval resets when the head changes.
- Deleting a ref (`new` is all zeros) and force-updates of the repo's default branch always need approval, even with auto-allow.
- Push auto-allow is per channel and per box, set by the owner on the card (**Always allow pushes from this box here**) or in the box settings.

### 5.3 Pull requests and GitHub reads

- `GET http://edge:8080/github/repos/<owner>/<repo>/…`: forwarded to `api.github.com` with the token, for attached repos and `GET` only (status checks, runs, PR state).
- `POST http://edge:8080/github/repos/<owner>/<repo>/pulls` with `{ title, body, head, base, draft }`: a `pr` edge request, decided like a push (auto-allowed when the channel auto-allows PRs for this box). When allowed, the edge creates the PR with the token and returns GitHub's reply. When not yet allowed, `403` with the request ID; the agent asks again after approval.
- The image ships `agora-pr` (`agora-pr create --title … --body-file … --base main`, `agora-pr status <n>`) so agents don't need `gh` or a token.
- Nothing else on GitHub's API is reachable from a box.

## 6. Box images

- Built from `box/Dockerfile`: Debian slim, Node 22, git, curl, jq, ripgrep, python3, build-essential, tini; the pinned Claude Code and Codex CLIs; agora-host and agora-mcp built from the same checkout; `agora-pr`; the box `AGENTS.md`/`CLAUDE.md`.
- **Versioned:** `box/VERSION` holds an integer. The image is tagged `agora/box:<VERSION>` and labelled `org.agora.box.version`. A change to the Dockerfile, the pinned CLIs or the in-box scripts bumps it.
- The CLI versions are pinned in the image, never auto-updated inside a box (agora-host refuses untested CLI versions, and a silent update would stop the agent).
- Built by the stack (`box-image` build-only service, like `sandbox-image`); two installs on one engine share a tag only when the content is the same version.

## 7. boxd

### 7.1 What it does

A reconcile loop, every 15 seconds and at start:

1. For each `agent_boxes` row: make sure the network, the edge's attachment (at `.2`), the volume and the container exist and match the row (image version, limits, allowlist hash, generation).
2. Create or recreate the container when something that needs it changed (§9). Start it if it should run; stop it if not.
3. Record `state`, `container_id`, `image_version`, `last_error`, `last_seen_at` on the row. Errors back off (15 s doubling to 10 minutes) and post one notice to the home channel.
4. Remove containers, networks and volumes labelled `org.agora.instance=<instance>` that no row claims, except volumes of deleted boxes during their 7-day grace period (§9.6).

The container template is built from constants plus the row; nothing from a request reaches Docker as a flag:

```
name           <instance>-box-<boxId>
image          agora/box:<VERSION>
runtime        runsc (runc only with AGORA_BOX_INSECURE_DEV=1: dev and CI without gVisor)
user           1000:1000
network        <instance>_box_<boxId>, ip .3
extra hosts    edge:<.2>
read-only      true;  tmpfs /tmp size=1g
volume         <instance>-box-<boxId>-home → /home/agent
cap-drop       ALL;   no-new-privileges
limits         cpus 2, memory 4g, pids 1024 (per box, owner-editable up to instance ceilings)
restart        unless-stopped
labels         org.agora.instance, org.agora.box, org.agora.box.version, org.agora.box.generation
env            AGORA_BOX_ID, AGORA_INSTANCE_URL=http://edge:8080, AGORA_HOST_TOKEN, AGORA_BOT_TOKEN,
               AGORA_BOX_PROFILE (name, adapter, auth), HTTPS_PROXY/HTTP_PROXY/NO_PROXY, the API key if any
```

### 7.2 Docker access

boxd reaches Docker only through its own `box-socket-proxy` (the same `wollomatic/socket-proxy` image the runner uses), which allows:
- `_ping`, `version`, `info`, `containers/json`, `networks` (list), `volumes` (list),
- create, start, stop, restart, kill, inspect, delete of containers named `<instance>-box-<ulid>`,
- create, inspect, connect, disconnect, delete of networks named `<instance>_box_<ulid>`,
- create, inspect, delete of volumes named `<instance>-box-<ulid>-home`,
- `images/<name>/json`.

No exec, no attach, no bind mounts (`-allowbindmountfrom` points nowhere), no image pulls or builds, nothing outside those names. The names include the instance, so one install's boxd can't touch another's boxes.

## 8. agora-host inside a box

### 8.1 Starting agents

- The box's entrypoint (tini → `agora-box-start`) writes agora-host's config from the env into `/run/agora/host.json` (tmpfs): `instance` = `http://edge:8080`, the host token, one profile (`workdir` = `~/work/<repo>`, `stateDir` = `~/.agora/state/<profile>`, the pinned CLI executables), the bot token. Then it runs agora-host, unchanged in how it claims, wakes and reports.
- So **each box is an agent host in Agora**, of kind `box`, with exactly one profile. Settings → Agents shows it with the box's state instead of "last seen on machine X".
- The child process gets the proxy variables in addition to agora-host's OS allowlist (new profile option `proxyEnv`, set only by the box config).
- **Yeet mode:** in a box, agora-host starts the CLI with its sandbox off and no permission prompts: Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`. That is allowed **only** when agora-host runs with `AGORA_HOST_IN_BOX=1` and the box marker file the image ships is present; on a machine, agora-host keeps refusing bypass flags as today. The box is the sandbox.
- Tool requests stop being needed for boxed agents: inside the box everything is allowed; the edges in §4–5 are the approvals.

### 8.2 Logging a CLI in, inside its box

The owner presses **Log in** on the box in Settings → Agents (or on the box's card in its home channel). Agora records a login request; the box's agora-host claims it (as it claims siwc plan requests today) and runs the CLI's own login with that profile's state directory:

| CLI | Command in the box | What the owner sees | Then |
|---|---|---|---|
| Codex | `codex login --device-auth` | the verification URL and the one-time code, in Agora | Codex finishes when the owner approves on OpenAI's page; the login is saved in the box's `CODEX_HOME` |
| Claude Code | `claude auth login --claudeai` | the sign-in URL, in Agora, and a box to paste the code Anthropic shows | the host writes the pasted code to the command's input; the login is saved in the box's `CLAUDE_CONFIG_DIR` |

- The URL, the device code and the pasted code pass through Agora only for the length of the login (10 minutes), are never logged and are deleted when it ends.
- The login is stored **only in the box's home volume**. It is never on the host, never in Agora's database, never in a backup that leaves the machine unencrypted (§9.4).
- `auth: "subscription"` boxes stay owner-only, as today: only the owner's messages wake them, only the owner can press Log in.
- *Verify live:* both commands in a box with a real account. CI checks the relay with fake CLIs that print the same prompts.

## 9. Lifecycle

| Action | Container | Home volume | Tokens | Logins | Who |
|---|---|---|---|---|---|
| **Create** | new | new | minted | none: Log in next | owner |
| **Restart** | same container, restarted | kept | kept | kept | owner, boxd on failure |
| **Rebuild** | removed and created again from the current image | kept | **rotated**: new host and bot token, old ones revoked | kept | owner; boxd on image upgrade |
| **Upgrade** | rebuild onto the new `box/VERSION` | kept | rotated | kept | boxd, after a stack upgrade |
| **Reset** | rebuilt | **wiped** (new empty volume) | rotated | gone | owner, with typed confirmation |
| **Delete** | removed | kept 7 days, then removed | revoked | gone with the volume | owner |

### 9.1 Upgrade (keeps the home folder)

`install/upgrade.sh` (also run by the Windows installer for an existing install): back up (§9.4) → fetch the new release → `docker compose build` → `up -d` → boxd sees boxes whose `image_version` is lower than `box/VERSION` and rebuilds them one at a time, waiting until no run is active in that box (at most 15 minutes, then it rebuilds anyway and the run is retried by the lease rules). Each upgrade posts a notice in the box's home channel with the old and new version.

Rollback: the previous image tag stays on the engine until the next upgrade; `install/upgrade.sh --rollback` restores the previous release and its backup.

### 9.2 Rebuild

Recreates the container from the image and the row, rotates both tokens. The fix for a box in a bad state that still has a good home folder.

### 9.3 Recovery

- Box process dies: tini exits, Docker restarts the container (`unless-stopped`); agora-host's lease rules retry the run.
- boxd dies: Docker restarts it; boxes keep running without it; it reconciles on start.
- edge dies or is recreated by a deploy: boxes lose their way out until it's back; boxd re-attaches it to every box network at `.2` (a recreated container loses networks attached at run time; the pinned address keeps every box's `/etc/hosts` correct, so boxes don't need restarting).
- Docker or the machine restarts: every container comes back by its restart policy; boxd reconciles; nothing needs the owner.
- A box that fails five starts in ten minutes is stopped with `last_error` and a notice; the owner rebuilds or resets it.

### 9.4 Backup (includes every box)

`install/backup.sh [dir]` writes a dated folder:
- `postgres.sql.gz` (`pg_dump`),
- `files-data.tar.gz`,
- `boxes/<boxId>-home.tar.gz` for **every** box volume of the instance (found by label, so none is missed),
- `env.prod` (it holds `AGORA_ENCRYPTION_KEY`; the folder is created mode 0700, and the script says to keep it as private as the key),
- `manifest.json`: instance, version, box IDs and image versions, SHA-256 of every file.

Boxes are stopped one at a time while their volume is archived (a few seconds each), so a CLI isn't writing its login mid-copy. `install/restore.sh <dir>` checks the manifest, restores the database, files and every box volume, then starts the stack; boxd rebuilds the boxes (new tokens), and their logins and repos are back.

### 9.5 Uninstall

`install/uninstall.sh` stops and removes the stack's containers and the instance's box containers and networks (by label). It keeps every volume unless run with `--purge`, which asks the owner to type the instance name first. On Windows, `uninstall.ps1` also removes the keep-alive task, and removes the WSL distro only if the installer created it (marker file) and the owner confirms.

### 9.6 Delete

Deleting a box revokes its tokens at once and removes its container and network. Its home volume is kept for 7 days (shown in Settings with **Restore** and **Delete now**), then boxd removes it.

## 10. Host mode (unboxed)

- A profile on an agora-host running on the machine itself (a host of kind `machine`, which every host is today) is **host mode**.
- New profiles in host mode need the owner to tick "Run unboxed on this machine (it can read and change your files)" when creating or editing the agent. `agent_profiles.host_mode` records it; existing profiles are migrated as host mode with that acknowledgement, since that is what they already are.
- Host-mode agents are **owner-only**: only the server owner's messages, `/start` and approvals wake them, whatever their auth mode. Settings → Agents, `/sessions` and the agent strip label them **unboxed**.
- Host mode keeps today's rules unchanged: the CLI's own sandbox stays on, no bypass flags, tool requests as cards.
- Host mode is for work a box can't do (a GPU, a local device). Everything else should be boxed.

## 11. Agents that need no box

**Model agents** ([model-agents.md](model-agents.md)) run inside Agora's API on a provider route and only read and write Agora messages: no files, no commands, no CLI. They get no box. A CLI agent always gets a box or is in host mode, even when its tools are read-only: a read-only CLI on the machine can still read every file the user can, so "read-only" there is not "no box".

## 12. The installer

One installer per platform, both ending at "open Agora" with a boxed agent waiting for its login. They own Docker, WSL and gVisor; the user doesn't run Docker commands.

### 12.1 Linux (`install/linux/install.sh`)

1. **Preflight:** Debian/Ubuntu x86_64 or arm64 (others: print the manual steps from [getting-started.md](getting-started.md) and stop), kernel ≥ 5.6, 4 GB RAM free, 20 GB disk, ports free (choose others if not, §13).
2. **Existing installs:** list `org.agora.instance` containers and volumes and any `agora` compose project; offer reuse (upgrade), a second install alongside, or stop. Never wipes without a typed confirmation.
3. **Docker Engine** from Docker's apt repository if missing; **gVisor** (`runsc`) from gVisor's apt repository; `runsc install`; restart Docker; check a `-gvisor` kernel.
4. **Agora:** download the release archive, verify its SHA-256, unpack to `~/agora` (or `~/agora-<instance>` for a second install).
5. **Config:** `setup-env.js --prod --non-interactive` in a `node:22` container (no Node needed on the host), with `AGORA_INSTANCE`, ports and `DOCKER_GID` filled in.
6. **Telemetry question** (§12.4).
7. **Start:** `docker compose up -d --build`, wait for `/health`.
8. **First admin:** asks for a username and password (or generates one and shows it once), runs `/instance/setup` with the setup token from the API's log.
9. **First box:** asks Claude Code / Codex / none; creates the agent, its box and its home channel through the API.
10. **Open Agora:** prints the URL (and opens a browser if there is one), with "press Log in on your agent's box".

On failure at any step: what failed, the exact cleanup command for what this run created, and **Report this problem?** (§12.5).

### 12.2 Windows (`install/windows/install.ps1`)

1. **Preflight:** Windows 10 2004+ or 11, virtualization on, 8 GB RAM.
2. **WSL:** if missing, `wsl --install --no-distribution` (asks for admin once), registers itself to continue after the reboot, and reboots with the user's consent.
3. **One Docker engine:** looks for a WSL distro (other than Docker Desktop's own) that already runs Docker Engine. If one exists, it offers to install into it and never starts a second engine in another distro. Otherwise it imports a distro named `Agora` from Canonical's Ubuntu 24.04 WSL image (downloaded from Canonical, SHA-256 checked) and turns on systemd.
4. Runs the Linux installer inside that distro (`--wsl`), which does steps 3–9 above.
5. **Keep-alive:** registers the hidden scheduled task from [getting-started.md](getting-started.md#local-stack-on-windows-with-gvisor-wsl2) step 7 for that distro.
6. **Agents on Windows:** none are needed; the first agent is boxed inside the distro. agora-host for host mode stays an optional extra.
7. Opens `https://localhost` (or the chosen port) in the default browser.

Docker Desktop may stay installed; the installer doesn't use or change it.

### 12.3 Tests

The same test (`test/install/clean-install.test.sh`) runs the Linux installer non-interactively on a clean machine and checks: health 200, admin login, the box running under `runsc`, the agent (a fake CLI image) answering a mention, the isolation suite (§14). In CI it runs on a fresh `ubuntu-latest` runner. Windows: CI runners have no WSL2, so the PowerShell installer's decisions are unit-tested with Pester against a mocked `wsl.exe`/`docker` (fresh machine, WSL missing, an existing engine distro, Docker Desktop present, reboot resume), and the full run is a scripted check on a real Windows machine (*verify live*).

### 12.4 Telemetry (opt-in)

At install the installer asks once, default **no**:

> Send one anonymous report when this install finishes? It contains only:
> - whether the install succeeded, or the step it failed at
> - the Agora version
> - the operating system name and version
>
> No names, addresses, IPs or IDs are kept. [y/N]

- The answer is saved as `AGORA_TELEMETRY=on|off` in `.env.prod`. Off sends nothing, ever.
- On sends one `POST https://push.agora.host/telemetry/v1/install` with `{ "result": "ok" | "failed", "step": "<step id>" | null, "version": "...", "os": "...", "osVersion": "..." }`. Upgrades send the same once.
- **The collector** is a route in `agora-push-relay` (already hosted at `push.agora.host`): JSON-schema-validated, the five fields stored with a date and nothing else, no IP or user agent stored or logged, 400 on anything extra.
- [docs/telemetry.md](telemetry.md) lists exactly this, and how to turn it off.

### 12.5 Report a setup problem

- **The doctor:** `install/doctor.sh` (and `doctor.ps1` on Windows, which adds the WSL checks and runs `doctor.sh` inside the distro) checks Docker, `runsc`, ports, the stack's containers, health, the runner's runtime, boxd and every box's state. It prints plain lines, with no secrets: it never reads `.env.prod` values, only whether each key is set, and redacts anything shaped like a token.
- **The button:** the installer offers **Report this problem** after a failure; Admin → Instance in Agora has **Report setup problem** (the API runs the checks it can: database, Redis, runner, boxd, boxes, versions). Both show the full bundle first, then send it only when the user presses **Send**, to `POST https://push.agora.host/telemetry/v1/problem` (at most 256 KB, kept 90 days). The user gets a report ID to quote in an issue.
- Nothing is sent without that press, telemetry on or off.

## 13. Second install on one engine (#209)

- `setup-env.js --prod` **no longer starts the stack**: it writes `.env.prod` and prints the start command. `--start` starts it; a failed start runs `compose down` for what it just created and says so.
- `AGORA_INSTANCE` (default `agora`, so existing installs keep their names) sets `COMPOSE_PROJECT_NAME`, the code-run network (`<instance>_sandbox`, also in `AGORA_SANDBOX_NETWORK` and the runner's socket-proxy allowlist), and every box name (§7).
- Ports come from `AGORA_HTTP_PORT` (80), `AGORA_HTTPS_PORT` (443) and `AGORA_API_PORT` (3000). setup-env picks free ones for a second install and sets `CORS_ORIGIN` to match.
- [getting-started.md](getting-started.md) gets a "second install on the same machine" section.

## 14. Threat model and tests

| # | Threat | Stopped by | Test |
|---|---|---|---|
| B1 | Box A reads B's token from a mount | no shared or host mounts; per-box volume | in A: B's volume and any `/home` but its own absent; no `docker.sock`; `find / -name '*token*'` finds only A's |
| B2 | Box A reads B's token from the environment | per-container env; gVisor process isolation | in A: every `/proc/*/environ` holds only A's tokens; B's token string appears nowhere in A's readable files |
| B3 | Box A reaches B over the network | per-box internal networks; edge refuses private addresses and forwards nothing between box networks | from A: B's `.3` unreachable on any port; CONNECT to B's address and to `postgres`, `redis`, the Docker host refused |
| B4 | Box A uses B's token (copied somehow) through the edge | edge signature + API box binding (§4.1) | from A with B's real token: every REST call and the WebSocket handshake get `403 token_not_for_this_box`, and the bot's audit trail records it |
| B5 | Box A gets B's token from the Agora API | tokens are hashes at rest and never returned; bots can't list other bots' tokens or boxes | with A's token: box, bot and host endpoints for B are 403; no response contains token material |
| B6 | Old tokens after rebuild | rotation in the rebuild transaction | A's pre-rebuild bot and host tokens are 401 after rebuild; B1–B5 repeated after `docker restart` of both boxes and after rebuild |
| B7 | Exfiltration to the internet | allowlist; SSRF guard; no DNS | CONNECT to an unlisted domain → 403 and a pending request; to an IP literal → 403; direct connection to a public IP (no proxy) fails |
| B8 | Push or PR without approval | git and PR brokers; token only at the edge | push without approval → `remote rejected` + pending request; after approval for that SHA it passes; a new commit needs a new approval; no GitHub token inside the box |
| B9 | Box escapes to the host | gVisor, read-only root, no capabilities | the box reports a `-gvisor` kernel; `mount`, raw sockets, `ptrace` of PID 1 fail |
| B10 | boxd touches another install's boxes | instance-named proxy allowlist | boxd of instance `agora` gets 403 creating/inspecting `agora2-box-*` |
| B11 | A box exhausts the machine | per-box CPU, memory and PID limits | a fork bomb in A is contained; B keeps answering |

**Recovery and reboot tests** (`test/boxes/recovery.box.test.ts`, on the same engine):
- kill the box's agora-host → the box restarts and the next mention is answered,
- recreate `edge` (`compose up -d --force-recreate edge`) → boxd re-attaches it, the box answers without a restart,
- restart boxd while a run is active → the run finishes,
- restart the Docker daemon (the reboot test on CI; on Windows also `wsl --shutdown` and the keep-alive task, *verify live*) → stack, boxd and boxes come back with logins and repos intact, and B1–B6 still hold,
- backup → reset the box → restore → the home folder's marker file and the fake login are back.

These run with `scripts/test-boxes.sh` on any Linux Docker engine with `runsc`, and in CI in a `boxes` job on `ubuntu-latest` with gVisor installed, path-filtered to the box, edge, installer and compose files. **#39 closes on this suite passing**: B1–B6 are its done-when for boxed agents. Host-mode agents keep the client binding from [bot-token-binding.md](bot-token-binding.md), which blocks accidents only.

## 15. Not covered in v1

- GitLab and other forges in the git broker (github.com only).
- Firecracker or VM boxes; GPU boxes (host mode covers GPU work).
- Running agora-host and the CLI as different users inside the box (would keep the host token from the agent; accepted residual, §3.2).
- macOS installer (Colima route stays manual, [getting-started.md](getting-started.md#local-stack-on-macos)).
- Prebuilt images from a registry: the installer builds them locally.
