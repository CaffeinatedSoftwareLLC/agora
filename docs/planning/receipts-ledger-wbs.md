# Work Breakdown Structure — Receipts ledger (decision ledger, surface 1)

> Planned 2026-10-30 by claude-code at Eryk's request. Codex reviews before R1 starts.
> Sizes: **XS** · **S** · **M** · **L** are relative to each other, not calendar promises.
> Status: ☐ todo · ◐ in progress · ☑ done

## What this adds

Every thread gets a **Receipts** side panel: a ledger of what the agents in that thread claimed and decided, with the evidence Agora already holds.

- **Claim receipts.** When an agent posts `DONE` (or a hosted run finishes in a bound thread), Agora writes a receipt that ties the claim to the run's `head_sha`, `changed_paths`, verification report and checkpoint, and grades it `verified`, `unverified` or `contradicted`. The agent's word is never the evidence.
- **Decision receipts.** Each `DECIDE` round becomes one receipt with every participant's `AGREE` or `BLOCK` and the reason given. Dissent is recorded, not lost in scrollback.
- **Owner cards.** The owner can accept or dispute a receipt from the panel or the phone, with the same card pattern as tool approvals.
- **Agents read receipts.** A new MCP tool lets an agent read a thread's receipts on catch-up, so "what did we decide and was it really done" is one call instead of a scrollback read.

Out of scope here, planned next: past-decision lookup through the decision model (`receipt_lookup`), and Progressive Crystallization, which promotes repeating receipts into scripts. Both need this ledger's rows first.

## Facts this plan rests on

- Protocol messages carry `[AGORA/v1 MODE=… STATE=…]` as the first line; `parseProtocol` (`src/lib/protocol.ts`) stores `{version, mode, state, yieldTo, decision, participants}` in `messages.protocol`. `DECIDE` bodies are `AGREE` or `BLOCK <reason>`. Only the initiator posts `DONE`.
- Routing of those states happens in `src/lib/agent-sessions.ts` (~L300–405) inside the message transaction. `DONE`/`BLOCK` from a participant closes the `agent_session_threads` row.
- Hosted runs end through `POST /agent-hosts/@me/runs/:runId/complete` (`src/routes/agent-hosts.ts` L542) with `changedPaths`, `branch`, `baseSha`, `headSha`, `verification` and `summary`; `src/lib/agent-runs.ts` stores them on `agent_runs` (migrations 039, 040, 051). Checkpoints (`agent_checkpoints`, 047) pin a `sha` per run.
- Verify-before-yield (`agora-host/src/verify.ts`) runs the owner's one verify command after a successful run with changed paths; the `VerificationReport` (`src/lib/channel-projects.ts` L174) lands in `agent_runs.verification` and is posted as a channel notice.
- Votes are parsed per message and never aggregated. There is no per-event table; tool calls are a live counter only.
- Side panels switch on `AuxView` in `agora-ui/src/stores/uiStore.ts`; `TasksPanel.tsx` is the template (fetch, subscribe to socket events, reload on `connect`). Socket notices are queued on `request.pendingEvents` and emitted to `channel:<id>` after commit.
- Approval cards are system messages with `system_event` + `system_data {kind, requestId, status}` updated by a decision route that emits `MessageUpdate` (`src/lib/agent-permissions.ts`, `src/routes/agent-tool-requests.ts`, `agora-ui/src/features/agents/ToolApprovalCard.tsx`).
- The nginx regex (`agora-ui/nginx.conf` L34) already proxies `/channels`; receipts routes live under it, so no regex, Vite proxy or `nginx-routes.unit.test.ts` change.

## Decisions

1. **Receipts are server-written, never agent-written.** An agent cannot create or grade a receipt. It can only attach evidence (`receipt_attach`) which is stored as `self_reported` and never upgrades the grade on its own.
2. **Grades.** `verified`: a succeeded run exists for the claiming session with `head_sha`, a checkpoint at that sha, and verification `passed` (or `skipped` because the channel has no verify command and the thread mode is not `fix`). `contradicted`: verification `failed`, or mode `fix` with an empty `changed_paths`, or `head_sha == base_sha` after a claim of change. `unverified`: everything else (interactive agent with no run, missing checkpoint, run still live).
3. **One decision receipt per DECIDE round.** A round opens at the first `DECIDE` after a `TURN`/`CHECKPOINT` and closes when every participant has voted or the thread closes. A new `DECIDE` after a `BLOCK` opens a new round; the old one stays with outcome `blocked`.
4. **Owner verdicts are a separate column**, never overwrite the grade. `owner_verdict` is `accepted`, `disputed` or null. A disputed receipt wakes the claiming session with the dispute reason (reuse the `direct` inbox reason).
5. **Receipts are immutable except for grade re-evaluation and owner verdict.** Re-evaluation runs when a later run or checkpoint arrives for the same session within the thread; the history of grades is kept in `grade_history JSONB`.
6. **Interactive agents** (chat_wait, no host) get `unverified` receipts unless they call `receipt_attach` with `sha` and `paths`; the server checks the sha exists in the channel project's repo only when a host for that channel is online (a `verify`-style host command), otherwise the attachment stays `self_reported`.
7. **Reads are RLS-scoped** by `is_server_member()` like every multi-tenant table. Writes come only from the server's own transaction (the message route or the run completion route).

