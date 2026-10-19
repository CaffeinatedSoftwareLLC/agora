# Cloud session handoff: beta features 3–10

> For Claude Code cloud sessions (claude.ai/code) started by Eryk on 2026-10-19. The local Claude session coordinates: it verifies, merges and deploys. **Cloud sessions build and open PRs; they never merge.**

## Read first
`CLAUDE.md`, `docs/planning/harness-research.md` (section 2 = the feature list), `docs/provider-terms.md` and `docs/planning/subscription-use.md` (every feature must stay within provider terms: no reuse of CLI login tokens, subscription profiles owner-only, Gemini hosted only via API key).

## Rules
- One branch + one PR per group below, from `main`. Title the PR with the group name. End commits with `Co-Authored-By: Claude <noreply@anthropic.com>`, PR bodies with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Follow repo conventions: Fastify JSON schemas, membership/authority checks, events only after commit, `.trim()` on CHAR(26), new top-level route prefixes → `agora-ui/nginx.conf`.
- Migrations: main is at **050** after PR #105. Use the number given for your group to avoid collisions.
- Tests: write them. Run what the cloud box supports: `npx vitest run test/unit`, `cd agora-ui && npx vite build && npx vitest run`, `cd agora-host && npm test`, `cd agora-mcp && npm run build && npm test`. Integration tests need Postgres 16 + Redis 7 (`docker compose up -d postgres redis` if Docker works, else install them, DB `accord_test`, user/pass `accord`). If you can't run integration tests, say so in the PR; the local session runs the full suite before merging.
- PR body: what changed, files, migration, exact test results, what you could not test, open questions.

## Groups (one cloud session each, can run in parallel)

**C1 — Project context + verify before yield** (migration 051)
- Channel "project context": owner/directors pin instructions and up to N docs/files to a channel; every agent wake (agora-host prompt) and an MCP resource/tool include them; UI to edit in channel settings.
- Verify before yield: per-session (or per-channel) test/lint command; agora-host runs it in the session worktree after a run that changed files and, on failure, feeds the output back as a follow-up turn (bounded retries) and posts the result; owner-configurable, off by default.

**C2 — Task board + subtask delegation** (migration 052)
- Task board per channel: cards (title, description, assignee agent, status), creating/starting a card spawns a worktree session (reuse #91 sessions) and the card tracks branch/PR status (#102 diff review).
- Subtask delegation: an agent can spawn a child session in a new thread with a scoped brief; the child works in clean context and posts only a summary back to the parent thread; budget inherited from the parent.

**C3 — Artifacts/canvas pane + browser preview** (migration 053)
- Canvas: messages can carry an artifact (HTML/Markdown/Mermaid/SVG); the UI renders it in a sandboxed iframe side pane (CSP, no same-origin, no network by default); versions per artifact; mobile-friendly.
- Browser preview: an agent can request a headless-browser screenshot (and console log) of a URL served from its session worktree (dev server on localhost via the host, or the sandbox runner); result posted as an image (reuse #86 image attach). Strict URL allowlist (localhost ports of that session only).

**C4 — Voice in and out** (migration 054 if needed)
- Voice input in the composer (push-to-talk) and spoken replies. Evaluate first and write the comparison into the PR: local Kokoro TTS (as in Eryk's thoth / issue #35, OpenAI-compatible Speech endpoint) vs browser Web Speech API vs a local Whisper/faster-whisper STT. Prefer local/offline and free; pick the best quality per direction and justify. Server-side TTS provider configurable in admin; per-user toggle; reads agent replies aloud on the phone.

**C5 — ACP support in agora-host** (no migration expected)
- Add an Agent Client Protocol adapter path to agora-host (spec: github.com/agentclientprotocol/agent-client-protocol) for agents that speak ACP (`gemini --acp` for Code Assist/API-key users, Claude Code ACP adapter, codex-acp), mapping ACP tool calls, permission requests (→ existing tool-request cards), diffs and progress into Agora. Must respect auth modes from #101/#105 (API-key or plan-owner only; no Google account login hosted). Goal: structured permission signals (may fix #93).
