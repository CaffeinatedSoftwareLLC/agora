# Work Breakdown Structure — Jev (System One decisions)

> Planned 2026-10-01 in Agora (thread `01M3WPM11NV2NFZY2649RM14BR`, #general) by claude-code (leader, implements), codex and gemini (review), with Eryk.
> Replaces WBS 2.2 / 2.3 of `wbs.md`, which moved here.
> Sizes: **XS** <1h · **S** ≈ half-day · **M** ≈ 1–2 days · **L** ≈ 3–5 days. Sizes are relative, not calendar promises.
> Status: ☐ todo · ◐ in progress · ☑ done

## Status (2026-10-01, end of the implementation session)

J0, A.1–A.3, B and C are implemented, on four stacked local branches that are **not pushed and have no PRs**: `feat/jev-foundation` → `feat/jev-routing` → `feat/jev-search-screening` → `feat/jev-file-tags`. The last one holds everything.

**Verified**
- Backend suite on an isolated database: all passing (see the PR for the count; 6 live checks are skipped by default). `agora-mcp` tests pass. UI: `vite build` clean, no new lint or type errors (17 lint and 7 type errors were there before).
- Live contract checks against TypeSafe (`JEV_LIVE=1 JEV_KEY=… npx vitest run test/live`): 6 of 6. They cover the response contract and the golden inputs for every question (injection, intent, tagging, tag relevance, ranking).
- End to end on a dev instance (API on Windows, real TypeSafe key, local Ollama for chat): provider test, 7 files tagged in 4 s (including a PDF), an injected file flagged and kept out of ranking, 5 searches ranked correctly in about 0.4 s each, a tag edit re-asking only that tag (7 requests), and two `@assistant` requests routed (one to chat, one to search). 51 decision requests cost about $0.0015.

**Not verified**
- **The UI has not been looked at in a browser.** It builds and its API calls work through the dev proxy, but the Decision model section, File tags section, Files panel and tag chips have not been seen on screen.
- **Search screening against a real search provider.** The screening question passes its live golden inputs and the pipeline passes with stubbed Tavily and Gemini, but no real Tavily search has gone through it (no Tavily key on the dev instance).
- **Nothing has run on the WSL + gVisor stack** (D.3). The sandbox suite (`npm run test:sandbox`, `scripts/test-sandbox-gvisor.sh`) was not run; `sandbox/std.ts` gained `searchFiles()` and new `search()` fields.
- The Docker image has not been built with the new `unpdf` dependency.

**Decisions taken during implementation** (not in the plan as agreed; say if any should change)
- The assistant's search posts the provider's answer and sources as a search card, and then (Eryk, 2026-10-01: "both") writes its own answer with the chat model from the results that passed screening. That is one extra chat call per Tavily search. Gemini-grounded results get the card only: the grounded answer is already model-written and must stay unmodified.
- Search has no keyword trigger: without routing switched on, the assistant never searches.
- `agora-mcp` gained `file_search` and `file_read`; its version stays `0.4.0` (Eryk, 2026-10-01), so the pending npm publish carries them.
- Bots can read the text of files in channels they have access to (Eryk, 2026-10-01: yes): `GET /files/:fileId/text`, `file_read` in `agora-mcp`, `readFileText()` in `agora:std`. They still cannot download the file itself.
- The default for a `decide` route is off, and every use is off, until switched on.

## What this adds

Jev is TypeSafe's "System One" model: it answers typed questions (yes/no, pick one, rate) about a piece of text, in well under a second, and returns probabilities. It does not write text. Agora will use it for three things, in Eryk's priority order:

| | Use | What Jev decides |
|---|---|---|
| **A** | Routing | Which assistant handler an explicit `@assistant` request should go to |
| **B** | Search screening | Whether a search result carries instructions aimed at the AI reading it (prompt injection) |
| **C** | File tagging and ranking | Which admin-defined tags apply to an uploaded file, and which files best match a query |

**Build order:** J0 → A.1–A.2 → B → A.3 → C. A.3 (assistant search) waits for B so that it is screened from its first day.

## Facts this plan rests on

**Jev** (docs.typesafe.ai, read 2026-10-01; one live call made with the test key: 200 in 0.41 s, model `jev-1.13.0`):
- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body `{ model: "jev-latest", state, questions }`.
- Question types: `noul` (→ probability 0–1), `choice` (≤255 options → choice, probabilities, confidence), `score` (2–10 ordered levels). Many questions per call, each answered independently.
- Text only. 64k tokens per request; 32k for `state` plus the longest question. $0.042 per 1M input tokens, output free. 40 requests/s. Errors: 401, 422, 429, 529.
- Known weaknesses (their "jaggedness" page): does not treat `state` as hostile by default; accuracy drops with irrelevant state; cannot count or compare numbers and dates; reads questions literally; cannot generate text.

**Agora today:**
- `decide` is a capability name (`src/ai/adapters/types.ts`, `ai_capability_routes`), but no adapter serves it and the cap-gateway returns 501 for it.
- Budgets are per server and capability (`checkBudget` in `src/ai/routing.ts`), counted from recorded usage, so concurrent calls can overshoot.
- The built-in assistant resolves only `chat`, plus the keyword-triggered audio overview (`isAudioOverviewRequest`). **It has no search path.** `adapter.search` is called in one place, the cap-gateway `search` handler, reached from sandboxed runs.
- Files enter through one function, `storeFile()` (`src/lib/file-store.ts`), called from the API and the cap-gateway. The metadata row is committed before the blob is written. Blobs are encrypted at rest.
- One background worker exists: `src/workers/file-cleanup.ts`.

## Decisions

| # | Decision | By |
|---|---|---|
| D1 | Order is routing, then search screening, then file tagging. Routing scope is loose; start with the assistant. | Eryk |
| D2 | The Jev key is entered in AI settings and stored in the provider registry like every other provider. `JEV_KEY` in the environment is for tests and live checks only; Agora does not read it at runtime. | Eryk |
| D3 | Gemini-grounded search results are never sent to Jev (Google's terms: unmodified, not analysed). Screening applies to Tavily. | Eryk |
| D4 | Tags come from a per-server list that admins edit in settings. Each tag has its own criteria. Jev cannot invent tags. | Eryk |
| D5 | **Jev is optional; Agora works without it.** Off or unconfigured: zero Jev calls and today's behaviour. Provider failure: one bounded attempt, then each use falls back (routing → today's rules including the audio overview keyword; screening → unscreened results with a status; tagging → jobs wait; file search → the coarse shortlist). The one exception is strict screening, which an admin switches on to refuse unscreened results. | Eryk, all |
| D13 | The `decide` contract (noul / choice / score in, validated probabilities out) is provider-neutral. Jev is the first adapter; another decision model (Eryk plans a fine-tuned one) plugs in as another adapter without touching the callers. The UI says "decision model", not "Jev". | Eryk |
| D6 | Jev informs; Agora enforces. A Jev answer never grants access, loosens a limit, or picks a provider or model. | all |
| D7 | Jev is never called for ordinary messages: only for explicit assistant mentions, search calls, file tagging and file search. | all |
| D8 | Screening is advisory, not a security boundary. The docs say so. | all |
| D9 | Tags are a ranking signal, never an exclusive filter: an untagged or mis-tagged file must still be findable. | codex |
| D10 | No plaintext excerpt of a file is stored. Tags and their probabilities are stored in plain text in Postgres. File text is sent to the decision provider for tagging **and** for ranking. Both facts are recorded in `docs/storage-and-encryption.md`, and each has its own switch. | all |
| D11 | Images are not tagged in this WBS. The extractor has an interface where a description step can be added later. | Eryk |
| D12 | No new infrastructure: the tagging queue is a Postgres table and a worker beside the file-cleanup worker. | claude-code |

## Definition of Done (every work package)

Everything in `wbs.md` "Definition of Done", plus:
- **Off means off:** a test proves the feature's code path makes zero Jev calls when the `decide` route is missing or disabled, or the per-use switch is off.
- **No secrets in logs or errors:** provider errors are sanitized before they are stored or returned.
- **Mocks follow the live contract:** after any change to the adapter, one opt-in live call (`JEV_KEY` set) is run and its result noted in the PR.
- A package that adds a migration gets its own test database (see `HANDOFF.md`, "Local environment").

---

## J0 · Foundation — `feat/jev-foundation`

| ID | Work package | Size | Depends |
|---|---|---|---|
| J0.1 | ☑ **Types and validators.** `DecideRequest` / `DecideResult` in `src/ai/adapters/types.ts`; `decide?()` on `Adapter`. Validators for the response: every asked question ID present and no extras, type matches, probabilities finite and in 0–1, a `choice` answer is one of the offered options, usage present. Size guards: state + longest question, and the whole request. *Tests:* noul/choice/score fixtures; missing and extra IDs, wrong type, NaN, out of range, over limit. | M | — |
| J0.2 | ☑ **`typesafe` adapter** (`src/ai/adapters/typesafe.ts`), plain `fetch`, registered in `adapters/index.ts`, with `testConnection`. One total deadline of 3 s covering retries; backoff on 429 and 529 that honours `Retry-After` within the deadline; abort on timeout; sanitized errors. *Tests:* mocked 401, 422, 429, 529, malformed body, deadline; one opt-in live contract check. | M | J0.1 |
| J0.3 | ☑ **Configuration.** Provider + `decide` route through the existing AI settings (D2). New per-server settings: one switch per use (routing, search screening, file tagging, file ranking), each use's share of the budget (J0.4), thresholds, strict mode for screening. JSON Schema on the routes, server-admin authorization, entries in the AI audit trail, UI in `agora-ui/src/features/settings/ai`. *Tests:* real-Postgres auth and RLS; missing or disabled route; key never returned; `vite build`. | M | J0.2 |
| J0.4 | ☑ **Internal decide service** (`src/ai/decide.ts`): the only place that calls the adapter. Resolves the server's `decide` route, checks the per-use switch and the budget, calls, validates, records usage (model, use, latency, error). Typed outcomes: `disabled`, `unconfigured`, `over_budget`, `provider_error`, `invalid_response`, `ok`. **Per-use budgets:** migration adds nullable `decision_use` to `ai_usage_events` (`routing`, `search_screening`, `file_tagging`, `file_ranking`) with an index on server, capability, use and day; `recordUsage` carries it. A call must fit both the route's total `decide` budget and its use's allocation. Allocations are percentages summing to ≤ 100; unused share is not borrowed; zero switches a use off; a route with no total limit needs explicit per-use caps for the isolation to hold. Old rows (no use) count toward the total only. Overshoot under concurrency is documented, not fixed; no reservation system. *Tests:* real-Postgres budget and ledger per use; a tagging backfill cannot consume screening's share; usage is recorded even when the caller discards the verdict; zero calls for `disabled` / `unconfigured`. | L | J0.2, J0.3 |
| J0.5 | ☑ **Question sets and fixtures.** Versioned question definitions per use (instructions, criteria, version string stored with each result). Golden inputs: benign, adversarial, uncertain. Tests assert the decision code takes on given probabilities, never exact live probabilities. | M | J0.1, J0.4 |

## A · Routing — `feat/jev-routing`

| ID | Work package | Size | Depends |
|---|---|---|---|
| A.1 | ☑ **Intent classifier.** For an explicit assistant mention: one `choice` over the handlers that exist and are enabled on that server. State is the current request only, bounded in size. Below the confidence threshold → chat. A handler that is disabled or not offered can never be selected. *Tests:* high and low confidence, unknown choice, outage and over-budget fallback. | S | J0.4, J0.5 |
| A.2 | ☑ **Wire into `assistant-handler.ts`**, after the existing bot, channel and thread checks. Jev on: the classifier picks between chat and audio overview. Jev off or unavailable: today's behaviour, including the audio overview keyword. *Tests (real Postgres):* explicit mention, duplicate dispatch, closed thread, bot without access; ordinary messages make zero calls; off keeps the keyword trigger. | M | A.1 |
| A.3 | ☑ **Assistant search handler** (new). Calls the shared screened-search service (B.1), keeps the Gemini display contract (answer unmodified with Search Suggestions, posted to the thread), uses the `search` budget. `search` becomes a classifier option only when this handler exists and a search route is enabled. *Tests:* Tavily screened answer; strict-mode failures; Gemini passes through by default and is refused in strict mode; the grounded display (answer and Search Suggestions in the thread) is intact; a duplicate dispatch posts once. | M | A.2, B.3 |
| A.4 | ☐ **Advisory participant suggestion** (which agent should take this message): endpoint + MCP tool. Never overrides an explicit YIELD or access rules; no automatic dispatch. **Backlog, not in the first release.** | M | J0.4 |

## B · Search screening — `feat/jev-search-screening`

| ID | Work package | Size | Depends |
|---|---|---|---|
| B.1 | ☑ **Shared screening service** (`src/ai/search-screening.ts`). Input: a `SearchResult`. One Jev call; one noul per item of agent-visible text (the answer, and each citation's title and snippet), each question pointing at its own item. Verdict per item from thresholds (defaults: ≥ 0.70 `flagged`, 0.35–0.70 `suspect`, below `clean`). Flagged text is withheld: a flagged citation keeps its URL and loses its title and snippet; a flagged answer is withheld. Output adds `screening: { status, model, questionVersion }` and a stable ID and verdict per citation. More items than one request allows → several calls inside the deadline, and the status says if coverage was partial. *Tests:* fixtures for injection in the answer, a title, a snippet; all-flagged; suspect; oversized. | M | J0.4, J0.5 |
| B.2 | ☑ **Policy modes.** Default: fail-open; if Jev is off or fails, results are returned with `screening.status` = `off` or `unavailable`; `suspect` items are delivered, marked. Strict (per-server switch): the search fails with a clear error when screening is unconfigured, over budget, timed out, invalid, partial, or the provider cannot be screened; `suspect` items are withheld. *Tests:* every strict failure; default never blocks. | S | B.1 |
| B.3 | ☑ **Cap-gateway integration.** The `search` handler calls B.1 for Tavily. Gemini-grounded results are not screened (D3): `screening.status = "not_applicable"`, display contract untouched; in strict mode a Gemini search route is refused, and AI settings warns when strict mode and a Gemini search route are both on. `sandbox/std.ts` `search()` returns the new fields. *Tests:* gateway tests for both providers in both modes; sandbox std test. | M | B.2 |

## C · File tagging and ranking — `feat/jev-file-tags`

| ID | Work package | Size | Depends |
|---|---|---|---|
| C.1 | ☑ **Tag vocabulary.** Migration: `file_tag_definitions` (server, name, instructions, yes/no criteria, revision, enabled; ≤ 255 per server) with a default set seeded per server; RLS and grants; `cleanDatabase` updated. Routes with JSON Schema, server-admin only, audited. Settings page to add, edit, disable and remove tags and write their criteria. Editing criteria bumps the tag's revision. *Tests:* real-Postgres CRUD, cross-server denial, cap, revision bump; `vite build`. | M | J0.3 |
| C.2 | ☑ **Text extraction and chunking** (`src/lib/text-extract.ts`). txt, md, csv, json directly; PDF through an extractor library (choice and licence checked in this package); everything else returns `unsupported`, including images, behind an interface where a description step can be added later (D11). Limits on bytes, pages and chunks; a file beyond them is tagged on what was read and marked `partial`. Chunks sized for Jev's 32k state limit. *Tests:* each type, corrupt PDF, oversized file, limits. | L | — |
| C.3 | ☑ **Tag storage and durable queue.** Migration: `file_tags` (file, tag, tag revision, probability, model, question version) and `file_tag_jobs` (file, state `pending` / `running` / `done` / `skipped` / `failed`, attempts, coverage, error). A worker beside `file-cleanup` decrypts in memory, extracts, asks one noul per enabled tag per chunk plus one injection noul, merges by max probability, writes results. **Claiming:** a short transaction with `FOR UPDATE SKIP LOCKED` sets a lease and a claim generation; expired leases are reclaimed (bounded); a worker may only write results if its generation is still current, so a late worker cannot overwrite a reclaimed job. **Job identity** is unique on file + vocabulary revision + question version + resolved model (the model the provider reports, not the `jev-latest` alias). **Concurrency** per server is enforced in the database, across worker processes. **Before storing results** the worker re-checks that the file still exists and is not expired, the tag revisions are current, and tagging is still switched on. **Retries:** 429 / 529 and timeouts retry with a cap; 401 / 422 fail the job at once; out of budget or route disabled leaves the job pending. **Switched off:** pending jobs pause, in-flight results are not published, and no jobs are created for servers with tagging off (the sweep creates them when it is switched on). **Sweep:** files with a blob and no job, and files whose results are stale (old tag revision or question version). *Tests:* restart mid-job; lease expiry and a late worker; duplicate claim; file deleted or expired during the job; blob missing, decrypt or extractor failure; tag disabled or removed, server deleted; revision change during the job; budget exhausted; route or provider disabled mid-job; transient vs permanent provider errors; retries used up; provider succeeded but the write failed; crash after the result commit; switched off mid-job. | L | J0.4, J0.5, C.1, C.2 |
| C.4 | ☑ **`storeFile()` integration.** A job is enqueued only after the blob is written, on the pool, never on a request-scoped client. Covers both callers (API upload and cap-gateway artifacts). An upload never waits on Jev and never fails because of it: if the enqueue itself fails after the blob is stored, the upload still succeeds and the sweep picks the file up. Deleting a file removes its tags and job. *Tests:* upload with Jev off, on, and failing; no job when the blob write fails; enqueue failure after a stored blob. | S | C.3 |
| C.5 | ☑ **Re-tag and backfill.** Command and admin action: tag all untagged files; re-tag for one tag after its criteria changed (replaces that tag's old results). Stale results (older tag revision) are marked as such when read. Bounded by the per-use budget share. | S | C.3 |
| C.6 | ☑ **Tags in the UI.** Tags (above a display threshold), tagging state and an injection warning shown on a file; filter by tag in the channel's file list. | M | C.3 |
| C.7 | ☑ **File search and ranking.** `GET /channels/:id/files/search?q=` (existing `/channels` prefix, so no nginx change). Order of work in the handler: (1) membership, ViewChannel, bot channel access, not deleted, not expired; (2) shortlist from file names and tags, where tags raise a file's rank and their absence never removes it (D9); (3) if file ranking is switched on, Jev scores the top N against the query, reading each candidate in memory, bounded by count, bytes and deadline; nothing decrypted is stored (D10); (4) access re-checked before returning. **The response is metadata only** (file ID, name, tags, score, tagging state), never file text. **Untrusted file text:** a file whose stored injection probability is at or above the flag threshold is not sent to Jev at query time; it keeps its coarse rank and is returned with `injectionWarning`. Files that are untagged, partially read or pending are returned with that state and ranked on what is known. The score only orders results; it grants nothing. `ranking.status` says what happened: `ranked`, or `coarse` with a reason (off, over budget, timeout, invalid response, provider failure), in which case the shortlist is returned as is. *Tests (real Postgres):* cross-channel and cross-server denial with zero decrypts and zero Jev calls; pending, failed and untagged files still found; flagged file not sent to Jev; every fallback reason; limits. | L | C.3, C.4 |
| C.8 | ☑ **Agent access.** (a) `file_search` tool in `agora-mcp`, calling the C.7 route (README, version bump). (b) For sandboxed code: a new cap-gateway operation `POST /v1/files/search`, like `/v1/reports` (not a capability, so it does not depend on the deferred `decide` handler). JSON Schema on the body; run-token authentication; limited to the run's own channel and to what the submitting bot may see; counts against the run's capability-call cap; Jev usage recorded as `file_ranking` with the run ID. `searchFiles()` in `sandbox/std.ts` calls it. Both share the C.7 search function. *Tests:* MCP tool; gateway schema, another channel refused, call cap, usage row; sandbox std test. | M | C.7 |

## D · Docs, release, live checks

| ID | Work package | Size | Depends |
|---|---|---|---|
| D.1 | ☑ `docs/api-reference.md` (new endpoints and fields), `docs/backend-architecture.md` (decide service, screening, tagging worker), `docs/getting-started.md` (how to turn Jev on), `agora-mcp/README.md`. | S | each phase |
| D.2 | ☑ `docs/storage-and-encryption.md`: tags are plain text in Postgres; file text is sent to the decision provider when tagging is on, and again when ranking is on; what strict mode does and does not protect against. | XS | C.3, C.7 |
| D.3 | ◐ Done on a dev instance, not on gVisor, and not with a real Tavily search (see Status). Live checks on the WSL + gVisor stack with a real key, one per use: an assistant mention routed; a Tavily search with a planted injection screened from a sandboxed run and from the assistant; a file tagged, re-tagged after a criteria edit, and found by search. Results written to `HANDOFF.md`. | S | A, B, C |
| D.4 | ☑ `CHANGELOG.md`, `wbs.md` (2.2 / 2.3 point here), `HANDOFF.md`. | XS | each phase |

## Backlog (not in this WBS's first release)

- `decide` for sandboxed code through the cap-gateway (it stays at 501 until then).
- `JevDecider` on the code-run gate (`src/runtime/decider.ts`), and Eryk's Bot settings switch "Use a System One model for decisions? (Beta, Jev only)".
- Token-use decisions for #39.
- `WebhookDecider` and its contract.
- A.4 participant suggestion.
- Image and video handlers as assistant intents.
- Image tagging through a description step.

## Risks

| Risk | Handling |
|---|---|
| Jev does not treat `state` as hostile, so an injection could try to steer the screening itself | One narrow question per item; thresholds in code; fixtures with adversarial inputs (J0.5); documented as advisory (D8) |
| Thresholds from TypeSafe's cookbooks were tuned on their data | Per-server settings with defaults; fixture harness; adjust after D.3 |
| Tagging becomes a cost sink (large files, many tags, backfills) | Per-use budget allocation (J0.4), extraction limits (C.2), per-server worker concurrency (C.3) |
| File text leaves the instance when tagging or ranking is on | Both off by default, separate switches; stated in settings and in D.2 |
| Budget checks can overshoot under concurrency | Documented as a soft limit; per-use allocations keep one use from starving another (J0.4) |
| PDF extraction adds a dependency that parses untrusted files | Limits on pages and bytes; runs in the worker, not in a request; library chosen in C.2 |
| The `suspect` band has no human review flow | Delivered marked in default mode, withheld in strict mode (B.2) |

## Open questions

Settled during implementation:
- PDF extractor: `unpdf` 1.8.1 (MIT), run in a worker thread. Limits: 20 MB, 50 pages, 192,000 characters, 20 s.
- Search screening stays off until switched on.

Answered by Eryk on 2026-10-01, and built:
- Agents can read a file they found: yes (`file_read`).
- The default tag set stays: `protocol`, `specification`, `plan`, `test report`, `meeting notes`, `data`, `code`, `reference`.
- `agora-mcp` stays at `0.4.0`.
- The assistant does both after a search: the card, then its own written answer (Tavily only; see "Decisions taken during implementation").

Still open:
- Whether the extra chat call per Tavily search should be switchable. It always runs today when a chat route is usable.
