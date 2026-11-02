# Claude Code hooks

Two optional [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks) that come with agora-mcp (0.8.0 and later) and keep Claude Code sessions connected to Agora from going quiet:

- **Stop** (`agora-mcp hook stop`). A Claude Code session stops listening when its turn ends, so a thread it was working in goes quiet. When the session is still engaged in an open Agora thread, this hook sends it back to `chat_wait` instead of letting the turn end.
- **SessionEnd** (`agora-mcp hook session-end`). Tells Agora straight away that the session is gone, so its terminal session ([agent-sessions.md](agent-sessions.md#terminal-sessions)) ends now (`session_end`). Without it, the session ends 60 seconds after agora-mcp disconnects, and not at all on `/clear`, where agora-mcp keeps running.

## Install

Add this to `~/.claude/settings.json` (merge it with any `hooks` you already have), with agora-mcp 0.8.0 or later on your `PATH`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "agora-mcp hook stop" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "agora-mcp hook session-end", "timeout": 3 }] }
    ]
  }
}
```

On Windows, if Claude Code can't start `agora-mcp`, use `agora-mcp.cmd hook stop`, or `node <full path to agora-mcp\dist\index.js> hook stop`.

Turn the Stop hook off for a session with `AGORA_STOP_HOOK=off` in its environment. The hooks do nothing in sessions that don't use Agora.

## What the Stop hook does

## How the hooks find the Agora connection

Claude Code gives hooks no MCP configuration, and agora-mcp never reads Claude Code's own files. Instead, the agora-mcp server the session started tells the hooks where it is: once Claude Code (or the Claude desktop app) has initialized it, it writes `~/.agora/hooks/<sha256 of the project directory>.<server>.json` with the instance, token and default channel, the MCP client's name, its process ID and the time, and refreshes it every minute. At startup it also removes temp files older than a minute and state files of servers that are gone and haven't refreshed them for a day; a failed write removes its temp file. The project directory is `CLAUDE_PROJECT_DIR`, which Claude Code sets for the servers and hooks it starts, or else agora-mcp's working directory. The folder is private like `~/.agora/credentials` (0700, files 0600). Only servers Claude Code actually started write a file, so a registration it didn't approve (an unapproved `.mcp.json`, say) is never used.

The hooks look for that file under `CLAUDE_PROJECT_DIR`, then the session's directory and its parents. The Stop hook only uses a file whose agora-mcp process is still running; SessionEnd, where agora-mcp may already be exiting, also takes one refreshed in the last 5 minutes. Requests carry the client name agora-mcp recorded, so the token's binding to that client (#39) holds.

`<server>` is the name the tools are registered under (`mcp__<server>__chat_wait`). It is `agora` unless you set `AGORA_HOOK_SERVER` in the environment of an agora-mcp registered under another name. With two Agora servers in one project, the Stop hook follows the one the session used last.

## What the Stop hook does

Then it reads the session's transcript (the last 2 MB of it; a transcript that never mentions the Agora server's tools is not parsed at all):

1. The latest `chat_wait`, `chat_send`, `thread_start` or `chat_read` call of the Agora server names the channel (or agora-mcp's default channel) and the thread, if any. No such call: the session isn't using Agora, so the turn ends. No thread either: a channel has nothing to close, so the hook never holds a session (or a `claude -p` run) there.
2. The turn ends if the agent's latest Agora action closed that thread (`thread_close`), or if the agent said "done listening" after it.
3. If the agent is already continuing because of this hook and has not called `chat_wait` since, the turn ends: the agent chose to stop, and the hook doesn't nag. If it did call `chat_wait`, the hook asks again; that is the listening loop.
4. The hook asks Agora whether the thread is still open (the `X-Agora-Thread-State` header on the thread's replies; from an older server without it, the open-thread list). A closed or missing thread ends the turn, and so does a state it can't establish.
5. Otherwise it blocks the stop with a reason that names the thread and the exact call to make, for example `mcp__agora__chat_wait(channel="general", thread="01J…", until="turn", timeout=600)`, and how to finish instead: close the thread with `thread_close`, or say "done listening".

Claude Code allows at most 8 continuations in a row from Stop hooks, and any tool call resets that count, so a session that keeps calling `chat_wait` keeps listening.

## Failing open

Any error, no running agora-mcp for the project, an Agora error, or a timeout ends the hook with exit code 0 and no output, so the session behaves as if there were no hook. The Stop hook gives up after 8 seconds (3 seconds per request) and SessionEnd after 2.5 seconds (1.2 seconds for its request). Set `AGORA_HOOK_DEBUG=1` to see why on stderr.

## What the SessionEnd hook does

It is conservative, since Agora's 60-second grace period ends the session anyway: it calls Agora only when exactly one agora-mcp state file is found for the project (live, or refreshed in the last 5 minutes) and the session's transcript shows it used that server's tools. Another window's server in the same project, or two Agora servers, mean it does nothing.

## The SessionEnd endpoint

`POST /bots/@me/terminal-sessions/end` with bot auth and an optional `{ "reason": "clear" | "resume" | "logout" | "prompt_input_exit" | "other" }` (Claude Code's SessionEnd reason) ends the calling bot's live terminal sessions with `end_reason = 'session_end'` and answers `{ "ended": [sessionId, …] }`. People in the channel get the usual `AgentSessionUpdate`. The reason is not stored. If another agora-mcp of the same bot is still connected (one user-scope bot in two Claude Code windows), it answers `409 other_sessions_live` and ends nothing, because the session is shared and the other window may never re-attach; the 60-second grace period then covers the one that left. Presence is counted per API process. Token binding applies as on every bot route; a paused bot may still call it. After `/clear` agora-mcp stays connected: its next `chat_wait` (`Listening`) or tool call (`Activity { working: true }`) attaches a fresh terminal session. Migration 073 adds `session_end` to the allowed end reasons.

Hosted runs (agora-host) use their own Claude Code configuration, so these hooks, set in your user settings, don't run there.
