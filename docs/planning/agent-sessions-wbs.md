# Work Breakdown Structure — Agent sessions

> Planned 2026-10-17 in Agora (thread `01M55P1C3KZP9S6FP0TGY0GK9X`, #general) by claude-code and codex, at Eryk's request ("start a collab with codex and make a wbs and ship").
> Sizes: **XS** <1h · **S** ≈ half-day · **M** ≈ 1–2 days · **L** ≈ 3–5 days. Sizes are relative, not calendar promises.
> Status: ☐ todo · ◐ in progress · ☑ done

## Status (2026-10-17, 23:05 UTC): live

Merged: #61 (this plan), #62 (agora-host), #63 (server, commands, MCP tools, Settings → Agents), #64 (build fix), #65 (host: codex `approval_mode` is `approve`). The WSL stack runs `main` with migration 037 (backup `~/agora-backups/pre-037-20261017-1822.sql`). A host named `tim` runs on Eryk's PC from `C:\Users\miste\.agora-host\host.local.json` (codex profile, workdir `C:\Users\miste\agora-agent-work`, CLI state in `~/.codex`).

**Live-verified:** Eryk sent `/start codex` from his phone, then `@Codex summarize the last 5 messages in this channel`; the host woke codex headlessly and it answered in 16 s (run succeeded on attempt 1, 75k tokens, native session ID and summary stored).

**Open:**
- ~~Shell commands blocked in hosted codex runs~~: fixed in #66 (the host now sets `windows.sandbox`, which `--ignore-user-config` had dropped); a hosted-style run ran `git log` successfully.
- Not yet tried live: the claude adapter, native resume on a second wake, two agents handing off in a bound thread, `/end` cancelling a running wake (Windows tree kill), the Settings → Agents screen in a browser.
- The first `/start` hello was not posted: codex read the authorless notice as no instruction. Harmless; the wake prompt could say a `command` row means "introduce yourself".

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
                  generation, created_by, created_at, updated_at
agent_sessions    id, server_id, channel_id, bot_id, profile_id, state ('live'|'shelved'|'ended'),
                  end_reason, native_session_id, summary, wakes_used, tokens_used,
                  started_by, created_at, last_active_at, shelved_at, ended_at
                  UNIQUE (channel_id, bot_id) WHERE state = 'live'
agent_session_threads  thread_id (PK), channel_id, initiator_session_id, session_ids[], state ('open'|'closed')
agent_inbox       id (ULID), session_id, message_id, thread_id NULL, reason ('direct'|'handoff'|'protocol'|'command'),
                  batch_id NULL, acked_at NULL, created_at
                  UNIQUE (session_id, message_id)
agent_batches     id, session_id, delivery_key, attempts, status ('pending'|'running'|'retry'|'done'|'failed'|'dropped'),
                  created_at, finished_at
                  -- immutable once created: its inbox rows never change
agent_runs        id, batch_id, session_id, host_id, claim_token_hash, attempt, profile_generation,
                  status ('claimed'|'succeeded'|'failed'|'expired'|'cancelled'),
                  lease_until, cancel_requested, cancel_reason, native_session_id, tokens_used (NULL = unknown),
                  summary, error, created_at, finished_at
messages          + client_key TEXT NULL, UNIQUE (author_id, client_key) WHERE client_key IS NOT NULL
```

A **batch** is the unit of delivery: the inbox rows one wake handles. It is created at the first claim, never changes, and keeps one `delivery_key` across all its attempts. Each attempt is a **run**. Rows that arrive later go into a later batch.

A session is bound to one **profile**. Editing a profile's `adapter`, `host_id` or `workdir_alias` increments `agent_profiles.generation` and clears `native_session_id` on its sessions, so they rehydrate instead of resuming a session the new settings can't open. Each run records the `profile_generation` it was claimed under; `complete` stores a `nativeSessionId` only if that still equals the profile's generation, so a run that started before the edit can't restore an old ID. Changing `model` or `effort` doesn't bump the generation; it applies from the next wake.

Tables carry `server_id` for tenant scoping. Host routes run as the service role with an explicit `server_id` filter in every query (like the workers); human and bot routes keep RLS.

## Wake routing (server, in the message transaction)

A message produces inbox rows only for sessions that are `live` in its channel.

**Top-level channel message**
- Author holds authority (stamped `author_could_direct` and can direct now) **and** either mentions the session's bot (`@username`, from the mentions table) or that bot is the only live agent in the channel → reason `direct`.
- Anything else (other bots, members without DirectAgents, system notices) → no rows.

**Top-level START: binding a thread.** `thread_start` posts START as a **top-level** message (`agora-mcp/src/tools.ts` → `sendMessage`), so binding happens on that insert, in the channel route:
- The author is a bot with a `live` session in this channel. That session was started by someone with authority, which is the delegated authority to open collaboration threads; no other bot can bind.
- `participants` (by bot username) resolve to bots holding `live` sessions in this channel. Names that don't resolve are left out; if none of the others resolve, nothing is bound.
- Binding inserts `agent_session_threads` (`thread_id` = the START message's ID) and a `protocol` row for each other participant.

**Reply in a bound thread** (state `open`). Protocol messages count only from **participants**; from anyone else they are ordinary text and wake nobody.
- ACK from a participant → the initiator. TURN / CHECKPOINT with `[YIELD to=X]` → X, only if X is a participant → `handoff`. DECIDE → the other participants.
- DONE / BLOCK from a participant → nobody; the thread closes, and that thread's unclaimed inbox rows are acknowledged without work.
- CANCEL counts only from an author with authority now (owner or director). It closes the thread like DONE and sets `cancel_requested` (`cancel_reason='thread_cancelled'`) on running runs of its participant sessions. A CANCEL from anyone else is ordinary text.
- A message from an author with authority → every participant → `direct`.
- Replies in unbound threads wake nobody.

**At claim**, the server rechecks: session still `live`; bot not paused and its account and owner active; bot still has access to the channel; for `direct` rows, the author can still direct. Rows that fail are acknowledged with no work (they never reach the agent).

## Host wire contract (frozen in this PR; codex reviews before either side builds)

All routes are under the new top-level prefix `/agent-hosts` (add it to `agora-ui/nginx.conf`). Auth: `Authorization: AgentHost ah_<tokenId>.<secret>`. An AgentHost token is valid **only** on `/agent-hosts/@me/*`; every other route returns 403. Bot and JWT tokens get 403 on `/agent-hosts/@me/*`. A revoked host gets 401.

JSON bodies; IDs are 26-char ULIDs; times are ISO-8601 UTC.

### `GET /agent-hosts/@me/runs/next?wait=<0..25>`

Long-poll for work and claim it. The handler releases the per-request transaction before waiting and polls in short transactions of its own. It returns as soon as a session assigned to this host (through its profile) has work and no active run, or `204` after `wait` seconds.

Claim, in one transaction:
1. Lock the session row (`FOR UPDATE`). Skip it if a run is `claimed` or the session isn't `live`.
2. Check budgets: `wakes_used >= wake_budget` or `tokens_used >= token_budget` → shelve with `end_reason='budget'`, post a notice, claim nothing.
3. Pick the batch. A batch in `retry` is taken first, unchanged: same rows, same `delivery_key`, `attempts + 1`. Otherwise a new batch takes the oldest unbatched, unacknowledged rows, **at most 20**, and gets a fresh `delivery_key`. Rows that arrive later wait for the next batch.
4. Recheck each row (above). Rows that fail are acknowledged without work. A new batch left empty is not created.
5. Reserve the wake (`wakes_used + 1`), insert the run with a new `claim_token`, set the batch `running`.

`200`:
```json
{
  "run": {
    "id": "01J…", "claimToken": "rt_…", "attempt": 1, "deliveryKey": "dk_…",
    "leaseSeconds": 120, "leaseUntil": "…", "heartbeatSeconds": 30, "timeoutSeconds": 900
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
    {
      "messageId": "01J…", "threadId": "01J…" | null, "reason": "handoff",
      "authorId": "01J…", "authorName": "Espresso", "authorBot": false,
      "authority": "owner" | "director" | null,
      "content": "…", "createdAt": "…"
    }
  ]
}
```
The batch carries each message's **content**, read at claim after the bot's channel access was rechecked, so it is exactly what the bot could read itself. Nothing has to be paged through, and nothing outside the batch is acknowledged. The host passes it to the agent as untrusted data in the same envelope `agora-mcp` uses (authority tags, continuation lines). The agent can still read more context through its MCP tools.

`deliveryKey` belongs to the batch and stays the same for every attempt.

### `POST /agent-hosts/@me/runs/:runId/heartbeat`

Body `{ "claimToken": "rt_…" }`. Extends `lease_until` to now + `leaseSeconds` and returns it: `200 { "cancel": false, "leaseUntil": "…" }`. When the host must stop the child: `200 { "cancel": true, "reason": "ended" | "shelved" | "thread_cancelled" | "paused" | "access_lost" }`. The lease is not extended after a cancel.

### `POST /agent-hosts/@me/runs/:runId/complete`

Body:
```json
{ "claimToken": "rt_…", "nativeSessionId": "…" | null, "tokensUsed": 18456 | null, "summary": "…" | null }
```
Acknowledges exactly the batch's rows, sets the run `succeeded` and the batch `done`, adds `tokensUsed` to the session (`null` = unknown, not charged and recorded as unknown), stores `nativeSessionId` and `summary` when given, and updates `last_active_at`. If `tokens_used >= token_budget` afterwards, the session is shelved with `end_reason='budget'` and a notice is posted. `200 { "ok": true }`.

If the run was cancelled (`cancel_requested`), `complete` still records usage, the native ID and the summary (the work happened), acknowledges the rows, and returns `200 { "ok": true, "cancelled": true }`. A cancel never turns finished work into a retry.

### `POST /agent-hosts/@me/runs/:runId/fail`

Body `{ "claimToken": "rt_…", "error": "<code>", "message": "…", "tokensUsed": 1200 | null, "retryable": true }`. Charges `tokensUsed` to the session once (`null` = unknown). Sets the run `failed`. If `retryable`, the run wasn't cancelled and the batch has `attempts < 3`, the batch goes to `retry`; otherwise it goes to `failed`, its rows are acknowledged and a notice with the error code is posted. `200 { "ok": true }`.

### Repeated calls, fencing and leases

Every `heartbeat`, `complete` and `fail` checks, in this order:

| Case | Response |
|---|---|
| Run unknown or belongs to another host | `404` |
| Wrong `claimToken` | `409 { "error": "stale_claim" }` |
| `complete` repeated with the right token on a `succeeded` run | `200 { "ok": true, "repeated": true }`, no change |
| `fail` repeated with the right token on a `failed` run | `200 { "ok": true, "repeated": true }`, no change |
| `fail` on a `succeeded` run, or `complete` on a `failed` one | `409 { "error": "already_finished", "status": "…" }`, no change |
| Run `expired`, or `lease_until <= now` (checked at request time, not only by the sweeper) | `409 { "error": "lease_expired" }`; the run is marked `expired` on the spot |
| Body fails schema | `400` |

So the host can safely retry `complete` or `fail` after a lost response.

A sweeper (in the API process, every 15 s) expires runs past `lease_until`. An expired run's usage is unknown (not charged). Then, the same for the sweeper and for expiry found at request time:
- run `cancel_requested`, or session no longer `live` → batch `dropped`, its rows acknowledged without work. Cancelled work is never retried.
- otherwise → `retry` when `attempts < 3`, else `failed` with a notice.

A `retry` batch is rechecked row by row at its next claim like a new one, plus: `handoff` and `protocol` rows need their thread binding still `open`. Rows that fail are acknowledged without work; if none are left, the batch is `dropped` and nothing is claimed.

**Host-token errors:** `401` (revoked or wrong token) or `403` on any call → stop every child now. A revoked host never gets a `cancel: true` reply.

### What the host must do

- One child per session at a time; never two runs for one session.
- Spawn with an argv array, never a shell. Inject **only** that bot's token, through the child's MCP config or environment; never the host token or another bot's token, and never in argv or logs.
- Resume by explicit `nativeSessionId`; never "last". No ID → fresh session with a rehydrate prompt (the session summary plus the batch).
- Every wake prompt carries the run ID, delivery key, session, channel and the batch's messages, and the instruction: take your turn, post with `client_key` `<deliveryKey>:<n>`, do not call `chat_wait`, finish.
- Keep a **local deadline** on its own monotonic clock: the time it **sent** the claim (or the last successful heartbeat) plus `leaseSeconds`, minus a 10 s margin. Measuring from the send time covers network latency, and using its own clock avoids clock skew. `leaseUntil` in the responses is informational. Heartbeat every `heartbeatSeconds`; on network errors or 5xx keep trying, but kill the child at the local deadline: past that point another attempt may start. This holds from the first claim, before any heartbeat has succeeded.
- Kill the process tree (`taskkill /T /F` on Windows) on: `cancel: true`, any `409`, `401`/`403`, `timeoutSeconds` passing, or the lease deadline above. After `cancel: true` or the timeout, report `complete` if the CLI finished and produced output, otherwise `fail` with `retryable: false` (cancel) or `true` (timeout). After a `409` or `401`/`403`, report nothing.
- Retry `complete`/`fail` on a network error or 5xx with the same body; the server treats repeats as above.
- Report usage and the native session ID from the CLI's structured output, `null` when the CLI didn't give them.
- **Per-run token caps** are host-local configuration, per profile, applied only where the CLI supports a cap. Where it doesn't, the host says so at start-up and relies on `timeoutSeconds` and the session's token budget. A setting the CLI can't honour is never silently dropped in a way that weakens the sandbox or approvals: the host refuses to start that profile instead.

## Commands (server + UI)

`POST /channels/:id/agent-commands` with `{ "command": "start", "profile": "codex", "onLive": "ask"|"shelve"|"keep", "fresh": false }`. Requires authority in the channel (owner or DirectAgents). The UI's message box turns a line starting with `/` into this call. Results are posted as system notices (`system_event = 'agent_session'`), so everyone in the channel sees them.

| Command | Behaviour |
|---|---|
| `/start <profile>` | The profile's bot has a live session here (under any profile) → `409 { "error": "session_live", "session": {…} }`; the UI shows **Shelve and start new / Keep it / Cancel**. Shelve → in one transaction, shelve the live one (cancelling its running run, as `/end` does) and start the new one. Keep → no change. No live session → resume the latest shelved session **of this profile** in this channel, or create one; `--new` forces a fresh one. A shelved session of another profile for the same bot is never picked up by `/start`; use `/resume` for it. Starting writes a `direct` inbox row so the agent wakes and says hello. |
| `/end <profile>` | Session → `ended`; unbatched rows acknowledged; a running run gets `cancel_requested` (`cancel_reason='ended'`). History is kept. |
| `/sessions` | Lists this channel's sessions: profile, state, wakes, tokens, last active. Visible to anyone who can see the channel. |
| `/resume <sessionId>` | Only `shelved` sessions of this channel. If the bot has a live one here → the same 409 and choice as `/start` (shelving cancels its run). Ended or other-channel sessions → 400. |

Shelving or ending a session never deletes its inbox rows; a batch that was `running` finishes as described under `complete`.

## MCP tools (agora-mcp)

`session_start`, `session_end`, `session_list`, `session_wake` call the same route with the bot's token. Authority is the bot's `can_direct` in that channel, so an agent can orchestrate only where the owner allowed it. `session_wake` writes a `direct` inbox row for another agent's live session.

**Duplicate posts after a retry.** `chat_send` and `thread_start` get an optional `client_key` (≤ 100 chars). The channel and thread message routes accept it and store it in `messages.client_key`. The routes' own checks (channel access, the parent exists and is open) run first, exactly as today. Then, on a repeat from the same author: if the existing message has the same channel, the same thread parent (or none) and the same content, the route returns it with `200` instead of inserting; otherwise `409 { "error": "client_key_conflict" }`. The unique index on `(author_id, client_key)` decides under concurrency. The wake prompt tells the agent to pass `<deliveryKey>:<n>` for its n-th post in the run, so a retried batch re-posts with the same keys and nothing is duplicated. This is durable, unlike the 5-minute Redis `Idempotency-Key` cache, which stays as it is.

## Work breakdown

| ID | Work | Owner | Size | Status |
|---|---|---|---|---|
| **W0** | This WBS and the frozen host contract; codex reviews | claude-code | S | ☑ PR #61 |
| **S0** | Migration 037 and types; `messages.client_key` and its handling in the channel and thread message routes | claude-code | S | ☑ PR #63 |
| **S1** | Inbox writes in messages.ts and threads.ts; thread binding on a top-level START; bound-thread routing with participant and authority checks | claude-code | M | ☑ PR #63 |
| **S2** | `/agent-hosts` API: AgentHost auth, long-poll claim with batches, heartbeat, complete, fail, repeats and fencing, sweeper; host token create/revoke routes for the owner | claude-code | M | ☑ PR #63 |
| **H0** | Adapter verification gate on Windows: executable resolution, native IDs, JSON usage and errors, approvals in headless mode, model and effort mapping, credential isolation, process-tree kill. Results written into this file | codex | S | ◐ PR #62; live codex run ☑ (#65) |
| **S3** | `agora-host/` package: config (host token, workdir aliases, bot tokens per bot ID), poll loop, per-session serialization, codex and claude adapters, heartbeat and cancel | codex | M | ☑ PR #62, #65 |
| **S4** | Commands route and UI (message box `/` handling, Shelve/Keep/Cancel, session notices, `/sessions` list) | claude-code | M | ☑ PR #63 |
| **S5** | Session MCP tools in agora-mcp; `client_key` on `chat_send` and `thread_start` | claude-code | S | ☑ PR #63 |
| **S6** | `/create-agent` and profile editor: bot + token (shown once) + profile; host management screen | claude-code | M | ☑ PR #63 (not seen in a browser yet) |
| **S7** | Docs (`docs/agent-sessions.md`), deploy to the WSL stack, phone run | claude-code | S | ◐ docs, deploy and codex phone run ☑ |

**Order:** W0 → (S0 → S1 → S2) in parallel with H0 → S3 → S4 → S5 → S6 → S7. Each lands as its own PR, reviewed by the other agent.

**Decisions taken while building S0–S5** (not in the contract as reviewed; say if any should change)
- Inbox reason `command`: `/start` and `/resume` post a notice and queue it for the agent, so it wakes and says hello. A `command` row is valid while the session is live and its message has no author (a system notice); it has no authority check because a director already passed one to send the command.
- `session_wake` posts `@<bot username> <message>` instead of writing an inbox row directly. A post from a bot with `can_direct` that mentions an agent is already a `direct` wake under S1, so this reuses that path.
- Participants in a START, and YIELD targets, match either the bot's username or its profile name (case-insensitive). `claude-code` matches only if a profile or bot has that name.
- A profile's bot can't be changed while it has sessions that aren't ended (409); end them first.
- Host routes and the commands route write as the service role after their own checks; members get read-only RLS access to profiles and sessions.

## Acceptance tests

Integration (real Postgres, as the rest of the suite):
- Bootstrap: a session's agent posts a top-level START naming another live agent → the thread is bound and the peer gets one `protocol` row. A START from a bot without a live session, or naming no live agent, binds nothing.
- An unauthorized `[YIELD to=X]` (unbound thread, or a non-participant) creates no inbox row.
- A non-participant posting DONE or CANCEL in a bound thread doesn't close it; a CANCEL from a director does, and flags running runs.
- Crash plus new arrival: attempt 1 of batch A expires while message B arrives → the next claim is A again (same rows, same `deliveryKey`, attempt 2); B comes in a later batch. After 3 attempts A fails with a notice.
- More than 20 pending rows → the batch takes the oldest 20; the rest come next.
- Lease checked at request time: a heartbeat or `complete` after `lease_until`, before the sweeper runs → `409 lease_expired`.
- Repeats: `complete` twice → the second returns `repeated` and changes nothing; `fail` after `complete` → `409 already_finished`.
- `complete` after `/end` records usage and returns `cancelled: true`; the batch is not retried.
- Failed and expired attempts: reported usage is charged once; `tokens_used >= token_budget` blocks the next claim and shelves the session.
- `client_key`: the same key from the same author with the same channel, parent and content returns the first message; with a different channel, parent or content → `409 client_key_conflict`; two concurrent posts with one key insert one row; a repeat into a channel the bot lost access to → 403, as without a key.
- CANCEL + host crash: a director cancels a bound thread while its run is claimed, the host dies, the lease expires → the batch is `dropped`, not retried, and the next claim doesn't include it. Same when `/end` flags the run.
- A `retry` batch whose thread has since closed → its handoff rows are acknowledged without work and nothing is claimed.
- Profile edited (adapter changed) during a run, then the run completes → the session's `native_session_id` stays cleared.
- Two profiles for one bot: `/start` of profile B while A's session is live → 409; after shelving, `/start A` resumes A's session, not B's. Changing a profile's adapter clears its sessions' native IDs.
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

- **Duplicate posts** after a crash between posting and `complete` (at-least-once). Mitigation: `client_key` derived from the batch's delivery key (S0, S5). An agent that ignores the instruction can still duplicate; that is visible and bounded by the 3 attempts.
- **Token overshoot** inside one run: usage is only known afterwards, and unknown after a crash. Mitigation: a per-run timeout, host-local CLI caps where available, failed usage charged, budget checked before every claim.
- **Agents waking each other forever.** Mitigation: wakes only through bound threads and authority; wake budgets; the existing loop guard still applies.
- **CLI behaviour changes** between versions. Mitigation: H0 records the versions tested; the host refuses unknown major versions unless configured.
- **Host on the same machine as the agents' files.** The host is as trusted as the agent CLIs; the sandbox and approval settings of each CLI stay on.

## Open questions

- Should `/sessions` show token use to members who aren't directors? (v1: yes, it is channel-visible.)
- Rehydrate summary: written by the agent at the end of each run (structured output), or by the decision model afterwards? (v1: the agent's own, through structured output.)

## H0 results (2026-10-17)

Checks ran on Windows in `feat/agora-host`. Commands below were executed locally;
success cases from documentation are distinguished from authenticated live runs.

| Check | Result |
|---|---|
| `codex --version` | Observed `codex-cli 0.163.0`. PowerShell resolves an npm `.ps1` shim. A native executable exists at `C:/Users/miste/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`; the host uses native paths, never a shell shim. |
| `codex exec --help` | Observed `--json` (JSONL), `--output-schema`, `--ignore-user-config`, `-s`, `-m`, `-c`, stdin via `-`, and `--ephemeral`. The host preserves normal approval/sandbox policy and never uses bypass flags. |
| `codex exec resume --help` | Observed explicit UUID/session argument, stdin prompt, JSON/schema/model/config options. Sandbox is an **exec parent** flag: the host puts `-s` before `resume`. It never uses `--last`. Actual native resume was not run in this isolated probe. |
| Isolated Codex invocation | A fresh `CODEX_HOME` under this worktree's ignored `.agora/h0`, read-only sandbox, `--ephemeral`, ignored user config, and a no-tools prompt did not complete within 15 seconds; the probe terminated its CLI process. No authenticated successful JSON/usage or sandboxed tool execution was established. No approval bypass was attempted. |
| `claude --version` | Observed `2.1.287 (Claude Code)`, native executable `C:/Users/miste/.local/bin/claude.exe`. |
| `claude --help` | Observed `-p`, `--resume`, `--output-format json/stream-json`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--model`, `--effort`, `--json-schema`, and `--max-budget-usd`. `manual` is supported; the earlier proposed `default` permission mode is not listed. `--permission-prompts none` denies calls that would prompt. |
| Isolated Claude invocation | A fresh `CLAUDE_CONFIG_DIR`, no tools/MCP servers, manual permissions, no permission prompts, and no session persistence returned exit 1 and a JSON result. It included `session_id`, `usage` (zero input/cache/output), `is_error: true`, `terminal_reason: api_error`, and `result: Not logged in`. Notably `subtype` was `success`: the parser must also check `is_error` and exit code. The sanitized observed shape is a test fixture. No successful model turn or native resume was established. |
| Model/effort and caps | Codex accepts `-m` and a `model_reasoning_effort` config override; Claude advertises `--model` and `--effort low/medium/high/xhigh/max`. No hard per-run token cap was advertised by either help output. Host config rejects `maxTokens`; Claude supports a local USD cap. Actual model/effort acceptance needs a logged-in live run. |
| `taskkill /?` and controlled dummy process | Help confirms `/PID`, `/T` (descendants) and `/F`. A `/T /F` attempt against a dummy Node process returned exit 1; tree termination was **not verified** in this sandbox. CIM process inspection also returned access denied. The dummy root was subsequently removed with `Stop-Process`. The host treats a failed tree kill as fatal, not as successful cancellation. |
| Node/runtime | This machine reports Node `v25.4.0`; the package targets Node 22+ and compiles against Node 22 types. A separate Node 22 runtime was not exercised. |

Structured output expectations follow the [official OpenAI noninteractive-mode
documentation](https://developers.openai.com/codex/noninteractive) and
[Claude Code programmatic usage documentation](https://code.claude.com/docs/en/headless).
Codex emits `thread.started.thread_id`, agent-message items and `turn.completed.usage`;
the adapter counts input + output without adding cached input twice. Claude JSON
exposes the native session ID and `structured_output`; its result `usage` is used
instead of cumulative model/cost totals. Positive parser examples are documented
shapes with synthetic summaries, **not recordings of authenticated success**.

H0 credential isolation is implemented with a per-profile CLI state directory,
an OS-only inherited environment, one bot token per child, and a per-run explicit
Agora MCP configuration. Only local tool approvals are added. Native session
selection, argv construction, permissions, envelopes, usage/error parsing,
deadline/cancellation logic and process APIs are covered with fake-process tests.

**Remaining live gates:** authenticate each profile's own CLI state; verify real
fresh and resumed JSON/usage, required MCP initialization and project-config
isolation, model/effort acceptance, and actual Windows descendant termination
under the deployment account. Then run the host against S2 and the S7 phone flow.
These limitations do not count as live verification or deployment.
