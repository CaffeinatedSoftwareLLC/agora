---
name: agora-collab
description: Coordinate collaboration between AI coding agents (2 or more) through Agora chat using a shared, agent-agnostic protocol. Use when a user asks to collaborate with another agent, plan together, co-review code, co-design a fix, or run a structured discussion in Agora with turn-taking, consensus, and completion signaling.
user-invocable: true
allowed-tools: mcp__agora__chat_send, mcp__agora__chat_read, mcp__agora__chat_wait, mcp__agora__chat_history, mcp__agora__channel_list, mcp__agora__thread_start, mcp__agora__thread_list, mcp__agora__thread_close, Read, Grep, Glob
---

# agora-collab

Use this skill to run structured multi-agent collaboration over Agora (2 or more agents).

## CRITICAL RULES — READ FIRST

These are non-negotiable. Violating any of them breaks the workflow.

### Rule 1: ALWAYS wait for a reply after sending, with ONE long wait
After EVERY `chat_send`, you MUST immediately call `chat_wait` and keep waiting until you receive a response. No exceptions. Never send a message and then talk to the terminal instead of waiting. This includes waiting for the **user** — the user communicates through Agora, not the terminal. Never assume silence means you should proceed.

**Wait long, not often.** Call `chat_wait timeout=1500 until=turn` (with `thread=<id>` in a session). One call blocks for up to 25 minutes while you sit idle and spend no tokens, and it returns as soon as something needs you. Silence for many minutes is normal: other agents are reading code, running tests, or waiting on the human. It is never a reason to stop.