## Data model (migration 060)

```sql
CREATE TABLE thread_receipts (
  id            CHAR(26) PRIMARY KEY,
  server_id     CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id    CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id     CHAR(26) NOT NULL,                      -- root message id of the thread
  kind          TEXT NOT NULL CHECK (kind IN ('claim','decision')),
  message_id    CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,  -- the DONE or first DECIDE
  session_id    CHAR(26) REFERENCES agent_sessions(id) ON DELETE SET NULL,
  run_id        CHAR(26) REFERENCES agent_runs(id) ON DELETE SET NULL,
  grade         TEXT CHECK (grade IN ('verified','unverified','contradicted')),  -- claims only
  grade_reason  TEXT,
  grade_history JSONB NOT NULL DEFAULT '[]',
  outcome       TEXT CHECK (outcome IN ('open','agreed','blocked','abandoned')),  -- decisions only
  evidence      JSONB NOT NULL DEFAULT '{}',  -- {headSha, baseSha, branch, changedPaths, verification, checkpointId, selfReported?}
  owner_verdict TEXT CHECK (owner_verdict IN ('accepted','disputed')),
  owner_verdict_by CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
  owner_verdict_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON thread_receipts (thread_id, created_at);

CREATE TABLE receipt_votes (
  receipt_id  CHAR(26) NOT NULL REFERENCES thread_receipts(id) ON DELETE CASCADE,
  voter_bot_id CHAR(26) REFERENCES bots(id) ON DELETE CASCADE,
  voter_user_id CHAR(26) REFERENCES users(id) ON DELETE CASCADE,
  vote        TEXT NOT NULL CHECK (vote IN ('agree','block')),
  reason      TEXT,
  message_id  CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
  voted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((voter_bot_id IS NULL) <> (voter_user_id IS NULL)),
  UNIQUE (receipt_id, voter_bot_id, voter_user_id)
);
```

RLS on both: `SELECT` for `is_server_member(server_id)`. Writes happen as `app_user` inside the message, thread and run-completion routes, so `INSERT`/`UPDATE` policies allow members of `server_id`; the receipt writer in `src/lib/receipts.ts` is the only code path that inserts, and no route exposes a raw insert. The owner-verdict route checks ownership explicitly before its `UPDATE`.

## Server

### Receipt writer (`src/lib/receipts.ts`)

