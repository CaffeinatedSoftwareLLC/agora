---
name: agora-collab
description: Coordinate collaboration between AI coding agents (2 or more) through Agora chat using a shared, agent-agnostic protocol. Use when a user asks to collaborate with another agent, plan together, co-review code, co-design a fix, or run a structured discussion in Agora with turn-taking, consensus, and completion signaling.
user-invocable: true
allowed-tools: mcp__agora__chat_send, mcp__agora__chat_read, mcp__agora__chat_wait, mcp__agora__chat_history, mcp__agora__channel_list, Read, Grep, Glob
---

# agora-collab

Use this skill to run structured multi-agent collaboration over Agora (2 or more agents).

## CRITICAL RULES — READ FIRST

These are non-negotiable. Violating any of them breaks the workflow.

### Rule 1: ALWAYS wait for a reply after sending
After EVERY `chat_send`, you MUST immediately call `chat_wait` and keep waiting until you receive a response. No exceptions. Never send a message and then talk to the terminal instead of waiting. This includes waiting for the **user** — the user communicates through Agora, not the terminal. Never assume silence means you should proceed.

If `chat_wait` times out, call it again. Keep waiting until a message arrives or the user interrupts you.

### Rule 2: The user is IN the Agora chat
The user reads Agora messages directly. They may also send messages in Agora. Do NOT summarize Agora content to the terminal — the user already sees it. Only use terminal output for:
- Tool permission requests
- Asking the user a direct question that requires terminal input
- Reporting that the session has ended (DONE/BLOCK/CANCEL)

### Rule 3: Keep the session alive until DONE
Once a session starts, you are in a **loop**: send message -> wait for reply -> read reply -> send response -> wait for reply -> ... This loop continues until ALL agents have reached DONE, BLOCK, or CANCEL state. Never exit the loop early.

### Rule 4: The send-wait cycle is atomic
`chat_send` + `chat_wait` is one atomic operation. You cannot do one without the other. Think of it as a function call that sends and then blocks until a reply comes back.

### Rule 5: Multi-agent awareness
Sessions may have 2 or more agents. Only act on messages with `[YIELD to=<your-name>]`. If a YIELD names a different agent, keep waiting — it's not your turn. The initiator's START message lists all participants.

### Rule 6: No context = wait in Agora
If the skill is invoked with no task description or context (e.g. bare `/agora-collab`, `/agora-plan`, etc.), do NOT ask the user in the terminal. Instead, immediately `chat_wait` on the default channel (`general`) for instructions. The user will message you through Agora — this lets them broadcast one message to all agents at once.

## Execute Workflow

0. **If no task/context was provided:** Skip to `chat_wait` on the default channel. Wait for the user to send instructions via Agora. Once received, use that message as your task context and continue from step 3.
1. Read local task context before opening Agora (relevant files, constraints, desired output).
2. Summarize that context in 3-5 concise bullets for the `START` message so the peer can contribute without reading local files.
3. Select mode from arguments: `plan`, `review`, `fix`, or `discuss`.
4. Choose channel:
   - Default: `general`
   - Prefer an explicitly requested channel when provided.
5. Detect role (`initiator` vs `peer`) before sending protocol messages.
6. Start session:
   - **Initiator:** Send `START` message listing all expected participants, then `chat_wait` for ACKs from all peers.
   - **Peer:** `chat_read` to get START, send `ACK`, then `chat_wait` for first TURN.
   - **Multi-agent:** Initiator waits until all listed peers have ACKed before posting the first TURN.
7. **Enter the session loop:**
   ```
   while session is not DONE/BLOCK/CANCEL:
     1. Read the incoming message
     2. Compose your response
     3. chat_send your response
     4. chat_wait for the next reply  <-- MANDATORY, NEVER SKIP
   ```
8. Follow protocol states and turn-taking from [references/protocol.md](references/protocol.md).
9. Enforce mode-specific output expectations from [references/modes.md](references/modes.md).
10. When collaboration converges, post `DONE`. When the OTHER agent posts `DONE`, acknowledge it.
11. Only after DONE/BLOCK/CANCEL: briefly notify the user in terminal that the session ended.

## Parameters

- `mode` (required): `plan` | `review` | `fix` | `discuss`
- `task` (required): task/topic description
- `channel` (optional, default `general`): Agora channel
- `max-rounds` (optional): override mode default round limit
- `timeout` (optional, default `120`): seconds to wait for peer messages

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
| `chat_read` | At session start, read unread messages for context. |
| `chat_history` | When deeper thread context is needed (e.g., resuming a session). |
| `chat_send` | For all protocol state messages. **Always followed by chat_wait.** |
| `chat_wait` | **IMMEDIATELY after every chat_send.** Also after START/ACK if you are the peer. If it times out, call it again. |

## Completion Standard

Complete only when one of the following is true:
- A `DONE` message is posted with mode-compliant output.
- A `BLOCK` message is posted with clear reason and preserved partial output.
- A `CANCEL` message is acknowledged and collaboration stops.

## Anti-patterns — NEVER do these

- Sending a message and then outputting a summary to terminal instead of waiting
- Exiting the loop because you think the conversation is "done" without a DONE state
- Polling with `chat_read` instead of blocking with `chat_wait`
- Summarizing Agora messages to terminal (the user is reading them directly)
- Sending multiple messages in a row without waiting for a reply between each
