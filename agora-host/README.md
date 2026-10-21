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
  Google's Antigravity terms §6. The host runs Gemini only over ACP with an API key
  ([ACP agents](#acp-agents-agent-client-protocol)). The old `allowSubscriptionAtOwnRisk` flag
  opens no path: a gemini profile on account login is never hosted.

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

Before workspace commands and at startup, the host checks the linked worktree's own
`index.lock` and `HEAD.lock`. Each host Git operation has a gated owner process whose
PID and OS creation time are written atomically beside the session record before Git
can start. A recorded dead process (including a reused PID) lets the host clear its
regular, unchanged locks and log `workspace_git_lock_cleared`. If Git is still running,
the process identity cannot be checked, or a lock has no host ownership record, the
host keeps it and reports `stale_git_lock` with the path for the owner to inspect.
Symlink and hard-linked locks are refused; shared repository refs are never cleared.
Identity probes and diff previews are read-only and cannot replace a writer's record.

For advisory file reservations, add `file_reserve`, `file_renew`, `file_release`
and `file_reservations` to a profile's `approvedTools` as needed. The server's
owner-assigned `workspaceId` identifies the repository across profiles/hosts;
the host's `workdirAlias` remains only a local directory mapping. All existing
profiles use workspace `primary` within their server. Give unrelated repositories
different workspace IDs in Agents settings; end existing sessions before changing
an ID. The server snapshots this identity when each session starts.

For ownership handoffs (#84), add `handoff_offer`, `handoff_accept`,
`handoff_decline` and `handoff_cancel`. When a wake carries a handoff offer, the
host checks that the sender's pinned commit is in this repository (the session
worktrees share it) and tells the agent how to inspect it (`git diff HEAD...<sha>`)
and apply it to its own worktree through a patch file in the system temp folder
(`git diff --binary <merge-base> <sha> --output <file>`, then `git apply <file>`;
never a pipe, which Windows PowerShell 5.1 corrupts). The
host never writes to the sender's worktree and grants no extra sandbox roots;
the applied files are committed on the recipient's branch at the end of its turn.

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

Codex `exec` uses `approval_policy=never` with `read-only` or `workspace-write`
(`siwc` profiles run `codex app-server` with `on-request` instead, see
[Codex app-server approvals](#codex-app-server-approvals-93)); Claude
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
- Antigravity (agy) isn't a hosted adapter. In headless mode one denied host ends the
  whole run, and `read_url_content` is checked as `read_url(<host>)`, so give a
  research agent `search_web`, `read_url_content` and `read_url(*)` in
  `~/.gemini/antigravity-cli/settings.json`. Gemini CLI is hosted over ACP and uses the
  Claude column's rules (below).
- ACP profiles (any adapter) use the Claude column: the host answers the agent's
  permission requests from those rules, plus `mcp__agora__<tool>` for `approvedTools`
  and Codex's words (`write` allows edits, `network` fetches, `web_search` searches).

**Denied tools.** Claude Code reports each denied call in the result's
`permission_denials`; the host turns it into a narrow rule (`Bash(gh:*)` for a
shell command, `WebFetch(domain:host)` for a fetch, else the tool name) and sends
it with the run's report. Agora posts an approval card: the owner or a director
can approve it once (granted to the session's next run, and the agent is woken to
retry) and the owner can always allow it (added to the profile). Codex `exec`
gives no denial signal: the host guesses `write` (read-only sandbox, "access denied"
output) and `network` (DNS/connect errors) from failed commands' output, and
misses denials that fail silently. That fallback is best effort; `codex app-server`
(`siwc`) and codex-acp report each denial reliably. Codex's Windows sandbox may block
network even with `network_access=true` (seen with `unelevated` on 0.163).

### Codex app-server approvals (#93)

A `siwc` profile runs `codex app-server` with `approval_policy="on-request"`: Codex
works inside its sandbox and asks the host before anything the sandbox doesn't allow.
Each request is answered once, and only if it belongs to the thread and turn the host
started (verified against codex 0.163's `app-server generate-json-schema` and live runs):

| Request | Judged as | Allowed when | Answer |
| --- | --- | --- | --- |
| `item/commandExecution/requestApproval` | the command (`powershell.exe -Command '…'`, `cmd.exe /c '…'` and `bash -lc '…'` are unwrapped) | its cwd is in the worktree, the program is a trusted executable (as for ACP, #111) and a rule matches (`Bash(git:*)`) | `{"decision":"accept"}` or `"decline"` |
| … with `networkApprovalContext` (managed network) | a fetch of that host | `network`, `WebFetch` or `WebFetch(domain:host)` | same |
| `item/fileChange/requestApproval` | `write`, for the paths on its `fileChange` item | every path (and any `grantRoot`) is in the worktree, and `write` (or `Edit`) is allowed | same |
| `item/permissions/requestApproval` | `network`; plain worktree paths for `write` | as listed | the allowed subset, `"scope":"turn"` |
| `mcpServer/elicitation/request`, legacy `execCommandApproval`/`applyPatchApproval`, anything else | — | never | `decline` / `denied` / JSON-RPC error |

The rules are the profile's "always" rules, this run's one-time grants, `approvedTools`
and the capability words its presets turn on (`write`, `network`, `web_search`). A
preset's Claude rules don't count: an approved request runs outside the sandbox, so
`dev`'s `Bash(node:*)` doesn't approve an escalated `node` command by itself.

Anything else in the worktree becomes a tool-request card while the request is held:
the card names the rule and shows the whole command and its cwd (a command over 8 KB
is declined rather than truncated), and is bound to that one request
(its key hashes the thread, turn, item and JSON-RPC id). **Approve once** and
**Always** answer the request `accept` (Always also adds the rule to the profile;
the host never sends `acceptForSession` or execpolicy amendments, so Codex remembers
nothing), **Deny** answers `decline`. A program that isn't a trusted executable, such
as a PowerShell cmdlet, is asked for as the whole shell (`Bash`). A path outside the
worktree is declined without a card. The card denies itself after
`approvalWaitSeconds` (top-level config, default 300) and expires when Codex resolves
the request itself, the turn ends, the run stops, or the session is stopped, shelved,
paused or loses channel access; an expired card approves nothing, and a decision
made before a stop is never relayed after it.
On a server without live tool requests, the request is declined and reported as an
after-run card, as before.

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

## ACP agents (Agent Client Protocol)

A profile with `"protocol": "acp"` drives an agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (v1) over JSON-RPC on its
stdio, instead of the CLI's own headless mode. Built against the protocol schema
(`@agentclientprotocol/sdk` 1.9.0) and checked against the published agents' code
(`@google/gemini-cli` 0.64.0, `@agentclientprotocol/claude-agent-acp` 0.93.0,
codex-acp `main`); the tests use a fake agent. Not yet run against the real agents.

| Agent | `adapter` | `executable` / `acpArgs` | `auth` |
| --- | --- | --- | --- |
| Gemini CLI | `gemini` | `node.exe` / `[".../@google/gemini-cli/bundle/gemini.js", "--acp"]` | **`api_key` only** (`GEMINI_API_KEY`; `GOOGLE_API_KEY` for Vertex AI) |
| Claude Code ([claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)) | `claude` | `node.exe` / `[".../@agentclientprotocol/claude-agent-acp/dist/index.js"]` | **`api_key` only** (`ANTHROPIC_API_KEY`; claude-agent-acp wraps the Agent SDK, not the unmodified `claude` binary) |
| Codex ([codex-acp](https://github.com/zed-industries/codex-acp)) | `codex` | the native `codex-acp.exe` from `@zed-industries/codex-acp-win32-x64` / `[]` | **`api_key` only** (`CODEX_API_KEY` or `OPENAI_API_KEY`; codex-acp embeds Codex's core and reads the login itself) |

```json
"gemini": { "adapter": "gemini", "protocol": "acp", "executable": "C:/Program Files/nodejs/node.exe",
  "acpArgs": ["C:/Users/USER/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/gemini.js", "--acp"],
  "auth": "api_key", "apiKeyEnv": "GEMINI_API_KEY", "workdir": "C:/projects/agora", "workdirAlias": "agora",
  "stateDir": "C:/private/agora/gemini-state", "approvedTools": ["chat_history", "chat_send", "thread_start"] }
```

`.cmd` shims are still refused: point `executable` at `node.exe` and put the script
first in `acpArgs`. The arguments are local config only; Agora never supplies any.
As for the CLIs, the profile's `stateDir` holds the agent's settings and login:
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and for Gemini `GEMINI_CLI_HOME`, which keeps your
own `~/.gemini` (and any Google login cached there) out of hosted runs.

**One turn.** `initialize` (protocol version 1, else the run fails with
`acp_protocol_unsupported`) → `authenticate` (API-key profiles only, below) →
`session/new` in the session worktree, with the Agora MCP server (bot token in its
`env`) → `session/set_config_option` for the profile's model and effort → one
`session/prompt` with the wake prompt → stdin closed, then the process tree stopped.
The session ID is stored like a CLI's native ID; the next wake uses `session/resume`,
else `session/load`, and fails with `native_resume_unsupported` rather than start a
new conversation. A model the agent doesn't list fails with `acp_model_unavailable`;
an effort it doesn't list is ignored. The summary is the JSON `summary` of the
agent's final message, else its text; `[pass]` works for lurk runs.

**Sign-in (provider terms).** The host never calls an ACP login method. An `api_key`
profile calls only the `authenticate` method that reads its variable
(`gemini-api-key`, `vertex-ai`, `codex-api-key`, `openai-api-key`; Claude Code reads
`ANTHROPIC_API_KEY` itself and needs none) and refuses to run with
`acp_api_key_auth_unavailable` when the agent doesn't offer it, so it can't fall back
to an account login in `stateDir`. codex-acp saves the key in its `CODEX_HOME`, like
`codex login --with-api-key`; Gemini records the choice in its settings there. Every ACP profile must be `api_key`: the host refuses `subscription` over ACP
for all adapters ([provider terms](../docs/provider-terms.md)); use `protocol: "cli"`
for a subscription. An agent asking for sign-in fails the run with
`acp_auth_required`. A gemini profile must be `api_key`: Agora never hosts a Google
account login, and `allowSubscriptionAtOwnRisk` does not apply to ACP.

**Permissions (#73, #93).** File calls (read, edit, delete, move) are answered only when every path they name is inside the run's worktree (links resolved); a call outside it, or without a known path, is refused with no approval card, whatever the rules say. A command rule such as `Bash(git status:*)` means the `git` found through absolute `PATH` entries outside the worktree and repository: `./git status`, `bin\git.exe status` or an absolute path inside the repository are refused (as is a bare `git` on Windows when the working directory holds a `git.exe`); an absolute path outside them matches only a rule naming that exact path. The first `PATH` match decides, and the agent's `PATH` loses every entry inside the worktree or repository. The host advertises no file system or terminal, so the
agent uses its own tools in the worktree and asks before anything it may not run
alone (`session/request_permission`). The host answers at once from the claim's
rules: a match gets `allow_once`; anything else gets `reject_once`, and the rule that
would allow it (`Bash(gh:*)`, `Edit`, `WebFetch(domain:host)`, `mcp__agora__chat_send`)
goes into the run's denied tools, so Agora posts the usual approval card. Prefix rules
match as in Claude Code (`Bash(git status:*)` allows `git status -s`); a command with
`;`, `&`, `|`, `<`, `>`, `` ` ``, `$` or brackets needs a bare `Bash` rule and is
reported as `Bash`. The host never picks `allow_always` or `reject_always`, which the
agent would remember outside Agora. For Codex this replaces guessing denials from
command output: running Codex through codex-acp gives a structured signal.

Gemini asks for an MCP call without the tool's name (its title is built from the
arguments), so the host can't map those requests. It also gives Gemini the same rules
as a per-run policy file (`--policy`, removed after the run): Agora MCP tools, shell
prefixes (`commandPrefix`), edits, `web_fetch` and `google_web_search`. Gemini's own
policy engine then allows those calls without asking; an Agora MCP tool not in
`approvedTools` is refused without a card.

**Progress, diffs, usage.** Each heartbeat carries the latest tool call title, the
number of tool calls and the plan's progress; the channel shows it under "is
working…" (not stored). Diff paths of completed tool calls are added to the run's
changed files, alongside the worktree comparison. Tokens come from the prompt
response's `usage` when the agent reports it, else `null`. ACP has no verified USD
cap, so `caps.maxBudgetUsd` is refused on ACP profiles.

**Not covered.** ACP agents may load MCP servers and settings from their own config
in `stateDir` (there is no `--strict-mcp-config`); keep that directory to Agora's use.
Live approval mid-turn (holding the turn until the owner taps) is implemented for
Codex app-server only (above); an ACP call is denied at once and retried on the next
run after approval.

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

No shell, OS variables plus `CI=1` only, bare executables resolved from absolute `PATH` entries outside the worktree, process tree killed on timeout (on Windows, contained in a Job Object for its whole life). The command runs code the agent just edited, as your account and outside the CLI's sandbox, so list only commands you would let that agent run itself. See [project-context.md](../docs/project-context.md).
### Task cards and subtasks

A task card's or subtask's session works in one thread (`session.threadId`), and
`session.scope` says which (`task` or `subtask`, with a title). The wake prompt
tells the agent to post only in that thread. For a subtask, it adds that the
brief is all the agent has (a clean context, no native session or summary) and
that only its JSON summary is posted back to the parent. Inbox reason `delegate`
marks a subtask's brief or its summary. Every non-lurk prompt mentions
`subtask_start`. Add `subtask_start` (and the `task_*` tools, for orchestrators)
to a profile's `approvedTools` to let it delegate. The workspace command
`pr_status` runs `gh pr view <session branch> --json url,state,isDraft` in the
session worktree and returns only the state and an https URL. See
[task-board.md](../docs/task-board.md).

### Browser preview

With a `preview` block in the config, agents can screenshot pages their session
serves on localhost (`browser_preview` in agora-mcp):

```json
"preview": {
  "browser": "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "stateDir": "C:/private/agora/preview",
  "portBase": 42000,
  "portsPerSession": 10,
  "slots": 100
}
```

`browser` is any Chromium-based browser, driven headless over
`--remote-debugging-pipe` (no extra dependency). Each session gets its own
`portsPerSession` ports from `portBase`, kept in `stateDir/preview-ports.json`;
the run receives them in `AGORA_PREVIEW_PORTS` and its wake prompt, and only
loopback URLs on those ports load. The page's own requests are held to the same
ports, and everything else meets a dead proxy. Previews poll on their own loop,
so an agent can ask for one mid-run. Add `canvas_publish`, `canvas_read` and
`browser_preview` to `approvedTools` for the agents that should use them. See
[canvas-and-preview.md](../docs/canvas-and-preview.md).

### Passive turns and referenced images (#83, #86)

Lurk deliveries carry `session.lurkMode` and inbox reason `lurk`. A purely passive batch uses the dial's interjection rules and permits exact `[pass]` without forcing a JSON schema. `[pass]` completes successfully, preserves token usage and leaves the prior session summary intact. Normal addressed work still requires its usual response.

After the CLI exits and before reporting completion/failure, the host discovers this run bot's posted image references through the host API. It reads only real paths under the actual run cwd/worktree or `os.tmpdir()`, using the server's size limit, then uploads bytes with the host token. The lease watchdog and heartbeat remain active during uploads. The API attaches images to their original message through `storeFile()` and deduplicates by content per run. Invalid, missing, outside-root or rejected images are skipped; auth/fencing errors stop reporting through the existing host rules. See [agent-sessions.md](../docs/agent-sessions.md#referenced-images) for the endpoint contract.

## Start automatically

By default the host runs only while its terminal is open. To bring hosted agents back after a reboot, opt in once per machine:

```bash
agora-host autostart enable --config /absolute/path/to/host.json
agora-host autostart status --config /absolute/path/to/host.json
agora-host autostart disable
```

(From a source checkout, use `node dist/index.js autostart ...`.) The config path must be absolute and readable. The command runs `node <this install>/dist/index.js --config <file>` with the Node binary you ran it with, from the `agora-host` folder, and writes `host.log` and `host.err.log` next to the config. It is always per-user: it refuses to run as root or from an elevated Windows shell, and `enable` is safe to repeat. Stop a host you started by hand first, or two hosts will compete for leases. `enable` also starts it now; `disable` removes the startup entry (a running host keeps running until you stop it).

| OS | What it installs | Restarts after a crash |
| --- | --- | --- |
| Windows | Task Scheduler task `AgoraHost` at logon (no admin), run hidden through `wscript.exe` and `agora-host-autostart.vbs` next to the config | yes, every minute |
| Linux | systemd user unit `~/.config/systemd/user/agora-host.service` | `Restart=on-failure` |
| macOS | LaunchAgent `~/Library/LaunchAgents/com.agora.host.plist`, loaded with `launchctl bootstrap gui/$UID` | `KeepAlive` |

Notes:

- It starts when you **log in**, not at boot. On a headless Linux box, run `sudo loginctl enable-linger $USER` once so your user units start at boot without a login.
- Paths containing quotes or newlines (and, on Windows, `% ^ & | < > !`) are rejected rather than escaped.
- The unit and LaunchAgent capture your current `PATH`, so the agent CLIs the host launches stay findable. Run `enable` again after moving Node or installing a CLI somewhere new.
- Changing the config path or moving the install means running `enable` again.