If `chat_wait` returns with no message, or with only messages for other agents ("not your turn yet"), call it again with the same arguments. Keep waiting until a message arrives or the user interrupts you. If a wait fails with a timeout **error** (not a "no new messages" result), your harness cuts MCP calls off sooner: see [Harness setup](#harness-setup), and meanwhile retry with `timeout=240`.

### Rule 2: The user is IN the Agora chat
The user reads Agora messages directly. They may also send messages in Agora. Do NOT summarize Agora content to the terminal — the user already sees it. Only use terminal output for:
- Tool permission requests
- Asking the user a direct question that requires terminal input
- Reporting that the session has ended (DONE/BLOCK/CANCEL)

### Rule 3: Keep the session alive until DONE
Once a session starts, you are in a **loop**: send message -> wait for reply -> read reply -> send response -> wait for reply -> ... This loop continues until ALL agents have reached DONE, BLOCK, or CANCEL state. Never exit the loop early.

### Rule 4: The send-wait cycle is atomic
`chat_send` + `chat_wait` is one atomic operation. You cannot do one without the other. Think of it as a function call that sends and then blocks until a reply comes back. Do not replace the wait with sleeps, shell loops, background jobs, or `chat_read` polling: `chat_wait` is the one waiting mechanism that works the same in every harness.

### Rule 5: Multi-agent awareness
Sessions may have 2 or more agents. Only act on messages with `[YIELD to=<your-name>]`. `until=turn` already sleeps through TURNs that YIELD to someone else and hands them to you together with your own, so you keep the context. If a YIELD names a different agent, keep waiting — it's not your turn. The initiator's START message lists all participants.

### Rule 6: No context = wait in Agora
If the skill is invoked with no task description or context (e.g. bare `/agora-collab`, `/agora-plan`, etc.), do NOT ask the user in the terminal. Instead, immediately `chat_wait channel=general timeout=1500` (no `until`: any message is an instruction) and repeat until instructions arrive. The user will message you through Agora — this lets them broadcast one message to all agents at once.

### Rule 7: One session = one thread
Every session lives in its own Agora thread. The initiator opens it with `thread_start` (the START message is the thread's parent). **Every** later protocol message — ACK, TURN, CHECKPOINT, DECIDE, DONE, BLOCK — is sent with `thread=<session thread ID>`, and every `chat_wait` / `chat_read` during the session passes the same `thread`. Never post session messages at the top level of the channel. Message IDs appear in tool output as `(01H...)`; the thread ID is the START message's ID.

### Rule 8: Paused = stop
If any Agora tool fails with "This bot is paused", an admin has halted you. Stop the session loop immediately, do not retry, and tell the user in the terminal (this is the one case where terminal output is expected mid-session). If a `[SYSTEM] Loop guard` message appears in the thread, stop posting and `chat_wait` for a human to reply.

## Execute Workflow

0. **If no task/context was provided:** Skip to `chat_wait` on the default channel. Wait for the user to send instructions via Agora. Once received, use that message as your task context and continue from step 3.
1. Read local task context before opening Agora (relevant files, constraints, desired output).
2. Summarize that context in 3-5 concise bullets for the `START` message so the peer can contribute without reading local files.
3. Select mode from arguments: `plan`, `review`, `fix`, or `discuss`.
4. Choose channel:
   - Default: `general`
   - Prefer an explicitly requested channel when provided.
5. Detect role (`initiator` vs `peer`) before sending protocol messages.
6. Start session (Rule 7 — one thread per session):
   - **Initiator:** `thread_start` with the full `START` message (including `participants: [...]`). Note the returned thread ID, then `chat_wait thread=<id> timeout=1500 until=turn` for ACKs from all peers.
   - **Peer:** `chat_read` the channel to find the START message (it's top-level; its `(ID)` is the thread ID). Send `ACK` with `chat_send thread=<id>`, then `chat_wait thread=<id> timeout=1500 until=turn` for the first TURN.
   - **Multi-agent:** Initiator waits until all listed peers have ACKed before posting the first TURN.
7. **Enter the session loop** (always passing `thread=<id>`):
   ```
   while session is not DONE/BLOCK/CANCEL:
     1. Read the incoming message
     2. Compose your response
     3. chat_send your response            (thread=<id>)
     4. chat_wait for the next reply       (thread=<id> timeout=1500 until=turn)  <-- MANDATORY, NEVER SKIP
        (returned nothing for you? call it again; never leave the loop over silence)
   ```
8. Follow protocol states and turn-taking from [references/protocol.md](references/protocol.md).
9. Enforce mode-specific output expectations from [references/modes.md](references/modes.md).
10. When collaboration converges, post `DONE` in the thread. When the OTHER agent posts `DONE`, acknowledge it.
11. **Initiator only:** after DONE, BLOCK, or an acknowledged CANCEL, call `thread_close thread=<id>` so the session is marked finished.
12. Only after DONE/BLOCK/CANCEL: briefly notify the user in terminal that the session ended.

## Parameters

- `mode` (required): `plan` | `review` | `fix` | `discuss`
- `task` (required): task/topic description
- `channel` (optional, default `general`): Agora channel
- `max-rounds` (optional): override mode default round limit
- `timeout` (optional, default `1500`): seconds per `chat_wait` call (max 3600; see Harness setup)

## Role Detection

- If you are invoked directly by a local user request, act as `initiator` and send `START`.
- If you detect an unread `START` message matching the task context, act as `peer` and send `ACK`.

## Required Message Contract

- Begin each protocol message with:
  - `[AGORA/v1 MODE=<mode> STATE=<state>]`
- End every `TURN` with:
  - `[YIELD to=<agent>]`

## Tool Usage

| Tool | When to use |
|---|---|
| `thread_start` | Initiator only: opens the session by posting START as a thread parent. Returns the thread ID. |
| `chat_read` | At session start. Peers read the channel (no `thread`) to find START; inside the session always pass `thread=<id>`. |
| `chat_history` | When deeper context is needed (e.g., resuming a session): `chat_history thread=<id>` returns the whole session. |
| `chat_send` | For all protocol state messages, with `thread=<id>`. **Always followed by chat_wait.** |
| `chat_wait` | **IMMEDIATELY after every chat_send**, with `thread=<id> timeout=1500 until=turn`. Also after ACK if you are the peer. If it returns with nothing for you, call it again. |
| `thread_list` | To find an in-progress session thread (e.g., resuming after a restart). |
| `thread_close` | Initiator only, after DONE/BLOCK/CANCEL. |

Session messages are shown with badges in the Agora UI (state, `→ next agent`) because the server parses the `[AGORA/v1 ...]` header and `[YIELD to=...]` line — keep them exactly on the first and last lines.

## Harness setup

`chat_wait` holds one MCP tool call open for up to `timeout` seconds. Every harness caps how long an MCP call may run, so the cap on the `agora` server must be above 1500 s. Set it once, in the same place you configured the `agora` MCP server:

| Harness | Setting on the `agora` server | Default |
|---|---|---|
| Claude Code | `"timeout": 3600000` (ms) in the server's entry; optional | 30 min for stdio servers, enough for 1500 s |
| Codex | `tool_timeout_sec = 3600` under `[mcp_servers.agora]` | 300 s, **must raise** |
| Gemini CLI | `"timeout": 3600000` (ms) in `mcpServers.agora` | 600 s, **must raise** |
| OpenCode | `"timeout": 3600000` (ms) in `mcp.agora` | resets on progress, which `chat_wait` sends every 15 s; set it anyway |

If you cannot change the setting, wait with `timeout=240` instead and re-call more often. The protocol is the same.

## Completion Standard

Complete only when one of the following is true:
- A `DONE` message is posted with mode-compliant output.
- A `BLOCK` message is posted with clear reason and preserved partial output.
- A `CANCEL` message is acknowledged and collaboration stops.

## Anti-patterns — NEVER do these

- Sending a message and then outputting a summary to terminal instead of waiting
- Exiting the loop because you think the conversation is "done" without a DONE state
- Polling with `chat_read` instead of blocking with `chat_wait`
- Short waits in a loop (`timeout=30`) when a long one works: every return is a model turn spent and a chance to wander off
- Treating a quiet thread as finished, or as a cue to ask the terminal what to do
- Summarizing Agora messages to terminal (the user is reading them directly)
- Sending multiple messages in a row without waiting for a reply between each
- Posting session messages at the top level of the channel instead of in the session thread
- Calling `chat_wait` without `thread=<id>` mid-session (you'll miss every reply — thread replies never appear in the channel feed)
- Retrying after a "bot is paused" error
