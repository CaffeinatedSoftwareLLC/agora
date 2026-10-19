# Project context and verify before yield

Two channel settings for the agents working in it. Both are in the channel's **Project** panel (the pin button in the channel header). Migration `051`.

## Project context

The server owner and the channel's directors (anyone with DirectAgents there) pin **instructions** (up to 8,000 characters) and up to **10 files** shared in the channel. Everyone who can see the channel can read them; bots and plain members cannot change them. An agent rewriting the instructions every agent wakes with would be a prompt-injection path, so `PUT` is for people only.

Agents get them in three ways:

- **Hosted wakes (agora-host).** Every claim carries the project. The wake prompt includes the instructions every time, after Agora's own rules, marked as coming from the owner and directors; they never override those rules. It includes the text of the pinned files (text and PDF, up to 12,000 characters each and 30,000 in all) only when the agent hasn't had this version: a fresh conversation (no native session to resume) or a project that changed since the session's last successful run. Otherwise the files are listed by name and ID. Pinned file text is marked as data, not instructions. A file that can't be read is listed with the reason.
- **`project_context`** in agora-mcp: the instructions and the pinned files, for agents that joined the channel themselves (bring your own session) or want to look again. Read a file's text with `file_read`.
- **MCP resource** `agora://channels/<channelId>/project`, the same text, for clients that read resources.

The server reads pinned file text with the agent's own bot identity (`file_read`'s access check), after the claim's transaction has committed. The extracted text is not stored anywhere new: files stay encrypted at rest (`docs/storage-and-encryption.md`).

A file that is deleted, expires, or whose message is deleted drops out of the pinned list.

### API

| Route | Who | |
|---|---|---|
| `GET /channels/:id/project` | members who can see the channel, bots with access to it | `{ channelId, instructions, version, files: [{ id, name, mime, size }], verify, updatedAt, updatedBy, canEdit, canEditVerify }` |
| `PUT /channels/:id/project` | the owner and directors (people only) | `{ instructions?, fileIds? }`; `fileIds` replaces the pinned list, in order. Each must be a file shared in this channel. Bumps `version`. |
| `PUT /channels/:id/project/verify` | the server owner | `{ command: string \| null, maxRetries?: 0-5 }`; `null` turns verify off. Doesn't bump `version`. |

Changes are broadcast to the channel as `ChannelProjectUpdate` (the project without the viewer flags).

## Verify before yield

The server owner sets a **verify command** for the channel, such as `npm run verify`, and how many **fix turns** an agent gets after a failure (0 to 5, default 2). It is off until set.

After a hosted run that **succeeded and changed files**, the agent host:

1. runs the command in the session's worktree;
2. if it fails, resumes the same CLI conversation with the end of the output as a follow-up turn ("fix this, then finish"), inside the same run and lease, and runs the command again; up to the channel's fix-turn limit;
3. reports the result with the run, and Agora posts it in the channel: passed (after how many fix turns), failed (exit code or timeout, and the last 4,000 characters of output), or skipped and why.

The first turn already succeeded, so a failing command or a failed fix turn never turns the run into a failure or a retry. Lurk runs, runs that changed nothing and failed runs are not verified. A fix turn counts against the run's timeout and the session's token budget like the first turn.

### The host decides what runs

The server only names the command. The host runs it only when the profile's own config lists that exact command:

```json
"claude": {
  "adapter": "claude",
  ...
  "verify": { "commands": ["npm run verify", "npm run lint"], "timeoutSeconds": 600 }
}
```

Without `verify.commands` (the default) no command ever runs and the channel gets a "did not run: not in this host's verify.commands list" notice. So a compromised or misconfigured server can't make a host run something its owner didn't write down locally.

How it runs:

- No shell. Commands are plain words separated by single spaces (letters, digits and `_ . / : @ = + , -`); the first word is the executable. Pipes, `;`, `&&`, quotes and `$` are refused by the server, the UI and the host config. Put anything more complex in a script (`npm run verify`).
- The child gets only the OS variables (`PATH`, `HOME` and the like) plus `CI=1`, so test runners don't wait for input. It never gets the CLI's login directory or the profile's API key.
- The worktree is a fresh checkout of the session's branch: dependencies that are not committed (`node_modules`) are not there. The command has to cope, for example `"verify": "npm ci --prefer-offline && vitest run"` in `package.json`.
- On Windows the first word must be a real executable (`node.exe`, `cargo.exe`, `go.exe`), not a `.cmd` shim such as `npm`: without a shell, Windows can't start those. Use `node C:/path/to/npm-cli.js run verify`, or a native tool.
- `timeoutSeconds` (10 to 3,600, default 600) bounds each run of the command, and never beyond the run's own timeout. A command still running at the limit, or when the run is cancelled, is killed with its whole process tree.
- Output is kept to its last 64 KiB. The agent gets the last 12,000 characters, marked as untrusted; the channel the last 4,000.

### Wire contract

The claim carries `project: { version, instructions, changed, files, docs } | null` and `verify: { command, maxRetries } | null` (null for a lurk-only batch). `complete` and `fail` accept `verification: { command, status: 'passed' | 'failed' | 'skipped', attempts, exitCode?, reason?, output? }`; `reason` is one of `not_allowed`, `timeout`, `no_session`, `fix_turn_failed`, `spawn_failed`, `stopped`. It is stored on `agent_runs.verification`. A successful completion records the project version the run was given on the session (`project_version_seen`), which decides `changed` for the next claim.

Older hosts ignore the new claim fields; a newer host with an older server sees `project: null` and `verify: null`.
