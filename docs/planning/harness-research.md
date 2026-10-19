# Harness research: features from desktop apps and open-source wrappers, within provider terms

> 2026-10-19, at Eryk's request: what would make Agora a beta people love, borrowing from official desktop apps and open-source wrappers **without breaking any provider's terms**. Goal: all providers working together, not competing with any one.
> Features: Gemini (web research). Terms + wrapper auth: Claude subagent (sources fetched 2026-10-19, quoted below). Star counts are Gemini's and approximate.

## 1. Provider terms: what Agora may and may not do

| Provider | Driving the official CLI on your own machine, your own login | Letting other people use it through your login | Automation recommendation |
|---|---|---|---|
| **Anthropic** | **Allowed** ("an end user signing in to the unmodified Claude Code binary with their own Claude subscription") | **Not allowed**: "may not… route requests through Free, Pro, or Max plan credentials on behalf of their users", "may not collect, store, or intermediate Claude.ai credentials or session tokens" | API key for third-party/hosted use; Agent SDK: "Use the API key authentication" |
| **OpenAI** | **Grey**: not forbidden; "API keys are still the recommended default for automation" | Not allowed: don't share account or `~/.codex/auth.json` | API key |
| **Google** | **Strictest**: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach"; suspensions enforced | Not allowed | **API key only** for anything automated |

Sources: code.claude.com/docs/en/legal-and-compliance; code.claude.com/docs/en/agent-sdk/overview; anthropic.com/legal/consumer-terms (eff. 2025-10-08); learn.chatgpt.com/docs/auth; github.com/google-gemini/gemini-cli docs/resources/tos-privacy.md (2026-04-10); antigravity.google/terms §6; ai.google.dev/gemini-api/terms (2026-04-28). OpenAI consumer ToU was read from mirrors (openai.com returned 403): unverified.

**Agora today:** agora-host spawns the unmodified `claude` / `codex` binaries under the machine owner's existing login; no credentials are read or relayed. Gemini (agy) is not hosted; Claude has run `agy -p` headless for research on this machine (official binary, but grey under Google's "products not provided by us" wording).

### Guardrails to adopt
1. **Subscription logins are for single-owner instances.** Docs + setup wizard say so; multi-user instances use API keys or one host per human.
2. **Host setting:** only the owner can trigger hosted runs on a subscription-login profile; anyone else's @mention needs an API-key profile. (Enforce in agora-host/server.)
3. **Gemini hosted only with a Gemini API key**; stop running `agy -p` on account login from automation.
4. **Never** extract, store or relay `auth.json` / OAuth tokens; **never** offer "Sign in with Claude/ChatGPT/Google" inside Agora; official binaries only.
5. **Branding:** "runs Claude Code / Codex / Gemini" in plain text, plus a not-affiliated disclaimer (as opcode does). No look-alike names or logos.

## 2. Features worth adding (ranked for beta users)

Agora already has: worktree per session, changed-files list per run, image auto-attach, file reservations, permission presets with phone approval, token budgets, lurk mode, sessions from the phone, invites, passkeys, sandboxed code runs, audio overviews.

| # | Feature | Who has it | Agora | Fit / terms |
|---|---|---|---|---|
| 1 | **Diff review from the phone**: per-session diff, accept/reject hunks, squash-merge or open PR | Claude Code desktop tab, Vibe Kanban, Crystal, CloudCLI, Zed | changed-file names only | builds on #79/#82 worktrees; no terms issue |
| 2 | **Checkpoints / fork from a message**: roll back chat + worktree to a turn, or branch from it | opcode, Cline, Crystal, Gemini CLI, LibreChat | no | git commits per turn in the session worktree |
| 3 | **Channel "project" context**: pinned instructions + pinned docs every agent gets on wake | Claude/ChatGPT Projects, Open WebUI, LibreChat | partial (channel topic) | wake prompt + MCP resource; cross-provider by design |
| 4 | **Task board → sessions**: cards that spawn a worktree session and track PR status | Vibe Kanban, Codex desktop, 1code | no | sits on threads + sessions |
| 5 | **Verify before yield**: run the project's test/lint command when an agent finishes, feed failures back | Aider, Crystal, OpenHands, Codex cloud | no | host post-run hook; pairs with #82 "done vs disk" |
| 6 | **Artifacts / canvas pane**: render HTML/Markdown/Mermaid/SVG a message produces, side by side | Claude, ChatGPT, Gemini canvas, LibreChat | no | sandboxed iframe in UI |
| 7 | **Subtask delegation with summary-only return** | Roo Code (Boomerang), Claude subagents, Goose recipes | no | thread + session per subtask; summary posted back |
| 8 | **Voice input** in the phone composer | Claude/ChatGPT mobile, Aider | no (TTS exists) | Web Speech API or local Whisper |
| 9 | **ACP support** in agora-host (structured tool calls, diffs, permission requests) | Zed, Toad, `gemini --acp`, OpenHands, OpenCode, Goose | no | could fix #93 (Codex denial signal) and give a cleaner adapter layer |
| 10 | **Browser preview / screenshot loop** for web apps | Cline, OpenHands, Claude Code desktop | no | heavier; uses the sandbox runner |

Also noted: MCP server manager UI (CloudCLI, opcode, Claude Desktop), usage/cost dashboard (opcode), recipes/YAML workflows (Goose), shareable session links (OpenCode).

## 3. Open-source projects reviewed
CloudCLI/claudecodeui (AGPL), opcode (AGPL, not-affiliated disclaimer), Vibe Kanban (Apache), Crystal → Nimbalyst (MIT), Claude Squad (AGPL), 1code (Apache), Toad (AGPL, ACP), Zed + ACP spec (agentclientprotocol/agent-client-protocol), OpenCode (MIT; note it reuses ChatGPT/Copilot OAuth, which is the pattern to avoid), Goose (Apache, ACP), Cline, Roo Code, Aider, OpenHands, LibreChat, Open WebUI. Most spawn the official CLIs under the user's own login, as Agora does; the ones that reuse consumer OAuth tokens directly are what the terms prohibit. **Don't copy AGPL code** into Agora without a licence decision; borrow ideas, not code.
