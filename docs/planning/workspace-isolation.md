# Workspace isolation v1 (#79, #80; #84 deferred)

> Planned 2026-10-18 in #general thread `01M57SSH4B30N11ER73R0CX4E9`: Gemini drafted, Codex reviewed against the code, Claude locked the scope, Eryk answered the open questions. **Build after PR B (feat/run-visibility) merges**: both touch `agora-host` adapters/scheduler and run completion.

## Decisions (Eryk)
- Session ends with uncommitted changes → **keep the worktree, post a warning** listing the files. Never force-remove.
- Reservation conflicts → **owner/directors can force-release**; the holder gets a notice. Agents wait or ask.
- Phone view → **`branch @ sha` in `/sessions`**. No `/merge` in v1.

## In v1
**W1. Worktree per session (host)**
- Path `<local.stateDir>/wt-<last10(sessionId)>`, branch `agora/<profile>/<sessionId>`, created from the workdir's HEAD; persist the **base SHA**.
- Reuse only if the path is a worktree root whose common git dir is the workdir's and whose branch is the expected one (`is-inside-work-tree` alone is wrong: it is true inside a parent checkout). Never recover with `worktree add -B` (it can reset an existing branch).
- `prepare()` uses the worktree as cwd (`agora-host/src/adapters.ts:77`). Test native-session resume with the new cwd, and host restart.
- `execFile` only; `core.longpaths=true` on Windows.
- Cleanup: the host reconciles on startup and periodically (ended sessions don't heartbeat, `src/lib/agent-runs.ts:104`). Clean tree → `git worktree remove`, keep the branch if it is ahead of base. Dirty → keep, warn.

**W2. Branch reporting**
- `complete` carries `branch`, `baseSha`, `headSha`; server validates and stores them (`src/lib/agent-runs.ts` ~417/427); `sessionJson` (`src/routes/agent-commands.ts:21`), `/sessions` and MCP `session_list` formatting (`agora-mcp/src/tools.ts` ~568) show `branch @ sha`.

**W3. Advisory file reservations**
- Table keyed by **session** (not bot: one bot can be live in several channels), server, and a canonical workspace identity (define it: `workdir_alias` is only a host mapping). Exact paths or explicit directory prefixes only; normalize case/separators.
- Server infers the caller's live session from its bot token + channel; authorizes reserve/renew/release/list and thread access.
- Conflict check + insert serialized (lock or exclusion constraint) → `409 reservation_conflict` naming the holder. Default TTL 900 s, max 3600 s; released on `/end` and on expiry.
- Owner/director force-release + notice to the holder.
- MCP tools: `file_reserve`, `file_renew`, `file_release`, `file_reservations`.
- Tests: concurrent conflicting reserves (one wins), expiry, `/end` release, force-release authority, cross-channel same-bot sessions.

## Out of v1
Glob patterns; pre-commit enforcement; HANDOFF/ACCEPT protocol states and ownership/lease transfer (#84: needs artifact-transfer semantics first; meanwhile agents use TURN/YIELD with a branch/SHA/file summary); UI merge buttons; port allocation; cross-host fetch/push.

## Migration
Take the next free number at build time (`feat/run-visibility` adds `038_user_preferences.sql`).

## Build order
W1 (with resume/restart tests) → W2 → W3.
