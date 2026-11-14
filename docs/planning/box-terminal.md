# The owner's terminal in a box: design

Status: first slice built (boxes only, owner only), then rebuilt so the owner's shell and its relay run as a separate Unix user from the agent ("Separate operator user" below). What a person sees and may change is in [../box-terminal.md](../box-terminal.md); this is the reasoning and the threat list a reviewer checks the code against.

The owner opens a real interactive shell in the browser, attached to one agent's box, to take over by hand: run the agent's CLI interactively, look at its files, fix something. It is a remote shell, so the door comes first and the feature second.

## The data path

```
 owner's browser                 Agora API                      box (gVisor)
 ┌─────────────┐  ws /socket.io  ┌────────────┐  ws via edge   ┌──────────────────────────────────────┐
 │ xterm page  │◄───────────────►│ ShellHub   │◄──────────────►│ box-relay  ◄pipes► agora-pty         │
 │ /terminal/… │ cookie+Origin   │ (gateway,  │ relay credential│ (Node, uid 1001)  fd 0,1,3 (Python   │
 └─────────────┘ +ticket         │ in memory) │ + edge signature│                          pty) ─ bash -i
                                 └────────────┘                │ agora-host (uid 1000) is another process │
                                                               └──────────────────────────────────────┘
```

- **Browser to Agora**: its own Socket.IO connection (`auth.type = 'shell'`) on the existing gateway, not an HTTP request (a request holds a database transaction until it replies). Same path as the chat socket, so nginx, Caddy and the tailnet files need no change; the REST side is `/boxes/:id/terminal…`, already under the `boxes` prefix.
- **Agora to the box**: the box's terminal relay (`agora-host box-relay`, run by the operator user, not the agent's agora-host) connects out through the edge with its own credential (`auth.type = 'relay'`), the same pattern as every box request (§4.1 of [agent-boxes.md](../agent-boxes.md)). Not a `docker exec`: boxd's Docker allowlist is unchanged ("no exec, no attach").
- **In the box**: the relay starts `box/agora-pty` (Python's standard `pty` module; stdin, stdout and a control pipe on fd 3 for resize), which runs `bash -i` as the operator.
- Bytes go socket to socket in the hub. They never enter a Socket.IO room, a table, a log line, telemetry or the doctor report. The hub keeps counts.

### Why Python's pty and not node-pty or `script`

`node-pty` is a native module: another thing to compile for amd64 and arm64 in the image, to keep in step with Node, and to fail at build time on someone's machine. `script -qfc` has no resize. The image already has `python3`, whose `pty` is in the standard library, so there is nothing to build; the helper is 200 lines that only move bytes, with backpressure (so `yes` cannot starve Ctrl-C), a resize pipe and process-group cleanup. Its tests run against a real pty on Linux (host unit tests in CI and the box test). The image changed (`box/agora-pty`, `AGENTS.md`), so `box/VERSION` is 6 (7 with the separate operator user).

## Who may open one, and how each hop proves it

Only the **server owner** (a person with a normal browser session). Never a member, a director, a bot, a host token, a box token.

| Hop | Proof |
|---|---|
| Button in Settings | owners only in the UI; the server decides |
| `POST /boxes/:id/terminal/ticket` | cookie session (a bearer token is refused: `cookie_session_required`); CSRF token of that session; `Origin` present and this site's; caller owns the box's server (audited refusal otherwise); the box is running, its host has spoken the terminal protocol and is connected; **the owner's password again** (counted against the login limiter) |
| the ticket | 32 random bytes, only its SHA-256 stored, 30 seconds, single use, bound to **the user, that browser session's jti, the box and its generation** |
| browser socket handshake | `Origin` required and allowed (stricter than chat); the **cookie only** (no bearer, bot or host token); JWT valid, not revoked, token version, account active; refused if it arrived through a box's edge (provenance); the ticket redeemed in one `UPDATE` that matches user and session; ownership checked **again**; box generation, state and host checked again; unique index: one terminal per box |
| relay socket | the relay credential (`ar_…`, hash-checked against `relay_secret_hash`; the host token is not accepted and does not parse), box relay only, through its own edge at its current generation (§4.1 both ways), protocol ≥ 2; the hub accepts a relay's events only for terminals it was given |
| in the box | the relay opens a shell only when asked on that socket, and only in box mode (`AGORA_HOST_IN_BOX` and the image's marker file); it refuses to run as any user but the operator |

Re-checked while it runs (every 15 seconds): the box is still running at the same generation, its host token is not revoked, the owner still owns the server and the account is active. Logout, a token revocation or a suspension drops the browser socket at once through the gateway's existing revocation, and the terminal with it.

## What the terminal can and cannot reach

A shell inside the box as **`operator`** (uid 1001), an ordinary account of its own (see "Separate operator user"), starting in its own home, with a fixed environment (no host token, bot token, relay credential or provider key; the proxy variables and `TERM`) and a `PATH` of root-owned directories only. The same network allowlist applies: the edge sees only the box's address, so an unlisted domain is refused (and appears as a card for the owner, exactly as for the agent). Same read-only root, no capabilities, no `sudo`, same limits. The agent's home is closed to the operator (mode 0700), so the agent's files are read, and its commands run, through `as-agent`.

What the terminal adds is **a person's keystrokes in a box that an autonomous agent runs in**. The agent can no longer read, poison or impersonate the owner's shell (separate user, separate credential, no capability anywhere); what remains on the agent's side of the wall is whatever the owner chooses to type into an `as-agent` session, which is the agent's own process, and the page and the banner say so. Running the CLI by hand is not yeet mode: Claude asks for permissions interactively.

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

## Review fixes (security review of PR #393)

- **Host socket takeover.** `registerHost` and the host handshake refuse a second socket for a box while the first is connected at the same generation (`host_already_connected`). The refusal is audited (`box_host_conflict`, once a minute per box), announced in the agent's home channel (once an hour per box, like the provenance notices) and closes an open terminal with its own reason (`host_changed`: "the connection to the box changed, so the terminal was closed for safety"). A real reconnect arrives after the old socket's disconnect, or after Socket.IO's ping timeout (25 s interval + 20 s timeout, about 45 s, for a connection that died uncleanly); agora-host treats the refusal as "retry in 5 s", not a growing backoff and not fatal. A socket registered at an older generation is replaced, not defended.
- **Shared shell.** The confirm page lists seven plain facts (same box and user as a running agent, it can read or change what you type, fake prompts, no secrets, wakes paused, `setsid`/`nohup` survive, API key in the environment); the live header carries a one-line reminder. The shell starts in the box user's home, not the agent's worktree, with a banner naming the workspace; `/opt/agora/bin` is first on the shell's PATH (the shell's environment only: the agent's own runs resolve tools as before); the child of `agora-pty` closes every descriptor above 2, so the resize pipe (fd 3) is not in the shell.
- **Idle clock.** xterm's `onData` carries the owner's keys and the widget's automatic answers (device attributes, cursor reports, focus reports). The page sends data as `shell:input` only within 150 ms of a browser event of the owner's (key, composition, paste, pointer, wheel, touch; `onKey` alone misses paste, IME and soft keyboards) and as `shell:reply` otherwise. The hub writes both to the shell under the same size and rate limits but only `shell:input` resets the idle clock, and only the paired browser socket can send either. A terminal open for an hour posts "still open; wakes are paused", then again each hour.
- **Audit flood.** Refusals are written at most once a minute per person, box and reason; the status, close and history routes are rate limited (60, 30, 60 a minute) like the ticket route (10); a ticket that does not redeem writes no row (the hub counts them); a missing box and a box that is not yours both answer `404 box_not_found`.
- **Generation.** A host socket counts only at the box's current generation, in the ticket check, the handshake and `attachBrowser`; the sweep drops sockets of an older generation.
- **Ownership.** `refreshGatewayAccess` (run after every committed change under `/servers`, `/admin`, `/users` ...) now also re-checks open terminals at once; the 15-second sweep stays as the backstop. Agora has no ownership-transfer route yet, so this hook is what an ownership change or a suspension would reach.
- **Origin scheme.** The ticket route and the shell handshake also require the Origin's scheme to match the request's (`X-Forwarded-Proto` only when `TRUST_PROXY` is on). Other routes keep the host-only check.
- **Backpressure.** The hub closes a terminal (`browser_stalled`) when more than 4 MiB are queued for a browser that is not reading.
- **Paste and plain http.** A multi-line paste with bracketed paste off asks first; the page refuses to open when `window.isSecureContext` is false away from localhost.

## Separate operator user (fixes the host-takeover residual)

The first slice ran the relay inside the agent's agora-host and the shell as the agent's user, so a prompt-injected agent could read the host token, `SIGSTOP` the real agora-host, wait for the server to drop it, and connect as "the host" to receive the owner's keystrokes and print fake prompts; it could also tamper with the owner's shell (startup files, the pty, `/proc`, ptrace, signals). The review fixes only made that visible. The fix is structural.

**Decision (the owner's):** the person gets a separate ordinary account, `operator` (uid 1001, not root); the agent keeps `agent` (uid 1000). Two long-lived processes run in the box, one per user, each with a credential the other cannot read. The details, with what was chosen and why:

| Point | As built |
|---|---|
| Users | `agent` 1000 and `operator` 1001, each with its own group; neither in the other's. The pinned CLIs stay in root-owned `/opt/agora/bin` and `/usr/local`, executable by both. `/home/agent` is mode 0700 (the image, and `agora-box-start` for kept volumes); `/home/operator` is a tmpfs, mode 0700, owned by the operator. |
| Starting two users | The container starts as **root** (spec `User: 0:0`) and only for its PID 1, `box/agora-box-init` (Python, replaces tini, reaps orphans). boxd adds **`SETUID SETGID SETPCAP KILL`** to `cap-drop ALL`, keeps `no-new-privileges`. For each child, before exec: empty the bounding set (`SETPCAP`), drop groups, set uid/gid (`SETUID`/`SETGID`; leaving root clears permitted and effective), clear inheritable and ambient, no-new-privileges, **read `/proc/self/status` and refuse to exec unless every capability set is empty**. Then the init drops `SETUID`, `SETGID`, `SETPCAP` and keeps only `KILL` (it is root, the children are not, and a stop must reach them). No process of either user holds a capability; no new setuid binary; the root filesystem is as read-only as before. If either child dies the init stops the other and exits, so the restart policy and boxd's failure counting behave as they did when agora-host died. |
| boxd | `containerSpec`: `User 0:0`, `CapAdd [KILL SETGID SETPCAP SETUID]`, two new tmpfs (`/home/operator`, `/run/as-agent`), `AGORA_RELAY_TOKEN` in the environment. `containerDrift`: the user, an exact cap-add set (compared however Docker spells the names), and the tmpfs map are checked together with the spec. The Docker socket proxy's allowlist is unchanged (no exec, no attach). |
| Credentials | A **relay credential** (`ar_<hostId>.<secret>`), minted in `rotateBoxTokens` with the generation, stored as `agent_hosts.relay_secret_hash`, bound to the box and its edge provenance like the host token. It reaches the relay through a **pipe** only the relay inherits (the init writes it and closes the write end before anything runs): no file at rest, not in any other process's environment, and PID 1's environment is root's. The spec asked for a file mode 0400 owned by the operator in a directory the agent cannot traverse; the init has no `CHOWN` or `DAC_OVERRIDE`, and a pipe gives the same property without a file (see "What remains"). The hub accepts a terminal endpoint with this credential only; `type: 'host'` handshakes and host tokens are refused at the parse. The relay does not need the host token, bot token or any provider key and does not have them; agora-host (the agent) has no terminal code and never sees the relay credential. |
| The shell | Starts in `/home/operator`; `PATH` is `/opt/agora/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`; bash `--noprofile --rcfile /opt/agora/operator.bashrc` (root-owned, prints the banner); `GIT_CONFIG_GLOBAL=/opt/agora/operator.gitconfig` and `GIT_CONFIG_NOSYSTEM=1` (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, no `safe.directory`, so git refuses the agent's repositories: "dubious ownership"); nothing from the agent's home or workspace is sourced. |
| `as-agent` | `/usr/local/bin/as-agent` (root-owned Python) asks `box/as-agent-server` to run a command as the agent in the agent's workspace. The server is a child of agora-host (supervised, restarted with backoff), runs as the agent with the agent's CLI environment (`childEnv`, plus `/opt/agora/bin` first on `PATH`), and listens on `/run/as-agent/server.sock` in a tmpfs the agent owns and the operator's group may only traverse (0710). **Authentication is the kernel's:** a connection is served only when its `SO_PEERCRED` user id is the operator's, so the agent cannot ask for itself and nothing in a request can claim to be the operator. The only operator-to-agent direction exists; the agent cannot make the operator run anything (the client only prints bytes). Interactive (a pty: resize and Ctrl-C) and non-interactive (stdin, stdout, stderr, exit status) forms are both built. |
| Reading the agent's files | Not by group or ACL in this PR: through `as-agent cat/ls/git ...`. A group grant would expose the agent's CLI login directories to everything the operator runs, would need the agent's umask changed (the agent's behaviour must not change), and would change volumes that already exist. |
| Version skew | New server, old image: its agora-host's `type: 'host'` handshake fails as a login and is retried slowly; `shell_protocol` stays below 2, so Settings says the box needs its update first. Old server, new image: the relay gets `Invalid token`, logs it once and retries with backoff; the agent is unaffected. |

### What the agent must not be able to do, and the test for each

All in `test/boxes/terminal.box.test.ts` ("the operator is out of the agent's reach"), run by the CI **Boxes** jobs under gVisor on amd64 and arm64, and locally under runc by `scripts/test-boxes.sh`. The agent's side is played by `docker exec -u 1000`, the same user and namespace as the daemon the prompt-injected agent would be; `test/boxes/operator-probe.py` is the attacker.

| Attempt as `agent` | Expected | Test |
|---|---|---|
| read the relay credential (every process's `environ` and `cmdline`, every file under `/run /tmp /home/agent /opt /etc /var`, PID 1's `environ`) | found nowhere | probe: `credential found where the agent can read: nowhere`; `PID 1 environment` denied |
| read or list `/home/operator` | `EACCES` | probe |
| read the shell's and the relay's `environ`, `mem`, `maps`, `fd/*`, `cwd`, `exe`, `io` | `EACCES` | probe |
| `cmdline` of those processes | readable by every user in Linux; holds no secret | probe asserts no `ar_`, `ah_`, `bot_` or the secret in it |
| `ptrace` attach and seize of the shell, the relay, PID 1 | `EPERM` | probe |
| `SIGSTOP`, `SIGHUP`, `SIGTERM`, `SIGKILL`, signal 0 to the shell, the relay; `SIGKILL`, `SIGTERM` to PID 1 | `EPERM` | probe; recovery test (the agent's kill of the relay and of PID 1 changes nothing) |
| open the shell's pty device for read, write, read-write; `TIOCSTI` on it | `EACCES` | probe |
| connect to the server as the terminal relay with the host token | refused | box test: `Malformed relay token`; the old `type: 'host'` handshake refused; integration tests for every variant |
| make `as-agent` serve a request from the agent | `forbidden` | box test |
| the operator's `git status` / `commit` in an agent-planted repository runs its hook or `fsmonitor` | git refuses ("dubious ownership"); nothing runs | box test (marker file empty) |
| the same through `as-agent` | runs, as uid 1000 | box test (marker holds `uid=1000`, never `uid=1001`) |
| any process of either user holds a capability or lacks no-new-privileges | none does; PID 1 holds `CAP_KILL` alone | box test (all five capability sets, every process the init started) |

### What remains unsafe

- **The browser page and Agora's server see every keystroke and every byte of output** while a terminal is open. They store none of it (tested), but a compromised Agora origin or server can read and send them. Nothing in a browser prevents it; the password step turns "silent" into "needs the owner's password".
- **Anything the operator chooses to execute from an agent-writable path.** `PATH` has none, git refuses the agent's repositories and bash reads only root-owned files, but `cd /tmp/x && ./run.sh`, `source` of an agent file, or copying an agent's file into the operator's home and running it runs that code as the operator. The banner and the confirm page say not to; `as-agent` is the way.
- **What the owner types in an `as-agent` session** is the agent's process's input.
- **A sandbox escape.** Everything above assumes gVisor (or runc in development) enforces user separation for `/proc`, ptrace, signals and ptys. If it does not, the box tests fail; if a kernel or sandbox bug breaks it, the two users share a box with no further layer. The same trust the rest of the box rests on.
- **The credential is in boxd's container environment** (anyone with Docker access can read it, as for the host token) and in the relay's memory.
- **`CAP_KILL` in PID 1**, a root process with no input surface; and root's reach over files the root filesystem leaves writable (only the tmpfs mounts and the agent's home volume, and without `CAP_DAC_OVERRIDE` root cannot write the operator's mode 0700 home or open the agent's).
- **The operator's home is not kept** across a restart or rebuild (a tmpfs).
- The first-slice review fixes (single registration per box, generation checks, audit and notices, idle and stall handling, rate limits) are unchanged and still apply to the relay.

## Follow-ups (not in this PR)

- A Content-Security-Policy and `frame-ancestors` for the whole app.
- Passkey or out-of-band step-up in place of the password.
- Running the relay under a separate uid (the residual risk above).
- Reattach after a dropped connection.
- Terminals for unboxed agents.

## Migration

`100_box_terminal.sql` (099 is left free for `feat/agent-commands`; `feat/run-streaming` has 098): the three limits on `agent_boxes`, `agent_hosts.shell_protocol`, `box_shell_sessions`, `box_shell_tickets`. No grants to `app_user`, RLS on.
