# Handoff — AI Runtime Initiative (updated 2026-09-30, after live testing and the #33 fix)

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

## Live test results (2026-09-30, WSL2 + gVisor stack, real provider keys)

| Feature | Result |
|---|---|
| gVisor sandbox end to end: agent `runtime_exec` → approval card → runsc container → cap-gateway → result card | ✅ verified |
| `search` via **Tavily** | ✅ verified (run `01M3T162YXNR25QFTPZ9AVHASN`, NC State Extension results) |
| Socket proxy on native Linux Docker (`DOCKER_GID`) | ✅ fixed and verified |
| Sandbox → gateway name resolution under gVisor (`/etc/hosts` pin) | ✅ fixed and verified |
| Route provider switch resets model; Tavily depth dropdown + server validation | ✅ fixed and verified |
| AI settings audit trail ("Recent changes") | ✅ verified: first live entry recorded actor, change, client |
| **Audio overview / multi-speaker TTS** | ❌ failed: Gemini now requires `speechMetadata.speaker` on each text part (issue **#33**). **Fix on branch `claude/amazing-johnson-q35x5f`, needs one live audio overview** (see Next up 1) |
| `video` (Veo) | ✅ verified (2026-09-30, after Veo came back). Route is on `veo-3.1-fast-generate-preview` (~$0.40 per 4 s) with a 2/day request cap |
| `image` | ✅ verified (2026-09-30) |
| `search` via Gemini (Search Suggestions card), single-voice `tts`, `testReport` | ☐ not yet tested live |

Lesson: every provider bug found live was an API contract our mocks had encoded wrongly or out of date (Tavily model field, gVisor DNS, Gemini multi-speaker). One real call per capability after any adapter change is worth more than more mocked tests.

## Next up (in order)
1. **Verify the #33 fix live**, then merge. Branch `claude/amazing-johnson-q35x5f`:
   - Multi-speaker speech goes through `synthesizeDialogue()` in `src/ai/speech.ts`. Adapters with native multi-speaker implement `ttsDialogue`; Gemini now sends one text part per line with `speechMetadata: { speaker }`, plus `multiSpeakerVoiceConfig`, and no preamble. Adapters without it (e.g. a future Kokoro/OpenAI-compatible speech provider) get each line voiced with `tts` and the WAVs joined with a 0.3 s pause. One speaker used → a single-voice call.
   - `agora:std` `tts(text, { speakers })`: the gateway parses `Name: …` turns (`parseDialogue`), rejecting undeclared labels and unlabelled openings with a 400.
   - **The request shape was written from the API reference only** (ai.google.dev is blocked from the cloud session). Live check: one "@assistant audio overview" in a thread, and one run with `tts("Joe: hi\nJane: hello", { speakers: [{ speaker: "Joe", voice: "Kore" }, { speaker: "Jane", voice: "Puck" }] })`. If Gemini still rejects it, the quick fallback is deleting `ttsDialogue` from `src/ai/adapters/gemini.ts`, which makes Gemini voice line by line (one call per line: watch the TTS preview RPM limits).
   - Potential enhancement **#35**: free local TTS with Kokoro as an OpenAI-compatible Speech provider. It only needs single-voice `tts` on the OpenAI-compatible adapter; the line-by-line path already handles two hosts.
2. ~~Retry video~~: ✅ verified live 2026-09-30.
3. **Remaining live checks:** Gemini search (expect the "Web search" card), single-voice `tts`, `testReport`. (`image` ✅.)
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

## Known pre-existing test failures (not caused by this work)
- `ai-assistant.integration.test.ts`: expects bot name `AI Assistant`, but code creates `AI-Assistant`.
- `threads.integration.test.ts` (2–3 tests) and occasionally one admin audit test: they read the DB before the request's COMMIT lands. They need `waitFor`-style polling. A separate agent session was started to fix these; as of 2026-09-30 it had **not** landed on `main`.
- Rare one-off: `ai-streaming` happy path failed once in a full run, then passed 4×.
- Rare one-off: `members` "returns 403 for non-member" failed once in a full run (2026-09-30), then passed 3× alone and on `main`.
- Rare one-off: `admin` "IP ban creates ip_bans row and suspends active user" failed once in a full run (2026-09-30, video branch), then the admin file passed 3× alone. Same read-before-COMMIT pattern as `threads`.
- **Root `npm run build` / `tsc -p .` runs out of memory** (pre-existing on `main`): `test/integration/agora-mcp-package.integration.test.ts` imports `agora-mcp/src/*` and causes ~20M type instantiations. The Docker image only compiles `src/`, so prod builds are unaffected. To type-check locally, exclude that file (a task chip was offered to fix it).

## Cloud sessions (claude.ai/code)
- Used for code work when local usage runs out; Codex on the local machine runs the live checks.
- No MinIO image is reachable (quay.io, Docker Hub, cgr.dev all blocked or gone). For the file-storing integration tests, run moto as an S3 stand-in on :9000 and create the bucket: `python3 -m venv s3env && s3env/bin/pip install "moto[server]"`, `s3env/bin/moto_server -H 127.0.0.1 -p 9000 &`, `curl -X PUT http://127.0.0.1:9000/agora-files`.
- Docker needs `dockerd &` first. Create `accord_test_runner` by hand, and set `IP_ENCRYPTION_KEY` / `AGORA_ENCRYPTION_KEY` in `.env` (register fails with "Invalid key length" otherwise).

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
- **agora-mcp:** the global `agora-mcp` is **0.3.0 linked to `agora-mcp/`** in the Windows checkout (`npm install -g .`), since npm only has 0.1.2, which lacks `runtime_exec`. Rebuilding that folder changes the installed MCP. This Claude session's own Agora MCP config still has a dead token.
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
