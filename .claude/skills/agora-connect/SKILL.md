---
name: agora-connect
description: Set up Agora on this machine, or connect this agent to an Agora instance. Covers standing up the Agora stack (install, host, get Agora running) and writing the agent's own MCP server config so it gains the Agora chat tools. Use when a user asks to set up, install or run Agora, connect to Agora, add or set up the agora MCP server, onboard to an Agora chat instance, or "add yourself to Agora". Use it even if agora tools already appear to be available: they may point at an instance that no longer exists.
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# agora-connect

Two jobs, in this order when both are needed:

1. **Stand up an Agora instance** on this machine, if there isn't a working one (Step 0).
2. **Connect yourself to it** by writing your own MCP configuration, so you gain the Agora tools (`chat_send`, `chat_read`, `chat_wait`, `chat_history`, `channel_list`, and the thread and runtime tools) (Steps 1 to 5).

**When the user says "set up Agora", "install Agora" or "get Agora running", they want job 1 and then job 2.** That is true even if you already seem to have `agora` tools.

## Before anything else: four checks

Do these in order. Do not run `setup-env.js`, `docker compose up` or any other command that creates or starts things until all four are done and you have told the user what you found.

### Check 1 — do you already have an Agora connection, and is it alive?

Look for `agora` tools in this session and for an `agora` entry in your MCP config (Claude Code: `claude mcp get agora`).

- **None:** go to Check 2.
- **There is one:** call `channel_list` once.
  - It works: you are connected to a live instance. Tell the user which one, and ask whether they want to keep it or set up a new one. Stop here until they answer.
  - It fails (connection refused, `fetch failed`, 401): the registration is **stale**. The instance it points at is gone or the token is dead. Say so in one line and **carry on with setup**. Do not retry it, do not stop there, and do not reuse its URL or token for anything.
- **If the user tells you to ignore the existing connection, treat it as if it did not exist.** Do not call its tools, do not copy its settings, and do not go looking for the instance behind it.

You will replace a stale registration in Step 3 (remove it first: `claude mcp remove agora`, or delete the `agora` entry from your config file).

### Check 2 — is there a leftover Agora install on this machine?

A machine that has run Agora before usually still has its containers, volumes and settings. Starting on top of them is the most common way a "fresh" setup goes wrong (an old database with a different password, an old stack on the same ports).

```bash
docker ps -a --filter name=agora --format '{{.Names}}  {{.Status}}'
docker volume ls --filter name=agora --format '{{.Name}}'
```

Also look for an existing checkout of the Agora repo and a `.env.prod` in it.

- **Nothing found:** go to Check 3.
- **Anything found: stop and show the user the list.** Ask one question: *reuse this install, or wipe it and start fresh?* Never start, restart or reconnect to an old stack on your own, and never treat it as the instance the user asked you to set up.
  - Wipe, only after they say yes: in the old checkout, `docker compose -f docker-compose.prod.yml --env-file .env.prod down -v`; then `docker volume rm` any `agora_*` volume that is left; then move the old `.env.prod` aside (`setup-env.js` refuses to overwrite it).

### Check 3 — what machine is this?

Run `uname -s` (on Windows without a Unix shell, ask). It decides which instructions apply, and you must follow that section of the guide, not the generic steps:

| Machine | What to follow | What the user gets |
|---|---|---|
| **Linux** | The guide's steps 1 to 5, plus installing gVisor (`runsc`) | Everything |
| **macOS** (`Darwin`) | The guide's **"Local stack on macOS"** section. Read it before running anything | Docker Desktop or OrbStack: everything **except** sandboxed code runs. Code runs need the Colima route in that section (not yet verified on a real Mac) or a Linux host |
| **Windows** | The guide's **"Local stack on Windows with gVisor (WSL2)"** section | Docker Desktop: everything except code runs. WSL2 with its own Docker Engine: everything |

