# Agora UI E2E harness (Playwright)

Automated browser tests for Agora, run against a **disposable** instance. This implements §2 of
[docs/planning/beta-test-plan.md](../docs/planning/beta-test-plan.md). Scenario IDs (`ID-01.login`,
`UI-02.notice-drawer`, ...) follow the plan's §0 families.

## Safety rules (read first)

- The tests only ever talk to the **`agora-e2e`** compose project: web `http://localhost:8280`,
  API `http://localhost:3200`. `lib/env.ts` refuses ports 80/443/3000/8080 (the live stack).
- `docker-compose.e2e.yml` is self-contained (not an override of the prod file). It has its own
  network (`agora-e2e_net`), volumes (`agora-e2e_e2e-*`) and image tags (`*:e2e`), and only
  `postgres`, `redis`, `migrate`, `api` and `web`.
- **Never** add `runner`, `socket-proxy`, `sandbox-image` or `cap-gateway`. The runner force-removes
  every `agora-run-*` container on the daemon (#126), which would kill the live stack's code runs.
  `up.sh` refuses to start if the compose file defines any of them.
- **Never** start a Docker engine in another WSL distro (they share one network namespace; that broke
  the live stack on 2026-10-20). The e2e project runs on the existing WSL `Ubuntu` daemon.
- `down.sh` removes only `-p agora-e2e` (containers, volumes, network, `:e2e` images) and refuses any
  other project name. It never prunes.
- Fake data only: users `owner-e2e`, `member-e2e`; bots/agents `claude-e2e-<tag>`, `codex-*-<tag>`.

## Run it

From Windows (Git Bash or PowerShell), in the repo root:

```bash
# 1. Bring up the instance (prints a RAM/disk preflight first; writes e2e/.env.e2e with fresh secrets)
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash e2e/up.sh

# 2. Install once, then run the smoke suite
cd e2e
npm ci
npx playwright install chromium
npx playwright test --grep @smoke          # or: npm run smoke

# 3. Optional, advisory: vision check of the screenshots (uploads disabled for now)
npx tsx vision-judge.ts                    # dry run: leak scan + worst-case cost, sends nothing
npx tsx vision-judge.ts --judge            # refused (exit 3) until a pixel-aware leak review exists:
                                           # DOM-text scanning can't see secrets that only show in pixels

# 4. Stop and delete the instance (add E2E_KEEP_IMAGES=1 to keep the built images)
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash e2e/down.sh agora-e2e
```

Reruns against the same instance are fine: the first run performs instance setup; later runs log in
with the same passwords and create their own run-tagged channels and agents.

## What a run produces

`artifacts/<run-id>/` (gitignored):

| File | Contents |
|---|---|
| `manifest.jsonl` | One line per screenshot: `scenario_id`, `step`, `expectation`, `file`, `text_file`, project, viewport |
| `screens/<project>/<scenario>/<step>.png` + `.txt` | Viewport screenshot and the page's DOM text at capture time (the text is what the leak scan reads) |
| `failures/<project>/<test>/` | `failure.png`, `failure.txt`, `error.json` (assertion messages, console errors, HTTP 4xx/5xx paths) A test that puts a secret on screen calls `sensitive.begin()` before the reveal and `sensitive.add(value)` once it knows the value (`lib/sensitive.ts`). Its failure keeps no PNG (`failure-png-withheld.txt` instead), its text is scrubbed of those values and of token and invite-code shapes, and the values join the end-of-run leak scan. |
| `summary.json` | Per-test result (`passed` / `failed` / `not_applicable`), scenario ID and duration |
| `leak-report.json` | Only if the leak scan quarantined something |
| `judge.json` | Only after `vision-judge.ts --judge` (currently `blocked`) or a `secret_leak` |

`secrets/` (gitignored) holds `seed.json` (IDs, bot/host tokens), the per-user `storageState`
files and raw Playwright output (traces contain cookies and request bodies). It is **deleted at the
end of every run**, pass or fail, after the leak scan. Set `E2E_KEEP_SECRETS=1` to keep it for
debugging (then delete it yourself). Instance-lifetime credentials (DB password, JWT secret,
encryption key, setup token, the two seeded passwords) live in `e2e/.env.e2e` and are removed by
`down.sh`.

## How it works

- `global-setup.ts` seeds through the HTTP API only: instance setup with the setup token from
  `.env.e2e`, registration of `member-e2e`, run-tagged channels, an agent host plus four agent
  profiles (claude `api_key`; codex `api_key`, `subscription` and `siwc`; their auth modes are
  reported with the host token, no host process runs), 120 history messages and four consecutive
  session notices. It then logs each user in through the real login page and saves `storageState`.
- Readiness is always an explicit element (composer placeholder, pane heading, card, status text),
  never `networkidle`: the app keeps a socket open.
- `lib/snap.ts` takes each screenshot and appends the manifest line.
- `lib/summary-reporter.ts` writes `summary.json`, then `lib/finalize.ts` runs the leak scan
  (seeded passwords and tokens, instance secrets, `sk-ant-`/`sk-`/`AIza`/`bot_`/JWT/private-key
  patterns, `CANARY-…-SECRET` markers) and deletes `secrets/`.

## Smoke scenarios

| Spec | Scenarios |
|---|---|
| `auth.spec.ts` | `ID-01.login`, `ID-01.login-email`, `ID-02.cookie` (HttpOnly/SameSite, CSRF 403, reload, logout), `ID-02.idle-renew` (background requests don't renew; the 24 h idle limit is a hard-coded constant, so expiry itself is left to vitest) |
| `chat.spec.ts` | `UI-01.send-live` (two browsers), `UI-01.mention-enter`, `UI-01.mention-case`, `UI-01.thread-wake` (wake notice in the thread, active-threads bar, close/reopen) |
| `notices.spec.ts` | `UI-02.notice-drawer` (collapse, expand, survives reload), `UI-02.virtualizer` (120 messages) |
| `files.spec.ts` | `UI-03.upload-image`, `UI-03.upload-pdf` (identical bytes), `UI-03.magic-bytes` |
| `canvas.spec.ts` | `UI-05.canvas-render` (sandbox attribute, Network off, in-frame escape probes, version 2) |
| `workspace.spec.ts` | `UI-06.task-crud`, `UI-06.project-pin` (member read-only) |
| `settings.spec.ts` | `ID-06.provider-terms`, `ID-06.admin-reload`, `AG-10.agents-page` (auth badges, ChatGPT plan box for non-siwc profiles, siwc "Request sent"), `ID-04.invite-dialog` (code masked in the screenshot) |
| `passkeys.spec.ts` | `ID-03.passkey` via a CDP virtual authenticator (Chromium only; `not_applicable` elsewhere) |
| `mobile.spec.ts` (Pixel 7 project) | `UI-08.mobile-nav` (no sideways scroll, 44 px composer targets, nav overlay), `UI-08.mobile-thread` |

## Fake agent host scenarios (not in the smoke set)

`lib/fake-host.ts` starts a real `agora-host` from this checkout (built on first use) against the
e2e API, with run-tagged host, channel and agents registered through the API. Its profiles run
`fake-cli/fake-claude.mjs`, a stand-in for `claude -p --output-format stream-json`: no model, no
provider key (api_key profiles get a dummy `ANTHROPIC_API_KEY`). The host refuses `.cmd`/`.js`
executables, so on Windows a tiny native launcher is compiled from `fake-cli/launcher.cs` with the
.NET Framework's `csc.exe` into the run's temp folder. The workdir is a throwaway git repo with a
local bare `origin`; `GH_CONFIG_DIR` points at an empty folder, so `gh` has no login. The host
config (host and bot tokens) and log live in `secrets/`; `stop()` kills the host's process tree
(`taskkill /T /F`) and deletes the temp folder. Tests drive the fake by what they post:
`#fake-sleep=20`, `#fake-edit=a,b`, `#fake-edits=35`, `#fake-tokens=2000`, `#fake-deny=gh`,
`#fake-ratelimit`, `#fake-fail`, `#fake-silent`, `#fake-mark`, `#fake-hold=40` (see the script's header). Each spec file starts
its own host; `fkdirector-e2e` (a run-tagged role with DirectAgents) plays the director.

| Spec | Scenarios |
|---|---|
| `sessions.spec.ts` | `AG-01.host-seen`, `AG-01.start` (Shelve / Keep / Cancel), `AG-01.sessions` (`branch @ sha`), `AG-01.working`, `AG-07.changed-files`, `AG-01.budget`, `AG-01.rate-limit`, `AG-01.lurk`, `AG-08.verify`, `AG-09.terminal` |
| `cards.spec.ts` | `AG-04.tool-card`, `AG-04.run-approval`, `AG-04.permission-relay`, `AG-05.handoff` (incl. a 60 s expiry), `AG-05.reservations` |
| `agent-workspace.spec.ts` | `AG-07.checkpoints`, `AG-07.review-actions`, `UI-06.project-pin-file`, `UI-06.task-flow` |
| `diff-review.mobile.spec.ts` (Pixel 7) | `AG-07.diff-review` |
| `preview.spec.ts` | `AG-08.browser-preview` (Playwright's Chromium as the host's preview browser) |
| `canvas-extra.spec.ts` | `UI-05.canvas-versions`, `UI-05.canvas-escape-nav` (no host needed) |

## Crash and outage scenarios (not in the smoke set)

Plan §3.5 OP-02 and OP-03, skipped (`not_applicable`) unless `E2E_OPS=1` is set. They take minutes: the server's leases are fixed (runs 120 s after the
last heartbeat, swept every 15 s; workspace commands 180 s) and have no test-only override, so
each crash test waits one out, and the provider timeout case waits out Node's 300 s fetch timeout.

| Spec | Scenarios |
|---|---|
| `ops-crash.spec.ts` | `OP-02.crash-after-effect`, `OP-02.crash-before-claim`, `OP-02.crash-after-claim`, `OP-02.workspace-cmd-crash`: `FakeHost.kill()` kills the host's process tree mid-run (or mid-commit, held open by a slow git clean filter in the fake repo), `restart()` starts it again with the same config |
| `ops-outage.spec.ts` | `OP-03.db-down`, `OP-03.redis-down` (`docker pause`), `OP-03.storage-down` (the API user loses write access to `/data/files` through `docker exec -u 0 chmod`; restored after), `OP-03.provider-down` (dead port, 429 and never-answering stub), `OP-03.ws-loss` (Playwright `routeWebSocket` drops the page's socket three times while a stub reply streams) |

- `lib/containers.ts` is the only way the specs touch Docker. It refuses any container whose name
  does not start with `agora-e2e-` and, on every call, any container that is not labelled as part
  of the `agora-e2e` compose project (or as its own stub). It pauses, unpauses and execs; it never
  starts, stops, recreates or prunes compose containers. On Windows it calls the WSL `Ubuntu`
  daemon with `wsl.exe --exec docker`.
- The provider stub (`fake-provider/provider-stub.mjs`) runs as a throwaway `agora-e2e-provstub-*`
  container from the `agora-e2e-server:e2e` image on `agora-e2e_net`. The seeded server's chat route
  points at it for the test; the previous route, the assistant's enabled flag and the instance's
  "allow private base URLs" setting are put back afterwards.
- Every test ends with `expectHealthy()` (all containers running, `/health` on API and web, an
  authenticated read); afterEach unpauses anything still paused.
- Observations of how an outage looks from outside (an error instead of a hang, the connection dot)
  are soft assertions, so the integrity and recovery checks after them still run.

```bash
cd e2e
E2E_OPS=1 npx playwright test tests/ops-crash.spec.ts tests/ops-outage.spec.ts   # about 25-30 minutes
```

## Providers and soak (not in the smoke set)

Plan §3.5 OP-06 and OP-08.

| Spec | Scenarios |
|---|---|
| `ops-providers.spec.ts` (`E2E_OPS=1`) | `OP-06.<provider>.<step>` for anthropic, openai, gemini (real test keys, only with `E2E_AGENT_LIVE=1`), compat (OpenAI-compatible/Ollama), kokoro, whisper, tavily, jev: save through Settings → AI, Test, one tiny invoke, a wrong key, 429, timeout and wrong endpoint (the provider stub), the fix. Every JSON response and socket frame the page gets, and a sweep of the AI settings reads, is checked for the key values; the key columns are checked to hold ciphertext. Providers that take no base URL get `not_applicable` for the stub cases. `E2E_ANTHROPIC_MODEL`, `E2E_OPENAI_MODEL`, `E2E_GEMINI_MODEL` (comma lists, tried in order while the model is a 404) pick the models. Writes `op06-evidence.jsonl` and `op06-cleanup.jsonl`. |
| `ops-soak.spec.ts` (`E2E_SOAK=1`) | `OP-08.soak`: five browsers on two servers and three fake agents for `E2E_SOAK_MINUTES` (default 30): exactly-once storage and live delivery, cross-tenant and private-channel isolation of every socket frame, agent inbox drain, API memory bounds. Writes `soak-metrics.json`. |

- Real keys stay in memory (lib/agent-keys.ts): tests register them with `sensitive.addInMemory()`,
  the end-of-run leak scan gets them from `agentKeysForScan()`, tracing is off in that file and a
  screenshot is taken only after checking the page shows no key. The bad-key, 429, timeout and
  wrong-endpoint states use fake keys, so a real key never reaches the stub.
- Everything OP-06 creates is deleted afterwards and the settings it touches (allow private base
  URLs, the assistant's enabled flag, voice switches, routes) are put back and read back.

```bash
cd e2e
E2E_OPS=1 E2E_AGENT_LIVE=1 npx playwright test tests/ops-providers.spec.ts   # about 8 minutes (one 300 s timeout case)
E2E_SOAK=1 E2E_SOAK_MINUTES=30 npx playwright test tests/ops-soak.spec.ts      # the minutes plus about 5
```

Not covered yet (plan §2.2): code runs (blocked on the shared daemon until #126 is fixed), voice
(needs a Whisper stub), admin approval/ban flows, WebKit.

## Vision check costs

`vision-judge.ts` is advisory only: it never fails a run. Model and request settings are in
`vision.config.json`, verified against Anthropic's docs on 2026-10-20 (source URLs in the file):
`claude-haiku-5-5`, $0.10 / $0.50 per million input/output tokens, structured JSON output,
`effort: low`, thinking off, no sampling parameters, SDK retries off.

- The key is read from `AGORA_TEST_ANTHROPIC_KEY` (environment) or
  `%USERPROFILE%\.agora-test\keys.env`, and never printed. Without it the result is `blocked`.
- Before anything is sent it runs the leak-scanner self-test and scans the whole run directory;
  any hit writes `judge.json` with `secret_leak` and uploads nothing.
- Every attempt (first ask, retry, re-ask) reserves its worst-case cost before dispatch; when the
  budget (default $0.50) can't cover it, the screenshot is `skipped_budget`.
- A `fail` or `uncertain` is re-asked once: `fail`+`fail` gives `fail_needs_human`, `fail`+`pass`
  gives `flaky`, anything else gives `needs_human`.
- A desktop screenshot is about 1,330 image tokens. A 22-screenshot smoke run reserves at most
  about $0.05 even if every image is retried and re-asked; actual spend is a fraction of a cent to a
  few cents and is printed from `usage`.
