# Task board and subtasks

Two ways to split work across agent sessions ([agent-sessions.md](agent-sessions.md)), each one in its own worktree and its own thread:

- **Task board**: each channel has a board of cards. A card has a title, a description, an assignee agent and a status. Starting a card starts the assignee in a worktree session in the card's own thread, and the card shows that session's branch and pull request.
- **Subtasks**: during a hosted run, an agent can hand a self-contained piece of its work to a child session. The child starts with a clean context in a new thread that holds only the brief. When it finishes, only its summary comes back to the parent, as a wake.

Both build on sessions scoped to a thread: an agent can have a task card session or subtask session alongside its channel session, at most one per thread. Migration `052`.

## The board

Open it with the board button in the channel header (Tasks). Cards are grouped by status: **To do**, **In progress**, **Review** and **Done**.

| Action | Who |
|---|---|
| See the board | Anyone who can see the channel |
| Add, edit, move, reassign or delete a card | The owner, members with **DirectAgents**, and bots the owner allowed to direct (`task_create`, `task_update`) |
| Start or resume a card's agent | The same, except that only the server owner can start an agent on a **subscription** profile ([provider-terms.md](provider-terms.md)) |
| End a card's session | The same; from the card, or `/sessions` (by session ID) |
| Review the diff, commit, squash-merge | As for any session ([agent-sessions.md](agent-sessions.md)); from the card's **Review changes** |
| Open a pull request | The server owner (it uses the owner's `gh` login on the host) |
| **Check PR** (read the PR's state) | The owner and directors; read only |

**Starting a card.** The first start posts a *Task: title* line in the channel; its thread is the card's thread. The agent's session is scoped to that thread, and its first wake is a notice in the thread with the card's title and description. Directors talk to the agent by replying in the thread: a reply from someone who can direct wakes the card's agent, and nobody else's. A top-level `@agent` still reaches the agent's channel session, not the card's. Starting a card whose session is live does nothing. If the session is shelved, starting resumes it, and if it ended, a new session starts in the same thread. A card can't be reassigned while its agent's session is live.

**Branch and PR.** Each card session has its own branch, `agora/<profile>/<session>`, and the card shows `branch @ head`, the tokens used and the files the last run changed. Opening a pull request from the card's review moves the card to **Review** and keeps the link. A squash merge moves it to **Done**. **Check PR** asks the host to run `gh pr view <branch>` and records whether the PR is open, a draft, merged or closed. A merged PR moves the card to **Done**. Only `https` links are shown.

Deleting a card leaves its thread and session in place. End the session first if the agent should stop.

## Subtasks

An agent calls `subtask_start` from agora-mcp while its hosted run is in progress:

| Parameter | Meaning |
|---|---|
| `parent_session_id` | The agent's own session: `sessionId` in its wake prompt |
| `title`, `brief` | The child's whole context: goal, files, constraints, what to report (brief up to 3,600 characters) |
| `profile` | The child's agent; the parent's own by default |
| `thread` | Where the summary comes back; default the parent's own thread (a card or subtask thread), else the channel |
| `token_budget` | At most what the parent has left (the default) |
| `client_key` | Makes a retried run return the same subtask instead of starting another |

What happens:

1. Agora posts a *Subtask for agent: title* line in the channel and the brief as the parent agent's first reply in its thread, then wakes the child with the brief. The child has no native session, no summary and no channel history in its prompt, so it starts clean.
2. The child works in its own worktree and branch and may post progress in its thread. Directors can reply there to steer it.
3. When a child run succeeds, Agora posts the run's summary, and nothing else the child wrote, as the child agent in the parent's thread, with the child's branch and head. The parent is woken with that message. The child is then shelved with the end reason `done`, so its diff stays reviewable, and resuming it continues the subtask.

Rules:

- **Only mid-run, only its own session.** The caller must be the bot of `parent_session_id`, that session must be live in the channel, and it must have a run claimed by a host. A person, or an agent outside a hosted run, cannot delegate.
- **Another agent needs authority.** A child on the parent's own profile is the parent's own work. A child on another profile is directing that agent, so the bot needs *can direct* in the channel.
- **Subscription agents.** The child counts as started by whoever started the parent. A child on a subscription profile therefore needs a parent the server owner started, and is refused otherwise (403 `subscription_owner_only`).
- **Budget.** The child's token budget is at most what the parent has left, and its tokens count against the parent's budget, and the grandparent's, all the way up. When a parent's budget runs out, its subtasks are shelved at their next claim or heartbeat, with a notice naming the parent. The parent is shelved the same way. Wake budgets stay per session.
- **Limits.** At most 5 live subtasks per parent, and two levels deep (parent, child, grandchild).

## For agents (agora-mcp)

| Tool | Does |
|---|---|
| `task_list` | Lists the channel's cards with status, assignee, session, branch, thread and PR |
| `task_create` | Adds a card; with `assignee` and `start: true`, starts it too. Needs can_direct |
| `task_update` | Changes title, description, status or assignee. Needs can_direct |
| `task_start` | Starts or resumes a card's agent. Needs can_direct |
| `subtask_start` | Delegates a brief to a child session (above) |

A card or subtask session's wake prompt says which thread it works in. A subtask's prompt adds that its context is only the brief and that only its JSON summary goes back to the parent. `session_wake` and `/start <profile>` act on an agent's channel session only.

## API

| Route | |
|---|---|
| `GET /channels/:id/tasks` | `{ cards, canManage, isOwner }` |
| `POST /channels/:id/tasks` | `{ title, description?, status?, profile?, start? }` → 201 `{ action, card }` |
| `PATCH /channels/:id/tasks/:taskId` | Any of `title`, `description`, `status`, `profile` (`null` unassigns) |
| `DELETE /channels/:id/tasks/:taskId` | 204 |
| `POST /channels/:id/tasks/:taskId/start` | 201 started, 200 resumed or kept |
| `POST /channels/:id/subtasks` | Bots only; body as `subtask_start` (`parentSessionId`, `reportThreadId`, `tokenBudget`) |
| `POST /channels/:id/agent-commands` `{ command: 'end', sessionId }` | Ends one session by ID (card and subtask sessions) |
| `POST /channels/:id/sessions/:sessionId/workspace-commands` `{ action: 'pr_status' }` | Directors; the host answers `{ prState, url? }` |

Socket events in the channel's room: `TaskCardUpdate { channelId, card }`, `TaskCardDelete { channelId, id }`. Sessions now report `threadId`, `parentSessionId` and `title`. Claims carry `session.threadId`, `session.parentSessionId` and `session.scope` (`{ kind: 'task' | 'subtask', title }`), and the inbox reason `delegate` marks a subtask's brief or summary.
