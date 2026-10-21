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
- Before every `up` **and every `down -v`**, `ops_validate` renders the config (all profiles)
  and `validate_compose.py` parses it: the project name; every service is one of postgres, redis,
  migrate, api, web with an allowed image (`agora-ops-server:old|new`, ...), no container_name,
  privileged or host network; every volume resolves to `<project>_…` and is not external; every
  network resolves to exactly `<project>_net`; every mount is a project volume (no bind mounts);
  every published port is the project's own api/web port, bound to 127.0.0.1, never 80, 443,
  3000, 8080, 3200 or 8280. Then no container outside the project may publish those ports.
- Every file the scripts write (env files, manifests, reports, backups, temp copies) must
  resolve inside `e2e/ops/.state/` after symlinks are resolved (`state_path` in `lib.sh`,
  re-checked in `opsapi.py`). There are no path or state-dir override variables.
- `guard-selftest.sh` proves the refusals: paths outside `.state` (including `..` and a symlink
  out), the live API port, and throwaway compose overrides in `.state/selftest/` that name
  `agora_pgdata`, `agora_pgdata_v2`, `agora_data2`, `agora_default`, `agora-e2e_net`, an
  external volume, a bind mount, port 3000, a port on all interfaces, a `runner` service and an
  `agora-e2e` image. The `up`/`down` cases use volume and network names that do not exist on the
  daemon, so even a guard that failed open could not reach a real resource.
- Fake data only (`ops-owner`, `ops-member`). The provider key is a `sk-test-CANARY-…` string and
  its base URL is `http://127.0.0.1:9/v1` inside the API container. The decryption proof requires
  the provider to still be that `openai` one on that URL and its test to answer exactly
  `{"ok": false, "error": "fetch failed (bad port)"}`: only `testConnection` produces that, and
  the route checks the adapter, validates the base URL and decrypts the key before calling it.
  Fetch refuses the port before connecting, so nothing leaves the container.
  `backup-restore.sh` also runs a negative control: with the provider's auth tag zeroed, the
  test must answer exactly `Stored API key could not be decrypted`.
- Secrets, manifests, backups and logs go to `e2e/ops/.state/` (gitignored). Delete it when done.

## Run

From Windows, with a checkout of the previously deployed SHA (e.g. `git worktree add --detach
.claude/worktrees/ops-old 11e998c`):

```bash
W=/mnt/c/path/to/this/checkout
wsl.exe -d Ubuntu --exec bash -c "cd $W && bash e2e/ops/guard-selftest.sh"
wsl.exe -d Ubuntu --exec bash -c "cd $W && OPS_OLD_CONTEXT=$W/../ops-old bash e2e/ops/upgrade.sh"
wsl.exe -d Ubuntu --exec bash -c "cd $W && bash e2e/ops/backup-restore.sh"
wsl.exe -d Ubuntu --exec bash -c "cd $W && bash e2e/ops/maintenance.sh"
wsl.exe -d Ubuntu --exec bash -c "cd $W && bash e2e/ops/down.sh all"
```

Use `wsl.exe --exec`, not `wsl.exe --`: the latter re-parses the command in a login shell and
expands `$vars` early.

| Script | What it does |
|---|---|
| `upgrade.sh` | Builds the old SHA as `agora-ops-server:old`, starts `agora-ops`, seeds, verifies (read-only), rebuilds this checkout as `:new` on the same volumes, then asserts: `schema_migrations` equals the old SHA's migration files before and the candidate's after, exactly the added ones were applied by the upgrade, 060 has one row, a re-run of `migrate` changes nothing (same rows, same `applied_at`), one fingerprint row with the value from before the upgrade, no refusal in the API log, 0 restarts; then `verify.sh` and an approval flow that uses migration 060 |
| `seed.sh` | Through the API: instance setup, 2 users, a channel, 4 messages, 6 files attached to messages, a provider with a fake key, an agent host, 2 profiles, 2 sessions (one live, one ended). Writes `.state/<project>.manifest.json` (ids, sha256 of each downloaded file) |
| `verify.sh` | Logins, messages, attachments, file downloads (sha256), provider config (present, key never returned, decrypts), host, profiles, session states, `/admin/storage`, then a new upload unless `--no-write` |
| `backup-restore.sh` | Backs up `agora-ops` (`pg_dump -Fc`, `pg_dumpall --roles-only`, a tar of the files volume, the env file) and restores three times into a fresh, empty `agora-ops-restore`: the documented procedure (no roles; expected to break, reported, the only mode that tolerates `pg_restore` errors), roles + a different `AGORA_ENCRYPTION_KEY` (must be refused at startup), roles + the right key (`pg_restore` must exit 0 with no errors, table, policy and blob counts must equal the source's, `verify.sh` must pass, then the decrypt negative control). Leaves the last one running |
| `maintenance.sh` | On `agora-ops-restore` only. Key rotation interrupted partway (one file's auth tag is corrupted so the tool stops), re-run, run again; old key refused; new key verifies. Then three blobs are moved back to pre-0.2.0 names and `strip-storage-filenames` is run twice |
| `down.sh` | `down -v` for one ops project, or `all` (both, plus the `agora-ops-*` image tags), after `ops_validate` |
| `guard-selftest.sh` | The negative checks above; needs `agora-ops` to be empty |
