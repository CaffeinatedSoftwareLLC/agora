# Agent sessions

Start an agent in a channel with `/start codex`, give it work by mentioning it, and it answers. Nothing has to sit waiting in a terminal: an **agent host** on your computer wakes the agent's CLI (`codex exec`, `claude -p`) when something in Agora is addressed to it, and the agent posts its turn and exits. It works from your phone too (see [remote-access.md](remote-access.md)).

Design and contract: [planning/agent-sessions-wbs.md](planning/agent-sessions-wbs.md).

## How it fits together

```
phone or browser ── /start codex, "@codex …" ──▶ Agora (records a wake in the session's inbox)
                                                     │
agent host on your PC ── long-polls /agent-hosts ────┘
   └─ starts codex / claude headless with that bot's token, the messages, and the session
        └─ agent reads, posts its turn, exits; the host reports usage and the session ID
```

- A **session** is one agent in one channel. Each agent has at most one live session per channel. Several agents can work in the same channel, and they collaborate in agora-collab threads inside their sessions.
- A **task card** or **subtask** session is scoped to its own thread, alongside the agent's channel session (at most one per thread). Only messages in that thread reach it. `/start`, `/end` and `/lurk` by name act on the channel session; end a scoped one by ID. See [task-board.md](task-board.md).
- A **profile** says which bot, which CLI (`codex` or `claude`), which host, which working folder (by alias), and which model and effort. `/start <profile>` uses it.
- The agent resumes its own CLI session when it can. Otherwise it starts fresh with the summary it wrote at the end of its last wake.
- A **terminal session** is the other kind: an agent you run yourself in your own terminal, connected through agora-mcp (see [Terminal sessions](#terminal-sessions) below).

## Terminal sessions

When you open a CLI yourself and connect it with agora-mcp ([claude-channel.md](claude-channel.md), "bring your own session"), Agora tracks it as a lightweight **terminal** session, next to the hosted ones (#112):

- **When.** agora-mcp's presence socket connects (plain MCP mode, or `--channel-mode`): Agora makes one live terminal session for the bot in each of its channels. `--no-presence` (which hosted runs use) makes none. When agora-mcp disconnects, the session stays live for a **grace period** (60 seconds, `AGORA_TERMINAL_GRACE_MS`) so a reconnect keeps it, then ends (`disconnected`). A heartbeat every 30 seconds keeps it fresh; a session nobody heartbeats (the API process died) is ended by a sweep.
- **Where it shows.** `/sessions` lists it as `terminal`. The agent strip shows it as the bot's ring-shaped chip, labelled `terminal · working`, `listening` or `connected`; tap it for its sheet. Ended terminal sessions are not listed.
- **One responder.** While a bot has a live terminal session in a channel, @mentions and direct messages there do **not** wake its hosted channel session: the terminal agent hears them itself. The hosted session stays live **on standby** (its chip says so) and takes wakes again once the terminal disconnects. The first time both exist, a notice says so once. A terminal agent also counts as a live agent for "only one agent live in the channel", so a post without a mention doesn't wake some other hosted agent. Task-card and subtask sessions in their own threads are not affected.
- **`/start` while connected from a terminal** answers 409 `terminal_connected` ("*agent* is already connected from a terminal") with **Keep the terminal** (`onLive: "keep"`, nothing starts) or **Start hosted on standby** (`onLive: "standby"`; then the usual live-session question if one is live). Terminal sessions can't be ended, resumed or budgeted with commands: close the CLI to end one.
- **Reservations.** `file_reserve`, `file_renew`, `file_release` and `file_reservations` accept a live terminal session, with the same authorization. The reservation belongs to that session (holder shown as "*bot* (terminal)") and is released when it ends. If the bot also has a hosted run in progress, the running hosted session holds it.
- **Working and usage.** agora-mcp reports **working** while the agent calls tools and **idle** when it waits (`chat_wait`, or no tool call for a minute). That feeds the same working indicator as hosted runs, with the number of tool calls. Token use is unknown for most CLIs and shows as **n/a**. **No budget applies**: Agora can't stop your own CLI, and the sheet says so.
- **What it can't do.** No worktree, diff review, checkpoints, verify or subtasks: the terminal agent works in your own checkout. The sheet shows those actions greyed out with a tooltip, and the server refuses them (`terminal_session`, or no hosted session).
- **Authority doesn't change.** It is your own CLI on your own login. Only the owner's and directors' messages are instructions (in channel mode, a subscription login pushes the owner's messages only; [claude-channel.md](claude-channel.md#who-can-instruct-the-session-sender-gating)). Being connected gives the bot no authority to direct agents.

Wire: the bot socket's `auth.mode` (`channel` or `mcp`) attaches the sessions and answers `TerminalSession { sessions: [{ channelId, sessionId }] }`; agora-mcp sends `Activity { working, toolCalls }`. People get `AgentSessionUpdate` with `kind: "terminal"`. Migration 056 adds `agent_sessions.kind` (`hosted`, `terminal`); a terminal row has no profile, so every host, budget and workspace query (which joins the profile) skips it.

## Who can do what

| Action | Who |
|---|---|
| Create hosts and agents, edit profiles | The server owner (Settings → Agents) |
| `/start`, `/end`, `/resume`, `/lurk` | The owner, members with **DirectAgents**, and bots the owner allowed to direct in that channel |
| `/sessions` | Anyone who can see the channel |
| Wake an agent | A post or thread reply from someone who can direct that mentions the agent (or, at the top level, with only one agent live in the channel and no other bot mentioned); hand-offs inside an agora-collab thread between its participants |
| Wake or `/start` an agent on a **subscription** profile | The server owner only (see below) |
| Approve a **Run request** card | The server owner only |

**Subscription or API key.** Each profile in the host's config runs its CLI either on the CLI's own login (`"auth": "subscription"`, the default) or on an API key from the host's environment (`"auth": "api_key"`). A personal subscription is for one person, so a subscription agent takes work only from the server owner: the owner's messages, the owner's `/start` and `/resume`, hand-offs between agents in sessions the owner started, and lurk wakes on the owner's own messages. Anyone else gets a notice: "*agent* runs on the owner's personal subscription; ask the owner, or configure an API key profile." API-key agents follow the rules in the table. Settings → Agents and `/sessions` show each agent's mode. Gemini needs an API key. Background and sources: [provider-terms.md](provider-terms.md).

Opt-in **lurk mode** also wakes an agent for otherwise unrouted channel posts and thread replies, including messages from members without DirectAgents and ordinary bots. It ignores its own posts and other lurking sessions' bots to prevent loops. System notices never wake a lurker. Ordinary direct/protocol routing takes precedence, so a message produces at most one inbox row per session.

## Handoffs

YIELD passes the turn in a thread; a **handoff** passes the task (#84). The agent that has the work offers it, and nothing moves until the recipient accepts.

1. **Offer.** `handoff_offer thread=<id> to=<agent> summary=<state of the work>` from an agent with a live session in the channel. Agora records the sender's session, its **last committed `branch @ sha`** (the commit the host made at the end of its latest finished turn) and its active file reservations, posts a **HANDOFF** card in the thread as the sender, and wakes the recipient. If the sender is mid-turn, the card says that turn's edits are not in the pinned commit. Offers expire after 30 minutes (`expires_in_seconds`, 60 seconds to 24 hours). One open offer per thread; once a thread has an owner, only the owner can offer it on.
2. **Refusals at offer time.** The recipient must be another agent with a live session in this channel (a session scoped to the thread, its terminal session, or its channel session) and access to the channel: `recipient_not_live`, `recipient_cannot_see_thread`. A recipient on a personal plan (`subscription`, `siwc`) takes a handoff only when both sessions were started by its plan owner (`plan_owner_only`, [provider-terms.md](provider-terms.md)).
3. **Accept.** `handoff_accept offer_id=<id>`, only by the named recipient. In one transaction, with both sessions and the offer locked, Agora rechecks expiry, the recipient session still being live, both agents' channel access, the thread, the plan-owner rule and the current owner; then it makes the recipient's session the thread's **task owner**, moves the sender's reservations that are still the sender's and active (same workspace) to the recipient with a fresh 15-minute TTL, and posts a notice: "*codex* now owns this (from *claude* @ `branch@sha`)". Reservations that lapsed or changed holder stay put and the notice counts them. Accepting again is a no-op (`alreadyAccepted`); concurrent accepts give one owner and one notice. An expired offer answers `410 offer_expired`.
4. **Decline or cancel.** `handoff_decline` (recipient, with a reason) tells the sender with a notice that wakes it. `handoff_cancel` is for the sender; the owner and directors can cancel any pending offer, also from the card's **Cancel offer** button.
5. **The code.** The recipient's wake lists the offer with its pinned commit. The host checks the commit is in its repository (session worktrees share it) and gives the commands: inspect with `git diff HEAD...<sha>`, apply through a patch file in the system temp folder: `git diff --binary <merge-base> <sha> --output <file>`, then `git apply <file>`. Never a pipe: Windows PowerShell 5.1 re-encodes piped native output and corrupts non-ASCII patches; `--binary` carries binary files. `git apply` changes only the recipient's working files and applies nothing on a conflict, so its own edits are never lost; the host commits the result on the recipient's branch at the end of the turn. Nothing writes to the sender's worktree. A commit made on another host isn't there: the prompt says so, and the sender pushes its branch or the recipient works from the summary.

The thread header shows the owner; the card shows *pending*, *accepted*, *declined*, *expired* or *cancelled*. API: `POST /channels/:id/handoffs` `{ threadId, to, summary, ttlSeconds? }`, `POST /channels/:id/handoffs/:offerId` `{ action: accept | decline | cancel, reason? }`, `GET /channels/:id/threads/:threadId/handoffs` → `{ owner, offers }`. Migration 058 adds `agent_handoffs` and `agent_thread_owners`.

## Set it up

1. **Create a host.** Settings → Agents → Hosts → *Create host*. Copy the token; it is shown once.
2. **Create an agent.** Settings → Agents → *Create agent*: a name (it is the bot's name and what you type after `/start`), the CLI, the host, a workdir alias such as `agora`, optionally a model and effort, and a channel to add it to. Copy the bot token; it is shown once.
3. **Write the host's config file** (outside any folder an agent can write to). The format is in [agora-host/README.md](../agora-host/README.md#configuration): the instance URL, the host token, one entry per profile (CLI executable, working folder for its alias, a private state folder), and the bot tokens by bot ID.
4. **Choose how each CLI signs in** (`auth` in its profile, [provider-terms.md](provider-terms.md)). For an API key, set `"auth": "api_key"` and `"apiKeyEnv"`, and set that variable in the host's environment. For your own login (owner-only agents), **log each CLI in once** with its state folder, because the host gives every agent its own CLI state:
   ```powershell
   $env:CODEX_HOME = "C:\private\agora\codex-state"; codex login
   $env:CLAUDE_CONFIG_DIR = "C:\private\agora\claude-state"; claude   # then /login
   ```
5. **Run the host:**
   ```powershell
   cd agora-host; npm install; npm run build
   node dist/index.js --config C:\private\agora\host.local.json
   ```
   Settings → Agents shows when the host was last seen.

## Use it

Type these in a channel's message box:

| Command | What happens |
|---|---|
| `/start codex` | Starts codex's session here (or resumes its last shelved one), posts a notice, and wakes it to say hello. If codex is already live here, you get **Shelve it and start new / Keep it / Cancel**. |
| `/start codex --new` | The same, but never resumes; starts fresh |
| `/end codex` | Ends the session: queued work is dropped and a run in progress is stopped. History stays. |
| `/sessions` | Lists this channel's sessions with their state, wakes and tokens, including terminal sessions |
| `/resume <session id>` | Brings back a shelved session (IDs are in `/sessions`) |
| `/lurk codex [quiet\|balanced\|vocal]` | Enables passive listening for codex's live session here; default is balanced |
| `/lurk codex off` | Disables passive listening and drops pending unclaimed lurk observations |

Then talk to it: `@codex look at the failing test in auth.spec.ts`. With only one agent live in the channel, you can leave the mention out.

- **Mentions are case-insensitive**: `@codex` and `@Codex` are the same agent, everywhere mentions are parsed.
- **In a thread** (#120): an @mention from the owner or a director in any thread the agent can see wakes its channel session, with that thread as where it replies (the plan-owner rule still applies to subscription and siwc agents). In a bound agora-collab thread the participants keep the thread rules, and a mention adds an agent that isn't a participant. A task card's or subtask's session in its own thread takes the mention instead of the channel session.
- **When a mention wakes nothing**, Agora says why in a short notice where you posted: the agent has no live session here (`/start` it), it runs on someone else's plan, or (once) its hosted session is on standby because it's connected from a terminal, which hears the message itself. Only the owner's and directors' mentions get the *no live session* notice.

The session sheet also has a **Lurk mode** switch and **Speak up** dial. The setting belongs to that session, survives shelving/resume, and starts off for a fresh session. Lurk batches collect for two seconds from the oldest pending observation (up to 20 messages per wake); direct work does not wait for that window. Continuous chatter cannot postpone the oldest observation indefinitely.

For a purely passive batch, the host asks the agent to read everything and speak only for something important: a bug, wrong claim, or missed step. **Quiet** requires a serious issue, **balanced** a material correction, and **vocal** permits useful actionable corrections. Otherwise it outputs exactly `[pass]` and posts nothing. A successful silent lurk turn has no “finished without posting” warning. Mixed batches that include direct/protocol work use the normal response rules. Passive wakes consume the same wake and token budgets, including heartbeat accounting.

MCP callers can pass `lurk: "quiet" | "balanced" | "vocal" | "off"` to `session_start`, or use `session_lurk` with the same dial to change an existing live session. Both require the same channel authority as `/start`. The API command is `{ command: "lurk", profile: "codex", lurkMode: "balanced" }`; use `null` for off.

## Referenced images

After a hosted CLI exits, the host checks messages posted by that bot in the session's channel during the active run. Local `.png`, `.jpg`, `.jpeg`, `.gif` and `.webp` paths in Markdown links, code spans, quoted text or bare paths become attachments on their source message, so channel and thread placement stay intact. Remote image URLs are ignored.

Relative paths resolve from the run's actual cwd (its session worktree). Absolute paths are accepted only inside that cwd or the system temporary directory. The host resolves symlinks/junctions, checks directory boundaries and opened-file identity, and rejects files outside those roots, missing/changed files, devices, network paths and alternate data streams. It reads no more than the instance's `files.max_size_bytes` setting. Invalid references are skipped without failing the completed CLI turn.

The host token authorizes `POST /agent-hosts/@me/runs/:runId/images/discover` with a claim token to fetch eligible messages and the size limit. `POST /agent-hosts/@me/runs/:runId/images` takes multipart fields `claimToken`, `messageId`, `reference`, then `file` bytes. The API never reads a supplied local path: it verifies host ownership, the current claim/lease, session/bot access, and that the exact reference occurs in an eligible, undeleted message. Finished/cancelled runs cannot upload. All images go through `storeFile()` for instance limits, magic-byte validation, quota, EXIF processing and encryption. Canonical paths are deduplicated on the host; image bytes are durably deduplicated by SHA-256 per run on the server. At most ten attachments may belong to one message.

**Orchestrators.** An agent can run other agents through agora-mcp's `session_start`, `session_end`, `session_list`, `session_lurk` and `session_wake`, but only in channels where the owner turned on *can direct* for its bot (Settings → Bots). Without it the write tools fail with "<bot> can't direct agents in #<channel>" (the server answers 403 `cannot_direct`), and `session_wake` posts nothing; `session_list` needs only access.

## Limits and budgets

- Each profile has a **wake budget** (default 50) and a **token budget** (default 2,000,000) per session, and a run timeout (default 15 minutes). When a session runs out, its shelve notice names the exhausted budget and shows usage. Raise a wake budget in Settings → Agents (the notice links there), or a token budget in the session controls, then `/resume` the session. A parent's token budget notice includes spending by its subtasks.
- A failed wake is retried up to 3 times with the same messages; then the channel gets a notice.
- When an agent's CLI hits its rate limit, the session **sleeps** until the limit resets (a notice says how long; the chip shows *Sleeping*). Messages addressed to it are held and delivered together in one turn when it wakes. Other live sessions of the same agent share its CLI login and sleep too. *Wake now* in its session sheet wakes it early.

## Tools and approvals

Settings → Agents → each agent → **Tools**: pick presets (*Read-only*, *Dev* for editing with git, gh and npm, *Research* for web search and fetch) and keep a list of tools that are always allowed. The host reads them at every wake, so there is nothing to edit on the PC and no restart. What each preset means per CLI is in [agora-host/README.md](../agora-host/README.md#tool-presets-and-approvals-73).

When a run is denied a tool, the channel gets a **Tool request** card, also on the phone:

- **Approve once**: the owner or a director. The agent's next run may use the tool, and the agent is woken to retry.
- **Always allow**: the owner only. The tool is added to the agent's always-allowed list.
- **Deny**: the owner or a director. Cards expire after 24 hours.

Claude Code reports denials exactly. Codex doesn't, so its denials are guessed from command output and some go unnoticed. On a subscription agent, only the owner's *Approve once* wakes it; a director's is kept for its next owner-triggered run.

**Run requests.** A profile with `"requireRunApproval": true` in the host config (forced on for a Gemini profile on account login, see [provider-terms.md](provider-terms.md#gemini-and-antigravity)) asks before every wake: a **Run request** card appears in the channel and the run starts only after the owner taps *Approve run*. *Deny* drops the waiting messages. A retry of an approved run needs no new approval; an unanswered card expires after 24 hours and a new one is posted.
- Delivery is at least once. After a crash the agent may get the same messages again; it passes a `client_key` with each post so repeats don't post twice, as long as it follows the instruction.

## Safety

- The host runs under your Windows account and is as trusted as the CLIs it starts. Each CLI's own sandbox and approval settings stay on; the host never passes bypass flags.
- Commands only pick a profile. Paths, executables and flags live in the host's local config; Agora never sends them.
- Each agent process gets only its own bot token, not the host token or other agents' tokens. An API-key profile's child also gets that one key variable; the key is never logged or sent to Agora.
- The host never reads, copies or relays a CLI's login files or OAuth tokens.
- Revoking a host in Settings stops it at once; ending a session stops its run.

## Status (2026-10-17)

Built and tested with the backend suite, the host's unit tests, and a check that a real server claim passes the host's parser. **Not yet verified live:** a real authenticated CLI run through the host, native resume, and Windows process-tree termination under your account. Do those checks before you rely on it.
