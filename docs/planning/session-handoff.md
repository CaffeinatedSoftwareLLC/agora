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

## State (2026-10-21 ~20:45 UTC)
- **main @ `4b2e488`**: the 15-PR batch plus 14 PRs merged on Eryk's go (#167 #168 #170 #173 #174 #177 #178 #179 #181 #186 #187 #191 #190 #192). Tree equals tested `test/combined-beta-3` (unit 434, integration 1,149, UI 324, host 323+4, mcp 173, Playwright 84/84). Migrations 060/061/062.
- **Live: still `11e998c`. NOT deployed.** Deploy needs Eryk's go: backup, `agora-deploy.sh` (migrations 060-062; 061 stops and lists case-colliding usernames if any), then rebuild/restart AgoraHost.
- **Open PRs, both AGREEd, waiting on Eryk's merge go:** #193 (pin nginx 1.31.7-alpine + caddy 2.11.7 by digest), #194 (#169 chat_wait cross-thread attention, migration 063), #195 (coverage-gap tests on main, ledger 0 gaps, integration 1,204).
- **Release:** Eryk asked for "0.4.0"; the latest release is already v0.5.0 and `agora-mcp-release.yml` requires tag == agora-mcp version (0.5.0). Asked him to confirm **0.6.0** (bump root + agora-mcp, CHANGELOG Unreleased → 0.6.0, tag after merges). Pending.
- All job threads (3, 5, 6, 7, 8) closed. Codex coordinates top-level in #general.
- e2e instance `agora-e2e` is built from `test/combined-beta-3`. Local Docker Desktop test Postgres holds throwaway review DBs (accord_review_*, accord_cov*, accord_combined3); `accord_test` has a stale `060_case_insensitive_usernames` row (auto-mode refused deleting it; use fresh DBs).
- PHP "php2shell" CVE-2026-109618/109619 check (19:00): no PHP anywhere; live nginx 1.31.7.

## Beta results today
- **Job 5 agent E2E (real CLIs):** 19/20 pass; A2 Gemini passes with #177 (flash-lite sometimes describes the hello instead of posting it). Runner `test/e2e-agent` @ `4be71ed`. Spend ~5.3M tokens (~$1–3). Codex Windows sandbox (`windowsSandbox: elevated`) pops a dialog that blocks unattended `codex exec`; future runs: `E2E_CODEX_WINDOWS_SANDBOX=unelevated`, or `E2E_A2_AGENTS=gemini`.
- **Job 7 §3.5:** complete. OP-02/03 pass with #178/#179; OP-04 upgrade, OP-05 restore (with roles)/wrong-key/key-rotate, strip-filenames pass; OP-06 providers (branch `test/ops-providers-soak`), OP-08 30-min soak pass (0 lost/dup/cross-tenant, p95 18 ms, RSS bounded). Harness branches: `test/ops-restore` @ `97d1dd4` (Codex AGREE), `test/ops-outage` @ `c383f78` (AGREE), `test/combined-ops`.
- Open issues from today: #169 (M, cross-thread mentions), #180 (L, test typecheck), #184 (L, speech-only Test 404), #185 (L, base URL UI + wake-budget notice). Older open: #150.

## Next (after Eryk)
0. Eryk: merge #193/#194/#195, release number, deploy go.
1. ~~Linux platform pass~~ done 16:40: mcp 173/173, host 299 + 7 skipped (node:22, `git archive` of agora-host, agora-mcp and src).
2. Codex: #184, then #185.
3. Eryk: merge/deploy go → manual sessions M01+ (beta-test-plan §7.1), macOS pass (needs the Mac agent).
4. Coverage gaps from PR #139 (41 rows, e.g. `SEC-01.rls-probe`).
