# Handoff — AI Runtime Initiative (2026-09-30)

Read with: `wbs.md` (task status, ☑/◐/☐), `ai-runtime-execution-plan.md` (why), `sandbox-isolation-spec.md` (approved sandbox design + threat model).

## Where things stand

| Phase | Status | PR |
|---|---|---|
| 0 Agent threads, thread-aware assistant, protocol badges, bot pause | merged | #24 |
| 1 Provider registry (Anthropic / OpenAI-compatible incl. Ollama / Gemini), capability routes, budgets, SSRF guard, AI settings UI | merged | #25 |
| 3.1–3.6 Sandboxed runtime: runner, `agora:std`, cap-gateway, run API, decision gate + approvals, result cards, retention, MCP `runtime_exec` | **open, awaiting review/merge** | #26 (`feat/runtime`) |

## Next up (in order)
1. **Merge #26**, then branch from `main`.
2. **3.8 Tripwires:** auto-pause the submitting bot (reuse `users.bot_paused_at`) on 3 failed/timed-out runs in 10 min, on gateway auth with another run's token, and on hitting the call cap. Post a notice in the thread. Hook points: `processRun` outcome in `src/runtime/runner.ts`, and the auth/`consumeCall` paths in `src/gateway/cap-gateway.ts`.
3. **3.9 Negative suite on gVisor:** the spec §14 list. Most probes already exist in `test/sandbox/runner.sandbox.test.ts`; add the rest and run with `SANDBOX_TEST_RUNTIME=runsc` on a Linux host/CI runner that has `runsc`. None exists yet.
4. **Phase 4 capabilities:** add `search` (Gemini Google Search grounding), `image`, and `tts` to the adapters and `HANDLERS` in cap-gateway (they return 501 today), then build the **visual test report** MVP. Verify Gemini grounding/TTS/image API shapes against current docs first; Google now recommends the "Interactions API", but we use `generateContent` (reason in `wbs.md` Phase 1 notes).
5. **Decision seam 2.2/2.3:** `WebhookDecider` + optional `JevDecider` behind `src/runtime/decider.ts` (they may only tighten decisions; see spec §10).
6. **Open GitHub issue #23:** loop guard UI visibility.

## Known pre-existing test failures (not caused by this work)
- `ai-assistant.integration.test.ts`: expects bot name `AI Assistant`, but code creates `AI-Assistant`.
- `threads.integration.test.ts` (2–3 tests) and occasionally one admin audit test: they read the DB before the request's COMMIT lands. They need `waitFor`-style polling. A separate agent session was started to fix these; check whether it landed.
- Rare one-off: `ai-streaming` happy path failed once in a full run, then passed 4×.

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