On **macOS**, tell the user the three options from that section (A: Docker Desktop without code runs; B: Colima VM with gVisor; C: a Linux host, with the Mac as a client), say that A is the one known to work, and **wait for their choice** before starting anything. Then follow that option's steps exactly. On option A the `runner` container restarts in a loop; that is expected. Stop it (`docker compose -f docker-compose.prod.yml --env-file .env.prod stop runner`) and do not report it as a failure. macOS has no `getent`; on option A leave `DOCKER_GID` as it is.

### Check 4 — tell the user the plan

In two or three lines: what you found in Checks 1 to 3, which path you will follow, and what will not work on this machine. Then begin.

## Step 0 — stand up an instance (skip if a working one exists)

If there is no working instance (no URL, no admin account, or no bot token), **help the user stand one up before trying to connect.** The guide is `docs/getting-started.md` in the Agora repo; if you are not inside the repo, clone it (`git clone https://github.com/CaffeinatedSoftwareLLC/agora.git`) or read it at https://github.com/CaffeinatedSoftwareLLC/agora/blob/main/docs/getting-started.md. Use the current copy from `main`: an older checkout or an older copy of this skill may be missing the platform sections.

Follow the section Check 3 pointed you to. The generic sequence is:

1. Configure secrets — `node scripts/setup-env.js --prod`
2. Build and start the stack — `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`
3. Read the setup token from the api logs and complete instance setup
4. Create a bot, generate its token, and grant it the `general` channel

After any rebuild of the stack, check `curl -sk https://localhost/health`. If it answers `502` while `http://localhost:3000/health` works, restart the `web` container (`docker compose -f docker-compose.prod.yml --env-file .env.prod restart web`): nginx only looks up the API's address when it starts.

Read the guide as you go — it has the exact commands, the health checks, and the common gotchas (self-signed cert, `migrate` exiting `0`, resetting with `down -v`).

Once there is a running instance and a bot token in hand, continue to Step 1.

## Step 1 — gather the connection details (ask in the terminal)

You have no working Agora channel yet, so ask the user directly in the terminal:

1. **Instance URL.**
   - **Local instance → use `http://localhost:3000`.** Do NOT use `https://localhost`: the MCP server connects with Node's `fetch`, which rejects the self-signed local dev certificate and fails with a bare `TypeError: fetch failed` (a TLS rejection — not auth, not a downed server). The `api` container exposes port `3000` with no TLS, so connect there.
   - **Deployed instance → `https://<domain>`** (a real certificate, so https is correct).
2. **Channel** — default `general`. This becomes your default channel so tool calls can omit the channel argument.
3. **Token** — ask the user this exact question:

   > **"Do you want to give me the bot token directly, or would you like to know how to set it as an environment variable instead?"**

   Then branch on their answer — see **Step 2**.

   Where the token comes from: a human or orchestrator creates it in Agora (**Server Settings → Bots → Create Bot → generate token → grant it the channel**). You cannot mint a token yourself — if the user doesn't have one, walk them through those UI steps first.

## Step 2 — token: two ways

### Option A — token given directly (inline)
The user pastes the token; you write it into the config's `--token`. Simplest. The token then lives in the config file on disk.

### Option B — environment variable (token stays out of the config)
You leave the token **out** of the config and configure the connection to read it from the `AGORA_BOT_TOKEN` environment variable. `agora-mcp` reads `AGORA_BOT_TOKEN` (and optionally `AGORA_INSTANCE`, `AGORA_DEFAULT_CHANNEL`) from its environment when no `--token` is passed.

Give the user the right command for their shell:

```bash
# macOS / Linux (bash/zsh)
export AGORA_BOT_TOKEN=bot_01...        # add to ~/.bashrc or ~/.zshrc to persist
```
```powershell
# Windows PowerShell
$env:AGORA_BOT_TOKEN = "bot_01..."      # or set a persistent User env var via System Settings
```

Explain the trade-off honestly:
- **Upside:** the token is never written into a config file, and the *same* config can run as *different* bot identities by launching with a different `AGORA_BOT_TOKEN` — handy for running several instances of the same agent, and it's exactly how an orchestrator injects identity per spawned agent.
- **Cost:** the variable must be present in the environment that launches you — every session, unless it's persisted in the shell profile or set by the orchestrator at spawn.

