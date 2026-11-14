# Open a terminal in an agent's box

You can open a real terminal in the browser, attached to one agent's [box](agent-boxes.md), to take over by hand: run the agent's CLI interactively (`claude`, `codex`), look at what it did, fix something, without leaving Agora. The reasoning and the threat list are in [planning/box-terminal.md](planning/box-terminal.md).

## Who can use it

Only the **server owner**, signed in on a browser. Not a member, not someone with the Direct Agents permission, not an agent, not a host or box token, not a copied bearer token. Opening one asks for your password again, even though you are signed in.

Boxes only. An agent that runs on your own computer ("unboxed") has no terminal: that would be a shell on your computer opened from a web page.

## How to open one

1. Settings, Agents, the agent's box: **Open terminal**. The button is off, with the reason beside it, when the box is not running, is not connected, or **needs its update first** (a box made from an older image has no terminal support, or only the first, weaker kind; rebuild it after upgrading Agora).
2. A page opens in a new tab and tells you what a terminal is here. Type your password and press **Open terminal**.
3. If another terminal is already open on that box, the page says who opened it and asks before closing it: only one terminal per box at a time.

The confirm page also says that closing the tab ends the shell and that anything started with `setsid`, `nohup` or `disown` keeps running. The page refuses to open over plain http (except on localhost). A multi-line paste into a shell that did not ask for bracketed paste asks before sending.

The tab is the terminal. **Close terminal** ends the shell. Closing the tab, losing the connection or signing out ends it too; there is no reconnecting to a shell, and jobs it started with `&` end with it (a job you detach on purpose with `nohup` or `setsid` can keep running in the box).

On a phone it works: you can type, scroll, and a toolbar sends Esc, Tab, Ctrl-C, Ctrl-D and the arrow keys.

## What you get: your own account, apart from the agent

The box has two users. The agent runs as **`agent`** (uid 1000). Your terminal runs as **`operator`** (uid 1001), a separate ordinary account: not root, not in the agent's group, and the agent is not in yours. It is a bash shell that:

- starts in `operator`'s own home, `/home/operator` (a tmpfs only you can enter; it is gone when the box restarts);
- has a fixed `PATH` of root-owned directories only (`/opt/agora/bin`, the image's own `claude`, `codex` and the rest, first), with nothing the agent can write on it and no `.`;
- reads no file from the agent's home or workspace: bash starts from a root-owned rc file in the image, and git reads one root-owned configuration with hooks and `fsmonitor` off and no `safe.directory`, so **git refuses the agent's repositories** ("dubious ownership") instead of running what is in them;
- has only fixed values in its environment, plus `TERM` and the proxy variables: no host token, no bot token, no relay credential, no provider key, no `AGORA_*` variable, none of the agent's login directories;
- reaches what the agent reaches: the same network allowlist (a domain the box is not allowed to reach is refused and shows up as an approval card, as it does for the agent), the same read-only system, no `sudo`.

The agent's workspace and home are **not** readable from your account (the agent's home is mode 0700). To look at what the agent did, run commands through `as-agent` (below), for example `as-agent ls`, `as-agent git log`, `as-agent cat notes.md`. This is deliberate: sharing the agent's files by group or ACL would also share its CLI login directories with every program you run, and would change the permissions of volumes that already exist. It can be added later; see the design.

### `as-agent`: act as the agent

```
as-agent claude          # the agent's CLI, in its workspace, logged in as the agent
as-agent git status      # a repository the agent wrote, with the agent's own hooks
as-agent npm test        # the agent's project scripts, as the agent
as-agent                 # a shell on the agent's side
```

