# Beta coverage reconciliation

> Step 3 of [beta-test-plan.md](beta-test-plan.md) §7.1. Ledger: [beta-test-surfaces.csv](beta-test-surfaces.csv). Checker: `python docs/planning/check-coverage-ledger.py`.
> Original 439 rows are at baseline `ae0c0f3`; the 120 appended rows (S0440–S0559) are at `11e998c`. Written 2026-10-20.
> A mapping says which scenario should exercise a surface. It is not a pass: every scenario is still `not_run` unless a run ledger says otherwise.

## Counts

| kind | mapped | anchor | gap | excluded | total |
|---|---:|---:|---:|---:|---:|
| http_endpoint | 184 | 0 | 11 | 0 | 195 |
| mcp_tool | 33 | 0 | 2 | 0 | 35 |
| route_module | 36 | 0 | 0 | 0 | 36 |
| ui_feature | 14 | 0 | 0 | 0 | 14 |
| test_anchor | 0 | 178 | 0 | 1 | 179 |
| socket_event | 26 | 0 | 1 | 0 | 27 |
| worker | 10 | 0 | 1 | 0 | 11 |
| cli_command | 10 | 0 | 4 | 1 | 15 |
| migration_set | 12 | 0 | 21 | 0 | 33 |
| deploy_entrypoint | 9 | 0 | 1 | 4 | 14 |
| **total** | **334** | **178** | **41** | **6** | **559** |

What was appended (S0440–S0559):

- **17 HTTP endpoints the static scan missed.** 10 are on the API and were registered with template-literal paths: `PATCH`/`DELETE /channels/:id/tasks/:taskId`, `POST …/tasks/:taskId/start`, the four `/channels/:id/sessions/:sessionId/{workspace-commands,checkpoints}` routes and `POST /runtime/runs/:id/{approve,deny}`. The other 7 are `GET /health` on the API and six cap-gateway routes (`/health`, `/v1/*`).
- **3 test files** added after `ae0c0f3`: `FileAttachment.test.tsx`, `ArcChannelSidebar.test.tsx`, `threadStore.test.ts`.
- 27 socket events, 11 workers or background services, 15 CLI commands, 33 migration rows (the set, 11 auth-table migrations, 21 RLS-policy migrations) and 14 deployment entrypoints.

A route module counts as `mapped` when at least one of its endpoints is mapped. Its scenario IDs are the families of its endpoints.

## Gaps

41 rows that no plan scenario covers. The proposed IDs are **not** in the plan yet. Add them to §2–§6 before using them in the ledger: the checker rejects suffixed IDs the plan doesn't contain. Each "must assert" line follows §0: what the UI shows, what is persisted, and how many side effects happen.

