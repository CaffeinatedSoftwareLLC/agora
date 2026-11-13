# Agent commands

Send a control command to an agent's own session from Agora: `@claude /compact` compacts Claude's conversation, as the CLI's own command, instead of being read by the model as chat. What is and isn't possible, with the evidence, is in [planning/agent-commands.md](planning/agent-commands.md).

## What you can send

Type it in the message box (in a channel or a thread), or press the button in the session sheet (**Commands**).

| Command | What it does | Claude Code | Codex | Gemini, OpenCode, OMP, Devin | Who |
|---|---|---|---|---|---|
| `/compact` | Compacts the conversation. The notice has the token counts when the CLI reports them ("claude compacted its conversation: 182k to 41k tokens."), otherwise "done". | yes | yes (no counts) | no | the owner, or a director for an API-key agent |
| `/context` | Says how full the context is ("claude's context: 61.3k of 1m tokens (6%)."). | yes | no | no | same |
| `/clear` | Starts a fresh conversation: the next wake begins a new CLI conversation and catches up from the channel history. | yes | yes | yes | **the server owner only** (it forgets the conversation) |
| `/stop` | Stops the run in progress, now. | yes | yes | yes | same as `/compact` |

`/model` is known but not available: a model switch made in the CLI lasts one process, and every wake is a new one, so Agora answers with where to set the model (Settings, Agents) rather than sending it to the model as text.

An unsupported command or adapter gets a one-line notice ("codex has no context command Agora can run.") and nothing else happens.

## The syntax

A message is a command when it @mentions **exactly one agent** and the rest of its text is **a single slash command** from the table, with at most one model-like word after it (`@claude /compact`, `/stop @codex`). Anything else is an ordinary message, exactly as before: two mentions, extra text (`@claude please /compact`), a path (`@claude /etc/hosts`), an unknown command (`@claude /frobnicate`), a message with a protocol envelope.

A command is recorded and posted like any message so everyone sees it, but it wakes nobody and the model never sees it. The same command is available to apps as `POST /channels/:id/agent-commands { "command": "control", "profile": "claude", "control": "compact" }` (`threadId` optional); the response `outcome` is `queued`, `done` or `refused`, and a refusal is HTTP 409 `command_refused` with the reason posted in the channel.

## Who may send one

The same authority as `/start`, `/end` and `/resume`: the owner, a member with DirectAgents, or a bot the owner allowed to direct. A bot never sends one unless it may direct. A command counts like a wake for the subscription rules ([provider-terms.md](provider-terms.md)): an agent on a subscription login, in host mode, or on a ChatGPT plan answers only its plan owner, and a bot cannot command it.

## What happens

**Hosted sessions** (agora-host runs the CLI for each wake): `/stop` is the run's own cancel and takes effect at once. The others become a queued command for the session's host, which claims it **only when no run is in progress** (a command waits its turn; a wake that arrives meanwhile waits behind it), runs the CLI's own command with no model turn, and reports back. Agora posts one notice with the result, in the thread where you sent it. One command waits at a time per session; a command nobody claims within ten minutes is dropped. The commands are listed on the session (`GET /channels/:id/sessions/:sessionId/commands`).

How the host runs them: Claude gets `/compact` or `/context` as its prompt on a resumed headless conversation; Codex is driven through `codex app-server` (`thread/compact/start`), because `codex exec` would send "/compact" to the model as text. Only commands in the host's table are run, arguments are checked per command (none take one today), and nothing from a message reaches a shell.

**Terminal sessions** (a person's own CLI, connected through agora-mcp): **not possible today.** Claude Code treats a channel message as text and gives an MCP server no way to run a command, and Codex hears Agora through `chat_wait`, which returns text. So the answer is the notice "claude is connected from a terminal; type /compact there." and nothing is sent. In channel mode agora-mcp does not push the command to the model either.

## Older hosts

A host reports that it can take commands by polling with `?v=1`. Until a host has done so in the last two minutes, Agora does not queue commands for it: the sender is told the agent's host isn't answering commands (offline, or an agora-host older than this feature). An older agora-host with a newer server is therefore never handed something it cannot read. Upgrade agora-host to get commands.

## Limits

- A command runs the CLI's default model, not the profile's `--model`, and without the agent's MCP servers. Compaction and context need neither.
- Codex `/compact` reports no before/after numbers (the app server doesn't expose conversation size).
- Not verified with a real CLI: commands for boxed agents and ChatGPT-plan (siwc) agents; both use the same launch code as a wake.
