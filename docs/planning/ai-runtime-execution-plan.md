# Execution Plan — Threads, Provider Registry, Decision Seam, Sandboxed Runtime

> **Status:** draft for review. Supersedes the phasing in `ai-runtime-and-gemini-brief.md`; that brief remains the source for *why*.
> **Date:** 2026-09-29

## Principles (settled)

1. **Provider-agnostic.** No provider is special. Providers are rows in a table; adapters are small code modules; capabilities route to providers by config.
2. **Agora is the substrate, not the orchestrator.** Agora holds state (channels, threads, messages), moves messages, and **enforces hard limits**. Orchestration (whose turn, is it done, spawn/route) lives in the `agora-collab` skill today and in an optional external orchestrator (e.g. one using Jev) later.
3. **Works barebones.** With no orchestrator and no Jev, users get the skill + MCP guiding agents, plus safe server-side defaults. Every smart layer is optional and pluggable.
4. **Enforcement lives in Agora; judgment can live outside.** Anything that must hold even against a misbehaving agent (sandbox, permissions, budgets, tripwires, the code-execution gate) is enforced server-side. External layers may *inform* those decisions via a hook, never bypass them.

## Correction to the Jev handoff doc

The handoff's model is right: Jev is a typed-decision classifier called by an orchestrator, not an orchestrator, and never on the message path. Two conclusions don't hold against the code:

- **"Agora needs zero changes to be Jev-ready" — false today.**
  - The MCP server has **no thread support** (`chat_send/read/wait/history` are channel-only). An orchestrator can't read or act on thread state.
  - There is **no way to pause/halt a bot** — the orchestrator's "halt" action has nothing to call.
  - Collab gate signals (consensus/done) exist only as free-text conventions in the skill; nothing structured for an orchestrator or the UI to read.
  - The code-execution gate doesn't exist yet.
- **The exec risk gate cannot live only in an external orchestrator.** An agent can call `runtime_exec` directly; if the only gate is outside Agora, a misbehaving agent simply skips it. Agora must *call out* to a decider before running code (see Phase 2), with a safe default when no decider is configured.