| surface_id | entrypoint | family | proposed ID | must assert |
|---|---|---|---|---|
| S0005 | MCP `channel_list` | ID-05 | `ID-05.channel-list-revoke` | Lists exactly the bot's `bot_channel_access` channels. After `DELETE /channels/:id/bots/:botId`, the channel is gone from the list, `chat_read` on it gives 403, and 0 events reach the bot afterwards |
| S0032 | MCP `canvas_read` | UI-05 | `UI-05.canvas-read` | Version N reads back byte-identical to what was published. In a channel the bot can't see: 403 and no content |
| S0046, S0047 | `GET`/`PATCH /admin/settings/ai` (`allowPrivateBaseUrls`) | OP-06 | `OP-06.private-base-url` | With the flag off, a provider with a `127.0.0.1` or `10.x` base URL gives 400 and no provider row. An admin turns it on: 1 audit row, then the same request gives 201. A non-admin `PATCH` gives 403 and the setting is unchanged |
| S0048, S0049, S0496 | `GET`/`PATCH /admin/settings/runtime`; runner maintenance sweep | OP-01 | `OP-01.code-retention` | Shortening retention without `confirm` gives 409 `confirmation_required` and nothing changes. With `confirm`, the next sweep prunes code only on runs past the limit: `GET /runtime/runs/:id/code` gives 410 with `prunedAt`, newer runs keep their code, and stale approvals expire. The sweep runs in `runner-main`, so this is `blocked` until #126 unless the maintenance function is driven directly |
| S0056 | `DELETE /servers/:serverId/agent-hosts/:hostId` | ID-05 | `ID-05.host-revoke` | Owner gets 204 and `revoked_at` is set. The host token's next `runs/next` gives 401. The host's claimed runs are redelivered once after the lease expires. A non-owner gets 403 and the row is unchanged |
| S0060 | `DELETE /servers/:serverId/agent-profiles/:profileId` | AG-01 | `AG-01.profile-delete` | With a non-ended session: 409 and the profile is kept. After `/end`: 204, the profile row is gone, and the bot and its messages remain. A director gets 403 |
| S0063, S0064 | `POST /agent-hosts/@me/workspaces/{reconcile,warning}` | AG-07 | `AG-07.ended-worktree` | `/end` with uncommitted edits: the worktree is kept and exactly 1 notice lists the paths. A clean ended worktree is removed. A session with a claimed run or a queued workspace command is not reconciled |
| S0121 | `PATCH /servers/:serverId/bots/:id` | ID-05 | `ID-05.bot-edit` | A rename shows in the member list and mentions. A duplicate name gives 409. A caller without ManageBots gets 403 and the row is unchanged. A rename can't produce an `[OWNER]`-looking author (SEC-01) |
| S0123 | `DELETE /servers/:serverId/bots/:id` | ID-05 | `ID-05.bot-delete` | Tokens give 401 afterwards. The handler (`bots.ts:419`) queues no socket disconnect or room leave, so the scenario must find out whether an already-open bot socket keeps receiving channel events, and expect 0. Also check what happens to agent profiles that reference the bot |
| S0238 | `GET /users/search` | SEC-01 | `SEC-01.user-search` | Any authenticated human can search **all** instance usernames, not only server members, and `q` goes into `ILIKE` unescaped, so `q=%` lists up to 20 users. No UI calls it: `UserSearch.tsx` is not imported anywhere. Decide whether it should exist. If kept, assert outsider scope and that `%` and `_` are escaped |
| S0472 | Redis `agora:events` bridge (`event-bridge.ts`) | SEC-01 | `SEC-01.bridge-allowlist` | Publishing a non-allowlisted event or room gives 0 client deliveries and 1 warning. An allowlisted `Message` to `channel:<id>` gives exactly 1 delivery. `_GatewayAccessChanged` triggers a DB re-read and is never forwarded |
| S0506 | `agora-mcp --no-permission-relay` | AG-09 | `AG-09.no-permission-relay` | In channel mode with the flag set, 0 `permission-relays` rows are created and the prompt stays in the terminal |
| S0509 | `npm run key:rotate` | OP-05 | `OP-05.key-rotate` | On a disposable copy, every file and provider key decrypts under the new key and none still needs the old one. Interrupt and re-run: the run completes and no file is double-encrypted. Starting the API with the old key gives the fingerprint refusal |
| S0511, S0549 | `npm run storage:migrate-from-s3`; `docker-compose.minio-migrate.yml` | OP-04 | `OP-04.minio-migrate` | Only applies if an install still on MinIO is supported. N blobs are copied and a re-run copies 0, then files download and match byte for byte. If no such install exists, change these rows to `excluded:` with that reason |
| S0512 | `npm run storage:strip-filenames` | OP-04 | `OP-04.strip-filenames` | Pre-0.2.0 keys are renamed to `<channel>/<file>/blob`. A re-run renames 0, downloads are unchanged, and no file name is left in a storage path |
| S0517, S0522–S0524, S0527, S0530–S0545 (21 RLS migrations, from `006_row_level_security.sql` to `058_agent_handoffs.sql`) | RLS policies | SEC-01 | `SEC-01.rls-probe` | No plan scenario tests RLS separately from the route checks, so a route 403 would still pass with a broken policy. For each policy table, connect as `app_user` with an outsider's `app.current_user_id`: SELECT returns 0 rows, INSERT/UPDATE/DELETE affect 0 rows or raise, and a member sees exactly their rows |

## Exclusions

| surface_id | entrypoint | reason |
|---|---|---|
| S0437 | `test/unit/ulid.unit.test.ts` | ID-generator utility test; no scenario-level behaviour |
| S0507 | `agora-mcp --version` | Prints the package version and exits; no state or authority |
| S0548 | `docker-compose.yml` | Dev and vitest infrastructure (127.0.0.1 postgres/redis, optional voice profile), not a deployment |
| S0557 | `e2e/docker-compose.e2e.yml` | Test harness for the disposable instance, not shipped |
| S0558 | `e2e/up.sh` | Same |
| S0559 | `e2e/down.sh` | Same |

