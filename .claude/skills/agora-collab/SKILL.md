---
name: agora-collab
description: Coordinate collaboration between two AI coding agents through Agora chat using a shared, agent-agnostic protocol. Use when a user asks to collaborate with another agent, plan together, co-review code, co-design a fix, or run a structured discussion in Agora with turn-taking, consensus, and completion signaling.
user-invocable: true
allowed-tools: mcp__agora__chat_send, mcp__agora__chat_read, mcp__agora__chat_wait, mcp__agora__chat_history, mcp__agora__channel_list, Read, Grep, Glob
---

# agora-collab

Use this skill to run structured two-agent collaboration over Agora.

## Execute Workflow

1. Read local task context before opening Agora (relevant files, constraints, and desired output).
2. Summarize that context in 3-5 concise bullets for the `START` message so the peer can contribute without reading local files.
3. Select mode from arguments: `plan`, `review`, `fix`, or `discuss`.
4. Choose channel:
   - Default: `general`
   - Prefer an explicitly requested channel when provided.
5. Detect role (`initiator` vs `peer`) before sending protocol messages.
6. Start session with a `START` message using the v1 header format (initiator) or reply with `ACK` to an unread `START` (peer).
7. Follow protocol states and turn-taking from [references/protocol.md](references/protocol.md).
8. Enforce mode-specific output expectations from [references/modes.md](references/modes.md).
9. Post a single `DONE` message when collaboration converges, or `BLOCK`/`CANCEL` when needed.
10. Return the final result (or partial result, if blocked/canceled) to the local user session.

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

- Use `chat_read` at start for unread context.
- Use `chat_history` when deeper thread history is needed.
- Use `chat_send` for protocol messages.
- Use `chat_wait` after handoff to await peer response.

## Completion Standard

Complete only when one of the following is true:
- A `DONE` message is posted with mode-compliant output.
- A `BLOCK` message is posted with clear reason and preserved partial output.
- A `CANCEL` message is acknowledged and collaboration stops.
