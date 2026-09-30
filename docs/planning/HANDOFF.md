# Handoff — AI Runtime Initiative (updated 2026-09-30, after live testing + long chat_wait)

Read with: `wbs.md` (task status, ☑/◐/☐), `ai-runtime-execution-plan.md` (why), `sandbox-isolation-spec.md` (approved sandbox design + threat model).

## Where things stand

| Phase | Status | PR |
|---|---|---|
| 0 Agent threads, thread-aware assistant, protocol badges, bot pause | merged | #24 |
| 1 Provider registry (Anthropic / OpenAI-compatible incl. Ollama / Gemini), capability routes, budgets, SSRF guard, AI settings UI | merged | #25 |
| 3.1–3.6 Sandboxed runtime: runner, `agora:std`, cap-gateway, run API, decision gate + approvals, result cards, retention, MCP `runtime_exec` | merged | #26 |
| 3.8 Tripwires: auto-pause on repeated failures / token misuse / call cap; pause kills running containers | merged | #27 |
| 4.2 / 5.1 / 5.2 capabilities: `search` (Gemini grounding with compliant display, Tavily), `image`, `tts` | merged | #28 |
| 4.1 Visual test report: `testReport()` in `agora:std` → `/v1/reports` → results card + Markdown report | merged | #29 |
| 5.1 Audio overview: "@assistant audio overview" → two-host script → multi-speaker TTS → MP3 + transcript; inline audio player | merged, **broken live, see #33** | #30 |
| 5.3 Video (Veo) + four fixes found in live testing: socket-proxy docker group, gVisor gateway DNS, route model reset / Tavily depths, AI settings audit trail | merged | #31 |
| Agent collab: long, turn-aware `chat_wait` (up to 3600 s, `until="turn"`, progress keep-alive), skills for all four harnesses wait with one `timeout=1500 until=turn` call. `agora-mcp` 0.4.0 | merged | #36 |
| Docs: WSL2 local-stack guide and keep-alive task (#34, #37); architecture docs synced with the code; flaky `threads` / stale `ai-assistant` tests fixed | merged / this PR | #34, #37 |

## Live test results (2026-09-30, WSL2 + gVisor stack, real provider keys)

| Feature | Result |
|---|---|
| gVisor sandbox end to end: agent `runtime_exec` → approval card → runsc container → cap-gateway → result card | ✅ verified |
| `search` via **Tavily** | ✅ verified (run `01M3T162YXNR25QFTPZ9AVHASN`, NC State Extension results) |
| Socket proxy on native Linux Docker (`DOCKER_GID`) | ✅ fixed and verified |
| Sandbox → gateway name resolution under gVisor (`/etc/hosts` pin) | ✅ fixed and verified |
| Route provider switch resets model; Tavily depth dropdown + server validation | ✅ fixed and verified |
| AI settings audit trail ("Recent changes") | ✅ verified: first live entry recorded actor, change, client |
| **Audio overview / multi-speaker TTS** | ❌ **fails**: Gemini now requires `speechMetadata.speaker` on each text part. Issue **#33** |
| `video` (Veo) | ⏸ not tested: Veo was down. Route is on `veo-3.1-fast-generate-preview` (~$0.40 per 4 s) with a 2/day request cap |
| `search` via **Gemini** | ◐ API path works: run `01M3T1RBHQFEWZDN70CAN2TFGR` returned grounded results (`vertexaisearch` redirect links, ncsu.edu/uconn.edu). The "Web search" Search Suggestions card in the UI wasn't checked |
| Long `chat_wait` across harnesses | ✅ verified: Codex (Sol, `tool_timeout_sec = 3600`) held one wait 394.5 s, past Codex's 300 s default; Claude Code held 380 s with no config change; `until=turn` slept through a TURN for another agent and returned both together |
| `image`, single-voice `tts`, `testReport` | ☐ not yet tested live |

Lesson: every provider bug found live was an API contract our mocks had encoded wrongly or out of date (Tavily model field, gVisor DNS, Gemini multi-speaker). One real call per capability after any adapter change is worth more than more mocked tests.

## Next up (in order)
1. **Fix #33** (multi-speaker TTS: one text part per line with `speechMetadata.speaker`, or per-line single-voice synthesis stitched together), then one real audio overview.
   - Potential enhancement **#35**: free local TTS with Kokoro (reusing Thoth's `kokoro-onnx` engine) as an OpenAI-compatible Speech provider.
2. **Retry video** once Veo is back: the agent prompt with `generateVideo("…", { durationSeconds: 4 })`, capability `video`.
3. **Remaining live checks:** the Gemini "Web search" card in the UI, `image`, single-voice `tts`, `testReport`. Also connect **Gemini CLI** and **OpenCode** to Agora and confirm a long `chat_wait` holds there (settings in the agora-collab skill's "Harness setup").
4. **MinIO images are gone** from quay.io/Docker Hub. Issue **#32**; a task chip for picking a replacement was also offered. The WSL stack uses a copy `docker save`d from Docker Desktop (image ID `14cea493d9a3`).
5. **3.9 Negative suite on gVisor:** the spec §14 list. **No CI runner needed any more:** the WSL2 Ubuntu here has `runsc` (release-20260928.0). Most probes already exist in `test/sandbox/runner.sandbox.test.ts`; add the rest and run with `SANDBOX_TEST_RUNTIME=runsc` against the WSL engine.
6. **Hardening:**
   - bind the API's published port to `127.0.0.1:3000:3000` in `docker-compose.prod.yml`. It is currently on all interfaces in plain HTTP, bypassing Caddy. Local agents use `http://localhost:3000`, remote ones should use `https://<domain>`.
   - optionally bind run tokens to the container IP (a live token replayed from another sandbox is indistinguishable today; only dead-token use trips).
7. **Remaining:**
   - `decide` still returns 501 (pairs with the decision seam: `WebhookDecider` + optional `JevDecider` behind `src/runtime/decider.ts`, which may only tighten decisions; spec §10).
   - Video follow-ups: image-to-video, per-second cost accounting (the ledger is per token; Veo reports no tokens, so only the request limit caps spend), an assistant trigger.
   - Audio overview: configurable host names/voices, an agent-facing trigger.
   - 4.1: an MCP tool taking a results file path (code is capped at 360 KB), a CI reporter recipe.
   - Google's docs now lead with the Interactions API; adapters still use `generateContent` (no deprecation notice).
8. **Open issues:** #23 (loop guard UI), #22 (agora-mcp + self-signed `https://localhost`).
9. **Cleanup leftovers:** dead pre-Arc frontend components (`ContentArea`, `UserPanel`, `ConnectionIndicator`, `UserSearch`, nothing imports them) and pre-pivot DB leftovers (DM/voice channel types, `channel_members`, `message_reactions`, `relationships`, the DM branch of `checkChannelMembership`). Both are documented as leftovers in the architecture docs; removing the tables needs a migration.

## Known pre-existing test failures (not caused by this work)
- **Fixed 2026-09-30:** `ai-assistant` (expected `AI Assistant`, code creates `AI-Assistant`) and `threads` (read the DB before the request's COMMIT landed; now polls). Recovered from an uncommitted agent worktree; 3 clean runs.
- Occasionally one `admin` audit test: same read-before-COMMIT pattern, not yet fixed.
- Rare one-off: `ai-streaming` happy path failed once in a full run, then passed 4×.
- Rare one-off: `members` "returns 403 for non-member" failed once in a full run (2026-09-30), then passed 3× alone and on `main`.
- Rare one-off: `admin` "IP ban creates ip_bans row and suspends active user" failed once in a full run (2026-09-30, video branch), then the admin file passed 3× alone. Same read-before-COMMIT pattern as `threads`.
- **Root `npm run build` / `tsc -p .` runs out of memory** (pre-existing on `main`): `test/integration/agora-mcp-package.integration.test.ts` imports `agora-mcp/src/*` and causes ~20M type instantiations. The Docker image only compiles `src/`, so prod builds are unaffected. To type-check locally, exclude that file (a task chip was offered to fix it).

## Local environment (this machine)
- **The prod stack runs in WSL2 Ubuntu** at `~/agora` (checkout of `main`), on its own Docker Engine 29.x with gVisor `runsc`. The runner starts with `runtime=runsc`, no dev flag. `.env.prod` there has `DOCKER_GID=986`.
  - Run commands in the distro via `wsl.exe -d Ubuntu -- bash -s <<'EOF' … EOF` (stdin scripts; PowerShell 5.1 and inline `bash -lc` mangle quotes).
  - Run long `compose up --build` as a background task, or it dies when the `wsl.exe` session closes.
  - **The distro stops about a minute after its last `wsl.exe` session closes**, taking the stack down (happened 2026-09-30 when a shared terminal was closed). A logon scheduled task, **"WSL Ubuntu keep-alive (Agora stack)"** (`conhost --headless wsl.exe -d Ubuntu --exec sleep infinity`), now holds it open. Docker is systemd-enabled and services are `restart: unless-stopped`, so the stack comes back on its own. If `localhost:3000` is dead, check `wsl -l -v` and that task first. Setup: `docs/getting-started.md` step 7.
  - Deploy: `git pull` in `~/agora`, then `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build <services>`.
  - Browser: `https://localhost` (Caddy, local cert). Agents/MCP: `http://localhost:3000` (Node rejects Caddy's local cert).
- **Docker Desktop (Windows)** still has the **stopped** old prod stack (compose project `agora`, disposable test data; fallback only) and the test infra. **Never** `docker compose up` the dev file there without `-p agora-test`.
- Test infra: `docker compose -p agora-test -f docker-compose.yml up -d postgres redis minio`, plus `--profile sandbox up -d socket-proxy` for runtime work.
- Use an **isolated test DB** so parallel agent sessions don't truncate each other: DB `accord_test_threads`, Redis DB 1. Env via the scratchpad `testenv.sh`, or set `DATABASE_URL` / `TEST_DATABASE_URL` (both!) and `REDIS_URL=redis://localhost:6379/1`.
- Exclude agent worktrees from vitest: the default config excludes `.claude/**` and `test/sandbox/**`. Docker suite: `npm run test:sandbox` (Docker Desktop, runc, needs `agora_sandbox` network + `agora/sandbox-deno:dev` image).
- **agora-mcp:** the global `agora-mcp` is **0.4.0 linked to `agora-mcp/`** in the Windows checkout (`npm install -g .`), since npm only has 0.1.2, which lacks `runtime_exec` and the long `chat_wait`. Rebuilding that folder changes the installed MCP, but running agents keep the old code until their MCP server restarts (check process start times against `agora-mcp/dist` if unsure).
- **Agents on Agora:** Claude Code (project entry in `~/.claude.json`) and **Sol** (Codex, project `.codex/config.toml`, gitignored, with `tool_timeout_sec = 3600`). Gemini CLI and OpenCode have no Agora server configured today.
- Local Ollama is at `localhost:11434` (qwen3:14b, qwen3:32b, gpt-oss:20b, deepseek-r1:14b, …). Testing against it loads models into the 5070 Ti.
- Windows/Git Bash: `ln -s` copies instead of linking; Python heredocs in Bash mangle `\n` and `\\`. Write scripts to files with the Write tool instead.

## Key design decisions made along the way (not all in the spec)
- Bots get **one per-bot "Code runs" setting** (`users.runtime_access`: none / approval / auto) instead of an `ExecuteCode` role bit.
- The **runner mints run tokens** at run start (never in the queue); only SHA-256 hashes are stored.
- Code enters containers via **base64 env chunks** and output comes back via **capped `local` log driver + logs API**: no bind mounts, no attach (the socket proxy doesn't support hijack).
- The **socket proxy** only allows operations on `agora-run-*` container names and rejects bind mounts (verified). It needs the host's docker group (`DOCKER_GID`) on native Linux.
- **Under gVisor, sandboxes have no DNS.** The runner pins `cap-gateway:<ip>` in each run's `/etc/hosts` (spec §6). This also closes DNS tunneling.
- Artifacts leave only via the gateway (`postFile`, `/v1/reports`, video) through the shared `src/lib/file-store.ts`.
- Cross-process Socket.IO events go through the Redis **event bridge** (`src/lib/event-bridge.ts`) with an allowlist.
- The Docker host env var is `AGORA_DOCKER_HOST` (not `DOCKER_HOST`, so a sourced `.env` never hijacks the docker CLI).
- **AI settings changes are audited** (`src/lib/ai-audit.ts`, `GET /servers/:id/ai/changes`, "Recent changes" in the UI), recording actor, client, and before/after; key material never.
