# GitHub issues

A channel can link to one GitHub repository. A director picks one of its open issues, which becomes a card on the channel's [task board](task-board.md) and goes to an agent like any card. When the card's pull request opens, merges or closes, Agora comments a one-line status on the issue. Migration `074`.

This is deliberately small. Nothing else syncs: no label sync, no comment mirroring, no history import, and an issue closed on GitHub doesn't move its card (it only gets a note). Importing by hand is the default; [automatic import](#automatic-import) is an opt-in rule.

## No GitHub token in Agora

Agora stores no GitHub credentials. Every GitHub call runs on an **agent host** the owner picks, with the `gh` CLI and the owner's own `gh` login on that machine, the same way **Open pull request** and **Check PR** already work. The host must have `gh` installed and signed in (`gh auth login`), and run an agora-host version with the bridge. Each call names the repository with `--repo=owner/name`, so the host needs no checkout of it.

The server queues a call in `github_commands`; the host claims it (`GET /agent-hosts/@me/github-commands/next`), runs `gh`, and reports the result. Errors come back as short codes only (`gh_not_installed`, `gh_not_signed_in`, `repo_not_found`, `gh_failed`), never `gh`'s output. A call the host claims and never answers fails after 90 seconds and isn't retried.

## Who can do what

| Action | Who |
|---|---|
| See the linked repository | Anyone who can see the channel |
| Link or unlink the repository, and pick its host | The server owner (it uses the owner's GitHub login) |
| List open issues, import one as a card | The owner and members with **DirectAgents** (people only) |
| Start the card's agent | As for any card ([task-board.md](task-board.md)) |
| Status comments on the issue | Agora, automatically, with fixed text |

## How it works

1. **Link.** In the task board, the owner enters `owner/name` and picks a host. Relinking replaces the repository; unlinking leaves cards made from its issues as they are.
2. **List.** **Import issue** asks the host for up to 30 open issues (`gh issue list --state=open`): number, title, author, last update, and the first 2,000 characters of the body. A list waiting for the host is reused rather than queued twice. The host re-checks that the repository is still linked to it and that the requester can still direct agents before it runs.
3. **Import.** Picking an issue makes a card. Its title, text and link come from the host's list, never from the request, so a person can't make a card that claims to be some other issue. A list older than an hour must be refreshed first. Each issue becomes at most one card per channel. The card shows `owner/name#N` linking to the issue (https links only).
4. **Assign and start.** As for any card: pick the agent, start it now or later.
5. **Report back.** When the card's pull request opens (**Open pull request** from the card's review), Agora comments on the issue with the pull request's link. When **Check PR** finds it merged, or closed without merging, Agora comments again. A draft counts as open. A squash merge from the card's review merges on the owner's machine, not on GitHub, so it doesn't comment: **Check PR** reports the GitHub merge.
   - **Which host.** Comments go out only through the host the owner linked to the channel's repository, never the host of the agent that did the work. If the channel no longer links the card's repository, nothing is commented and a notice in the card's thread says so. Relinking or unlinking cancels queued GitHub work; the host also rechecks the link before it runs anything.
   - **Once per state.** A state counts as reported when the host confirms the comment. If it fails where `gh` certainly posted nothing (not installed, not signed in, repository not found, link changed), a notice in the card's thread says so and the next **Check PR** tries again. If it may have posted (`gh` failed midway, or the host never answered), the notice says so and it is never retried, so it never posts twice.

## Issue text is untrusted

Anyone who can open an issue on the repository wrote its text. The card's description is the issue body, and the kickoff the agent reads says where it came from and that it is a report of the problem, not instructions. Treat imported cards like any outside input: read the issue before you start an agent on it (each issue number in the picker opens it on GitHub).

