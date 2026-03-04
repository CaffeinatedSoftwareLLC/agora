# agora-collab Protocol v1

## Message Format

Every protocol message begins with a header line:

```
[AGORA/v1 MODE=<mode> STATE=<state>]
```

- `MODE`: one of `plan`, `review`, `fix`, `discuss`
- `STATE`: one of the states defined below

After a TURN message, the sender must end with a handoff line:

```
[YIELD to=<agent>]
```

## States

| State | Sender | Purpose |
|---|---|---|
| `START` | Initiator | Opens session. Includes mode, task description, constraints, done-criteria, and context summary. |
| `ACK` | Peer | Confirms scope. May raise blockers or clarify assumptions. |
| `TURN` | Alternating | Substantive contribution. Must end with `[YIELD to=<peer>]`. |
| `CHECKPOINT` | Either (typically after even-numbered turns) | Summarize agreements so far + open questions. Keeps collaboration on track. |
| `DECIDE` | Either | Emit `AGREE` or `BLOCK <reason>`. Signals readiness to finalize or a hard stop. |
| `DONE` | Either (after mutual AGREE) | Final structured output. Format depends on mode (see modes.md). |
| `BLOCK` | Either | Hard stop with reason. Collaboration pauses. Partial output is preserved. |
| `CANCEL` | User-initiated | Abort at any point. Agent receiving CANCEL should acknowledge and stop. |

## State Machine

```
START ──> ACK ──> TURN ──> TURN ──> CHECKPOINT ──> TURN ──> TURN ──> CHECKPOINT ──> ... ──> DECIDE ──> DONE
                                                                                              \──> BLOCK

Any state ──> CANCEL (user-initiated)
Any state ──> BLOCK  (agent-initiated, on hard blocker)
```

### Rules

1. **Initiator goes first.** After ACK, the initiator posts the first TURN.
2. **Strict alternation.** Each TURN must be followed by a TURN from the other agent (or a CHECKPOINT/DECIDE).
3. **Checkpoint cadence.** A CHECKPOINT should occur every 2 turns (i.e., after both agents have spoken once).
4. **DECIDE requires both.** Both agents must post DECIDE with AGREE before DONE can be emitted. If either posts BLOCK, collaboration pauses.
5. **DONE is singular.** Only one DONE message is posted, by the agent who has the clearest picture of the final output (typically the initiator).

## YIELD Semantics

`[YIELD to=<agent>]` is mandatory after every TURN. It serves two purposes:

1. **Deadlock prevention.** Without YIELD, both agents might `chat_wait` simultaneously.
2. **Clear handoff.** The named agent knows it's their turn to act.

An agent should only call `chat_wait` after posting a message with YIELD (or after START/ACK if they are the peer).

## Timeout Handling

| Scenario | Behavior |
|---|---|
| No ACK within timeout (default: 60s) | Initiator posts `[AGORA/v1 MODE=<mode> STATE=BLOCK] peer_unavailable`. Returns partial output to user. |
| No TURN within timeout (default: 120s) | Waiting agent posts BLOCK with `turn_timeout`. Preserves progress so far. |
| Max rounds exceeded | Current agent posts CHECKPOINT summarizing progress, then DECIDE with AGREE or BLOCK as appropriate. |

## CANCEL Handling

CANCEL is always user-initiated (never agent-initiated — agents use BLOCK instead).

When an agent detects a CANCEL message:
1. Acknowledge: `[AGORA/v1 MODE=<mode> STATE=CANCEL] Acknowledged. Stopping.`
2. Stop posting further TURN messages.
3. Return any partial results to the user's local session.

## Tool Usage

| Tool | When to use |
|---|---|
| `chat_read` | At session start, read unread messages for context. |
| `chat_history` | When deeper thread context is needed (e.g., resuming a session). |
| `chat_send` | For all protocol state messages. |
| `chat_wait` | After posting a YIELD, wait for the peer's response. Use timeout parameter. |

## Session Lifecycle (Agent Perspective)

### As Initiator
1. Read relevant local files/context.
2. `chat_send` START message with context summary.
3. `chat_wait` for ACK.
4. Post first TURN + YIELD.
5. Loop: `chat_wait` → respond with TURN/CHECKPOINT → YIELD.
6. When ready: post DECIDE AGREE.
7. If peer also AGREEs: post DONE with structured output.
8. Return DONE content to local user session.

### As Peer
1. `chat_read` to get START message.
2. `chat_send` ACK (confirm scope or raise blockers).
3. `chat_wait` for first TURN.
4. Loop: respond with TURN + YIELD → `chat_wait`.
5. When ready: post DECIDE AGREE.
6. If initiator posts DONE: acknowledge and stop.
