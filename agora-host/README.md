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
  server owner and the owner's own bots can wake the agent: the owner's messages, `/start`,
  `/resume`, and, in sessions the owner started, the owner's own bots' messages and hand-offs
  (the server marks those claim items `ownerBot`; with **Only you** set in Settings → Agents,
  only hand-offs between sessions the owner started or from the owner's own agents in terminal
  sessions they run). Never put a personal bot token in `botTokens`: every hosted run,
  including one a director started, gets it as `AGORA_BOT_TOKEN`, and while a terminal on that
  token is connected its posts would count as the owner's. Use the token Agora made with the
  agent. Everyone else, other people's bots included, is refused with a channel notice.
- `"auth": "api_key"` with `"apiKeyEnv"`: the host passes that one variable from its own
  environment to the child. Allowed names: `ANTHROPIC_API_KEY` (claude), `CODEX_API_KEY` or
  `OPENAI_API_KEY` (codex), `GEMINI_API_KEY` or `GOOGLE_API_KEY` (gemini), `OPENROUTER_API_KEY`
  or `OPENROUTER_API_KEY_<NAME>` (opencode). The codex CLI
  reads only `CODEX_API_KEY`, so a codex profile (protocol `cli`) gets the key as
  `CODEX_API_KEY` whichever of the two names holds it on the host; codex-acp gets it under the
  configured name. The host refuses to start if the variable is unset, and never prints its
  value. Ordinary authority rules apply.
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
- `adapter: "omp"` (oh-my-pi) runs only over ACP with `api_key` on an OpenRouter key; see
  [oh-my-pi](#oh-my-pi).
- `adapter: "opencode"` runs only over ACP with `api_key` (`OPENROUTER_API_KEY` or
  `OPENROUTER_API_KEY_<NAME>`); see
  [opencode and OpenRouter](#opencode-and-openrouter).

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
`npm install -g https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-mcp-latest/agora-mcp.tgz`
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
PID and a random nonce are written atomically beside the session record before Git
can start. Only recovery queries the OS command line for that nonce, so a reused PID
cannot be mistaken for the owner. A recorded dead process lets the host clear its
regular, unchanged locks and log `workspace_git_lock_cleared`. If Git is still running,
the process identity cannot be checked, or a lock has no host ownership record, the
host keeps it and reports `stale_git_lock` with the path for the owner to inspect.
Symlink and hard-linked locks are refused; shared repository refs are never cleared.
Identity probes, diff previews and private temporary-index commands cannot replace a
writer's record. Overlapping host Git commands queue per worktree within their timeout.

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
| [opencode](https://opencode.ai) | `opencode` | the native `opencode.exe` from `opencode-ai/node_modules/opencode-windows-x64/bin` / `["acp"]` (the default) | **`api_key` only** (`OPENROUTER_API_KEY`, the default); see [opencode and OpenRouter](#opencode-and-openrouter) |
| [oh-my-pi](https://github.com/can1357/oh-my-pi) | `omp` | the release binary (`omp-windows-x64.exe`) / `["acp"]` (the default, and the only value) | **`api_key` only** (`OPENROUTER_API_KEY`, the default); see [oh-my-pi](#oh-my-pi) |

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
`env`) → `session/set_config_option` for the profile's model and effort (or
`session/set_model` when the agent advertises `models` without a model config option) → one
`session/prompt` with the wake prompt → stdin closed, then the process tree stopped.
The session ID is stored like a CLI's native ID; the next wake uses `session/resume`,
else `session/load`, and fails with `native_resume_unsupported` rather than start a
new conversation. A model the agent doesn't list fails with `acp_model_unavailable`;
the run's error message lists the available model IDs (up to eight, with a count of any others).
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
cap, so `caps.maxBudgetUsd` is refused on ACP profiles. For opencode the cap is the
OpenRouter key's own credit limit ([below](#opencode-and-openrouter)).

**Not covered.** ACP agents may load MCP servers and settings from their own config
in `stateDir` (there is no `--strict-mcp-config`); keep that directory to Agora's use.
Live approval mid-turn (holding the turn until the owner taps) is implemented for
Codex app-server only (above); an ACP call is denied at once and retried on the next
run after approval.

### opencode and OpenRouter

An `opencode` profile runs `opencode acp` (opencode 1.18) on an OpenRouter key, so any
OpenRouter model can be a dedicated Agora agent: one profile, one bot, one model. Only
`adapter`, `executable`, `workdir`, `workdirAlias` and `stateDir` are needed; `protocol`
defaults to `"acp"`, `acpArgs` to `["acp"]`, `auth` to `"api_key"` and `apiKeyEnv` to
`OPENROUTER_API_KEY`. Anything else (`protocol: "cli"`, `auth: "subscription"`, another key
variable) is refused.

```json
"qwen": { "adapter": "opencode",
  "executable": "C:/Users/USER/AppData/Roaming/npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe",
  "workdir": "C:/projects/agora", "workdirAlias": "agora", "stateDir": "C:/private/agora/opencode-qwen-state",
  "approvedTools": ["chat_history", "chat_send", "thread_start"] }
```

Use the native `opencode.exe` (`npm install -g opencode-ai` puts it under
`opencode-ai/node_modules/opencode-windows-x64/bin/`; on an older CPU the `-baseline`
build), not the `opencode.cmd` shim. Set `OPENROUTER_API_KEY` in the host's environment, or
give each agent its own variable with `"apiKeyEnv": "OPENROUTER_API_KEY_QWEN"` (any
`OPENROUTER_API_KEY_<NAME>`). opencode reads only `OPENROUTER_API_KEY`, so the host passes
the profile's key to it under that name; no other key reaches it.

**The model.** Set it on the agent in Settings → Agents; an opencode profile needs one.
Write the OpenRouter model ID as OpenRouter lists it (`qwen/qwen3-coder`) or with
opencode's prefix (`openrouter/qwen/qwen3-coder`); the host adds the prefix. The field holds
up to 64 characters. `opencode models openrouter` (with the key set) lists what opencode
knows. `opencode acp` has no model flag, so the host passes the model twice: in
`OPENCODE_CONFIG_CONTENT` (`model` and `small_model`, so titles are billed to the same
model) and through the session's `model` config option, as for other ACP agents. A model
opencode doesn't list fails the run with `acp_model_unavailable` and the available IDs.

**What the host sets.** `OPENCODE_CONFIG_CONTENT` enables only the `openrouter` provider, so
opencode can't fall back to OpenCode Zen or another provider, and makes every tool ask
(`"permission": { "*": "ask" }`) except its to-do list; the host answers each request from
the claim's rules as above. opencode's MCP calls are titled `agora_<tool>` and map to
`mcp__agora__<tool>`. `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and
`XDG_STATE_HOME` point into the profile's `stateDir`, so your own opencode config and
logins stay out of hosted runs. Project config (`opencode.json` and `.opencode/` in the
worktree, which could add MCP servers, plugins or providers), external plugins, `~/.claude`
skills and prompts, sharing, update checks and LSP downloads are turned off with opencode's
`OPENCODE_*` switches. opencode offers only a terminal login over ACP, so the host never
calls `authenticate`; opencode reads `OPENROUTER_API_KEY` itself. On Windows opencode runs
shell commands through PowerShell.

**Spend cap.** Give each opencode agent its own OpenRouter key with a credit limit
(openrouter.ai → Settings → Keys → limit, optionally resetting daily, weekly or monthly), in
its own `OPENROUTER_API_KEY_<NAME>`. Profiles that share a variable share its limit.
OpenRouter refuses requests once the limit is used up. The host recognises OpenRouter's
out-of-credit and limit messages (HTTP 402, and 403 budget stops) in opencode's error and
fails the run with `credit_exhausted`, which is not retried: Agora shelves the session and
posts "Session for *name* shelved: its OpenRouter key is out of credit or has used up its
credit limit. Raise the key's limit at https://openrouter.ai/settings/keys or wait for it
to reset, then /resume *id*." At start the host reads the key's limit from
`GET https://openrouter.ai/api/v1/key` and logs one line, e.g. `Profile qwen: OpenRouter key
credit limit $10.00, $7.50 left, resets monthly.`, or a warning when the key has no limit.
Agora's own wake and token budgets apply as for any agent.

**Checked against** opencode 1.18.34 driven through this host's ACP runner, with a local
mock of OpenRouter's API: model selection, permission requests for shell, read, write
(inside and outside the worktree) and Agora MCP calls, and a 402 reply. Not yet run against
OpenRouter itself. When the host refuses one of opencode's requests, opencode ends the turn
without a final message, so the run reports the denied tool and fails; approve the card and
wake it again.

### oh-my-pi

An `omp` profile runs [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT; `omp acp`,
tested with 18.17.0) on an OpenRouter key, like opencode: `protocol` defaults to `"acp"`,
`acpArgs` to `["acp"]` (and may be nothing else), `auth` to `"api_key"` and `apiKeyEnv` to
`OPENROUTER_API_KEY` (or `OPENROUTER_API_KEY_<NAME>`, passed to omp as
`OPENROUTER_API_KEY`). The agent needs its OpenRouter model ID in Settings → Agents;
`qwen/qwen3-coder` becomes `openrouter/qwen/qwen3-coder`. omp's subscription logins
(Claude, ChatGPT, Copilot, Cursor, Devin, ...) are never used ([provider-terms.md](../docs/provider-terms.md#oh-my-pi-and-openrouter)).

```json
"pi": { "adapter": "omp", "executable": "C:/Users/USER/.local/bin/omp-windows-x64.exe",
  "workdir": "C:/projects/agora", "workdirAlias": "agora", "stateDir": "C:/private/agora/omp-pi-state",
  "approvedTools": ["chat_history", "chat_send", "thread_start"] }
```

Use the release binary (`omp-windows-x64.exe`, `omp-linux-x64`, ... from
[the release](https://github.com/can1357/oh-my-pi/releases/tag/v18.17.0), checked against its
`SHA256SUMS.txt`). omp releases every few days: the host checks the version omp reports over
ACP at start and refuses anything but 18.17.0 (the provider, discovery-source and tool lists
the host passes are that version's) unless the profile sets `"allowUntestedVersion": true`.

**What the host sets.** omp's default approval mode is yolo and it reads a lot from the
worktree, so every run gets fixed switches and a settings overlay (`--config`, which
outranks the worktree's own `.omp/` settings; `src/acp/omp.ts`):

- `--approval-mode always-ask` on a machine (`--yolo` only in a box), `--no-extensions
  --no-skills --no-rules --no-title`, and the profile's model for every model role
  (`--model`, `--smol`, `--slow`, `--plan`), so nothing falls back to another model.
- On a machine only the tools the host can judge: `--tools read,bash,edit,write,grep,glob,find,todo`
  (Agora's MCP tools come on top), and `--no-lsp` with LSP off in the settings: omp would
  otherwise start language servers from the worktree's own `lsp.json` and `node_modules/.bin`
  after a write. `task`, `lsp`, `github` (your gh login), `eval`, `debug`, checkpoints and the
  rest are also denied by name.
- Every model provider but OpenRouter disabled, and every config discovery source (the
  worktree's `.omp/`, `.claude/`, `.codex/`, `.cursor/`, ... settings, hooks, custom tools,
  extensions, plugins, rules and MCP servers) disabled; only the worktree's `AGENTS.md` is
  read. omp starts in its own home folder in the state directory, so the worktree's `.env` is never loaded.
- No update check or install, OTLP export, auto-QA reports, Spotlight or Exa search;
  `bash.direnv: off`; Agora's tools as ordinary tools (`tools.xdev: false`).
- `web_search`, `browser` and `computer` denied in every mode.
- `PI_CODING_AGENT_DIR` (settings, sessions, `agent.db`) and, on a machine, `HOME` /
  `USERPROFILE` in the profile's `stateDir`, so your own `~/.omp`, `~/.env` and any login
  saved there stay out. Git still finds your identity through `GIT_CONFIG_GLOBAL`
  (`~/.gitconfig`); other dotfiles under your home (SSH keys for a push) are not visible to
  the agent's commands.

**Approvals on a machine.** omp asks for shell commands, deletes and moves with
`session/request_permission`, and for writes, edits, reads, searches and Agora's tools with
an ACP form elicitation ("Allow tool: write" with Approve / Deny); the host advertises form
elicitation for omp only and answers both from the claim's rules, as for other ACP agents:
file tools only inside the worktree, URL reads never, `mcp__agora_<tool>` as
`mcp__agora__<tool>`, a denied rule as an approval card. An elicitation doesn't say which
tool call it is for, so the host answers it only when exactly one call of that tool is
waiting (and answers each call once), and reads the paths from that call (an edit's from
omp's own `File:` lines), together with the absolute locations omp resolved itself. A path
omp would rewrite or split before resolving it (a leading `@`, `:`, `~` or `!`, quotes, `;`,
`,` or whitespace, a `..` segment, `file:` or another scheme, a drive path (`C:...`) or any
backslash on every platform, `{` or `}` in a search root or glob, and on Windows `/c/...` and
`/mnt/c/...`) is refused rather than followed. So is a prompt with a reason line (omp's
restricted folders: its own settings, home and the run's overlay), parallel calls, or
anything else it can't check. A refusal only costs the agent a retry. It never picks "for
this session" or "always" choices.

**Checked against** the real omp 18.17.0 Linux binary driven by this host's `prepare()` and
ACP runner, with a loopback mock of OpenRouter's Responses API and a hostile worktree
(`.env`, `.omp/config.yml` allowing every tool, extensions, custom tools, hooks, Claude
hooks, `.mcp.json`, `lsp.json`, `.omp/lsp.json`, a `node_modules/.bin` language server):
writes inside the worktree and an Agora tool approved; a write outside it, an `@`-prefixed
write, a write to omp's own settings, an unapproved shell command, reads outside the
worktree, a `;` path list and a URL read refused; `task`, `lsp`, `github` and `web_search`
not there; nothing from the worktree run. Without `--no-lsp` the same writes started all
three of the worktree's language servers.

### Devin

A `devin` profile runs Devin's own ACP server (`devin acp`, Devin CLI 3000.11) on your own
Devin login. Only `adapter`, `executable`, `workdir`, `workdirAlias`, `stateDir` and, on a
machine, `allowUnverifiedApprovals` are needed; `protocol` defaults to `"acp"`, `acpArgs` to
`["acp"]` and `auth` stays `"subscription"`. Anything else (`protocol: "cli"`,
`auth: "api_key"`, `auth: "siwc"`) is refused: a Devin account is its holder's own
(docs/provider-terms.md, "Devin"), so only the server owner can wake a Devin agent.

**On a machine it is opt-in.** Devin's Code mode runs file edits in the workspace without
asking; the host's config adds `ask` rules so they come to the host like every other call,
but that has not been seen with a logged-in Devin yet. So a devin profile on a machine is
refused at start unless it has `"allowUnverifiedApprovals": true`. A Devin agent in a box
needs no opt-in. **The live check that lifts this:** with a logged-in Devin on a scratch repo,
run one turn that asks Devin to edit a file in the worktree, with no `Edit` rule: the host must
log a denied `Edit` and the file must be unchanged; then approve the card and wake it again:
the edit must go through. Record Devin's MCP call names from the same run.

```json
"devin": { "adapter": "devin",
  "executable": "C:/Users/USER/AppData/Local/devin/cli/bin/devin.exe",
  "workdir": "C:/projects/agora", "workdirAlias": "agora", "stateDir": "C:/private/agora/devin-state",
  "allowUnverifiedApprovals": true, "approvedTools": ["chat_history", "chat_send", "thread_start"] }
```

Use the binary itself (`~/.local/bin/devin` links to it on Linux and macOS). **Log the profile
in once** with `agora-host devin login --profile devin --config <file>`: it runs
`devin auth login` (your browser) with the profile's own Devin folders and a config with
nothing imported and no auto-update; `--paste` uses Devin's paste-the-code flow instead. The login stays in the `stateDir`; the host never reads
it. A profile that isn't logged in fails its run with `acp_auth_required`, which is not
retried.

**Its own folders.** Devin keeps its config, MCP servers, login, sessions and logs in the XDG
directories on Linux and macOS, so `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and
`XDG_STATE_HOME` point into the `stateDir`. On Windows Devin ignores those and `APPDATA`
alone, so its child gets `USERPROFILE`, `HOME`, `APPDATA` and `LOCALAPPDATA` in a `home`
folder in the `stateDir`, and `GIT_CONFIG_GLOBAL` pointing at your own `.gitconfig`, so git
keeps your identity. With you logged in to Devin, `devin auth status` in that environment
says "Not logged in" (checked on 3000.11.234). Your own Devin login, config, MCP servers and
sessions never reach a hosted run, and Devin's account token (`WINDSURF_API_KEY`) is never
passed. The start-up check runs in the `stateDir`, not your workdir.

**What the host sets.** Each run gets its own config file (`devin --config <file> acp`; it
replaces your own `config.json`, with its permission rules and hooks): no auto-update, no
OpenTelemetry export, and every `read_config_from` source off. By default Devin imports MCP
servers, rules, skills and hooks from Claude Code (`~/.claude.json`, `.mcp.json`,
`CLAUDE.md`), Cursor, Windsurf, opencode, Zed, Copilot and Devin Cloud; tried with them on,
it started the Claude Code MCP servers of the user it ran as. With them off, a project's
`.claude/settings.json` hooks, `.mcp.json`, `.cursor/mcp.json`, `.windsurf/`, `opencode.json`
and `.zed/` did not load; `.agents/skills/` still loads as Devin's own skills. Every tool
asks: `ask` rules for the tools Devin's reference names (`read`, `edit`, `grep`, `glob`,
`exec`) and for `Write(**)` and `Write(/**)`, which cover its `write` tool and paths outside
the workdir. Devin's loader accepts any rule text without a word (a typo is silently no
rule), so these follow its reference (docs/reference/permissions.mdx in the 3000.11.234
tarball), which mixes the two forms in one list; it has no catch-all rule. The host answers
each request from the claim's rules as above; the Agora tools in `approvedTools` are allowed
in the config, and writing to `.devin/` is denied. A session starts in Devin's "Code" mode (`accept-edits`),
which the host sets again on a resumed session. The Agora MCP server comes from
`session/new`, as for other ACP agents.

