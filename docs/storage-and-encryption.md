# Storage and Encryption

What Agora stores, where it lives, what is encrypted, and what is not. This page is the reference for the security claims in the [root README](../README.md#security). It was written from the code and checked against a running instance on 2026-10-01.

**Short version**

- Uploaded files are **always** encrypted by Agora (AES-256-GCM) before they are written anywhere. The storage backend only ever holds ciphertext.
- Replacing MinIO with a plain directory (#32) did not change that. Encryption never depended on MinIO.
- Messages, usernames, emails and file *names* are **not** encrypted at rest. Protect the database and the volumes like any other server data.
- Client IP addresses are not stored at all.
- Agora's protection ends where the host's begins: see [What the host must provide](#what-the-host-must-provide).

## Contents

- [Where data lives](#where-data-lives)
- [What is encrypted, and how](#what-is-encrypted-and-how)
- [What is not encrypted](#what-is-not-encrypted)
- [File storage](#file-storage)
- [The MinIO change (#32)](#the-minio-change-32)
- [Upgrading an install that used MinIO](#upgrading-an-install-that-used-minio)
- [Keys](#keys)
- [Rotating the encryption key](#rotating-the-encryption-key)
- [Backups](#backups)
- [Encryption in transit](#encryption-in-transit)
- [What the host must provide](#what-the-host-must-provide)
- [Known gaps](#known-gaps)

## Where data lives

| Data | Location (Docker) | Encrypted at rest by Agora |
|---|---|---|
| Uploaded files, files posted by agent runs, generated audio / images / video | `files-data` volume (`/data/files`), or an S3 bucket | **Yes**, every file |
| File metadata: name, type, size, uploader, channel, per-file IV and auth tag | Postgres (`files`) | No |
| Messages, threads, servers, channels, roles | Postgres (`pgdata` volume) | No |
| Passwords | Postgres | Hashed (Argon2id), not reversible |
| Bot tokens | Postgres | Hashed (Argon2), shown once |
| Sandbox run tokens | Postgres | Hashed (SHA-256), live only while the run does |
| AI provider API keys | Postgres (`ai_providers`) | **Yes** |
| Client IP addresses | **Not stored.** Used in memory for rate limiting only | — |
| Code submitted for sandbox runs | Postgres (`exec_runs`) | No. Pruned after the retention period (default 30 days) |
| Queues, rate limits, loop guard counters | Redis (`redisdata` volume) | No |
| TLS certificates | `caddy_data` volume | Managed by Caddy |

## What is encrypted, and how

All application-level encryption is AES-256-GCM (`src/lib/encryption.ts`, `src/auth/crypto.ts`): authenticated encryption, so a modified or swapped blob fails to decrypt instead of returning garbage.

| What | Key | Details |
|---|---|---|
| **Files** | `AGORA_ENCRYPTION_KEY` | A fresh random 96-bit IV per file. The ciphertext goes to the storage backend; the IV and the 16-byte auth tag go to the `files` row in Postgres. Done in `storeFile()` (`src/lib/file-store.ts`), the single path used by user uploads, sandbox `postFile()`, test reports, audio overviews and generated video. There is no setting that turns it off. |
| **AI provider API keys** | `AGORA_ENCRYPTION_KEY` | Stored as ciphertext + IV + tag. Decrypted only at the moment of a provider call. The config API never returns a key. |

Files are decrypted in the API process when a member with `ViewChannel` on the file's channel requests `GET /files/:fileId`, and streamed back over the request. Agora does not hand out signed or public URLs to stored objects.

## What is not encrypted

Be clear-eyed about this when deciding where to host:

- **Message content and everything else in Postgres** except the items in the table above. Anyone with the database has the conversations.
- **File sizes, and the names of files stored before 0.2.0.** New files are stored as `<channelId>/<fileId>/blob`, so a listing of the volume or bucket shows how many files a channel has and how large each is, but not what they are called. Files stored before 0.2.0 still carry their original name in the path until you run the one-off rename (see [File storage](#file-storage)). File names are always in the `files` table in Postgres.
- **Data in memory and in transit between containers.** Containers talk to each other over the Docker network in plain text.
- **Redis.**

For protection against a stolen disk or a copied volume, add full-disk or volume encryption on the host. Agora's file encryption protects file *contents* from someone who has the storage but not the key; it is not a substitute for host security.

## File storage

`src/lib/storage.ts` defines a three-method store (`put`, `get`, `remove`) with two drivers:

| Driver | Setting | Where blobs go |
|---|---|---|
| **Disk** (default) | `STORAGE_DRIVER=disk`, `STORAGE_DIR` | A directory. In Docker it is the `files-data` volume mounted at `/data/files` in both `api` and `cap-gateway`. In local development it is `data/files` in the repo (gitignored). |
| **S3** | `STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION` | Any S3-compatible service: AWS S3, Cloudflare R2, Backblaze B2, Garage, SeaweedFS, or a MinIO you already run. The bucket is created if missing. |

Properties of the disk driver:

- **Atomic writes.** A blob is written to a temporary name and renamed, so a crash never leaves a half-written file under the real name.
- **Keys can't escape the root.** Empty segments, `.`, `..`, backslashes and NUL bytes are rejected.
- **Tidy deletes.** Removing a blob also removes its now-empty per-file and per-channel directories.

**Storage names.** A file is stored as `<channelId>/<fileId>/blob`; after a key rotation the last part becomes `blob-<8 hex characters>`. The original file name is not part of the path. Installs that stored files before 0.2.0 can rename the old blobs once, with the API and cap-gateway stopped (the blobs stay encrypted; it is safe to re-run):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps api node dist/src/tools/strip-storage-filenames.js
```

**Who owns the files.** The backend containers run as the image's unprivileged `node` user (uid 1000), not root. A one-shot `files-perms` service hands an older, root-owned `files-data` volume over to that user on the first start after upgrading, and does nothing afterwards.

With the S3 driver the provider sees ciphertext only, plus object names and sizes. No provider-side encryption setting is required or assumed.

Limits (size, allowed extensions, retention, quota, EXIF stripping) live in the `instance_settings` table and are set from **Admin → Storage**. They apply the same way to both drivers. A background worker (`src/workers/file-cleanup.ts`) deletes expired files, orphaned uploads and old soft-deleted rows every hour.

### Two services share the volume

`api` serves uploads and downloads. `cap-gateway` stores files posted by sandbox runs. Both mount `files-data` and both hold `AGORA_ENCRYPTION_KEY`, exactly as both held the MinIO credentials before. **Sandbox containers never mount the volume**: the socket proxy rejects bind mounts, and a run can only add a file by calling the gateway with its run token.

## The MinIO change (#32)

MinIO stopped publishing images that can be pulled anonymously, so `docker compose up` failed on fresh installs. Agora only ever used three operations on whole encrypted blobs, so the bundled object server was removed rather than replaced with another one.

| | Before (#32) | Now |
|---|---|---|
| Blob location | `minio-data` volume, behind the MinIO service | `files-data` volume, a plain directory |
| Access control to blobs | MinIO root user and password over the Docker network | Filesystem access to the volume |
| Secrets to manage | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | None for storage |
| Encryption of file contents | AES-256-GCM in Agora before upload | **Unchanged** |
| File names visible in storage | Yes (object keys) | No for new files (0.2.0); older files until renamed |
| A blob that is missing | The row was soft-deleted on first access | A plain 404; the row is kept, so a file opened before the migration isn't lost |
| Services in the stack | one more (`minio`) | one fewer |

What did not change: the encryption algorithm, the key, the per-file IV and tag, the `files` table, the storage keys, the upload validation pipeline, the admin limits. Existing files keep working after their blobs are copied across, because the ciphertext is copied byte for byte and the IV and tag stay in Postgres.

What you give up: an S3 API in front of the bundled store, and MinIO's own access layer. If you want those, run any S3-compatible service and set `STORAGE_DRIVER=s3`.

## Upgrading an install that used MinIO

New installs skip this. For an install that stored files in the bundled MinIO, copy the blobs to the volume **once, before starting the new stack**. You need the MinIO image still present on the machine (it can no longer be pulled) and `MINIO_ROOT_PASSWORD` still in `.env.prod`.

```bash
# 1. Copy every live blob from MinIO to the files-data volume
docker compose -f docker-compose.prod.yml -f docker-compose.minio-migrate.yml --env-file .env.prod run --rm storage-migrate

# 2. Remove the MinIO container
docker compose -f docker-compose.prod.yml -f docker-compose.minio-migrate.yml --env-file .env.prod rm -sf minio

# 3. Start the stack as usual
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

The tool prints how many blobs it copied, how many were already present and which were missing from MinIO. It is safe to re-run. It needs no encryption key: blobs are copied as ciphertext.

Once files open in the app, remove the old volume and the old settings:

```bash
docker volume rm <project>_minio-data
```

Then delete the `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` lines from `.env.prod`. While they remain, they are harmless: they are only read as fallbacks for `S3_ACCESS_KEY` / `S3_SECRET_KEY` when `STORAGE_DRIVER=s3`.

If the MinIO image is gone from the machine, set `MINIO_IMAGE` to any image you can still obtain, or run the tool outside Docker against any S3 endpoint that can serve the old data: `npm run storage:migrate-from-s3` with `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `STORAGE_DIR` set.

## Keys

| Variable | Protects | Format | Generated by `setup-env.js --prod` |
|---|---|---|---|
| `AGORA_ENCRYPTION_KEY` | Files and AI provider API keys | 64 hex characters (32 bytes) | Yes |
| `JWT_SECRET` | Login sessions | any string | Yes |
| `DB_PASSWORD` | Postgres | any string | Yes |

Generate a key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- **Losing `AGORA_ENCRYPTION_KEY` loses every file and every stored provider key.** There is no recovery path. Keep a copy outside the server.
- **The server will not start with a different key.** On first start it stores a fingerprint of `AGORA_ENCRYPTION_KEY` in the database (an HMAC of a fixed label: it identifies the key without revealing it). On every later start, the API and the capability gateway compare, and stop with a message if the key differs. An instance that predates this check records the current key on its next start, after confirming it can decrypt a stored provider key if there is one.
  - In Docker the container then restarts in a loop; `docker logs agora-api-1` shows `AGORA_ENCRYPTION_KEY does not match the key this instance was set up with`.
  - The fix is to restore the original key in `.env.prod`.
  - If the original key is gone for good, start once with `AGORA_ACCEPT_NEW_ENCRYPTION_KEY=1` in `.env.prod`, then remove it. This only records the new key: files and provider keys written under the old one stay unreadable.
- **In production the server also refuses** a missing or all-zero `AGORA_ENCRYPTION_KEY` and a placeholder `JWT_SECRET`. The Docker image runs in production mode.
- **Rotating the key** re-encrypts every file and every stored provider key. See [Rotating the encryption key](#rotating-the-encryption-key).
- Keys live in `.env.prod` on the host and in the environment of the `api`, `runner` and `cap-gateway` containers. Sandbox containers receive no keys: only the gateway's address, a per-run token and the run's own code.

## Rotating the encryption key

Do this when the key may have been exposed, or on a schedule if your policy asks for one.

1. Back up the database, the file store and `.env.prod` ([Backups](#backups)).
2. Generate the new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Stop the services that use the key, and run the tool with the current key still in `.env.prod`:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod stop api cap-gateway runner
   docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps \
     -e AGORA_NEW_ENCRYPTION_KEY=<new key> api node dist/src/tools/rotate-encryption-key.js
   ```
4. When it reports success, put the new key in `AGORA_ENCRYPTION_KEY` in `.env.prod` and start the stack. Keep the old key until you have opened a few files.

What it does: each file is decrypted with the current key, encrypted with the new one, written under a new storage name, and only then is its row updated and the old blob deleted. Provider keys and the key fingerprint switch together at the end, in one transaction. If the run is interrupted, run it again with the same two keys; it skips the files it already did. Until it finishes, the instance still belongs to the old key. After it finishes, the server refuses to start with the old key.

Outside Docker: `AGORA_NEW_ENCRYPTION_KEY=<new key> npm run key:rotate`.

## Backups

A restorable backup is three things taken together:

1. **Postgres** (`pgdata`): all data, plus the IV and auth tag for every file.
2. **The file store** (`files-data`, or your bucket): the ciphertext.
3. **`.env.prod`**: the keys.

Any two without the third cannot restore files. Agora ships no backup tool; use `pg_dump` and a copy of the volume, taken close together.

## Encryption in transit

- **Browsers and remote agents** connect through Caddy on 443. Caddy obtains and renews certificates automatically for a real domain, and uses its own local certificate authority for `localhost`.
- **The API also listens in plain HTTP on port 3000**, for agents on the same machine (Node rejects Caddy's local certificate, see #22). On this branch that port is published on `127.0.0.1` only; set `API_BIND=0.0.0.0` in `.env.prod` to publish it on the network, unencrypted. *This binding has not been tested on a live stack yet.* Before it, the port was open on all interfaces.
- **Between containers**, traffic is plain text on Docker's internal networks. `postgres` and `redis` publish no ports.
- **Outbound provider calls** use HTTPS for the built-in Anthropic, OpenAI, Gemini and Tavily endpoints. A custom provider base URL may be `http://` (a local Ollama, for example); that traffic is then unencrypted. Private and loopback addresses are refused unless the instance setting that allows private base URLs is on.

## What the host must provide

Agora's part is narrow: keep stored files unreadable without the key, enforce who can see what, and contain agent code. Anyone who controls the machine controls the keys, the database and the Docker daemon, so none of that holds against them. The rest is the host's job:

- **Disk or volume encryption.** Messages and the rest of the database are stored in the clear, and `.env.prod` sits next to the data it protects. Without disk encryption, a stolen disk or a copied VM image gives up everything, including the file key.
- **A firewall that exposes only 80 and 443.** Postgres and Redis publish no ports, and the API's port 3000 is bound to `127.0.0.1`; keep it that way.
- **Tight access to `.env.prod` and the Docker volumes.** `chmod 600 .env.prod`. Anyone who can read it can decrypt every file and sign a login token for any account.
- **Tight access to the Docker socket.** Membership of the `docker` group is root on the host. The sandbox's socket proxy narrows what the *runner* may ask Docker to do; it does nothing about other users on the machine.
- **One trusted OS user, or real separation.** Agents running as the same OS user can read each other's local configuration, including bot tokens (#39). Agora cannot fence off processes that share a user account.
- **Backups, stored somewhere else**, with the key kept apart from the data it unlocks.
- **Patching.** Docker, gVisor (`runsc`) and the host kernel. The sandbox's strength is gVisor's.
- **TLS for anything off the machine.** Use the bundled Caddy; do not publish port 3000.

## Known gaps

Found in the 2026-10-01 audit. None was introduced by the MinIO change. Tracked in [`planning/HANDOFF.md`](planning/HANDOFF.md).

Earlier gaps, now closed: file names in storage paths (new files), backend containers running as root, and the missing key rotation tool were all addressed in 0.2.0. Production running with a default IP key was closed by removing IP tracking and IP bans altogether (migration `031`): there is no stored IP left to protect and no `IP_ENCRYPTION_KEY`. The production startup check not running in Docker was closed by setting `NODE_ENV=production` in the image and adding the key fingerprint check described under [Keys](#keys).

1. **No built-in backup.** See [Backups](#backups) for what to copy.
2. **Files stored before 0.2.0 keep their name in the storage path** until the one-off rename is run (see [File storage](#file-storage)).
