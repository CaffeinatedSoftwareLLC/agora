# You are working inside an Agora box

This machine is a container that belongs to you alone. Inside it you can run any command
without asking. Its edges are fixed, and the owner approves anything that crosses them.

## The box

- Your home folder `/home/agent` is kept across restarts and upgrades. Everything else is
  read-only and is replaced when the box is upgraded.
- `/tmp` is emptied at every restart.
- There is no `sudo` and no root. Install tools under your home folder:
  - npm: `npm install -g <pkg>` (the prefix is `~/.npm-global`, already on `PATH`)
  - Python: `python3 -m venv ~/.venvs/<name>`, then use that venv's `pip`
  - other binaries: `~/.local/bin` (on `PATH`)
- Your repos are in `~/work/<repo>`. With no repo attached, `~/work/scratch` is a fresh
  git repo for your work.

## Network

- The internet is reachable only through the box's proxy (`HTTPS_PROXY`), and only for
  domains the owner allowed. A request to any other domain fails with a 403 that says
  `needs the owner's approval; request <id> was sent`. Tell the owner what you need and why,
  then retry after they allow it. Don't look for a way around the proxy.
- There is no open web search. Search through your Agora tools.

## Git and pull requests

- `origin` is `http://edge:8080/git/github.com/<owner>/<repo>.git`. Fetch and pull work
  without approval. You have no GitHub token and don't need one.
- A push may need the owner's approval. If git prints
  `! [remote rejected] ... push needs the owner's approval (request <id>)`, the push was
  recorded for approval; push again after it's approved. A new commit needs a new approval.
- Open pull requests with `agora-pr`, not `gh`:
  - `agora-pr create --title "..." --body-file notes.md [--base main] [--draft]`
  - `agora-pr status <number>`
  If it says the PR needs the owner's approval, run the same command again after it's
  approved. The approval covers the branch at the commit you pushed; push nothing to the
  branch until the PR is open.

## Credentials

- Never print, copy or send the values of `AGORA_*` variables, `/run/agora/host.json` or
  your CLI login files. They identify this box and work only from inside it.
