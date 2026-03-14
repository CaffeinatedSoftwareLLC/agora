# Agora Alpha Test

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

For Developers: There is an MCP ReadMe located in agora-mcp for multi agent orchestration.

Disclaimer: This repo was made with the help of Claude, this Read Me was also generated after this disclaimer, but read over a dozen times and refined by hand. I understand programming fundamentals and have some professional training and experience in the field, however data science and project management are my true bread and butter. I have made significant efforts to ensure safety, which you will see throughout the repo. With the help of the community, I hope to make this the most robust self-hosted "chat" platform available.

Agora is a self-hosted, Discord-like chat platform built with Fastify, PostgreSQL, and React. It supports servers, channels, direct messages, real-time messaging via Socket.IO, role-based permissions, and row-level security at the database layer.

## What Works Right Now

This is an early alpha — the foundation is solid but the feature set is slim:

- **Text chat** — send, edit, and delete messages in channels with real-time updates, markdown rendering
- **Threads** — reply chains on messages, active threads bar, close/reopen with moderation permissions
- **Direct messages** — 1-on-1 conversations between users
- **Agent Orchestration** - connect any Agent CLI that uses MCP protocol to Agora, allowing them to collaborate as a team. Particularly useful for planning and reviewing. This feature is used to build agora. It is ***highly*** recommended you use the skills provided in this repo.
- **Voice channels** — join, mute/unmute, video, screen share, deafen, device selector (via LiveKit)
- **Full HD Streaming** - share yhour screen within a voice channel.
- **DM voice/video calls** — ring/accept/decline flow for 1-on-1 calls, this needs some serious UX work
- **File sharing** — upload and download files with inline image previews, drag-and-drop, paste-to-upload, UI management to provide granular control on accepted file types.
- **Servers & channels** — create text/voice channels, invite users via shareable codes
- **Presence** — online/offline indicators and typing notifications
- **Mentions** — @mention users and bots with autocomplete
- **Reactions** — emoji reactions on messages
- **Unread tracking** — badge counts on channels and DMs
- **Admin panel** — user management, storage settings, registration approval
- **Server settings** — bot management, channel loop guard configuration, moderation tools
- **Bot / agent infrastructure** — create bots with API tokens, avatars, @mention-based coordination, per-channel loop guard, rate limiting
- **AI agent connectivity** — MCP server (`agora-mcp`) lets Claude Code, Codex, Gemini CLI, and other agents chat through Agora channels
- **Two color themes** — Aegean and Terracotta

**Voice chat warning:** Voice channels may not work for users outside your local network if you're hosting from home. WebRTC requires peers to discover each other's IP addresses via a TURN server, and most home networks sit behind NAT/firewalls that block this. For reliable voice chat with remote users, it is strongly recommended to deploy Agora on a VPS with a public IP. I will be looking into options like TailScale in the near future.

**Not yet implemented:** search, message pinning, notifications, roles/permissions UI, group DMs, and more; the search and notifications visible in the UI are just placeholders.

## Roadmap

Roughly in priority order. No ETAs — this is a community project, not a product launch.

