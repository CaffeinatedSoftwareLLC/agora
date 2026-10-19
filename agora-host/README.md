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
      "approvedTools": ["chat_history", "chat_send", "thread_start", "thread_list", "thread_close", "who_directs", "project_context"],
      "caps": { "maxBudgetUsd": 2 },
      "verify": { "commands": ["npm run verify"], "timeoutSeconds": 600 }
    }
  },
  "botTokens": {
    "BOT_ULID_FOR_CODEX": "bot_TOKENID.SECRET",
    "BOT_ULID_FOR_CLAUDE": "bot_TOKENID.SECRET"
  },
  "maxConcurrent": 2
}
```

### How each CLI signs in (provider terms)

Every profile declares `auth` (see [docs/provider-terms.md](../docs/provider-terms.md)):

- `"auth": "subscription"` (the default): the CLI's own login in its `stateDir`. Only the
  server owner can wake the agent: the owner's messages, `/start`, `/resume`, and hand-offs
  between sessions the owner started. Everyone else is refused with a channel notice.
- `"auth": "api_key"` with `"apiKeyEnv"`: the host passes that one variable from its own
  environment to the child. Allowed names: `ANTHROPIC_API_KEY` (claude), `CODEX_API_KEY` or
  `OPENAI_API_KEY` (codex), `GEMINI_API_KEY` or `GOOGLE_API_KEY` (gemini). The host refuses to
  start if the variable is unset, and never prints its value. Ordinary authority rules apply.
- `"auth": "siwc"` (codex only): Sign in with ChatGPT. The agent runs `codex app-server` on the
  ChatGPT Plus/Pro plan of the person who connected it, with the plan's OAuth access token in
  the child's environment (never its arguments), not on the machine's `codex login`. Connect
  from Settings → Agents (**Continue with ChatGPT**, the browser opens on this machine) or run
  `agora-host siwc login --profile <name> --config <file>`; also `siwc status` and
  `siwc logout`. Tokens stay in `siwc.dir` (default `~/.agora-host/siwc`, `0600` files) and are
  never sent to Agora. Only the plan owner can wake the agent. Local and self-hosted use only.
  Optional top-level `"siwc": { "dir": "...", "callbackPort": 1455 }`. Full guide:
  [docs/codex-chatgpt-plan.md](../docs/codex-chatgpt-plan.md).
- `"requireRunApproval": true`: every wake waits for the owner's **Approve run** card.
- `adapter: "gemini"` must use `api_key`; on account login the host refuses to start and quotes
  Google's Antigravity terms §6. `"allowSubscriptionAtOwnRisk": true` overrides that and forces
  run approval; that reduces the terms risk but does not remove it. Gemini is not a hosted
  adapter yet, so a gemini profile currently stops the host after this check.

```json
"claude-team": { "adapter": "claude", "auth": "api_key", "apiKeyEnv": "ANTHROPIC_API_KEY", "...": "..." },
"codex-plan": { "adapter": "codex", "auth": "siwc", "...": "..." }
```

At start the host reports each profile's mode to Agora (`POST /agent-hosts/@me/profiles`,
variable names only), and checks every claim against its own config as well.

Profile names, adapter and `workdirAlias` must match the server's profiles.
`model` and `effort` come from each claim. The host maps them to verified CLI
flags; it refuses unsupported effort values. Native IDs must be explicit UUIDs.
There is no `--last`/`--continue` fallback. A failed native resume is reported as a
failure, rather than silently starting a different conversation.

Use the real Codex **native executable**, found under the npm installation's
`@openai/codex-win32-x64/vendor/.../bin/codex.exe`, not `codex.cmd` or `codex.ps1`.
Executables and directories are absolute local paths. No shell is used.

`mcp.entrypoint` is the Agora MCP server's `dist/index.js`. With
`npm install -g https://github.com/CaffeinatedSoftwareLLC/agora/releases/latest/download/agora-mcp.tgz`
it is under `npm root -g`, e.g.
`C:/Users/USER/AppData/Roaming/npm/node_modules/@caffeinated-software/agora-mcp/dist/index.js`;
with a repository build it is `agora-mcp/dist/index.js` in your checkout.

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
not inherit API keys (except its own `apiKeyEnv` in `api_key` mode), the host token,
sibling tokens, `NODE_OPTIONS`, or nested agent flags. Otherwise CLI authentication
must live in that profile's state directory. The host never reads or copies those
login files.
Codex ignores user config and gets an explicit top-level MCP map override;
Claude uses `--strict-mcp-config`. Project instructions and normal CLI policy
still apply. Only locally listed `approvedTools` are preapproved, using the
CLIs' normal tool approval controls; `chat_wait` is deliberately unavailable in
this list. Add orchestrator tools only after the owner grants the bot authority.