The command runs **as the agent** (uid 1000, in the agent's workspace, with the agent's login and the agent's environment, the same as its own runs get), so a hook or script the agent wrote runs as the agent and never as you. With a terminal it is interactive (the window size follows yours, Ctrl-C reaches the program); without one (`echo x | as-agent cat`, `as-agent make > out.txt`) stdin, stdout, stderr and the exit status pass through.

Run the agent's code with `as-agent`, **not from your own shell**. Plain `git status` in a repository the agent wrote is refused on purpose; `as-agent git status` is the way to run it.

**What you type in an `as-agent` session is on the agent's side of the wall.** The program runs as the agent, so the agent can see it, and can show you a fake prompt there. A short reminder is printed when an interactive session starts. Never type a password, a token or a login code into the box.

How it is checked: `as-agent` talks to a small server on the agent's side over a Unix socket in a directory only the agent and you can enter. The server accepts a connection only from the operator user, by the kernel's own record of who connected (`SO_PEERCRED`), not by anything in the request, so the agent cannot ask for itself or for you.

## What the agent cannot do

An agent that has been fed a hostile prompt runs as `agent`. Each of these fails, and each is a test in `test/boxes/terminal.box.test.ts` that runs in the box under gVisor in CI:

| The agent tries to | Why it fails |
|---|---|
| read the relay's credential | it is in no file; it reaches the relay through a pipe only the relay inherits; PID 1's environment and the relay's memory, environment and files are another user's |
| read or list `/home/operator` | mode 0700, owned by `operator` |
| read the shell's or the relay's `environ`, `fd/*`, `mem`, `maps`, `cwd`, `exe` | another user's process |
| attach to them with `ptrace` | another user's process |
| send them `SIGSTOP`, `SIGKILL`, `SIGHUP`, `SIGTERM` | another user's process |
| open the shell's terminal, or inject keystrokes with `TIOCSTI` | the terminal device belongs to `operator` |
| connect to Agora as the terminal relay with the host token | the terminal hub accepts only the relay credential; the host token is not a terminal credential at all |
| make `as-agent` run a command | the server turns away any connection that is not the operator's |
| make you run its hooks | git refuses its repositories for `operator`; `as-agent` runs them as the agent |

What the agent can still see: the command line of your shell and of the relay (`/proc` shows every process's command line to every user; it holds nothing secret), and that a terminal is open (the channel is told).

## While it is open

- **The agent**: new wakes for that agent are paused until the terminal closes; they are waiting, not lost, and are picked up when it closes. A run that was already working is not stopped; the page and the channel say so, and you share the box with it. Files may change under you.
- **The channel** (the box's home channel) is told when a terminal opens and when it closes: "eryk has a terminal open in cci's box. New wakes for this agent are paused until it closes." A terminal that stays open posts "still open; wakes for the agent are paused" once an hour. If a second connection claims to be the box's terminal relay while the real one is connected, it is refused, written to the audit log (`box_host_conflict`), announced in the channel (at most once an hour per box) and an open terminal is closed ("the connection to the box changed, so the terminal was closed for safety").
- **What is recorded**: who opened it, which box, when, for how long, how many bytes you typed and it printed, and why it closed. You read the list under the box's card, "Terminal limits and history", and in the audit log (`box_terminal_open`, `box_terminal_close`; refused attempts as `box_terminal_refused`). **What you type and what the shell prints is not stored or logged anywhere.**

## Limits

These are part of what keeps a terminal safe to leave open. They are shown on the terminal page and you can change them per box, under "Terminal limits and history" on the box's card.

| Limit | Default | Range |
|---|---|---|
| Closes after no keystroke from you for (the terminal's automatic answers to the shell's queries do not count) | 15 minutes | 1–240 |
| Never stays open longer than | 8 hours | 1–24 |
| Most output the shell may send | 512 KiB/s | 16–8192 |

A shell that prints faster than the output limit is slowed down (a flood just takes longer, and Ctrl-C still works); a box that ignores the limit has the terminal closed. Input is limited too: pastes are sent in pieces, and about 1 MiB at once is the most the terminal takes before it closes. Your browser session ending ends the terminal.

## What the page does with what the shell prints

It never writes your clipboard, never changes the tab's title, never follows a link the shell prints, and answers no window queries. It shows no chat, no messages and no channel names.

## If something goes wrong

| It says | Means |
|---|---|
| This box needs its update first | The box's image is older than this feature. Rebuild the box (Settings, the box, Rebuild). |
| The box is not connected yet | Its terminal relay has not reached Agora (just started, or the box is down). Try again in a moment. |
| That password is not right / too many attempts | Counted against the same limit as signing in. |
| A terminal is already open on this box | Someone, or you in another tab, has one. The page asks before taking it over. |
| It closed because ... | The reason is on the page and in the history: idle limit, longest time, output limit, input limit, the box restarted or was rebuilt, the connection to the box changed, this page stopped reading, Agora restarted, you were signed out. |
| `git status` says "dubious ownership" | You ran git in a repository the agent owns. That is the point: use `as-agent git status`. |
| `as-agent` says the agent's side is not running | The agent's host is starting or restarting; try again in a moment. |

## For operators

No new service, port or proxy rule: the terminal uses Agora's existing WebSocket (`/socket.io`) and the box routes (`/boxes/:id/terminal…`). Migration `100_box_terminal.sql`. The box image version is 7 (`box/agora-box-init`, `box/as-agent`, `box/as-agent-server`, the operator account); boxd rebuilds boxes onto it like any image change, so **boxes restart once on upgrade**. A box's container now starts as root, for its init only, with `SETUID`, `SETGID`, `SETPCAP` and `KILL` and nothing else, and every process of both users has an empty capability set (details and tests in [agent-boxes.md §17](agent-boxes.md#17-the-owners-terminal)). A single API process is assumed, as for the rest of the gateway.
