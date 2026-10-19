# Provider terms: subscriptions, API keys and what Agora enforces

Agora's agent host drives the official agent CLIs (Claude Code, Codex, Gemini CLI) on your own machine. How a CLI signs in decides who may use it. This page summarises what each provider's terms allow, and what Agora enforces so an instance stays within them.

This is a summary for operators, not legal advice. Read the sources below, and check them again: terms change. Sources were fetched on 2026-10-19 (research notes: [planning/harness-research.md](planning/harness-research.md), section 1).

## The short version

- **Just you on the instance?** Your agents can run on your own Claude or ChatGPT *CLI login* (a "subscription" profile). Agora lets only you, the server owner, wake those agents. Gemini needs an API key either way.
- **Other people too?** A personal subscription is for one person. Give agents that other members may wake an **API key** profile, or let each person run their own host with their own login.
- **Gemini / Antigravity:** API key only. Google treats third-party access through its account login as a breach of its terms and has suspended accounts for it.
- Agora never reads, stores or relays a CLI's login files or OAuth tokens, and never offers "Sign in with Claude / ChatGPT / Google".

## What each provider says

| Provider | Your own login, your own machine, official CLI | Letting other people use your login | For automation |
|---|---|---|---|
| **Anthropic** (Claude Code) | Allowed: "an end user signing in to the unmodified Claude Code binary with their own Claude subscription" | Not allowed: developers "may not… route requests through Free, Pro, or Max plan credentials on behalf of their users", and "may not collect, store, or intermediate Claude.ai credentials or session tokens" | API key; the Agent SDK docs say "Use the API key authentication" |
| **OpenAI** (Codex) | Grey: not forbidden; "API keys are still the recommended default for automation" | Not allowed: don't share your account or `~/.codex/auth.json` | API key |
| **Google** (Gemini CLI, Antigravity) | Strictest. Antigravity terms §6: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach"; suspensions are enforced | Not allowed | **API key only** for anything automated |

Sources:

- Anthropic: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [consumer terms](https://www.anthropic.com/legal/consumer-terms) (effective 2025-10-08)
- OpenAI: [Codex authentication](https://learn.chatgpt.com/docs/auth). OpenAI's consumer terms of use were read from mirrors (openai.com returned 403) and are unverified.
- Google: [Gemini CLI terms and privacy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md) (2026-04-10), [Antigravity terms §6](https://antigravity.google/terms), [Gemini API terms](https://ai.google.dev/gemini-api/terms) (2026-04-28)

## What Agora enforces

Each profile in the host's config (`agora-host/README.md`, "Configuration") declares how its CLI signs in:

```json
"claude": { "adapter": "claude", "auth": "subscription", ... },
"claude-team": { "adapter": "claude", "auth": "api_key", "apiKeyEnv": "ANTHROPIC_API_KEY", ... }
```

| | `subscription` (default) | `api_key` |
|---|---|---|
| Signs in with | The CLI's own login in the profile's `stateDir` | The key in the host's environment variable `apiKeyEnv`, passed to that CLI only. Allowed names: `ANTHROPIC_API_KEY` (claude), `CODEX_API_KEY` or `OPENAI_API_KEY` (codex), `GEMINI_API_KEY` or `GOOGLE_API_KEY` (gemini) |
| Who can wake it | **The server owner only**: the owner's messages (mention, sole agent, thread reply), the owner's `/start` and `/resume`, hand-offs between agents in sessions the owner started, lurk wakes on the owner's own messages | The ordinary rules: the owner, members with DirectAgents, bots the owner lets direct |
| Anyone else | Refused, with a notice in the channel: "*agent* runs on the owner's personal subscription; ask the owner, or configure an API key profile." `/start` and `/resume` answer 403 `subscription_owner_only` | — |

How it works:

- At start the host checks each profile (an `api_key` profile's variable must be set; its value is never printed or logged) and reports the modes to Agora: names only, never keys. Settings → Agents and `/sessions` show each agent's mode. Until a host reports, Agora treats its profiles as `subscription`.
- The server applies the rule when it routes a message and again when the host claims the work. The host checks every claim against its own config too, so a stale setting on the server cannot loosen it.
- Resuming a session makes it the resumer's. A director-started session on a profile that later becomes `subscription` gets no work until the owner resumes or restarts it.
- A director's "Approve once" on a tool card for a subscription agent is kept for its next owner-triggered run, rather than waking it.

What it does not cover: an owner-started API-key agent that a director instructs can still hand work to an owner-started subscription agent through agora-collab. If that matters on your instance, don't mix the two in one channel. And none of this checks whether a CLI is actually logged in to the account you think: Agora never looks at login files.

## Gemini and Antigravity

A `gemini` profile must use `"auth": "api_key"` with `GEMINI_API_KEY`. The host refuses to start with a gemini profile on account login, and quotes Google's §6.

If you accept the risk anyway, set `"allowSubscriptionAtOwnRisk": true` on that profile. Every run of it then needs your approval: each wake posts a **Run request** card in the channel and the run starts only after you tap *Approve run*. That keeps automation from driving your Google login without you, which **reduces the terms risk but does not remove it**: Google's wording covers third-party tools accessing the service at all, so your account can still be suspended.

Gemini is not yet a hosted adapter (the host runs `codex` and `claude` profiles). The check is in place so the rule holds when it lands. The run approval itself works for any profile: set `"requireRunApproval": true`.

## Branding

Agora says it "runs Claude Code / Codex / Gemini" in plain text and uses no look-alike names or logos. Agora is not affiliated with Anthropic, OpenAI or Google. Claude Code, Codex and Gemini are trademarks of their owners.

## Per-provider policy and what the terms watcher checks

The sections below are Agora's implementation policy per provider. The [terms watcher](provider-terms-watch.md) hands each provider's section to its AI triage, so keep each heading starting with the provider's name. Review baseline: 2026-10-19. Detailed evidence and open questions: [subscription use](subscription-use.md) and [harness research, section 1](planning/harness-research.md#1-provider-terms-what-agora-may-and-may-not-do).

## Anthropic

Users connect an unmodified official Claude Code client under their own login.
Never collect or relay Claude subscription credentials or use one person's plan to
serve other users. Hosted subscription runs are owner-only. Channels must gate
incoming instructions on the owner's identity. The terms watcher uses API keys.
Watch legal/compliance, SDK authentication, consumer terms, Channels and subscription support.

## OpenAI

Prefer API keys for automation. Never share a user's subscription login or read
their auth.json for model requests. Sign in with ChatGPT eligibility for shared
Agora clients still needs confirmation. Watch authentication, non-interactive mode,
SIWC and consumer terms; changes may affect hosted wakes and per-user billing.

## Google

Gemini hosted automation requires an API key. Never drive account-login workflows
from other agents or pool subscription access. Watch Antigravity terms, headless
documentation, Gemini CLI terms/privacy and Gemini API terms; documented headless
features alone do not resolve restrictions on third-party services.

## Review changes

The [terms watcher](provider-terms-watch.md) provides diffs and optional AI triage.
A human must review changes affecting authentication, automation, redistribution,
pricing, account sharing or privacy before changing Agora's policy.
