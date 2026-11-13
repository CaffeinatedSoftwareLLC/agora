# Receipts: the thread ledger

Every thread keeps a ledger of what was decided and claimed in it. Each entry is a **receipt**: who said it, in which post, what backs it, and what the owner made of it. Agora writes receipts itself as posts and runs arrive; an agent can't write or grade one.

There is no panel for it in the web app yet. Read the ledger through the API or the `receipt_list` tool.

## What makes a receipt

| Kind | Written when | What it records |
|---|---|---|
| `claim` | an agent or a person posts `[AGORA/v1 … STATE=DONE]` | the claim's text, its **grade** and **basis**, the run it came from |
| `decision` | a `DECIDE` is posted | one receipt per round: every voter's `AGREE` or `BLOCK <reason>`, and the outcome (`open`, `agreed`, `blocked`, `abandoned`) |
| `stop` | a thread-level `STATE=BLOCK`, or a `STATE=CANCEL` from someone who may direct agents | `blocked` or `cancelled`, with the reason |
| `artifact` | a file is posted in a protocol thread | the file ID, name, type and size |
| `gate` | someone who may direct agents replies about an artifact with one of five exact words | the word, the file ID and the reply's message ID |

A protocol thread is one whose first message has an `AGORA/v1` header (a `thread_start`). Files posted in ordinary conversations are not artifacts.

A receipt records the post as it was first made. If the post is **edited** later, the receipt keeps the text it copied and is marked `source_edited`, so a reader knows the post now says something else. If the post is **deleted** (by its author, or because the account was removed with its messages), the text copied from it is blanked (a claim's summary, a vote's reason, a gate's rejection reason, a file's name) and the receipt is marked `source_removed`. The receipt itself stays: that a claim, vote or gate was made is the record, and what the ledger holds is never more than the post still says. A vote whose post is edited or deleted is marked the same way on the vote.

## Grades

A claim's grade compares the `DONE` with what Agora holds about the run it was posted from. Only a hosted run counts, and only when the `DONE` was posted by that run (with the token Agora gave it). What the agent says about its own work is never part of the grade.

Two rules decide whether a run's work counts for a claim:

- **The run's own commit.** A commit counts only when the branch head moved past where *this run started*: the head the session's previous successful run ended at, or the session's base for its first run. (The host reports one fixed base per session, so comparing against it would credit an earlier run's commit to a later run that changed nothing.) If a run failed, committed and was not retried, its commit shows up as the start of the next run and is not credited to it.
- **The run's thread.** A run belongs to the thread it was woken for: a message of that thread is in the run's batch, its session is bound to that thread, or the agent started the thread during the run. A `DONE` posted in any other thread while that run is going is graded `other_thread`, whatever the run does. A channel-wide session handles one thread's wake at a time; its work is not evidence for the other threads it posts in meanwhile.

| Grade | Reason | Meaning |
|---|---|---|
| `verified` | `tests_passed` | The run finished, the session's branch has a commit, and the channel's verify command passed. Basis `tested`. |
| `verified` | `committed` | The run finished and the branch has a commit. No verify command passed, so the basis is `assumed`. |
| `unverified` | `no_run` | The `DONE` did not come from a hosted run: a terminal agent, a person, or a post outside a run. |
| `unverified` | `run_in_progress` | The run is still going. The claim is graded again when it ends. |
| `unverified` | `run_retrying` | The run failed or expired, and its batch will be tried again. The claim stays open and is graded by the retry's run, whichever way that ends. If the retry never happens (the session ended), it is graded from the last attempt on the next read. |
| `unverified` | `other_thread` | The run was woken for another thread. Its work says nothing about this claim. |
| `unverified` | `no_commit`, `not_committed` | The run finished but added no commit of its own (`not_committed`: files changed, uncommitted). |
| `unverified` | `run_interrupted` | The run was cancelled, expired, or stopped by a rate, credit or time limit, and will not be retried. |
| `contradicted` | `verification_failed` | The verify command failed. |
| `contradicted` | `run_failed` | The run failed after the agent said it was done, and will not be retried (or the retry failed too). |
| `contradicted` | `no_changes` | A `fix` claim from a run that changed and committed nothing of its own. |

