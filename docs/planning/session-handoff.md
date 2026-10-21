# Session handoff (Claude coordinator), 2026-10-21 early morning

Start a new Claude Code session in this repo and say: "read docs/planning/session-handoff.md and continue in Agora".

## Goal of this phase
Run **every test in `docs/planning/beta-test-plan.md`**, fix what fails, Codex reviews every PR, Eryk merges (except where he gives a standing order). The post-beta roadmap is on hold.

## How to work in Agora
1. **One START post in #general per job, and everything else goes in that thread**, including status and questions for Eryk. Nothing top-level.
2. **Always keep a listener on every open thread:** `chat_wait(channel=general, thread=<start id>, until=turn, timeout=3600)`. A blocking chat_wait stalls the coordinator, so run each one in a listener subagent (it only calls chat_wait and returns the output) and re-arm it whenever it returns.
3. A Claude subagent isn't in Agora. Post its results in the thread yourself, **after** reading its diff and re-running its tests. Never post a number you didn't run (this session had to correct itself twice).
4. Codex treats Eryk's standing order as authorization for `[YIELD to=Codex]` reviews. The thread starter closes the thread after DONE.
5. Questions for Eryk also go through `thoth-tts speak`.

## State (2026-10-21 ~00:30)
- **Live stack:** main `11e998c`, deployed 2026-10-21 00:00 on Eryk's go (backup `~/agora-backups/pre-deploy-20261020-1954.dump`). Merged and deployed: #131 (e2e harness), #133 (nginx anchor + Vary), #134, #135.
- **Disposable e2e instance:** `agora-e2e` on the WSL daemon (web 8280, api 3200), built from `.worktrees/combined` at main. It has extra instance-lifetime users: `director-e2e`, `admin-e2e`, `outsider-e2e`, `fkdirector-e2e` (registration is limited to 5 per hour).
- **Worktrees have no `.env`:** load the repo's (`set -a && . <repo>/.env && set +a`), or tests fail with `28P01`. Root `npm run build` runs out of memory on main (#136); type-check `src/` alone with a temporary tsconfig instead.

## Open PRs (all reviewed by Codex in #general thread `01M5DVWVMHZSBKXQ13PE4MFTCZ`)
| PR | What | Review |
|---|---|---|
| #138 | agora-host tests pass on Linux and without gh (#137) | clear |
| #139 | coverage ledger reconciled, report, env manifest | clear |
| #140 | e2e wave A1 (chat/roles/files/bots) + secret-aware failure evidence | P2 resolved |
| #144 | §6 security checks; #142/#143 as linked `it.fails` | P2 resolved |
| #148 | host accepts `pr_status` (#145) | clear |
| #151 | e2e wave A2: fake agent host + session specs; build provenance | P2 fixes pushed (`6f624c9`, `608a619`), awaiting re-review |
| #152 | own message shown twice (#149) | new |
| #153 | tool card buttons only for owner/directors (#146) | new |
| #154 | rate-limit chip shows Sleeping + reset (#147) | new |

Combined candidate: local `.worktrees/combined` branch `test/combined-beta-2` = main + #138, #139, #140, #144, #148, #151, #152, #153, #154 (clean merge). Non-E2E suites were running on it. The E2E run needs the instance rebuilt from that branch **after wave B finishes**. Then post the results in the review thread, get Codex's DECIDE, and ask Eryk to merge (he merges these; the earlier "merge after Codex approves" order covered only #131 to #135).

## Running jobs (threads in #general)
- **Job 3, Playwright E2E** (`01M5DSJW5KC3MHWVPEQ94SN6TH`): wave B (setup/auth/admin/storage/mobile, which changes instance-wide settings) runs as a subagent on local branch `test/e2e-wave-b`, built on wave A1.
- **Job 4, §6 security** (`01M5DSMN39H2T0RRDBJMVC5X5Z`): done, in PR #144. Waiting on Eryk's #143 decision: A = check the cache before the tts limit (recommended), B = keep it and delete the test.
- Jobs 1 and 2 are closed.

## Open beta-test issues
#136 (tsc OOM), #137 (fixed in #138), #141 (M: /users/search instance-wide, wildcards), #142 (L: `.cmd` verify), #143 (L: tts cache, decision pending), #145 (fixed in #148), #146 (fixed in #153), #147 (fixed in #154), #149 (fixed in #152), #150 (L: e2e not repeatable with `--repeat-each`). Plan wording questions: there's no kick endpoint, and channel rename/delete and leave-server don't exist (PR #139 report).

## Next in beta-test-plan §7.1
After the merges: manual 5-check sessions with Eryk (one thread each; live is on `11e998c`), agent E2E with test keys (ask Eryk "keys in?" first; keys at `C:\Users\miste\.agora-test\keys.env`, never print them), operations and recovery (§3.5), platform passes (agora-host on Linux passes after #138, run in a `node:22` container), fix wave (#141, #142, #143, #150, plus the 41 coverage gaps such as `SEC-01.rls-probe`). Runtime/code-run tests stay blocked until #126.

## Rules (also in memory)
- Never start a second Docker engine in another WSL distro. Never run `scripts/test-sandbox-gvisor.sh` on the live daemon.
- Deploys need Eryk's go each time (`MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash /mnt/c/Users/miste/agora-deploy.sh`). After a host-code merge such as #148, rebuild and restart agora-host.
