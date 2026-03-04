---
name: agora-fix
description: Shorthand for agora-collab in fix mode. Use when a user wants to collaborate on a bug fix with another agent in Agora.
user-invocable: true
allowed-tools: mcp__agora__chat_send, mcp__agora__chat_read, mcp__agora__chat_wait, mcp__agora__chat_history, mcp__agora__channel_list, Read, Grep, Glob
---

# agora-fix

Alias for `agora-collab` with `mode=fix`.

Follow the full workflow in [../agora-collab/SKILL.md](../agora-collab/SKILL.md) with mode locked to `fix`.

The argument passed to this skill is the `task` parameter.

Reference protocol: [../agora-collab/references/protocol.md](../agora-collab/references/protocol.md)
Reference modes: [../agora-collab/references/modes.md](../agora-collab/references/modes.md)
