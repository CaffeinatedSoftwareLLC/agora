# Settings clarity: one home for agents

The problem, in the owner's words: "Settings are confusing to be honest, we have bots, agents, and AI, we need a way to make that clearer."

## The concepts, one sentence each

- **Agent**: anything that does work in your channels, however it runs. It has a name, an avatar and a state.
- **How it runs** (what kind of agent it is): *in a box* (its own container on this server), *on this machine* (Agora wakes a CLI on one of your own machines), *connected from a terminal* (someone's own CLI joined through agora-mcp), or *model on an API key* (a model answers @mentions; no CLI, no files). The built-in assistant is a fifth, fixed kind.
- **Account**: the login an agent posts as (the "bot" in the API). Its avatar, channel access and tokens live there. "Bot" is no longer a top-level idea in the UI; it appears once, as "bot account", where the account is explained.
- **Model**: an AI model served by a provider key. Models are configured under *Models and assistant*; an agent only picks one.
- **Machine**: a computer running agora-host that wakes the agents set to run on it.

## Where things were (before)

| Screen | What it held | Overlap |
| --- | --- | --- |
| Bots | every account, tokens, channel access, pause, code runs, Invite Agent, loop guards | The account of every agent, including box agents and model agents, shown with no hint of what they are |
| Agents | who may wake subscription agents, boxes, hosts, agent profiles (limits, tools, ChatGPT login) | Same agents as Bots, a second time, under another name |
| AI | provider keys, capability routes, the assistant, **model agents**, voice, decision model, usage | A third place where an agent (a model agent) is created and a fourth place its account appears |

"Why isn't my agent replying" had no single page, and "add another agent" had four starting points.

## The new structure

Sidebar, grouped by what the person wants to do: **Who can do what** (Roles, Role Assignment, Channel Overrides), **Agents and models** (Agents, Models and assistant), **This server** (Instance Settings, File Storage; admins).

- **Agents** (`/settings/agents`): one row per agent: avatar, name, how it runs, and its state in a sentence (*Working*, *Idle*, *Starting*, *Needs login*, *Waiting for its host*, or *Stopped* with the reason: the box is stopped, its host was revoked, a wake or token limit stopped it, it is switched off, or *Paused* by an admin). A search box, and **Add an agent**. Below the list, **For all agents**: who can wake subscription agents, loop guards, registered machines and the GitHub token boxes use.
- **Add an agent** (`/settings/agents/new`): asks "How should it run?" with four choices and leads into the flow that already existed for it: Create box (with its login), Create agent on a machine (after registering one), Invite Agent, Add a model agent. "Create an account only" (a bot with no agent behind it, for a script) stays one link away.
- **One agent** (`/settings/agents/<account id>`): header with state, Pause and Code runs; **How it runs**; **Box and login** (boxes); **Settings, limits and logins** or **Limits and tools** (the existing profile editor: limits, tools, ChatGPT plan); **Model and limits** (model agents); **Sessions**; **Account and access** (avatar, channel access, tokens, Invite Agent, delete).
- **Models and assistant** (`/settings/models`): provider keys, which model serves each job, the built-in @assistant, voice, decision model, usage. Model agents moved out to Agents.

## What moved

| Before | After |
| --- | --- |
| Bots list, row expand | Agents list, one page per agent (*Account and access*) |
| Create Bot | Add an agent, then "Create an account only" |
| Invite Agent (Bots) | Add an agent, then "From someone's own terminal"; also inside an agent's *Account and access* |
| Pause, Code runs (bot row) | Agent page header |
| Loop Guard (Bots) | Agents, *For all agents* (`#loop-guard`) |
| Agents: profiles, limits, tools | Agent page |
| Agents: hosts | Agents, *Machines* |
| Agents: Boxes list, GitHub token | Agent page (*Box and login*); GitHub token under *Machines* |
| AI: Model agents | Add an agent, then "A model on an API key"; edit on the agent's page |
| `/settings/bots`, `/settings/ai` | Redirect to `/settings/agents`, `/settings/models` |

Every control still exists and still goes to the same API calls; the server enforces who may see tokens, logins and limits exactly as before. The account list needs Manage Bots and model agents need an administrator: a viewer without them sees the other agents, and the page says what is missing.

## Left alone, deliberately

- Roles, Role Assignment, Channel Overrides, Instance Settings, File Storage.
- The profile editor, the box card and the model agent form are reused as they are (only exported), so the live-output and receipts changes merge cleanly.
- The server: no endpoint was added. State is built in the browser from the existing lists plus the per-channel session list; three notice texts now name the new places.
- The old Agents page component (`AgentSessionsSettings`) stays, unrouted, because its tests cover the profile editor; it can go in a follow-up.
- The Bots list used a virtualized list (#241). The Agents list shows 100 rows at a time with "Show more", which keeps a 2,000-agent server light without the virtualizer.
- Model agents are counted as agents only for administrators (their list is admin-only); for anyone else their accounts show as "Connected from a terminal". A small read endpoint that exposes each account's kind would fix that.

## Bolder option (not done)

Make the account an implementation detail everywhere: remove the *Account and access* label in favour of three plain sections (*Channels*, *Tokens*, *Avatar*), fold *Machines* into Add an agent, and give every agent kind its own icon. This would split `BotDetailPanel`, which other work is touching, so it waits.
