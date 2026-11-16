# Live terminals

Status: first slice built (this document says what, and what is later). Migration `104_live_terminal.sql`, box image version 8.

## The idea

A boxed agent can run its normal interactive CLI in a terminal that Agora owns. The session stays alive when every browser is closed. Agora mirrors the one real screen to any device, and the server owner can type into it. Chat stays the main view and the record.

This is a second mode for a boxed agent, chosen per agent by the owner:

| | Per-wake runs (default) | Live terminal |
|---|---|---|
| What runs | A fresh headless process for each wake | One interactive CLI per live channel session, in a pty in the box |
| How messages arrive | The wake prompt | The Claude Code Channel (a push), never typed keys |
| Token budgets | Yes | **No**: tokens are not measured from an interactive CLI |
| Wake limit | Per run | Per turn (a delivered message until the agent goes idle) |
| Run-time limit | Per run | Per turn: the CLI is interrupted with one Escape |
| `@agent /compact` and friends | Agora runs the command | A notice: type it in the terminal |

Only boxed Claude Code can use it in this slice. Settings says plainly that token budgets need per-wake runs.

## Decisions

1. **One live terminal per live channel session.** The session is an ordinary hosted session row (it keeps `/start`, `/end`, the chip, the wake limit) with `agent_sessions.live_mode`. It takes no per-wake runs: the host's claim query skips it (`src/lib/agent-runs.ts`), while server routing treats it like any hosted session and writes its inbox rows (`src/lib/agent-sessions.ts`), which the live hub delivers (decision 5). The CLI's own presence row (a terminal session of the same bot) is not treated as a competing user terminal. Its conversation id is a UUID chosen at `/start` and kept in `native_session_id`, so a restart resumes the same conversation.
2. **The pty is owned by the agent's `agora-host`** (uid 1000), not by the owner's terminal relay (uid 1001). The relay holds a credential the agent must not read, and the agent's screen can show the agent's own secrets: neither belongs in the operator side's memory. `agora-host` already runs as the agent, already holds the host token and bot token (the same boundary as every wake), and already starts the agent's CLI. It starts `claude` through the existing `agora-pty` helper (`agora-host/src/live-terminal.ts`), supervises it (restart with back-off, conversation resumed), and relays the screen over its own Socket.IO connection to the server's live hub with the host token, through the box's edge (the box signature rule applies to this handshake like any other). The scrollback ring (256 KiB) lives in this process's memory and in the hub's memory, nowhere else.
3. **Agora connection of the interactive CLI.** `agora-host` writes, per session, `mcp.json` (the Agora MCP in `--channel-mode`, `--auth subscription` or `api_key` as the profile signs in) and `settings.json` (the hooks) in the session's state folder, and starts `claude --strict-mcp-config --mcp-config … --settings … --dangerously-load-development-channels server:agora` with the box's yeet arguments. The bot token is in the CLI's environment only, as it is for a wake: never in a file or on a command line. A rebuilt box has new tokens and a new container; its `agora-host` starts again from the new config, and the CLI starts again with `--resume`. Screen history does not survive that; the conversation does.
4. **Startup dialogs.** Claude Code may show the development-channel warning, a trust-folder question or an update prompt. The host does what is configurable without keystrokes (`skipDangerousModePermissionPrompt` in the session's settings, the box's quiet environment) and **types nothing at a dialog**. If no `SessionStart` hook has fired 25 s after the CLI started, the state is "waiting on you" with the note `no_signal`, the channel is told once, and the owner answers in the terminal. See "What only a real login can prove".
5. **The server routes, the Channel only carries.** A live session is an ordinary hosted session for the server's routing (`src/lib/agent-sessions.ts`: mention, sole agent, thread follow-up, task thread, protocol, handoff; `mayDirect`, `termsAllow`, owner-bot authority, the plan-owner rule, `started_by`, the loop guard). Routing writes an inbox row. The live hub (`src/lib/boxes/live-hub.ts` `dispatch`) counts the wake there, server-side, against the wake limit as it stands at that moment, and sends `LiveDeliver` to that session's `agora-mcp` for exactly that message, with the session id and channel. `agora-mcp` in live mode (`AGORA_LIVE_SESSION`) pushes only deliveries for its own session and ignores every chat event (`agora-mcp/src/channel.ts` `onLiveDeliver`), then sends `LiveAck`. What is not acknowledged is sent again after 30 s and, in order, whenever the channel connection comes up (a CLI restart, the end of a startup dialog, a box restart); the wake is counted once. A message still undelivered after 10 minutes is said in the channel once. If the Channel cannot be used (flag refused, preview change) the state says `channel_unavailable` and a notice says so; messages wait, nothing is typed.
6. **The controls.** While the owner's keyboard has been active in that terminal in the last 20 s (`AGORA_LIVE_CONTROL_IDLE_MS`), that session's deliveries are held **on the server**: the rows simply wait and go, in order, when the owner leaves or stops. There is no client queue. The page shows "You have the controls". The wake limit holds deliveries the same way and says so.
7. **Mirroring hub** (`src/lib/boxes/live-hub.ts`). Several viewers at once; replay of the ring, then live output; the session outlives all viewers; **one authoritative size**: the one the owner's page last set (120x32 until then), other viewers render at that size, letterboxed, and cannot resize; a viewer that stops reading is dropped (`viewer_stalled`), never waited for; the host is told to pause for 500 ms when it exceeds 2 MiB/s; input is limited like the owner's shell (64 KiB a chunk, 256 KiB/s).
8. **Who can do what.** The server owner may watch, and may type after the first-time confirmation (`live:take`, recorded in the audit log as `live_terminal_take`; the page says the agent sees whatever is typed). People who can direct agents in the session's channel may watch, read-only. Anyone else is refused with the same answer as for a session that does not exist. A bearer token, a bot token and a host token never watch (cookie session and an allowed Origin only). No password is asked per attach.
9. **States** come from Claude Code hooks, through `box/agora-live-hook` (a root-owned wrapper that hands one event to a Unix socket in `/run/agora`, mode 0700, the agent's own): `SessionStart` is idle, `UserPromptSubmit` is working, `Notification` of type `permission_prompt` or `elicitation_dialog` is waiting on you, `PreToolUse` clears waiting, `Stop` is idle. The hooks run in the agent's own CLI, so **what people see (state, turn record) is cooperative**: display and timing only. **Enforced by the server:** who may reach the session (its normal routing, rechecked at delivery with the same checks as the per-wake claim: `recheckLiveRows` in `src/lib/agent-runs.ts`), the wake count and the wake limit, and the hold. **The run-time stop is a safety net against a runaway agent, not against a hostile one**: see decision 11.
10. **Turns.** A turn runs from a prompt until `Stop`. It is "from a message" only if the message id it names is one the server itself delivered to this session (`agent_inbox.live_sent_at`); anything else, including a prompt the owner typed, is a typed turn and counts no wake. The host reads the branch and commit with `git` at both ends. `agent_reported_clean` means the CLI reported `Stop` and both commits were read: **it is the agent's report, not proof, and the receipts grading must not trust it as evidence that work finished.** Otherwise the row says why (`no_idle_signal`, `no_commit_read`, `superseded`, `server_restarted`). Turn events of a session run one after another on the server and one after another on the host; at most one row is open, rows left open by a restart or a lost host are closed, and a session keeps its last 500 turns.
11. **Run-time limit** (the profile's per-run limit). The clock starts when the SERVER pushes a delivery to the session (not at an agent-reported turn start, which never moves it), starts again at the next delivery, and stops at the agent's reported end of the turn that began after the delivery. While it runs past the limit the server asks the host for: Escape, then Escape again, then Ctrl-C, then the host stops the CLI and starts it again with `--resume`, 15 s apart (`AGORA_LIVE_ESCALATE_MS`), one channel notice per step. **What this does and does not stop.** In a box, agora-host and the CLI both run as the agent (uid 1000). Wake counting and delivery are enforced by the server. The run-time stop is carried out by agora-host, and the clock can be ended early by a false `Stop` report, so it stops an agent that is stuck or looping, not an agent that is hostile; the hard stop for a hostile agent is stopping the box. This is the same as for per-wake runs in a box: there too the server decides (a heartbeat answers cancel, the lease runs out) and agora-host, running as the agent, kills the process, so on this point the two modes are equal.
12. **Limits on a host that misbehaves.** Control events: 20 a second, burst 50, then the host is dropped (counted, not logged); at most 8 database operations in flight per host; a "waiting on you" or channel notice at most once per session per 10 minutes; a host that ignores `live:pace` for 10 s is dropped. A host socket is checked again every 15 s (token revoked, generation replaced, box not wanted) and the live socket is opened only by a host that has a live-mode agent (`GET /agent-hosts/@me/live`). Viewers: 5 per person and 25 per session; their account, cookie session (blacklist, token version, account status) and role are checked again every 15 s; typing is unlocked only once the `live_terminal_take` audit entry is written.
13. **What the agent can read.** `chat_wait` in a live session returns at once (messages are pushed to it; a second copy would arrive twice), while `chat_read` and `chat_send` are unchanged: the agent can still read whatever its bot may read. The routing guarantees are about what is pushed to it as an instruction.
14. **Delivery semantics.** Delivery is at least once as far as agora-mcp: the server sends again until agora-mcp acknowledges, and agora-mcp does not push a message twice in one process. An acknowledgement means agora-mcp wrote the push to the CLI's stdio; Claude Code acknowledges nothing, so at the CLI itself delivery is at most once (a CLI that dies between the write and the model reading it loses that push).
15. **Starting.** `/start` for a live-mode agent is refused with a 409 and the reason unless the box is running and its host has connected with live support (an image older than version 8 is rebuilt first). Task-card and subtask sessions of a live-mode agent are ordinary per-wake runs in their own worktree session (their thread is theirs); the mode switch moves only channel-level sessions.

## What is built in this slice

- Mode switch per agent (owner only, boxed Claude Code only, not while a session is live): `PATCH /servers/:id/agent-profiles/:id { sessionMode }`, Settings → Agents → "How it works".
- Session in the box: `agora-host/src/live-terminal.ts`, `box/agora-live-hook`, the image's fake interactive CLI (`box/fake/fake-cli.mjs`) for tests.
- Delivery and the controls hold: `live-hub.ts` `dispatch`, `agora-mcp/src/channel.ts` (`onLiveDeliver`).
- Hub: `src/lib/boxes/live-hub.ts`, route `GET /servers/:id/live-terminals/:sessionId`, migration 104.
- Viewer page `/live-terminal/:serverId/:sessionId` (`agora-ui/src/features/boxes/terminal/LiveTerminalPage.tsx`), opened from the agent's session sheet ("Open terminal"); the chip says "terminal" and "waiting on you".

## Known limits of this slice

- The state shown to people and the turn record are the agent's own reports (decision 9).
- A message that arrives while the CLI is down waits (up to the notice at 10 minutes) and is delivered when its Channel connects; it is not dropped, and not typed.
- The CLI's own writes to `.claude.json` are not under the host's lock (see "only a real login can prove").
- Live mode is Claude Code in a box only; the per-wake settings text for budgets still applies to its task and subtask sessions.

## Later

- The Terminals view (a tile per agent, layouts, status rings), custom layouts.
- Live mode for machine-host agents, Codex, Gemini, opencode.
- Grading a `DONE` against its live turn in the receipts ledger (the data is recorded now).
- Reading the CLI's context use for a hand-off nudge.

## What only a real Claude Code login can prove

The box suite runs an interactive fake CLI that honours the Channel push through the real `agora-mcp` and fires the hooks through the real wrapper. It cannot prove:

1. that the real CLI accepts `--dangerously-load-development-channels server:agora` with no human at the keyboard, and what the warning dialog needs (the design assumes the owner answers it once in the terminal);
2. that `skipDangerousModePermissionPrompt` and the pre-trusted folder avoid the other first-run dialogs;
3. that the real hooks fire as the fake's do (`SessionStart` at start, `Stop` at the end of every turn, a `Notification` of type `permission_prompt`);
4. that a Channel push is taken while the CLI is idle for days, and what happens when its context fills.

## Manual test on a real box

1. Update Agora, then rebuild the agent's box (Settings → Agents, the box, Rebuild) so it has image version 8.
2. Settings → Agents, the agent's card, "How it works": choose "Live terminal".
3. In the channel, type `/start <agent>`.
4. Open the agent's chip, then press "Open terminal".
5. If the state says "Waiting on you" with a startup prompt, press "Take the keyboard", confirm, and answer the prompt in the terminal.
6. Wait for the state "Idle".
7. In the channel, type `@<agent> reply with the word ok`.
8. Check that the agent answers in the channel and that nothing was typed into the terminal.
9. Press "Take the keyboard", type a short prompt, and watch the chip say "working".
10. While you type, post another message to the agent and check that it is delivered a few seconds after you stop.
11. Open the same page on your phone and check that it shows the same screen, and that the toolbar sends Esc and Ctrl-C.
12. Sign in as a person who can direct agents (not the owner), open the page, and check that it is read-only.
13. Restart the box (Settings → Agents, the box, Restart) and check that the terminal comes back with the conversation resumed.
14. Type `/end <agent>` and check that the page says the session ended.
