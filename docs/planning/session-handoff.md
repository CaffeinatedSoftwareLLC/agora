# Session handoff (Claude coordinator), 2026-10-21 ~03:20 UTC (paused for the night by Eryk)

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

## Approved batch, on hold (2026-10-21 02:48)
Codex **AGREE**d the combined candidate `80192a5` (local `.worktrees/combined`, branch `test/combined-beta-2`) at these heads:
#138 `655b02d`, #139 `ea9ddab`, #140 `7bf4d89`, #144 `7be585f`, #148 `d686677`, #151 `6406ef6`, #152 `4edbb70`, #153 `3b9dc6b`, #154 `63d439f`, #156 `befe0db` (stacked on #144), #160 `85fa1ff` (stacked on #140), #161 `badbd9b`, #162 `d290f54`, #163 `2579e78` (migration 060), #164 `a6e24f9`.
Results on `80192a5`: Playwright 84 passed / 0 failed / 2 n/a; integration 1075; unit 341; UI 292; host 290 + 4 skipped; mcp 161.
**Eryk: "we wait for tests"**. Don't merge or deploy until he says so. When he does: merge in the order above with `gh pr merge --merge --match-head-commit <sha>`, retarget #156 and #160 to `main` once their parents have merged, then check that main's tree equals `80192a5`. Any head change needs a Codex re-review. Deploying needs its own go: run `agora-deploy.sh`, then rebuild and restart AgoraHost (#148 changes host code).

## Where to resume (Eryk: "resume tests tomorrow")
- **Batch on hold:** the 15-PR candidate `80192a5` was approved by Codex (see above). Don't merge or deploy until Eryk says.
- **Job 5, agent E2E** (thread `01M5E4JXRH9ZHFF57S7SM355S4`, still open). Runner branch `test/e2e-agent` (pushed, head `b2b3b5f`, already includes `80192a5`); its worktree is `.claude/worktrees/agent-a073e7290a7077859`.
  - Live command (in `e2e/`): `E2E_AGENT_LIVE=1 E2E_CODEX_KEY_ENV=CODEX_API_KEY E2E_MODEL_CLAUDE=claude-haiku-5-5 E2E_MODEL_CODEX=gpt-6-luna E2E_MODEL_GEMINI=gemini-3.1-flash-lite E2E_AGENT_TOKEN_CAP=1500000 npx playwright test tests/agents-live.spec.ts`. Keys come from `~/.agora-test/keys.env`; never print them.
  - Last run: 3 passed (A9, A15, A19). The 15 failures all came from **#166**: each setup waits for the /start hello. Spend so far is about 1.57M tokens, roughly under $1.
  - **Next:** merge `fix/166-start-hello` (PR #168) and `fix/165-codex-api-key-env` (PR #167) into `test/e2e-agent` locally, then re-run A1 to A20. Once #167 is in, drop `E2E_CODEX_KEY_ENV` (the host passes `CODEX_API_KEY` itself). Then send #167 and #168 to Codex for review.
  - Each /start wake costs about 50k tokens (Claude Code's own prompt), so budget for that.
- **Job 3 E2E thread** `01M5DSJW5KC3MHWVPEQ94SN6TH`: done (84/84 on the candidate). Close it after the merge.
- After job 5: operations and recovery (§3.5, destructive, disposable instance only), manual sessions M01 and on with Eryk (live is still `11e998c`, so deploy first), platform passes.
- Listener subagents time out after an hour; re-arm on the open threads when resuming.

## Open beta-test issues
#136 (tsc OOM), #137 (fixed in #138), #141 (M: /users/search instance-wide, wildcards), #142 (L: `.cmd` verify), #143 (L: tts cache, decision pending), #145 (fixed in #148), #146 (fixed in #153), #147 (fixed in #154), #149 (fixed in #152), #150 (L: e2e not repeatable with `--repeat-each`), #155/#157/#158/#159 (fixed in the batch: #161-#164), #165 (codex OPENAI_API_KEY, fix PR #167), #166 (no hello after /start, fix PR #168). Plan wording questions: there's no kick endpoint, and channel rename/delete and leave-server don't exist (PR #139 report).

## Next in beta-test-plan §7.1
After the merges: manual 5-check sessions with Eryk (one thread each; live is on `11e998c`), agent E2E with test keys (ask Eryk "keys in?" first; keys at `C:\Users\miste\.agora-test\keys.env`, never print them), operations and recovery (§3.5), platform passes (agora-host on Linux passes after #138, run in a `node:22` container), fix wave (#141, #142, #143, #150, plus the 41 coverage gaps such as `SEC-01.rls-probe`). Runtime/code-run tests stay blocked until #126.

## Rules (also in memory)
- Never start a second Docker engine in another WSL distro. Never run `scripts/test-sandbox-gvisor.sh` on the live daemon.
- Deploys need Eryk's go each time (`MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash /mnt/c/Users/miste/agora-deploy.sh`). After a host-code merge such as #148, rebuild and restart agora-host.
