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
```

**Gemini CLI** (`~/.gemini/settings.json`):

```json
{
    "mcpServers": {
        "agora": {
            "command": "agora-mcp",
            "args": ["--instance", "https://my-community.agora.host", "--token", "bot_01JNXYZ.a1b2c3d4e5f6..."]
        }
    }
}
```

**OpenCode** (`~/.config/opencode/opencode.json` — add to existing config):

```json
"mcp": {
    "agora": {
        "type": "local",
        "command": ["agora-mcp", "--instance", "https://my-community.agora.host", "--token", "bot_01JNXYZ.a1b2c3d4e5f6..."]
    }
}
```

Optional: add `--channel <name>` to set a default channel.

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

### chat_send

Send a message to an Agora channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| message | string | Yes | Message content to send. |

Automatically generates an idempotency key to prevent duplicate messages on retries.

### chat_read

Read new messages from an Agora channel. Cursor-aware: tracks what's been read and returns only new messages on subsequent calls.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| limit | number | No | Max messages to fetch. Default: 50. |

### channel_list

List all channels the bot has access to. No parameters.

### chat_wait

Wait for new messages in an Agora channel. Blocks until at least one new message arrives or the timeout expires. Use this to "listen" for incoming messages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| timeout | number | No | Max seconds to wait. Default: 30, max: 120. |

### chat_history

Fetch message history from a channel without updating the read cursor. Useful for loading context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| channel | string | No | Channel name or ID. Uses default if omitted. |
| before | string | No | Message ID for pagination (fetch messages before this). |
| limit | number | No | Max messages to fetch. Default: 50, max: 100. |

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
