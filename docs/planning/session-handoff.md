# Session handoff (Claude coordinator), 2026-10-20 evening

Start a new Claude Code session in this repo and say: "read docs/planning/session-handoff.md and continue in Agora".

## Goal of this phase
Run **every test in `docs/planning/beta-test-plan.md`**: automated families, E2E, the manual 5-check sessions, and (once keys are in) the agent tests. Fix what fails, Codex reviews every PR, and merge when Eryk says. The post-beta roadmap is on hold.

## How to work in Agora (the last session got this wrong, read it first)
1. **One START post in #general per job, and everything else goes in that thread.** That covers Codex's turns, your replies, test results, and questions and status for Eryk. Don't post top-level status in #general.
2. **Always keep a listener on the active thread:** `chat_wait(channel=general, thread=<start id>, until=turn, timeout=3600)`. Re-arm it the moment it returns, in the same turn. A channel `chat_read`/`chat_wait` does **not** show thread replies. Codex once waited about an hour because of this.
3. **Don't claim work that isn't visible.** A Claude subagent isn't in Agora. If you say "running X", post progress and results in the thread, or run it yourself.
4. **Verify subagent output yourself before handing it to Codex.** Read the diff and run the tests. Last session, Codex found issues that the coordinator should have caught (the open `Vary: Accept` question was sent for review unfixed, and the #135 race went unreviewed).
5. Codex only acts on Eryk's orders (he directs it in the thread). The thread starter closes the thread after DONE. Codex gets a 403 closing a thread under someone else's message (#132).
6. Questions for Eryk also go through `thoth-tts speak`.

## State
- Live stack at `ae0c0f3` (WSL `Ubuntu`, deploy via `C:\Users\miste\agora-deploy.sh`, memory `local-test-env`). AgoraHost scheduled task runs the agent host. Codex is connected from a terminal (session `01M5DH3264CE8BRTAA1XFQV2WJ`).
- **Eryk's standing instruction (22:26):** merge #131, #133, #134 and #135 **after Codex approves**. Before merging, run the full suite on the combined branch.

## Open PRs
| PR | What | Status |
|---|---|---|
| #131 | E2E harness (`test/e2e-harness`, head `a0f7fff`) | **Codex AGREE**. Review thread closed. Uploads hard-off (`PIXEL_REVIEW=false`). Engine guard is in `scripts/lib/engine-guard.sh` with tests in `scripts/test-engine-guard.sh` (11 pass). Canvas egress is checked with an intercepted canary |
| #133 | Fixes #127 nginx admin reload (`fix/127-nginx-route-anchor`, `e89a202`) | **Changes requested**, see below |
| #134 | Fixes #130 keyboard file and image cards (`fix/130-file-card-keyboard`, `27a9558`) | **Codex: no blocking findings** |
| #135 | Fixes #128 thread bar and #129 online count (`fix/128-129-realtime-ui`, `b03c9e5`) | **Changes requested**, see below |

Active review thread: **#general thread `01M5DPSC8DJ9VK3GQ64TEHJW3R`**. Codex's TURN (22:30) lists the findings. Nothing has been replied yet; the next post there is ours.

### To fix (do it yourself, then post new SHAs in that thread)
1. **#133, P2 (Codex):** add `Vary: Accept` to **both** responses: the final `/index.html` after the `rewrite ... last` (adding it only in the admin location doesn't cover that response) and the proxied JSON for `/admin/users` and `/admin/storage`. Add a header regression check for HTML and JSON, ideally a browser navigation followed by an API fetch with the cache on.
2. **#133, test break (found by the combined run):** `test/unit/nginx-routes.unit.test.ts:18` parses the proxy regex with `/location\s+~\s+\^\/\(([\w|-]+)\)\s*\{/`. The new `(/|$)` suffix doesn't match, so the test throws. Update the parser. Don't drop the anchor.
3. **#135, P2 (Codex):** `agora-ui/src/stores/threadStore.ts:337-344` drops invalidations that arrive during a refresh. Repro: list=[]; event for new thread A starts a fetch; event for B arrives while it's pending; fetch resolves [A], so B is lost and nothing refetches. Mark the channel dirty and run a trailing refresh. An older snapshot must not overwrite newer reply or closure metadata. Add the deferred-response regression test (Codex's check failed with `expected ['thread-A'] to include 'thread-B'`).

### Then
- Rebuild the combined branch (`.worktrees/combined`, local only; recreate it from origin/main and merge #131, #133, #134 and #135 in that order with the new heads). Run backend build, unit and integration tests, UI lint, `vite build` and vitest, `bash scripts/test-engine-guard.sh`, and the e2e smoke (`e2e/README.md`). The smoke run should now pass the old #127–#130 failures. Lint has 15 errors already on main.
- The last combined run was stopped midway. Its integration run on the Docker Desktop `agora-test` infra hit a Postgres auth failure (`28P01`) from `.worktrees/combined`. Check that the `.env`/`DATABASE_URL` there matches the `agora-test` compose credentials.
- Post the results in the thread, get Codex's AGREE, merge, deploy only on Eryk's go, and close the thread.

## Left running / leftovers
- Docker Desktop: `agora-test-postgres-1` and `agora-test-redis-1` (test infra, fine to keep or stop).
- WSL daemon: the `agora-e2e` instance is up (web :8280, api :3200), built from `.worktrees/e2e`. Stop it with `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash e2e/down.sh agora-e2e` from that worktree before bringing one up from the combined branch.
- Test keys: `C:\Users\miste\.agora-test\keys.env` (`AGORA_TEST_ANTHROPIC_KEY`, `AGORA_TEST_OPENAI_KEY`, `AGORA_TEST_GEMINI_KEY`). Never print the values; use them only on the test instance. Ask Eryk "keys in?" before the agent tests.

## Next, after the merges (beta-test-plan.md)
- The rest of the automated families and E2E specs beyond smoke, the manual 5-check sessions with Eryk (one Agora thread per session), and the agent tests with keys.
- Deferred, gating any screenshot-upload enablement: a pixel-aware leak review plus rendered-input, image and canvas canaries.
- Runtime and code-run tests stay **blocked** until #126 (instance-scoped runtime containers) or a separate VM or remote Docker host.

## Rules (also in memory)
- Never start a second Docker engine in another WSL distro. Never run `scripts/test-sandbox-gvisor.sh` on the live daemon (the guard now refuses anyway).
- Merges and deploys need Eryk's go each time. Codex reviews every PR. Combine the PRs and run the full suite before merging.
- Delegate builds and test runs to subagents if you like, but verify the results yourself and report them in the thread.
