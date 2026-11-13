# The owner's terminal in a box: design

Status: first slice built (boxes only, owner only). What a person sees and may change is in [../box-terminal.md](../box-terminal.md); this is the reasoning and the threat list a reviewer checks the code against.

The owner opens a real interactive shell in the browser, attached to one agent's box, to take over by hand: run the agent's CLI interactively, look at its files, fix something. It is a remote shell, so the door comes first and the feature second.

## The data path

```
 owner's browser                 Agora API                      box (gVisor)
 ┌─────────────┐  ws /socket.io  ┌────────────┐  ws via edge   ┌───────────────────────────────┐
 │ xterm page  │◄───────────────►│ ShellHub   │◄──────────────►│ agora-host ◄pipes► agora-pty  │
 │ /terminal/… │ cookie+Origin   │ (gateway,  │ host token +   │ (Node)      fd 0,1,3  (Python │
 └─────────────┘ +ticket         │ in memory) │ edge signature │                       pty) ─ bash -i
                                 └────────────┘                └───────────────────────────────┘
```

- **Browser to Agora**: its own Socket.IO connection (`auth.type = 'shell'`) on the existing gateway, not an HTTP request (a request holds a database transaction until it replies). Same path as the chat socket, so nginx, Caddy and the tailnet files need no change; the REST side is `/boxes/:id/terminal…`, already under the `boxes` prefix.
- **Agora to the box**: the in-box agora-host connects out through the edge with its host token (`auth.type = 'host'`), the same pattern as every box request (§4.1 of [agent-boxes.md](../agent-boxes.md)). Not a `docker exec`: boxd's Docker allowlist is unchanged ("no exec, no attach").
- **In the box**: agora-host starts `box/agora-pty` (Python's standard `pty` module; stdin, stdout and a control pipe on fd 3 for resize), which runs `bash -i`.
- Bytes go socket to socket in the hub. They never enter a Socket.IO room, a table, a log line, telemetry or the doctor report. The hub keeps counts.

### Why Python's pty and not node-pty or `script`

`node-pty` is a native module: another thing to compile for amd64 and arm64 in the image, to keep in step with Node, and to fail at build time on someone's machine. `script -qfc` has no resize. The image already has `python3`, whose `pty` is in the standard library, so there is nothing to build; the helper is 200 lines that only move bytes, with backpressure (so `yes` cannot starve Ctrl-C), a resize pipe and process-group cleanup. Its tests run against a real pty on Linux (host unit tests in CI and the box test). The image changed (`box/agora-pty`, `AGENTS.md`), so `box/VERSION` is 6.

## Who may open one, and how each hop proves it

Only the **server owner** (a person with a normal browser session). Never a member, a director, a bot, a host token, a box token.

| Hop | Proof |
|---|---|
| Button in Settings | owners only in the UI; the server decides |
| `POST /boxes/:id/terminal/ticket` | cookie session (a bearer token is refused: `cookie_session_required`); CSRF token of that session; `Origin` present and this site's; caller owns the box's server (audited refusal otherwise); the box is running, its host has spoken the terminal protocol and is connected; **the owner's password again** (counted against the login limiter) |
| the ticket | 32 random bytes, only its SHA-256 stored, 30 seconds, single use, bound to **the user, that browser session's jti, the box and its generation** |
| browser socket handshake | `Origin` required and allowed (stricter than chat); the **cookie only** (no bearer, bot or host token); JWT valid, not revoked, token version, account active; refused if it arrived through a box's edge (provenance); the ticket redeemed in one `UPDATE` that matches user and session; ownership checked **again**; box generation, state and host checked again; unique index: one terminal per box |
| host socket | host token (hash-checked), box host only, through its own edge at its current generation (§4.1 both ways), protocol ≥ 1; the hub accepts a host's events only for terminals it was given |
| in the box | agora-host opens a shell only when asked on that socket, and only in box mode (`AGORA_HOST_IN_BOX` and the image's marker file) |

Re-checked while it runs (every 15 seconds): the box is still running at the same generation, its host token is not revoked, the owner still owns the server and the account is active. Logout, a token revocation or a suspension drops the browser socket at once through the gateway's existing revocation, and the terminal with it.

## What the terminal can and cannot reach

A shell inside the box as `agent` (uid 1000), in the agent's workspace folder (else `~/scratch`, else home), with the environment the agent's CLI gets (`childEnv`: an OS allowlist, the CLI's state directory so `claude`/`codex`/`devin` find the agent's login, the proxy variables) plus `TERM`. The same network allowlist applies: the edge sees only the box's address, so an unlisted domain is refused (and appears as a card for the owner, exactly as for the agent). Same home volume, same read-only root, no capabilities, no `sudo`, same limits.

The host token and bot token are not in the shell's environment. They are **not** hidden from the shell's user: `/run/agora/host.json` and PID 1's environment are readable by uid 1000, as they are for the agent (agent-boxes.md §3.2, "accepted"). A terminal adds no reach beyond what the agent already has; what it adds is a person at the keyboard. Running the CLI by hand is not yeet mode: Claude asks for permissions interactively.

## Lifecycle

- **Open**: ticket, socket, the browser reports its size (`shell:start`), the host starts the shell, `shell:ready`. The audit entry and the channel notice are written when the shell starts.
- **Resize**: the browser tells the host through the hub; the helper sets the window size.
- **Close**: the Close button or Settings (`DELETE`), the shell exiting, a limit, the owner's session ending. The host kills the shell and its process group.
- **The browser disappearing** (tab closed, network lost): the terminal closes at once (`browser_gone`). No detach or reattach in this slice; a reattach token would be one more door.
- **The box restarting or rebuilding**: its host socket drops, the terminal closes (`box_disconnected`); a generation change is also caught by the re-check.
- **Agora restarting**: every terminal row is closed at boot (`server_restarted`); sockets are gone anyway.
- **Takeover**: a second open returns `terminal_in_use` with who and since when; only a deliberate retry with `takeover: true` (and the password again) closes the first (`taken_over`) and issues a ticket. Two tickets racing: the unique index lets one in.

## One person and one agent in a box

New wakes for that agent **pause** while a terminal is open: `claimNext` offers the box's host nothing for that profile, and queued wakes are claimed when it closes. A run already working is not stopped: that would lose work, and the terminal page and the channel notice say so ("a run in progress keeps going, so you share the box with it"); the Settings card shows that a terminal is open. Running both at once would have two writers in one worktree and, for a subscription agent, two processes on one CLI login directory. The channel is told when it opens and closes ("**eryk** has a terminal open in **cci**'s box. New wakes for this agent are paused until it closes").

## What is recorded

`box_shell_sessions` (who, which box, when, how long, bytes in and out, why it closed), audit entries `box_terminal_open`, `box_terminal_close` and `box_terminal_refused`, and the two channel notices; the owner reads the list in the box's card. **The terminal's content is not stored or logged** and the code logs nothing from the hub; the integration test types a marker, then searches every table and every console and stream write for it.

## Limits that are security boundaries (owner-editable, shown, not hidden)

| Limit | Default | Range | What it stops |
|---|---|---|---|
| idle: no keystroke from the owner | 15 min | 1–240 | a terminal left open |
| longest a terminal stays open | 8 h | 1–24 | a terminal left open for days |
| output rate | 512 KiB/s | 16–8192 | a flood into the browser and the API |

Also fixed: one terminal per box; input chunks ≤ 64 KiB and ≤ 256 KiB/s (burst 1 MiB); window size ≤ 500×200; 10 ticket requests a minute; the socket ends with the owner's browser session (24 h idle at most).

## Threats

| # | Threat | Answer | Test |
|---|---|---|---|
| 1 | Someone other than the owner opens or joins one: member, director, bot, host/box token, another server's owner, a stolen link | the proofs above. A stolen *link* is only `/terminal/<boxId>`; nothing secret is in a URL, and the ticket travels in a POST body and a socket handshake. A copied ticket fails: single use, 30 s, bound to the original browser session | integration: member, director, other owner, bot, host token (with and without the edge), bearer token, wrong password, reused / expired / other-session / other-user ticket, ownership change between ticket and socket, rebuild between ticket and socket, host from another box, `box-terminal.integration.test.ts` |
| 2 | A page on another origin opens the socket with the owner's cookie | cookie is `SameSite=Strict`; ticket request needs `Origin` + CSRF; the socket handshake refuses any other or missing `Origin`; and still needs a ticket that page cannot get | integration: other origin, no origin, no/forged/other-session CSRF, no cookie, provenance |
| 3 | A script injected into an Agora page (a stored message) drives the terminal | message content is already neutralised. The terminal adds: opened only from a deliberate click on a card that is not message content, on a route that renders no user content and has no chat socket; a fresh ticket per terminal; **the owner's password typed again** (a script does not know it); a channel notice the owner and others see. **Residual, stated plainly:** a script running in the Agora origin can call any API as the owner and can drive a window it opens; the password step turns "silent" into "needs the owner to type their password into a window the script controls". It is not a defence against a compromised origin, and nothing in a browser can be | integration: password required; UI: the page shows no message or channel |
| 4 | The terminal's bytes leak into logs, the database, rooms, telemetry, the doctor report | the hub is the only code that holds them; it stores counts; no room is used; no logger is called with data; telemetry and the doctor have no terminal fields | integration: marker searched in every table and every log write; a member's chat socket hears the notice and never a `shell:*` event |
| 5 | An agent run and a person in the box at once | new wakes pause, running work continues and is announced, the state is in the channel and on the card | integration: wake held while open, claimed after close |
| 6 | Escape sequences from the box attack the browser widget | xterm with no clipboard addon (OSC 52 ignored), title changes ignored, OSC 8 link activation a no-op, no window reports, `allowProposedApi` off; query responses are fixed-format reports that carry no attacker text | UI test of the widget's options and addons |
| 7 | Denial of service | pacing at the host (the pty blocks, so `cat bigfile` slows, Ctrl-C still works), a hard close at the server for a host that ignores it; input limits; one terminal per box; idle and longest limits; ticket and password rate limits; tickets purged | integration: output flood, input flood, idle, longest; host test: pacing; box test: `yes` at 64 KiB/s then Ctrl-C |

Two more that came up: **a box restarted under a terminal** (host socket drop closes it) and **an older box image** (the host never reports the protocol; Settings says "this box needs its update first" and no ticket is issued: `box_needs_update`).

## Unboxed agents (not built)

A terminal for an unboxed agent is a shell on the owner's own computer opened from a web page. Leave it out until there is an **explicit opt-in in the machine's own agora-host config** (a key the server can never set, read at start, off by default), a confirmation shown on that machine, and a decision on whether the browser-to-computer path needs a stronger step than a password. agora-host refuses to open a terminal outside box mode today.

## Not in this slice

Reattach after a dropped connection; passkey step-up (every account has a password, so password re-entry always works); recording or replay (deliberately never); per-user terminal quotas across boxes; sharing a terminal.

## Migration

`100_box_terminal.sql` (099 is left free for `feat/agent-commands`; `feat/run-streaming` has 098): the three limits on `agent_boxes`, `agent_hosts.shell_protocol`, `box_shell_sessions`, `box_shell_tickets`. No grants to `app_user`, RLS on.
