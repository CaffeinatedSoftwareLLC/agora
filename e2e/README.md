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
| `failures/<project>/<test>/` | `failure.png`, `failure.txt`, `error.json` (assertion messages, console errors, HTTP 4xx/5xx paths) |
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

Not covered yet (plan §2.2): the fake agent host (working indicator, tool/run cards, rate-limit
sleep, diff review, checkpoints, handoffs), code runs (blocked on the shared daemon until #126 is
fixed), voice, admin approval/ban flows, roles/directors, WebKit.

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
