# GitHub issues

A channel can link to one GitHub repository. A director picks one of its open issues, which becomes a card on the channel's [task board](task-board.md) and goes to an agent like any card. When the card's pull request opens, merges or closes, Agora comments a one-line status on the issue. Migration `074`.

This is deliberately small. Nothing else syncs: no labels, no comment mirroring, no history import, and an issue closed on GitHub doesn't change its card.

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

The comments Agora posts are fixed sentences plus the pull request's link: nothing a person or agent typed goes to GitHub.

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