- `onProtocolMessage(db, message)` called from `src/routes/messages.ts` and `src/routes/threads.ts` right after `parseProtocol`, inside the transaction, before pending events are queued:
  - `DECIDE` → find the open decision receipt for the thread or create one; upsert the vote; if all `participants` (from the thread's `START`) have voted, set `outcome`.
  - `DONE` → create a claim receipt; resolve the author's `agent_sessions` row for this channel (and `thread_id` when bound); take its latest `agent_runs` row; grade per Decision 2.
  - `BLOCK`/`CANCEL` at thread level → close any open decision receipt as `blocked`/`abandoned`.
- `onRunComplete(db, run)` called from `completeRun` in `src/lib/agent-runs.ts`: if the run's session has a bound `thread_id`, re-evaluate any `unverified` claim receipt for that session in that thread (Decision 5).
- Each write queues a `ReceiptUpdate {channelId, threadId, receipt}` notice.

### Routes (`src/routes/receipts.ts`)

| Method | Path | Who | Does |
|---|---|---|---|
| GET | `/channels/:id/threads/:threadId/receipts` | members | list receipts + votes, newest first; `?kind=` filter |
| GET | `/channels/:id/receipts?since=` | members | channel rollup for the phone and for crystallization later |
| POST | `/channels/:id/receipts/:receiptId/verdict` | owner | `{verdict: accepted|disputed, note?}`; writes verdict, posts a system message `receipt_verdict`, wakes the session on dispute |
| POST | `/channels/:id/receipts/:receiptId/attach` | bot (session) | `{sha, paths[]}` → `evidence.selfReported`; never changes grade |

All bodies validated with Fastify JSON Schema; all handlers run the membership query first.

### MCP (`agora-mcp`)

- `receipt_list(thread_id, kind?)` → the GET above, formatted as a short table for catch-up.
- `receipt_attach(thread_id, sha, paths)` → the attach route.
- `thread_start` and the agora-collab `START` instructions gain one line: "read `receipt_list` before your first TURN".

## UI (`agora-ui`)

- `AuxView` gains `'receipts'`; toggle next to Tasks in `ArcContentArea.tsx`; the thread header shows a count badge with the number of `contradicted` + `disputed` receipts in red.
- `features/receipts/ReceiptsPanel.tsx` modeled on `TasksPanel.tsx`: fetch on open, subscribe to `ReceiptUpdate`, reload on `connect`.
- `ReceiptCard.tsx`: claim card shows grade chip, short sha (links to `SessionWorkspace` diff), file count, verification status, checkpoint; decision card shows the question (first DECIDE body's preceding TURN summary line), one row per voter with agree/block and the reason, and the outcome.
- `ReceiptVerdictCard.tsx` in the message list for the `receipt_verdict` system event, same pattern as `ToolApprovalCard`.
- Contract types in `lib/contracts/receipts.ts` and the `ReceiptUpdate` payload in `ws-events.ts`.
- Phone: the panel is already an aux view, which the mobile shell renders full-screen; no extra work.

## Work breakdown

| # | Item | Size | Owner | Status |
|---|---|---|---|---|
| R0 | This plan reviewed by Codex; contract frozen | XS | codex | ☐ |
| R1 | Migration 060 + RLS + `src/lib/receipts.ts` writer (DECIDE, DONE, BLOCK/CANCEL) + unit tests for grading | M | claude | ☐ |
| R2 | Hook writer into message/thread routes and `completeRun`; `ReceiptUpdate` notice; integration tests (DONE with/without run, DECIDE round, contradicted fix) | M | claude | ☐ |
| R3 | Routes `receipts.ts` (list, rollup, verdict, attach) + schema + membership tests | S | codex | ☐ |
| R4 | MCP tools `receipt_list`, `receipt_attach`; agora-collab SKILL line | S | codex | ☐ |
| R5 | UI: `receipts` aux view, `ReceiptsPanel`, `ReceiptCard`, badge, contracts | M | claude | ☐ |
| R6 | UI: `ReceiptVerdictCard`, dispute wake; phone check | S | claude | ☐ |
| R7 | Docs: `docs/receipts.md` user guide; CLAUDE.md one line; `vite build`, `npm run build`, full integration run | S | claude | ☐ |
| R8 | Deploy to WSL stack, re-arm listeners, live test: Claude + Codex run a `fix` thread, one DECIDE with a BLOCK, one DONE; owner disputes from the phone | S | claude | ☐ |

R1–R2 and R3–R4 can run in parallel once R0 freezes the table and route contract. R5 needs R3's response shape.

## Acceptance tests

1. A `DONE` from a hosted session whose last run succeeded with a checkpoint and `verification.status = passed` produces a `verified` claim receipt within the same request; the `ReceiptUpdate` event arrives after commit.
2. A `DONE` in a `fix` thread whose run has empty `changed_paths` produces `contradicted` with reason `no_changes`.
3. A `DONE` from an interactive agent with no session produces `unverified`; a later `receipt_attach` adds `evidence.selfReported` and leaves the grade unchanged.
4. Two participants, one `AGREE` and one `BLOCK must keep RLS`, produce one decision receipt with outcome `blocked`, two vote rows, and the block reason stored verbatim.
5. A later `DECIDE` round after the block opens a second receipt; the first stays `blocked`.
6. A non-member gets 403 on every receipts route; a member who is not owner gets 403 on verdict.
7. Owner `disputed` with a note posts a `receipt_verdict` system message and enqueues one `agent_inbox` row for the claiming session.
8. `receipt_list` through the MCP returns the same rows as the REST route for the bot's own channel and nothing for another server.

## Risks

- **Participants list missing.** Threads started without a `START` line have no `participants`; a decision round then closes only when the thread closes. Mitigation: outcome `open` is shown as such; the panel never pretends a round is complete.
- **Grade means less than it sounds.** `verified` means tests passed at a sha, not that the task is right. The card wording says "tests passed at `abc1234`", never "correct".
- **Session resolution.** An author bot may have several sessions in a channel; bound `thread_id` resolves it, otherwise the newest live session is used and the receipt records which one.
- **Scrollback drift.** Edited protocol messages re-parse; the writer must be idempotent on `message_id` (upsert, never duplicate).

## Open questions

- [ ] Should human `AGREE`/`BLOCK` replies count as votes? Plan says yes when the author could direct (`author_could_direct`), stored with `voter_user_id`.
- [ ] Keep `receipt_attach` at all, or require every claiming agent to run hosted? Plan keeps it, graded `unverified`, so interactive sessions still appear in the ledger.
- [ ] Red badge threshold on the thread header: any `contradicted`, or only unresolved ones?
