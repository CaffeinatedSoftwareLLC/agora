# Handoff: Agora from Eryk's phone (2026-10-17, ~14:55 UTC)

**Goal:** Eryk uses his Agora instance from his phone (Android, `eryks-s26-ultra`) to direct the agents on his Windows PC, without exposing anything to the internet. Planned with Codex in Agora (#general, planning thread `01M550QH905XYHYYW3EB6CTDNY`, work thread `01M551ZCPDNNVXNY48YPS54H6S`). Codex ran out of usage at ~14:37 UTC; Claude carries on alone.

**Rule for the whole job:** nothing is used remotely until step D passes. In D, each check is reported as *live-verified*, *source-reviewed* or *pending*. A check that couldn't be run is pending, never passed.

## Done and merged to `main`

| PR | What | Author / reviewer |
|---|---|---|
| #53 | README: npm date removed (npm publish still blocked, see below) | Claude |
| #54 | A1: login attempt limits (per account, before argon2, instance budget, Redis errors → 503, `login:unlock`) | Claude / Codex |
| #55 | A3: agora-mcp envelope: message text can't forge lines, tags or authors; author IDs shown | Claude / Codex |
| #56 | A2(i): WebSocket access: ViewChannel-filtered rooms, bot pause/owner checks, eviction on access loss, read/write gate, tripwire eviction via the event bridge | Codex / Claude |
| #57 | A2(ii): `token_version`, **Log out all sessions**, per-token socket eviction, expiry timers (migration 035) | Codex / Claude |
| #58 | B: **DirectAgents**: owner-only permission bit 29 for humans, owner-only `can_direct` for bots, authority stamped per message and rechecked on read, `[OWNER]`/`[DIRECTOR]` tags, `who_directs`, Rule 10 in all skill copies, UI switches (migration 036) | Claude / Codex |
| #59 | C: `docker-compose.tailnet.yml` + [`docs/remote-access.md`](../remote-access.md) | Claude / Codex |

## Deployed

The live WSL stack (`~/agora` in the `Ubuntu` distro) runs `main` at `a8f9e61` with the tailnet override, so #54–#59 are live. That is **not** #60. Database backup taken before migrations 035/036: `~/agora-backups/pre-035-036-20261017-1027.sql`.

Verified live: 36 migrations; every published port on `127.0.0.1` (api :3000, caddy :80/:443, web :8080); `/health` 200 through Caddy and :8080; `https://localhost` 200 from Windows (Caddy on loopback still reachable through WSL's localhost forwarding).

Deploy command (run as a background task, or the build dies when the `wsl.exe` session closes):
```bash
wsl.exe -d Ubuntu -- bash -c 'cd ~/agora && git pull --ff-only origin main && docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d --build'
```
Afterwards check `curl -sk https://localhost/health`. If it returns 502, restart `web` (WBS 6.9).

## Open, in order

### 1. PR #60: REST visibility (Codex's, finished by Claude). Merge, then deploy

`fix/channel-view-access`: messages, threads, ack, unreads, the channel list and **run views** now need ViewChannel, not just membership. The 403 text changed to `Channel access denied`. Claude added the commit Codex left uncommitted, plus a fix to its test (invalid `gate_decision`). Visibility tests: 5/5. A full-suite run was in progress at handoff: check it, then merge and deploy. Codex reviewed its own first commit only. The run-view change and test fix are Claude's, small, and unreviewed by a second agent.

### 2. Tailscale: Eryk's part (partly done)

Done by Eryk: Tailscale installed in WSL `Ubuntu` and signed in. The machine is **`tim`** (`100.88.102.93`, `tim.tail995bbc.ts.net`), the phone is `eryks-s26-ultra` (`100.82.231.57`). MagicDNS is on. No serve config, no Funnel.

Still needed from Eryk (admin console):
- **DNS → HTTPS Certificates → Enable.** At handoff `CertDomains` was empty.
- **Access controls**: back up the current policy, then:
```json
{
  "hosts": { "agora-home": "100.88.102.93", "my-phone": "100.82.231.57" },
  "acls": [ { "action": "accept", "src": ["my-phone"], "dst": ["agora-home:443"] } ]
}
```

### 3. Exposure found during setup (fix before D)

All WSL2 distros share one network, and Docker Desktop publishes its containers on `0.0.0.0`. So these Docker Desktop containers listen on every interface, **including `tailscale0`**, and probably the LAN:
- `agora-test-postgres-1` (5432), `agora-test-redis-1` (6379, **no password**): the test infra.
- **`agora-minio` (9000/9001): an old MinIO left running from before #32.** Nothing uses it.

The ACL above keeps the phone off them, but they shouldn't listen there. Steps:
- Eryk: `docker stop agora-minio` (auto mode blocked Claude from stopping it). Its volume stays; deleting it is a separate decision.
- Claude: bind the dev `docker-compose.yml` ports to `127.0.0.1` (`"127.0.0.1:5432:5432"`, `"127.0.0.1:6379:6379"`), then recreate the test containers (`docker compose -p agora-test up -d postgres redis`).
- D check: from the phone or another device, ports 5432, 6379, 9000 and 9001 on `tim` must not answer.

Side effect seen: `wslrelay` holds `[::1]:5432`, so `localhost:5432` from Windows reaches the WSL side. Tests must use `127.0.0.1` in `DATABASE_URL` / `REDIS_URL`.

### 4. Serve it (Claude, after 1–3)

In WSL: set `CORS_ORIGIN=https://tim.tail995bbc.ts.net` in `~/agora/.env.prod` (keep `DOMAIN`), redeploy, then:
```bash
tailscale serve status; tailscale funnel status   # must be empty before you start
sudo tailscale serve --bg http://127.0.0.1:8080   # needs Eryk's sudo password
```

### 5. Agents on the PC need the new client

The running `agora-mcp` processes and skill copies are old (no `[OWNER]` tags, no `who_directs`, no Rule 10). Build `agora-mcp` from main in the main checkout (`cd agora-mcp && npm run build`; the main checkout is on branch `video/your-turn` with untracked `video/`, so build from a clean worktree or switch carefully). Then Eryk restarts each agent session (Claude Code, Codex, Gemini). Before the bot-instruction test, confirm in a real tool result that `[OWNER]` tags and `who_directs` appear.

### 6. D: acceptance (the list is in `docs/remote-access.md`, section 6)

Phone on Wi-Fi and on mobile data; `https://localhost` still works; WSL and Windows restart persistence; other tailnet device refused; Tailscale off refused; LAN refused (`:8080`, `:443`, and the item-3 ports); no `portproxy`, no `networkingMode=mirrored`; forged `X-Forwarded-For` doesn't change login limits; Log out all sessions drops the phone's socket and a copied token; removing the phone in the admin console cuts it off; an agent obeys `[OWNER]` and refuses another bot; code runs still need approval.

## Other loose ends (not part of this job)

- **npm publish of `agora-mcp` 0.4.0:** Eryk's npm account rejected his recovery code. He emailed npm support (2026-10-17) and is waiting. The README says "coming soon".
- `docs/planning/HANDOFF.md` predates all of this.
- Local branches and worktrees from this work (`.claude/worktrees/*`, `.worktrees/*`) can be removed once #60 is merged.
- Timing (Eryk asked): planning 13:28–13:36; A1 13:36–13:48; A3 13:48–13:53; B 13:59–14:12; #54–#59 merged by 14:27; deploy 14:28–14:32. Review rounds with Codex ran alongside.