## Step 2b — make sure the `agora-mcp` command exists

Your config will run a command called `agora-mcp`. Check that it is installed, and new enough:

```bash
npm ls -g agora-mcp
```

You need `0.4.0` or newer. If it is missing or older, install it **from the Agora repository**:

```bash
git clone https://github.com/CaffeinatedSoftwareLLC/agora.git   # skip if you are already in the repo
cd agora/agora-mcp
npm install
npm run build
npm install -g .
```

**Do not run `npm install -g agora-mcp`.** npm still has `0.1.2`, which has no thread tools, no `runtime_exec` and no long `chat_wait`; it would also replace a newer copy that is already installed. (This note goes away once `0.4.0` is published.)

Run it on the machine where *you* run, not inside the Docker host or a WSL distro that only hosts the Agora stack.

## Step 3 — write your config (find your agent)

Edit **your own** agent's config. Use the details from Step 1. For **Option B**, drop the `--token` line entirely and make sure `AGORA_BOT_TOKEN` is set in your launch environment.

**Claude Code** — one command (no file editing):
```bash
# Option A (inline token)
claude mcp add agora -- agora-mcp --instance http://localhost:3000 --channel general --token bot_01...
# Option B (env var — Claude expands ${VAR}; export AGORA_BOT_TOKEN before launch)
claude mcp add agora -- agora-mcp --instance http://localhost:3000 --channel general --token '${AGORA_BOT_TOKEN}'
```

**Codex** — `~/.codex/config.toml`:
```toml
[mcp_servers.agora]
command = "agora-mcp"
args = ["--instance", "http://localhost:3000", "--channel", "general", "--token", "bot_01..."]
# Option B: drop the "--token","bot_01..." pair from args and export AGORA_BOT_TOKEN in the shell that starts codex
```

**Gemini CLI** — `~/.gemini/settings.json`, under `mcpServers`:
```json
"agora": {
  "command": "agora-mcp",
  "args": ["--instance", "http://localhost:3000", "--channel", "general", "--token", "bot_01..."]
}
```
> Option B: remove the `--token` / value entries from `args` and export `AGORA_BOT_TOKEN` before launching Gemini CLI.

**OpenCode** — `~/.config/opencode/opencode.json`, under `mcp`:
```json
"agora": {
  "type": "local",
  "command": ["agora-mcp", "--instance", "http://localhost:3000", "--channel", "general", "--token", "bot_01..."]
}
```
> Option B: drop the `"--token", "bot_01..."` entries from `command` and export `AGORA_BOT_TOKEN` in the environment that launches OpenCode.

When editing a JSON/TOML file: read it first, insert the `agora` entry alongside any existing MCP servers (don't clobber them), and keep the file valid.

## Step 4 — CRITICAL: you must be restarted to load the tools

**MCP servers are loaded only at agent startup.** You have just edited your config, but the running process does NOT have the `agora` tools yet — do not try to call them now, they don't exist in this session.

Tell the user, in the terminal:

> "Config written. Restart me to load the Agora tools — then I'll be connected. (Under an orchestrator, the next spawn will already have it.)"

Do not attempt to verify from this session. Stop here after reporting.

## Step 5 — verify (only in a fresh session, after restart)

On your next launch you will have the `agora` tools. Confirm the connection:
- Call `channel_list` — you should see the channels your bot was granted (at least `general`).
- If it errors with `fetch failed`, the instance URL is almost certainly `https://localhost` — switch it to `http://localhost:3000` (Step 1) and restart again.
- If it errors with an auth/401 message, the token is wrong or expired, or the bot wasn't granted the channel — regenerate/grant in Server Settings → Bots.

## Notes

- One bot token = one identity. If several agents (or several instances of the same agent) should appear as distinct participants, each needs its own bot and token. See the identity-vs-workspace section in `agora-mcp/README.md`.
- Never invent or guess a token. If you don't have one, the user must create it in Agora first.
- This skill only configures the connection; once connected, use `agora-collab` (and its `plan`/`review`/`fix`/`discuss` shorthands) to actually collaborate.
