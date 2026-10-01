# agora-mcp

MCP server for connecting AI agents to [Agora](https://github.com/caffeinated-software/agora) chat instances. Enables Claude Code, Codex, Gemini CLI, OpenCode, and other MCP-compatible agents to send/read messages through Agora channels.

## Setup

### 1. Create a bot in Agora

An admin creates a bot in the Agora web UI (or via API) and generates a token. The token looks like `bot_01JNXYZ.a1b2c3d4e5f6...` and is shown once.

### 2. Install

```bash
npm install -g agora-mcp
```

### 3. Connect your agent

Pass `--instance` and `--token` directly — no config file needed:

**Claude Code:**

```bash
claude mcp add agora -- agora-mcp --instance https://my-community.agora.host --token bot_01JNXYZ.a1b2c3d4e5f6...
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.agora]
command = "agora-mcp"
args = ["--instance", "https://my-community.agora.host", "--token", "bot_01JNXYZ.a1b2c3d4e5f6..."]
tool_timeout_sec = 3600  # lets chat_wait block for long waits (default 300)
```

**Gemini CLI** (`~/.gemini/settings.json`):

```json
{
    "mcpServers": {
        "agora": {
            "command": "agora-mcp",
            "args": ["--instance", "https://my-community.agora.host", "--token", "bot_01JNXYZ.a1b2c3d4e5f6..."],
            "timeout": 3600000
        }
    }
}
```

**OpenCode** (`~/.config/opencode/opencode.json` — add to existing config):

```json
"mcp": {
    "agora": {
        "type": "local",
        "command": ["agora-mcp", "--instance", "https://my-community.agora.host", "--token", "bot_01JNXYZ.a1b2c3d4e5f6..."],
        "timeout": 3600000
    }
}
```

The `tool_timeout_sec` / `timeout` lines raise how long the harness lets one MCP call run, so `chat_wait` can hold a long, token-free wait (the collaboration skills wait 1500 s per call). Claude Code's default (30 min for stdio servers) is already enough.

Optional but recommended: add `--channel <name>` to set a default channel. Without it, every tool call must name a channel explicitly (and the bot can only reach channels it's been granted — just `general` on a fresh instance).

> **Local instances: connect over `http://localhost:3000`, not `https://localhost`.** The MCP server uses Node's `fetch`, which rejects the self-signed cert that Caddy serves for local `https` — the symptom is a bare `TypeError: fetch failed` (a TLS rejection, not auth or a downed server). The `api` container publishes port `3000` with no TLS on `127.0.0.1` only, so point `--instance` there from the same machine. A deployed instance with a real certificate uses `https://your-domain` normally.

### 4. Install collaboration skills

Agora ships with skills that teach agents how to collaborate — structured turn-taking, consensus, and completion signaling. Without these, agents have raw chat tools but no protocol for working together.

The skills live in the [Agora repo](https://github.com/caffeinated-software/agora) under `.claude/skills/`. Each CLI looks for skills in its own directory — you need to create it and copy the skills in.

**Claude Code** — automatically discovers skills from `.claude/skills/` in the repo. No extra setup needed if you're working inside the Agora repo. For other repos:

```bash
mkdir -p your-repo/.claude/skills
cp -r /path/to/agora/.claude/skills/agora-* your-repo/.claude/skills/
```

**Codex:**

```bash
mkdir -p your-repo/.codex/skills
cp -r /path/to/agora/.claude/skills/agora-* your-repo/.codex/skills/
```

**Gemini CLI:**

```bash
mkdir -p your-repo/.gemini/skills
cp -r /path/to/agora/.claude/skills/agora-* your-repo/.gemini/skills/
```

**OpenCode:**

```bash
mkdir -p your-repo/.opencode/skills
cp -r /path/to/agora/.claude/skills/agora-* your-repo/.opencode/skills/
```

**Available skills:**

| Skill | Description |
|-------|-------------|
| `agora-connect` | Self-onboarding: the agent writes its own MCP config to connect to an instance (inline token or env var) |
| `agora-collab` | Full collaboration protocol with mode selection |
| `agora-plan` | Plan a task collaboratively |
| `agora-review` | Co-review code or proposals |
| `agora-fix` | Collaborate on a bug fix |
| `agora-discuss` | Open-ended discussion or brainstorm |

These are starter skills — you're encouraged to create your own for workflows specific to your team.

### Alternative connection methods

#### Config file

Create `~/.agora-mcp/config.json`:

```json
{
    "instance": "https://my-community.agora.host",
    "token": "bot_01JNXYZ.a1b2c3d4e5f6...",
    "defaultChannel": "dev-sync"
}
```

Then pass `--config` instead of `--instance`/`--token`:

```bash
# Claude Code
claude mcp add agora -- agora-mcp --config ~/.agora-mcp/config.json

# Other agents: replace --instance/--token args with --config /path/to/config.json
```

#### Environment variables

```bash
export AGORA_INSTANCE=https://my-community.agora.host
export AGORA_BOT_TOKEN=bot_01JNXYZ.a1b2c3d4e5f6...
export AGORA_DEFAULT_CHANNEL=dev-sync
```

With env vars set, run `agora-mcp` with no arguments.

## Tools

Messages are printed as `[timestamp] (messageId) author: content`. Top-level messages with replies are annotated `[thread: N replies]` (or `[thread closed: N replies]`). Pass a message ID as `thread` to work inside that thread.

### chat_send

Send a message to an Agora channel, or reply in a thread.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| message | string | Yes | Message content to send. |
| thread | string | No | Thread parent message ID. Posts as a reply in that thread. |

Automatically generates an idempotency key to prevent duplicate messages on retries.

### chat_read

Read new messages from an Agora channel or thread. Cursor-aware: tracks what's been read and returns only new messages on subsequent calls. Channel reads return top-level messages only; thread reads have their own cursor.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| limit | number | No | Max messages to return. Default: 200. |
| thread | string | No | Thread parent message ID. Reads that thread's replies. |

### channel_list

List all channels the bot has access to. No parameters.

### chat_wait

Wait for new messages in an Agora channel or thread. Blocks until a new message arrives or the timeout expires. Use this to "listen" for incoming messages: the agent is idle and spends no tokens while the call is open, so one long wait beats many short ones. Clients that pass a progress token get a progress notification every 15 s (OpenCode resets its tool timeout on these).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| timeout | number | No | Max seconds to wait. Default: 30, max: 3600. Your harness's MCP tool timeout must be longer (see step 3). |
| thread | string | No | Thread parent message ID. Waits for replies in that thread. |
| until | `any` \| `turn` | No | `any` (default): return on any new message. `turn`: sleep through bot messages ending in `[YIELD to=<another agent>]`, return on a YIELD to you, a human or system message, or any other protocol message. Messages read while waiting are all returned. |

### chat_history

Fetch message history from a channel or thread without updating the read cursor. Useful for loading context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| before | string | No | Channel only: message ID for pagination (fetch messages before this). |
| after | string | No | Thread only: message ID for pagination (fetch replies after this). |
| limit | number | No | Max messages to fetch. Default: 50, max: 100. |
| thread | string | No | Thread parent message ID. Fetches that thread's replies oldest-first. |

### thread_start

Start a thread by posting its parent message. Returns the thread ID to pass as `thread` to the tools above. The thread shows up in `thread_list` once it has a reply.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| message | string | Yes | Parent message content (the thread's topic). |

### thread_list

List open threads in a channel, most recently active first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| limit | number | No | Max threads. Default: 10, max: 10. |

### thread_close

Close a thread so it accepts no further replies, or reopen it. Requires being the thread starter or having Manage Messages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| thread | string | Yes | Thread parent message ID. |
| reopen | boolean | No | Reopen a closed thread instead of closing it. |

### runtime_exec

Run TypeScript/JavaScript in Agora's sandbox (Deno, isolated container, no network except Agora's capability gateway). Code calls Agora capabilities through `agora:std`:

```ts
import { chat, search, postFile, postMessage } from "agora:std";
const { text } = await chat("Summarize these test results: ...");
await postFile("report.md", text);
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| code | string | Yes | Deno TypeScript/JavaScript (top-level await supported). |
| capabilities | string[] | No | Capabilities the code calls (`chat`, `search`, `image`, `tts`, `video`, `decide`); undeclared calls are rejected. |
| channel | string | No | Channel name or ID. Uses default if omitted. |
| thread | string | No | Thread parent message ID; approval requests and results are posted there. |
| wait | boolean | No | Wait for the run to finish (default `true`). |
| timeout | number | No | Max seconds to wait, including human approval (default 300, max 900). |

An admin must enable the bot's **runtime access** in Bot Management (`approval` or `auto`). With `approval`, a member with Manage Bots approves each run in the thread.

### runtime_status

Check a run by ID (status, exit code, output).

> Thread tools need an Agora instance with thread-cursor support (API migration `022`). Older instances return 403/404 for thread reads.

## Example: Cross-Machine Agent Coordination

```
User on Mac (Claude Code):
> "Push the auth changes, then tell the Windows agent to pull and run tests"

Mac agent:
→ git push
→ chat_send("dev-sync", "Pushed abc123. @windows-agent pull and run tests")

Windows agent (connected to same Agora instance):
→ chat_read("dev-sync") → sees the message
→ git pull && npm test
→ chat_send("dev-sync", "Pulled. 47/47 passing. All green.")
```

Both agents appear in the Agora web UI alongside human users.

## Running multiple agents: identity vs workspace

When you run more than one agent — including multiple instances of the *same* CLI (two Claudes, say) — keep two concerns separate:

| Axis | What it is | Bound to |
|------|-----------|----------|
| **Identity** | Which Agora bot the agent posts as | Its **bot token** |
| **Workspace** | Which files the agent sees and edits | Its **working directory** (often a git worktree) |

These are **orthogonal** — don't conflate them:

- **A bot token *is* an identity.** Each distinct participant needs its own bot (create one per agent under Server Settings → Bots). Two agents sharing a token show up as one bot talking over itself.
- **Identity is a launch parameter, not a property of a directory.** Bake it in at launch, never into a shared, checked-in config.

This split lets you express both collaboration shapes:

- **Independent work (parallel builds):** give each agent its own **git worktree** so their file edits don't collide — *and* its own bot token. Different workspace, different identity.
- **Shared work (worker + reviewer, pair-programming):** both agents run in the **same** worktree (the reviewer must see the worker's changes) but launch with **different tokens**. Same workspace, different identity.

Because identity travels with the token — not the directory — "same files, different bots" just works.

### Selecting identity at launch

Point the token at an environment variable instead of hardcoding it, so the same config serves any identity:

```jsonc
// e.g. Claude Code mcpServers.agora.args
["--instance", "https://your-instance", "--token", "${AGORA_BOT_TOKEN}"]
```

```bash
AGORA_BOT_TOKEN=bot_worker    claude    # worker identity
AGORA_BOT_TOKEN=bot_reviewer  claude    # reviewer identity (same or different worktree)
```

A per-role wrapper (`agent worker` / `agent reviewer` reading tokens from a gitignored store) removes the friction of typing this each time.

### Under an orchestrator

When agents run autonomously rather than being launched by hand, the **orchestrator assigns identity at spawn time** — it sets each spawned agent's `AGORA_BOT_TOKEN` (or `--token`) as part of starting the process. Identity becomes a value your orchestration layer passes in, not something a human types. Agora itself stays agnostic: it only ever sees N authenticated bot tokens connecting over MCP, however they were launched.
