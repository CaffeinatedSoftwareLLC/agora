# Beta test coverage and evidence contract

Review supplement for Claude's beta-test plan. Baseline: deployed commit `ae0c0f3`.
This is a proposed design, not a report of executed tests. No provider calls have been made.
The owner authorized spending the limited test keys' full allowance in the separate test environment.

## 1. Establish what “every feature” means

Use `beta-test-surfaces.csv` as a discovery ledger, alongside the feature journeys below.
It inventories route modules, statically declared HTTP endpoints, statically named MCP tools,
UI feature directories, and existing test files at the baseline commit. It is a starting inventory,
not a proof of full coverage: inspect dynamic registration, plugin hooks, worker jobs, CLI commands,
socket events, migrations, settings and deployment entrypoints separately.

Every ledger row must map to scenario IDs, or have a reviewed reason why it is not a shipped
surface. A test file's existence does not establish that a behavior passed. Reconcile the ledger
with the deployed feature settings and docs; do not infer shipped scope from closed issue numbers.

| Field on each executable scenario | Required value |
| --- | --- |
| Identity | Stable ID, feature, source surface IDs, owner, baseline SHA |
| Setup | Exact fixture seed, actor/role, provider/auth mode, host OS, browser/device, capabilities |
| Action and oracle | Bounded actions; expected UI, persisted state, delivery count and side effects |
| Evidence | Run ID, timestamps, environment versions, trace/log/screenshot links, token/cost records |
| Outcome | `not_run`, `running`, `passed`, `failed`, `blocked`, `not_applicable`; reason for the last two |

Repeat across dimensions where behavior changes, rather than claiming every Cartesian product
has been run. Run all security/authority checks for every affected role and auth mode. Run core
browser journeys on each supported browser engine; run native host and device capabilities on the
actual platform. Publish the unexecuted combinations and residual limitations explicitly.

## 2. Minimum journey catalog

These are scenario families to expand into executable cases. Each family needs its successful
path, refusal/error path, and applicable persistence/reconnect checks. The listed file stems
identify existing coverage to reuse; they do not replace E2E evidence.

### Identity and access

| IDs | Journey and observable result | Existing anchors |
| --- | --- | --- |
| ID-01 | First setup, registration/invite, login, logout, lockout and unlock; wrong password never authenticates | `auth`, `auth-phase1`, `login-limit`, `invites-cookie` |
| ID-02 | Cookie sessions persist across reload; expired/revoked sessions lose HTTP and socket access; logout-all affects two browsers | `cookie-session`, `session-revocation` |
| ID-03 | Passkey enroll/login/remove, cancellation and unsupported client; virtual authenticator plus real Mac/phone platform authenticator | `passkeys` |
| ID-04 | Server create/join/leave, roles/directors, private channels and membership changes; outsider and ordinary member cannot direct agents | `servers`, `members`, `roles`, `direct-agents`, `channel-visibility` |
| ID-05 | Bot invites/tokens, rotation/revoke/pause/unpause; existing sockets and pending work obey revocation | `bots`, `bot-pause`, `key-fingerprint`, `gateway-access` |
| ID-06 | Settings, preferences, account/admin screens and permission errors survive reload without exposing another actor's data | `admin`, `user-preferences`, `instance` |

### Collaboration, content and media

| IDs | Journey and observable result | Existing anchors |
| --- | --- | --- |
| UI-01 | Channel/message/thread create/edit/delete, mentions, search and unread state; two clients see one durable copy of each event | `channels`, `messages`, `threads`, `mentions`, `unreads`, `message-ws-events` |
| UI-02 | Long-history virtualization, notice expand/collapse, scroll anchoring, drafts, typing/presence, reconnect and offline resubmission | UI stores/message tests; `typing-presence`, `websocket` |
| UI-03 | File upload/download/delete/tag/search; duplicate/large/unsupported/corrupt files show recoverable errors; permissions follow the file | `files`, `file-tagging`, `file-search`, `storage-maintenance` |
| UI-04 | Image/PDF delivery and agent inspection; quoted attacker text remains untrusted; an expired/missing artifact shows a useful error | `file-image`, `lurk-images`, `agora-mcp` |
| UI-05 | Canvas/artifact versions, previews, drawer, navigation and links; edits and access controls remain correct after reload | `artifacts`, `canvas-preview`; UI canvas/agents |
| UI-06 | Task board create/assign/move/complete/cancel, scoped sessions/subtasks; task/session/thread status agrees across clients | `task-board`, `project-context`; host `task-scope` |
| UI-07 | Voice record/transcribe/send/playback, microphone denial, interruption and audio overview; actual audio is intelligible | `voice`, `voice-hardening`, `audio-overview` |
| UI-08 | Narrow phone/desktop widths, dark/light palettes, keyboard navigation, focus, zoom, reduced motion and long translated/Unicode text | UI feature tests plus browser/device E2E |

