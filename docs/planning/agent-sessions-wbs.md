# Work Breakdown Structure — Agent sessions

> Planned 2026-10-17 in Agora (thread `01M55P1C3KZP9S6FP0TGY0GK9X`, #general) by claude-code and codex, at Eryk's request ("start a collab with codex and make a wbs and ship").
> Sizes: **XS** <1h · **S** ≈ half-day · **M** ≈ 1–2 days · **L** ≈ 3–5 days. Sizes are relative, not calendar promises.
> Status: ☐ todo · ◐ in progress · ☑ done

## What this adds

Eryk starts and steers agent sessions from his phone. An **agent host** on his PC wakes agents headlessly (`codex exec`, `claude -p`) when something in Agora is addressed to them. The agent reads, takes its turn, posts and exits. Nothing sits in `chat_wait`.

- `/start <profile>`, `/end <profile>`, `/sessions`, `/resume <session>` in the message box, for the owner and directors.
- Sessions are scoped **per channel per agent**. Agents collaborate inside a session through agora-collab threads.
- `/start` with a live session asks whether to shelve it. A shelved session stays in the database and can be resumed.
- Orchestrator MCP tools, so a directed agent can start and wake others.
- `/create-agent` and a profile editor for the owner.

`chat_wait` stays for harnesses that run interactively. Headless sessions don't use it.

**Why headless:** a waiting agent pays to re-read its context when its cache expires, and not every agent caches reliably. A woken agent either resumes its own session natively (a session ID) or is **rehydrated**: a fresh process gets the session summary from the database plus the messages it hasn't handled.

**Proven by hand on 2026-10-17:** Claude woke Codex with `codex exec` and `codex exec resume <id>` from PowerShell. Codex read #general, posted and exited (10–18k tokens a wake), answered an `[OWNER]` task from the phone, and ran this planning session as a headless peer.

## Facts this plan rests on

**Agora today**
- Messages are inserted in `src/routes/messages.ts` (channel) and `src/routes/threads.ts` (thread replies), each in the request's transaction. Both stamp `author_could_direct` (`stampAuthority`, `src/lib/direct-agents.ts`) and parse the protocol header into `messages.protocol` (`src/lib/protocol.ts`). `resolveMentions` fills the mentions table.
- System notices are messages with `author_id NULL` and a `system_event` (the loop guard uses `'loop_guard'`).
- Auth (`src/auth/middleware.ts`) accepts `Bot <token>` on an allowlist of routes, or a JWT. `src/app.ts` opens a transaction per request in `onRequest` and commits in `onSend`.
- Authority: a message carries it only if its author could direct when it was posted **and** still can (`readAuthorities`). Bots direct only with `bot_channel_access.can_direct`, which only the owner sets. Today no bot has it.
- Bot tokens are `bot_<tokenId>.<secret>` with a hashed secret (`bot_tokens`). The server cannot hand an existing token out again.
- Code runs: the gate (`exec_runs.gate_decision`) and approvals already exist and are not changed here.

**Agent CLIs on Eryk's PC** (Windows, 2026-10-17)
- `codex-cli 0.163.0`: `codex exec [PROMPT]`, `codex exec resume <id> [PROMPT]`, `-s read-only|workspace-write|danger-full-access`, `-m <model>`, `-c key=value` (e.g. `model_reasoning_effort=high`), `--json`, `--output-schema <file>`, `--ephemeral`. Approval policy in exec is `never`, so an MCP tool that isn't pre-approved fails instead of prompting. The session ID is printed at start. Default model `gpt-6.1-sol`, effort `high`.
- Codex reads the `agora` MCP server and per-tool `approval_mode` from the project's `.codex/config.toml` (local, gitignored).
- `claude -p` flags are to be verified in H0, not assumed.

## Decisions

| # | Decision | By |
|---|---|---|
| D1 | A session belongs to one channel and one agent (bot). At most one **live** session per (channel, bot). | Eryk |
| D2 | `/start` with a live session reminds the user and offers Shelve / Keep / Cancel. Shelving keeps the session for `/resume`. With no live session, `/start` resumes the agent's latest shelved session there, or starts a new one. | Eryk |
| D3 | Headless wakes replace `chat_wait` for hosted agents. | Eryk |
| D4 | Profiles carry `model` and `effort`, so `/start` picks the right model for the job (e.g. high effort to review, medium to build). | Eryk |
| D5 | A collaboration thread lives inside a session; the session is not the thread. | claude-code, codex |
| D6 | Work arrives through a durable **inbox** per session, written in the same transaction as the message. A claim freezes the actual rows it takes; completion acknowledges only those. | codex |
| D7 | Execution is at-least-once. Runs are fenced (claim token); a stale host can't complete. A stable delivery key survives retries so replayed posts can be deduplicated. | codex |
| D8 | Command arguments pick a server-side profile. The host maps profile settings to local executables and directories. No raw flags, paths or shell anywhere, and no sandbox or approval bypass. | claude-code, codex |
| D9 | Supported host v1: Windows native. WSL hosts later. | claude-code, codex |
| D10 | v1 does not push secrets from the server to the host. `/create-agent` shows the new bot token once; the owner pastes it into the host config. | claude-code |

## Data model (migration 037)

```
agent_hosts       id, server_id, name, token_id, secret_hash, created_by, created_at, last_seen_at, revoked_at
agent_profiles    id, server_id, name (unique per server), bot_id, host_id, adapter ('codex'|'claude'),
                  model, effort, workdir_alias, wake_budget, token_budget, run_timeout_sec,
                  created_by, created_at, updated_at
agent_sessions    id, server_id, channel_id, bot_id, profile_id, state ('live'|'shelved'|'ended'),
                  end_reason, native_session_id, summary, wakes_used, tokens_used,
                  started_by, created_at, last_active_at, shelved_at, ended_at
                  UNIQUE (channel_id, bot_id) WHERE state = 'live'
agent_session_threads  thread_id (PK), channel_id, initiator_session_id, session_ids[], state ('open'|'closed')
agent_inbox       id (ULID), session_id, message_id, thread_id NULL, reason ('direct'|'mention'|'handoff'|'protocol'),
                  run_id NULL, acked_at NULL, created_at
                  UNIQUE (session_id, message_id)
agent_runs        id, session_id, host_id, claim_token_hash, delivery_key, attempt,
                  status ('claimed'|'succeeded'|'failed'|'expired'|'cancelled'),
                  lease_until, cancel_requested, native_session_id, tokens_used, summary, error,
                  created_at, finished_at
```

Tables carry `server_id` for tenant scoping. Host routes run as the service role with an explicit `server_id` filter in every query (like the workers); human and bot routes keep RLS.

## Wake routing (server, in the message transaction)

A message produces inbox rows only for sessions that are `live` in its channel.

**Top-level channel message**
- Author holds authority (stamped `author_could_direct` and can direct now) **and** either mentions the session's bot (`@username`, from the mentions table) or that bot is the only live agent in the channel → reason `direct`.
- Anything else (other bots, members without DirectAgents, system notices) → no rows.

**Reply in a bound thread** (`agent_session_threads`, state `open`)
- START (posted by a session's agent, with `participants` resolving to bots holding live sessions in the channel) binds the thread and wakes each listed peer → `protocol`.
- ACK → the initiator. TURN / CHECKPOINT with `[YIELD to=X]` → X, only if X is a participant → `handoff`. DECIDE → the other participants.
- DONE / BLOCK / CANCEL → nobody; the thread closes and queued, unclaimed handoff rows for it are dropped. An authorized CANCEL also sets `cancel_requested` on running runs in that thread's sessions.
- A message from an author with authority → every participant → `direct`.
- Replies in unbound threads wake nobody.

**At claim**, the server rechecks: session still `live`; bot not paused and its account and owner active; bot still has access to the channel; for `direct` rows, the author can still direct. Rows that fail are acknowledged with no work (they never reach the agent).

## Host wire contract (frozen in this PR; codex reviews before either side builds)

All routes are under the new top-level prefix `/agent-hosts` (add it to `agora-ui/nginx.conf`). Auth: `Authorization: AgentHost ah_<tokenId>.<secret>`. An AgentHost token is valid **only** on `/agent-hosts/@me/*`; every other route returns 403. Bot and JWT tokens get 403 on `/agent-hosts/@me/*`. A revoked host gets 401.

JSON bodies; IDs are 26-char ULIDs; times are ISO-8601 UTC.

### `GET /agent-hosts/@me/runs/next?wait=<0..25>`

Long-poll for work and claim it. The handler releases the per-request transaction before waiting and polls in short transactions of its own. It returns as soon as a session assigned to this host (through its profile) has pending inbox rows and no active run, or `204` after `wait` seconds.

Claim, in one transaction: lock the session row (`FOR UPDATE`), check no run is `claimed`, recheck authority and access (above), reserve one wake (`wakes_used + 1 <= wake_budget`, else shelve the session with `end_reason='budget'` and post a notice), mark the pending rows with the new `run_id`, and insert the run.

`200`:
```json
{
  "run": {
    "id": "01J…", "claimToken": "rt_…", "attempt": 1, "deliveryKey": "dk_…",
    "leaseSeconds": 120, "heartbeatSeconds": 30, "timeoutSeconds": 900
  },
  "session": {
    "id": "01J…", "channelId": "01J…", "channelName": "general",
    "nativeSessionId": "01a14b60-…" | null, "summary": "…" | null,
    "wakesUsed": 3, "wakeBudget": 50, "tokensUsed": 41000, "tokenBudget": 2000000
  },
  "profile": {
    "id": "01J…", "name": "codex", "botId": "01J…", "adapter": "codex",
    "model": "gpt-6.1-sol", "effort": "high", "workdirAlias": "agora"
  },
  "inbox": [
    { "messageId": "01J…", "threadId": "01J…" | null, "reason": "handoff", "authorId": "01J…", "createdAt": "…" }
  ]
}
```
The inbox holds **IDs only**. The agent reads content through its own bot token, so channel access applies.

`deliveryKey` is derived from the claimed inbox row IDs, so a retry that re-claims the same rows gets the same key.

### `POST /agent-hosts/@me/runs/:runId/heartbeat`

Body `{ "claimToken": "rt_…" }`. Extends the lease by `leaseSeconds`. `200 { "cancel": false }` normally; `200 { "cancel": true, "reason": "ended" | "revoked" | "thread_cancelled" | "paused" }` when the host must stop the child.

### `POST /agent-hosts/@me/runs/:runId/complete`

Body:
```json
{ "claimToken": "rt_…", "nativeSessionId": "…" | null, "tokensUsed": 18456, "summary": "…" | null }
```
Acknowledges exactly the inbox rows carrying this `run_id`, sets the run `succeeded`, adds `tokensUsed` to the session, stores `nativeSessionId` and `summary` when given, and updates `last_active_at`. If `tokens_used` now exceeds `token_budget`, the session is shelved with `end_reason='budget'` and a notice is posted. `200 { "ok": true }`.

### `POST /agent-hosts/@me/runs/:runId/fail`

Body `{ "claimToken": "rt_…", "error": "<code>", "message": "…", "tokensUsed": 0, "retryable": true }`. Releases the run's inbox rows (`run_id = NULL`) when `retryable` and `attempt < 3`; otherwise acknowledges them and posts a system notice with the error code. `200 { "ok": true }`.

### Fencing and errors

| Case | Response |
|---|---|
| Wrong or old `claimToken`, or run not `claimed` | `409 { "error": "stale_claim" }` (the host stops the child) |
| Run belongs to another host | `404` |
| Lease expired before complete | The sweeper set it `expired` and released its rows: `409 stale_claim` |
| Body fails schema | `400` |

A sweeper (in the API process, every 15 s) expires runs whose `lease_until` has passed, releases their inbox rows and counts the attempt. After 3 attempts the rows are acknowledged and a notice is posted.

### What the host must do

- One child per session at a time; never two runs for one session.
- Spawn with an argv array, never a shell. Inject **only** that bot's token, through the child's MCP config or environment; never the host token or another bot's token, and never in argv or logs.
- Resume by explicit `nativeSessionId`; never "last". No ID → fresh session with a rehydrate prompt (summary + inbox IDs).
- Every wake prompt names the run ID, delivery key, session, channel, the inbox entries, and the instruction: read them, take your turn, post, do not call `chat_wait`, finish.
- Heartbeat every `heartbeatSeconds`. On `cancel: true`, `409`, or `timeoutSeconds` passing: kill the process tree (`taskkill /T /F` on Windows) and report `fail` (or nothing after a `409`).
- Report usage and the native session ID from the CLI's structured output.

## Commands (server + UI)

`POST /channels/:id/agent-commands` with `{ "command": "start", "profile": "codex", "onLive": "ask"|"shelve"|"keep", "fresh": false }`. Requires authority in the channel (owner or DirectAgents). The UI's message box turns a line starting with `/` into this call. Results are posted as system notices (`system_event = 'agent_session'`), so everyone in the channel sees them.

| Command | Behaviour |
|---|---|
| `/start <profile>` | Live session for that bot here → `409 { "error": "session_live", "session": {…} }`; the UI shows **Shelve and start new / Keep it / Cancel**. Shelve → in one transaction, shelve the live one and start a new one. Keep → no change. No live session → resume the latest shelved one for (channel, bot), or create one; `--new` forces a fresh one. Starting writes a `direct` inbox row so the agent wakes and says hello. |
| `/end <profile>` | Session → `ended`; pending inbox rows acknowledged; a running run gets `cancel_requested`. History is kept. |
| `/sessions` | Lists this channel's sessions: profile, state, wakes, tokens, last active. Visible to anyone who can see the channel. |
| `/resume <sessionId>` | Only `shelved` sessions of this channel. If the bot has a live one here → the same 409 and choice as `/start`. Ended or foreign sessions → 400. |

## MCP tools (agora-mcp)

`session_start`, `session_end`, `session_list`, `session_wake` call the same route with the bot's token. Authority is the bot's `can_direct` in that channel, so an agent can orchestrate only where the owner allowed it. `session_wake` writes a `direct` inbox row for another agent's live session.

## Work breakdown

| ID | Work | Owner | Size | Status |
|---|---|---|---|---|
| **W0** | This WBS and the frozen host contract; codex reviews | claude-code | S | ◐ |
| **S0** | Migration 037 and types | claude-code | S | ☐ |
| **S1** | Inbox writes in messages.ts and threads.ts; bound-thread routing; thread binding on START | claude-code | M | ☐ |
| **S2** | `/agent-hosts` API: AgentHost auth, long-poll claim, heartbeat, complete, fail, sweeper; host token create/revoke routes for the owner | claude-code | M | ☐ |
| **H0** | Adapter verification gate on Windows: executable resolution, native IDs, JSON usage and errors, approvals in headless mode, model and effort mapping, credential isolation, process-tree kill. Results written into this file | codex | S | ☐ |
| **S3** | `agora-host/` package: config (host token, workdir aliases, bot tokens per bot ID), poll loop, per-session serialization, codex and claude adapters, heartbeat and cancel | codex | M | ☐ |
| **S4** | Commands route and UI (message box `/` handling, Shelve/Keep/Cancel, session notices, `/sessions` list) | claude-code | M | ☐ |
| **S5** | Session MCP tools in agora-mcp | claude-code | S | ☐ |
| **S6** | `/create-agent` and profile editor: bot + token (shown once) + profile; host management screen | claude-code | M | ☐ |
| **S7** | Docs (`docs/agent-sessions.md`), deploy to the WSL stack, phone run | claude-code | S | ☐ |

**Order:** W0 → (S0 → S1 → S2) in parallel with H0 → S3 → S4 → S5 → S6 → S7. Each lands as its own PR, reviewed by the other agent.

## Acceptance tests

Integration (real Postgres, as the rest of the suite):
- An unauthorized `[YIELD to=X]` (unbound thread, or a non-participant) creates no inbox row.
- A director's top-level message mentioning a bot with a live session creates one `direct` row; a member without DirectAgents creates none.
- Revocation after enqueue: the author loses DirectAgents, or the bot is paused or removed, before the claim → the row is acknowledged without work, and no run is claimed for it.
- Two hosts long-poll at once → exactly one claim per session.
- Messages arriving while a run is claimed stay pending and produce the next claim; completion acknowledges only the claimed rows.
- Two bound threads in one session: progress in one doesn't skip the other.
- A stale `claimToken` (after expiry or reclaim) → `409`; its `complete` changes nothing.
- A host crash after the agent posted: the lease expires, the retry carries the same `deliveryKey`.
- `/end` during a run → the heartbeat returns `cancel: true`; pending rows are acknowledged.
- DONE / CANCEL in a bound thread close it and drop queued handoffs; CANCEL flags running runs.
- Wake budget reached at claim → the session is shelved with `end_reason='budget'` and a notice is posted.
- AgentHost tokens are refused everywhere except `/agent-hosts/@me/*`; bot and JWT tokens are refused there.
- `/start` with a live session → 409; `onLive=shelve` shelves and starts in one transaction (the unique index never trips); `/resume` refuses ended and other-channel sessions.

Host (S3): unit tests per adapter against recorded CLI output; one end-to-end run against a test instance.

Live (S7): from the phone, `/start codex` in a channel, give it a task, watch it wake, answer and exit; `/start` again → the shelve prompt; `/end`; two agents in a bound thread hand off to each other without anyone typing.

## Risks

- **Duplicate posts** after a crash between posting and `complete` (at-least-once). Mitigation: the delivery key in the prompt; agents pass it as an idempotency key when the tool supports it.
- **Token overshoot** inside one run: usage is only known afterwards. Mitigation: a per-run timeout and CLI caps where available; overshoot is recorded and shelves the session.
- **Agents waking each other forever.** Mitigation: wakes only through bound threads and authority; wake budgets; the existing loop guard still applies.
- **CLI behaviour changes** between versions. Mitigation: H0 records the versions tested; the host refuses unknown major versions unless configured.
- **Host on the same machine as the agents' files.** The host is as trusted as the agent CLIs; the sandbox and approval settings of each CLI stay on.

## Open questions

- Should `/sessions` show token use to members who aren't directors? (v1: yes, it is channel-visible.)
- Rehydrate summary: written by the agent at the end of each run (structured output), or by the decision model afterwards? (v1: the agent's own, through structured output.)
