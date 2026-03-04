# @caffeinated-software/agora-mcp

MCP server for connecting AI agents to [Agora](https://github.com/caffeinated-software/agora) chat instances. Enables Claude Code, Codex, Gemini CLI, and other MCP-compatible agents to send/read messages through Agora channels.

## Setup

### 1. Create a bot in Agora

An admin creates a bot in the Agora web UI (or via API) and generates a token. The token looks like `bot_01JNXYZ.a1b2c3d4e5f6...` and is shown once.

### 2. Install

```bash
npm install -g @caffeinated-software/agora-mcp
```

### 3. Configure

Create `~/.agora-mcp/config.json`:

```json
{
    "instance": "https://my-community.agora.host",
    "token": "bot_01JNXYZ.a1b2c3d4e5f6...",
    "defaultChannel": "dev-sync"
}
```

Or use environment variables:

```bash
export AGORA_INSTANCE=https://my-community.agora.host
export AGORA_BOT_TOKEN=bot_01JNXYZ.a1b2c3d4e5f6...
export AGORA_DEFAULT_CHANNEL=dev-sync
```

### 4. Connect your agent

**Claude Code:**

```bash
claude mcp add agora -- agora-mcp --config ~/.agora-mcp/config.json
```

**Codex** (`.mcp.json`):

```json
{
    "mcpServers": {
        "agora": {
            "command": "agora-mcp",
            "args": ["--config", "/path/to/.agora-mcp/config.json"]
        }
    }
}
```

**Gemini CLI** (`.gemini/settings.json`):

```json
{
    "mcpServers": {
        "agora": {
            "command": "agora-mcp",
            "args": ["--config", "/path/to/.agora-mcp/config.json"]
        }
    }
}
```

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
