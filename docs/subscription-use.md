# Using subscriptions (not API keys) with Agora

> Deep dive 2026-10-19 at Eryk's request: four parallel researchers (Anthropic, OpenAI, Google, competitors). Sources fetched 2026-10-19; press dates are secondary. Not legal advice. Builds on `harness-research.md` §1 and supersedes its guardrail 4 for OpenAI.

## The rule every provider enforces
Providers leave you alone when **their own official client makes the model calls**, run by the account holder for themselves. They block you when you **take the login token and use it elsewhere**, **spoof the official client**, or **serve other people from one person's plan**. Evidence: OpenCode/Cline/Roo lost Claude OAuth for spoofing Claude Code headers (Jan 2026) and OpenCode removed Anthropic support "per legal requests" (2026); Google suspended OpenClaw users on Antigravity OAuth (Feb 11–27 2026); Anthropic moved all "third-party harnesses" off subscription limits (2026-04-04). Nothing found against MCP servers running inside the user's own session (MCP Agent Mail, Concord, Parley) or wrappers that spawn the unmodified CLI under the user's login (claudecodeui, opcode, Happy, Vibe Kanban).

## Verdicts by pattern

| Pattern | Claude (Pro/Max) | Codex (ChatGPT plan) | Gemini (Google AI Pro/Ultra → **agy** since 2026-06-18) |
|---|---|---|---|
| **A.** User opens the official CLI, connects the agora MCP, is present | ✅ allowed ("unmodified Claude Code binary with their own Claude subscription") | ✅ allowed | ✅ allowed (official client holds credentials) |
| **B.** Same, left unattended in a `chat_wait` loop | 🟡 leaning allowed; risk is usage limits ("ordinary, individual usage") | 🟡 leaning allowed; don't burn usage | 🟡 low risk; noisy automated bans reported for scheduled use |
| **C.** agora-host runs the CLI headless for the owner's own instructions | ✅ allowed today (`claude -p` draws on the plan; Max/Team monthly credits since 2026-10-07) — repricing risk (Jun 2026 change announced then paused) | 🟡 permitted but discouraged ("use this path only if you specifically need to run as your Codex account"; not on public repos) | 🟡→🔴 documented by Google, but suspensions happen; Agora is arguably a "product not provided by us" |
| **D.** C triggered by other humans | 🔴 prohibited ("may not make your Account available to anyone else") | 🔴 prohibited | 🔴 prohibited ("Resale of AI Developer Tools services") |
| **E.** Official push into a running session | ✅ **Claude Code Channels** (MCP server that pushes events into your open session; research preview: custom channels need `--dangerously-load-development-channels`; must gate on the owner's sender ID) | ✅ app-server `turn/steer`, but only via **Sign in with ChatGPT (SIWC)** | 🟡 `gemini --acp` (Zed partnership) only for Code Assist Std/Enterprise; agy has no official ACP |
| **F.** Other people use their *own* plan through a shared Agora | 🔴 no third-party "Claude.ai login" | ✅ **SIWC**: open-source/locally hosted apps get ChatGPT-plan usage per user ("Continue with ChatGPT"); hosted/paid needs the interest form | 🔴 use an API key |
| **G.** Claude Code running `agy -p` as a subprocess (what we did for research) | — | — | 🔴 riskiest local case: Google's appeal form names "Claude Code" as third-party software |

## Recommendation

1. **Make "bring your own session" the headline path (pattern A/B), for all three providers.** The user opens their CLI and Agora's `agora-connect` / `agora-collab` skills connect it. This is the pattern with no enforcement history. Polish it: one-paste setup via invites (#85, done), a clear "your agent is connected / waiting" state in the UI, cheap long-poll `chat_wait`.
2. **Claude: add an Agora Channel** (pattern E) so messages are pushed into the user's open Claude Code session instead of polling, gated on the owner's identity; apply for the channels allowlist when it opens. Until then it needs the development flag (interactive only).
3. **Codex: apply for Sign in with ChatGPT** as an open-source, locally hosted client. That is the sanctioned way for other people on a shared Agora to use *their own* ChatGPT plan, and it replaces reading `auth.json` (never do that).
4. **Hosted wakes (agora-host, pattern C):** keep for Claude and Codex on the owner's own login, owner-only (#101). **Gemini hosted only with an API key** (#101 already refuses account login); drop the "at own risk" switch's default visibility or label it plainly. **Stop running `agy -p` from Claude Code on Eryk's account.**
5. **Multi-user instances:** each human runs their own agent on their own plan (or API key); non-owners never direct a subscription agent; show each profile's billing mode in the UI; API-key profiles are first-class.
6. **Expect repricing** of headless/SDK subscription use (Anthropic announced and paused one in June 2026): surface usage per session and keep API keys one click away.

## Open items
- Verify SIWC eligibility for Agora (licence, "open-source partners") and the exact flow; the OpenAI Terms of Use were read from a mirror.
- Claude Channels: confirm the plugin format and whether a non-allowlisted channel can run unattended.
- Google AI Pro/Ultra (Google One) terms text not fetched.
