# agora-collab Protocol v1

## The Golden Rule

**Every `chat_send` MUST be immediately followed by `chat_wait`.** This is the single most important rule in this protocol. If you send a message and do not wait for a reply, the conversation breaks.

## Message Format

Every protocol message begins with a header line:

```
[AGORA/v1 MODE=<mode> STATE=<state>]
```

- `MODE`: one of `plan`, `review`, `fix`, `discuss`
- `STATE`: one of the states defined below

After a TURN message, the sender must end with a handoff line naming the **specific** next agent:

```
[YIELD to=<agent>]
```

In multi-agent sessions, `<agent>` must be one of the participants listed in the START message. Only the named agent should respond — all others keep waiting.

## States

| State | Sender | Purpose |
|---|---|---|
| `START` | Initiator | Opens session. Includes mode, task description, constraints, done-criteria, context summary, and **participants list**. |
| `ACK` | Peer | Confirms scope. May raise blockers or clarify assumptions. |
| `TURN` | Alternating | Substantive contribution. Must end with `[YIELD to=<peer>]`. |
| `CHECKPOINT` | Either (typically after even-numbered turns) | Summarize agreements so far + open questions. Keeps collaboration on track. |
| `DECIDE` | Either | Emit `AGREE` or `BLOCK <reason>`. Signals readiness to finalize or a hard stop. |
| `DONE` | Either (after mutual AGREE) | Final structured output. Format depends on mode (see modes.md). |
| `BLOCK` | Either | Hard stop with reason. Collaboration pauses. Partial output is preserved. |
| `CANCEL` | User-initiated | Abort at any point. Agent receiving CANCEL should acknowledge and stop. |

## State Machine

```
START --> ACK --> TURN --> TURN --> CHECKPOINT --> TURN --> TURN --> CHECKPOINT --> ... --> DECIDE --> DONE
                                                                                            \--> BLOCK

Any state --> CANCEL (user-initiated)
Any state --> BLOCK  (agent-initiated, on hard blocker)
```

### Rules

1. **Initiator goes first.** After all peers ACK, the initiator posts the first TURN.
2. **Explicit handoff via YIELD.** Each TURN must end with `[YIELD to=<agent>]` naming the specific next agent. In 2-agent sessions this is simple alternation. In 3+ agent sessions, the initiator sets the initial turn order and agents YIELD to the next in sequence (round-robin) unless a specific agent needs to respond.
3. **Only act on your YIELD.** If a message ends with `[YIELD to=someone-else]`, keep waiting. Do not respond.
4. **Checkpoint cadence.** A CHECKPOINT should occur every N turns where N = number of participants (i.e., after each agent has spoken once).
5. **DECIDE requires all.** All agents must post DECIDE with AGREE before DONE can be emitted. If any agent posts BLOCK, collaboration pauses.
6. **DONE is singular.** Only one DONE message is posted, by the initiator.

## YIELD Semantics

`[YIELD to=<agent>]` is mandatory after every TURN. It serves three purposes:

1. **Deadlock prevention.** Without YIELD, multiple agents might `chat_wait` simultaneously.
2. **Clear handoff.** The named agent knows it's their turn to act.
3. **Multi-agent ordering.** In 3+ agent sessions, YIELD explicitly routes the conversation to a specific participant.

An agent should only call `chat_wait` after posting a message with YIELD (or after START/ACK if they are a peer). If a message YIELDs to a different agent, ignore it and keep waiting.

## Timeout Handling

| Scenario | Behavior |
|---|---|
| No ACK within timeout (default: 60s) | Initiator posts `[AGORA/v1 MODE=<mode> STATE=BLOCK] peer_unavailable: <agent>`. Returns partial output to user. May continue with remaining peers if at least one ACKed. |
| No TURN within timeout (default: 120s) | Call `chat_wait` again. Keep retrying up to 3 times before posting BLOCK with `turn_timeout`. |
| Max rounds exceeded | Current agent posts CHECKPOINT summarizing progress, then DECIDE with AGREE or BLOCK as appropriate. |

## CANCEL Handling

CANCEL is always user-initiated (never agent-initiated -- agents use BLOCK instead).

When an agent detects a CANCEL message:
1. Acknowledge: `[AGORA/v1 MODE=<mode> STATE=CANCEL] Acknowledged. Stopping.`
2. Stop posting further TURN messages.
3. Return any partial results to the user's local session.

## Tool Usage

| Tool | When to use |
|---|---|
| `chat_read` | At session start, read unread messages for context. |
| `chat_history` | When deeper thread context is needed (e.g., resuming a session). |
| `chat_send` | For all protocol state messages. **ALWAYS followed immediately by `chat_wait`.** |
| `chat_wait` | **IMMEDIATELY after every `chat_send`.** If timeout expires with no message, call `chat_wait` again. |

## Session Lifecycle (Agent Perspective)

### As Initiator
1. Read relevant local files/context.
2. `chat_send` START message with context summary and `participants: [agent1, agent2, ...]` list.
3. `chat_wait` for ACK from each peer. **(Do NOT skip this. In multi-agent sessions, keep waiting until all peers have ACKed.)**
4. Post first TURN + `[YIELD to=<next-agent>]`.
5. `chat_wait` for response. **(Do NOT skip this.)**
6. Loop: read reply -> respond with TURN/CHECKPOINT + YIELD -> `chat_wait`. **(Every send must wait.)**
7. When ready: post DECIDE AGREE, then `chat_wait`.
8. If all peers also AGREE: post DONE with structured output.
9. Only now: briefly notify the terminal that the session ended.

### As Peer
1. `chat_read` to get START message.
2. `chat_send` ACK (confirm scope or raise blockers).
3. `chat_wait` for your YIELD. **(Do NOT skip this. Ignore messages that YIELD to other agents.)**
4. Loop: respond with TURN + `[YIELD to=<next-agent>]` -> `chat_wait`. **(Every send must wait.)**
5. When ready: post DECIDE AGREE, then `chat_wait`.
6. If initiator posts DONE: acknowledge and stop.

## User Participation

The user is a participant in the Agora chat. They can see all messages and may send messages too. Do NOT repeat or summarize Agora content in terminal output. The user is reading the chat directly.
