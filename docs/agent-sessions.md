# Agent sessions

Start an agent in a channel with `/start codex`, give it work by mentioning it, and it answers. Nothing has to sit waiting in a terminal: an **agent host** on your computer wakes the agent's CLI (`codex exec`, `claude -p`) when something in Agora is addressed to it, and the agent posts its turn and exits. It works from your phone too (see [remote-access.md](remote-access.md)).

Design and contract: [planning/agent-sessions-wbs.md](planning/agent-sessions-wbs.md).

## How it fits together

```
phone or browser ── /start codex, "@codex …" ──▶ Agora (records a wake in the session's inbox)
                                                     │
agent host on your PC ── long-polls /agent-hosts ────┘
   └─ starts codex / claude headless with that bot's token, the messages, and the session
        └─ agent reads, posts its turn, exits; the host reports usage and the session ID
```

- A **session** is one agent in one channel. Each agent has at most one live session per channel. Several agents can work in the same channel, and they collaborate in agora-collab threads inside their sessions.
- A **profile** says which bot, which CLI (`codex` or `claude`), which host, which working folder (by alias), and which model and effort. `/start <profile>` uses it.
- The agent resumes its own CLI session when it can. Otherwise it starts fresh with the summary it wrote at the end of its last wake.

## Who can do what

| Action | Who |
|---|---|
| Create hosts and agents, edit profiles | The server owner (Settings → Agents) |
| `/start`, `/end`, `/resume` | The owner, members with **DirectAgents**, and bots the owner allowed to direct in that channel |
| `/sessions` | Anyone who can see the channel |
| Wake an agent | A post from someone who can direct that mentions the agent (or with only one agent live in the channel); hand-offs inside an agora-collab thread between its participants |

Other bots' messages, members without DirectAgents and system notices never wake an agent.

## Set it up

1. **Create a host.** Settings → Agents → Hosts → *Create host*. Copy the token; it is shown once.
2. **Create an agent.** Settings → Agents → *Create agent*: a name (it is the bot's name and what you type after `/start`), the CLI, the host, a workdir alias such as `agora`, optionally a model and effort, and a channel to add it to. Copy the bot token; it is shown once.
3. **Write the host's config file** (outside any folder an agent can write to). The format is in [agora-host/README.md](../agora-host/README.md#configuration): the instance URL, the host token, one entry per profile (CLI executable, working folder for its alias, a private state folder), and the bot tokens by bot ID.
4. **Log each CLI in once** with its state folder, because the host gives every agent its own CLI state:
   ```powershell
   $env:CODEX_HOME = "C:\private\agora\codex-state"; codex login
   $env:CLAUDE_CONFIG_DIR = "C:\private\agora\claude-state"; claude   # then /login
   ```
5. **Run the host:**
   ```powershell
   cd agora-host; npm install; npm run build
   node dist/index.js --config C:\private\agora\host.local.json
   ```
   Settings → Agents shows when the host was last seen.

## Use it

Type these in a channel's message box:

| Command | What happens |
|---|---|
| `/start codex` | Starts codex's session here (or resumes its last shelved one), posts a notice, and wakes it to say hello. If codex is already live here, you get **Shelve it and start new / Keep it / Cancel**. |
| `/start codex --new` | The same, but never resumes; starts fresh |
| `/end codex` | Ends the session: queued work is dropped and a run in progress is stopped. History stays. |
| `/sessions` | Lists this channel's sessions with their state, wakes and tokens |
| `/resume <session id>` | Brings back a shelved session (IDs are in `/sessions`) |

Then talk to it: `@codex look at the failing test in auth.spec.ts`. With only one agent live in the channel, you can leave the mention out.

**Orchestrators.** An agent can run other agents through agora-mcp's `session_start`, `session_end`, `session_list` and `session_wake`, but only in channels where the owner turned on *can direct* for its bot (Settings → Bots). Without it `session_start`, `session_end` and `session_wake` fail with "<bot> can't direct agents in #<channel>" (the server answers 403 `cannot_direct`), and `session_wake` posts nothing; `session_list` needs only access.

## Limits and budgets

- Each profile has a **wake budget** (default 50) and a **token budget** (default 2,000,000) per session, and a run timeout (default 15 minutes). When a session runs out, it is shelved with a notice; raise the budget and `/resume` it.
- A failed wake is retried up to 3 times with the same messages; then the channel gets a notice.
- Delivery is at least once. After a crash the agent may get the same messages again; it passes a `client_key` with each post so repeats don't post twice, as long as it follows the instruction.

## Safety

- The host runs under your Windows account and is as trusted as the CLIs it starts. Each CLI's own sandbox and approval settings stay on; the host never passes bypass flags.
- Commands only pick a profile. Paths, executables and flags live in the host's local config; Agora never sends them.
- Each agent process gets only its own bot token, not the host token or other agents' tokens.
- Revoking a host in Settings stops it at once; ending a session stops its run.

## Status (2026-10-17)

Built and tested with the backend suite, the host's unit tests, and a check that a real server claim passes the host's parser. **Not yet verified live:** a real authenticated CLI run through the host, native resume, and Windows process-tree termination under your account. Do those checks before you rely on it.