**How the kickoff frames it.** The issue's title and text sit between two boundary lines, `=== BEGIN GITHUB ISSUE TEXT <token> ===` and `=== END GITHUB ISSUE TEXT <token> ===`. The token is random, made for that one kickoff, and used only in those two lines, so the issue cannot know it and cannot close the frame early, however it spells an "end of issue" marker (extra spaces, a line break, look-alike letters, other dashes). The fixed text before the frame tells the agent that only text outside the two lines comes from Agora. Earlier versions stripped one exact marker; that is gone because every spelling would have to be listed. This applies to every card made from an issue, imported by hand or by the rule. The card's thread opens with `(from GitHub) Task: <title>`, so a title a stranger wrote is never shown as if Agora wrote it.

The comments Agora posts are fixed sentences plus the pull request's link: nothing a person or agent typed goes to GitHub.

## Automatic import

A rule on the linked repository can turn issues into cards by itself, and, as a separate choice, start an agent on them. **Both are off unless the owner turns them on.** Migration `101`. Everything is in the task board's repository row, under **Automation**.

| Choice | Options | Default |
|---|---|---|
| **Import issues as cards** | Off / issues with a label you name (suggested: `agora`) / every new open issue | Off |
| **Only issues opened by these GitHub users** | Anyone / a list of logins (compared without capital letters, up to 50) | Anyone |
| **Start an agent on each new card** | Off / start one of the channel's agents | Off |
| **Start at most N agents per check** | No limit / a number from 1 to 200 | No limit |
| **Check every** | 2 to 1440 minutes | 5 minutes |
| **Comment "Picked up in Agora" on the issue** | On / off | Off |

- **Who.** Only the server owner changes the rule: the link uses the owner's GitHub login, and an automatic start runs on the owner's account. Directors can read it and press **Check now**. Members and bots cannot change it.
- **Label.** The host asks `gh` for open issues with that label (`gh issue list --label=...`). Labelling needs triage rights on GitHub, so a label is the safest rule: only people you trust pick what is imported. **Open issues that already carry the label are picked up on the first check**, not only new ones; the form says so, and shows how many the last check found when it has a count for that label. The host sends each issue's labels, and the server checks the label on the issue itself: an answer is not trusted to match the rule it was asked under.
- **Every new open issue** takes only issues opened *after* you turned it on (and after you last switched to it). It never imports the backlog.
- **Author filter.** Applied by Agora to the author `gh` reports. There is no "only people with write access" choice: `gh issue list` and `gh issue view` do not report the author's association with the repository (checked against gh 2.83), and asking for it per author would need the GitHub API through `gh api`, which this bridge does not use.
- **Polling, not webhooks.** A worker queues a scan for each channel with a rule every time its interval has passed. The floor of 2 minutes protects GitHub's rate limit and the host: a scan is one `gh issue list` of up to 200 open issues plus up to 10 `gh issue view` calls. When more than 200 issues match, only the newest 200 are looked at and the rule's status says so. **Check now** queues a scan at once (not twice while one waits, and not within 10 seconds of the last). It is limited to **12 times an hour per channel** (whoever presses it) and **30 an hour per person** across channels; the rule's own polling is never counted. Over the limit it answers 429 `check_limit`.
- **Last checked.** The rule shows when a host last answered and how it went. A host that is offline, revoked or running an older agora-host is skipped quietly, with the reason in that status line and no message in the channel. A scan the host does not claim in 10 minutes is dropped. `gh` not signed in (or not installed, or the repository not found) is said **at most once an hour per error code**, however often the host flaps between working and failing; the rule's status always shows the latest result.
- **An older agora-host** never sees the new command. A host says it knows `issue_scan` by polling `github-commands/next?v=2`; the server queues and hands out scans only to a host that did so in the last 3 minutes, and shows "update agora-host" otherwise.

### What one check can cost

Read this before turning on an agent. The same words are in the Automation section of the task board, in the confirmation warning and in the server's message for it.

