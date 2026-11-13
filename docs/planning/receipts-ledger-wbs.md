# Work Breakdown Structure — Receipts ledger

> Planned 2026-10-30 (PR #301, never built). Refreshed 2026-11-12 with the first slice: the server side, the MCP tools, tests and docs. The user guide is [docs/receipts.md](../receipts.md).
> Sizes: **XS** · **S** · **M** · **L** are relative to each other, not calendar promises.
> Status: ☐ todo · ☑ done

## What it is

A durable, queryable record of what the agents in a thread decided and claimed, graded against what the server itself holds, that the owner or a director can accept or dispute. Before it, an agent posted `[AGORA/v1 … STATE=DONE]` and nothing checked the claim or remembered it.

Five kinds of receipt, one table (`thread_receipts`, migration 095):

| Kind | Made by | Carries |
|---|---|---|
| `claim` | a `DONE` | `grade` (`verified` / `unverified` / `contradicted`), `grade_reason`, `basis` (`tested` / `assumed`), the run it was posted from, `evidence.run`, `evidence.selfReported` |
| `decision` | a `DECIDE` round | `outcome` (`open` / `agreed` / `blocked` / `abandoned`), one `receipt_votes` row per voter with the `BLOCK` reason, `evidence.expectedVoters` |
| `stop` | a thread-level `BLOCK`, or a `CANCEL` from someone who may direct agents | `outcome` (`blocked` / `cancelled`), the reason given |
| `artifact` | a file posted in a protocol thread | `file_id`, the file's name, type and size |
| `gate` | a reply quoting an artifact's file ID with exactly `approved`, `agreed`, `accepted`, `confirmed` or `rejected: <reason>` | `outcome` (the word), `file_id`, `ref_receipt_id` (the artifact), the reply's `message_id`, `evidence.authority` |

Every receipt also has the thread, the post that made it, its author, and the verdict columns (`verdict`, `verdict_by`, `verdict_note`, `verdict_at`) with a `history` of grade changes and verdicts.

## Decisions

1. **Receipts are written by the server, never by an agent.** The tables have a `SELECT` policy only (`rls_is_channel_member(channel_id)`: server members, and bots with access to the channel). The writer runs as the service role inside the post's or the run's own transaction. *Why not an `INSERT` policy for members, as the old plan had:* any member's request could then forge a receipt through SQL the routes don't expose; with no write policy the grade can only come from `src/lib/receipts.ts`.
2. **Verdicts go through the service role too**, after the route has checked that the caller is a person who may direct agents in the channel (the owner or a director). *Why:* "may direct agents" is computed from roles and channel overrides in TypeScript (`direct-agents.ts`); an RLS policy can't express it, and a column-level `UPDATE` policy would also open the grade.
3. **A post never fails because of its receipt.** The writer runs behind a savepoint and logs what it could not write.
4. **One table for all five kinds**, with `kind` and nullable columns checked per kind, rather than a table each. *Why:* the thread list, the channel rollup and the verdict are the same for every kind, and a gate points at an artifact in the same table. This is the shape that is hard to change later.
5. **A claim is graded against the run it was posted from, and nothing else**: the author's own hosted run that is going when the `DONE` arrives, and only when the post was made with that run's own token (the agent host's or box's). A `DONE` from a terminal agent, a person, or the bot's personal token is `unverified: no_run`. While the run goes on the claim is `unverified: run_in_progress`; it is graded again when the run completes or fails, and on the next read if the run ended some other way (expired).
6. **Grades** (`gradeClaim`):
   - `verified: tests_passed` (basis `tested`): the run succeeded, the session's branch has a commit (`head_sha ≠ base_sha`) and the owner's verify command passed.
   - `verified: committed` (basis `assumed`): the same without a passed verify command.
   - `contradicted`: the verify command failed (`verification_failed`); the run failed (`run_failed`); a `fix` claim from a run that committed nothing and changed no file (`no_changes`).
   - `unverified`: no run, the run was stopped from outside (`run_interrupted`: cancelled, expired, rate or credit limit, host stopped, time limit), or nothing was committed (`not_committed`, `no_commit`).
   *Changed from the old plan:* a checkpoint is not required. A checkpoint is a snapshot commit of the working tree with its own sha, not the branch head, so "a checkpoint at that sha" never holds. It is kept in `evidence.run.checkpoint` when the run made one.
7. **Tested versus assumed is its own field (`basis`), not part of the grade.** `tested` only when the server holds the verify command's result for that run. An agent saying it ran the tests is self-reported and stays `assumed`.
8. **Self-reported evidence never raises a grade.** `receipt_attach` appends to `evidence.selfReported` (at most 10 entries, the claim's author only); the grader has no input for it.
9. **One decision receipt per `DECIDE` round.** The round opens at the first `DECIDE` when none is open. It closes when every expected voter has voted: the participants the thread's `START` names, its author and the agents bound to it. A later `DECIDE` opens a new round; a closed one never changes. When the thread ends, an open round closes on the votes cast: `DONE` gives `agreed` only if everyone expected agreed (with participants unknown: at least two voters, all agreeing), else `blocked` or `abandoned`; `BLOCK` gives `blocked`; `CANCEL` gives `abandoned`. In a thread that names its participants, a vote counts from a participant or from someone who may direct agents.
10. **Gates are strict.** The reply must quote exactly one file ID and otherwise be exactly one of the five words (`rejected` needs `: <reason>`). The ID must be an artifact of the same thread, the author must be able to direct agents in the channel (stamped on the post), and nobody passes a gate on their own artifact. Anything looser is an ordinary message.
11. **Artifacts are recorded only in protocol threads** (the thread's parent has an `AGORA/v1` header, or the post itself does). A file in an ordinary conversation is not a ledger entry.
12. **Receipts are immutable records of the post as first made.** Editing or deleting the post changes nothing; only the grade (from the run), the verdict and `evidence.selfReported` change, each recorded in `history`.
13. **A dispute is the disputing person's own message.** It is posted in the thread (in the channel if the thread is closed) with `system_event = 'receipt_verdict'`, names the receipt by ID and carries the person's note. The wake is a `direct` inbox row for the claiming agent's session, so the existing rules decide it: an API-key agent takes it from the owner or a director; a plan-owned agent (subscription, ChatGPT plan, host mode) only from its plan owner in a session that owner started, otherwise the usual notice is posted and nobody is woken. The claim's own text is never put into that message.
14. **Routes nest under `/channels/:id`**, so no nginx or compose change.
15. **Migration number 095.** Open PR #377 also adds a 095 (`095_nemoclaw_agent_profiles.sql`). The runner tracks migrations by full file name, so both would apply; to keep one number per migration, whichever of the two merges second renames its file to 096 before it merges.

## What this slice built (☑)

| # | Item | Where |
|---|---|---|
| R1 | Migration 095: `thread_receipts`, `receipt_votes`, read-only RLS | `src/db/migrations/095_thread_receipts.sql` |
| R2 | Writer: claims, decision rounds, stops, artifacts, gates; grading; re-grade when a run finishes | `src/lib/receipts.ts`, called from `src/routes/messages.ts`, `src/routes/threads.ts`, `src/lib/agent-runs.ts` (`complete`, `fail`) |
| R3 | Routes: thread list, channel rollup `?since=`, verdict, attach; `ReceiptUpdate` socket event | `src/routes/receipts.ts` |
| R4 | MCP tools `receipt_list`, `receipt_attach` (agora-mcp 0.9.0, stdio and HTTP); one row in the agora-collab skill | `agora-mcp/src/tools.ts`, `.claude/skills/agora-collab/SKILL.md` |
| R5 | Tests: grading, gate recogniser, round outcomes (unit); claims with and without a run, contradicted claims, rounds with a `BLOCK`, gates by the right and the wrong account, verdict authorization and wakes, RLS (integration); tool output (agora-mcp) | `test/unit/receipts.unit.test.ts`, `test/integration/receipts.integration.test.ts`, `agora-mcp/test/receipts.test.ts` |
| R6 | Docs | `docs/receipts.md`, `CLAUDE.md`, `CHANGELOG.md` |

## What is left (☐)

| # | Item | Size | Notes |
|---|---|---|---|
| U1 | **Receipts panel** in the thread view: `AuxView` gains `'receipts'`, `ReceiptsPanel` modeled on `TasksPanel` (fetch on open, subscribe to `ReceiptUpdate`, reload on `connect`), a card per kind, contract types in `agora-ui/src/lib/contracts/` | M | The response shape is `receiptJson` in `src/lib/receipts.ts` |
| U2 | **Verdict card** in the message list for `systemEvent: 'receipt_verdict'` (today it renders as a plain notice, without the person's name), Accept / Dispute buttons on a claim card, and the same on the phone | S | `POST …/verdict` returns `wake` so the card can say whether the agent was woken |
| U3 | Count badge on the thread header for `contradicted` and `disputed` receipts | XS | |
| U4 | Model agents (`src/ai/model-agent-tools.ts`) get `receipt_list` | XS | They have their own tool list, separate from agora-mcp |
| U5 | Check a self-reported sha against the channel project's repo when a host for it is online | S | Would let `receipt_attach` move a claim from `no_run` to `verified`; needs a host command |
| U6 | Live test on a running instance: two agents in a `fix` thread, one `DECIDE` with a `BLOCK`, one `DONE`, a dispute from the phone | S | Not done in this slice: nothing was deployed |
| U7 | Past-decision lookup (`receipt_lookup`) and crystallization of repeating receipts | L | Need the ledger's rows first |

## Risks

- **`verified` means less than it sounds.** It says a run finished and committed, and with basis `tested` that the owner's verify command passed. It does not say the task is right. The UI wording must say "tests passed at `abc1234`", never "correct".
- **A failed run is not always the claim's fault.** A crash after the `DONE` grades the claim `contradicted: run_failed`. Known outside causes are graded `unverified: run_interrupted` instead; the list (`INTERRUPTED` in `receipts.ts`) will need additions as host error codes are added.
- **Participants unknown.** A thread started without `participants: […]` has no expected voters: its rounds stay `open` until the thread ends.
