# Handoff — AI Runtime Initiative (updated 2026-10-01, end of day: 0.2.0 released, instance wiped for onboarding tests)

Read with: `wbs.md` (task status, ☑/◐/☐), `ai-runtime-execution-plan.md` (why), `sandbox-isolation-spec.md` (approved sandbox design + threat model), `../storage-and-encryption.md` (what is stored where, what is encrypted, known gaps).

## Decision model (Jev): implemented, open as PR #51 (2026-10-01, evening)

The Jev project was planned in Agora with Codex and Gemini and then implemented in one session. **Plan, status, what was and was not verified, and the open questions for Eryk: [`jev-wbs.md`](jev-wbs.md), "Status" at the top.** Read that before touching this work.

- **PR #51**, `feat/jev-file-tags` → `main`, one commit per phase. Not merged. Three earlier local branches (`feat/jev-foundation`, `feat/jev-routing`, `feat/jev-search-screening`) are ancestors of it and can be deleted.
- What it adds: an optional decision model (`typesafe` adapter, `decide` route) used for assistant routing, assistant web search, search-result screening for prompt injection, file tagging with admin-defined tags, and file search with ranking. Agents can also read file text now (`file_read`), with or without a decision model. Off by default; with it off, Agora behaves as before.
- Migrations `033` and `034` (not reversible: use a database of their own when testing, as with `031`). New dependency `unpdf`.
- The test key is the Windows user environment variable `JEV_KEY`. Agora does not read it at runtime; admins enter the key in AI settings. Live checks: `JEV_LIVE=1 JEV_KEY=… npx vitest run test/live`.
- Test databases made for this work on the Docker Desktop Postgres (`agora-test-postgres-1`): `accord_test_jev` (the test suite) and `agora_jev_live` (the dev instance used for the end-to-end check, with its files in `%TEMP%\agora-jev-live-files`). Both are disposable.
- Still to do before merging: look at the UI in a browser, run a real Tavily search through screening, run the sandbox suite and a deploy on the WSL + gVisor stack, and build the Docker image.

## Current state (read this first)

**0.2.0 is released.** `main` is at #48. Tag `v0.2.0` sits on the merge of #45 (`49c78e5`), and there is a GitHub release with the changelog. No PRs are open.

**There is no running Agora instance on this machine.** After 0.2.0 was deployed and checked, Eryk had the WSL stack wiped (`docker compose down -v`) and the Agora MCP registrations removed, to test onboarding from scratch. Do not assume `localhost:3000` answers. See "Local environment".

| PR | What | State |
|---|---|---|
| #42 | `main` through #41, MinIO → disk store (#32), API port on `127.0.0.1`, the recovered #38, `docs/storage-and-encryption.md` | merged; in 0.2.0 |
| #43 | IP tracking and IP bans removed (migration `031`) | merged; in 0.2.0 |
| #44 | `NODE_ENV=production` in the image, refusal of default secrets, startup fingerprint check for `AGORA_ENCRYPTION_KEY` | merged; in 0.2.0 |
| #45 | **Release 0.2.0.** 6.8 commit before the reply · 6.6 the setup script's domain · 6.7 file names out of storage paths, non-root containers, key rotation, bound run tokens · 3.9 negative security suite on gVisor · `/suspend` alias removed · changelog, version bump | merged, tagged `v0.2.0`, deployed to WSL and verified, then the instance was wiped |
| #46 | Docs: install `agora-mcp` from the repo until 0.4.0 is on npm; what works on macOS (three options) | merged, after 0.2.0 |
| #47 | `agora-connect` skill: four checks before anything is started (stale registration, leftover install, platform gate, state the plan); short scripted messages at the two token steps; the same checks in `CLAUDE.md` | merged, after 0.2.0 |
| #48 | Log in with a username or an email (`login` field; `email` still accepted; case ignored); the login route now validates its body | merged, after 0.2.0, **not deployed anywhere**; listed under "Unreleased" in `CHANGELOG.md` |

**Three things waiting on something outside the repo:**

