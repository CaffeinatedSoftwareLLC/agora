# Competitor research: multi-agent coordination tools

> 2026-10-18. Researched by Gemini (search + page reads) at Eryk's request, starting from
> [r/ClaudeAI: "I run Claude Code and Codex in parallel on two machines"](https://old.reddit.com/r/ClaudeAI/comments/1x92aeq/i_run_claude_code_and_codex_in_parallel_on_two/).
> Claude checked the GitHub repos with `gh api` the same day.
>
> **Verification status**
> - Repos confirmed (stars / last push): happy ★24.2k, mcp_agent_mail ★2.2k, agor ★1.5k, concord-mcp ★542, afk-code ★90, parley ★33, roundtable ★7, tunnel-mcp ★4, duplex-bridge ★3, clicker4ai ★3, codex-delegate-mcp ★2.
> - **Not found:** `Open-ACP/OpenACP`, the URL is wrong.
> - Many Reddit thread URLs below are Gemini's own and several are marked unverified. Treat them as leads, not citations.
> - Feature and limitation claims come from READMEs and posts, not hands-on testing. Next step: the agents browse these together and confirm.

## Summary

| Rank | Borrow this | Who does it | Agora today |
|---|---|---|---|
| 1 | One worktree or file lease per agent | Agor, MCP Agent Mail, Concord | Turn-taking only; agents can still edit the same files |
| 2 | Approve/deny cards on the phone for denied tools | Happy, OpenACP, Clicker4AI | Approval UI exists for code runs only (#73) |
| 3 | Check "done" against git/disk state | the 1x92aeq author, Concord | Trusts the agent's message |
| 4 | Lurk mode: unaddressed agent speaks only on a bug | Parley | — |
| 5 | Per-session token/cost meter | OpenACP, Clicker4AI | `/sessions` shows tokens, no alerting |

Where Agora is ahead: waking idle agents on @mention, one server across machines, the turn-taking protocol with loop guard, phone steering in real channels. Weak spot: setup (Docker + Postgres) versus `npx` + SQLite.

---

## Gemini's full report

---

### 1. Target Thread Breakdown: `https://old.reddit.com/r/ClaudeAI/comments/1x92aeq/i_run_claude_code_and_codex_in_parallel_on_two/`

**Post Title:** *"I run Claude Code and Codex in parallel on two machines. These are the walls I hit and how I got past them"* (r/ClaudeAI, cross-posted to r/ClaudeCode; Windows PC + Mac running Claude Code as primary implementer and Codex as independent reviewer/auditor).

1. **Wall 1 — Claude hooks don't bind Codex child processes:** Running OpenAI's Codex plugin inside Claude Code spawns `codex app-server` as a separate OS process, bypassing Claude's `PreToolUse` hooks (a 0-byte commit guard failed open for ~19 hours). **Fix:** Enforce rules in the native Git `commit-msg` hook and auto-repair missing hooks at session startup.
2. **Wall 2 — "Done" is a self-report, not disk state:** Codex returned a job ID in 36 seconds claiming completion, while nothing changed on disk for 90 minutes. **Fix:** Verify completion against objective artifacts (files on disk, git worktree list, target version) rather than agent chat messages.
3. **Wall 3 — Two writers in one worktree:** A parallel clean command wiped build outputs while another step packaged a JAR, producing 0-byte artifacts. **Fix:** Enforce one writer per Git worktree; allow parallel reads, isolate writes to separate worktrees, and keep the main checkout on the default branch.
4. **Wall 4 — Cross-machine state blindness:** A merge or hook update on the Mac left the Windows session operating on stale state. **Fix:** Built a Cloudflare Worker "intercom" so sessions on both machines pass messages and cross-trigger, governed by one hard rule: *"A peer message informs, it never approves."*
5. **Wall 5 — Stale memory across runtimes:** Agents read stale cache versions or mistook empty search indexes for dead jobs. **Fix:** An observation agent writes verified milestones to a shared Confluence space after substantial turns; sessions query it via Atlassian Rovo semantic search using explicit evidence labels (`confirmed`, `assumed`, `superseded`) and distinct exit codes (`0` vs `UNKNOWN`).

**Comments Note:** *[Unverified direct comment bodies: `read_url_content` wrote the full payload to disk rather than inline, and public search index snapshots of this post captured 0 direct replies on the original submission, though parallel r/ClaudeAI and r/ClaudeCode discussion threads echo the git worktree isolation and markdown/diff handoff patterns.]*

---

### 2 & 3. Competitive Landscape (10 Distinct Projects)

#### 1. Parley (`parley-room`)
* **URL:** `https://github.com/auspex0/parley` (`npx parley-room`)
* **What it is:** A zero-dependency local web chat room where humans, Claude Code, and Codex share a single thread and collaborate on a local repo.
* **Connection:** Spawns official local `claude` and `codex` CLIs under existing user logins; relays verbatim responses between sessions via message bookmarks.
* **Self-hosted:** Yes (local web server on `localhost`, Node 20+).
* **Notable features:** `@claude`, `@codex`, and `@both` addressing; **Lurk Mode** (idle agent listens and only interjects when it spots a bug); **Pair Mode** (one builds, one reviews); **Sleep Mode** (pauses an agent that hits rate limits and queues prompts).
* **Complaints / Limitations:** Both agents share the same working directory without automatic Git worktree isolation; agents only see relayed chat text and disk files (not each other's internal tool logs); battle-tested primarily on Windows; burns rate limits quickly in `@both` loops.
* **Reddit Thread:** `https://www.reddit.com/r/codex/` & `https://www.reddit.com/r/claude/` — *"I put Codex and Claude Code in one chat room. They debate, review each other's work, and the one you're not talking to speaks up when it spots a problem."* *[Exact 7-char Reddit post ID unverified due to search redirect masking.]*

#### 2. Concord MCP (`concord-mcp`)
* **URL:** `https://github.com/Get-Concord-AI/concord-mcp`
* **What it is:** A peer-to-peer MCP coordination server that lets Claude Code, Codex, Cursor, and Gemini CLI message each other and lock files on a shared repository.
* **Connection:** MCP server backed by a local SQLite database at the repository root.
* **Self-hosted:** Yes (local SQLite store, zero external infra).
* **Notable features:** Explicit **file/task claims** before editing to prevent overwrite collisions; direct peer-to-peer agent messaging; persistent decision and handoff log that survives context compaction; PR review packet generation.
* **Complaints / Limitations:** Passive MCP tool model—cannot headlessly wake a sleeping agent unless the agent is actively polling or prompted by a human; file claims are advisory if an agent edits files via bash without calling Concord first; single-machine/repo-root scope.
* **Reddit Thread:** `https://www.reddit.com/r/mcp/comments/1i3x7y3/i_built_an_opensource_mcp_server_that_lets_claude/` — *"I built an open-source MCP server that lets Claude Code, Codex and Cursor talk to each other"* (also discussed in `r/AI_Agents`: *"How I keep agents running for days without them forgetting what they were doing"*).

#### 3. MCP Agent Mail (`mcp_agent_mail`)
* **URL:** `https://github.com/Dicklesworthstone/mcp_agent_mail` (`https://mcpagentmail.com`)
* **What it is:** An asynchronous "Gmail for coding agents" coordination layer providing threaded mail, persistent identities, and file leases across Claude Code, Codex, and Gemini CLI.
* **Connection:** FastMCP server backed by SQLite + Git-committed markdown archives.
* **Self-hosted:** Yes (local SQLite + Git repo + optional local web oversight UI).
* **Notable features:** Memorable agent identities (e.g., *GreenCastle*) with model/task metadata; glob-based **advisory file reservations** (`src/auth/**/*.ts`) with expiring leases; threaded Markdown messages with importance levels and ack tracking stored outside context windows; human web UI.
* **Complaints / Limitations:** Asynchronous inbox model requires agents to poll or check mail between steps unless paired with external wake hooks; advisory leases don't enforce OS-level filesystem locks; risk of prompt injection or context bloat if agents ingest long mail threads.
* **Reddit Thread:** Discussed in `r/LocalLLaMA` and `r/mcp` — *"MCP Agent Mail: Like Gmail for your coding agents"* *[Exact 7-char Reddit post ID unverified due to search redirect masking.]*

#### 4. Tunnel MCP (`tunnel-mcp`)
* **URL:** `https://github.com/zachlikefolio/tunnel-mcp`
* **What it is:** An ephemeral, end-to-end encrypted P2P WebSocket relay allowing two separate Claude Code (or MCP) agents across machines to pair-program without a human clipboard.
* **Connection:** MCP server (`claude mcp add tunnel -- npx -y tunnel-mcp`) + in-process WebSocket relay over `cloudflared` quick-tunnels.
* **Self-hosted:** Hybrid (in-process local WebSocket server exposed via ephemeral Cloudflare Quick Tunnels; no account required).
* **Notable features:** `tunnel_open` generates a join URI for a peer agent; NaCl `secretbox` end-to-end encryption with HMAC join challenge; outbound-only NAT traversal across different machines.
* **Complaints / Limitations:** Strictly 1-to-1 ephemeral point-to-point tunnel (no persistent channels, no multi-agent rooms, no web UI for human mobile steering, no daemon to wake idle agents).
* **Reddit Thread:** `https://www.reddit.com/r/ClaudeAI/comments/1hq4s10/i_built_an_mcp_server_so_two_seperate_claude_code_agents_can_pair_program_without_a_human_relaying_messages/` (also cross-posted to `r/ClaudeCode`).

#### 5. Roundtable (`ashwaryy/roundtable`)
* **URL:** `https://github.com/ashwaryy/roundtable` (see also MCP variant `https://github.com/yylo-dev/roundtable`)
* **What it is:** A local thread-based multi-AI + human discussion app where Claude Code and Codex debate specs, critique code, and collaborate inside workspace snapshots.
* **Connection:** CLI wrapper + `tmux` + local hooks/allowlists invoking authenticated local `claude` and `codex` binaries.
* **Self-hosted:** Yes (local desktop/terminal app).
* **Notable features:** Workspace snapshotting so debates/experiments don't corrupt the active checkout; interactive and autonomous multi-turn agent debate modes; uses existing CLI subscriptions instead of API keys.
* **Complaints / Limitations:** Local-only (no remote/mobile web UI or multi-user server); requires `tmux` and macOS/Linux (Windows requires WSL); lacks cross-machine agent coordination.
* **Reddit Thread:** `https://www.reddit.com/r/ClaudeCode/comments/1k6083l/put_claude_and_codex_in_one_thread_for_fun_it/` — *"Put Claude and Codex in one thread for fun. It became the most useful thing I've built this year. Roundtable: local app for multi-AI + human conversations [open-source]"*.

#### 6. Duplex Bridge (`duplex-bridge`)
* **URL:** `https://github.com/sergioDS-coder/duplex-bridge`
* **What it is:** A bidirectional MCP bridge that lets Claude Code consult or delegate file writes to ChatGPT/Codex CLI using local authenticated CLIs.
* **Connection:** MCP server wrapping local `claude` and `codex` CLIs, persisting multi-turn threads in `~/.duplex-bridge` JSONL ledgers.
* **Self-hosted:** Yes (local stdio MCP process).
* **Notable features:** Exposes `ask_chatgpt` (read-only sandbox for second-opinion reviews) and `ask_chatgpt_write` (workspace-write sandbox); zero API keys needed; persistent thread IDs prevent re-pasting context.
* **Complaints / Limitations:** Master-slave delegation model (one agent calls the other as a synchronous tool) rather than a shared chat room; no human UI or mobile orchestration; synchronous tool calls block the caller while the peer CLI runs.
* **Reddit Thread:** `https://www.reddit.com/r/ChatGPT/comments/1f7o8g7/built_an_mcp_bridge_that_lets_claude_ask/` (also shared in `r/ClaudeAI` and `r/ClaudeCode`) — *"Built an MCP bridge that lets Claude ask ChatGPT/Codex for a second opinion (no API keys, uses your already-authenticated CLIs)"*.

#### 7. Codex Delegate MCP (`codex-delegate-mcp`)
* **URL:** `https://github.com/andreilungeanu/codex-delegate-mcp`
* **What it is:** A lightweight MCP server that lets Claude Code delegate scoped coding tasks and code reviews to the local OpenAI Codex CLI.
* **Connection:** MCP server spawning the local `codex` CLI binary.
* **Self-hosted:** Yes (local process).
* **Notable features:** Structured task brief handoffs; returns structured execution summaries and changed-file lists back to Claude for verification; shifts bulk implementation tokens onto Codex quota.
* **Complaints / Limitations:** One-way hierarchical delegation (Claude $\rightarrow$ Codex); no shared human-visible chat channel; child Codex process bypasses Claude's `PreToolUse` hooks; no remote/phone control.
* **Reddit Thread:** Discussed across `r/ClaudeCode` and `r/ClaudeWorkflows` (e.g., *"Codex is resetting almost daily yet Claude hardly resets ever"* / structured agent handoff threads). *[Exact 7-char Reddit post ID unverified due to search redirect masking.]*

#### 8. Agor (`preset-io/agor`)
* **URL:** `https://github.com/preset-io/agor` (`https://agor.live`)
* **What it is:** A multiplayer 2D spatial canvas ("Figma for AI coding") for orchestrating parallel Claude Code, Codex, and Gemini CLI sessions across isolated Git worktrees.
* **Connection:** Native Agent SDKs + MCP (`agor-mcp`) + local daemon (LibSQL/SQLite + Socket.IO + Linux `bubblewrap` sandboxing).
* **Self-hosted:** Yes (local CLI or Docker Compose).
* **Notable features:** Automatic **Git worktree isolation** (`~/.agor/worktrees/...`) and port allocation per agent; visual 2D board with workflow "zones" that trigger templated prompts; multiplayer cursors and pinned comments; `bubblewrap` filesystem sandboxing.
* **Complaints / Limitations:** Heavy RAM/CPU footprint when spinning up multiple worktrees and dev servers; BSL 1.1 license restricts commercial hosting; 2D spatial canvas is designed for desktop monitors rather than quick phone chat steering.
* **Reddit Thread:** `https://www.reddit.com/r/SideProject/comments/1omej2s/agor_open_source_spatial_workspace_for_ai_agent/` (cross-posted to `r/ClaudeAI` and `r/ClaudeCode`) — *"Agor – Open source spatial workspace for AI agent orchestration (Figma for AI coding)"*.

#### 9. Happy (`slopus/happy` / `happy-cli`)
* **URL:** `https://github.com/slopus/happy` (`https://happy.engineering`)
* **What it is:** An E2E-encrypted CLI wrapper and mobile/web app (`happy claude` / `happy codex`) for monitoring and steering local Claude Code and Codex sessions from a phone.
* **Connection:** CLI wrapper (`happy-cli`) + E2E-encrypted WebSocket relay + iOS/Android/Web companion apps.
* **Self-hosted:** Yes (MIT-licensed client, CLI, and self-hostable relay server, plus hosted `app.happy.engineering`).
* **Notable features:** Push notifications on permission requests or stalls; one-tap mobile permission approval cards; voice-to-code input buffer on mobile; instant device handoff between desktop terminal and phone.
* **Complaints / Limitations:** Wrapper fragility when upstream `claude` or `codex` CLIs update; user anxiety over whether third-party CLI wrappers violate Anthropic/OpenAI subscription ToS; built for human-to-single-agent session mirroring rather than multi-agent group chat rooms.
* **Reddit Thread:** `https://www.reddit.com/r/ClaudeCode/comments/1iw467r/are_tools_like_happy_allowed_to_be_used_with/` — *"Are tools like happy allowed to be used with Claude subscription?"* & `https://www.reddit.com/r/ClaudeAI/comments/1o72498/best_way_to_get_codex_and_claude_code_working/`.

#### 10. OpenACP (`Open-ACP/OpenACP`) & `afk-code` (`clharman/afk-code`) & `Clicker4AI` (`kosio-labs/clicker4ai`)
* **URL:** `https://github.com/Open-ACP/OpenACP` | `https://github.com/clharman/afk-code` | `https://github.com/kosio-labs/clicker4ai`
* **What it is:** Self-hosted mobile bridges that pipe local Claude Code, Codex, and Gemini CLI sessions into Telegram/Discord/Slack threads (`OpenACP`, `afk-code`) or a mobile PWA (`Clicker4AI`).
* **Connection:** Agent Client Protocol (ACP) / PTY wrappers + JSONL session watchers bridged to Telegram/Discord/Slack bots or a local PWA over Tailscale/LAN.
* **Self-hosted:** Yes (runs as background daemon on dev machine).
* **Notable features:** Maps parallel agent sessions to Telegram forum topics or Discord threads; interactive chat buttons/cards for tool permission approvals; per-session cost tracking (`OpenACP`, `Clicker4AI`); image/screenshot forwarding from local sessions (`afk-code`).
* **Complaints / Limitations:** Reviewing code diffs in Telegram/Discord or on a 6-inch screen is painful ("walls of text"); no native multi-agent turn-taking protocol (agents sit in separate threads unless manually bridged); runaway API/token loops when unattended AFK.
* **Reddit Threads:** `https://www.reddit.com/r/ClaudeAI/comments/1j7lw02/i_use_claude_code_from_my-phone-through-telegram-now/` (`OpenACP`); `r/ClaudeCode` *"Interact with local Claude Code sessions from Telegram/Discord/Slack"* (`afk-code`); `r/ClaudeAI` *"I keep seeing 'how do I control Claude Code from my phone'"* (`Clicker4AI`). *[Exact 7-char post IDs for `afk-code` and `Clicker4AI` unverified due to search redirect masking.]*

---

### 4. Honest Synthesis for Agora

#### (a) Features several competitors have that Agora lacks (or may lack)
1. **First-class Git worktree & file-lease isolation:** `Agor`, `Vibe Kanban`, `Concord MCP`, and `MCP Agent Mail` treat workspace collision as the #1 multi-agent failure mode—providing either automatic per-agent Git worktrees (`Agor`) or explicit file/glob reservation leases (`Concord`, `MCP Agent Mail`). Agora coordinates *conversation* turns via `agora-collab`, but does not natively lock files or provision isolated Git worktrees per agent.
2. **Interactive mobile tool-permission approval cards:** `Happy`, `OpenACP`, and `Clicker4AI` intercept interactive CLI permission prompts (e.g., bash execution approval) and render them as Approve/Deny buttons on the phone. Headless wake-on-mention in Agora requires pre-authorized tool permissions or flags rather than mid-turn interactive tool approval over the web UI.
3. **Passive "Lurk / Interject" and "Sleep / Quota-Wait" modes:** `Parley` lets an unaddressed agent silently monitor a thread and speak up *only* if it detects a bug, plus a Sleep mode that queues messages when an agent hits a 5-hour quota wall.
4. **Workspace snapshotting & diff/cost dashboards:** `Roundtable` snapshots the repo before multi-agent experiments, and `OpenACP`/`Clicker4AI` track per-session token/dollar burn to catch runaway AFK loops.
5. **Zero-infra setup (`npx` + SQLite):** `Parley`, `Concord`, and `MCP Agent Mail` launch with a single `npx` command and a local SQLite file, whereas Agora requires running a full server stack (Docker + PostgreSQL + MCP config + host daemon).

#### (b) Pain points users report that Agora already solves
1. **The "Passive MCP" wakeup gap:** Standard MCP servers (`Concord`, `MCP Agent Mail`) cannot wake an idle CLI agent—agents only read messages when already running a tool loop. Agora's host daemon waking agents headlessly on `@mention` directly solves this.
2. **Cross-machine split-brain without custom glue:** The author of `1x92aeq` had to build a custom Cloudflare Worker intercom to coordinate Windows and Mac sessions. Agora's central server + `agora-mcp` gives multi-machine agents a shared, persistent channel out of the box.
3. **Unstructured multi-agent talk loops:** Users of raw CLI bridges and chat rooms complain about agents talking over each other or burning tokens in infinite polite agreement loops. Agora's `agora-collab` turn-taking protocol, loop guards, and rate limiting address this directly.
4. **Human-as-clipboard fatigue:** Eliminates manual copy-pasting of plans, critiques, and diffs between Claude Code, Codex, and Gemini terminals.
5. **Wall-of-text chaos in Telegram/Discord bridges:** Unlike `afk-code` or `OpenACP` stuffing terminal output into external chat apps, Agora provides purpose-built channels, threads, and role bitmasks with full data ownership.

#### (c) Approaches that look strictly better than Agora's
1. **Automatic Git worktree + glob lease management (`Agor` + `MCP Agent Mail`):** Conversational turn-taking (`agora-collab`) is not enough when two agents edit the same repo—as `1x92aeq` proved, even sequential or sub-process steps corrupt builds if they share a working tree or leave uncommitted state. Binding each agent session/thread to an isolated Git worktree or enforcing file-glob leases in the MCP server is strictly safer than chat-only coordination.
2. **Single-binary / SQLite local-first deployment (`Parley`, `Concord`, `Agor`):** Requiring PostgreSQL + Docker for a solo developer who just wants Claude Code and Codex to co-review a repo on `localhost` is high friction compared to `npx parley-room` or a local SQLite store.
3. **Artifact-based "Done" verification (`1x92aeq` + `Concord`):** Rather than trusting an agent's chat completion signal in `agora-collab`, verifying completion via git state, file claims, or commit hooks prevents false-positive "done" handoffs.
4. **Anthropic's native `claude remote-control` + `Happy` for single-agent mobile steering:** If a user only wants to steer a single agent from their phone with interactive permission buttons and voice input, native `claude remote-control` or `Happy` is lower-friction than hosting a chat server.

---


---

## Hands-on review (2026-10-18, all three agents)

Claude, Codex and Gemini each read the READMEs and source of their share (nothing installed or run). Full posts: #general thread `01M57QZT602A4R269DB5ZDJP97`. **Where this section and Gemini's report above disagree, this section wins.**

### Corrections to the report
- **Concord can wake idle agents** through its supported adapters (README L130-136). Waking on @mention is not unique to Agora.
- Concord's "verifies done" uses evidence the caller supplies (`handoff.ts` L52-70), not disk checks. Its claims and Agent Mail's "exclusive" reservations are advisory only: they warn, they don't lock.
- Agor isolates per branch/task, not per agent. Agent Mail's Python repo is superseded by a Rust one, and it's not `npx`.
- Parley has no database. tunnel-mcp seats up to 16, not 2. Roundtable agents can't edit code (it's a forum). duplex-bridge is two-way.
- afk-code and Clicker4AI are Claude Code only, and afk-code has no approval buttons. OpenACP's GitHub repo is gone; `@openacp/cli` is on npm, licensed AGPL-3.0 (not MIT).
- codex-delegate-mcp runs `--dangerously-bypass-approvals-and-sandbox` in every mode.

### Ranked: what Agora should borrow
| # | Idea | From | Where it fits in Agora |
|---|---|---|---|
| 1 | A persistent worktree per task/session: provision it before `prepare()`, keep it across resumes, use it as cwd | Agor | `agora-host/src/adapters.ts:77` (today a fixed `local.workdir`) |
| 2 | Expiring, repo-scoped file reservations (reserve/renew/release), with conflicts shown in handoffs | Agent Mail, Concord | new tools in `agora-mcp/src/tools.ts` + server table |
| 3 | Approval card for a denied tool, with a one-shot escalation instead of a settings edit; passkey step-up before "always allow" | Happy, Clicker4AI | host + UI (#73, #78) |
| 4 | Token/cost budget that pauses a runaway session | OpenACP, Clicker4AI | host + server session budget |
| 5 | List of files changed per run, from Codex `file_change` events | codex-delegate | `parseOutput` in `agora-host/src/adapters.ts` |
| 6 | Lurk mode: an unaddressed agent hears everything, replies `[pass]` unless it spots a problem | Parley | `routeMessage` in `src/lib/agent-sessions.ts` + host |
| 7 | Ownership handoff the recipient must accept, alongside YIELD | Concord | protocol + `agora-mcp` |
| 8 | Single-use invite (~10 min) that bundles the `claude mcp add agora …` line | tunnel-mcp | bot-token flow + `agora-connect` (setup wizard) |

Smaller: auto-attach images an agent references (afk-code); hold messages while an agent is rate-limited and replay them on wake (Parley); strip ANSI escapes and private-key blocks from relayed text (duplex-bridge).

### Things others do that Agora can't (not planned)
End-to-end encryption (tunnel-mcp, Happy); a live view of an agent's terminal (Roundtable, Clicker4AI); the ChatGPT web app as a participant (duplex-bridge); dev-port tunnels (OpenACP).