Codex uses `approval_policy=never` with `read-only` or `workspace-write`; Claude
uses `manual` permissions with `--permission-prompts none`. Neither adapter uses
sandbox or permission bypass flags. Any other action that needs approval fails
normally, and is reported back to Agora as an approval request (below).

## Tool presets and approvals (#73)

The owner picks tool presets per agent in Settings → Agents. Every claim carries
the profile's presets, its "always allowed" rules and any rules approved once for
this run, so an edit applies from the next wake without touching this config or
restarting the host. The host translates them to each CLI's own mechanism:

| Preset | Claude (`--allowedTools`) | Codex | Gemini / agy (not hosted; settings.json) |
| --- | --- | --- | --- |
| `readonly` | `Read`, `Glob`, `Grep`, `Bash(git status/diff/log/show:*)` | `-s read-only` | read tools only |
| `dev` | read tools, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash(…:*)` and `PowerShell(…:*)` for git, gh, npm, npx, node | `-s workspace-write`, `sandbox_workspace_write.network_access=true` | shell allow rules for git, gh, npm |
| `research` | `WebSearch`, `WebFetch` | `web_search="live"` | `search_web`, `read_url_content`, `read_url(*)` |

- Without any preset the profile's local `sandbox` and `approvedTools` decide, as
  before. With presets, Codex's sandbox follows them (`read-only` unless one
  grants `workspace-write`), so `research` alone runs Codex read-only.
- Redefine a preset or add one with a top-level `presets` object, e.g.
  `"presets": { "dev": { "claude": ["Bash(cargo:*)"], "codex": { "sandbox": "workspace-write" } } }`.
  A preset name the host doesn't know is skipped and logged as `unknown_tool_preset`.
- Rules use Claude's permission-rule syntax without commas. Codex `exec` has no
  per-command allow list, so for Codex only `write`, `network`, `web_search` and
  `mcp__agora__<tool>` mean anything.
- Gemini (agy) isn't a hosted adapter. In headless mode one denied host ends the
  whole run, and `read_url_content` is checked as `read_url(<host>)`, so give a
  research agent `search_web`, `read_url_content` and `read_url(*)` in
  `~/.gemini/antigravity-cli/settings.json`.

**Denied tools.** Claude Code reports each denied call in the result's
`permission_denials`; the host turns it into a narrow rule (`Bash(gh:*)` for a
shell command, `WebFetch(domain:host)` for a fetch, else the tool name) and sends
it with the run's report. Agora posts an approval card: the owner or a director
can approve it once (granted to the session's next run, and the agent is woken to
retry) and the owner can always allow it (added to the profile). Codex gives no
denial signal: the host guesses `write` (read-only sandbox, "access denied"
output) and `network` (DNS/connect errors) from failed commands' output, and
misses denials that fail silently. Codex's Windows sandbox may block network even
with `network_access=true` (seen with `unelevated` on 0.163).

**Rate limits (#87).** A Claude `rate_limit_event` with status `rejected` (its
`resetsAt` gives the reset time), a 429, or a Codex `turn.failed`/`error` about a
usage limit ("try again in 2 hours", "try again at 3:45 PM") is reported as
`rate_limited`. The session sleeps until the reset (30 minutes if unknown, at most
24 hours), its messages are held, and the first claim after it delivers them in
one batch. The rate-limited attempt costs neither a retry nor a wake.

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
### Project context and verify before yield

Each claim carries the channel's pinned instructions and files (`project`), and the prompt includes them; pinned file text only when the agent hasn't had that version yet. When a channel's owner sets a verify command and the run succeeded and changed files, the host runs it in the worktree and gives the agent the failure output as a resumed follow-up turn, up to the channel's limit, then reports the result. It runs only commands the profile lists itself:

```json
"verify": { "commands": ["npm run verify"], "timeoutSeconds": 600 }
```

No shell, OS variables plus `CI=1` only, bare executables resolved from absolute `PATH` entries (never the worktree), process tree killed on timeout. The command runs code the agent just edited, as your account and outside the CLI's sandbox, so list only commands you would let that agent run itself. See [project-context.md](../docs/project-context.md).

### Passive turns and referenced images (#83, #86)

Lurk deliveries carry `session.lurkMode` and inbox reason `lurk`. A purely passive batch uses the dial's interjection rules and permits exact `[pass]` without forcing a JSON schema. `[pass]` completes successfully, preserves token usage and leaves the prior session summary intact. Normal addressed work still requires its usual response.

After the CLI exits and before reporting completion/failure, the host discovers this run bot's posted image references through the host API. It reads only real paths under the actual run cwd/worktree or `os.tmpdir()`, using the server's size limit, then uploads bytes with the host token. The lease watchdog and heartbeat remain active during uploads. The API attaches images to their original message through `storeFile()` and deduplicates by content per run. Invalid, missing, outside-root or rejected images are skipped; auth/fencing errors stop reporting through the existing host rules. See [agent-sessions.md](../docs/agent-sessions.md#referenced-images) for the endpoint contract.
