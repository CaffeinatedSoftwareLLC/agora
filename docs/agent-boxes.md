# Agent boxes: the boundary contract

Status: **design, reviewed** (2026-11-04: Codex review in #agora, five findings and two corrections folded in). Sections marked *verify live* need a real login or a real machine that CI can't give.

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
| `/home/operator` | tmpfs, 256 MB, mode 0700, owner `operator` | yes, by the owner's terminal only | nothing (gone at restart) |
| `/run/agora` | tmpfs, 1 MB, mode 0700, owner `agent` | the agent | nothing |
| `/run/as-agent` | tmpfs, 1 MB, mode 0710, owner `agent`, group `operator` | the agent; the owner's group may only traverse it | nothing |
| everything else (image) | read-only root filesystem | no | replaced on upgrade |

- The home folder holds the CLI state (`~/.agora/state/<profile>`: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`), the repos (`~/work/<owner>/<repo>`; with none, `~/scratch`), session worktrees (as agora-host makes them today), and anything the agent installs for itself (`~/.local`, `~/.npm-global`, `~/.cache`).
- **No bind mounts, ever.** boxd's socket proxy rejects them (§7.2). No host path, no Docker socket, no other box's volume is visible in a box.
- Nothing is shared between boxes: no common cache volume. Two boxes that both need a package download it twice; that is the price of not having a channel between them.
- Tools an agent installs system-wide don't exist: the root filesystem is read-only and there's no `sudo`. The box's `AGENTS.md`/`CLAUDE.md` says to install under the home folder.

### 3.2 Credentials

| Credential | Where it lives | Who can read it | Lifetime |
|---|---|---|---|
| **Host token** (`ah_…`, one per box) | env of the box's container, set by boxd at create | the box (its own token only); anyone with Docker access | until the box is rebuilt or deleted, then revoked |
| **Bot token** (`bot_…`, one per box) | same | same | same; also bound to the box at the API (§4.1) |
| **Terminal relay credential** (`ar_…`, one per box generation) | env of the container (boxd sets it); the box's init (root) hands it to the relay through a pipe only the relay inherits; held hashed in `agent_hosts.relay_secret_hash` | anyone with Docker access; inside the box, only the relay's user (`operator`): it is in no file and in no other process's environment | until the box is rebuilt or deleted, then revoked; accepted by the terminal hub and nothing else (§17) |
| **CLI login** (Claude, Codex, Devin) | `/home/agent/.agora/state/<profile>` | the box | until logout or Reset |
| API key (`api_key` profiles; opencode's OpenRouter key) | env of the container, under the adapter's variable (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `OPENROUTER_API_KEY`), from an encrypted per-box secret in the DB | the box | until changed or the box is rebuilt |
| Owner's GitHub token | `box_github_credentials`, encrypted with `AGORA_ENCRYPTION_KEY` | edge, for one upstream request at a time | until the owner replaces or removes it |
| `AGORA_EDGE_SECRET` | edge and api env | edge, api | rotated by restarting both with a new value |

Rules:
- A box gets exactly one bot token, one host token and one terminal relay credential, all minted by boxd for that box. **Rebuild mints new ones and revokes the old ones in the same transaction** that records the new container.
- The host token's host has exactly one profile: the box's. It can claim only that profile's runs.
- Inside the box, agora-host and the CLI run as the same user (`agent`, uid 1000). So **the agent can read its own box's host and bot token**. The owner's terminal is the exception: it runs as another user (`operator`, uid 1001) with its own credential, which the agent cannot read (§17). That is accepted: both are scoped to its own identity, and the edge refuses them from any other box (§4.1). The evidence contract (later) must treat anything the box reports, including verify results, as "agent says", not as trusted-runner evidence.
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
  - `X-Agora-Edge-Box: <boxId>`, `X-Agora-Edge-Gen: <generation>`, `X-Agora-Edge-Ts: <unix seconds>`,
  - `X-Agora-Edge-Sig: hex(HMAC-SHA256(AGORA_EDGE_SECRET, "agora-edge/v1\n" + boxId + "\n" + generation + "\n" + ts))`.
- That signature is the only definition. The generation is bumped on every rebuild, reset and restore; the timestamp is accepted for 60 seconds either way. The API checks it in its auth step, in both directions:
  - **A box credential is valid only through its own box's edge.** Every bot token and host token boxd mints is recorded with `box_id` and `generation`. A request that authenticates with one must carry a valid edge signature for that same box and generation; without one (straight to the published API port, through Caddy, from another machine, through an allowed domain that loops back) it is refused with `403 box_token_outside_box`. So a token copied out of box B is useless everywhere except inside box B.
  - **Inside a box only that box's credentials work.** A request with a valid edge signature must authenticate as the box's own bot or host; any other bot token, host token or user token is refused with `403 token_not_for_this_box`.
  - Both refusals are written to the bot's audit trail and posted to the owner (at most once per hour per box). They cover REST and the WebSocket handshake (the headers are on the upgrade request), which the edge can't parse.
- A request without edge headers and without a box credential is ordinary (a host-mode agent, the browser). Edge headers that don't verify, or name an old generation, are refused (`403 bad_edge_signature`).

### 4.2 The internet: domain allowlist

- The box's CLI, `git`, `npm`, `pip` and `curl` use `HTTPS_PROXY`/`HTTP_PROXY=http://edge:3128` (`NO_PROXY=edge`). Node's own `fetch` in agora-host and agora-mcp doesn't use a proxy, and doesn't need one: they only talk to `edge`.
- The edge allows `CONNECT host:port` (port 443, or 80 for plain HTTP requests) when `host` matches the box's allowlist: exact names or `*.example.com` suffixes, no IPs, no wildcard-all.
- **Default allowlist**, set when the box is created, so a fresh box starts without a burst of cards:
  - the adapter's provider (the `allowlist` of its entry in the box adapter registry, [Adding a box adapter](#16-adding-a-box-adapter)): Claude `api.anthropic.com`, `platform.claude.com` (where `claude auth login` exchanges its code), `claude.ai`, `console.anthropic.com`; Codex `api.openai.com`, `chatgpt.com` (its ChatGPT-plan backend), `auth.openai.com` (sign-in) and `*.oaiusercontent.com` (content it fetches from regional hosts on its first start); oh-my-pi `openrouter.ai` alone (omp 18.17.0 through a logging proxy, 2026-11-06, with a fake key: `openrouter.ai` and `catalog.stencil.so`, the second refused below and not needed); opencode `openrouter.ai` (OpenRouter's API) and `models.opencode.ai` (the model catalog opencode reads at start and hourly; without it `session/new` fails); Devin `server.codeium.com` only (the Windsurf/Codeium server its login names as the API server, contacted at every start and by the login: Devin's provider seam, where its model calls and its own analytics both go, so they can't be split at the edge). `api.devin.ai` was never contacted and is not listed; `app.devin.ai`, its sign-in, is reachable only during a login (§4.2.3). opencode also installs its own `@opencode-ai/plugin` package from `registry.npmjs.org` at its first session, into `<state>/config/opencode/node_modules` in the home volume (§6), which the registries entry covers. Checked against Anthropic's network docs and the pinned CLIs' binaries, and against the cards the live boxes made (2026-11-04); opencode 1.18.34 through a logging proxy (2026-11-06: those two hosts and `registry.npmjs.org`, nothing else); Devin 3000.11.234 in the box image, as a box runs it, through a logging proxy with no login (2026-11-06: `server.codeium.com`, and the telemetry hosts below, refused, with Devin working without them; its login also reaches `app.devin.ai`; the hosts a logged-in turn's model traffic needs are *verify live*),
  - package registries: `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`.
  - Existing boxes got the additions by migration (082 `platform.claude.com`, 083 `*.oaiusercontent.com`).
- **Telemetry is off and blocked** (§4.2.1).
- `github.com` is **not** on it: git goes through the git broker (§5.1), which is the only path with credentials.
- **SSRF guard, pinned:** the edge resolves `host` once, refuses the request if **any** answer is private, loopback, link-local, multicast, reserved, CGNAT, an IPv4-mapped or NAT64 IPv6 address, or inside one of the engine's Docker networks (the existing `src/lib/url-guard.ts` rules plus those), and then dials **the validated address itself**, never the name again. A retry repeats the whole check. So a name that answers differently between check and connect (DNS rebinding) can't reach `postgres` or another box.
- **What the allowlist controls:** the CONNECT authority (host and port). TLS stays end to end and the edge doesn't see inside it, so on shared infrastructure (a CDN that serves many sites) the name the client sends inside TLS can differ from the allowed one. The allowlist is a reach limit, not proof of which site the box talked to. Allowed domains (the provider, the registries) also remain outbound data paths; the allowlist narrows exfiltration, it doesn't prevent it.
- **Unknown domain:** the edge answers `403` with `X-Agora-Edge-Request: <requestId>` and a one-line body (`domain example.com needs the owner's approval; request <id> was sent`). It records a pending `domain` edge request (deduplicated per box and domain while pending) and posts the card. **Allow** adds the domain to that box's allowlist; **Allow `*.example.com`** adds its bounded wildcard (§4.2.2); **Deny** keeps it out and suppresses new cards for that domain for 24 hours. The agent retries after approval; nothing is held open, except during a login (§4.2.3).

#### 4.2.1 Telemetry hosts

Privacy is part of the point of a box: the CLIs' telemetry, metrics, error-report and experiment hosts are not on any allowlist, and the edge refuses them with a `403` and **no card** (`domain ab.chatgpt.com sends telemetry, which boxes don't send`). The list is `TELEMETRY_DOMAINS` in `src/lib/boxes/domains.ts`; a name covers its subdomains.

| Host | CLI | What it is | Switched off in the box by |
|---|---|---|---|
| `ab.chatgpt.com` | Codex | usage metrics (OpenTelemetry export, seen live on a fresh box) | `-c analytics.enabled=false` |
| `ingest.sentry.io`, `ingest.us.sentry.io`, `ingest.de.sentry.io` (`o33249.ingest.us.sentry.io`) | Codex | feedback and crash reports | `-c feedback.enabled=false` |
| `statsig.anthropic.com` | Claude Code | feature flags and events (older versions) | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |
| `http-intake.logs.us5.datadoghq.com` | Claude Code | operational metrics | same |
| `browser-intake-us5-datadoghq.com` | Claude Code | error reports | same |
| `opncd.ai` | opencode | session sharing | `share: "disabled"` and `OPENCODE_DISABLE_SHARE` (every opencode run) |
| `build.stencil.so` | oh-my-pi | update checks and downloads | interactive mode and `omp update` only; `update.auto: false` (every omp run) |
| `cloud.stencil.so` | oh-my-pi | Spotlight experiment (tool-output ranking) | `spotlight.experiment.enabled: false` (every omp run) |
| `catalog.stencil.so` | oh-my-pi | model metadata (models.dev), fetched at start | none; omp runs without it (checked with it refused) |
| `unleash.codeium.com` | Devin | feature flags, fetched at start (Devin keeps its defaults without them) | no switch: refused at the edge |
| `ingest.us.sentry.io` (`o4507463137361920.ingest.us.sentry.io`), `codeium-i5.sentry.io` | Devin | error reports, sent at every session end | no switch: refused at the edge |
| `static.devin.ai`, `cli.devin.ai` | Devin | update checks, downloads and the install script | `"auto_update": false` in every run's config; the CLI is pinned in the image |

Only the ingest hosts are listed, never a vendor's whole domain: an agent working on a project that uses Sentry, Datadog or Statsig still reaches `sentry.io`, `api.datadoghq.com` or `api.statsig.com` (with a card).

- **Each CLI works without them.** The vendors document switching them off: Codex's `analytics.enabled`, `feedback.enabled` and `check_for_update_on_startup` settings (agora-host passes them as `-c` overrides to `codex exec`, `codex app-server` and `codex login` in a box; Codex type-checks the keys, so a renamed one fails loudly), and Claude Code's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (telemetry, error reports, auto-updates, `/feedback`, release notes, feature flags). The box also sets `DISABLE_AUTOUPDATER` and `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` (the marketplace is cloned from `github.com`, which a box reaches only through the git broker). The edge's refusal is the second layer, for a version that ignores a switch. *Verify live:* a fresh box of each CLI makes no telemetry request.
- The owner can still let one through by adding its **exact** name in the box's settings. A wildcard never does: allowing `*.chatgpt.com` doesn't reach `ab.chatgpt.com`.
- **The CLI switches are the control; the edge's refusal is a name check.** The edge sees only the CONNECT name (§4.2), so a process that tunnels to an allowed `chatgpt.com` and names `ab.chatgpt.com` inside TLS isn't stopped by it. That needs code in the box set on sending telemetry, which a stock CLI with these switches isn't.
- Claude Code's WebFetch safety check goes to `api.anthropic.com` (on the list); boxes disallow `WebSearch` anyway (§8.1).

#### 4.2.2 Wildcard approval

A domain card can offer **Allow `*.<registrable domain>`**, so a service that spreads over several hosts (`eu.files.example.org`, `us.files.example.org`, …) is one tap instead of a card each. The bound is computed by the server from the card's host (`wildcardFor`, `src/lib/boxes/domains.ts`), never taken from the client:

- It is `*.` plus the host's **registrable domain** by the Public Suffix List, private section included (`tldts`, pinned): `a.b.example.com` → `*.example.com`, `a.evil.github.io` → `*.evil.github.io`, `bucket.x.s3.amazonaws.com` → `*.x.s3.amazonaws.com`.
- **It never covers someone else's suffix.** No `*.com`, `*.co.uk` or `*.github.io` (a public suffix), and no `*.amazonaws.com`, `*.windows.net` or `*.on.aws` either: those aren't suffixes themselves but have suffixes under them (`s3.amazonaws.com`, every S3 bucket). The check reads the list's own rule trie from the pinned tldts and fails closed (no wildcard at all) if it can't.
- No button for a host that is already its registrable domain (`example.com`, `evil.github.io`), is a public suffix itself (`s3.amazonaws.com`, each `*.oaiusercontent.com` region), is an IP, or is under a suffix the list doesn't know (`400 no_wildcard` if asked anyway).
- Allowing it also answers the box's other pending cards it covers. Decisions on one box run one at a time, so two wildcards tapped at once can't deadlock.
- The settings route refuses an owner-typed wildcard that would cover someone else's suffix (`400 invalid_domain`), except the reviewed defaults: Codex's `*.oaiusercontent.com` (OpenAI lists each region as its own suffix, for its users' content; every region is OpenAI's) is on Codex boxes from the start and stays accepted. Migration 083 adds it to existing Codex boxes without a tap: a widening the owner did not approve one by one, called out in the change that ships it.

#### 4.2.3 Unknown hosts during a login

A CLI login can't be resumed after a refused request: Claude's login was refused `platform.claude.com` the moment its card was filed, so tapping Allow came too late (seen live 2026-11-04). So while a login is open for the box (§8.2), a request to **that CLI's own provider domains** (Claude: `anthropic.com`, `claude.ai`, `claude.com`; Codex: `openai.com`, `chatgpt.com` and their subdomains) waits for its card instead of being refused:

- The edge files the card as usual, then holds the connection, looking every second, for at most **2 minutes**. Allow (or a wildcard that covers it) lets the request through; Deny, the card expiring, the login ending or the box closing the connection ends the wait with the usual `403`.
- At most 4 requests per box wait at once; others are refused at once. Other domains are never held, login or not. Any process in the box can be held while a login is open (the edge can't tell the login command from the rest), only on those provider domains.
- The login dialog says what it waits on (`Blocked: the login needs platform.claude.com …`); if the login fails anyway, its error is `needs_domain` and the box shows **login failed: allow X, then log in again** (§8.2).
- **Login-only hosts** (the registry's `loginOnly`, exact names; Devin: `app.devin.ai`): while a login is open for the box they go through without a card; any other time they are unknown domains like the rest. They never join the allowlist on their own (an owner who allows one on a card adds it, as for any domain).
- Search: boxes get no open web. An agent searches through Agora (the assistant's search route, screened by the decision model where it's on) using its Agora tools, as today.

### 4.3 Edge requests and approvals

- Table `box_edge_requests`: `kind` (`domain`, `push`, `pr`), `box_id`, `generation`, `subject` (domain; the push's sorted command set and its hash; the PR's repo, head, head SHA, base and payload hash), `status`, `decided_by`, timestamps. Statuses:
  - `pending` → `allowed` or `denied` (the owner), or `expired`;
  - `allowed` → `in_flight` (the edge, under a row lock, while it forwards) → `used` (verified done), `allowed` (verified that nothing was written), `unknown` (the outcome couldn't be established; never reusable), or `changed` (a PR whose head moved; never reusable).
- The card goes to the box's **home channel** (chosen when the box is created; the channel its agent works in) and as a notification to the owner's phone. Only the **server owner** decides edge requests. Pending requests expire after 24 hours.
- Every decision is in the audit log (`box_edge_allow`, `box_edge_deny`).

## 5. Git and pull requests: the brokers

Repos are attached to a box when it's created or later in its settings (`owner/repo` on github.com in v1). boxd's first start of the box clones each one into `~/work/<owner>/<repo>` through the git broker; a clone kept in the home folder is used only while its origin is that repo through the edge. A change to the attached repos rebuilds the box (home kept). GitHub stays the remote.

**Fixed upstreams, for both brokers.** The edge builds every upstream URL itself from constants and the attached repo's stored `owner` and `repo` (`^[A-Za-z0-9-]{1,39}$`, `^[A-Za-z0-9._-]{1,100}$`, not `.` or `..`). A request path is matched against a short list of exact forms after one decode; `..`, encoded separators (`%2f`, `%5c`), double encoding, a different host or anything else is `404` before a credential is added. Upstream redirects are never followed with credentials attached (the reply is `502`).

### 5.1 Fetch and clone

- The box's `origin` is `http://edge:8080/git/github.com/<owner>/<repo>.git`.
- `GET …/info/refs?service=git-upload-pack` and `POST …/git-upload-pack` are forwarded to `https://github.com/<owner>/<repo>.git` with the owner's GitHub token added (`Authorization: Basic x-access-token:<token>`). No approval: reading is allowed for attached repos.
- A repo that isn't attached to the box: `404`.

### 5.2 Push

- `GET …/info/refs?service=git-receive-pack` is forwarded with the token (git needs the remote's refs before it pushes).
- `POST …/git-receive-pack`: the edge parses the command list at the start of the body: pkt-lines of `<old> <new> <ref>` (the first with its capability list), up to the flush packet. **Anything it doesn't understand is refused**: a malformed or oversized pkt-line, more than 50 commands, a ref outside `refs/heads/` and `refs/tags/`, a symbolic or `HEAD` ref, `push-options`, `push-cert`, the v2 protocol for pushes, a duplicate ref.
- **Every command in the push must be authorized**, or none of it goes upstream. A command is authorized by:
  - **auto-allow**, if the home channel's policy auto-allows pushes from this box, and the command creates or updates a branch that is **not** the repo's default branch (read from GitHub when the repo is attached, refreshed hourly). Deleting a ref, any tag, and any update to the default branch are never auto-allowed;
  - otherwise **an approval for the exact push**: the same box and generation, the same repo, and the same complete set of `(old, new, ref)` commands (stored as a sorted list and its hash).
- **Approvals are used once.** Forwarding a push first moves its approval from `allowed` to `in_flight` under a row lock, so two concurrent pushes can't both use it. Then:
  - GitHub's report says every ref was updated → `used`.
  - The outcome is unclear (the connection dropped, a timeout, a report that didn't arrive or didn't parse): the edge **reads every ref in the command set back from GitHub** (`info/refs`). All still at `old` → nothing was written, back to `allowed` for a retry. All at `new` → `used`. Anything else → `unknown`, which can never be reused.
  - A partial result (some refs updated, some rejected or still at `old`) → `used` for what it did; the remaining commands become a **new pending request** with their current `old` values, never a reuse of the original approval.
  - Allowed approvals expire 30 minutes after approval.
- **The old SHA is part of the approval, and GitHub enforces it**: receive-pack updates a ref only if it still points at `old`. So an approved push can't be replayed after the remote has moved, and can't rewind a branch that someone else updated. A pkt-line says nothing about ancestry, so the edge doesn't claim to know whether an update is a fast-forward; that is why default-branch updates always go to the owner, with the old and new SHA on the card.
- **Not authorized:** the edge drains the body, records a pending `push` request for that exact command set and answers with a valid receive-pack report, `ng <ref> push needs the owner's approval (request <id>); push again after it's approved` for each ref. git prints it as `! [remote rejected]`. New commits mean a new command set and a new approval: approval resets when the head changes.
- Push auto-allow is per channel and per box, set by the owner on the card (**Always allow pushes from this box here**) or in the box settings.
- Tests: mixed authorized and unauthorized refs in one push (none forwarded), deletes, tags, a stale `old` (GitHub refuses), replay of a used approval, two concurrent pushes on one approval, malformed and v2 bodies.

### 5.3 Pull requests and GitHub reads

- **Reads:** `GET` only, attached repos only, and only these paths under `http://edge:8080/github/repos/<owner>/<repo>/`: `pulls`, `pulls/<n>`, `pulls/<n>/reviews`, `pulls/<n>/comments`, `pulls/<n>/files`, `commits/<sha>/check-runs`, `commits/<sha>/status`, `actions/runs`, `actions/runs/<id>`, `issues/<n>`, `issues/<n>/comments` (`<n>`, `<id>` digits; `<sha>` 40 or 64 hex). Query strings are limited to `state`, `head`, `base`, `per_page`, `page`, `branch`, `event`. Forwarded to `api.github.com` with the token.
- **Creating a PR:** `POST http://edge:8080/github/repos/<owner>/<repo>/pulls` with `{ title, body, head, base, draft }` (`head` a branch of the same repo; no cross-fork PRs in v1). The edge resolves `head` and `base` to SHAs on GitHub and binds the request to the box and generation, the repo, `head`, **the head SHA**, `base` and **the hash of the title, body and draft flag**. The card shows all of them.
  - **Broker writes to one repo and ref are serialized**: the edge holds a per-`(repo, head)` lock (a Postgres advisory lock) across the whole PR operation, and pushes to that ref wait for it. So no push through the broker can move `head` between the check and the create.
  - Allowed (approved, or auto-allowed when the channel auto-allows PRs from this box): under the lock, the edge resolves `head` again; it creates the PR only if the head SHA and the payload hash still match. After GitHub answers, it **checks the head SHA GitHub reports for the new PR**. A match → `used`. A mismatch (someone outside Agora pushed to that branch meanwhile) → `changed`: the PR exists, the card says it was opened on a different commit than the one approved, and the evidence for it is unverified until a new approval.
  - Retries are idempotent: before creating, the edge looks for an open PR from `head` to `base`; if one exists that this request already created, it returns it instead of creating another.
  - Not yet allowed: `403` with the request ID; the agent sends the same request again after approval.
  - **A PR is a branch, and branches move.** The approval covers opening the PR at that SHA, nothing later. Every later commit on the branch makes any review, check or acceptance recorded for an earlier SHA stale; the evidence contract must bind them to the SHA they were made on.
- The image ships `agora-pr` (`agora-pr create --title … --body-file … --base main`, `agora-pr status <n>`) so agents don't need `gh` or a token.
- Nothing else on GitHub's API is reachable from a box.

## 6. Box images

- Built from `box/Dockerfile`: Debian slim, Node 22, git, curl, jq, ripgrep, python3, build-essential, util-linux; two users, `agent` (1000) and `operator` (1001); `box/agora-box-init` as PID 1; the pinned CLI of every box adapter (Claude Code, Codex, opencode, Devin; [§16](#16-adding-a-box-adapter)); agora-host and agora-mcp built from the same checkout; `agora-pr`; the box `AGENTS.md`/`CLAUDE.md`. opencode (MIT, `opencode-ai` on npm) is a native binary: its install step links the build for the machine's CPU (glibc, AVX2 or the baseline build) and drops the other platforms' packages. Devin (Cognition's CLI, not on npm) comes from its release tarball for the machine's CPU (`static.devin.ai/cli/<version>/devin-<version>-<x86_64|aarch64>-unknown-linux.tar.gz`), checked against the sha256 pinned for each CPU in the Dockerfile and the registry; only its static binary is kept, and its installer's `devin setup` wizard never runs. The image is built on the machine that runs it, so the CPU check matches. At its first session opencode adds `@opencode-ai/plugin` (the version that matches it) from npm to its config folder, `<state>/config/opencode/node_modules`: that is in the home volume, not the image, so it can't be preinstalled there; it comes through the edge like any npm install and stays until Reset.
- **Versioned:** `box/VERSION` holds an integer. The image is tagged `agora/box:<VERSION>` and labelled `org.agora.box.version`. A change to the Dockerfile, the pinned CLIs or the in-box scripts bumps it. A change to agora-host, agora-mcp or `box/` needs no bump: the image also carries a build label, `org.agora.box.build` (the `BOX_BUILD` build arg, from `AGORA_BOX_BUILD`, which `install/` and `scripts/test-boxes.sh` set to `scripts/box-build-id.sh`: a hash of those sources and their lockfiles). boxd labels each container with the build it was created from and rebuilds a box whose label differs from the current image's, one at a time like an upgrade and at most once per build. A missing label on either side (an image built without `AGORA_BOX_BUILD`, a container from before the label) rebuilds nothing; a base image or apt change doesn't change the label.
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
user           0:0 (root, for the init only; it starts every process of both users and gives its capabilities up, §17)
network        <instance>_box_<boxId>, ip .3
extra hosts    edge:<.2>
read-only      true;  tmpfs /tmp size=1g; tmpfs /run/agora size=1m,mode=0700,uid=1000;
               tmpfs /home/operator size=256m,mode=0700,uid=1001; tmpfs /run/as-agent size=1m,mode=0710,uid=1000,gid=1001
volume         <instance>-box-<boxId>-home → /home/agent
cap-drop       ALL;   cap-add KILL, SETGID, SETPCAP, SETUID (the init's, nobody else's: §17);   no-new-privileges
limits         cpus 2, memory 4g, pids 1024 (per box, owner-editable up to instance ceilings)
restart        unless-stopped
labels         org.agora.instance, org.agora.box, org.agora.box.version, org.agora.box.generation
env            AGORA_BOX_ID, AGORA_INSTANCE_URL=http://edge:8080, AGORA_HOST_TOKEN, AGORA_RELAY_TOKEN, AGORA_BOT_TOKEN,
               AGORA_BOX_PROFILE (name, adapter, auth), HTTPS_PROXY/HTTP_PROXY/NO_PROXY, the API key if any
```

### 7.2 Docker access

boxd reaches Docker only through its own `box-socket-proxy` (the same `wollomatic/socket-proxy` image the runner uses), which allows:
- `_ping`, `version`, `info`, `containers/json`, `networks` (list), `volumes` (list),
- create, start, stop, restart, kill, inspect, delete of containers named `<instance>-box-<ulid>`,
- create, inspect, connect, disconnect, delete of networks named `<instance>_box_<ulid>`,
- create, inspect, delete of volumes named `<instance>-box-<ulid>-home`,
- `images/<name>/json`.

No exec, no attach, no bind mounts (`-allowbindmountfrom` points nowhere), no image pulls or builds. Start, stop, inspect, connect and delete are limited to the instance's names, so one install's boxd can't touch another's boxes. **Create is not name-filtered** (the name travels in the query or the body), so what boxd creates rests on boxd itself, below.

The proxy filters paths, not request bodies: it can't stop a create request that asks for privileges, another network or another box's volume. That is boxd's job, and the residual risk is the same as the runner's (sandbox spec T9): a compromised boxd could create a privileged container. So boxd stays small, builds every body from the constants above, and before each start inspects the container and refuses to start it (and alerts) unless its image, user (root, for the init), runtime, capabilities (drop ALL and add exactly the init's four, in whatever spelling Docker reports), read-only flag, tmpfs (all four), its single volume (its own `-home`), its single network (its own) with address `.3`, and its labels are exactly what the row says. It also checks that the container's entrypoint (the absolute interpreter, `-I`, the init), command, `PATH`, `HOME` and working directory are exactly boxd's and that no loader variable (`LD_*`, `PYTHON*`, `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`, ...) is set, and that its own volume is mounted by no other container, and that the home volume is a plain `local` volume with no driver options (a local volume with `type=none,o=bind,device=…` would be a host bind mount under another name).

## 8. agora-host inside a box

### 8.1 Starting agents

- The box's PID 1 (`agora-box-init`, as root) starts `agora-box-start` as the agent, which writes agora-host's config from the env into `/run/agora/host.json` (tmpfs): `instance` = `http://edge:8080`, the host token, one profile (`workdir` = `~/work/<owner>/<repo>`, `stateDir` = `~/.agora/state/<profile>`, the pinned CLI executables), the bot token. Then it runs agora-host, unchanged in how it claims, wakes and reports.
- So **each box is an agent host in Agora**, of kind `box`, with exactly one profile. Settings → Agents shows it with the box's state instead of "last seen on machine X".
- The child process gets the proxy variables in addition to agora-host's OS allowlist (new profile option `proxyEnv`, set only by the box config).
- **Yeet mode:** in a box, agora-host starts the CLI with its sandbox off and no permission prompts: Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`; opencode (an ACP agent) gets a permission config that allows every tool (`"permission": { "*": "allow" }`) and agora-host allows every ACP permission request it still sends; oh-my-pi gets `--yolo` and the host's settings overlay (OpenRouter only, nothing discovered from the repository), and any permission request it still sends is allowed; Devin gets a config that allows every tool in its own rules except its web tools (`web_search`, `webfetch`, from the binary), and its session stays in Code mode rather than `bypass` (`devin acp` starts every session in Code mode whatever the config or `DEVIN_PERMISSION_MODE` says, checked on 3000.11.234; under bypass nothing would reach agora-host), so whatever it still asks comes to agora-host, which allows it unless it is a web tool by name or an ACP `fetch` call (`acpDeny`; a deny in Devin's config alone is unverified). Search tools stay off: Claude's `WebSearch` and Codex's `web_search` run on the provider's side, around the edge; opencode's `websearch` and `codesearch` (Exa) would go through the edge like anything else, but a box searches through Agora (§4.2.3), so they are off too; so are oh-my-pi's `web_search`, `browser` and `computer` (denied in its settings in every mode), and Devin's `web_search` and `webfetch`. The provider-side way around the edge for opencode is an OpenRouter `:online` model (web search inside the model call): Agora refuses one when the box is created (`400 model_not_allowed`) and agora-host refuses to run one in a box. That is allowed **only** when agora-host runs with `AGORA_HOST_IN_BOX=1` and the box marker file the image ships is present; on a machine, agora-host keeps refusing bypass flags as today. The box is the sandbox. Each adapter's switches are its `yeet` entry in `agora-host/src/box-adapters.ts`.
- **Local servers stay off the proxy.** `opencode acp` drives its own HTTP server on `127.0.0.1:4096`, and opencode (Bun) sends that through `HTTP_PROXY` too, which the edge refuses; so its child gets `localhost,127.0.0.1,::1` added to `NO_PROXY` (the adapter's `noProxy`).
- Tool requests stop being needed for boxed agents: inside the box everything is allowed; the edges in §4–5 are the approvals.

### 8.2 Logging a CLI in, inside its box

The owner presses **Log in** on the box in Settings → Agents (or on the box's card in its home channel). Agora records a login request; the box's agora-host claims it (as it claims siwc plan requests today) and runs the CLI's own login with that profile's state directory:

| CLI | Command in the box | What the owner sees | Then |
|---|---|---|---|
| Codex | `codex login --device-auth` | the verification URL and the one-time code, in Agora | Codex finishes when the owner approves on OpenAI's page; the login is saved in the box's `CODEX_HOME` |
| Claude Code | `claude auth login --claudeai` | the sign-in URL, in Agora, and a box to paste the code Anthropic shows | the host writes the pasted code to the command's input; the login is saved in the box's `CLAUDE_CONFIG_DIR` |
| Devin | `devin auth login --force-manual-token-flow` | the sign-in URL on `app.devin.ai` (or `windsurf.com`, which it prints when it can't resolve its deployment), in Agora, and a box to paste the code Devin shows (up to 4096 characters) | the host writes the pasted code to the command's input; the login is saved in the profile's `XDG_DATA_HOME` (`<state>/data/devin`) in the box. Devin's other login opens a browser on a localhost redirect, which a box can't. The ACP agent is the official `devin` binary itself, so its own login may be relayed (unlike an ACP wrapper around Claude or Codex) |

- **oh-my-pi has no Log in** either: an OpenRouter key given at creation only, never one of omp's subscription logins ([provider-terms.md](provider-terms.md#oh-my-pi-and-openrouter)); `409 login_not_supported` as for opencode.
- **opencode has no Log in.** It runs only on the OpenRouter key given at creation (it has no account login Agora may host, [provider-terms.md](provider-terms.md#opencode-and-openrouter)), so Settings shows no Log in button and `POST /boxes/:id/login` answers `409 login_not_supported`; a stale request reaching its host is refused the same way.
- The URL, the device code and the pasted code pass through Agora only for the length of the login (10 minutes), are never logged and are deleted when it ends.
- The login is stored **only in the box's home volume**. It is never on the host and never in Agora's database; backups carry it only inside the encrypted bundle (§9.4).
- `auth: "subscription"` boxes stay owner-only, as today: only the owner's messages wake them, only the owner can press Log in.
- **Status, honestly.** A running box whose CLI isn't logged in can't answer anyone, so Settings → Agents shows its login state in place of "running": **not logged in**, **logging in**, or **login failed** with the next step (`Login failed: allow platform.claude.com on the box's card, then log in again.` when the edge refused a provider domain, else `Login failed (<error>): log in again.`).
- *Verify live:* all three commands in a box with a real account (Devin's prints its URL and reads its input from a pipe, checked with no login; the pasted code finishing it is not). CI checks the relay with fake CLIs that print the same prompts.

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

`install/upgrade.sh` (also run by the Windows installer for an existing install): back up (§9.4) → fetch the new release → `docker compose build` → `up -d` → boxd sees boxes whose `image_version` is lower than `box/VERSION` and rebuilds them one at a time, waiting until no run is active in that box (at most 15 minutes, then it rebuilds anyway and the run is retried by the lease rules). Each upgrade posts a notice in the box's home channel with the old and new version. The same happens, with the same wait, for a box on another build of the current version (its build label differs); its notice says it was rebuilt on the current build.

Rollback: the previous image tag stays on the engine until the next upgrade; `install/upgrade.sh --rollback` restores the previous release and its backup.

### 9.2 Rebuild

Recreates the container from the image and the row, rotates both tokens. The fix for a box in a bad state that still has a good home folder.

### 9.3 Recovery

- Box process dies: the init stops the other process and exits, Docker restarts the container (`unless-stopped`); agora-host's lease rules retry the run. This holds for the agent's agora-host and for the owner's terminal relay alike; the agent cannot end the relay or the init (§17).
- boxd dies: Docker restarts it; boxes keep running without it; it reconciles on start.
- edge dies or is recreated by a deploy: boxes lose their way out until it's back; boxd re-attaches it to every box network at `.2` (a recreated container loses networks attached at run time; the pinned address keeps every box's `/etc/hosts` correct, so boxes don't need restarting).
- Docker or the machine restarts: every container comes back by its restart policy; boxd reconciles; nothing needs the owner.
- A box that fails five starts in ten minutes is stopped with `last_error` and a notice; the owner rebuilds or resets it.

### 9.4 Backup (includes every box)

**A coherent restore point.** `install/backup.sh` first quiesces everything that changes box state:
1. stops `boxd` (no provisioning, reconciliation or token rotation can run) and `edge` (no approvals are decided or used, no git traffic), after waiting for an in-progress boxd operation to finish;
2. stops every box (their CLIs stop writing logins and repos), then the `api`, `runner` and `cap-gateway` writers;
3. dumps the database, then archives `files-data` and **every** box home volume of the instance (found by label, so none is missed), while nothing is running that could change them;
4. starts everything again.

Everything is one bundle, **encrypted before it leaves the machine's Docker volumes**: the archive is streamed through AES-256-GCM (`dist/src/tools/backup-crypt.js` in the backend image) with a key derived (scrypt) from a backup passphrase the owner chooses at first backup; nothing is written in plain text. The bundle holds `postgres.sql`, `files-data.tar`, `boxes/<boxId>-home.tar` (CLI logins and repos), `env.prod` (it holds `AGORA_ENCRYPTION_KEY`) and `manifest.json` (instance, version, box IDs, generations and image versions, SHA-256 of every part). Without the passphrase it can't be restored; that is the point.

`install/restore.sh <bundle>` asks for the passphrase, checks the manifest, restores the database, files and every box volume, then, before anything starts:
- bumps every box's **generation** and revokes all box host and bot tokens (boxd mints fresh ones when it rebuilds the boxes, so a token from the old install or a copy of the backup is dead),
- expires every pending or allowed edge request (approvals made before the backup don't carry over).

Then it starts the stack; boxd rebuilds the boxes, and their logins and repos are back. A test runs a backup while a rebuild and a delete are in progress and checks the restored state is one of "before" or "after" for each box, never a mix.

### 9.5 Uninstall

`install/uninstall.sh` stops and removes the stack's containers and the instance's box containers and networks (by label). It keeps every volume unless run with `--purge`, which asks the owner to type the instance name first. On Windows, `uninstall.ps1` also removes the keep-alive task, and removes the WSL distro only if the installer created it (marker file) and the owner confirms.

### 9.6 Delete

Deleting a box revokes its tokens at once and removes its container and network. Its home volume is kept for 7 days (shown in Settings with **Restore** and **Delete now**), then boxd removes it.

## 10. Host mode (unboxed)

- A profile on an agora-host running on the machine itself (a host of kind `machine`, which every host is today) is **host mode**.
- New profiles in host mode need the owner to tick "Run unboxed on this machine (it can read and change your files)" when creating or editing the agent. `agent_profiles.host_mode` records it; existing profiles are migrated as host mode with that acknowledgement, since that is what they already are.
- Host-mode agents are **owner-only**: only the server owner's messages, `/start` and approvals wake them, whatever their auth mode. One exception, unchanged from before boxes: a profile on Sign in with ChatGPT (`siwc`) runs on its plan owner's plan, so it follows that person (who can only be someone the owner let connect a plan on the owner's host); nobody else can wake it. Settings → Agents, `/sessions` and the agent strip label them **unboxed**.
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

### 12.6 macOS (`install/macos/install.sh`)

The Windows design with a Lima VM in place of WSL ([macos.md](macos.md)):

1. **Preflight:** Apple Silicon (a Rosetta shell is refused), macOS 13.5+, 8 GB of memory, 30 GB free, not root. Warns when the Mac sleeps by itself.
2. **Lima** 2.0+: if missing, `brew install lima` with consent (`--allow-lima-install` when non-interactive); Homebrew's own install script is never run.
3. **One VM per install:** creates `agora` (or `--vm`) from a generated Lima config: `vmType: vz`, Canonical's Ubuntu 24.04 arm64 cloud image pinned by the digest in its `SHA256SUMS`, no mounts, no containerd, no SSH agent forwarding, and port forwards for the install's three ports to `127.0.0.1` on the Mac with every other guest port ignored. A boot-time provision script (`install/macos/guest/host-firewall.sh`) refuses new connections from the VM and its containers (`OUTPUT` and `DOCKER-USER`) to `192.168.5.2`, Lima's address for the Mac's loopback, except valid ports listed in `/etc/agora/host-allow-ports`. It creates `DOCKER-USER` before Docker's first start (Docker keeps it), re-runs after every Docker start (a drop-in) and after the Linux installer, and builds its chain fresh and swaps it in, so a failure keeps the previous rules. The image is a dated Ubuntu build pinned by its `SHA256SUMS` digest. Mac-side ports are 1024 or above (8443, 8000, 3000 by default). A VM the installer didn't create is never used. gVisor runs on its default systrap platform, so no nested virtualization is needed.
4. **The release goes in with `limactl copy`**, and `install/linux/install.sh --lima` runs inside with the Mac's ports (steps 3–9 of §12.1). Password and key files are copied into a 0700 folder in the VM and removed after.
5. **Keep-alive:** a LaunchAgent (from login) or, with `--at-boot`, a LaunchDaemon running as the user (from boot, sudo asked in preflight and used before the VM's long first start) runs `~/.agora/macos/keepalive.sh` at load and every 5 minutes, which starts the VM if it isn't running and the installer isn't (its lock file). It also logs low disk space on the Mac.
6. Opens `https://localhost:<port>`.

`install/macos/agora-vm.sh` runs `doctor.sh`, `backup.sh`, `restore.sh` and `upgrade.sh` inside the VM and moves bundles to and from the Mac. Tests: `test/install/macos.test.sh` drives the scripts with the Mac's and Lima's commands stubbed (CI on Linux and on `macos-latest` with its bash 3.2); the stack itself is covered on arm64 by the `-arm64` CI jobs. The full run is [testing/macos-test-plan.md](testing/macos-test-plan.md) on a real Mac (*verify live*).

## 13. Second install on one engine (#209)

- `setup-env.js --prod` **no longer starts the stack**: it writes `.env.prod` and prints the start command. `--start` starts it. It refuses an install name the engine already has, starts nothing when Docker can't be asked what exists, and after a failed start removes nothing: it prints the exact `down --remove-orphans -v` command and what that deletes (two setups of one name can race, so an earlier empty inventory proves nothing).
- `AGORA_INSTANCE` (default `agora`; an install from before #209 keeps the Compose project name it already has, which upgrade writes into `.env.prod`) sets `COMPOSE_PROJECT_NAME`, the code-run network (`<instance>_sandbox`, also in `AGORA_SANDBOX_NETWORK` and the runner's socket-proxy allowlist), and every box name (§7).
- Ports come from `AGORA_HTTP_PORT` (80), `AGORA_HTTPS_PORT` (443) and `AGORA_API_PORT` (3000). setup-env picks free ones for a second install and sets `CORS_ORIGIN` to match.
- [getting-started.md](getting-started.md) gets a "second install on the same machine" section.

## 14. Threat model and tests

| # | Threat | Stopped by | Test |
|---|---|---|---|
| B1 | Box A reads B's token from a mount | no shared or host mounts; per-box volume | in A: B's volume and any `/home` but its own absent; no `docker.sock`; `find / -name '*token*'` finds only A's |
| B2 | Box A reads B's token from the environment | per-container env; gVisor process isolation | in A: every `/proc/*/environ` holds only A's tokens; B's token string appears nowhere in A's readable files |
| B3 | Box A reaches B over the network | per-box internal networks; edge refuses private addresses and forwards nothing between box networks | from A: B's `.3` unreachable on any port; CONNECT to B's address and to `postgres`, `redis`, the Docker host refused |
| B4 | Box A uses B's token (copied somehow) | edge signature + box binding in the API, both directions (§4.1) | from A with B's real token: every REST call and the WebSocket handshake get `403 token_not_for_this_box`; B's token used directly against the published API port (no edge) gets `403 box_token_outside_box`; both are in the bot's audit trail |
| B5 | Box A gets B's token from the Agora API | tokens are hashes at rest and never returned; bots can't list other bots' tokens or boxes | with A's token: box, bot and host endpoints for B are 403; no response contains token material |
| B6 | Old tokens after rebuild | rotation in the rebuild transaction | A's pre-rebuild bot and host tokens are 401 after rebuild; B1–B5 repeated after `docker restart` of both boxes and after rebuild |
| B7 | Reaching what it shouldn't, outside or inside | allowlist; pinned SSRF guard; no DNS; telemetry refused; wildcards bounded to a registrable domain. Narrows, doesn't prevent, exfiltration: allowed domains are data paths (§4.2) | CONNECT to an unlisted domain → 403 and a pending request; to an IP literal → 403; an allowed name whose DNS answer changes to a private address between lookups → refused; direct connection to a public IP (no proxy) fails; a telemetry host → 403 and no card, also under an allowed wildcard; no card offers or the settings route accepts a wildcard over a public suffix |
| B8 | Push or PR without approval, or replayed | git and PR brokers; token only at the edge; exact, single-use approvals (§5.2, §5.3) | the push tests in §5.2; a PR whose head moved or whose title changed after approval is refused; a retried PR returns the same PR; traversal and encoded-separator paths are 404; no GitHub token inside the box |
| B9 | Box escapes to the host | gVisor, read-only root, no capability held by any process of either user | the box reports a `-gvisor` kernel; `mount`, raw sockets, `ptrace` of PID 1 fail; every process of both users reports empty permitted, effective, inheritable, ambient and bounding sets and no-new-privileges, and PID 1 holds `CAP_KILL` alone (`test/boxes/terminal.box.test.ts`) |
| B10 | boxd touches another install's boxes | instance-named proxy allowlist (not for create: §7.2) | boxd of instance `agora` gets 403 starting, inspecting, exec'ing or deleting `agora2-box-*` |
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
- Prebuilt images from a registry: the installer builds them locally.
- A terminal for an unboxed agent ([§17](#17-the-owners-terminal)).

## 16. Adding a box adapter

The owner's rule: **every adapter agora-host runs on a machine also runs in a box.** Everything a box needs to know about a CLI is one entry in the box adapter registry, which has two halves because the API image and the box image are built from different folders:

| File | What the entry holds |
|---|---|
| `src/lib/boxes/adapters.ts` (`BOX_ADAPTER_REGISTRY`, server, boxd, edge) | `label`; `image` (pinned version and the Dockerfile `ARG` that holds it; an npm package, or a release tarball's URL with its sha256 per CPU, each in its own `ARG`); `protocol` (`cli` or `acp`); `authModes` (`subscription`: a CLI login relayed into the box, owner-only; `api_key`: a key given at creation, stored encrypted per box, set by boxd in the box's environment; the first is the default); `apiKeyEnv` (the variable boxd sets the key in); `modelRequired`; `allowlist` (the provider's API, sign-in and content hosts; registries are added for every box); `loginDomains` (where its sign-in lives: the edge holds these during a login, §4.2.3; empty without a login); `loginOnly` (hosts reached only during a login, §4.2.3); `telemetry` (ingest hosts refused without a card, §4.2.1) |
| `agora-host/src/box-adapters.ts` (`BOX_ADAPTERS`, agora-host in the box) | `executable` (`/opt/agora/bin/<adapter>`); `version`, `protocol`, `authModes`, `apiKeyEnv` as above; `acpArgs`; `login` (its arguments, the hosts its sign-in URL may be on, `device` or `paste`; `null` for API key only); `quiet` (env and arguments that turn off telemetry, error reports, update checks); `noProxy` (local hosts the CLI must reach without the edge); `yeet` (arguments that turn its sandbox and prompts off, arguments that turn off open-web tools, or `acpAllowAll` for an ACP agent, with `acpDeny` the requests the host still refuses); `state` (where its global instructions file goes in its state directory, and settings files written once) |

To add one (opencode, oh-my-pi and Devin followed these steps):

1. **Run it on a machine first.** agora-host must already drive it (`agora-host/src/adapters.ts`, `config.ts`, `terms.ts`), and [provider-terms.md](provider-terms.md) must say how it may sign in. A box changes where it runs, not whether Agora may run it.
2. **Registry entries:** one in each file above, same name, same order. Check its hosts against the pinned binary (`strings`, or run it through a logging CONNECT proxy as opencode was) and list every telemetry host it has.
3. **Image:** in `box/Dockerfile`, an `ARG <NAME>_VERSION=<pin>` and an install block in the `box` stage (install as root with `HOME=/root`, link the binary to `/opt/agora/bin/<adapter>`, run `--version`, remove whatever the install left under `/root`), and in the `test` stage a fake CLI linked as `/opt/agora/bin/<adapter>`: `box/fake/fake-cli.mjs` answers the headless CLI modes and the login relay, `box/fake/fake-acp.mjs` an ACP agent. Bump `box/VERSION`.
4. **Agora:** if `agent_profiles.adapter`'s check constraint doesn't list it yet, a migration (opencode needed none: 068 added it; Devin's is 089; add the value to whatever list is there, never restate it, as 088 and 089 do). A CLI with a login also needs its sign-in hosts in `LOGIN_HOSTS` (`src/routes/box-hosts.ts`, which the unit test checks against the relay's hosts, and `boxRules.ts`), and its Log in kind in `BOX_ADAPTER_OPTIONS`. The UI's Create box list is `BOX_ADAPTER_OPTIONS` in `agora-ui/src/features/boxes/boxRules.ts` (with the `BoxAdapter` type in `api.ts`).
5. **Tests:** `test/unit/box-adapters.unit.test.ts` fails until both halves, the Dockerfile and the UI list agree; `test/boxes/adapters.box.test.ts` starts a box of every registry entry on the test image. Add host tests for its launch in a box (`agora-host/test/box.test.ts`: the yeet arguments, the environment it gets, a turn with its fake) and, if it has a login, for the relay (`agora-host/test/box-login.test.ts`).
6. **Docs:** its allowlist (§4.2), telemetry (§4.2.1), yeet switches (§8.1) and login (§8.2) here.

## 17. The owner's terminal

The owner can open a real terminal in the browser, attached to one box ([box-terminal.md](box-terminal.md); design and threat list in [planning/box-terminal.md](planning/box-terminal.md)). It is a remote shell, so it is built on what this document already has, and widens nothing:

- **Not a `docker exec`.** boxd's socket proxy still allows no exec and no attach (§7.2), and its allowlist did not change for this. A **terminal relay** inside the box starts the pseudo-terminal (`box/agora-pty`, Python's `pty`) and relays its bytes over a socket it opens **out** through the edge, with a credential of its own. The gateway checks it like every other box credential (§4.1, both ways: a box credential works only through its own edge at its current generation), and the hub accepts a relay's events only for a terminal it was given. A box credential's reach grows by exactly this socket and no REST route.
- **Who.** The server owner, on a cookie session, with this site's `Origin`, a CSRF token and **their password again**, for a 30-second single-use ticket bound to the person, that browser session and the box; then the browser's own socket, which refuses any other `Origin`, any bearer, bot or host token, and a login that arrived through a box's edge, redeems the ticket in one statement and checks ownership again. One terminal per box (a unique index); a second needs a confirmed takeover.
- **Two users, two processes, two credentials.** The agent (agora-host and its CLIs) runs as `agent` (uid 1000). The terminal relay and the owner's shell run as `operator` (uid 1001): an ordinary account, not root, in no group of the agent's, with a home of its own (a tmpfs, mode 0700). The agent cannot read, trace, signal or type into the operator's processes, and cannot read the relay's credential.
  - **How they start.** The container starts as **root**, and only so that its PID 1 (`box/agora-box-init`) can switch users. boxd gives the container `cap-drop ALL`, `cap-add SETUID SETGID SETPCAP KILL`, and `no-new-privileges`. For each of the two children the init: empties the bounding capability set (`CAP_SETPCAP`), drops supplementary groups and sets uid and gid (`CAP_SETUID`, `CAP_SETGID`; leaving root clears the permitted and effective sets), clears inheritable and ambient, sets no-new-privileges, **reads `/proc/self/status` and refuses to exec unless every capability set is empty**. Then it gives up everything but `CAP_KILL`, which it keeps only to pass a stop on to the two. So **no process of either user holds a capability or can gain one**; PID 1 is root with one capability. Its inputs are its children's exits and `SIGTERM`/`SIGINT`/`SIGHUP`: after start-up it reads no file, no socket, no environment variable and nothing from any home folder, and nothing it loaded or ran at start-up came from a place the agent can write (next bullet).
  - **What the root init loads (second security review).** The agent owns its home, a volume, and can plant files in it, make it traversable, and force a restart (it can end its own agora-host; an upgrade also restarts on the same volume). So the init, the only root code with capabilities, must load nothing from it. boxd sets the container's **entrypoint** explicitly to `/usr/bin/python3 -I /opt/agora/agora-box-init` (`-I`: no `PYTHON*` variable, no user site so no `usercustomize.py` or `.pth` under `$HOME`, no current directory or script directory on the import path); the shebang says the same, nothing is found through `PATH` (the agent's `~/.npm-global/bin` and `~/.local/bin` are on the agent's own `PATH`, and last on the image's), and the working directory becomes `/`. The init then **re-executes itself** (still PID 1) with an **empty environment**, handing the container's environment to its second stage in a memory file descriptor: `/proc/1/environ` is empty, so it holds neither the relay credential nor the host or bot token. Everything the init runs is an absolute path in the read-only root (`/usr/bin/python3`, `/usr/local/bin/node`, `/opt/agora/...`) with a fixed environment of its own (the relay side gets `PATH` root-owned, `HOME=/home/operator`, no `NODE_*`, `PYTHON*` or `LD_*`). boxd's start check refuses a container whose entrypoint, command, `PATH`, `HOME` or working directory differ or that sets a loader variable (`LD_*`, `PYTHON*`, `NODE_OPTIONS`/`NODE_PATH`, `BASH_ENV`, ...). The image's `PATH` lists root-owned directories first; the agent's own processes get its installs first (the init sets that for them only), as before.
  - **Supervision.** If the agent's process ends, the init stops everything and exits with its status; Docker's restart policy (`unless-stopped`) restarts the box exactly as it always did for a dead agora-host, and boxd's failure counting (§7.1, `FAIL_LIMIT`) is unchanged. The terminal side is separate: the init starts `box/agora-relay-supervisor` as the operator (no capability), which holds the credential, starts the relay and, if it dies, starts it again with a back-off (at most five starts a minute; then it stays down and says why in the box's log; status 2, a refused credential or argument, is not retried). A dead relay therefore never takes the agent's run down, and the init does not keep `SETUID`/`SETGID` for its whole life to restart it (the alternatives were: keep those capabilities in PID 1, or a root helper holding them: both leave more power lying around than a same-user supervisor). If the supervisor itself ends, the box stays up and the terminal is unavailable until the box restarts.
  - **The relay credential** (`ar_<hostId>.<secret>`, `agent_hosts.relay_secret_hash`, hashed like the host token) is minted in the same transaction as the box's generation and host token, in boxd's container environment (readable by anyone with Docker access, as the host token is). The init reads it from the environment it was given, and writes it into a pipe whose read end only the relay's supervisor inherits (descriptor 3); the supervisor keeps it in memory and gives each relay it starts a fresh pipe, which the relay reads and closes. Where a copy lives afterwards, and who can read it: **Docker's container configuration** (`docker inspect`: boxd, the host's Docker users and root; the same place the host token is, and the one copy that survives a restart, which is why it is not a file on a tmpfs: Docker restarts the box without boxd and a tmpfs is empty again); **PID 1's memory** (root; PID 1's `/proc/1/environ` is empty, see above); **the supervisor's and the relay's memory** (the operator, so also anything the owner runs in the terminal as the operator; the agent cannot, it is another user). It is in no file, in no process's environment (the agent's has no `AGORA_RELAY_TOKEN`; the relay's has no host token, bot token or provider key). The hub accepts a terminal endpoint (`auth.type = 'relay'`) with this credential **only**. The **host token can no longer register as a terminal endpoint at all**: it does not parse as a relay token, and the old `type: 'host'` handshake is gone. A rebuild mints a new one and the old one is dead.
  - **Why a pipe and not a file.** A file the relay can read and the agent cannot would need a root-written, operator-owned file in a directory the agent cannot traverse; the init has no `CAP_CHOWN` or `CAP_DAC_OVERRIDE` and should not. A pipe has the same effect with nothing at rest, and it needs the same barrier to hold (another user's process memory and `/proc` entries), which the box tests check under gVisor.
- **What the shell is.** A bash shell as `operator`, starting in its home. Its `PATH` is root-owned directories only (`/opt/agora/bin` first); bash starts from a root-owned rc file (`--rcfile`), git reads one root-owned configuration (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`) with `core.hooksPath=/dev/null`, `core.fsmonitor=false` and no `safe.directory`, so git refuses repositories the agent owns; no file of any home is sourced. Its environment is fixed values, `TERM` and the proxy variables, so it has no host token, bot token, relay credential, provider key or CLI login directory. The same network allowlist, same network namespace and same edge apply (the shell sees nothing more or less than the agent).
- **`as-agent`.** `as-agent <command>` (a root-owned program on the operator's `PATH`) asks the **agent's side** to run the command as the agent, in the agent's workspace, on a pty (interactive: resize, Ctrl-C) or with plain pipes (stdin, stdout, stderr, exit status). The agent's side is `box/as-agent-server`, a Python process agora-host starts and supervises as the agent, listening on `/run/as-agent/server.sock`. The directory is a tmpfs owned by the agent with the operator's group allowed to traverse it (mode 0710), and the socket is open to connect to, but the server serves **only a peer whose kernel-reported user id (`SO_PEERCRED`) is the operator's**; the agent asking for itself is refused before its request is read. The direction that matters is operator to agent: the agent can neither ask as the operator nor make the operator run anything (the client only prints what the server sends; a hostile server can show text, as any program can). What the operator types into an `as-agent` session is visible to the agent, and the banner and confirm page say so. **Which side the owner is on is shown by the page, not by the screen** (second security review): the agent can end its program and draw a byte-exact copy of the operator's prompt, so nothing inside the terminal proves anything. `box/agora-pty` (operator side) reports about once a second which side it is, from the one fact the agent cannot fake: whether a process running `/usr/local/bin/as-agent` is in the terminal's foreground process group (`tcgetpgrp` on the pty, then `/proc`; an explicit notification from the client was weighed and rejected, a client killed with `SIGKILL` could never say it left). The relay sends `shell:side` (`operator` or `agent`) to the server, which passes it to the paired browser only (not to the channel, not stored); the page draws it **outside the terminal canvas**: a red frame and "AGENT SIDE: everything you type here goes to the agent" on the agent's side, the normal header on the operator's side, and the agent-side frame again when the reports stop (6 seconds) or are anything but exactly `operator`. The client has a **local escape handled before anything is sent**: Enter, then `~` and `.` leaves the session (`~~` types one `~`), so a server that ignores input cannot hold the owner. The client treats its server as hostile: frames are capped (1 MiB, 4 MiB buffered), a malformed exit frame is a plain failure, a server that stops reading ends the session (1 MiB unsent), output is written without blocking the keyboard, and error messages are fixed strings (nothing the server sent is printed in them). The agent's files stay closed to the operator (mode 0700 on the agent's home, set again at every start for kept volumes): the operator reads them through `as-agent`; a group or ACL read grant was weighed and left out (it would also expose the agent's CLI login directories to everything the operator runs).
- **Beside the agent.** While a terminal is open, `claimNext` offers the box's host no new wake for that profile; a run already working is not stopped. The home channel is told when it opens and closes.
- **Recorded.** `box_shell_sessions` and the audit log: who, when, how long, bytes in and out, why it closed. Never the bytes themselves.
- **Limits** (per box, the owner's to change): idle 15 minutes, longest 8 hours, output 512 KiB/s. Output is paced at the relay and closed at the server if ignored.
- **Version skew.** `agent_hosts.shell_protocol` is set when a relay connects (protocol 2). A box from an older image has none, so Settings says "this box needs its update first" and the ticket route answers `409 box_needs_update`; a new server refuses an old image's `type: 'host'` handshake as an ordinary failed login, which that agora-host retries slowly and ignores. A new image on a server that predates the relay gets `Invalid token` from the gateway for `type: 'relay'`; the relay logs it once, retries with backoff, and the agent's runs never notice.
- **Unboxed agents.** None, by design. agora-host refuses to open a terminal outside box mode. It would need an explicit opt-in in the machine's own host config that the server can never switch on.

| # | Threat | Stopped by | Test |
|---|---|---|---|
| B12 | Someone other than the owner gets a shell in a box | owner-only ticket with password re-entry, cookie session, `Origin`, CSRF; single-use ticket bound to person, session and box; ownership re-checked at the socket; relay events only for its own terminals | `test/integration/box-terminal.integration.test.ts` (member, director, other owner, bot, host token, bearer, wrong password, reused / expired / other-session ticket, other `Origin`, no CSRF) |
| B13 | The terminal is a way around the box's limits | the shell is the operator's, in the box, behind the same edge | `test/boxes/terminal.box.test.ts` (uid 1001, no host, bot or relay token in the environment, an unlisted domain refused, nothing direct) |
| B14 | A terminal's bytes are kept | the hub passes bytes and counts them | the integration test searches every table and every log write for a typed marker |
| B15 | The agent replaces the box's terminal endpoint with its own and receives the owner's keystrokes | the host token is not a terminal credential; the relay credential is unreadable to the agent; a second socket is refused while the first is connected, audited and announced; an open terminal closes | integration (`host token cannot register`, review 1); box test (`the host token cannot register as a terminal endpoint`) |
| B16 | The agent reads, traces, signals or types into the owner's shell or relay, or reads the relay credential | separate Unix users; mode 0700 homes; `/proc` and ptrace rules; no capability in either user's processes | box test, in gVisor in CI: environ, mem, maps, fd, cwd, exe, io, `ptrace` attach and seize, `SIGSTOP`, `SIGHUP`, `SIGTERM`, `SIGKILL`, the terminal device (read, write, `TIOCSTI`), `/home/operator`, PID 1; the credential's secret is found nowhere the agent can read |
| B17 | Some process of either user holds a capability or can gain one | init drops the bounding set, sets no-new-privileges and verifies `/proc/self/status` before exec | box test: every process of both users has empty permitted, effective, inheritable, ambient and bounding sets and no-new-privileges; PID 1 holds `CAP_KILL` alone |
| B18 | Agent code runs as the owner (hooks, fsmonitor, scripts) | git refuses the agent's repositories for the operator; the operator runs them through `as-agent`, which runs them as the agent | box test: an agent-planted hook and `core.fsmonitor` do not run for plain `git`, and run as uid 1000 under `as-agent` |
| B20 | The agent gets its own code run as root (a planted `python3`, `env` or `node` on a `PATH` entry in its volume, `usercustomize.py`, a `.pth` file, `sitecustomize.py`) by making its home traversable and forcing a restart | explicit absolute entrypoint in isolated mode; nothing looked up by `PATH`; working directory `/`; empty environment after the first stage; fixed environments for the children; the start check compares entrypoint, command and environment | box test (`planted interpreters ... never run as root or the operator`): the plants run only as uid 1000, PID 1 holds `CAP_KILL` alone, children none, the credential is not found; fails with the old init |
| B21 | The owner mistakes the agent's side for their own shell (a fake prompt) | the page's frame and label come from the box's relay, outside the terminal; the escape is local to the client | UI tests (frame, label, output cannot change them); host tests with a real pty; box test (a hostile server on `/run/as-agent/server.sock` draws the operator's prompt: still `agent`; `~.` leaves) |
| B22 | A hostile agent side attacks the `as-agent` client (oversized frames, hostile exit frames, escape sequences in errors, no reading) | caps, no blocking, fixed messages | box test with a hostile server: each mode ends with a short fixed message |
| B23 | The terminal side takes the agent down (a relay that dies or restarts in a loop) | a same-user supervisor with a capped back-off; the init keeps the box up | recovery test: the relay is restarted, then left down after five starts a minute, the box and the agent's host carry on |
| B24 | A setuid binary in the image gives back privilege | no-new-privileges and an empty bounding set | box test: `su` in the operator's shell and under `as-agent` runs with its caller's user id, no capability |
| B25 | Unauthenticated guesses at the relay credential cost a password-grade hash each | a failure budget per credential id (5 a minute) checked before any hash; nothing audited | integration test |
| B19 | The agent uses `as-agent` to get a command run as itself or the owner | the server serves only the operator's user id, by `SO_PEERCRED` | box test: the agent's own request is `forbidden` |