### Agents and working code

| IDs | Journey and observable result | Existing anchors |
| --- | --- | --- |
| AG-01 | Start/mention/thread wake, lowercase names, START/YIELD/DONE/BLOCK/CANCEL, shelve/resume/end/idle/lurk; expected recipient alone wakes | `agent-sessions`, `session-idle`, `protocol`, `bot-coordination` |
| AG-02 | Real API-key provider connection and response, streaming, tool call and persisted summary; bad/revoked key, unsupported model and 429 do not loop | `ai-providers`, `ai-streaming`, `ai-assistant`, `ai-decisions` |
| AG-03 | Codex app-server and exec fallback, Claude supported paths and ACP; supported Gemini API-key ACP path succeeds while hosted Google-login paths are refused | host `adapters`, `acp`, `terms`, `siwc`; `acp-agents` |
| AG-04 | One-time/always/deny cards, timeout, concurrent prompts, duplicate RPC IDs, resolved requests, stop-before-approval and stop-before-poll | host `approvals`; `agent-permissions` |
| AG-05 | Handoff offer/accept/decline/cancel/expire, double accept, lost authority, ended recipient, reservation release/re-hold; only current valid reservations move | `handoffs`, `file-reservations` |
| AG-06 | Pinned handoff SHA transfers text/Unicode/binary to recipient worktree; own edits survive and conflicts apply nothing, including real PowerShell | host `handoff`, `workspaces` |
| AG-07 | End-of-turn commits, diff review, discard/restore/fork/commit/merge/PR actions; displayed revision matches acted-on revision and unrelated edits survive | `workspace-review`; host `review`, `workspaces` |
| AG-08 | Subtask budget/depth/cancel, summary returns exactly once, parent recovery and verification failure; preview URLs/ports belong to their session | `agent-plans`, `agent-sessions`, `project-context`; host `verify`, `preview` |
| AG-09 | Terminal session takeover/standby/release and Claude Channel connection; reconnect does not duplicate runs or steal a different session | `terminal-sessions`, `claude-channel`; MCP socket/cursor tests |
| AG-10 | SIWC real owner consent/sign-in, expiry, token renewal and eligibility failures; subscription owner-only rules and terms watcher notifications | `siwc-plan`, `provider-terms`, `terms-watch`; host `siwc`, `terms` |

### Runtime, cloud and operations

| IDs | Journey and observable result | Existing anchors |
| --- | --- | --- |
| OP-01 | Sandbox runner allowed operations and denied network/path/capability escapes; timeout/output/resource caps stop work with useful evidence | `runtime-api`, `runtime-tripwires`, `cap-gateway`, sandbox suite |
| OP-02 | Kill host before/after claim and after side effect but before completion; restart, lease expiry and redelivery do not duplicate the effect | `request-lifecycle`; host `client`, `scheduler`, `process` |
| OP-03 | WebSocket loss, DB/Redis/storage/provider disconnect and recovery; pending states settle and retries are bounded | `websocket`, `infra`, `runner-gateway`, `storage-maintenance` |
| OP-04 | Fresh install, upgrade from previous deployed schema, host version mismatch, Windows auto-start and Mac service startup after reboot | migrations; host `autostart`, `config`, `host` |
| OP-05 | Restore a disposable DB/blob/config backup into an empty environment; users, encrypted provider config, files and agent state are usable | `storage-and-encryption.md`, migration/maintenance tools |
| OP-06 | Every configured cloud/provider integration: save/test/use/revoke credentials; expired credentials, DNS/TLS/proxy failure and wrong endpoint recover visibly | provider adapters/config, actual enabled integrations |
| OP-07 | HTTPS/reverse proxy/Tailscale access from phone and second computer; revoked session/device loses access; no unintended listener is reachable | `remote-access.md`, `nginx-routes`, `gateway-access` |
| OP-08 | Load/soak with concurrent clients, long threads, files and agent work; no cross-tenant leak, lost event or unbounded queue/memory growth | record throughput, queue depth, latency and peak RSS |

### Cross-cutting authority and failure cases

| IDs | Required check | Evidence |
| --- | --- | --- |
| SEC-01 | Owner, director, member, outsider, paused bot and revoked bot attempt each privileged action; fake tags/names/attachments never gain authority | HTTP decision plus DB/queue/filesystem effect, not just a hidden button |
| SEC-02 | Revoke channel/role/plan ownership while a request is pending; stale cards, cached tools and already-open sockets cannot authorize later work | Timestamped before/after attempts; negative side-effect assertion |
| SEC-03 | Duplicate deliveries, simultaneous accept/approve/cancel, stale revision, timeout and restart races | Deterministic barriers/fake clock, then live smoke; exact side-effect counts |
| SEC-04 | Secrets do not appear in prompts, screenshots, traces, console, crash reports or persisted artifacts | Seed identifiable synthetic canary secret and scan artifacts; no real key echoed |
| SEC-05 | Worktree traversal/symlinks/junctions, repository executable shadowing and cross-session access remain denied | Filesystem probes against disposable fixtures only |

