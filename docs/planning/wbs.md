# Work Breakdown Structure — AI Runtime Initiative

> Companion to `ai-runtime-execution-plan.md` (the *what/why*). This file is the *how/in what order*.
> Branch for Phase 0: `feat/agent-threads`. Each phase gets its own branch + PR.
> Sizes: **XS** <1h · **S** ≈ half-day · **M** ≈ 1–2 days · **L** ≈ 3–5 days.
> Status: ☐ todo · ◐ in progress · ☑ done

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
| 1.1 | Migration: `ai_providers`, `ai_capability_routes`; `ai_provider_config.provider_id`; data migration of existing rows; drop provider CHECK; `ai_usage_events` nullable channel/message + `kind`, `provider_id`, `cost_micros`, `run_id`; grants | M | — |
| 1.2 | Adapter interface + registry (`src/ai/adapters/`), capabilities enum, exhaustive dispatch | S | — |
| 1.3 | Adapters: `anthropic` (port), `openai-compatible` (port + `base_url`: OpenAI/Ollama/OpenRouter/Groq/vLLM), `gemini` (verify API first) | M | 1.2 |
| 1.4 | Routes: providers CRUD + test, capability routes CRUD, under `/servers/:id/ai/...`; assistant config references provider | M | 1.1, 1.2 |
| 1.5 | Budgets: capability toggles (non-chat off by default), daily caps per server/bot, pre-call enforcement, usage ledger writes | M | 1.1 |
| 1.6 | UI: provider list/add/test, capability routing table, usage + spend view | M | 1.4, 1.5 |
| 1.7 | Tests: migration of legacy config, CRUD authz, routing resolution, budget enforcement, adapter SSE parsing fixtures | M | 1.3–1.5 |

## 2 · Decision Seam — folds into Phase 1/3 branches
| ID | Work package | Size | Depends |
|---|---|---|---|
| 2.1 | `Decider` interface + `RulesDecider` (exec gate rules, tripwire escalation) | S | 0.4 |
| 2.2 | `WebhookDecider` + contract doc (schema, auth/HMAC, timeout ⇒ rules fallback) | S | 2.1 |
| 2.3 | `JevDecider` adapter (`typesafe`, `decide` capability) — optional, gated on API access | S | 1.3, 2.1 |

## 3 · Sandboxed Runtime — `feat/runtime`
| ID | Work package | Size | Depends |
|---|---|---|---|
| 3.1 | **Isolation spec** + threat model (`sandbox-isolation-spec.md`) — user sign-off gate | M | — |
| 3.2 | `runner` service: BullMQ consumer, Docker socket (sole holder), gVisor launch, limits, scratch tmpfs; compose prod + dev (runc warning) | L | 3.1 |
| 3.3 | Sandbox image: Deno, `agora:std` module, non-root, read-only rootfs | M | 3.1 |
| 3.4 | Capability endpoint + per-run tokens + per-run call caps + cost ledger | M | 1.5 |
| 3.5 | `ExecuteCode` permission; `/runtime/runs` routes; MCP `runtime_exec`; nginx + compose prefix updates | M | 3.2 |
| 3.6 | Exec gate via `Decider`; approval control posted in originating thread; `exec_runs` audit table | M | 2.1, 3.5, 0.1 |
| 3.7 | Artifact harvest → file-validation → MinIO → thread post | S | 3.2 |
| 3.8 | Tripwires ⇒ auto-pause (egress denied, repeated failures) | S | 0.4, 3.2 |
| 3.9 | Negative security suite (DB/Redis/MinIO reach, cross-scratch, env read, fork bomb, infinite loop) | M | 3.2–3.4 |

## 4 · First Value — `feat/visual-reports`, `feat/search`
| ID | Work package | Size | Depends |
|---|---|---|---|
| 4.1 | Visual test report (MVP): payload → routed capability → chart/HTML card → thread | M | 3 |
| 4.2 | `search()`: routed `search` capability, citation rendering per provider terms | M | 3, 1.3 |

## 5 · Media — later
| 5.1 | Audio overview (script → multi-speaker TTS) | M | 3 |
| 5.2 | Image generation | S | 3 |
| 5.3 | Video (deferred) | L | 3 |

## Risks / open decisions log
| # | Item | Owner | Due |
|---|---|---|---|
| R1 | ☑ Per-thread guard, default off. UI visibility tracked in a GitHub issue | user | 0.4.4 |
| R2 | `messages.protocol` JSONB vs side table | Claude (default JSONB) | 0.3.1 |
| R3 | Gemini API surface verification | Claude | 1.3 |
| R4 | gVisor compat on prod host kernel | user/Claude | 3.1 |
| R5 | Jev API access (early access / Vercel AI Gateway) | user | 2.3 |
