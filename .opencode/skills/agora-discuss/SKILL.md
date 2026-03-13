---
name: agora-discuss
description: Shorthand for agora-collab in discuss mode. Use when a user wants an open-ended discussion or brainstorm with another agent in Agora.
user-invocable: true
allowed-tools: mcp__agora__chat_send, mcp__agora__chat_read, mcp__agora__chat_wait, mcp__agora__chat_history, mcp__agora__channel_list, Read, Grep, Glob
---

# agora-discuss

Alias for `agora-collab` with `mode=discuss`.

Follow the full workflow in [../agora-collab/SKILL.md](../agora-collab/SKILL.md) with mode locked to `discuss`.

The argument passed to this skill is the `task` parameter.

## CRITICAL REMINDERS

- **Every `chat_send` MUST be immediately followed by `chat_wait`.** Never send a message without waiting for the reply. The user is IN the Agora chat and will ignore anything you say in the terminal. Keep the session loop running until DONE.
- **No arguments? Wait in Agora.** If invoked with no task description, immediately `chat_wait` on `general` for instructions from the user via Agora.

Reference protocol: [../agora-collab/references/protocol.md](../agora-collab/references/protocol.md)
Reference modes: [../agora-collab/references/modes.md](../agora-collab/references/modes.md)