## Scenario IDs with no surface, and plan steps with no code

The checker finds **no** scenario ID in the plan, coverage review or spec titles that maps to zero surfaces. Two notes on that result:

- `AG-04.siwc-*` (§3.4 heading) is a wildcard and is ignored. `OP-06.<provider>.*` has no fixed ID, so only the `OP-06` family is checked.
- `OP-02.crash-before-claim / after-claim` (§3.5) gives the ID `OP-02.crash-before-claim` only. If `after-claim` is a separate scenario, spell it out as `OP-02.crash-after-claim`.

Several plan steps name features that have **no server route** at `11e998c`. They will fail as written, so rewrite or drop them:

| Plan text | Finding |
|---|---|
| §1.2 Moderation "Kick, ban, change roles"; §2.2 "Members page: moderator kicks `member-e2e`" | No kick endpoint exists. Ban is instance-admin only (`POST /admin/users/:id/ban`) |
| §1.3 Channels "rename it, delete it" | Only `POST /servers/:id/channels` exists. There is no channel `PATCH` or `DELETE` |
| Coverage review ID-04 "Server create/join/**leave**" | No leave-server or remove-member endpoint |
| §2.1 harness layout (`compose.e2e.yml` override, ports 3300/8380/8743, Caddy, `e2e/scripts/*`, `results/`) | The harness that was built differs: a self-contained `e2e/docker-compose.e2e.yml`, web 8280 / API 3200, plain HTTP, no Caddy, `artifacts/<run-id>/`. See [beta-env-manifest.md](beta-env-manifest.md) |
| §0 and §2.1 seeded users and bots (`director-e2e`, `claude-e2e`, `codex-e2e`, `gemini-e2e`) | `global-setup.ts` seeds `owner-e2e`, `member-e2e` and run-tagged agents only. There is no director user and no Gemini profile yet |

Not a plan problem, but found while reading: `src/app.ts:98` and `:110` exempt `/webhooks/*` from the instance-initialized and auth checks, and no `/webhooks` route exists. Any route added under that prefix later would skip authentication by default.

## Method and limits

The 439 original rows were mapped by reading each endpoint's handler at its listed source line: its auth preHandler (`requireOwner`, `requireAdmin`, `requireInstanceAdmin`, `requireManageBots`, `canViewChannel`, `stampAuthority`, bot-only or human-only checks) and its error codes. Each was matched to the §1 feature rows, the §2.2, §3.3–§3.5, §5 and §6 scenarios, the family text in the coverage review, and the `[ID]` titles in `e2e/tests/*.spec.ts`. Endpoints that enforce owner, director, admin or bot-only authority also carry a SEC family.

A family ID alone (for example `ID-05`) means a plan feature row or the family's own description names the behaviour, but no suffixed scenario does yet. Those rows are `mapped` and still need concrete cases. Test files are `anchor`, never evidence of a pass.

The appended rows came from code searches at `11e998c`:

- socket events: `pendingEvents.push`, `.emit(`, `socket.on(`, the event-bridge allowlist
- workers: `src/workers/*`, `setInterval` sweeps, `runner-main`, `gateway-main`
- CLI commands: `bin` entries, the `agora-host`/`agora-mcp` argument parsers, `package.json` scripts
- migrations: `CREATE POLICY` / `ROW LEVEL SECURITY` / `SECURITY DEFINER`, and `ALTER`/`CREATE TABLE` on auth tables
- deployment: compose files, Dockerfiles, `nginx.conf`, `Caddyfile`, `setup-env.js` and the release workflow

Limits:

- This was static reading only. Nothing was executed against an instance.
- Dynamic registration beyond template literals, and UI-only behaviour inside the 14 feature folders, were not enumerated per component.
- The 11 auth-table migrations are mapped to `OP-04.upgrade` because the plan covers them applying cleanly, not because their constraints are probed.
- Scripts that only run tests (`scripts/test-*.sh`, `scripts/lib/engine-guard.sh`) and `scripts/sync-skills.js` were not added as surfaces.