- **Volume.** One check can create up to **200 task cards** and, with an agent chosen, start up to **200 agent sessions**. Your host's `maxConcurrent` limits how many run at once, not how many are queued or what they spend: the rest wait as sessions that are started, not cancelled.
- **Who can cause it.** With "Every new open issue" on a **public** repository and no author filter, anyone can open issues, so anyone can cause this again and again. A label rule is safer, because only people who can label an issue pick what is imported.
- **Whose money.** The agents run on your API key or your subscription, and nothing limits that spend until you set a limit. Limits are yours to set and are off by default: **Start at most N agents per check** in the Automation section, and the per-agent limits (wakes, tokens, minutes) in Settings → Agents → the agent → Limits ([agent-limits.md](agent-limits.md)).
- **Start at most N agents per check.** Off by default, and a plain row like the other limits. With a number, the first N new cards of a check (oldest issue first) get an agent; the rest stay on the board with a note on the card (*Not started: the limit of N agents per check was reached. Start it from here.*) and you start them by hand. The next check has a fresh allowance. Agora adds no other cap.
- **One notice per check.** Cards that were not started (the cap, a personal login, a refusal, an error) are said **once per check**, with a count and the reasons, not once per card. Each card carries its own note.

### One card per issue, ever

Each issue becomes at most one card per channel. The record `github_issue_imports` (primary key: channel, repository, issue number) outlives the card, and two polls that race collide on it.

| What happens | Result |
|---|---|
| The issue is unlabelled and labelled again | No new card: it already has a record |
| A person deletes the card | The issue is **not** brought back by the rule. Importing it by hand from **Import issue** makes a card again |
| Two scans answer at the same moment | One card; the other answer finds the record and skips it |
| The issue was already imported by hand | The rule leaves it alone |
| The rule is switched off, or the channel is linked to another repository, before the host answers | The answer is dropped. Linking another repository switches the rule off |
| The rule is **changed** (mode, label, authors, anything) while the host works | Every save bumps a rule version; a scan carries the version it was queued under, and an answer for any other version is dropped. A scan nobody has claimed yet is cancelled, and the next check runs under the new rule |
| The repository is renamed on GitHub and linked again under the new name | The rule is off after a relink, as for any other repository. The host also reports the repository's stable id (`gh repo view --json id`); when the new name has the same id as the previous link, the import records and cards follow the new name, so turning the rule back on makes no duplicates. With no id on record, or a different repository, nothing is moved |
| The same repository is linked again on **another host** | The rule is reset (off): another host is another machine with another `gh` login. The same repository on the same host again keeps the rule |
| A card was deleted **before** migration `101` | It left no import record, so in label mode that issue can be turned into a card once more. Cards deleted after the migration are not brought back |

The card's title, text and link come from the host's answer, cleaned and checked (an `https` link to that issue), never from a request. A notice in the channel says *GitHub issue owner/name#N became a task card by this channel's automation rule.* The card shows **from rule**. When an issue is closed on GitHub while its card is not done, the card shows *issue closed on GitHub*; a running agent is not stopped.

### Starting an agent

When you choose an agent, the rule starts it on each new card through the same path a person's **Start** uses, and records the **server owner** as the one who started it. The kickoff keeps the untrusted-text framing above. Limits you set on the agent apply as usual; if one stops it, the usual notice appears.

