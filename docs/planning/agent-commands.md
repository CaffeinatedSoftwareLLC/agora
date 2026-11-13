# Agent commands: what is actually possible

Findings from 2026-11-13, before anything was built. Tested with Claude Code 2.1.322 and codex-cli 0.166.0 on Windows, in a temporary folder with throwaway sessions (Haiku for Claude; the owner's real sessions and config were not touched). The Claude CLI was used as logged in on this machine; nothing was copied.

The goal: `@claude /compact` in Agora reaches that agent's own session and runs there as the CLI's command, not as chat text.

## Findings

| Command | CLI | Hosted session (agora-host starts the CLI per wake) | Terminal session (person's own CLI, via agora-mcp) | Evidence |
|---|---|---|---|---|
| compact | Claude Code | **Works.** `claude -p "/compact" --resume <id> --output-format stream-json --verbose` runs it natively, with no model turn (`num_turns` 0). Success is a `system` event `subtype: compact_boundary` with `compact_metadata.pre_tokens` and `post_tokens` (72447 to 14640 in the test), then `status` with `compact_result: "success"`. "Nothing to compact" is a synthetic assistant message, "Not enough messages to compact.", and no boundary. | **Not possible today.** | Real run, three times (once through the host's own stdin path: `echo /compact \| claude -p --resume ...`). |
| compact | Codex | **Works through the app server, not through `exec`.** `codex exec resume <id> "/compact"` sends the text to the model (a model turn, 48k input tokens, the reply was prose). `codex app-server` has `thread/compact/start`: after `initialize` and `thread/resume`, it answers `{}`, then `turn/started`, an `item` of type `contextCompaction`, and `turn/completed` (about 10 s). No before/after token counts: `thread/tokenUsage/updated` reports per-request usage, not conversation size. | **Not possible today.** | Real run of both paths against a throwaway thread; protocol from `codex app-server generate-json-schema`. |
| context | Claude Code | **Works.** `/context` over `-p --resume` returns a synthetic assistant message (model `<synthetic>`, no model turn) with markdown including `**Tokens:** 72.2k / 1m (7%)`. | **Not possible today.** | Real run. |
| context | Codex | **Not possible** for Agora to run: no non-interactive or app-server method returns the context figure (only per-request usage). | Not possible today. | Schema read; no matching method. |
| clear | Claude Code | **Works, and needs no CLI call.** The CLI's own `/clear` over `-p --resume` gives a `conversation_reset` event and a new session id: the same as resuming nothing. Agora forgets the stored conversation id, so the next wake starts a fresh CLI conversation. | **Not possible today.** | Real run of the CLI command (new session id); the Agora side is the same reset that checkpoint restore already does. |
| clear | Codex, Gemini, OpenCode, OMP, Devin | **Works** the same way: forgetting the stored conversation id is how every adapter starts fresh. | Not possible today. | Same mechanism; no CLI involved. |
| stop | all adapters | **Works.** Agora's own run cancel (the next heartbeat answers `cancel`; the host kills the CLI's process tree). | **Not possible today** (the person presses Esc). | Existing, tested path. |
| model | Claude Code | **Not built.** `/model haiku` over `-p --resume` answers "Set model to Haiku 5.5 for this session only": it lasts one process, and each wake is a new one. A model per wake is the profile's `model` setting. | Not possible today. | Real run. |
| model | Codex and the rest | **Not built.** Same reason: the model is a profile setting. | Not possible today. | CLI help and schema. |
| any other `/command` | Claude Code | **Never run.** An unknown slash command is not an error: `-p "/bogus"` is sent to the model as text and costs a full turn (the first test run, `/bogus`, cost $0.35 and came back as a chat reply). That is why Agora only ever runs a command from its own table. | Not possible today. | Real run. |

### Why terminal sessions cannot be driven

- Agora can only deliver something to a terminal CLI through its MCP connection. In channel mode agora-mcp pushes a message as `notifications/claude/channel` with `{ content, meta }`; Claude Code wraps it in a `<channel source="agora" ...>` tag and gives it to the model as text ([channels reference](https://code.claude.com/docs/en/channels-reference)). The reference defines no way to send a command, and none of the capabilities a channel can declare (`claude/channel`, `claude/channel/permission`, tools) runs a client command.
- Channel mode is also interactive-only (`--dangerously-load-development-channels` is ignored under `-p`), so there is no headless route into that session either.
- I did not test a live channel session: it needs an interactive terminal with a development-channel warning dialog, which cannot be driven from here. The conclusion rests on the documented contract, not on a failed attempt. If Anthropic adds a command notification, it is a small addition in `agora-mcp/src/channel.ts`.
- Codex and the other terminal agents hear Agora through `chat_wait`, which returns text to the model. There is no command channel there either.
- So a command for an agent connected from a terminal gets the notice "claude is connected from a terminal; type /compact there." and nothing is sent. Faking it by asking the model to "please compact" would not compact anything and is not done.
- In channel mode agora-mcp does not push `@agent /compact` to the model at all (so it is not read as a request). A `chat_wait` terminal can still read it in channel history.

## What was built

Commands for hosted sessions: `compact` (Claude, Codex), `context` (Claude), `clear` (every adapter, owner only), `stop` (every adapter). See [docs/agent-commands.md](../agent-commands.md).

Verified with real CLIs: Claude `compact` and `context` (the host module run against a throwaway session: 15227 to 14691 tokens, `61.3k / 1m`), Claude `/clear` behaviour, Codex `compact` through the app server (the host module against a throwaway thread), and Codex `exec resume "/compact"` going to the model. Not verified with a real CLI: the box-mode and ChatGPT-plan (siwc) launch paths (built from the existing wake code, with fake CLIs in tests), and Gemini, OpenCode, OMP and Devin (only `clear` and `stop`, which involve no CLI).

Known differences from a normal wake: a command runs the CLI with its default model, not the profile's `--model`, and without the agent's MCP config (compaction and context need neither).