(Also: the handoff's "grounding fields" note belongs to Gemini, not Jev.)

## Decision seam — one interface, three implementations

```ts
interface Decider {
  decide(q: DecisionRequest): Promise<Decision>;   // typed answer + confidence + source
}
```

| Implementation | When | Notes |
|---|---|---|
| `RulesDecider` (default) | always available | deterministic; no model; safe defaults |
| `WebhookDecider` | admin configures an orchestrator URL | Agora POSTs the decision request; timeout ⇒ fall back to rules. This is how an external Jev-based orchestrator plugs in. |
| `JevDecider` (optional adapter) | admin adds a `typesafe` provider | direct call for users without an orchestrator; same fallback |

Decision call sites Agora owns (enforced): **exec gate**, **tripwire escalation**. Call sites the skill/orchestrator owns (advisory): **turn, consensus, completion, routing**.

### Default router (no Jev)

| Decision | Default behavior |
|---|---|
| Capability routing | Explicit: std-lib/assistant names the capability → lookup in `ai_capability_routes`. No intent inference. |
| Exec gate | `ExecuteCode` permission + code-size cap + requested capabilities ⊆ server allowlist + budget headroom. Server mode `require_approval` (default) or `auto` for admin-trusted bots. |
| Bad behavior | Tripwires: existing per-channel loop guard + bot rate limit, budget caps, repeated failed runs, sandbox egress-denied events ⇒ **auto-pause bot** + post to thread. |
| Turn / consensus / completion | Skill protocol markers, now recorded as structured events (Phase 0). Server records and displays; doesn't judge. |

---

## Phase 0 — Agent threads + orchestration primitives (S–M) · *start here*

Backend already supports threads (`POST/GET /channels/:id/messages/:msgId/replies`, `GET /channels/:id/threads`, `PATCH .../thread` close/reopen; bots pass the membership check; loop guard applies). Gap is entirely in the agent-facing layer.

- **0.1 MCP thread support** (`agora-mcp/src/tools.ts`, `api.ts`, `cursor.ts`)
  - `thread` param on `chat_send`, `chat_read`, `chat_wait`, `chat_history`
  - per-thread read cursors (key cursors by `channel:thread`)
  - new tools: `thread_create` (post parent + open), `thread_list`, `thread_close`
- **0.2 Assistant is thread-aware** (`app.ts` mention dispatch, `internal-bus.ts`, `assistant-handler.ts`)
  - carry `threadId` in `AssistantMentionEvent`
  - context query scoped to the thread (parent + replies) or to top-level only (currently mixes both)
  - reply into the thread; update parent `reply_count`/`last_reply_at` + emit `ThreadMetadataUpdate`
- **0.3 Structured protocol events**
  - `message.meta` JSONB (or extend `system_event`) for collab markers: `turn`, `consensus`, `done`, `blocked`
  - MCP: optional `signal` param on `chat_send`; surfaced in `chat_read` output
  - UI: render markers as badges in the thread view
- **0.4 Bot pause/resume**
  - `bots.paused_at` + `PATCH /servers/:id/bots/:botId/pause` (admin or orchestrator bot with a new `ManageBots`-scoped permission)
  - paused bots rejected at send/reply with a clear error; MCP surfaces it
- **0.5 `agora-collab` skill update** (all four copies: `.claude`, `.codex`, `.gemini`, `.opencode`)
  - one thread per collaboration session; markers via `signal`; respect pause
- **Tests:** MCP unit tests for thread cursors; integration tests for thread-scoped assistant context, meta markers, pause enforcement.
- **Done when:** two agents run an `agora-plan` session entirely inside a thread with structured done/consensus markers visible in the UI, and an admin can pause one mid-session.

## Phase 1 — Provider registry (M)

- **1.1 Schema (migration `022`)**
  - `ai_providers (id, server_id, adapter, label, base_url, key_enc/iv/tag, enabled, created_at)` — N rows per server, duplicates of an adapter allowed
  - `ai_capability_routes (server_id, capability, provider_id, model, enabled, PK(server_id, capability))`
  - `ai_provider_config` → assistant config referencing `provider_id`; migrate existing rows; drop the `provider` CHECK
  - `ai_usage_events`: `channel_id`/`message_id` nullable; add `kind`, `provider_id`, `cost_micros`, `run_id`
  - RLS + grants to `app_user`
- **1.2 Adapter registry** — `src/ai/adapters/{anthropic,openai-compatible,gemini,typesafe}.ts`, each declaring capabilities (`chat | search | image | tts | video | decide`) and implementing `testConnection`. Replace the Claude-else-OpenAI fallthrough with a registry lookup.
  - `openai-compatible` + `base_url` covers OpenAI, Ollama (local 5070 Ti), OpenRouter, Groq, vLLM
  - Verify Gemini model IDs / SSE format / auth header against live docs before coding
- **1.3 Routes + UI** — CRUD for providers and capability routes under `/servers/:id/ai/...` (existing prefix; no nginx change). Admin UI: provider list, add/test, capability routing table.
- **1.4 Budgets** — per-server capability toggles (all non-chat **off by default**), daily spend cap per server and per bot, enforced before any provider call.
- **Done when:** a server has Claude for chat + Gemini configured with `search` routed to it; assistant chats through any configured chat provider; existing configs migrated losslessly.

## Phase 2 — Sandboxed runtime (spec M → build L)

### 2a · Isolation spec (`docs/planning/sandbox-isolation-spec.md`, sign-off before build)
- **Topology:** new `runner` service is the *only* component with Docker socket access; `api` never gets it. `runner` consumes BullMQ jobs (Redis already present), exposes nothing.
- **Per run:** fresh container on gVisor (`--runtime=runsc`, installed on the prod Docker host); read-only rootfs, tmpfs `/scratch/<run-id>`, non-root, `cap-drop=ALL`, seccomp, pids/CPU/mem limits, wall-clock timeout, output-size cap. Dev (Docker Desktop/Windows) runs `runc` with a loud warning.
- **Egress:** sandbox on an internal network that reaches only the capability endpoint; Deno `--allow-net=<that host>` as the second layer.
- **No secrets in the sandbox:** std-lib calls a capability endpoint with a short-lived per-run token; Agora holds provider keys and enforces caps.
- **Threat model** with a test per threat: escape, exhaustion, exfiltration, secret leakage, cross-run access.

### 2b · Build
- `ExecuteCode` permission bit
- `POST /runtime/runs`, `GET /runtime/runs/:id` + MCP `runtime_exec` — new `/runtime` prefix ⇒ update `agora-ui/nginx.conf` **and** `docker-compose.prod.yml` (runner service, network)
- **Exec gate** via `Decider` before enqueue; `needs_approval` posts an Approve/Deny control into the originating thread; comments stripped before any model-based classification; code over the classifier's token limit ⇒ `needs_approval`; an `auto_run` verdict never relaxes sandbox limits
- `exec_runs` audit table (who, code hash, gate decision + source, limits, exit, artifacts, duration)
- Std-lib `agora:std` starting with `postFile()`; artifacts → `file-validation` → MinIO → posted into the thread (admin file limits apply)
- Capability endpoint + per-run tokens + per-run call caps + cost ledger
- Tripwire: egress-denied / repeated failures ⇒ auto-pause bot (Phase 0.4)
- **Negative security suite** (reach DB/Redis/MinIO, read other scratch, read env, fork bomb, infinite loop) — all must fail

## Phase 3 — First value (M each)
- **Visual test report (MVP):** results payload → routed `image`/`chat` capability → chart + HTML card → posted to thread.
- **Grounded `search()`:** routed `search` capability; citations surfaced per provider terms (verify Google grounding attribution requirements).

## Phase 4 — Media (M/L)
- Audio overview (script → multi-speaker TTS) → images → video (deferred).

## Parallel / optional
- `WebhookDecider` contract doc (request/response schema, timeout, fallback) — can be written during Phase 1.
- `JevDecider` adapter — only after Phase 1 registry; access currently via early access or Vercel AI Gateway (`typesafe-ai/jev`).

## Open items to verify
1. Gemini API surface (model IDs, streaming, grounding citation fields, TTS/image/Veo availability) — before Phase 1.2 / 3.
2. gVisor on the prod host (kernel/distro compatibility) — during 2a.
3. Jev API specifics (closed early access) — before `JevDecider`.
4. Whether collab markers belong in `message.meta` JSONB vs a dedicated table — decide in 0.3.

## Housekeeping
- Stray directory at repo root: `C:Usersmistelife-managerGit_Projectsagoratestunit` (mangled path from an earlier command) — confirm and remove.
