# Telemetry and problem reports

Agora sends nothing about you or your install unless you say so. There are two things it can send, both to the telemetry routes of `agora-push-relay` at `https://push.agora.host`:

| | When | Who decides |
|---|---|---|
| **Install report** | once when the installer (or `install/upgrade.sh`) finishes or fails | the telemetry question at install, saved as `AGORA_TELEMETRY` in `.env.prod`. Default **off** |
| **Problem report** | when you press **Send** after reading the whole report | you, each time; telemetry on or off makes no difference |

## The install report

The installer asks once, and the default is no:

> Send one anonymous report when this install finishes? It contains only:
> - whether the install succeeded, or the step it failed at
> - the Agora version
> - the operating system name and version
>
> No names, addresses, IPs or IDs are kept. [y/N]

With `on`, exactly one request is sent at the end of an install or an upgrade:

```
POST https://push.agora.host/telemetry/v1/install
Content-Type: application/json

{ "result": "ok" | "failed", "step": "<step id>" | null, "version": "0.9.0", "os": "ubuntu", "osVersion": "24.04" }
```

- `result`: `ok`, or `failed`.
- `step`: `null` on success; on failure the id of the step that failed (the list is below).
- `version`: the Agora version (`package.json`).
- `os`, `osVersion`: from `/etc/os-release` (`ID`, `VERSION_ID`); `ubuntu-wsl` when the Linux installer runs inside WSL. A failure in the Windows installer before the Linux one starts sends `os: "windows"` and the Windows version number (`10.0.<build>`).

The request has no user agent header and no cookies. Nothing else is ever sent: not your domain, your instance name, a hostname, a user name, an IP address, an install id or anything about your boxes or agents. With `off` (the default) nothing is sent at all, not even on failure.

**Turn it off** after installing: set `AGORA_TELEMETRY=off` in `.env.prod`. Only the installer and `install/upgrade.sh` read it; the running stack never sends install reports.

### Step ids

Linux installer (`install/linux/install.sh`): `preflight.os`, `preflight.kernel`, `preflight.memory`, `preflight.wsl`, `docker.install`, `gvisor.install`, `gvisor.check`, `existing`, `preflight.disk`, `preflight.ports`, `source.copy`, `telemetry`, `config`, `start`, `health`, `admin`, `box`, `box.start`, `done`.

Upgrade (`install/upgrade.sh`): `upgrade.fetch`, `upgrade.backup`, `upgrade.replace`, `upgrade.config`, `upgrade.build`, `upgrade.start`.

Windows installer (`install/windows/install.ps1`): `win.preflight`, `win.telemetry`, `win.wsl`, `win.reboot`, `win.distro`, `win.import`, `win.linux`, `win.keepalive`, `win.browser`. When the Linux installer fails inside WSL it sends its own report; the Windows installer doesn't send a second one.

## Problem reports

After a failed install the installer offers **Report this problem?**, and in Agora, Admin → Instance has **Report setup problem**. Both work the same way:

1. The report is built and **shown to you in full**.
2. Only if you answer yes (or press **Send**), it goes to `POST https://push.agora.host/telemetry/v1/problem` as `{ "report": "<the text you saw>", "version": "...", "os": "..." }`, at most 256 KB.
3. You get a report id (`pr_` and 16 characters) to quote in an issue.

What a report holds:

- **From the installer or `install/doctor.sh`**: the failed step, the Agora version, the distribution and kernel, free memory and disk, the Docker and Compose versions, whether `runsc` is registered and works, which `.env.prod` keys are set (never their values), whether ports are in use, each stack container's state, the API's and web's health, the runner's runtime line, the last five log lines of `boxd` and `box-edge`, and each box container's state, image version, generation and runtime.
- **From Admin → Instance** (`src/lib/doctor.ts`): the Agora and Node versions, which configuration keys are set, the database version and migration count, the number of instance admins, Redis, code-run counts by status for the last day, when boxd and the edge last reported in, and each box's id, state, generation, image version, login state and last error.

What it never holds: secret values, box or user names, message text, file names. Every line goes through a filter that replaces anything shaped like a token (bearer tokens, Agora host and bot tokens, provider and GitHub keys, JWTs, long hex or base64 strings, passwords in URLs, `*_SECRET=` / `*_TOKEN=` / `*_KEY=` values). The filter can't know every format, which is why you see the report before it is sent.

`install/doctor.sh --report` (or `install\windows\doctor.ps1 -Report`) does the same from a terminal at any time.

## What the collector keeps

The routes are in `agora-push-relay` (`src/telemetry.ts`; its README has the details):

- Install reports: the five fields and the date (UTC day, no time). Kept.
- Problem reports: the text, `version`, `os`, the date and the random report id. Deleted after 90 days.
- Anything else in a request (an extra key, a missing one, a wrong type) is refused with `400` and not stored.
- No IP address, user agent or other header is stored or written to the relay's logs; its rate limits count all callers together, so they hold no addresses either. The relay runs on Heroku, whose router writes its own access log line for every request (with the client address) to the app's log stream. Those lines are outside the relay's code; without a log drain attached they stay only in Heroku's short in-memory log buffer.
