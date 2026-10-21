# Beta test environment manifest

> The environment manifest from step 3 of [beta-test-plan.md](beta-test-plan.md) §7.1 (the "Environment ready" gate in [beta-test-coverage-review.md](beta-test-coverage-review.md) §5).
> Sources: `e2e/README.md`, `e2e/docker-compose.e2e.yml`, `e2e/up.sh`, `e2e/down.sh`, `e2e/lib/env.ts`, `e2e/global-setup.ts`, `e2e/playwright.config.ts`, plan §2.1/§3.1/§4 and `docs/getting-started.md`, all at `11e998c`. The machine facts were checked on 2026-10-20.
> This file lists credential **variable names only**. No values were read: neither `e2e/.env.e2e` nor `%USERPROFILE%\.agora-test\keys.env` was opened.

## 1. Disposable instance identity

| Item | Value |
|---|---|
| Compose project | `agora-e2e`, pinned by `name:` in the compose file and by `-p` in `up.sh`/`down.sh` |
| Compose file | `e2e/docker-compose.e2e.yml`. It is self-contained, **not** an override of `docker-compose.prod.yml` |
| Services | `postgres` (16-alpine), `redis` (7-alpine), `migrate` (one-shot), `api`, `web` |
| Web | `http://localhost:8280`, bound to `127.0.0.1:8280` → container port 80. Override with `E2E_WEB_PORT` |
| API | `http://localhost:3200`, bound to `127.0.0.1:3200` → container port 3000. Override with `E2E_API_PORT` |
| Postgres / Redis | Internal to the network only, not published. Database `agora`, user `accord` |
| Network | `agora-e2e_net` |
| Volumes | `agora-e2e_e2e-pgdata`, `agora-e2e_e2e-files` (mounted at `/data/files` in `api`) |
| Images | `agora-e2e-server:e2e` (built from `Dockerfile`, used by `migrate` and `api`), `agora-e2e-web:e2e` (built from `agora-ui/Dockerfile`) |
| Instance settings | Name `Agora E2E`. Registration `open` (set by seeding). WebAuthn RP name `Agora E2E`, origin = base URL. Login lock after 10 failures for 15 min. Global login limit raised to 600/min. `COOKIE_SECURE=true` (`http://localhost` is a secure context, so Secure cookies and WebAuthn work) |
| Daemon | `e2e/README.md` runs it on the **WSL `Ubuntu` daemon** (`wsl.exe -d Ubuntu -- bash e2e/up.sh`), the same daemon as the live stack. Plan §4 prefers the Docker Desktop daemon and allows WSL only when Docker Desktop is unavailable. **Open decision:** pick one and record it in each run's manifest |

**Preflight in `up.sh`.** Before anything is created, `up.sh` refuses to start unless all of these hold:

- at least 2 GB RAM and 10 GB disk are free;
- the compose file defines no forbidden service (`runner`, `socket-proxy`, `sandbox-image`, `cap-gateway`, `caddy`, `tailscale`);
- the rendered project name is `agora-e2e`;
- the rendered config doesn't reference the live `agora_default`, `agora_sandbox`, `agora_pgdata` or `agora_files-data`;
- the API and web ports are not 80/443/3000/8080 and are not already published by another container.

`lib/env.ts` also refuses a live-looking base URL or port at test time.

**Teardown.** `e2e/down.sh agora-e2e` refuses any other project name. It runs `down -v --remove-orphans` and removes the two `:e2e` images (keep them with `E2E_KEEP_IMAGES=1`) and `e2e/.env.e2e` (keep it with `KEEP_ENV=1`). It never prunes.

## 2. What the instance deliberately omits

