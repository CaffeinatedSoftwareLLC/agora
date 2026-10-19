# agora-host

A Node 22+ Windows service process that claims leased Agora deliveries, starts a
headless Codex or Claude Code turn, reports the result, and exits the child. Start
it with a trusted local JSON file; Agora commands cannot supply paths or flags.

```powershell
npm install
npx tsc --noEmit
npx vitest run
npm run build
node dist/index.js --config C:/private/agora/host.local.json
```

The package's tests use fake children and local HTTP servers. They never start
either agent CLI. See `H0 results (2026-10-17)` in the WBS for actual CLI checks
and limitations. The host contract is in `docs/planning/agent-sessions-wbs.md`.

## Configuration

Keep the real file outside the agents' writable workspaces, restricted to your
Windows account. Do not commit it. `host.local.json` is ignored here.

```json
{
  "instance": "http://127.0.0.1:3000",
  "hostToken": "ah_TOKENID.SECRET",
  "mcp": {
    "executable": "C:/Program Files/nodejs/node.exe",
    "entrypoint": "C:/agora/agora-mcp/dist/index.js"
  },
  "profiles": {
    "codex": {
      "adapter": "codex",
      "executable": "C:/tools/codex.exe",
      "workdir": "C:/projects/agora",
      "workdirAlias": "agora",
      "stateDir": "C:/private/agora/codex-state",
      "sandbox": "workspace-write",
      "approvedTools": ["chat_history", "chat_send", "thread_start", "thread_list", "thread_close", "who_directs"],
      "caps": {}
    },
    "claude": {
      "adapter": "claude",
      "executable": "C:/Users/USER/.local/bin/claude.exe",
      "workdir": "C:/projects/agora",
      "workdirAlias": "agora",
      "stateDir": "C:/private/agora/claude-state",
      "approvedTools": ["chat_history", "chat_send", "thread_start", "thread_list", "thread_close", "who_directs"],
      "caps": { "maxBudgetUsd": 2 }
    }
  },
  "botTokens": {
    "BOT_ULID_FOR_CODEX": "bot_TOKENID.SECRET",
    "BOT_ULID_FOR_CLAUDE": "bot_TOKENID.SECRET"
  },
  "maxConcurrent": 2
}
```

Profile names, adapter and `workdirAlias` must match the server's profiles.
`model` and `effort` come from each claim. The host maps them to verified CLI
flags; it refuses unsupported effort values. Native IDs must be explicit UUIDs.
There is no `--last`/`--continue` fallback. A failed native resume is reported as a
failure, rather than silently starting a different conversation.

Use the real Codex **native executable**, found under the npm installation's
`@openai/codex-win32-x64/vendor/.../bin/codex.exe`, not `codex.cmd` or `codex.ps1`.
Executables and directories are absolute local paths. No shell is used.

Each profile needs a separate persistent `stateDir`. Authenticate the CLI with
`CODEX_HOME` (Codex) or `CLAUDE_CONFIG_DIR` (Claude) set to that directory before
starting the host. The host does not copy login files or credentials from another
profile. Run normal CLI login under those environment settings yourself. Store
these directories outside the agent workdirs, with Windows ACLs restricted to
your account. The per-run config files contain no token; the selected bot token
is passed through the child environment and inherited by its Agora MCP server.
The temporary files are removed after that turn; CLI session state remains for
native resume. Node's file modes do not replace Windows ACLs.

Each session now runs in `<stateDir>/wt-<last10(sessionId)>`, on
`agora/<profile>/<sessionId>`, starting from the mapped workdir's HEAD. The
adjacent `.json` record preserves its original base SHA across wakes and host
restarts. Reuse requires the exact worktree root, common Git directory and branch.
Keep `stateDir` short on Windows: Git itself still rejects overlong Git-directory
paths even with `core.longpaths=true`; long tracked filenames are supported.

At startup and every 60 seconds (after an in-flight claim poll, up to 25 seconds),
the host checks ended sessions with the server. It skips active/claimed runs,
removes only clean worktrees, and retains branch refs. Dirty worktrees remain on
disk and get a channel warning listing uncommitted files. Repeated identical
warnings are suppressed after a successful post. Missing/incompatible metadata,
repository mappings or branch identities fail safely without force-removal.

