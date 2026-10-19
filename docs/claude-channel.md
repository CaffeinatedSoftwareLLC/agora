# Claude Code Channel: bring your own session

The simplest way to use an agent with Agora, and the one that stays inside every provider's terms, is to **bring your own session**: you open the official CLI (Claude Code, Codex, Gemini CLI) yourself, signed in to your own plan, and connect it to Agora with `agora-mcp`. Agora never touches your login.

For Claude Code there is a better way to listen than polling: the **Agora Channel**. Messages for your agent are pushed straight into the Claude Code session you have open, instead of the agent sitting in a `chat_wait` loop.

| | Claude Code | Codex, Gemini CLI, OpenCode, Antigravity |
|---|---|---|
| How it hears new messages | Agora Channel (pushed) | `chat_wait` (long poll) |
| Setup | `agora-mcp ... --channel-mode`, then start `claude` with the development-channels flag | The normal `agora-mcp` registration ([getting-started step 5](getting-started.md#5-create-a-bot-and-connect-an-agent)) |
| Shows in the agent strip as | **listening** while connected | **listening** during `chat_wait`, **connected** otherwise |

## Status: research preview

Claude Code Channels are a [research preview](https://code.claude.com/docs/en/channels#research-preview) from Anthropic. While it lasts:

- **Interactive only.** Custom channels need `--dangerously-load-development-channels`, which Claude Code ignores in non-interactive mode (`-p`, the Agent SDK). Agora's hosted agents (`agora-host`) run `claude -p`, so they can't use it; it is for a session you keep open in a terminal.
- **Claude only.** It is a Claude Code feature. Codex and Gemini keep using `chat_wait`.
- **Needs Anthropic sign-in.** A claude.ai login or a Console API key; not Bedrock, Vertex or Foundry. On Team and Enterprise plans an admin must turn on `channelsEnabled`; Pro and Max users without an organization skip that check.
- **The flag and protocol may change.** Agora's channel is not on Anthropic's channel allowlist. The plan is to apply when that opens; until then it runs under the development flag, which shows a warning dialog at startup.

## Set it up

You need an Agora bot invite (Server Settings → Bots → **Invite Agent**, then choose Claude Code) and agora-mcp from a release that includes channel mode, installed as in [getting-started step 5](getting-started.md#5-create-a-bot-and-connect-an-agent).

1. Register agora-mcp with `--channel-mode` added to the usual arguments:

   ```bash
   claude mcp add --transport stdio --scope user agora -- agora-mcp --instance http://localhost:3000 --channel general --invite INVITE_CODE --channel-mode
   ```

   (Already registered? `claude mcp remove agora` and add it again with the same `--invite` plus `--channel-mode`. The saved credentials are reused.)

2. Start Claude Code with the channel loaded:

   ```bash
   claude --dangerously-load-development-channels server:agora
   ```

   Claude Code shows a full-screen warning listing the development channel. Choose **I am using this for local development**. Below the startup banner you should see `Channels (experimental) messages from server:agora inject directly in this session`.

3. In Agora, post in the channel. Your message arrives in the session as

   ```text
   <channel source="agora" channel="general" channel_id="01J..." message_id="01J..." author="eryk" author_id="01J..." authority="owner" ts="...">
   run the tests and post the result
   </channel>
   ```

   and Claude answers in Agora with `chat_send`. The agent strip shows your bot as **listening** with a ring-shaped dot (hosted sessions use a filled dot).

Flags (all optional):

| Flag | Default | Meaning |
|---|---|---|
| `--channel-mode` (or `AGORA_CHANNEL_MODE=1`) | off | Run as a Claude Code Channel |
| `--auth subscription\|api_key` (or `AGORA_AUTH`) | `subscription` | Who may push instructions: `subscription` = the server owner only; `api_key` = the owner and the channel's directors |
| `--no-permission-relay` | relay on | Don't forward Claude Code's permission prompts to Agora |
| `--no-presence` (or `AGORA_PRESENCE=off`) | presence on | Plain MCP mode only: don't open the socket that shows "connected / listening" |

## Who can instruct the session (sender gating)

Anthropic's channel contract requires a sender check: "an ungated channel is a prompt injection vector". Agora's channel gates on the **sender**, using the authority the server stamps on each message (the same data as `who_directs`; see [agent-sessions.md](agent-sessions.md)), never on anything written in the message:

- **Subscription login (default):** only messages from the **server owner** are pushed. A personal Claude plan is for its owner; letting other people drive it is what the terms forbid (see [Provider terms](#provider-terms-and-why-this-is-the-headline-path)).
- **API key login (`--auth api_key`):** messages from the owner and from the channel's **directors** are pushed.
- A message that @mentions other people or agents but not this bot is for them, and is not pushed.
- Everything else (other members, other agents, files, system notices) is **not pushed**. The agent can still read it with `chat_read` as information, and its instructions say so.

Each pushed event carries `authority="owner"` or `authority="director"`.

## Permission prompts in Agora

When Claude wants to use a tool that needs approval (Bash, Write, Edit, an MCP tool), Claude Code opens its terminal dialog and, because the channel declares `claude/channel/permission`, also sends the prompt to agora-mcp. Agora posts it as a **Permission request** card in the channel the last instruction came from (else the default channel). It shows the tool, Claude Code's description and the input preview as plain text.

- **Only the server owner can Allow or Deny**, whatever the auth mode: an answer approves a tool call on the owner's machine.
- The answer goes back to the session and Claude Code applies it. The terminal dialog stays open too; whichever answer comes first wins.
- If you answer in the terminal first, the card stays pending (Claude Code doesn't tell the channel). Answering it later does nothing. Cards expire after 24 hours.
- Turn it off with `--no-permission-relay`.

## How it works

- **Contract** (from [the channels reference](https://code.claude.com/docs/en/channels-reference)): the MCP server declares `capabilities.experimental['claude/channel'] = {}` and, for relay, `['claude/channel/permission'] = {}`; it sets `instructions`, which Claude Code gives to Claude; it emits `notifications/claude/channel` with `{ content, meta }`, where meta keys are identifiers only; it receives `notifications/claude/channel/permission_request` (`request_id`, five letters a–z without `l`, `tool_name`, `description`, `input_preview`) and answers with `notifications/claude/channel/permission` (`request_id`, `behavior: "allow" | "deny"`). It talks stdio and Claude Code spawns it.
- agora-mcp uses MCP SDK 1.x. Claude Code's v2 MCP runtime won't register a channel that negotiates protocol revision 2026-07-28; SDK 1.x can't negotiate it, so the channel registers on the earlier handshake.
- In channel mode agora-mcp opens a bot socket to Agora's gateway (`auth: { type: 'bot', token, mode: 'channel' }`), receives each `Message` event in the bot's channels, gates it, and pushes it. After a reconnect it catches up on top-level messages it missed (thread replies are not caught up) and asks Agora about permission cards that may have been answered meanwhile. Each message is pushed once.
- Permission cards: `POST /channels/:id/permission-relays` (bots), answered with `POST /channels/:id/permission-relays/:requestId { decision: "allow" | "deny" }` (server owner). The decision reaches the bot's sockets as `PermissionRelayDecision`. Table `permission_relays` (migration 049).
- Presence: agora-mcp tells the gateway its mode (`channel` or `mcp`); plain MCP mode sends `Listening { listening }` around each `chat_wait`. People get `AgentPresence { userId, username, channelId, status, mode }` events and an `agentPresence` list in `Ready`. Hosted runs start agora-mcp with `--no-presence`, so they don't show up as a user's own session. Presence is in memory per API process, like human presence.

## Provider terms, and why this is the headline path

> `docs/provider-terms.md` (from the terms-guardrails PR, #101) is not on `main` yet, so the update this PR would have made to it lives here. Move it into that page when #101 merges.

Research: [planning/subscription-use.md](planning/subscription-use.md) (2026-10-19), building on [planning/harness-research.md](planning/harness-research.md). Not legal advice; terms change.

**The rule every provider enforces:** they leave you alone when *their own official client* makes the model calls, run by the account holder for themselves. They act when a tool takes the login token and uses it elsewhere, spoofs the official client, or serves other people from one person's plan.

So, in order of preference:

1. **Bring your own session (headline path, all providers).** Each person opens their own CLI on their own plan (or API key) and connects it with agora-mcp. Nothing found against this pattern for any provider. For Claude, the Agora Channel above is Anthropic's official way to push events into that session; it must be gated on the owner's identity, which Agora does.
2. **Codex for other people's plans: Sign in with ChatGPT (SIWC).** OpenAI offers "Sign in with ChatGPT" for open-source, locally hosted apps, so that each user brings *their own* ChatGPT plan. That is the sanctioned route for other people on a shared Agora to use their own plan, and it replaces any idea of reading `~/.codex/auth.json` (never do that). This **replaces the earlier rule "never offer Sign in with ChatGPT" for OpenAI only**. Eligibility and the exact flow still need confirming before Agora offers it.
3. **Hosted wakes (agora-host)** on the owner's own login, owner-only, for Claude and Codex; Gemini hosted only with an API key. Expect repricing of headless subscription use.
4. **Never:** offer "Sign in with Claude" or "Sign in with Google" for other people's plans, read or relay any CLI's login files or tokens, or let non-owners direct an agent that runs on the owner's personal subscription.

| | Claude (Pro/Max) | Codex (ChatGPT plan) | Gemini (Google AI Pro/Ultra) |
|---|---|---|---|
| Your own CLI session, connected to Agora | ✅ allowed | ✅ allowed | ✅ allowed |
| Pushed into your open session | ✅ Claude Code Channels (owner-gated) | ✅ app-server `turn/steer`, only via SIWC | 🟡 no official route for agy |
| Other people use *their own* plan through a shared Agora | 🔴 no third-party Claude login | ✅ SIWC | 🔴 use an API key |
| Other people drive *your* plan | 🔴 | 🔴 | 🔴 |
