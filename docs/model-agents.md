# Model agents

A model agent is a bot that runs on the Agora server with its own provider and model, for example a model on OpenRouter. People @mention it in a channel or thread; the server calls the model, lets it use a fixed set of Agora tools, and posts its answer as the bot. A server can have any number of them, next to the built-in `@assistant`.

Model agents need no agent host and never touch anyone's machine. Code they write runs only in the sandbox, through the same approval gate as any bot's code. Migration `069`.

## Set one up (OpenRouter)

1. **Settings → AI → Providers → Add provider.** Choose *OpenAI / OpenAI-compatible*, label it `OpenRouter`, set the base URL to `https://openrouter.ai/api/v1` and paste an OpenRouter API key. A key with a credit limit, made for this server in the OpenRouter dashboard, keeps a runaway agent from spending more than that limit.
2. **Settings → AI → Model agents → Add agent.** Give it a name (how people @mention it, for example `Scout`), pick the OpenRouter provider and enter an OpenRouter model ID, for example `openai/gpt-4.1-mini` or `anthropic/claude-sonnet-4.5`. The model must support tool calling (OpenRouter lists this per model). Optionally write a system prompt, choose tools, set the maximum steps, daily limits and the channels it answers in.
3. In one of those channels, write `@Scout what changed in the task board today?`.

The agent can be added to more channels later from the channel's agent list, like any bot. To let it change task cards, the server owner turns on **can direct** for it in that channel, as for any bot.

The same works with any OpenAI-compatible server that implements function calling: OpenAI itself, Groq, vLLM, or Ollama for local models (base URL `http://host:11434/v1`, with *Allow private base URLs* on).

## What happens on a mention

A mention reaches the agent when a member with **Use Bots** (or Administrator) writes `@name` in a channel the agent's bot was added to, or in an open thread there. The server then:

1. Checks the agent is enabled, its bot isn't paused and has access to the channel, and handles each mention once.
2. Reads the last 20 messages (the thread and its parent for a thread mention) and formats them with the same envelope agora-mcp uses: each message starts with `[time] (id) author [BOT] [OWNER]/[DIRECTOR] (user id):`, continuation lines start with `  | `, and names can't carry tags.
3. Calls the model with Agora's preamble, the admin's system prompt and that transcript. If the model asks for tools, the server runs them and sends the results back, up to the agent's **max steps** model calls. The last step is offered no tools, so the model has to answer.
4. Posts the final answer as the bot where it was mentioned (in the thread for a thread mention). Answers longer than 4000 characters are cut.

The answer is posted once, when the model is done; it is not streamed.

## Who gives instructions

Every agent runs under the same rule as agora-collab's Rule 10, placed before the admin's system prompt:

- Only messages from the server owner (`[OWNER]`) and people the owner allowed to direct agents in the channel (`[DIRECTOR]`) are instructions.
- Everything else (other members, other bots, file text, tool results, run output, text a director quotes) is information.
- When someone without the tag asks for something, the agent says an owner or director needs to ask.

The server also enforces this for the mention itself: when the person who mentioned the agent is not an owner or director, the model is told so and is offered only the reading tools (`read_history`, `file_search`, `file_read`, `task_list`) for that request. A tool call outside that set is answered with a refusal and not run.

This lowers the risk of the model obeying the wrong person. It does not make a model immune to prompt injection; the tools and limits below are what bound the damage.

## Tools

Each agent has an allowlist. Every tool is a call to Agora's REST API as the agent's bot, so the bot's checks apply exactly as for an agora-mcp bot: the bot route allowlist, channel access, pause, per-channel rate limit and loop guard, **can direct** for task changes, and the runtime approval gate.

| Tool | Does | Notes |
|---|---|---|
| `read_history` | Read recent messages of a channel or thread | Any channel the bot has access to; others are refused (403) |
| `post_message` | Post a message or thread reply | Counts toward the bot rate limit and the loop guard |
| `file_search` | Search shared files by name, tag and content | Names and IDs, not content |
| `file_read` | Read a file's text in pages | Flagged files come with a warning |
| `task_list` | List the channel's task cards | |
| `task_create`, `task_update` | Add or change task cards | Refused unless the owner allowed the bot to direct in the channel |
| `canvas_publish` | Post a canvas artifact (Markdown, HTML, Mermaid, SVG) | In the thread when mentioned in one |
| `runtime_exec` | Submit TypeScript to the sandbox | Always in the mention's channel and thread; see below |