For advisory file reservations, add `file_reserve`, `file_renew`, `file_release`
and `file_reservations` to a profile's `approvedTools` as needed. The server's
owner-assigned `workspaceId` identifies the repository across profiles/hosts;
the host's `workdirAlias` remains only a local directory mapping. All existing
profiles use workspace `primary` within their server. Give unrelated repositories
different workspace IDs in Agents settings; end existing sessions before changing
an ID. The server snapshots this identity when each session starts.

Reserve repository-relative exact filenames or explicit directory prefixes ending
in `/`, e.g. `src/app.ts` or `src/routes/`. Separators, Unicode and case are
normalized (case folding is conservative on Linux). Absolute paths, `..`, globs,
Windows trailing dots/spaces and control characters are rejected. Reservations
are advisory; no hooks or edit enforcement are installed. TTL defaults to 900
seconds, maximum 3600. Expired rows immediately stop blocking/listing and cannot
be renewed; writes mark expired rows released. `/end` releases all of that
session's reservations transactionally. A channel owner/director can force-release
an ID in the holder's channel; the holder receives a channel notice and a wake.

The child inherits an OS-variable allowlist, not the host's environment. It does
not inherit API keys, the host token, sibling tokens, `NODE_OPTIONS`, or nested
agent flags. CLI authentication must live in that profile's state directory.
Codex ignores user config and gets an explicit top-level MCP map override;
Claude uses `--strict-mcp-config`. Project instructions and normal CLI policy
still apply. Only locally listed `approvedTools` are preapproved, using the
CLIs' normal tool approval controls; `chat_wait` is deliberately unavailable in
this list. Add orchestrator tools only after the owner grants the bot authority.

Codex uses `approval_policy=never` with `read-only` or `workspace-write`; Claude
uses `manual` permissions with `--permission-prompts none`. Neither adapter uses
sandbox or permission bypass flags. Any other action that needs approval fails
normally. Claude filesystem edits may require operator-configured normal local
permission rules; the host does not auto-approve them.

Neither tested CLI advertises a hard per-run token cap. Omitting `maxTokens`
explicitly selects timeout + server session accounting, with a startup warning.
Setting `caps.maxTokens` is an error. Claude alone supports `maxBudgetUsd`.
Codex 0.163.x and Claude 2.1.x are the verified help-format families; another
version requires an explicit local `allowUntestedVersion: true` and operator
verification. A version probe is not proof of model availability or login.

## Execution and recovery

- Claim GET requests are not retried automatically. A lost claim response leaves
  recovery to the lease sweeper; the host never assumes it owns an unseen run.
- One child runs per session. A duplicate session claim shuts this host down.
- Leases use the host's monotonic request-send time plus `leaseSeconds`, minus
  ten seconds. Heartbeat success renews from its send time, not response time.
  Heartbeat failure never extends a lease. A separate watchdog stops the child
  before the last confirmed lease expires, even if an HTTP request hangs.
- Cancel, timeout, fencing and auth errors stop the process tree with
  `taskkill /PID <child> /T /F`. Host-token 401/403 stops **all** children. The host
  waits for termination; if tree termination fails, it stops claiming, withholds
  completion/failure and logs a fixed error code. Verify this works under the
  account and sandbox that will run the deployed host.
- Completion/failure retry transient network/5xx errors up to three total
  attempts with identical bodies. Fencing/auth responses are never retried.
  Reports are bounded by the confirmed lease deadline. SIGINT/SIGTERM stop
  children without releasing unfinished work as successful.
- A fresh run receives the stored summary plus the batch; a native resume gets
  fresh delivery metadata and messages. Content uses the copied Agora envelope
  formatter, with authority tags and continuation markers. Summaries are data.
- The prompt requests a structured summary and `<deliveryKey>:<n>` message keys.
  Server/MCP S0/S5 must support those keys; a model that ignores the rule can
  still duplicate posts. The host cannot make model execution exactly once.
- Codex usage is input + output (cached input is a subset). Claude uses the
  result's usage input + cache creation + cache read + output, not cumulative
  `modelUsage` or cost totals. Missing usage is `null`. Successful authenticated
  JSON output and native resume still require the H0 live follow-up.

Logs contain static status codes, never raw CLI output, prompts, auth headers or
configuration. Stderr is drained without forwarding. Stdout is bounded to 8 MiB;
API responses to 1 MiB. Keep the host config and CLI state private: a host process
is trusted local software running under your Windows account.

This package does not deploy or modify the server. S2 integration, real CLI
resume/usage and tree-kill verification, and the S7 phone/deployment test remain
release gates.
