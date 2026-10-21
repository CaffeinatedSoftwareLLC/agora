# Upgrade and backup/restore checks (OP-04, OP-05)

Scripts for the operations rows of [beta-test-plan.md](../../docs/planning/beta-test-plan.md) §3.5:
`OP-04.upgrade`, `OP-05.restore`, `OP-05.wrong-key`, plus `OP-05.key-rotate` and
`OP-04.strip-filenames` from the coverage report. They run inside WSL `Ubuntu` on its existing
Docker daemon, next to the live `agora` stack and the `agora-e2e` project, without touching either.

## Safety

- Only two compose projects: `agora-ops` (api `127.0.0.1:3300`) and `agora-ops-restore`
  (api `127.0.0.1:3400`). `lib.sh` refuses any other name.
- `docker-compose.ops.yml` is self-contained: `postgres`, `redis`, `migrate`, `api` (and `web`
  behind the `web` profile, unused by the checks). No runner, socket-proxy, cap-gateway or caddy.
  Volumes are `<project>_ops-*`, the network is `<project>_net`.
- Before every `up`: no forbidden service, rendered project name matches, no `agora_*` or
  `agora-e2e` volume/network in the rendered config, ports are not the live/e2e ones (80, 443,
  3000, 8080, 3200, 8280) and not published by another container.
- Fake data only (`ops-owner`, `ops-member`). The provider key is a `sk-test-CANARY-…` string and
  its base URL is `http://127.0.0.1:9/v1` inside the API container: the provider test proves the
  key decrypts and then fails locally (`fetch failed (bad port)`), so nothing leaves the container.
- Secrets, manifests, backups and logs go to `e2e/ops/.state/` (gitignored). Delete it when done.

## Run

From Windows, with a checkout of the previously deployed SHA (e.g. `git worktree add --detach
.claude/worktrees/ops-old 11e998c`):

```bash
W=/mnt/c/path/to/this/checkout
wsl.exe -d Ubuntu --exec bash -c "cd $W && OPS_OLD_CONTEXT=$W/../ops-old bash e2e/ops/upgrade.sh"
wsl.exe -d Ubuntu --exec bash -c "cd $W && bash e2e/ops/backup-restore.sh"
wsl.exe -d Ubuntu --exec bash -c "cd $W && bash e2e/ops/maintenance.sh"
wsl.exe -d Ubuntu --exec bash -c "cd $W && bash e2e/ops/down.sh all"
```

Use `wsl.exe --exec`, not `wsl.exe --`: the latter re-parses the command in a login shell and
expands `$vars` early.

| Script | What it does |
|---|---|
| `upgrade.sh` | Builds the old SHA as `agora-ops-server:old`, starts `agora-ops`, seeds, verifies (read-only), rebuilds this checkout as `:new` on the same volumes, then checks `schema_migrations` (each new migration once, a re-run of `migrate` is a no-op), the API log (no fingerprint refusal), `verify.sh`, and an approval flow that uses migration 060 |
| `seed.sh` | Through the API: instance setup, 2 users, a channel, 4 messages, 6 files attached to messages, a provider with a fake key, an agent host, 2 profiles, 2 sessions (one live, one ended). Writes `.state/<project>.manifest.json` (ids, sha256 of each downloaded file) |
| `verify.sh` | Logins, messages, attachments, file downloads (sha256), provider config (present, key never returned, decrypts), host, profiles, session states, `/admin/storage`, then a new upload unless `--no-write` |
| `backup-restore.sh` | Backs up `agora-ops` (`pg_dump -Fc`, `pg_dumpall --roles-only`, a tar of the files volume, the env file) and restores three times into a fresh `agora-ops-restore`: the documented procedure (no roles), roles + a different `AGORA_ENCRYPTION_KEY` (must be refused at startup), roles + the right key (`verify.sh` must pass). Leaves the last one running |
| `maintenance.sh` | On `agora-ops-restore` only. Key rotation interrupted partway (one file's auth tag is corrupted so the tool stops), re-run, run again; old key refused; new key verifies. Then three blobs are moved back to pre-0.2.0 names and `strip-storage-filenames` is run twice |
| `down.sh` | `down -v` for one ops project, or `all` (both, plus the `agora-ops-*` image tags) |
