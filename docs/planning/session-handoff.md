# Session handoff (Claude coordinator), 2026-10-23 ~02:25 UTC

Start a new Claude Code session in this repo and say: "read docs/planning/session-handoff.md and continue in Agora".

## State
- **Live: `62a9c65`** (deployed 2026-10-23 ~02:18 UTC). Migrations through **067**. Backups `~/agora-backups/pre-deploy-20261022-2217.dump` + `post-deploy-roles-20261022-2218.sql`.
- Merged and live on 2026-10-22: #215 #216 #221 #225 #226 #227 #228 #232 #233 #235 #238 #217 #240 #242 #245 #243.
- AgoraHost autostarts (it survived an accidental PC reboot). Deploy: `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash /mnt/c/Users/miste/agora-deploy.sh`, then the roles backup, then **re-arm every Agora listener** (each deploy breaks chat_wait).
- The owner gave a **standing go**: merge and deploy anything that's tested (full integration on a fresh DB plus the browser suite, main tree equal to the tested tree), reviewed (Codex, or an independent Claude reviewer while Codex is out) and backed up. Don't ask per PR.
- Codex ran out of usage on 2026-10-22 ~20:30 UTC. His queue is empty. #230, #231, #234 and #236 are unassigned.

## Threads (#general)
- Job 9c, status and owner updates: `01M5J7SPC4T21GDVPA8M2TK2AB` (71+ replies; #221 fixed the 50-reply limit).
- Job 11, Codex fix wave: `01M5HRNYM37NQZ114K0S1RFNVF`.
- Job 12, decision models: `01M5JE5Q4177M6B2VKMSMM1W2J`.

## Video
- **v3 is final**: `video/out/agora-features-v3.mp4` (2:30, Terracotta, the owner's voice-over levelled to -16 LUFS, a lofi bed about 20 dB under). The project is `video/agora-features/` (composition AgoraFeaturesV3; the real-text scenes come from `real-text.json` with the owner's name redacted). The owner plans to post it to r/vibecoding; a draft post is in the job 9c thread.

## Open issues worth picking up
- **#241 (M):** Settings → Bots renders every bot and re-renders the whole list about every 0.6 s. It makes ID-05/ID-04 e2e fail on the populated e2e instance.
- #244 (stale approval cards), #246 (follow-ups from the #245 review), #236 (key redaction in the chat, search and speech adapters), #230 (agent liveness and usage monitoring), #231 (local bge-small RAG), #234 (Decision models settings page), #206 (storage-authority race), #150 (e2e flakes).
- Manual beta sessions M07–M21 are still open (see `docs/planning/manual-ledger.csv`). Agent-session sessions need a separate test agent (`scout`), so they don't collide with the terminal Claude and Codex.

## Working rules learned 2026-10-22
- Check running jobs yourself every few minutes (processes, log tails). Subagent monitors fail silently.
- Listener subagents must retry through `fetch failed` for at least 15 minutes and never stop just to report status.
- Never `git worktree remove`; worktrees share node_modules through junctions.
- The repo is public: fix security findings before describing them in issues, and use neutral PR wording.