- [x] Voice channel participant visibility (see who's in a room without joining)
- [x] Bot / agent infrastructure (tokens, channel access, rate limiting, loop guard)
- [x] AI agent connectivity (MCP server for Claude Code, Codex, Gemini CLI)
- [x] Message threads (reply chains, close/reopen, moderation)
- [x] Server settings UI (bot management, channel config, moderation)
- [x] Markdown rendering in messages
- [ ] Roles and permissions UI (backend already supports this)
- [ ] Message pinning
- [ ] Search (messages, users, channels)
- [ ] Notifications (desktop + in-app)
- [ ] Group DMs
- [ ] Custom emoji
- [ ] Mobile-friendly / responsive UI
- [ ] E2E encryption (stretch goal)

Want to help? Pick something off the list and open a PR. Contributions are welcome.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend framework | Fastify 5 |
| Database | PostgreSQL 16 |
| Cache / pub-sub | Redis 7 |
| Object storage | MinIO (S3-compatible) |
| Auth | Argon2 password hashing, JWT tokens |
| Real-time | Socket.IO 4 (WebSocket-only, no polling) |
| Voice / video | LiveKit |
| AI agent connectivity | agora-mcp (MCP server) |
| IDs | ULID (26-char, chronologically sortable) |
| Frontend framework | React 19 |
| Build tool | Vite 7 |
| CSS | Tailwind CSS v4 |
| State management | Zustand 5 |
| Routing | React Router 7 |
| Testing | Vitest (backend + frontend), Supertest, Testing Library |
| Language | TypeScript throughout |

## Prerequisites

- **Docker** and **Docker Compose**
- **Git**
- **Node.js 20+** (only needed for local development)

## Production Deployment (Docker)

The entire stack runs in Docker. One command builds and starts everything.

### 1. Clone and configure secrets

```bash
git clone <repo-url> agora
cd agora
cp .env.prod.example .env.prod
```

Edit `.env.prod` and set the required values:

| Variable | How to generate |
|---|---|
| `DB_PASSWORD` | Any strong password |
| `JWT_SECRET` | `openssl rand -base64 32` |
| `MINIO_ROOT_PASSWORD` | Any strong password |
| `AGORA_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `LIVEKIT_API_KEY` | Must match `livekit.prod.yaml` (see voice setup below) |
| `LIVEKIT_API_SECRET` | Must match `livekit.prod.yaml` (see voice setup below) |
| `CORS_ORIGIN` | Your domain (e.g., `https://chat.example.com`) |

### Voice chat setup (LiveKit)

Voice channels require [LiveKit](https://livekit.io/). The prod Docker stack includes a LiveKit container that reads its config from `livekit.prod.yaml` in the project root.

1. Generate an API key and secret:

```bash
# Key (short identifier)
openssl rand -hex 16

# Secret (long random string)
openssl rand -hex 32
```

2. Put them in `livekit.prod.yaml`:

```yaml
keys:
  your-api-key: your-api-secret
```

3. Set the **same values** in `.env.prod`:

```
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

If you skip this, everything else works — voice channels will just return a "not configured" error.

### 2. Build and start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

This starts eight services:
- **postgres** — PostgreSQL 16 with persistent volume
- **redis** — Redis 7 with AOF persistence
- **minio** — S3-compatible object storage for file uploads
- **livekit** — WebRTC media server for voice/video
- **migrate** — Runs database migrations once, then exits
- **api** — Backend on port 3000 (internal only)
- **web** — nginx (serves frontend + reverse proxies API/WebSocket, internal only)
- **caddy** — Reverse proxy on ports 80/443 with automatic Let's Encrypt TLS

### 3. Verify

```bash
curl https://your-domain.com/health
```

Open **https://your-domain.com** in your browser — you should see the setup wizard. Caddy auto-provisions a Let's Encrypt certificate, so HTTPS works immediately (make sure DNS points to your server first).

The setup token is printed in the API logs:

```bash
docker logs agora-api-1 2>&1 | grep -A 2 "SETUP TOKEN"
```

This prints the token block:

```
  AGORA SETUP TOKEN (use this to complete initial setup):
  <your-token-here>
```

Copy the hex string and paste it into the setup wizard.

### 4. DNS

Point your domain (e.g., `alpha.agora.host`) to your server's IP address. Caddy handles TLS certificate provisioning automatically — no manual cert setup or renewal needed.

The domain is configured in the `Caddyfile` at the project root.

### Architecture

```
Internet → Caddy (ports 80/443, auto TLS)
              └── nginx (web container)
                    ├── static files (React SPA)
                    ├── /auth, /servers, /channels, /files, etc. → api:3000
                    └── /socket.io (WebSocket) → api:3000
           postgres:5432, redis:6379, minio:9000 (internal only)
```

### Stopping and resetting

```bash
# Stop the stack (preserves data)
docker compose -f docker-compose.prod.yml --env-file .env.prod down

# Stop and destroy all data (fresh start)
docker compose -f docker-compose.prod.yml --env-file .env.prod down -v
```

## Local Development Setup

For contributing or running locally without Docker for the app layer.

### 1. Install dependencies

```bash
npm install
cd agora-ui && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Defaults work out of the box for local development.

### 3. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL, Redis, MinIO, and LiveKit. Wait for healthy status:

```bash
docker compose ps
```

### 4. Run migrations

```bash
npm run migrate
```

### 5. Start backend and frontend

In two separate terminals:

```bash
npm run dev                    # Backend on http://localhost:3000
```

```bash
cd agora-ui && npm run dev     # Frontend on http://localhost:5173
```

Open **http://localhost:5173** — the setup wizard appears on first run.

## First-Time Instance Setup

Agora requires a one-time setup to create the first admin account. This is secured by a **setup token**.

### Where the setup token comes from

The setup token is resolved in this priority order:

1. **`AGORA_SETUP_TOKEN` environment variable** -- if set in `.env`, this value is used directly.
2. **`.agora/setup-token` file** -- if the file exists in the project root (or `AGORA_DATA_DIR`), the token is read from it.
3. **Auto-generated** -- if neither of the above exist, a random 64-character hex token is generated on first boot. The server prints it to the console:

```
============================================================
  AGORA SETUP TOKEN (use this to complete initial setup):
  <your-token-here>
============================================================
```

The auto-generated token is saved to `.agora/setup-token` so it persists across restarts. If the file cannot be written (for example, a read-only filesystem), the token still works for the current process but will not survive restart; set `AGORA_SETUP_TOKEN` for a stable token.

### Completing setup

Complete setup through the frontend UI, or directly via the API:

```bash
curl -X POST http://localhost:3000/instance/setup \
  -H "Content-Type: application/json" \
  -d '{
    "setupToken": "<your-token>",
    "username": "admin",
    "email": "admin@example.com",
    "password": "your-secure-password",
    "instanceName": "My Agora",
    "registrationPolicy": "open"
  }'
```

**Required fields:**
- `setupToken` -- the token from the console output or env var
- `username` -- admin account username (1-32 characters)
- `email` -- admin account email
- `password` -- admin account password (minimum 8 characters)

**Optional fields:**
- `instanceName` -- display name for the instance (defaults to "Agora")
- `registrationPolicy` -- one of `open`, `invite_only`, or `approval` (defaults to `open`)

Setup can only be run once. Subsequent calls return `409 instance_already_initialized`.

## File Sharing

Agora uses MinIO (S3-compatible object storage) for file uploads. Files are validated by magic bytes, not just extension, and can optionally be encrypted at rest.

### Admin-configurable settings

All file limits are managed from the **Admin Panel > Storage** page (or via `PATCH /admin/settings/files`):

- **Max file size** — enforced per-upload (default: 25 MB, no hard cap)
- **Allowed extensions** — whitelist of permitted file types
- **Retention period** — auto-delete files after N days (off by default)
- **Storage quota** — total storage cap across all files (off by default)
- **EXIF stripping** — remove metadata from uploaded images (on by default)

There are no hardcoded limits outside the database — the admin setting is the sole authority.

### How it works

- Files are uploaded via multipart POST to `/files/upload`
- Magic-byte validation ensures file content matches the declared type
- Inline-safe types (images, audio, video, PDF) get signed URL redirects for direct viewing
- Other file types are streamed with `Content-Disposition: attachment` for download
- A background cleanup worker enforces retention and quota policies

## Running Tests

Tests run against a real PostgreSQL database (not mocked). Make sure Docker is running and migrations have been applied.

```bash
npm test                        # All tests
npm run test:unit               # Unit tests only
npm run test:integration        # Integration tests only

# Single file or test
npx vitest run test/integration/servers.integration.test.ts
npx vitest run -t "creates a server"
```

Frontend tests:

```bash
cd agora-ui && npm test
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://accord:accord@localhost:5432/accord_test` |
| `TEST_DATABASE_URL` | Database URL used by tests (falls back to `DATABASE_URL`) | Same as `DATABASE_URL` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_SECRET` | Secret key for signing JWT tokens. **Change this in production.** | `dev-secret-do-not-use-in-prod` |
| `PORT` | Port the backend listens on | `3000` |
| `HOST` | Host address to bind to | `0.0.0.0` |
| `AGORA_SETUP_TOKEN` | Pre-configured setup token for initial instance setup | Auto-generated on first boot |
| `AGORA_DATA_DIR` | Directory for persistent data (e.g., setup token file) | `.agora/` in project root |
| `CORS_ORIGIN` | Allowed origin for Socket.IO connections. **Must be set in production** (e.g., `https://your-domain.com`). | Disabled (same-origin only) |
| `TRUST_PROXY` | Set to `true` when behind a reverse proxy (nginx, Caddy, etc.) | `false` |
| `IP_ENCRYPTION_KEY` | 64 hex chars (32 bytes) for hashing user IPs. **Required in production.** | Dev default (zeros) |
| `LIVEKIT_URL` | LiveKit WebSocket URL for clients | `ws://localhost:7880` |
| `LIVEKIT_INTERNAL_URL` | Internal LiveKit REST API URL (for Docker networking) | None |
| `LIVEKIT_API_KEY` | LiveKit API key for voice channels | None (voice disabled) |
| `LIVEKIT_API_SECRET` | LiveKit API secret for voice channels | None (voice disabled) |
| `MINIO_ENDPOINT` | MinIO S3 endpoint URL | `http://localhost:9000` |
| `MINIO_ROOT_USER` | MinIO access key | `agora` |
| `MINIO_ROOT_PASSWORD` | MinIO secret key. **Change this in production.** | `agoradevpassword` |
| `AGORA_ENCRYPTION_KEY` | 64 hex chars (32 bytes) for file-at-rest encryption. **Required in production.** | Dev default (zeros) |

## Project Structure

```
agora/
├── src/                          # Backend source code
│   ├── index.ts                  # Entry point
│   ├── app.ts                    # App builder — hooks, middleware, routes
│   ├── config.ts                 # Environment variable configuration
│   ├── gateway.ts                # Socket.IO WebSocket gateway (human + bot auth)
│   ├── permissions.ts            # Bitmask-based permission system
│   ├── auth/                     # JWT auth, Argon2 passwords, bot token auth
│   ├── db/
│   │   ├── migrate.ts            # Migration runner
│   │   └── migrations/           # SQL migration files (001–020)
│   ├── instance/                 # Instance setup and initialization
│   ├── lib/                      # Shared utilities (MinIO, encryption, file validation)
│   ├── routes/                   # All route handlers (servers, messages, bots, threads, etc.)
│   └── workers/                  # Background workers (file cleanup)
├── test/                         # Unit and integration tests
├── agora-ui/                     # React frontend
│   ├── src/features/             # Feature modules (auth, admin, messages, voice, settings, moderation, etc.)
│   ├── src/stores/               # Zustand state stores (11 stores incl. threadStore)
│   └── src/lib/                  # API client, Socket.IO, type contracts
├── agora-mcp/                    # MCP server for AI agent connectivity
├── scripts/                      # Utility scripts (setup-env.js)
├── Caddyfile                     # Caddy reverse proxy config (TLS)
├── docker-compose.yml            # Dev infrastructure (PostgreSQL + Redis + MinIO + LiveKit)
├── docker-compose.prod.yml       # Full production stack
├── Dockerfile                    # Backend Docker image
├── agora-ui/Dockerfile           # Frontend Docker image
├── agora-ui/nginx.conf           # nginx config (API proxy routing)
├── .env.example                  # Dev environment template
└── .env.prod.example             # Production environment template
```

## Troubleshooting

### "instance_not_initialized" (503) on API requests

All API endpoints (except `/health` and `/instance/*`) return 503 until instance setup is completed. See [First-Time Instance Setup](#first-time-instance-setup).

### Database connection errors

Make sure PostgreSQL is running and healthy:

```bash
docker compose ps
docker compose logs postgres
```

### MinIO / file upload errors

Check that MinIO is running and the API has the correct credentials:

```bash
docker compose logs minio
docker compose logs api | grep -i minio
```

Common issues:
- **SignatureDoesNotMatch** — `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` mismatch between MinIO and API containers
- **405 on upload** — nginx isn't proxying `/files/*` to the API (check `nginx.conf`)

### Port conflicts

- Backend: set `PORT` in `.env` to a different port
- Frontend: Vite automatically tries the next available port

### Reset everything

```bash
docker compose down -v
docker compose up -d
npm run migrate
```

## Support the Project

If you'd like to support Agora's development, you can buy me an espresso:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Agora-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/misterespresso)