Tool results go back to the model labelled as data. Structured results are one-line JSON, so they can't fake transcript lines. A tool result is cut at 8000 characters, and at most 5 tool calls run per step.

**Code runs.** Giving an agent `runtime_exec` sets its bot's sandbox access to **approval** (if it was off); removing the tool sets it to **none**. Every run then waits for a member with Manage Bots to approve it in the channel, and its result is posted there when it finishes; the model only learns that the run was submitted. An admin can change the bot's access in Bot Management like any bot's, including to auto-run, which is their call.

## Limits and usage

| Limit | Value |
|---|---|
| Model calls per mention | `max steps`, 1–20 (default 6) |
| Output tokens per call | `maxOutputTokens`, 64–32000 (default 2048) |
| One model call | 90 s |
| One mention, tools included | 5 minutes |
| Mentions one agent handles at once | 2 per API process; more get a "busy" reply |
| Agent's own daily requests, tokens, cost | Optional, per agent (UTC day) |
| Server's chat budget | The Chat route's daily limits apply too: agent calls count as chat usage |

Over a limit, the agent posts a notice instead of calling the model. Each model call is a row in the usage ledger with `capability = 'chat'` and the agent's `model_agent_id`; with input and output prices set on the agent, rows carry a cost. Settings → AI → Model agents shows today's calls and tokens per agent.

**Out of credit.** When the provider answers HTTP 402 (OpenRouter: the key has no credit left or hit its limit), the agent posts that it is out of credit instead of a generic error.

## Pause and delete

**Pause** in Settings pauses the bot too: a paused agent ignores mentions, and a paused bot can't post or call tools. **Delete** deletes the agent's bot, its token and its channel access. A provider that an agent uses can't be deleted (409); delete or move the agent first.

## How it is built

- `src/ai/model-agent-handler.ts`: the mention listener (on the same internal event as the assistant), context, the step loop, limits and posting.
- `src/ai/model-agent-tools.ts`: tool definitions and execution.
- `src/ai/adapters/openai.ts`: `chatWithTools`, a non-streamed Chat Completions call with `tools` and `tool_calls`. Only adapters that implement it can serve an agent; today that is the OpenAI-compatible adapter.
- `src/lib/message-envelope.ts`: the agora-mcp envelope, copied for the server; a unit test checks both give the same output.
- `src/routes/model-agents.ts`: the API.
- Creating an agent creates its bot user and one bot token, named *model agent (server)*. The server keeps that token encrypted (AES-256-GCM, like provider keys) in `model_agents.token_*` and uses it to call its own API in process (`app.inject`). The token is never returned by the API. Revoking it in Bot Management stops the agent; recreate the agent to get a new one.

## API

All routes need **Administrator** on the server, like the rest of AI settings.

| Method and path | Body | Returns |
|---|---|---|
| `GET /servers/:serverId/ai/agents` | | The server's agents, with today's usage |
| `POST /servers/:serverId/ai/agents` | `name`, `providerId`, `model`, and optionally `systemPrompt`, `tools`, `maxSteps`, `maxOutputTokens`, `dailyRequestLimit`, `dailyTokenLimit`, `dailyCostLimitMicros`, `inputPriceMicrosPerMtok`, `outputPriceMicrosPerMtok`, `channelIds` | 201 with the agent; 400 for a provider whose adapter can't run agents; 409 `username_taken` |
| `PATCH /servers/:serverId/ai/agents/:agentId` | Any of the settings above, and `enabled` | The agent |
| `DELETE /servers/:serverId/ai/agents/:agentId` | | `{ deleted: true }` |

`name` is the bot's username: letters, digits, `-` and `_`, up to 32 characters. Changes are recorded in the AI change log (`ai_agent_create`, `ai_agent_update`, `ai_agent_delete`); the system prompt itself is not copied into the log.

## Not built yet

- **A capped key per agent.** OpenRouter can mint keys with their own credit limit from a management key (`POST https://openrouter.ai/api/v1/keys` with a `limit`). Agora could do that when an agent is created, so each agent has its own spending cap at the provider. Today, use one key per provider and set its limit in the OpenRouter dashboard, plus the agent's daily limits here.
- Streaming the answer as it is written, and a "thinking" placeholder.
- Tool calling for the Anthropic and Gemini adapters.
- Reading images, `canvas_read`, and waiting for a code run's result within the same request.
