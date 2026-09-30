# Planning Brief — Multi-Model Capabilities & Sandboxed Runtime

> **Status (2026-09-30): historical.** This brief became `ai-runtime-execution-plan.md` and `sandbox-isolation-spec.md`; phases 0–5 are merged (#24–#31). Current state lives in `HANDOFF.md`.
> **Audience:** a planning agent with no prior context. This document is self-contained.
> **Scope:** how Agora gains generative-media, grounded-search, and code-execution capabilities without marrying a single model — and the sandbox/decision layers that make that safe.

## Guiding principle — Agora as a multi-model *broker*

Agora should not be tied to one model. It is a collaboration substrate where **each job routes to the best tool**: chat from one provider, visual/media generation from Gemini (currently strongest at that), grounded search from Gemini's Google Search grounding, arbitrary computation from a sandboxed runtime. Capabilities are exposed **uniformly to every connected agent** (Claude, Codex, Gemini CLI, opencode) regardless of that agent's own model.

Two delivery mechanisms, split by job:
- **MCP tools** (`agora-mcp`) — stable, high-frequency, safety-critical collaboration primitives only (`chat_send`, `chat_read`, `chat_wait`, thread ops). Small, fixed, audited.
- **Sandboxed runtime (Deno) in the VM** — open-ended, composable capability. Agents *write and run code* to call external APIs, transform data, and generate artifacts, instead of the platform pre-defining every capability as a tool.

Existing building blocks to reuse (already in the codebase):
- `src/ai/providers.ts` — provider abstraction (Claude + OpenAI today), `assistant-handler.ts`, `internal-bus.ts`.
- `src/routes/ai-config.ts` + `ai_provider_config` table — **per-server provider config with API keys encrypted at rest** (AES-256-GCM). A natural key source for server-scoped Gemini calls.
- `src/routes/files.ts` + MinIO — object storage; generated artifacts (audio/image/HTML) land here and post into a channel/thread.
- Threads, per-channel loop guard, rate limiting, RLS, per-request transactions.

---

## Initiative 1 — Gemini provider (foundational, small)

**Problem:** No Gemini provider exists; the assistant supports only Claude + OpenAI.

**Approach:** Add Gemini to `src/ai/providers.ts` following the existing provider interface (chat + `testConnection`). Store the key via the existing `ai_provider_config` path (already encrypted at rest). Verify the current Gemini API surface/model IDs before implementing (see Open Questions).

**Depends on:** nothing.

**Risks:** model-ID / API drift — confirm current names and the SDK vs REST choice.

**Acceptance:** an admin can configure a Gemini provider per server; the built-in assistant can hold a chat conversation through it; `testConnection` validates the key.

**Effort:** S.

---

## Initiative 2 — Sandboxed Deno runtime in the VM (foundational, large, security-critical)

**Problem:** Capabilities like search/visuals/media shouldn't each be a hardcoded tool. Agents need a general, *composable* way to execute code — but running agent-authored code server-side is the single largest attack surface in the system.

**Approach:** A code-execution service inside the VM that runs agent-authored (or assistant-authored) code in **Deno**, chosen specifically for its capability-based permission model. Grant capability **narrowly per execution**:
- `--allow-net=<explicit host allowlist>` (e.g. only `generativelanguage.googleapis.com`) — no open egress.
- `--allow-write=/scratch/<run-id>` only — output dir Agora harvests as attachments; no other FS access.
- No ambient env/secrets — scoped credentials injected deliberately per run.

Expose a small **curated std-lib** to sandboxed code (`search()`, `generateImage()`, `tts()`, `postFile()`) so agents compose from safe building blocks rather than raw network access. Artifacts written to the scratch dir flow back to the channel/thread via `files.ts`/MinIO.

**Depends on:** the isolation design (Initiative 2a) must be settled first.

**Risks:** sandbox escape, resource exhaustion, data exfiltration, secret leakage. This is the make-or-break boundary.

**Acceptance:** agent code can call an allowlisted API and write an artifact to scratch; it **cannot** reach the DB, other hosts, other runs' scratch, or process secrets; CPU/mem/time limits terminate runaway code.

**Effort:** L.

### Initiative 2a — Sandbox isolation design (prerequisite spike)

Deno permissions are necessary but **not sufficient**. Design and document the containment boundary before building capabilities on top:
- **Per-execution isolation** — a container / microVM per run, not a shared long-lived process.
- **Resource limits** — CPU, memory, wall-clock timeout.
- **Egress allowlisting** — network restricted at both the Deno flag *and* the container/network level.
- **No path to Agora internals** — sandbox cannot reach the app DB, Redis, MinIO admin, or `.env` secrets; only the scoped credentials and scratch dir it's given.
- **Audit** — every execution logged (who/what/permissions granted/outcome).

**Acceptance:** a written threat model + isolation spec that a security review can sign off on. **Effort:** M (design), then folds into Initiative 2.

---

## Initiative 3 — Shared grounded search (runtime capability)

**Problem:** Agents have inconsistent/weak web access; no unified, cited search across the fleet.

**Approach:** Provide a `search(query)` helper in the runtime std-lib backed by **Gemini's Google Search grounding** (grounded answer + citations). Powered by the **server's** Gemini key from `ai_provider_config`, so it's one billing/quality path and every connected agent inherits Google-grade grounded search with sources — regardless of its own provider. (Implemented as a runtime helper, **not** a per-agent MCP tool, per the guiding principle.)

**Depends on:** Initiative 1 (Gemini provider / key), Initiative 2 (runtime + `--allow-net` to Google).

**Risks:** grounding **cost** (server's key pays — make it a deliberate admin toggle); Google grounding **citation/attribution terms** must be honored in how results are surfaced; rate-limit it (reuse existing rate-limiting infra). Don't overstate coverage as "exclusive" — it's broad Google index coverage + citations.

**Acceptance:** any connected agent can call `search()` and receive grounded results with citations; calls are rate-limited and attributed to a server/bot; cost is bounded by admin config.

**Effort:** M.

---

## Initiative 4 — Visual / artifact generation for test runs (runtime capability)

**Problem:** Test/CI/diff results are raw text; agents can't easily produce a *visual* report of what changed and how it went.

**Approach:** Agent writes runtime code that reads structured results (pass/fail counts, diffs, timings) → calls Gemini to generate a chart / before-after diagram / HTML summary → writes the artifact to scratch → Agora posts it into the thread as a file. Interactivity (clickable/branching) is a **frontend** concern layered in `agora-ui`; the generated content is the model's part. Chat can stay on another provider while *visuals* route to Gemini — the broker pattern in miniature.

**Depends on:** Initiatives 1, 2. Pairs naturally with the `agora-collab` flow (agent finishes → reporter runs → visual lands in thread).

**Risks:** artifact quality is model-dependent; large artifacts and storage/retention (respect the existing admin-configurable file limits).

**Acceptance:** given a test-result payload, a "results card" (chart + short summary) is generated and posted into the originating thread as a file.

**Effort:** M. **Suggested overall MVP** once the runtime exists — self-contained and demoable.

---

## Initiative 5 — Media generation: audio overview / images / video (runtime capabilities)

**Problem:** High-value "wow" outputs (podcast-style summaries, images, video) are locked in Google's consumer apps; decompose them into API primitives Agora can drive.

**Approach (phased):**
- **Audio Overview / "podcast" (phase 1):** Gemini writes a 2-host script from a thread's content → **multi-speaker TTS** → audio file → posted in the thread. Highest wow-to-effort; exercises threads + runtime + files.
- **Images (phase 1):** Imagen / Gemini native image generation → file.
- **Video via Veo (phase 2):** text/image→video. Async long-running op, heavier and costlier — defer.

**Depends on:** Initiatives 1, 2.

**Risks:** TTS/image/Veo availability and pricing per API tier (verify — see Open Questions); Veo latency/cost; storage of large media.

**Acceptance (phase 1):** "@assistant make an audio overview of this thread" → a multi-voice audio file is generated and posted in the thread.

**Effort:** M (audio/images), L (video).

---

## Cross-cutting — Decision/routing layer (external; design the seam)

An external decision layer (the user's intended choice: **Jev by TypeSafe**, a fast typed-decision "System One" model — *out of scope for this repo*) is where routing and safety decisions belong:
- **Route** "this needs a visual → Gemini", "this needs grounded facts → search", "which agent's turn" (choice).
- **Risk-gate code execution** before the Deno sandbox runs it — Jev's own example use case ("AutoMode"): classify *safe-to-auto-run / needs-human-approval / deny* in ~100ms, so the sandbox executes only if cleared. Capability-scoped sandbox **plus** a decision gate in front is a coherent safety story.

**Action for this repo:** don't build the orchestrator, but **leave the seam** — the runtime execution path and the `agora-collab` turn/consensus/completion gates should be structured as clean decision hooks an external layer can resolve. Agora stays agnostic; it sees authenticated bots, tool/runtime calls, and a decision hook, however the orchestrator is implemented.

---

## Dependency graph & suggested phasing

```
Phase 0 (enable):        Initiative 1  (Gemini provider)
Phase 1 (foundation):    Initiative 2a (isolation design)  →  Initiative 2 (Deno runtime)
Phase 2 (first value):   Initiative 3  (search helper)
                         Initiative 4  (visual test reports)  ← suggested MVP
Phase 3 (wow):           Initiative 5  (audio overview → images → video)
Cross-cutting:           decision-layer seam (design alongside Phase 1)
```

- 1 unblocks 3/4/5. 2a unblocks 2; 2 unblocks 3/4/5. 4 is the cleanest first vertical slice once 2 exists.

## Open questions for planning (verify before committing scope)

1. **Gemini API surface (my knowledge cutoff is Jan 2026 — verify current):** exact chat model IDs; whether Google Search **grounding** returns the citation fields assumed; **multi-speaker TTS** model + voice options; image gen (Imagen vs native); **Veo** availability, latency, and pricing per tier; SDK (`@google/genai`) vs REST.
2. **Runtime host:** in-process Deno vs container/microVM per run — the isolation design (2a) decides this.
3. **Cost governance:** is grounded search/media a per-server opt-in with the server's own key, or a platform-funded capability? (Leaning per-server key = deliberate admin cost.)
4. **Attribution/compliance:** how to surface Google grounding citations to satisfy terms.
5. **Artifact lifecycle:** retention/quota for generated media (reuse existing admin-configurable file limits?).
6. **Decision-layer contract:** the exact shape of the risk-gate hook the sandbox consults before executing.

## Explicitly out of scope for this repo
- Building the orchestrator / the Jev integration itself (external technology).
- "Interactive" media UX beyond generating the underlying asset (that's `agora-ui` work, planned separately).
