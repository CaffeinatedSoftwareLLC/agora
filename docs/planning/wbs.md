# Work Breakdown Structure — AI Runtime Initiative

> Companion to `ai-runtime-execution-plan.md` (the *what/why*). This file is the *how/in what order*.
> Branch for Phase 0: `feat/agent-threads`. Each phase gets its own branch + PR.
> Sizes: **XS** <1h · **S** ≈ half-day · **M** ≈ 1–2 days · **L** ≈ 3–5 days.
> Status: ☐ todo · ◐ in progress · ☑ done · → moved out of this WBS

## Status at 0.2.0 (reviewed 2026-10-01)

Everything below marked ☑ is on `main` and running on the WSL stack. Reviewed against the code, the merged PRs (#24–#44) and the live instance.

| Phase | State |
|---|---|
| 0 Agent threads & orchestration | ☑ complete |
| 1 Provider registry | ☑ complete |
| 2 Decision seam | 2.1 ☑ (rules decider, in use). 2.2 and 2.3 → **moved to the separate Jev project** |
| 3 Sandboxed runtime | ☑ except **3.9** (negative suite on gVisor), the one open package of the original plan |
| 4 First value | ☑ complete. `testReport` has not had a live check |
| 5 Media | ☑ complete. Follow-ups are GitHub issues (#40, #35) |
| 6 Platform | 6.1–6.5 ☑. Open: 6.6, 6.7, 6.8, 6.9 |

**Carried past 0.2.0:** 3.9, 6.6–6.9, the `testReport` live check, and the open GitHub issues (#39, #40, #35, #23, #22, and the older UI issues #9–#18).

## Definition of Done (every work package)
- Backend: `npm run build` clean for `src/`; `npx vitest run test/integration` green
- MCP: `cd agora-mcp && npm run build && npm test` green
- UI touched: `cd agora-ui && npx vite build` + `npm run lint` clean
- New top-level route prefix ⇒ `agora-ui/nginx.conf` regex + `docker-compose.prod.yml` updated
- New env var ⇒ `.env.example`, `.env.prod.example`, `docker-compose.prod.yml`
- Migrations: new numbered SQL file, RLS/grants for `app_user`, test cleanup covers new tables (`cleanDatabase`)
- Docs: `docs/api-reference.md` for new endpoints; `agora-mcp/README.md` for new tools

---

## 0 · Agent Threads & Orchestration Primitives — `feat/agent-threads`

Backend thread endpoints exist and admit bots. Gaps found in code review:
- MCP tools are channel-only; `formatMessages` doesn't print message IDs, so agents can't even address a thread parent.
- Channel message list is top-level only (`thread_id IS NULL`) ⇒ agents currently **never see thread replies**.
- Server-side read cursors are keyed `(bot_id, channel_id)`; no thread cursors.
- Assistant mention events carry no `threadId`; context query mixes channel + thread replies; replies land top-level.
- Loop guard is per-channel (`loopguard:{channelId}`), shared by all threads in a channel — two agents collaborating in a thread will trip it after `max_bot_hops` (default 4) consecutive bot messages.
- No bot pause mechanism.

### 0.1 MCP thread support ☑
| ID | Task | Size | Depends |
|---|---|---|---|
| 0.1.1 | Migration `022_bot_thread_cursors.sql`: `bot_thread_cursors (bot_id, thread_id → messages, channel_id, last_read_id, updated_at, PK(bot_id, thread_id))` + grants | XS | — |
| 0.1.2 | Routes `GET /bots/@me/thread-cursors`, `PUT /bots/@me/thread-cursors/:threadId` + bot route allowlist (also opens `PATCH .../thread` close/reopen to bots) (bot-only; verifies parent is a top-level message in a channel the bot can access). New endpoints rather than changing `/bots/@me/cursors` shape, so published `agora-mcp@0.1.x` keeps working | S | 0.1.1 |
| 0.1.3 | Add `bot_thread_cursors` to `cleanDatabase` truncate list | XS | 0.1.1 |
| 0.1.4 | Integration tests: thread cursor CRUD, access denied for non-access channel, human token rejected, reply-to-a-reply rejected as cursor target | S | 0.1.2 |
| 0.1.5 | `agora-mcp/src/api.ts`: `Message` gains `threadId`, `replyCount`, `lastReplyAt`, `threadClosedAt`; methods `getReplies`, `sendReply`, `listThreads`, `setThreadClosed`, `getThreadCursors`, `updateThreadCursor` | S | 0.1.2 |
| 0.1.6 | `cursor.ts`: thread cursor map, lazy load, `getThreadCursor`, `ackThread` (monotonic like `ack`) | XS | 0.1.5 |
| 0.1.7 | `tools.ts`: `fetchUnreadReplies` (ascending via `after`, bounded scan); `formatMessages` prints IDs + `[thread: N replies]` / `[closed]` annotations | S | 0.1.6 |
| 0.1.8 | Tool changes: `thread` param on `chat_send`, `chat_read`, `chat_wait`, `chat_history`; new `thread_start`, `thread_list`, `thread_close` (with `reopen`) | S | 0.1.7 |
| 0.1.9 | MCP unit tests (thread cursors, unread replies, formatting) + extend `agora-mcp.integration.test.ts` for a real thread round-trip | S | 0.1.8 |
| 0.1.10 | Docs: `agora-mcp/README.md` tools table, `docs/api-reference.md` thread-cursor endpoints; bump `agora-mcp` version (minor) | XS | 0.1.8 |

### 0.2 Thread-aware built-in assistant ☑
| ID | Task | Size | Depends |
|---|---|---|---|
| 0.2.1 | `MessageMention` payload gains `threadId` (threads.ts reply path); `AssistantMentionEvent.threadId` in `internal-bus.ts`; pass through in `app.ts` dispatch | XS | — |
| 0.2.2 | `assistant-handler.ts`: context = parent + thread replies when `threadId`, else top-level only (`thread_id IS NULL`) | S | 0.2.1 |
| 0.2.3 | Placeholder/final message inserted with `thread_id`; bump parent `reply_count`/`last_reply_at`; emit `ThreadMetadataUpdate`; reject if thread closed (post nothing); `BotMessageStream` carries `threadId` and the UI thread store applies it | S | 0.2.1 |
| 0.2.4 | Integration tests in `ai-assistant.integration.test.ts` / `ai-streaming...`: mention in thread ⇒ reply in thread with thread-only context | S | 0.2.3 |

### 0.3 Structured collab signals ☑
Agents already emit `[AGORA/v1 MODE=<m> STATE=<s>]` and `[YIELD to=<agent>]` per the skill contract — parse, don't add a new param.
| ID | Task | Size | Depends |
|---|---|---|---|
| 0.3.1 | Decide storage: `messages.protocol JSONB` (mode, state, yieldTo) vs side table — default JSONB, nullable | XS | — |
| 0.3.2 | Migration `024_message_protocol.sql` (023 went to the thread loop guard) | XS | 0.3.1 |
| 0.3.3 | `src/lib/protocol.ts` parser (strict: only well-formed header at message start; YIELD at end) + unit tests | S | — |
| 0.3.4 | Populate on insert in `messages.ts` + `threads.ts`; include `protocol` in message payloads and WS events | S | 0.3.2, 0.3.3 |
| 0.3.5 | ~~MCP `formatMessages` shows parsed state~~ — dropped: agents already see the header verbatim in content | XS | 0.3.4 |
| 0.3.6 | UI: `ProtocolBadge` on messages (state, decision, → yieldTo; mode/participants on hover); session chip in thread panel header = latest state in the thread | M | 0.3.4 |

### 0.4 Bot pause/resume + loop-guard scope ☑
| ID | Task | Size | Depends |
|---|---|---|---|
| 0.4.1 | Migration `025_bot_pause.sql`: `users.bot_paused_at`, `bot_paused_reason` | XS | — |
| 0.4.2 | `PATCH /servers/:serverId/bots/:id/pause { paused, reason? }` — ManageBots/Administrator (existing bit); audit `bot_pause`/`bot_resume` | S | 0.4.1 |
| 0.4.3 | Enforced centrally in bot auth: paused ⇒ 423 on every non-GET except read-cursor PUTs; `/bots/@me` + bot list expose pause; MCP turns 423 into a plain "you are paused, stop" error and `channel_list` shows it | S | 0.4.1 |
| 0.4.4 | ☑ Per-thread loop guard: `loopguard:{channelId}:{threadId}`, `channels.max_thread_bot_hops` (default **0 = off**, per user), settable via `PATCH /channels/:id/bot-config`; channel guard no longer counts thread replies | S | — |
| 0.4.5 | UI: Pause/Resume button + PAUSED badge in Bot Management (message/member-list indicator deferred) | S | 0.4.2 |
| 0.4.6 | Integration tests: pause enforcement, permission checks, per-thread loop guard | S | 0.4.3, 0.4.4 |

### 0.5 `agora-collab` skill update ☑
| ID | Task | Size | Depends |
|---|---|---|---|
| 0.5.1 | Initiator: `thread_start` with START as parent; all protocol messages as thread replies; peers discover session via `chat_read` top-level (START visible) and follow its thread ID | S | 0.1 |
| 0.5.2 | `DONE` ⇒ initiator calls `thread_close`; paused ⇒ stop loop and report | XS | 0.1, 0.4 |
| 0.5.3 | Update `allowed-tools`, tool table, `references/protocol.md`; sync all four copies (`.claude`, `.codex`, `.gemini`, `.opencode`) + shorthand skills | S | 0.5.1 |
| 0.5.4 | ☑ E2E: two bots ran a full plan session (START→ACK→TURN×2→CHECKPOINT→DECIDE×2→DONE→close) through the real agora-mcp tool handlers against the branch API; pause/resume and UI badges verified in the browser | S | all of 0 |

**Phase 0 exit:** 0.5.4 passes ☑; PR open for review.

---

## 1 · Provider Registry — `feat/provider-registry`

**Design decisions (2026-09-29)**
- **Adapters are code, providers are rows.** `src/ai/adapters/{anthropic,openai,gemini}.ts` implement one interface and declare capabilities. `openai` takes an optional `base_url`, which covers OpenAI, Ollama, OpenRouter, Groq and vLLM.
- **Gemini** uses `models/{model}:streamGenerateContent?alt=sse` (Google: "legacy, fully supported"; documented schema, stateless). The newer Interactions API is recommended for new projects but its streaming schema isn't documented yet, and it keeps server-side state we don't want. Swap later inside the adapter only. Default model `gemini-3.8-flash` (stable as of 2026-09-29).
- **The assistant uses the `chat` capability route.** `ai_provider_config` keeps assistant-only settings (bot, prompt, context, enabled). Its provider/model/key columns become nullable legacy fields, migrated into `ai_providers` + a `chat` route.
- **`/ai-config` stays working.** PUT upserts a provider plus the chat route, so existing clients and the current UI keep working until the new settings UI replaces it.
- **SSRF guard on `base_url`:** http/https only. Private, loopback and link-local targets are rejected unless the instance setting `ai_allow_private_base_urls` is on (needed for local Ollama). Checked on save and again before each call.
- **Budgets per capability route:** optional daily request/token limits, plus optional admin-entered prices that turn into `cost_micros` and a daily cost limit. Non-chat routes start disabled. Per-bot caps wait for Phase 3, when bots actually call capabilities.
| ID | Work package | Size | Depends |
|---|---|---|---|
| 1.1 | ☑ Migration: `ai_providers`, `ai_capability_routes`; `ai_provider_config.provider_id`; data migration of existing rows; drop provider CHECK; `ai_usage_events` nullable channel/message + `kind`, `provider_id`, `cost_micros`, `run_id`; grants | M | — |
| 1.2 | ☑ Adapter interface + registry (`src/ai/adapters/`), capabilities enum, exhaustive dispatch | S | — |
| 1.3 | ☑ Adapters: `anthropic` (port), `openai-compatible` (port + `base_url`: OpenAI/Ollama/OpenRouter/Groq/vLLM), `gemini` (verify API first) | M | 1.2 |
| 1.4 | ☑ Routes: providers CRUD + test, capability routes CRUD, under `/servers/:id/ai/...`; assistant config references provider | M | 1.1, 1.2 |
| 1.5 | ☑ Budgets: capability toggles (non-chat off by default), daily caps per server/bot, pre-call enforcement, usage ledger writes | M | 1.1 |
| 1.6 | ☑ UI: provider list/add/test, capability routing table, usage + spend view | M | 1.4, 1.5 |
| 1.7 | ☑ Tests: migration of legacy config, CRUD authz, routing resolution, budget enforcement, adapter SSE parsing fixtures | M | 1.3–1.5 |

## 2 · Decision Seam — folds into Phase 1/3 branches

> **2.2 and 2.3 are no longer part of this WBS (2026-10-01).** The Jev decision layer is its own project. Its WBS will be written and worked by agents in Agora. Nothing here blocks on it: the rules decider (2.1) is the gate in use, and the `decide` capability stays at 501 until that project lands.

| ID | Work package | Size | Depends |
|---|---|---|---|
| 2.1 | ☑ `Decider` interface + `RulesDecider` done in 3.6 (exec gate); tripwires (3.8) pause the bot, which the decider already denies | S | 0.4 |
| 2.2 | → `WebhookDecider` + contract doc (schema, auth/HMAC, timeout ⇒ rules fallback). Moved to the Jev project | S | 2.1 |
| 2.3 | → `JevDecider` adapter (`typesafe`, `decide` capability). Moved to the Jev project. Starting notes for it: Eryk wants a toggle in Bot settings, "Use a System One model for decisions? (Beta, Jev only)", with the API key entered there; a second use for the decision handler is sketched in a comment on #39 | S | 1.3, 2.1 |

## 3 · Sandboxed Runtime — `feat/runtime`
| ID | Work package | Size | Depends |
|---|---|---|---|
| 3.1 | ☑ **Isolation spec** + threat model: `sandbox-isolation-spec.md`, approved 2026-09-29 (bots-only submission, per-bot auto-approve, time profiles, 30-day code retention) | M | — |
| 3.2 | ☑ `runner` (BullMQ `runtime` queue, atomic claim with gate re-check + per-server concurrency, runner-minted run tokens, reconcile + orphan cleanup), hardened container template, name-restricted socket proxy (dev compose profile `sandbox`), base sandbox image (Deno 2.9.7 distroless), `exec_runs`/`exec_run_tokens`. Prod compose wiring deferred to 3.5 | L | 3.1 |
| 3.3 | ☑ `agora:std` (`call`, `chat`, `search`, `generateImage`, `tts`, `decide`, `postFile`, `postMessage`, `AgoraError`) via import map + global `agora`; bearer run token; tested against a production-shaped fake gateway (dual-homed forwarder) | M | 3.1 |
| 3.4 | ☑ `cap-gateway` service (`npm run cap-gateway`): run-token auth, declared-capability check, atomic per-run call + artifact caps, route budgets, `chat` handler (others 501 until Phase 4), messages + files into the run's thread via shared `storeFile()`, Redis event bridge with allowlist. E2E sandbox → gateway → provider verified | M | 1.5 |
| 3.5 | ☑ Per-bot **runtime access** (none / approval / auto) instead of a role bit; `/runtime/runs` API (submit, status, code download, approve/deny); MCP `runtime_exec` + `runtime_status` (agora-mcp 0.3.0); `/runtime` in nginx; prod compose (sandbox-image, socket-proxy, runner, cap-gateway, internal `agora_sandbox` network) | M | 3.2 |
| 3.6 | ☑ `Decider` + `RulesDecider`; approval card in the thread (View code / Approve / Deny, 30-min expiry, audit); result summary card; code retention (30 days, confirm before shortening, pruning sweep). Verified live: bot → approval in UI → sandbox → gateway → local Ollama → file + result in thread | M | 2.1, 3.5, 0.1 |
| 3.7 | ~~Artifact harvest~~ folded into 3.4: artifacts leave only through the gateway (`postFile`), no container harvest (spec D5) | — | — |
| 3.8 | ☑ Tripwires ⇒ auto-pause (`src/runtime/tripwires.ts`, spec §12): 3 failed/timed-out runs in 10 min (count resets on resume), a real run token used outside its run, a run hitting its call cap. Pausing posts a notice card in the thread, audits `bot_pause_tripwire`, kills the bot's running containers (runner polls), and denies its queued runs at claim. "Egress denied" dropped: the internal network drops egress, so nothing observes it | S | 0.4, 3.2 |
| 3.9 | ☐ Negative security suite (spec §14, 15 items). **Partly covered, never run on gVisor.** `test/sandbox/runner.sandbox.test.ts` already probes internet, public DNS, `postgres`, subprocesses, writes outside scratch, remote imports, the infinite loop, memory exhaustion, output truncation, the unapproved-run refusal and the no-gVisor refusal, but only under `runc` on Docker Desktop. Still to write: `redis` / `api` reach and no mount of `files-data`, the env allowlist, `/proc/1/environ` and the Docker socket, the 64 MB scratch cap, cross-run token use from inside a sandbox. Then run the whole suite with `SANDBOX_TEST_RUNTIME=runsc` against the WSL2 engine | M | 3.2–3.4 |

## 4 · First Value — `feat/visual-reports`, `feat/search`
| ID | Work package | Size | Depends |
|---|---|---|---|
| 4.1 | ☑ Visual test report (MVP): `agora:std` `testReport()` parses JUnit XML / Vitest-Jest JSON / Agora's `{totals, suites, failures}` (`sandbox/report.ts`), gets a summary from the routed `chat` capability (computed fallback), and posts through gateway `POST /v1/reports` a bot-authored `runtime_report` card (UI-drawn pass-rate bar, per-suite bars, collapsible failures) plus the full report as Markdown. The card is native UI rather than a generated HTML file because HTML/SVG uploads aren't allowed (T10); charts come from the data, not an image model, so the numbers can't be wrong | M | 3 |
| 4.2 | ☑ `search()`: routed `search` capability. **Gemini** (Google Search grounding via `generateContent` + `tools: [{googleSearch: {}}]`): per Google's terms the gateway posts the answer unmodified with Google's Search Suggestions into the thread (`runtime_search` card, suggestions in a script-less sandboxed iframe) and returns `{answer, citations, displayedIn}` to the run. **Tavily** adapter (agent-oriented terms; route "model" = search depth) returns `{answer, citations}` without posting. See R6 | M | 3, 1.3 |

## 5 · Media
| ID | Work package | Size | Depends |
|---|---|---|---|
| 5.1 | ☑ Audio overview: mentioning the built-in assistant with "audio overview" / "podcast" makes the `chat` route write a two-host script (Alex and Sam) from the whole thread (or recent channel messages), the `tts` route voice it with two speakers, and posts an MP3 plus transcript as the assistant's reply, with progress in the placeholder. WAV → MP3 via `@breezystack/lamejs` (LGPL-3.0, pure JS) because `mp3` is allowed by default and `wav` isn't, and MP3 is ~6× smaller. Audio attachments get an inline player. Multi-speaker speech goes through `synthesizeDialogue` (`src/ai/speech.ts`): Gemini gets one text part per line tagged with `speechMetadata.speaker` (#33); adapters without native multi-speaker voice each line and the WAVs are joined | M | 3 |
| 5.2 | ☑ `image` capability (Gemini native image via `responseModalities: [TEXT, IMAGE]` + `imageConfig` aspect ratio/size; returns base64 for `postFile`) | S | 3 |
| 5.3 | ☑ `video` capability: Gemini adapter drives Veo (`predictLongRunning` → poll the operation → download; checked against Google's Veo REST example, 2026-09-17). The API key goes only to Google's API host; the storage redirect is followed without it. The gateway reserves an artifact slot before the (billed) call, stores the MP4, and posts it into the run's thread (`generateVideo()` returns IDs, not bytes). New `video` time profile (8 min default, 10 min ceiling; migration 030). MP4 attachments play inline. All Veo 3.1 models are preview; default `veo-3.1-fast-generate-preview`; no cost accounting yet (Veo bills per second, the ledger is per token) | L | 3 |

## 6 · Platform — storage, hardening, audit fixes — PRs #42, #43, #44
| ID | Work package | Size | Depends |
|---|---|---|---|
| 6.1 | ☑ Replace the bundled MinIO with a disk store, S3 optional (#32): `src/lib/storage.ts` (disk driver with atomic writes and root confinement; S3 driver), `files-data` volume shared by `api` and `cap-gateway`, one-time `storage-migrate` tool, a missing blob is a 404 instead of a soft-delete. Works live (2026-10-01). File encryption unchanged: `storeFile()` encrypts before the driver sees the bytes | M | — |
| 6.2 | ☑ Publish the API's plain-HTTP port on `127.0.0.1` only (`API_BIND` to override). Deployed and verified from this machine 2026-10-01: localhost answers, the WSL address refuses. Not checked from a second device | XS | — |
| 6.3 | ☑ Docs for 6.1–6.2 and an encryption audit: `docs/storage-and-encryption.md`, README security section rewritten to match the code | S | 6.1 |
| 6.4 | ☑ Remove IP tracking and IP bans outright (decision 2026-10-01) instead of wiring `IP_ENCRYPTION_KEY` into production: migration `031` drops `ip_bans` and `users.last_ip_*`; the ban routes, the admin UI option, `src/auth/crypto.ts` and the key are gone. Closes audit finding A. Merged (#43) and deployed; migration `031` ran on the live DB | S | — |
| 6.5 | ☑ `NODE_ENV=production` in the runtime image so the startup checks run; an all-zero `AGORA_ENCRYPTION_KEY` and a placeholder `JWT_SECRET` are refused; startup fingerprint check (`src/lib/key-fingerprint.ts`) refuses a changed encryption key, with `AGORA_ACCEPT_NEW_ENCRYPTION_KEY=1` as the explicit override. Closes audit finding B. Merged (#44) and deployed; the live key's fingerprint is recorded | S | — |
| 6.6 | ☐ Make the setup script's domain take effect: write `DOMAIN`, pass it to `caddy` (finding C). Verify on a real domain | S | — |
| 6.7 | ☐ Optional hardening: storage keys without the filename (finding D); run backend containers as non-root (finding E); key rotation tool; bind run tokens to the container IP | M | 6.1 |
| 6.8 | ☑ **Commit the request transaction before the reply is sent.** `src/app.ts` committed in `onResponse`, after the response had gone out, so a client acting on a response at once could arrive before the data was saved; this was the cause of the flaky integration tests. The commit is now in `onSend`; a failed COMMIT becomes `500 commit_failed`; socket events still follow the commit. New `request-lifecycle` tests fail on the old code; full suite 673 of 673, three runs | M | — |
| 6.9 | ☐ **Make nginx re-resolve the API address.** `agora-ui/nginx.conf` resolves `api` once at startup, so a deploy that recreates `api` but not `web` returns 502 until `web` is restarted (seen on the #44 deploy). Use Docker's resolver with a variable upstream | XS | — |

## Risks / open decisions log
| # | Item | Owner | Due |
|---|---|---|---|
| R1 | ☑ Per-thread guard, default off. UI visibility tracked in a GitHub issue | user | 0.4.4 |
| R2 | ☑ `messages.protocol` JSONB vs side table: JSONB, shipped in 0.3 | Claude | 0.3.1 |
| R3 | ☑ Gemini API verified 2026-09-29 (generateContent/streamGenerateContent v1beta; live key-rejection response confirmed endpoint + auth header) | Claude | 1.3 |
| R4 | ◐ gVisor compat on the host kernel: works on WSL2 (kernel 6.6, `runsc` release-20260928.0, verified 2026-09-30). Not tried on a dedicated Linux production host | user/Claude | 3.1 |
| R5 | → Jev API access: moved with 2.2 / 2.3 to the Jev project | user | — |
| R6 | ☑ Google grounding terms (updated 2026-04-28): results only with Search Suggestions, unmodified, to the prompt's submitter; no caching/analysis. Decision 2026-09-30: build both a compliant-display Gemini path and a Tavily adapter. Residual: grounded answers appear in a shared thread and run code still receives them; operators are responsible for derived use (docs/getting-started.md) | user | 4.2 |
