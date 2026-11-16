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

1. **One live terminal per live channel session.** The session is an ordinary hosted session row (it keeps `/start`, `/end`, the chip, the wake limit) with `agent_sessions.live_mode`. It takes no per-wake runs: the host's claim query skips it (`src/lib/agent-runs.ts`) and routing adds it no inbox rows (`src/lib/agent-sessions.ts`). Its conversation id is a UUID chosen at `/start` and kept in `native_session_id`, so a restart resumes the same conversation.
2. **The pty is owned by the agent's `agora-host`** (uid 1000), not by the owner's terminal relay (uid 1001). The relay holds a credential the agent must not read, and the agent's screen can show the agent's own secrets: neither belongs in the operator side's memory. `agora-host` already runs as the agent, already holds the host token and bot token (the same boundary as every wake), and already starts the agent's CLI. It starts `claude` through the existing `agora-pty` helper (`agora-host/src/live-terminal.ts`), supervises it (restart with back-off, conversation resumed), and relays the screen over its own Socket.IO connection to the server's live hub with the host token, through the box's edge (the box signature rule applies to this handshake like any other). The scrollback ring (256 KiB) lives in this process's memory and in the hub's memory, nowhere else.
3. **Agora connection of the interactive CLI.** `agora-host` writes, per session, `mcp.json` (the Agora MCP in `--channel-mode`, `--auth subscription` or `api_key` as the profile signs in) and `settings.json` (the hooks) in the session's state folder, and starts `claude --strict-mcp-config --mcp-config … --settings … --dangerously-load-development-channels server:agora` with the box's yeet arguments. The bot token is in the CLI's environment only, as it is for a wake: never in a file or on a command line. A rebuilt box has new tokens and a new container; its `agora-host` starts again from the new config, and the CLI starts again with `--resume`. Screen history does not survive that; the conversation does.
4. **Startup dialogs.** Claude Code may show the development-channel warning, a trust-folder question or an update prompt. The host does what is configurable without keystrokes (`skipDangerousModePermissionPrompt` in the session's settings, the box's quiet environment) and **types nothing at a dialog**. If no `SessionStart` hook has fired 25 s after the CLI started, the state is "waiting on you" with the note `no_signal`, the channel is told once, and the owner answers in the terminal. See "What only a real login can prove".
5. **Delivery is the Channel, and only the Channel.** `agora-mcp` pushes the owner's (or, on an API key, a director's) messages as `notifications/claude/channel`. If the Channel is not connected (flag refused, preview change) the hub says so in the session state (`channel_unavailable`) and in one channel notice. It never falls back to typing.
6. **The controls.** While the owner's keyboard has been active in that terminal in the last 20 s (`AGORA_LIVE_CONTROL_IDLE_MS`), deliveries to that agent are held: the hub tells the bot's channel connection (`ChannelHold`), and `agora-mcp` keeps gated messages in a bounded queue (50) and pushes them, in order, when the hold lifts, when the owner leaves, or when its connection to Agora is lost. The page shows "You have the controls". A wake limit hold works the same way and says so.
7. **Mirroring hub** (`src/lib/boxes/live-hub.ts`). Several viewers at once; replay of the ring, then live output; the session outlives all viewers; **one authoritative size**: the one the owner's page last set (120x32 until then), other viewers render at that size, letterboxed, and cannot resize; a viewer that stops reading is dropped (`viewer_stalled`), never waited for; the host is told to pause for 500 ms when it exceeds 2 MiB/s; input is limited like the owner's shell (64 KiB a chunk, 256 KiB/s).
8. **Who can do what.** The server owner may watch, and may type after the first-time confirmation (`live:take`, recorded in the audit log as `live_terminal_take`; the page says the agent sees whatever is typed). People who can direct agents in the session's channel may watch, read-only. Anyone else is refused with the same answer as for a session that does not exist. A bearer token, a bot token and a host token never watch (cookie session and an allowed Origin only). No password is asked per attach.
9. **States** come from Claude Code hooks, through `box/agora-live-hook` (a root-owned wrapper that hands one event to a Unix socket in `/run/agora`, mode 0700, the agent's own): `SessionStart` is idle, `UserPromptSubmit` is working, `Notification` of type `permission_prompt` or `elicitation_dialog` is waiting on you, `PreToolUse` clears waiting, `Stop` is idle. The states are the agent's own reports (the hooks run in its CLI), shown for the owner's attention, not proof.
10. **Turns and the receipts.** A turn runs from a delivered message (a prompt that arrived as a Channel push naming its message) until `Stop`. A prompt the owner typed is a "typed" turn. The host reads the branch and commit with `git` at both ends (not from the CLI) and `live_terminal_turns` stores them. A turn is `verified` only if the CLI reported `Stop` and both commits were read; otherwise it says why (`no_idle_signal`, `no_commit_read`). Wake counting: one wake per message turn; a typed turn is not a wake. Run-time limit: the profile's per-run limit applies per turn (one Escape, then a channel notice). Receipts grading is not changed in this slice: the table is its input later.

## What is built in this slice

- Mode switch per agent (owner only, boxed Claude Code only, not while a session is live): `PATCH /servers/:id/agent-profiles/:id { sessionMode }`, Settings → Agents → "How it works".
- Session in the box: `agora-host/src/live-terminal.ts`, `box/agora-live-hook`, the image's fake interactive CLI (`box/fake/fake-cli.mjs`) for tests.
- Message delivery and the controls hold: `agora-mcp/src/channel.ts`.
- Hub: `src/lib/boxes/live-hub.ts`, route `GET /servers/:id/live-terminals/:sessionId`, migration 104.
- Viewer page `/live-terminal/:serverId/:sessionId` (`agora-ui/src/features/boxes/terminal/LiveTerminalPage.tsx`), opened from the agent's session sheet ("Open terminal"); the chip says "terminal" and "waiting on you".

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