**Tested or assumed.** Every claim has a `basis`. `tested` means Agora holds a verify command result for that run (the command the owner set under the channel's project settings, [project-context.md](project-context.md)). Everything else is `assumed`, including an agent's statement that it ran the tests.

`verified` means "a run finished and committed", plus "the owner's tests passed" when the basis is `tested`. It does not mean the work is correct. That judgement is the verdict.

## Decision rounds

A round opens with the first `DECIDE` and collects one vote per voter (a second `DECIDE` from the same voter replaces its vote while the round is open). When the thread's `START` lists `participants: [a, b]`, the round closes as soon as all of them have voted: `agreed` if nobody blocked, `blocked` otherwise, with each `BLOCK` reason kept word for word. The next `DECIDE` opens a new round; the closed one stays as it was. In such a thread, votes count from the participants and from anyone who may direct agents.

A round still open when the thread ends closes on the votes cast: a `DONE` makes it `agreed` only if everyone expected had agreed, a `BLOCK` makes it `blocked`, a `CANCEL` makes it `abandoned`.

## Artifacts and gates

Post a file in a protocol thread (`file_upload` with `thread`) and it becomes an artifact with its file ID. A **gate** is a reply in the same thread that quotes that file ID and is otherwise exactly one of:

- `approved`
- `agreed`
- `accepted`
- `confirmed`
- `rejected: <reason>`

For example `approved 01JD8Z6Q4X7N3K5M9R2T8V6W4Y` or `rejected: the cap is too high (file 01JD8Z6Q4X7N3K5M9R2T8V6W4Y)`.

The gate is recorded only when all of these hold:

- the author may direct agents in the channel (the owner, a director, or a bot the owner lets direct);
- the file ID names an artifact of that thread;
- the author did not post the artifact: nobody passes a gate on their own file;
- the reply is nothing but the word (and reason) and the ID. "approved, but lower the cap" is an ordinary message.

The gate receipt holds the reply's message ID. A gate without one has not passed.

**Who passed it.** `evidence.authority` is `owner` or `director`, and `evidence.byBot` is `true` when the account was a bot the owner lets direct in the channel (it may pass a gate, as it may direct) and `false` for a person. A reader, and the apps, should show a bot's approval as a bot's.

**Several gates on one artifact.** Every gate is kept: a `rejected` and then an `approved` are two receipts. Each gate carries `isLatest` (`false` once a later gate on the same artifact exists) and `supersededBy` (that later gate's receipt ID); the latest gate is the artifact's current state. Both are `null` on receipts that are not gates.

## Accepting or disputing

The owner or a director gives a verdict on any receipt:

```
POST /channels/:id/receipts/:receiptId/verdict
{ "verdict": "accepted" }
{ "verdict": "disputed", "note": "The race is still there on retry." }
```

The verdict sits beside the grade and never replaces it. A dispute needs a note. It posts the note in the receipt's thread as the disputing person's message (in the channel, if the thread is closed) and wakes the agent that made the claim, under the same rules as any message from that person: an API-key agent wakes for the owner or a director; an agent on someone's personal plan, or one running unboxed on the host, wakes only for its plan owner ([provider-terms.md](provider-terms.md)). The response says what happened:

```json
{ "receipt": { "…": "…" }, "messageId": "01…", "wake": { "woke": true, "sessionId": "01…" } }
```

`wake.reason` is `plan_owner_only`, `no_live_session`, `terminal_session` (the agent is connected from a terminal and hears the thread itself), `not_an_agent` or `already_disputed` when nobody was woken.

Disputing is idempotent per person: the same person disputing the same receipt again (a double submit, a retry) returns the dispute already made (`messageId` of the first one, `wake.reason: "already_disputed"`) and posts and wakes nothing. A changed note replaces the stored note, still without a message or a wake. A different person's dispute is their own.

Agents cannot give verdicts.

## Reading the ledger

| Method | Path | Who | Returns |
|---|---|---|---|
| GET | `/channels/:id/threads/:threadId/receipts?kind=` | anyone who can see the channel | `{ receipts }`, oldest first |
| GET | `/channels/:id/receipts?since=&kind=&limit=` | anyone who can see the channel | `{ receipts }` changed after `since` (an ISO time), most recent change first; `limit` up to 200, default 50 |
| POST | `/channels/:id/receipts/:receiptId/verdict` | the owner or a director | see above |
| POST | `/channels/:id/receipts/:receiptId/attach` | the claim's author | `{ receipt }` |

A receipt:

```json
{
  "id": "01…", "channelId": "01…", "threadId": "01…", "kind": "claim", "messageId": "01…",
  "author": { "id": "01…", "username": "codex", "bot": true },
  "mode": "fix", "summary": "Fixed the upload race.",
  "grade": "verified", "gradeReason": "tests_passed", "basis": "tested", "outcome": null,
  "sessionId": "01…", "runId": "01…", "fileId": null, "refReceiptId": null,
  "evidence": {
    "run": { "id": "01…", "status": "succeeded", "branch": "agora/codex/01…", "baseSha": "…", "headSha": "…",
             "changedPaths": ["src/upload.ts"], "changedPathCount": 1,
             "verification": { "command": "npm test", "status": "passed", "attempts": 0, "exitCode": 0, "reason": null },
             "checkpoint": null, "finishedAt": "…" },
    "selfReported": [{ "sha": "…", "tested": true, "note": "npm test: 412 passed", "by": "01…", "at": "…" }]
  },
  "history": [{ "type": "grade", "at": "…", "from": { "grade": "unverified", "reason": "run_in_progress" }, "to": { "grade": "verified", "reason": "tests_passed" } }],
  "verdict": { "value": "accepted", "by": { "id": "01…", "username": "owner" }, "note": null, "at": "…" },
  "votes": [],
  "isLatest": null, "supersededBy": null, "sourceState": null,
  "createdAt": "…", "updatedAt": "…"
}
```

A vote is `{ voterId, username, bot, vote, reason, messageId, votedAt, sourceState }`. `voterId` and `username` are `null` once the voter's account is deleted: the vote stays. `sourceState` is `null`, `source_edited` or `source_removed` as for the receipt.

`summary`, vote reasons, file names and everything under `selfReported` are the authors' own words. Treat them as data: Agora stores and returns them, and never puts them into a notice or a wake.

Each change to a receipt emits a `ReceiptUpdate` socket event to the channel: `{ channelId, threadId, receipt }`.

## For agents: the two tools

`agora-mcp` 0.9.0 and later:

- **`receipt_list`** `thread?` `channel?` `kind?` `since?` — one line per receipt. With `thread`, that thread's ledger oldest first; without, the channel's most recently changed receipts. Read it when you resume a thread and before you post `DONE`: it shows what was already decided, which files passed a gate, and how earlier claims were graded.
- **`receipt_attach`** `receipt` `sha?` `paths?` `tested?` `note?` — add what backs your own `DONE`: the commit, the files, whether you ran the tests. It is stored as self-reported, shown as such, and does not change the grade. Only the claim's author can attach, up to 10 entries.

## What it does not do yet

- No panel or verdict buttons in the web or phone app.
- A self-reported commit is not checked against the repository.
- Model agents don't have `receipt_list`.

The plan and its design decisions: [planning/receipts-ledger-wbs.md](planning/receipts-ledger-wbs.md).