1. **`agora-mcp` 0.4.0 is not on npm** (npm has 0.1.2). The npm account (`misterespresso`) has a passkey as second factor that could not be found; Eryk got in with a recovery code on 2026-10-01 and npm then blocks publishing for 72 hours, so the earliest publish is about **2026-10-04**. Publishing is his to run (`npm login`, then `npm publish` in `agora-mcp/`; it needs his passkey). The package is built and tested (52 tests) and a dry-run pack is clean. He should add a new passkey on this machine first. **After it is published:** change the docs and the skill back from "install from the repo" to `npm install -g agora-mcp` (#46 lists the places) and check `npm view agora-mcp version`.
2. **macOS.** The first test on a Mac failed: that Mac still had an old `agora` MCP registration and an old stack, and the agent tried the stale tools, then the old stack, then ran the generic Docker steps (#47 is the response). The second run **worked end to end, including a sandboxed code run** (Eryk, 2026-10-01). Not yet known: which route it took (a code run needs gVisor, so almost certainly the Colima VM), Apple Silicon or Intel, and whether any step needed changing. **The docs still say the Colima route is "not yet verified on a real Mac"** (`docs/getting-started.md`, the skill, `CLAUDE.md`): replace that with what happened once Eryk supplies those details. Verified separately: every image the stack pulls has an arm64 build, and the backend, sandbox and web images build and start for `linux/arm64` under emulation.
3. **WBS 6.9**, the one item left out of 0.2.0: nginx resolves the API address only at startup, so a deploy that recreates `api` without `web` returns 502 until `web` is restarted. It happened on both deploys on 2026-10-01. A task chip with the fix and how to test it was left in the session.

Merged remote branches that can be deleted (each is merged; check no open PR uses it as a base first): `release/0.2.0`, `docs/install-agora-mcp-from-repo`, `docs/agora-connect-dirty-machines`, `feat/login-email-or-username`.

**What went wrong on 2026-09-30.** PR #38 was pushed at 22:08 UTC and its branch `chore/cleanup-after-36` was deleted at 22:13 UTC, in the same sweep that removed the merged feature branches. GitHub closes a PR when its branch is deleted, so #38 was closed **unmerged** and its work never reached `main`. The handoff on `main` then described a state that didn't match the code. The commits were recovered from `refs/pull/38/head` and landed in #42.

**Rule from this:** before deleting a branch, check its PR says *merged*, and that no other open PR uses it as its base. `gh pr list --state open --head <branch>` and `gh pr list --state open --base <branch>` must both be empty, and `git branch -r --merged origin/main` must list it.

**Lessons from 2026-10-01 about onboarding tests:**
- A cleanup only covers the machine it ran on. The Windows machine and WSL were cleaned; the Mac was not, and nobody said so.
- An agent on another machine sees only what is on GitHub `main` (and whatever stale copies are on that machine). Guidance for it has to be merged, and copied skills do not update themselves.
- Instructions have to survive a dirty machine: a dead registration, an old stack, an old `.env.prod`.

## Order of work agreed 2026-10-01

1. **Docs first** (done in #42): README, getting started, architecture, API reference, sandbox spec, this handoff, and the new storage and encryption page.
2. **Then code changes**, starting with the gaps the audit found (next section). The first one is done: Eryk decided to **remove IP tracking and IP bans outright** rather than repair them. IP bans are easy to evade, can hit unrelated people behind one address, and would hit every local agent at once (they all arrive from the same local address). Registration policy, account bans and bot pause / token revocation are the controls.
3. **Jev is its own project now.** Decided 2026-10-01: the Jev decision layer (WBS 2.2, 2.3, the `decide` capability) leaves this initiative. Its WBS is [`jev-wbs.md`](jev-wbs.md), written in Agora and since implemented on local branches (see the section above). The rules decider is still the only gate on code runs, and `decide` still returns 501 to sandboxed code: both are in that WBS's backlog.

## Audit findings (2026-10-01): what the docs promised vs what runs

File encryption came through the MinIO change intact. Two older gaps in the production setup did not hold up. All findings (A–E) are now closed; F (stale comments) was fixed along the way. Full detail in `../storage-and-encryption.md`.

| # | Finding | Evidence | Fix (code phase) |
|---|---|---|---|
| A | ~~The production API runs with the default (all-zero) `IP_ENCRYPTION_KEY`~~, so stored IPs were encrypted with a publicly known key. | Live WSL stack logged `WARNING: Using default IP_ENCRYPTION_KEY`. Older than #32. | **Closed by removal** (#43, deployed 2026-10-01): no IPs are stored, the key is gone, and the live API no longer logs the default-key warning. |
| B | ~~The "refuses to start in production" guard never runs in Docker~~: `src/config.ts` only hard-fails when `NODE_ENV=production`, and nothing set it. | `NODE_ENV` was empty in the live `api` container. | **Fixed (#44, deployed 2026-10-01)**: the image sets `NODE_ENV=production`; an all-zero `AGORA_ENCRYPTION_KEY` and a placeholder `JWT_SECRET` are refused; a startup fingerprint check refuses a *changed* encryption key (`src/lib/key-fingerprint.ts`, override `AGORA_ACCEPT_NEW_ENCRYPTION_KEY=1`). |
| C | ~~The setup script's domain prompt has no effect~~: it wrote `CORS_ORIGIN`, compose built the API's origin from `DOMAIN` (default `alpha.agora.host`), and `caddy` got no `DOMAIN`, so the `Caddyfile` always fell back to `localhost`. | Read from the compose file, `Caddyfile` and setup script; `caddy adapt` without `DOMAIN` gives host `localhost`. | **Fixed (WBS 6.6, 0.2.0):** the script writes `DOMAIN`; compose passes it to `caddy` and derives the API origin from it (an explicit `CORS_ORIGIN` still wins). Checked by running the real script (`--no-start`) and `caddy adapt`. **Not checked: certificate issuance on a real domain.** |
| D | ~~The storage path contains the original filename~~ (`<channelId>/<fileId>/<filename>`), as the MinIO object keys did. | `src/lib/file-store.ts`; names on the live volume. | **Fixed (WBS 6.7, 0.2.0):** new files are stored as `<channelId>/<fileId>/blob`. Older files keep their name until `strip-storage-filenames` is run. |
| E | ~~All backend containers run as root~~ (no `USER` in the `Dockerfile`). | `id -u` was 0 in the live `api` container. | **Fixed (WBS 6.7, 0.2.0):** the image runs as `node` (uid 1000); a one-shot `files-perms` service hands an existing root-owned `files-data` volume over. Verified on an isolated stack built from the release image. |
| F | ~~Stale code comments from the MinIO era~~ in `src/lib/file-store.ts`, `src/tools/migrate-storage-from-s3.ts` and `test/integration/files.integration.test.ts`. | grep | **Fixed (0.2.0).** |

Verified on the live stack on 2026-10-01: six blobs on `files-data`, none starting with its file type's magic bytes (PNG, JPG, MP4, TXT, MP3 all read as random bytes), so encryption at rest is doing its job on disk.

## Where things stand

| Phase | Status | PR |
|---|---|---|
| 0 Agent threads, thread-aware assistant, protocol badges, bot pause | merged | #24 |
| 1 Provider registry (Anthropic / OpenAI-compatible incl. Ollama / Gemini), capability routes, budgets, SSRF guard, AI settings UI | merged | #25 |
| 3.1–3.6 Sandboxed runtime: runner, `agora:std`, cap-gateway, run API, decision gate + approvals, result cards, retention, MCP `runtime_exec` | merged | #26 |
| 3.8 Tripwires: auto-pause on repeated failures / token misuse / call cap; pause kills running containers | merged | #27 |
| 4.2 / 5.1 / 5.2 capabilities: `search` (Gemini grounding with compliant display, Tavily), `image`, `tts` | merged | #28 |
| 4.1 Visual test report: `testReport()` in `agora:std` → `/v1/reports` → results card + Markdown report | merged | #29 |
| 5.1 Audio overview: "@assistant audio overview" → two-host script → multi-speaker TTS → MP3 + transcript; inline audio player | merged; fixed by #41 | #30, #41 |
| 5.3 Video (Veo) + four fixes found in live testing: socket-proxy docker group, gVisor gateway DNS, route model reset / Tavily depths, AI settings audit trail | merged | #31 |
| Agent collab: long, turn-aware `chat_wait` (up to 3600 s, `until="turn"`, progress keep-alive); skills for all four harnesses wait with one `timeout=1500 until=turn` call. `agora-mcp` 0.4.0 | merged | #36 |
| Docs: WSL2 local-stack guide and keep-alive task | merged | #34, #37 |
| Storage: MinIO → disk store, S3 optional | merged, deployed | #42 (closes #32) |
| Hardening: API port on `127.0.0.1` only | merged, deployed, verified from this machine | #42 |
| Architecture docs synced with the code; Vite dev proxy `runtime`; `threads` / `ai-assistant` test fixes (recovered from closed #38) | merged | #42 |
| IP tracking and IP bans removed | merged, deployed | #43 |
| Startup key checks (finding B) | merged, deployed | #44 |
| Commit before the reply; domain setting; storage paths without file names; non-root containers; key rotation; bound run tokens; negative suite on gVisor | merged; released as 0.2.0 | #45 |
| Onboarding: install `agora-mcp` from the repo; macOS guidance; `agora-connect` checks and token scripts | merged | #46, #47 |
| Login with a username or an email | merged, unreleased, not deployed | #48 |

## Live test results (WSL2 + gVisor stack, real provider keys)

| Feature | Result |
|---|---|
| gVisor sandbox end to end: agent `runtime_exec` → approval card → runsc container → cap-gateway → result card | ✅ verified 2026-09-30 |
| `search` via **Tavily** | ✅ verified (run `01M3T162YXNR25QFTPZ9AVHASN`, NC State Extension results) |
| `search` via **Gemini** | ✅ works (Eryk, 2026-10-01). Earlier API-path check: run `01M3T1RBHQFEWZDN70CAN2TFGR` returned grounded results |
| Single-voice `tts` | ✅ works (Eryk, 2026-10-01) |
| **Audio overview / multi-speaker TTS** | ✅ #33 fix verified live 2026-09-30: two voices, no 400. That run exposed a second bug: the script was cut off after 3 lines (0:23) because Gemini 3.x thinking tokens count against the script step's 2048-token cap. Raised to 8192 and an unfinished last line is dropped; ✅ verified live (full-length overview). Channel overviews still skip thread replies: **#40** |
| `video` (Veo) | ✅ verified 2026-09-30. Route is on `veo-3.1-fast-generate-preview` (~$0.40 per 4 s) with a 2/day request cap |
| `image` | ✅ verified 2026-09-30 |
| **Disk file store (MinIO replacement, #32)** | ✅ works (Eryk, 2026-10-01). WSL stack runs `5af0f43` with no `minio` container; blobs on `files-data` are ciphertext |
| **Stored files still open** after the storage change and the three deploys | ✅ Eryk opened files in the app (2026-10-01). After #42–#44 were deployed, all 6 stored files (MP4, JPEG, 2 MP3, text, PNG) were decrypted inside the live `api` container with the live key: each decrypts, matches its recorded size and starts with its type's magic bytes |
| Socket proxy on native Linux Docker (`DOCKER_GID`) | ✅ fixed and verified |
| Sandbox → gateway name resolution under gVisor (`/etc/hosts` pin) | ✅ fixed and verified |
| Route provider switch resets model; Tavily depth dropdown + server validation | ✅ fixed and verified |
| AI settings audit trail ("Recent changes") | ✅ verified: first live entry recorded actor, change, client |
| Long `chat_wait` across harnesses | ✅ verified: Codex (Sol, `tool_timeout_sec = 3600`) held one wait 394.5 s, past Codex's 300 s default; Claude Code held 380 s with no config change; `until=turn` slept through a TURN for another agent and returned both together |
| **API port on `127.0.0.1` only** | ✅ verified 2026-10-01 from this machine: `docker ps` shows `127.0.0.1:3000->3000`; from Windows, `http://localhost:3000` and `https://localhost` answer; the WSL address (`172.19.74.12:3000`), which answered before, now refuses. ☐ Not checked from a second device. In WSL's default NAT mode port 3000 was never reachable from the LAN without a port proxy, so that check matters for a real Linux host, not this setup |
| **Migration `031`** on the live DB | ✅ 2026-10-01: applied; 4 users and 6 files intact; `health` ok; runner on `runsc` |
| **Sandbox suite under gVisor** (incl. the §14 negative suite) | ✅ 2026-10-01: 37 of 37 on the WSL engine via `scripts/test-sandbox-gvisor.sh` (`runsc` release-20260928.0; containers report kernel `4.19.0-gvisor`). Test containers only: the live stack was not touched |
| **Release image, isolated stack** (Docker Desktop, project `agora-rel-test`, own ports) | ✅ 2026-10-01: services run as uid 1000 in production mode; a root-owned uploads volume is handed over; upload stores `<channel>/<file>/blob` as ciphertext; download through nginx + Caddy; key rotation in Docker, after which the old key is refused. No gVisor there, so no code runs |
| **0.2.0 on the WSL stack** | ✅ 2026-10-01: deployed from `main` at `49c78e5`. `api`, `cap-gateway` and `runner` run as uid 1000 in production mode with 0 restarts; `files-perms` handed the uploads volume over; 32 migrations; all 6 stored files decrypted as the non-root user; runner on `runsc`. `https://localhost` returned 502 until `web` was restarted (6.9). No code run was submitted on it before it was wiped |
| **macOS, end to end** | ✅ per Eryk, 2026-10-01: a fresh Claude on a Mac stood the stack up and connected, and a sandboxed code run completed. Route, chip and any deviations from the guide are not recorded yet |
| `testReport` | ☐ not yet tested live |

Lesson: every provider bug found live was an API contract our mocks had encoded wrongly or out of date (Tavily model field, gVisor DNS, Gemini multi-speaker). One real call per capability after any adapter change is worth more than more mocked tests.

## Next up (in order)

1. **WBS 6.9: make nginx re-resolve the API address**, so a deploy that recreates `api` without `web` stops returning 502.
2. **Write the Mac result into the docs** once Eryk gives the route, the chip and any step that needed changing (see "Current state", item 2).
3. **Publish `agora-mcp` 0.4.0** on or after 2026-10-04 (Eryk runs it), then switch the docs and the skill back to the npm install line.
4. **Stand an instance back up** when one is needed again: `~/agora` in WSL is a checkout of `main` at `49c78e5` with its `.env.prod` in place, so `git pull` and `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build` gives a fresh, uninitialised 0.2.0+ instance (new setup token in the `api` logs). That will also be the first deploy of #48.
5. **#40** (channel audio overviews ignore threads) and **#39** (agents can read and use each other's bot tokens from local MCP config). For #39, Eryk's idea (2026-10-01): let the **decision handler** take part of that job. Notes on what it can and can't see are in a comment on #39.
6. **Remaining live checks:** `testReport`; certificate issuance on a real domain through `DOMAIN`; the login form with a username in a browser (#48 was tested through the API and the UI build, not looked at on screen). Also connect **Gemini CLI** and **OpenCode** to Agora and confirm a long `chat_wait` holds there (settings in the agora-collab skill's "Harness setup").
7. **Hardening backlog** (spec §18): a per-run Docker network, rootless Docker for the sandbox daemon, a tighter seccomp profile.
8. **Remaining:**
   - `decide` returns 501: belongs to the separate Jev project (see "Order of work").
   - Video follow-ups: image-to-video, per-second cost accounting (the ledger is per token; Veo reports no tokens, so only the request limit caps spend), an assistant trigger.
   - Audio overview: configurable host names/voices, an agent-facing trigger.
   - Potential enhancement **#35**: free local TTS with Kokoro as an OpenAI-compatible Speech provider. It only needs single-voice `tts` on the OpenAI-compatible adapter; the line-by-line path in `src/ai/speech.ts` already handles two hosts.
   - 4.1: an MCP tool taking a results file path (code is capped at 360 KB), a CI reporter recipe.
   - Google's docs now lead with the Interactions API; adapters still use `generateContent` (no deprecation notice).
9. **Open issues:** #23 (loop guard UI), #22 (agora-mcp + self-signed `https://localhost`).
10. **Cleanup leftovers:** dead pre-Arc frontend components (`ContentArea`, `UserPanel`, `ConnectionIndicator`, `UserSearch`, nothing imports them) and pre-pivot DB leftovers (DM/voice channel types, `channel_members`, `message_reactions`, `relationships`, the DM branch of `checkChannelMembership`). Both are documented as leftovers in the architecture docs; removing the tables needs a migration. The `minio` npm package stays: it is the S3 client behind `STORAGE_DRIVER=s3` and the migration tool.

## How multi-speaker speech works (#41)

- Multi-speaker speech goes through `synthesizeDialogue()` in `src/ai/speech.ts`. Adapters with native multi-speaker implement `ttsDialogue`; Gemini sends one text part per line with `speechMetadata: { speaker }`, plus `multiSpeakerVoiceConfig`, and no preamble. Adapters without it get each line voiced with `tts` and the WAVs joined with a 0.3 s pause. One speaker used → a single-voice call.
- `agora:std` `tts(text, { speakers })`: the gateway parses `Name: …` turns (`parseDialogue`), rejecting undeclared labels and unlabelled openings with a 400.
- If Gemini changes the contract again, the quick fallback is deleting `ttsDialogue` from `src/ai/adapters/gemini.ts`, which makes Gemini voice line by line (one call per line: watch the TTS preview RPM limits).

## Known test failures (not caused by this work)
- **The flaky tests are fixed at the cause (WBS 6.8, 0.2.0).** The request transaction used to commit in `onResponse`, after the reply had gone out, so a test acting on a response could arrive before the data was saved (one full run on 2026-10-01: 21 failures of 670; the next, unchanged: 0). The commit now happens in `onSend`, before the reply. `test/integration/request-lifecycle.integration.test.ts` fails on the old code and passes on the new; the full suite then ran 673 of 673 three times in a row. The entries below describe the old behaviour and should not recur. The `waitForRow` polling left in some test files is now unnecessary but harmless.
- **Fixed in #42** (from #38): `ai-assistant` (expected `AI Assistant`, code creates `AI-Assistant`) and `threads` (read the DB before the request's COMMIT landed; now polls).
- *History:* `admin.integration.test.ts` was flaky before #43. On 2026-10-01 the full suite ran 460 of 461 green, with one `admin` failure; eight runs of that file gave 1, 10, 17, 0, 1, 0, 0, 0 failures out of 50. The failures inspected were tests that read the DB straight after a request (the read-before-COMMIT pattern `threads` had), most of them IP ban and "records IP" tests. #43 deleted those IP tests (the file is now 40 tests). The audit-log tests in that file still read right after the request and still need the polling helper.
- *History:* `auth-phase1` "register with valid inviteCode returns 201, user added to server" failed once in the full run on `chore/remove-ip-tracking` (658 of 659 green, 2026-10-01), then the file passed 5× alone. It queries `server_members` straight after the register request: read-before-COMMIT again.
- *History:* `ai-streaming` happy path failed once in a full run, then passed 4×.
- *History:* `members` "returns 403 for non-member" failed once in a full run (2026-09-30), then passed 3× alone and on `main`.
- **Root `npm run build` / `tsc -p .` runs out of memory** (pre-existing on `main`): `test/integration/agora-mcp-package.integration.test.ts` imports `agora-mcp/src/*` and causes ~20M type instantiations. The Docker image only compiles `src/`, so prod builds are unaffected. To type-check locally, exclude that file.

## Cloud sessions (claude.ai/code)
- Used for code work when local usage runs out; Codex on the local machine runs the live checks. **A cloud session branches from `main` as it is when the session starts**: if a PR merges while it works (as #41 did), its branch is behind and needs `main` merged in.
- File-storing tests need no storage service any more: blobs go to a temp directory (`vitest.config.ts`).
- Docker needs `dockerd &` first. Create `accord_test_runner` by hand, and set `AGORA_ENCRYPTION_KEY` in `.env`. (`IP_ENCRYPTION_KEY` is no longer read.)

## Local environment (this machine)
- **The prod stack lives in WSL2 Ubuntu** at `~/agora`, on its own Docker Engine 29.x with gVisor `runsc`. **It is currently down and empty:** wiped on 2026-10-01 with `down -v` (no containers, no data volumes, no networks). The checkout is `main` at `49c78e5` and `.env.prod` is still there (`DOCKER_GID=986`, unused `MINIO_ROOT_*` lines; the keys in it belong to no data any more, so a fresh start simply records a new fingerprint). Left behind on purpose: the old `agora_minio-data` volume, the `agora-sbxtest-npm-cache` volume from the gVisor test script, and two database dumps in `~/agora-backups` (the only copies of the old instance's data). When the stack is up, the runner starts with `runtime=runsc`, no dev flag.
  - Run commands in the distro via `wsl.exe -d Ubuntu -- bash -s <<'EOF' … EOF` (stdin scripts; PowerShell 5.1 and inline `bash -lc` mangle quotes).
  - Run long `compose up --build` as a background task, or it dies when the `wsl.exe` session closes.
  - **The distro stops about a minute after its last `wsl.exe` session closes**, taking the stack down (happened 2026-09-30 when a shared terminal was closed). A logon scheduled task, **"WSL Ubuntu keep-alive (Agora stack)"** (`conhost --headless wsl.exe -d Ubuntu --exec sleep infinity`), now holds it open. Docker is systemd-enabled and services are `restart: unless-stopped`, so the stack comes back on its own. If `localhost:3000` is dead, check `wsl -l -v` and that task first. Setup: `docs/getting-started.md` step 7.
  - Deploy: `git pull` in `~/agora`, then `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build <services>`.
  - **After every deploy, check `curl -sk https://localhost/health`.** nginx in `web` resolves `api` once at startup; if `api` was recreated and `web` wasn't, the site returns 502 while `http://localhost:3000` works. Fix: `docker compose -f docker-compose.prod.yml --env-file .env.prod restart web` (WBS 6.9 removes the need).
  - The image runs with `NODE_ENV=production`. If `api` restarts in a loop after an env change, read `docker logs agora-api-1` first: it refuses a default or changed `AGORA_ENCRYPTION_KEY` and says so.
  - Browser: `https://localhost` (Caddy, local cert). Agents/MCP: `http://localhost:3000` (Node rejects Caddy's local cert).
  - Volumes when it is running: `agora_files-data` (uploads), `agora_pgdata`, `agora_redisdata`, `agora_caddy_data`. `docker compose down -v` removes those four and nothing else.
- **Docker Desktop (Windows)** still has the **stopped** old prod stack (compose project `agora`, with its own old `agora_pgdata` and other volumes; disposable test data) and the test infra. **Never** `docker compose up` the dev file there without `-p agora-test`. A standalone `agora-minio` container is also running there; nothing uses it. Setting Agora up from the Windows repo would land on that old stack and its old database volume: wipe it first or use WSL.
- Test infra: `docker compose -p agora-test -f docker-compose.yml up -d postgres redis`, plus `--profile sandbox up -d socket-proxy` for runtime work. No storage service: tests write blobs to a temp directory.
- Use an **isolated test DB** so parallel agent sessions don't truncate each other: DB `accord_test_threads`, Redis DB 1. A branch with a **new migration** needs its own database (`chore/remove-ip-tracking` used `accord_test_noip`): migrations are not reversible, so running it against a shared test DB breaks every other branch's tests there. Env via the scratchpad `testenv.sh`, or set `DATABASE_URL` / `TEST_DATABASE_URL` (both!) and `REDIS_URL=redis://localhost:6379/1`.
- Exclude agent worktrees from vitest: the default config excludes `.claude/**` and `test/sandbox/**`. **On gVisor:** `scripts/test-sandbox-gvisor.sh` from WSL (`cd /mnt/c/Users/miste/life-manager/Git_Projects/agora && bash scripts/test-sandbox-gvisor.sh`); it brings its own Postgres, Redis, socket proxy and network, runs the tests in a Node container, cleans up, and refuses to start while a real `agora-run-*` container is running (the suite removes them). Docker suite under runc: `npm run test:sandbox` (Docker Desktop, runc, needs `agora_sandbox` network + `agora/sandbox-deno:dev` image).
- **agora-mcp:** the global `agora-mcp` command is **0.4.0, linked to `agora-mcp/`** in the Windows checkout (`npm install -g .`). npm has only 0.1.2 until the publish described under "Current state"; **do not run `npm install -g agora-mcp`**, it would replace the link with the old version. Rebuilding that folder changes the installed MCP, but running agents keep the old code until their MCP server restarts.
- **Agents on Agora: none registered on this machine.** On 2026-10-01 the `agora` MCP server was removed from Claude Code (`claude mcp remove agora -s local`) and from Codex's project `.codex/config.toml` (now empty; a stale `config.toml.bak-20260930` with a dead token is still next to it). Gemini CLI and OpenCode never had one. To reconnect an agent, use the `agora-connect` skill against a running instance; Codex needs `tool_timeout_sec = 3600` on its `agora` entry for long `chat_wait` calls. Codex also keeps a worktree at `~/.codex/worktrees/4acd/agora` (clean, detached at an old `main`).
- Local Ollama is at `localhost:11434` (qwen3:14b, qwen3:32b, gpt-oss:20b, deepseek-r1:14b, …). Testing against it loads models into the 5070 Ti.
- Windows/Git Bash: `ln -s` copies instead of linking; Python heredocs in Bash mangle `\n` and `\\`. Write scripts to files with the Write tool instead.

## Key design decisions made along the way (not all in the spec)
- Bots get **one per-bot "Code runs" setting** (`users.runtime_access`: none / approval / auto) instead of an `ExecuteCode` role bit.
- The **runner mints run tokens** at run start (never in the queue); only SHA-256 hashes are stored.
- Code enters containers via **base64 env chunks** and output comes back via **capped `local` log driver + logs API**: no bind mounts, no attach (the socket proxy doesn't support hijack).
- The **socket proxy** only allows operations on `agora-run-*` container names and rejects bind mounts (verified). It needs the host's docker group (`DOCKER_GID`) on native Linux.
- **Under gVisor, sandboxes have no DNS.** The runner pins `cap-gateway:<ip>` in each run's `/etc/hosts` (spec §6). This also closes DNS tunneling.
- Artifacts leave only via the gateway (`postFile`, `/v1/reports`, video) through the shared `src/lib/file-store.ts`.
- **Files are encrypted by Agora before they reach storage** (`src/lib/file-store.ts` → `src/lib/storage.ts`), so the storage driver never sees plaintext. That is why MinIO could be swapped for a plain directory (#32) without weakening anything: the store only does put / get / remove on opaque blobs. `api` and `cap-gateway` share the `files-data` volume; sandboxes never mount it.
- Cross-process Socket.IO events go through the Redis **event bridge** (`src/lib/event-bridge.ts`) with an allowlist.
- The Docker host env var is `AGORA_DOCKER_HOST` (not `DOCKER_HOST`, so a sourced `.env` never hijacks the docker CLI).
- **AI settings changes are audited** (`src/lib/ai-audit.ts`, `GET /servers/:id/ai/changes`, "Recent changes" in the UI), recording actor, client, and before/after; key material never.