| Omitted | Why | Consequence |
|---|---|---|
| `runner`, `socket-proxy`, `sandbox-image` | On startup the runner force-removes every `agora-run-*` container on the daemon (`removeOrphans`, #126), so it would kill the live stack's code runs | `OP-01` (code runs) and §5 item 59 stay `blocked` until #126 is fixed or a separate VM/remote daemon exists |
| `cap-gateway` | Serves sandboxed code only, which needs the runner | `agora:std` capabilities and the `/v1/*` gateway routes are not exercised |
| `caddy`, tailnet override | Not needed: plain HTTP on `localhost` is enough for Playwright | Nothing about trusted TLS, Caddy routing or Tailscale is proven here. Those stay manual (§5, `OP-07`) |
| `kokoro`, `whisper` | Not in the file | Server-side voice routes are unavailable. Voice tests need a stub (§2.2) |

## 3. Seeded fixtures (`global-setup.ts`, HTTP API only)

| Fixture | Value |
|---|---|
| Owner | `owner-e2e` (`owner-e2e@example.test`). Instance admin, created by `POST /instance/setup` with the setup token from `.env.e2e`. Owns the instance's default server |
| Member | `member-e2e` (`member-e2e@example.test`), registered under the `open` policy |
| Server | The instance default server (`instanceServerId`), **not** a separate `E2E Lab` server |
| Channels | `#general`, plus run-tagged `agents-<tag>`, `notices-<tag>` and `history-<tag>` (`<tag>` is 4 random hex characters per run) |
| Agent host | `e2e-host-<tag>`. **No host process runs.** The harness reports the profiles' auth modes with the host token itself |
| Agents (bot + profile, workdir alias `e2e`) | `claude-e2e-<tag>` (claude, `api_key`, key variable `ANTHROPIC_API_KEY`); `codex-key-<tag>` (codex, `api_key`, `OPENAI_API_KEY`); `codex-sub-<tag>` (codex, `subscription`); `codex-plan-<tag>` (codex, `siwc`) |
| Messages | 4 Lorem-ipsum messages in `agents-<tag>`, 120 history messages in `history-<tag>`, 4 consecutive start/end notices in `notices-<tag>` |
| Sessions | `storageState` for owner and member, saved after logging in through the real login page |

Seeded passwords look like `CANARY-owner-…-SECRET` and `CANARY-member-…-SECRET`, so the leak scanner can find them in retained evidence.

**Planned but not seeded yet** (plan §0/§2.1): a `director-e2e` user and the `Directors` role, `gemini-e2e`, a canary bot token and a canary provider key (only the canary passwords exist today), a seeded thread and an uploaded PNG. Authority scenarios that need a director stay `not_run` until those exist.

## 4. Disposable repo and storage

- **Storage.** File blobs go to the `agora-e2e_e2e-files` volume (`STORAGE_DIR=/data/files`), encrypted with the instance's own random `AGORA_ENCRYPTION_KEY`. The database is the `agora-e2e_e2e-pgdata` volume. Both are deleted by `down.sh`.
- **Repo.** None yet. The smoke suite runs no agent host. The per-run throwaway git repo (`<tmp>/repo`) and the empty per-profile `stateDir`s in §3.1 still have to be built with the fake and real agent hosts.
- **Run evidence.**
  - `e2e/artifacts/<run-id>/` holds the manifest, screenshots, sanitized failures, `summary.json` and the leak report. It is kept. The plan's name for it is `results/`.
  - `e2e/secrets/` holds `seed.json`, `storageState` and raw Playwright output. It is deleted at the end of every run unless `E2E_KEEP_SECRETS=1`.
  - All three paths are gitignored (`e2e/.gitignore`).

## 5. Platforms and browsers on this machine

| Item | Status (2026-10-20) |
|---|---|
| Host OS | Windows 11 Home 10.0.26200 |
| WSL2 distros | `docker-desktop`: Running. `Ubuntu`: Running; this is the live stack's Docker Engine with gVisor `runsc`. `agora-test`: **Stopped. Keep it stopped.** Starting a second `dockerd` in another distro broke the live stack's networking on 2026-10-20 (plan ground rules) |
| Docker Desktop | Running. It can't run gVisor (`docs/getting-started.md`). Per plan §4 it hosts the vitest `-p agora-test` infra |
| macOS | Not on this machine. The Mac test agent sees GitHub `main` only, and Option B (Colima + gVisor) is unverified |
| Phone | Android Chrome over Tailscale. It reaches the **live** stack only, never `agora-e2e` |
| Playwright | `@playwright/test` 1.64.1. Installed browsers: `chromium-1248` and `chromium_headless_shell-1248` only |
| Playwright projects | `desktop-chromium` (1280×800, every spec except mobile) and `pixel-7` (Pixel 7 emulation on Chromium, `mobile.spec.ts` only) |
| WebKit / Firefox | Not configured in `playwright.config.ts` and not installed. Record core journeys on those engines as `not_run`. `ID-03.passkey` uses a CDP virtual authenticator and is `not_applicable` outside Chromium |
| Session idle expiry | The 24 h idle limit is a hard-coded constant (`e2e/README.md`), so the plan's short-`SESSION_IDLE_SECONDS` second API isn't possible. Expiry stays in vitest. E2E covers only `ID-02.idle-renew` |

## 6. The live stack: never touch

- **Project.** `agora` (WSL `~/agora`), started from `docker-compose.prod.yml` plus `docker-compose.tailnet.yml`.
- **Ports.**
  - `127.0.0.1:80` and `127.0.0.1:443` (Caddy; the tailnet override binds them to loopback)
  - `127.0.0.1:3000` (API)
  - `127.0.0.1:8080` (web, tailnet override)
- **Networks and volumes.** `agora_default`, `agora_sandbox`, `agora_pgdata`, `agora_files-data`.
- **Remote URL.** `https://agora-home.<tailnet>.ts.net` (plan §1.9).
- **Rules.**
  - Nothing destructive, no revocation and no fault injection runs there.
  - No code-run tests run on its daemon (plan §2.1).
  - Eryk's normal use of `main` there may run alongside automation.
  - `up.sh` lists the live containers but never acts on them.
  - `down.sh` acts only on `-p agora-e2e`.

## 7. Credential variable names (values never recorded)

| Where | Variable names |
|---|---|
| Test API keys (owner's limited keys, plan ground rules) | `AGORA_TEST_ANTHROPIC_KEY`, `AGORA_TEST_OPENAI_KEY`, `AGORA_TEST_GEMINI_KEY`. Only `AGORA_TEST_ANTHROPIC_KEY` is read today, by `vision-judge.ts`, from the environment or `%USERPROFILE%\.agora-test\keys.env`. The other two are for the agent suite (§3), which isn't built yet |
| Provider variables in the agora-host child process (§3.1) | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`. Each is set from the matching `AGORA_TEST_*` key in that child only |
| `e2e/.env.e2e`, written by `up.sh` (mode 600, gitignored, removed by `down.sh`) | `DB_PASSWORD`, `JWT_SECRET`, `AGORA_ENCRYPTION_KEY`, `AGORA_SETUP_TOKEN`, `E2E_OWNER_PASSWORD`, `E2E_MEMBER_PASSWORD`, `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_BASE_URL` |
| `e2e/secrets/seed.json`, deleted every run | Fields: `ownerPassword`, `memberPassword`, `ownerToken`, `memberToken`, `botToken`, `hostToken` |
| Run controls (not secrets) | `E2E_RUN_ID`, `E2E_FRESH_ENV`, `E2E_KEEP_SECRETS`, `E2E_KEEP_IMAGES`, `KEEP_ENV`, `VISION_BUDGET_USD` |

## 8. Where the built harness differs from plan §2.1

Plan §2.1 describes:

- a `compose.e2e.yml` override of the prod file;
- API on 3300 and Caddy on 8380/8743 with `ignoreHTTPSErrors`;
- `e2e/scripts/{preflight,seed,…}.ts`;
- a `results/` folder.

The harness that was built uses:

- a self-contained `e2e/docker-compose.e2e.yml`;
- API on 3200 and web on 8280 over plain HTTP, with no Caddy;
- `up.sh` for the preflight and `global-setup.ts` for seeding;
- an `artifacts/` folder.

Update §2.1 to match, or treat the differences as deliberate and record them here.
