# Session handoff (Claude coordinator), 2026-10-21 ~16:35 UTC

Start a new Claude Code session in this repo and say: "read docs/planning/session-handoff.md and continue in Agora".

## Goal of this phase
Run **every test in `docs/planning/beta-test-plan.md`**, fix what fails, Codex reviews every PR, Eryk merges and deploys (each needs his go). The post-beta roadmap is on hold.

## How to work in Agora (updated 2026-10-21)
1. **Codex coordination is top-level in #general** until #169 (cross-thread mention delivery) is fixed; Eryk closed the job-6 thread for that reason. Job threads stay for results (job 5 `01M5E4JXRH9ZHFF57S7SM355S4`, job 7 `01M5F9QE7CMPMQ79FPVH2796X5`, job 3 `01M5DSJW5KC3MHWVPEQ94SN6TH`).
2. Keep listeners armed: a haiku listener subagent per open thread plus one on #general itself (`chat_wait(channel=general, until=turn, timeout=3600)`), re-armed on every return.
3. **Codex (Sol 6.1) builds small fixes and reviews.** He runs with skipped permissions, so **never give him anything that deletes** (rm, branch -D, worktree remove, reset --hard, docker rm/down -v, DELETE/TRUNCATE/DROP, closing PRs). Integration tests TRUNCATE, so **Claude runs integration suites** on his branches (in `.worktrees/review-141`, junction-linked to `.worktrees/combined/node_modules`). He may run host/mcp/ui vitest.
4. Two bots alone at the top level hit the loop guard after 4 messages; Eryk has to post to clear it.
5. Never post a number you didn't run. Subagent results get spot-checked before posting.
6. No thoth voice for the rest of 2026-10-21 (Eryk at work).

## State
- **Live:** main `11e998c` (deployed 2026-10-21 00:00). Nothing merged or deployed since.
- **e2e instance** `agora-e2e` (8280/3200, WSL daemon): currently built from `test/combined-ops` @ `c8b9125` (candidate 80192a5 + ops-outage specs + #179 + #178). Rebuild from `.worktrees/combined` (80192a5) with `e2e/up.sh` when needed. If its Postgres stopped overnight, `up.sh` brings it back; after an api recreate, restart the web container (nginx caches the old api IP).
- Local test DB: Docker Desktop `agora-test-postgres-1` / `-redis-1` (`docker start` them if exited).

## Ready for Eryk's batch (all Codex+Claude AGREE, tests re-run by Claude)
- Earlier 15-PR batch on hold: candidate `80192a5` (#138 #139 #140 #144 #148 #151 #152 #153 #154 #156 #160 #161 #162 #163 #164). Merge order and checks: previous handoff section in git history (`a13b8bb`).
- New today: #167 (#165 codex key), #168 (#166 /start hello), #170 (#142 .cmd verify; stacked on #144), #173 (#141 user search; stacked on #144), #174 (#171 restore docs), #177 (#172 gemini ACP models), #178 (#175 stale git lock, `f8c5f11`), #179 (#176 503s + MCP retry, `4e18889`), #181 (#136 build OOM, `9349fab`), #186 (#182/#183 OpenAI token field + Test deadline, `d975584`).
- After merge: deploy needs its own go, then rebuild/restart AgoraHost (host code changed).

## Beta results today
- **Job 5 agent E2E (real CLIs):** 19/20 pass; A2 Gemini passes with #177 (flash-lite sometimes describes the hello instead of posting it). Runner `test/e2e-agent` @ `4be71ed`. Spend ~5.3M tokens (~$1–3). Codex Windows sandbox (`windowsSandbox: elevated`) pops a dialog that blocks unattended `codex exec`; future runs: `E2E_CODEX_WINDOWS_SANDBOX=unelevated`, or `E2E_A2_AGENTS=gemini`.
- **Job 7 §3.5:** complete. OP-02/03 pass with #178/#179; OP-04 upgrade, OP-05 restore (with roles)/wrong-key/key-rotate, strip-filenames pass; OP-06 providers (branch `test/ops-providers-soak`), OP-08 30-min soak pass (0 lost/dup/cross-tenant, p95 18 ms, RSS bounded). Harness branches: `test/ops-restore` @ `97d1dd4` (Codex AGREE), `test/ops-outage` @ `c383f78` (AGREE), `test/combined-ops`.
- Open issues from today: #169 (M, cross-thread mentions), #180 (L, test typecheck), #184 (L, speech-only Test 404), #185 (L, base URL UI + wake-budget notice). Older open: #150.

## Next
1. ~~Linux platform pass~~ done 16:40: mcp 173/173, host 299 + 7 skipped (node:22, `git archive` of agora-host, agora-mcp and src).
2. Codex: #184, then #185.
3. Eryk: merge/deploy go → manual sessions M01+ (beta-test-plan §7.1), macOS pass (needs the Mac agent).
4. Coverage gaps from PR #139 (41 rows, e.g. `SEC-01.rls-probe`).
