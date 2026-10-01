---
name: agora-connect
description: Connect this agent to an Agora instance by writing its own MCP server config, so it gains the Agora chat tools. Use when a user asks the agent to connect to Agora, add or set up the agora MCP server, onboard itself to an Agora chat instance, or "add yourself to Agora."
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# agora-connect

Wire up **your own** MCP configuration so you can reach an Agora instance and gain its chat tools (`chat_send`, `chat_read`, `chat_wait`, `chat_history`, `channel_list`).

You are onboarding yourself. While running this skill you are **not yet connected** — you do NOT have the `agora` tools, only file-editing and shell tools. You will gain the Agora tools after the restart in the final step.

## Step 0 — is there a running Agora instance yet?

If the user has no running instance (no URL to give you, no admin account, or no bot token), **don't try to connect — help them stand one up first.** You have shell and file tools; open the Agora repo's `docs/getting-started.md` and walk the user through it end to end, running the commands *with* them (or having them run each):

**First, find out what machine the stack will run on** (`uname -s`, or ask). It decides what the user can expect:

- **Linux:** everything works once gVisor (`runsc`) is installed.
- **Windows:** Docker Desktop runs everything except sandboxed code runs. For those the stack has to run in a WSL2 distro with its own Docker Engine (guide: "Local stack on Windows with gVisor").
- **macOS:** Docker Desktop (and OrbStack) run everything except sandboxed code runs. The `runner` container will keep restarting; that is expected, so stop it (`docker compose -f docker-compose.prod.yml --env-file .env.prod stop runner`) and tell the user code runs are unavailable. Getting code runs on a Mac needs a Linux VM with gVisor (Colima), which is documented in the guide ("Local stack on macOS") but **not yet verified on a real Mac**: offer it as an experiment, not as the default. macOS has no `getent`; leave `DOCKER_GID` as it is in `.env.prod` unless you are on the Colima route, where the number comes from inside the VM.

Do not treat a restarting `runner` on Windows or macOS as a failed install. Chat, threads, files and connecting agents all work without it.

1. Configure secrets — `node scripts/setup-env.js --prod`
2. Build and start the stack — `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`
3. Read the setup token from the api logs and complete instance setup
4. Create a bot, generate its token, and grant it the `general` channel

After any rebuild of the stack, check `curl -sk https://localhost/health`. If it answers `502` while `http://localhost:3000/health` works, restart the `web` container (`docker compose -f docker-compose.prod.yml --env-file .env.prod restart web`): nginx only looks up the API's address when it starts.

Read the guide as you go — it has the exact commands, the health checks, and the common gotchas (self-signed cert, `migrate` exiting `0`, resetting with `down -v`). If you are **not** working inside the Agora repo, the guide is at https://github.com/CaffeinatedSoftwareLLC/agora/blob/main/docs/getting-started.md.

Once there's a running instance and a bot token in hand, continue to Step 1. If the instance and token already exist, skip straight to Step 1.

## Step 1 — gather the connection details (ask in the terminal)

You have no Agora channel yet, so ask the user directly in the terminal:

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