**A `.devin` folder refuses the run.** Devin runs the hooks in `.devin/hooks.v1.json` (and
in `.devin/config.json`) at session start without a permission request, whatever the user
config says, and loads `.devin/` MCP servers. So on a machine the host refuses to start
Devin when there is a `.devin` folder in the worktree, in any folder above it up to the
filesystem root (your home included), or anywhere in the worktree's tracked or untracked
files, with a fixed message in the channel. (Devin itself ran a hooks file only from the
worktree when tried, not from above the repository or from `$HOME`, but that is its discovery
rule today.) A `.devin/config.local.json` left by your own Devin use in a parent folder counts
too: move it, or run the agent in a box.

**Version.** The host checks `devin --version` (Devin's ACP server calls itself `0.0.0-dev`):
3000.11.x passes; anything else needs `"allowUntestedVersion": true`. Turn Devin's own
auto-update off (`"auto_update": false` in your Devin config) if you don't want a new
version to stop the agent at its next start.

**Checked against** Devin 3000.11.234 with no login: the version check, `initialize` (ACP
v1), `session/new`, the session's mode and model config options, the imports with
`read_config_from` on and off, a project hook running unasked, and the folders it writes on
Linux and Windows. A turn with a real login is *verify live* (the check above).

## NemoClaw

A `nemoclaw` profile runs [NVIDIA NemoClaw](https://docs.nvidia.com/nemoclaw/latest/) (Apache-2.0,
alpha): OpenClaw in an OpenShell sandbox on this machine. Every wake is one headless OpenClaw turn:

```
nemoclaw <sandbox> agent --session-id agora-<agora session id> --json [--model <id>] --timeout <run timeout>
```

with the prompt on stdin. The Agora session's OpenClaw session continues from wake to wake. The
reply's visible text is the run's summary (its `{"summary": …}` JSON when it gives one); usage
is `input + output + cacheRead + cacheWrite`. Not a CLI protocol of its own: NemoClaw passes the
arguments to `openclaw agent` inside the sandbox.

**What the agent can and can't reach.** It reaches Agora only through NemoClaw's managed MCP,
which takes only an HTTPS Streamable HTTP server: Agora's `/mcp` endpoint ([docs/mcp-http.md](../docs/mcp-http.md)).
It works in its own sandbox: the worktree agora-host keeps for the session is on this machine,
and the agent can't see or change it. Its wake prompt says so. Use a NemoClaw agent for
discussion, review, planning and anything it can do with Agora's tools; give repository work to
an agent that has the worktree.

### Set it up

1. Install NemoClaw and create an OpenClaw sandbox ([quickstart](https://docs.nvidia.com/nemoclaw/latest/get-started/quickstart)).
   Pin the version: `curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_REF= NEMOCLAW_INSTALL_TAG=v0.0.143 bash`.
   Pick the inference provider at `nemoclaw onboard`: NVIDIA Endpoints (`NVIDIA_INFERENCE_API_KEY`,
   the default model `nvidia/nemotron-3.5-super-vl-120b-a12b`), OpenRouter (`OPENROUTER_API_KEY`)
   or Ollama. The key stays with OpenShell; agora-host never sees it. A build.nvidia.com trial key is
   for testing and evaluation only (docs/provider-terms.md, "NVIDIA NemoClaw").
2. Make Agora's `/mcp` endpoint reachable from the sandbox over HTTPS: a domain with a real
   certificate, or Tailscale (`https://<machine>.<tailnet>.ts.net/mcp`, docs/remote-access.md). A
   tailnet name resolves to a private address, which NemoClaw refuses unless it is trusted: set
   `"trustPrivateHost": true`. Not `localhost` or `host.docker.internal`: NemoClaw refuses loopback.
3. Add the profile. On Linux or macOS the executable is `nemoclaw` itself:

   ```json
   "nemo": { "adapter": "nemoclaw", "auth": "api_key",
     "executable": "/home/me/.local/bin/nemoclaw",
     "workdir": "/home/me/projects/agora", "workdirAlias": "agora", "stateDir": "/home/me/.agora-host/nemo-state",
     "nemoclaw": { "sandbox": "agora-nemo", "mcpUrl": "https://agora.tail1234.ts.net/mcp", "trustPrivateHost": true } }
   ```

   On Windows NemoClaw runs in WSL2 ("tested with limitations" by NVIDIA), and agora-host
   (native) starts it through `wsl.exe` with the distro and nemoclaw's path in it:

   ```json
   "nemo": { "adapter": "nemoclaw", "auth": "api_key",
     "executable": "C:/Windows/System32/wsl.exe",
     "workdir": "C:/projects/agora", "workdirAlias": "agora", "stateDir": "C:/private/agora/nemo-state",
     "nemoclaw": { "sandbox": "agora-nemo", "mcpUrl": "https://agora.tail1234.ts.net/mcp", "trustPrivateHost": true,
       "wsl": { "distro": "Ubuntu", "nemoclawPath": "/home/me/.local/bin/nemoclaw" } } }
   ```

   NemoClaw's own sandboxes need Docker in that distro. Don't start a second Docker Engine in a
   WSL distro that already runs one (Agora's stack, for example): put NemoClaw in the same
   distro, or on another machine.
4. Attach Agora's MCP endpoint to the sandbox, once:

   ```powershell
   agora-host nemoclaw setup --profile nemo --config C:\private\agora\host.local.json --bot <botId>
   ```

   It runs `nemoclaw <sandbox> mcp add agora --url <mcpUrl> --env AGORA_MCP_TOKEN
   [--trusted-private-host <host>]` with the bot's token from `botTokens` in that command's
   environment only, then `mcp status agora --probe --tools`. OpenShell stores the token and adds
   the network policy for the endpoint (the sandbox reaches that host, path and MCP methods only);
   no `openshell policy` step is needed. OpenClaw's MCP client names itself `openclaw-bundle-mcp`,
   so the token binds to that name on first use (docs/bot-token-binding.md). After the bot gets a
   new token, run it again with `--replace`.

Only `auth: "api_key"` (with no `apiKeyEnv`: the key is the sandbox's) and `protocol: "cli"` are
accepted. Efforts are refused (OpenClaw has thinking levels of its own); a model is optional and
goes to `--model`. Every command gets `NEMOCLAW_DISABLE_TELEMETRY=1` and
`NEMOCLAW_NON_INTERACTIVE=1` (through `WSLENV` on Windows).

**Version.** NemoClaw releases several times a week. v0.0.142 (the installer's default `lkg`) and
v0.0.143 pass the start-up check; anything else needs `"allowUntestedVersion": true`. NemoClaw
doesn't update itself; `nemoclaw update` follows `lkg`, so run it on purpose. The check also
needs the sandbox to exist and run OpenClaw (`nemoclaw <sandbox> status --json`): NemoClaw
refuses `agent` for Hermes and Deep Agents sandboxes.

**In an agent box** NemoClaw itself can't run (its OpenShell sandboxes need Docker, which a gVisor box doesn't have), so the box's `nemoclaw` adapter runs OpenClaw, NemoClaw's agent, directly: `openclaw agent exec --json --config <run config> --cwd <worktree> --model nvidia/<model> --message-file -` (OpenClaw 2026.11.3 under its own Node 24, `/opt/agora/bin/nemoclaw` in the image). Inference is NVIDIA Endpoints on the box's `NVIDIA_API_KEY` (model `nvidia/nemotron-3.5-super-vl-120b-a12b` unless the profile names another catalog model); Agora's tools come from the stdio agora-mcp through the box's edge, shown to the model directly (`tools.toolSearch: false`). The agent works in the worktree, as every box agent does. `agent exec` can't continue a session, so each wake starts a fresh conversation with the session's summary; the box rules lead the prompt. Checked against OpenClaw 2026.11.3 in Docker with a stub model and MCP servers: the JSON envelope, stdio and Streamable HTTP MCP, the nvidia provider's key, and the hosts it contacts. A real NVIDIA turn is *verify live*.

**Checked against** NemoClaw v0.0.143's documentation (commands, managed MCP, network policy,
the `--json` envelopes) and a fake CLI (`box/fake/fake-nemoclaw.mjs`) in the tests. A real
sandbox turn is *verify live*: run `nemoclaw <sandbox> agent --session-id test --json -m hi`
yourself first, then one wake that posts in a channel.

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

### GitHub issues

A channel linked to a GitHub repository (owner only) uses the host picked for it to
list its open issues and to comment on a card's issue
when its pull request opens, merges or closes. The host polls
`/agent-hosts/@me/github-commands/next` on its own loop and runs
`gh issue list --repo=owner/name --state=open` or
`gh issue comment <n> --repo=owner/name --body=<fixed text>` with your own `gh`
login, so `gh` must be installed and signed in. It reports issue fields (body cut to
2,000 characters) or a short error code, never `gh`'s output. See
[github-issues.md](../docs/github-issues.md).

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
- With Homebrew's Node (macOS, or Linuxbrew), the startup entry runs Homebrew's `opt/node/bin/node` link rather than the versioned `Cellar/node/<version>` folder, which `brew upgrade node` deletes.
- On a Mac, a LaunchAgent starts at login. On a Mac mini nobody logs in to, turn on automatic login (System Settings → Users & Groups; not available with FileVault on), or hosted agents start only when someone logs in. Agora itself runs in a VM that the macOS installer can start from boot ([docs/macos.md](../docs/macos.md)).
- Changing the config path or moving the install means running `enable` again.

## Running in a box

In an agent box (`docs/agent-boxes.md`) agora-host runs inside the box's container, one host per box with one profile. You don't configure it: the box image (`box/Dockerfile`) starts it.

- **Start.** tini runs `/opt/agora/agora-box-start`, which checks the environment boxd set (`AGORA_INSTANCE_URL`, `AGORA_HOST_TOKEN`, `AGORA_BOT_ID`, `AGORA_BOT_TOKEN`, `AGORA_BOX_PROFILE`), clones the attached repos into `~/work/<owner>/<repo>` through the edge (`http://edge:8080/git/github.com/<owner>/<repo>.git`, retried at the next start if it fails), makes `~/scratch` when there is no cloned repo (or the first one's origin is not that repo through the edge), sets the git identity to the box's name and bot, links the box rules (`/opt/agora/AGENTS.md`) as `~/AGENTS.md`, `~/CLAUDE.md` and the CLI's global instructions, then runs `agora-host box-config --out /run/agora/host.json` and `agora-host --config /run/agora/host.json` with `AGORA_HOST_IN_BOX=1`. The host and bot tokens are removed from agora-host's own environment; it reads them from the config file (mode 0600, on a tmpfs).
- **`agora-host box-config`** writes the config from the environment: one profile named after the box, `executable` the pinned CLI in `/opt/agora/bin`, `workdir` the first attached repo when its clone's origin is that repo (else `~/scratch`), `workdirAlias` `work`, `stateDir` `~/.agora/state/<name>`, `proxyEnv: true`. `box-config --repos` checks the environment and prints the attached repos. Errors name the variable or field, never a value.
- **Box mode** is on only when `AGORA_HOST_IN_BOX=1` **and** the image's marker file `/etc/agora-box` exists. Then:
  - Codex runs `exec --dangerously-bypass-approvals-and-sandbox` (no `-s`, no approval policy, `web_search="disabled"`) and Claude runs with `--dangerously-skip-permissions --disallowedTools WebSearch` (no `--permission-mode`, no `--allowedTools`). The ACP agents run with every permission request allowed: opencode with a permission config that allows every tool but web and code search; Devin with every tool allowed in its own config but its web tools (`web_search`, `webfetch`), its session kept in Code mode rather than bypass, so what it still asks reaches the host, which allows it unless it is a web tool or a fetch (`allowAllExcept`; a box fetches through the edge, with `curl`). A `.devin` folder doesn't refuse the run in a box. Tool presets, allowed tools and one-time grants don't apply: inside the box everything is allowed, and the edge's approvals are the boundary. Web search stays off because a box has no open web; agents search through Agora.
  - `proxyEnv` passes `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (and their lowercase copies) to the CLI, on top of the usual OS allowlist. Nothing else is added: the CLI never sees the host token, and gets the bot token only as `AGORA_BOT_TOKEN` for the agora-mcp server it starts, as on a machine.
  - On a machine, none of this happens: the bypass flags are never passed, and `proxyEnv` is ignored.
- **Log in** (`src/box-login.ts`). The host polls `GET /agent-hosts/@me/box-login` every 3 seconds. For a claimed request it runs, without a shell, `codex login --device-auth` (`CODEX_HOME` = the state dir), `claude auth login --claudeai` (`CLAUDE_CONFIG_DIR` = the state dir) or `devin auth login --force-manual-token-flow` (Devin's XDG directories in the state dir; a URL only on `devin.ai` or `windsurf.com`, then the pasted code, as for Claude; a pasted code may be up to 4096 characters, since Devin's can be a whole token). It reads the CLI's output (terminal escapes removed, a URL only on `openai.com`/`chatgpt.com` or `claude.ai`/`claude.com`/`anthropic.com`), reports `awaiting_user` with Codex's URL and code or `awaiting_code` with Claude's URL, and for Claude polls `GET .../box-login/<id>/code` every 2 seconds and writes the owner's pasted code to the CLI's input. The CLI's exit is reported as `succeeded` or `failed`; after 10 minutes (or 60 seconds without a prompt) the CLI is stopped and the login fails. A `404`/`409` from Agora (the owner cancelled, or the login expired) stops the CLI with no further report. The URL, the codes and the CLI's output are never logged. *Verify live:* both logins with real accounts.
- **Image.** `box/Dockerfile` builds agora-host and agora-mcp from the checkout and installs Claude Code 2.1.311, Codex 0.163.0, opencode 1.18.34 and Devin 3000.11.234 (the families the host verifies, so no `allowUntestedVersion`; Devin from its sha256-checked release tarball). The fake ACP CLI (`box/fake/fake-acp.mjs`) plays opencode or Devin by its file name, with Devin's paste login. The `test` target swaps them for fake CLIs (`box/fake/fake-cli.mjs`) that answer `--version`, one headless turn (and post `fake-<cli> reply` to the wake's channel), and both logins; they need a fake login (`.fake-login` in the state dir) or an API key to answer a turn.
- **Pull requests.** `agora-pr create --title T (--body B | --body-file F) [--base B] [--head H] [--draft]` and `agora-pr status <n>` talk to the edge's PR broker. Exit codes: 0 done, 1 refused or failed, 2 usage, 3 needs the owner's approval (run it again after approval), 4 not in a box repo, 5 the edge didn't answer.