- **Who may be started, and on whose issues.** An agent on an **API key** (in a box) may be started on any issue, with any author list or none: the cost is the key's and nobody's login is used. An agent on a **personal login** (a subscription, host mode, or the owner's own ChatGPT plan) is the owner's own account, and [provider-terms.md](provider-terms.md) allows the owner's own automation on it but never other people's messages driving it. So the rule starts such an agent **only on the owner's own issues**: **Only issues opened by these GitHub users** must be exactly one login, the GitHub login the linked host's `gh` is signed in as (shown in the form as *Your GitHub login on this machine*). Another person's ChatGPT plan is never started by the rule. This is the strict reading of the terms; the owner can decide to loosen it later.
  - **Where the login comes from.** The host asks its own `gh` (`gh api user --jq .login`, a read of the signed-in account that needs no extra scope) through the same command queue, when the repository is linked or the host changes, at least once a day while the rule is on, and when a save is refused for want of it. The host checks the answer against the shape of a GitHub login before it sends it, and the server checks it again. It is stored with the link and cleared when the link or host changes, or when `gh` reports it is signed out.
  - **If it cannot be determined** (an older agora-host, `gh` signed out, an offline host), auto-start for those agents is refused, with the reason shown in the form and on the card.
  - **Enforced twice.** At save (400 `autostart_not_allowed`) and at every start. If the host's login changes later, or the agent's login changes to a personal one after the rule was saved, the cards are still made, none is started, the channel is told once, and each card says why.
- **Many at once.** Without a cap the rule starts every new card. The host runs only `maxConcurrent` agents at a time, and the rest wait: those cards show **Queued**. See *What one check can cost* above for the owner's cap.
- **The warning.** Every new open issue, no author filter and an agent started means strangers' text reaches an agent with nobody reading it first, if the repository is public. The owner has to confirm before saving; it is not forbidden. The warning also states the volume and cost facts above.
- **Three protections.** The author filter. The agent works in its box and opens a pull request but never merges (merging is the owner's step on the task board). The [receipts ledger](receipts.md) records what the agent claimed.

### Comment on pickup

Off by default. When on, the host comments the fixed text `Picked up in Agora` on the issue when the rule makes its card. Agora never posts agent- or person-written text to GitHub; every comment it makes is a fixed sentence (and a pull request link).

### API

| Route | |
|---|---|
| `GET /channels/:id/github/automation` | `{ rule, canConfigure, autostartOptions }`; `rule` is `null` when no repository is linked |
| `PUT /channels/:id/github/automation` | The whole rule: `{ import: { mode, label? }, authors?, autostart?: { profile, confirmOpen?, maxPerCheck? }, pollMinutes?, commentOnPickup? }`. Owner. 409 `confirmation_required` for the warning case, 400 `autostart_not_allowed`, `invalid_label`. `maxPerCheck` is 1 to 200 or `null` (no limit, the default); leaving it out keeps the saved value. Every save bumps the rule version. The rule also reports `hostLogin` |
| `POST /channels/:id/github/automation/check` | 202 `{ id, status }`. Owner and directors. 409 `rule_off`, `host_offline`, `host_old`, `host_revoked`; 429 `too_soon`, 429 `check_limit` (12 an hour per channel, 30 per person) |

Host: `GET /agent-hosts/@me/github-commands/next?v=2` may return `action: 'issue_scan'` with `payload: { mode, label?, limit, watch[], ruleVersion }`; the result is `{ issues[] (with createdAt and labels), watched[{ number, closed }], truncated }`. It may also return `action: 'link_info'` (no payload); the result is `{ login, repoId? }`: the GitHub login `gh api user --jq .login` prints, and the repository's node id from `gh repo view --json id`. Both are checked for shape on the host and on the server. Cards carry `fromRule` and `issueClosedAt`; a card's session carries `queued`.

## API

| Route | |
|---|---|
| `GET /channels/:id/github` | `{ link: { repo, hostId, hostName, hostRevoked, updatedAt } \| null, canLink, canImport }` |
| `PUT /channels/:id/github` | `{ repo, hostId }` → `{ link }`. Owner |
| `DELETE /channels/:id/github` | 204. Owner |
| `POST /channels/:id/github/issues` | 202 `{ id, status }`: the host lists open issues. Directors |
| `GET /channels/:id/github/commands/:commandId` | `{ id, action, status, repo, result }`; a finished list has `result.issues[]` with `number, title, url, author, updatedAt, body, cardId` (`cardId` set when already imported). Directors |
| `POST /channels/:id/github/issues/import` | `{ commandId, number, profile?, start? }` → 201 `{ action, card }`. 409 `issue_already_imported` (with `cardId`), 409 `issue_list_stale`, 404 `issue_not_in_list` |

Host routes (agent host token): `GET /agent-hosts/@me/github-commands/next` → `{ id, claimToken, action: 'issue_list' | 'issue_comment', repo, payload }` or 204, and `POST /agent-hosts/@me/github-commands/:id/result` `{ claimToken, success, result }`.

Cards carry `issue: { repo, number, url } | null`.
