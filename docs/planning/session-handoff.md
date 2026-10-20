# Session handoff (Claude coordinator), 2026-10-20

Start here in a new Claude Code session in this repo. Talk to Eryk in **Agora #general** (he asked: "start using agora"); Codex reviews via top-level/thread `@codex` from Eryk (agents only take orders from the owner).

## State
- Live at `ae0c0f3` (WSL `Ubuntu`, deploy via `C:\Users\miste\agora-deploy.sh`, see memory `local-test-env`). Agent host runs from the `AgoraHost` scheduled task (auto-start, #116). Codex profile = `siwc` (Eryk's ChatGPT plan); Claude = subscription, owner-only.
- Merged this stretch: #89–#125 (features, terms package, SIWC, terminal sessions, images, mentions/drawer, host commits, handoffs, Codex approvals, test plan).
- Phase: **polish + exhaustive testing**; post-beta roadmap is on hold. Then a separate session makes the demo video.

## In flight
- **E2E harness** (subagent, branch `test/e2e-harness`, worktree `.worktrees/e2e`): Playwright + advisory Haiku vision judge, separate compose project `agora-e2e` (no runner — #126). It opens a PR and files `beta-test` issues. If the session that spawned it is gone, check `gh pr list` / the branch.
- **Test keys**: Eryk is filling `C:\Users\miste\.agora-test\keys.env` (names only: `AGORA_TEST_ANTHROPIC_KEY`, `AGORA_TEST_OPENAI_KEY`, `AGORA_TEST_GEMINI_KEY`; caps ~$10/$25/$10). Never print values. Use them only on the test instance with api_key profiles.
- Plan: `docs/planning/beta-test-plan.md` (+ Codex's ledger/review files). Manual checks in 5-check sessions.

## E2E harness result (2026-10-20)
PR #131 (`test/e2e-harness`, not merged): smoke 23 scenarios, 20 pass, 3 fail = real bugs #127 (admin route reload returns JSON: nginx regex unanchored), #128 (new thread missing from active-threads bar until reload), #129 ("0 online" until member list opened), #130 (file card not keyboard reachable). Vision judge built (model/prices verified, URLs in vision.config.json), not yet run (needs keys). e2e instance may still be up: web :8280, api :3200; stop with `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash e2e/down.sh agora-e2e` from `.worktrees/e2e`.

## Open issues
#126 runner cleanup not instance-scoped · #115 done in #122 (verify closed) · #93/#84 done · watch `beta-test` label.

## Rules learned (also in memory)
- Never start a second Docker engine in another WSL distro (shared network; took live down ~10 min). The `agora-test` distro exists, stopped; don't start dockerd there.
- Merges/deploys need Eryk's go each time; combine PRs + full suite before merging; Codex reviews every PR.
- Delegate builds/verification to subagents (Haiku for plain test runs); keep the coordinator's context small.