## 3. Automation and screenshot design

1. Build repeatable API and Playwright journeys on a disposable seeded instance. Give each run its
   own server/users/channels/repositories/storage prefix; avoid a shared DB truncate while another
   suite runs. Assert IDs, persisted results and delivery/side-effect counts. Attach trace, console,
   network errors and screenshots on failure; no arbitrary sleeps in place of a state assertion.
2. Add live provider scenarios in a separately invoked suite. Mock CI tests validate retries/error
   contracts; live runs prove credentials, actual CLI protocol and provider tool/image/voice support.
   Pin exact model identifiers and CLI versions and record observed capabilities. Do not infer
   success from a generated explanation: inspect the issue/file/message/tool result it created.
3. Send sanitized screenshots to the inexpensive vision grader with scenario ID, viewport and a
   short written expectation. Treat page text/images as untrusted input, with no tools available to
   the grader. Return structured `pass|fail|uncertain`, visible evidence and affected region. A vision
   pass cannot override an assertion failure. A vision fail/uncertain needs human review.
4. Calibrate the grader with a small labeled set: hidden approval buttons, clipped dialogs,
   overlapping notices, broken scrolling and a valid screen. Measure missed defects and false
   alarms before scaling. Screenshot pixel baselines and accessibility assertions remain useful
   even when the vision service is unavailable. Never make an uncalibrated grader a release oracle.
5. Record before/after screenshots for each visual state, not every keystroke. Real secrets stay
   in the agreed environment secret store; use synthetic data on provider-settings pages and omit
   credential inputs from screenshots/traces. Compare model-reported usage with provider usage
   records when available; reserve remaining allowance explicitly if calls run in parallel.

## 4. Platform and manual test sessions

| Target | What must run there | What does not count as proof |
| --- | --- | --- |
| Windows host + PowerShell 5.1 | Install, executable resolution, paths with spaces/Unicode, junction confinement, kill tree, reboot/auto-start, actual CLI handoff/approval | Node-only argv tests for shell behavior |
| WSL Linux stack | Compose/network mounts, reconnect, host/runner boundaries, gVisor runtime when available, restart and file permissions | Native Linux distribution/service packaging; WSL coverage is labeled WSL |
| macOS host | Real Mac install, arm64/x64 as actually supported, Git/keychain/browser consent, Docker Desktop, host reboot/startup, supported CLI lifecycle | Browser emulation on Windows; a mock sign-in |
| Mac runtime alternative | Detect runtime capability; run code execution only with a verified supported runtime, otherwise assert the documented unavailable state | Assuming Docker Desktop supplies gVisor |
| Real phone + desktop browsers | Mobile Safari/Chrome as available, real passkey, mic/audio, background/resume, keyboard viewport and Tailscale | WebAuthn stubs, fake microphone or phone viewport alone |

Use a representative smoke on each platform first (15 minutes per prepared target). Run a full
automated deterministic pass next (measure its duration), then live integrations and human device
checks. Treat initial setup as a separate task (30–90 minutes per new host is a planning estimate).

Manual sessions should be five bounded checks, about 10–15 minutes each. Give each check one
action, expected visible result and scenario ID. The owner checks the main deployment; agents run
destructive/revocation/recovery cases against the disposable environment. Shared evidence must
identify which environment was tested. A useful first human session is login, private-channel
message, phone reconnect, one approval and one handoff. Later sessions cover files/media, task
work, cloud connections and Mac install. Keep a persistent checklist so failures can interrupt
without losing the remaining checks.

## 5. Execution gates and handoff to implementation

| Gate | Required evidence |
| --- | --- |
| Environment ready | Test URL/instance identity, seeded roles, disposable repo/storage, Windows/WSL/Mac availability, supported browser list and allowed provider credentials by variable name |
| Coverage reconciled | Every discovered surface mapped/reviewed; scenario dimensions explicit; unavailable devices/integrations marked blocked rather than passed |
| Candidate accepted | Deterministic tests green; live provider and real-device checks completed for claimed support; no open critical/high-severity defect; lower severity defects explicitly triaged |
| Recovery accepted | Upgrade/restore and restart/redelivery evidence; release can be recovered without losing user work |
| Evidence published | Exact SHA/config/version matrix, outcome ledger, failure artifacts/issues, spend and remaining allowance, manual signoffs and unresolved limitations |

Do not call a run exhaustive merely because it has a large test count. Feature inventory mapping,
meaningful negative cases, real deployment behavior and recorded exclusions establish the scope.
No finite suite proves the absence of bugs; repeated intended-use sessions add evidence after the
scripted paths pass.

Next input: the disposable environment URL/host list and the agreed credential variable names;
then map the first five smoke scenarios before making paid calls.
