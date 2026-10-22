# Session handoff (Claude coordinator), 2026-10-22 ~01:35 UTC (Eryk: stop for tonight)

Start a new Claude Code session in this repo and say: "read docs/planning/session-handoff.md and continue in Agora".

## Goal of this phase
Run **every test in `docs/planning/beta-test-plan.md`**, fix what fails, Codex reviews every PR, Eryk merges and deploys (each needs his go).

## How to work in Agora
1. **Everything for Eryk goes in the active job's thread**, never top-level (he misses messages otherwise). Keep that thread's listener armed with `until="any"`.
2. Agent coordination: #194 (cross-thread wake) is live since `f1d8c58`. Once Codex confirms his agora-mcp has it (>= `cf37651` or 0.6.0), move Codex coordination into job threads too (#211: top-level #general is cluttered).
3. Codex (Sol 6.1) builds small fixes and reviews; **no deletion of any kind** for him (skip-permissions). Claude runs integration/E2E/live. Answer every `[YIELD to=Claude]` promptly; he waits.
4. Use fresh DBs for review runs (`CREATE DATABASE accord_review_<n>` on Docker Desktop `agora-test-postgres-1`, override both `DATABASE_URL` and `TEST_DATABASE_URL`). Auto-mode refuses deleting rows in the shared `accord_test`.
5. Never post a number you didn't run. Version for the app stays **0.5** (Eryk).

## State
- **Live: `9ef181c`** (deployed 2026-10-22 ~01:03 UTC; backup `~/agora-backups/pre-deploy-20261021-2103.dump` + roles `post-deploy-roles-20261021-2103.sql`). Migrations through 063. AgoraHost PID 38088, codex profile `windowsSandbox: unelevated`.
- Merged 2026-10-21: the 15-PR batch, #167 #168 #170 #173 #174 #177 #178 #179 #181 #186 #187 #190 #191 #192 #193 #194 #195, then #200 #201 #202 #203 #205 #208.
- **Open PR: #212** (agora-mcp 0.6.0 release bump), waiting for Codex review. After merge: `gh release create v0.6.0` from main (workflow attaches tarballs; tag must equal agora-mcp version). Then tell mac-bot (job 10 thread `01M5GJEAH7DQJQQH5PHP9A66BT`) to reinstall from releases/latest and retry `file_read` on image `01M5GJ7Q9AE1VS8JFEY9WY921K`.
- **Mac agent:** `mac-bot` (Claude Code on Eryk's Mac mini, tailnet 100.113.157.31) connected. Tailnet grant now `src ["my-phone","Mac"] → agora-home:443`; new devices must be added there. macOS pass done (#213).
- e2e instance `agora-e2e` is built from `test/combined-m01-m03`.

## Threads
- Job 9 manual sessions: `01M5G83H82XF52PN5WEC6S947W` (open). Ledger: `docs/planning/manual-ledger.csv`.
- Job 10 Mac agent: `01M5GJEAH7DQJQQH5PHP9A66BT` (open until the 0.6.0 retry).

## Tests left
- **Manual sessions M05–M21** (§5): M05 files, M06–M08 sessions/lurk/budget, M09 review, M10 cards, M11 tasks/canvas, M12 preview/handoff, M13 subtasks/voice, M14 voice/settings, M15 bots/admin, M16 PC files + terms, M17 channel/terminal, M18 SIWC approvals (disposable host), M19–M21 destructive (disposable instance). Then items 11 and 100 (Tailscale off, phone removal) last. M04 #22 to retest in a channel with notice runs.
- **Blocked:** runtime/code-run tests (#126, gVisor on a dedicated host).
- **Automated gaps:** WebKit Playwright project (#213), OP-04.host-version live run (code-reviewed only), A2 Gemini flash-lite hello flake.
- **Open beta issues:** #213 macOS/WebKit, #211 fold agent chatter, #210 Agents label, #209 second-install collisions, #206 storage-authority flake, #180 test typecheck, #150 e2e repeatability, #132 session/thread closure.
