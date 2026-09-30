# Handoff — AI Runtime Initiative (updated 2026-09-30, after 3.8)

Read with: `wbs.md` (task status, ☑/◐/☐), `ai-runtime-execution-plan.md` (why), `sandbox-isolation-spec.md` (approved sandbox design + threat model).

## Where things stand

| Phase | Status | PR |
|---|---|---|
| 0 Agent threads, thread-aware assistant, protocol badges, bot pause | merged | #24 |
| 1 Provider registry (Anthropic / OpenAI-compatible incl. Ollama / Gemini), capability routes, budgets, SSRF guard, AI settings UI | merged | #25 |
| 3.1–3.6 Sandboxed runtime: runner, `agora:std`, cap-gateway, run API, decision gate + approvals, result cards, retention, MCP `runtime_exec` | merged | #26 |
| 3.8 Tripwires: auto-pause on repeated failures / token misuse / call cap; pause kills running containers | merged | #27 |
| 4.2 / 5.1 / 5.2 capabilities: `search` (Gemini grounding with compliant display, Tavily), `image`, `tts` | **open, awaiting review/merge** | `feat/capabilities` |

## Next up (in order)
1. **Merge the capabilities PR** (`feat/capabilities`), then branch from `main`. Before relying on it, smoke-test each capability once with real Gemini and Tavily keys (only mocked responses were tested; API shapes were checked against Google's generateContent reference and Tavily's docs on 2026-09-30).
2. *(Hardening, optional)* **Bind run tokens to the container IP.** Today a *live* token replayed from another sandbox is indistinguishable from its own run; only dead-token use trips. The runner could record the container's `agora_sandbox` IP on `exec_run_tokens` and the gateway compare `request.ip` (needs a trusted-proxy setting for the dev forwarder).
3. **3.9 Negative suite on gVisor:** the spec §14 list. Most probes already exist in `test/sandbox/runner.sandbox.test.ts`; add the rest and run with `SANDBOX_TEST_RUNTIME=runsc` on a Linux host/CI runner that has `runsc`. None exists yet.
4. **4.1 Visual test report MVP:** results payload → routed `image`/`chat` capability → chart + HTML card → thread. Capabilities it needs are in place. Still open from Phase 4/5: `decide`/`video` (501), and the audio-overview flow on top of `tts`.
   - Google's docs now lead with the Interactions API (`/v1beta/interactions`); `generateContent` is still documented with no deprecation notice. Adapters use `generateContent` for everything.
5. **Decision seam 2.2/2.3:** `WebhookDecider` + optional `JevDecider` behind `src/runtime/decider.ts` (they may only tighten decisions; see spec §10).
6. **Open GitHub issue #23:** loop guard UI visibility.

## Known pre-existing test failures (not caused by this work)
- `ai-assistant.integration.test.ts`: expects bot name `AI Assistant`, but code creates `AI-Assistant`.
- `threads.integration.test.ts` (2–3 tests) and occasionally one admin audit test: they read the DB before the request's COMMIT lands. They need `waitFor`-style polling. A separate agent session was started to fix these; as of 2026-09-30 (3.8 work) it had **not** landed on `main`.
- Rare one-off: `ai-streaming` happy path failed once in a full run, then passed 4×.
- **Root `npm run build` / `tsc -p .` runs out of memory** (pre-existing on `main`): `test/integration/agora-mcp-package.integration.test.ts` imports `agora-mcp/src/*` and causes ~20M type instantiations. The Docker image only compiles `src/`, so prod builds are unaffected. To type-check locally, exclude that file (a background task was suggested to fix it).

## Local environment gotchas (this machine)
- **The prod stack runs locally** (compose project `agora`: postgres DB `agora`, no published 5432). **Never** `docker compose up` the dev file without `-p`; it recreates prod containers.
- Test infra: `docker compose -p agora-test -f docker-compose.yml up -d postgres redis minio`, plus `--profile sandbox up -d socket-proxy` for runtime work.
- Use an **isolated test DB** so parallel agent sessions don't truncate each other: DB `accord_test_threads`, Redis DB 1. Env via the scratchpad `testenv.sh`, or set `DATABASE_URL` / `TEST_DATABASE_URL` (both!) and `REDIS_URL=redis://localhost:6379/1`.
- Exclude agent worktrees from vitest: the default config now excludes `.claude/**` and `test/sandbox/**`. Docker suite: `npm run test:sandbox`.
- Sandbox dev prerequisites: `docker network create --internal agora_sandbox`, `docker build -t agora/sandbox-deno:dev sandbox`, runner with `AGORA_SANDBOX_INSECURE_DEV=1` (Docker Desktop has no gVisor). Gateway dev forwarder: see `docs/getting-started.md` → Sandbox runner.
- Local Ollama is at `localhost:11434` (qwen3:14b, qwen3:32b, gpt-oss:20b, deepseek-r1:14b, …). Testing against it loads models into the 5070 Ti.
- Windows/Git Bash: `ln -s` copies instead of linking; Python heredocs in Bash mangle `\n` and `\\`. Write scripts to files with the Write tool instead.

## Key design decisions made along the way (not all in the spec)
- Bots get **one per-bot "Code runs" setting** (`users.runtime_access`: none / approval / auto) instead of an `ExecuteCode` role bit.
- The **runner mints run tokens** at run start (never in the queue); only SHA-256 hashes are stored.
- Code enters containers via **base64 env chunks** and output comes back via **capped `local` log driver + logs API**: no bind mounts, no attach (the socket proxy doesn't support hijack).
- The **socket proxy** only allows operations on `agora-run-*` container names and rejects bind mounts (verified).
- Artifacts leave only via the gateway (`postFile`) through the shared `src/lib/file-store.ts`.
- Cross-process Socket.IO events go through the Redis **event bridge** (`src/lib/event-bridge.ts`) with an allowlist.
- The Docker host env var is `AGORA_DOCKER_HOST` (not `DOCKER_HOST`, so a sourced `.env` never hijacks the docker CLI).
