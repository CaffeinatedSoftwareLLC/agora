# Agora Alpha Test

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

Like many of you, I am a gamer. Before a certain company existed, voice chat with friends was a real PITA. A certain company gained our trust, and this year broke that trust. None of the alternatives are good enough. So, I made this project for us. If we all work together in making the best voice chat on the market, we will never be betrayed again. I look forward to collaborating with all of you. Happy Gaming.

Agora is a self-hosted, Discord-like chat platform built with Fastify, PostgreSQL, and React. It supports servers, channels, direct messages, real-time messaging via Socket.IO, role-based permissions, and row-level security at the database layer.

## What Works Right Now

This is an early alpha — the foundation is solid but the feature set is slim:

- **Text chat** — send, edit, and delete messages in channels with real-time updates
- **Direct messages** — 1-on-1 conversations between users
- **Voice channels** — join, mute/unmute (via LiveKit)
- **Servers & channels** — create text/voice channels, invite users via shareable codes
- **Presence** — online/offline indicators and typing notifications
- **Mentions** — @mention users with autocomplete
- **Unread tracking** — badge counts on channels and DMs
- **Admin panel** — approve/reject registrations, view user stats
- **Two color themes** — Aegean and Terracotta

**Voice chat warning:** Voice channels may not work for users outside your local network if you're hosting from home. WebRTC requires peers to discover each other's IP addresses via a TURN server, and most home networks sit behind NAT/firewalls that block this. For reliable voice chat with remote users, it is strongly recommended to deploy Agora on a VPS with a public IP.

**Try it out:** A public alpha instance is live at [alpha.agora.host](https://alpha.agora.host). Note that you currently cannot see who is in a voice room until you join it. During the alpha test, moderation will be minimal for the first few days — join at your own risk.

**Not yet implemented:** search, message pinning, file uploads, notifications, roles/permissions UI, server settings, and a lot more.

## Roadmap

Roughly in priority order. No ETAs — this is a community project, not a product launch.

- [ ] File uploads and image embeds
- [ ] Voice channel participant visibility (see who's in a room without joining)
- [ ] Roles and permissions UI (backend already supports this)
- [ ] Server settings (name, icon, moderation options)
- [ ] Message pinning
- [ ] Search (messages, users, channels)
- [ ] Notifications (desktop + in-app)
- [ ] Message replies and threads
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
| Auth | Argon2 password hashing, JWT tokens |
| Real-time | Socket.IO 4 (WebSocket-only, no polling) |
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

Edit `.env.prod` and set both values:

| Variable | How to generate |
|---|---|
| `DB_PASSWORD` | Any strong password |
| `JWT_SECRET` | Generate a random secret (see below) |

Generate `JWT_SECRET`:

```bash
# macOS / Linux
openssl rand -base64 32

# Windows (PowerShell)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 2. Build and start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

This starts six services:
- **postgres** — PostgreSQL 16 with persistent volume
- **redis** — Redis 7 with AOF persistence
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
                    ├── /auth, /servers, /channels, etc. → api:3000
                    └── /socket.io (WebSocket) → api:3000
           postgres:5432, redis:6379 (internal only)
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

This starts PostgreSQL and Redis only. Wait for healthy status:

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

## Project Structure

```
agora/
├── src/                          # Backend source code
│   ├── index.ts                  # Entry point
│   ├── app.ts                    # App builder — hooks, middleware, routes
│   ├── config.ts                 # Environment variable configuration
│   ├── gateway.ts                # Socket.IO WebSocket gateway
│   ├── permissions.ts            # Bitmask-based permission system
│   ├── auth/                     # JWT auth, Argon2 passwords
│   ├── db/
│   │   ├── migrate.ts            # Migration runner
│   │   └── migrations/           # SQL migration files
│   ├── instance/                 # Instance setup and initialization
│   └── routes/                   # All route handlers
├── test/                         # Unit and integration tests
├── agora-ui/                     # React frontend
│   ├── src/features/             # Feature modules (auth, messages, etc.)
│   ├── src/stores/               # Zustand state stores
│   └── src/lib/                  # API client, Socket.IO, type contracts
├── Caddyfile                     # Caddy reverse proxy config (TLS)
├── docker-compose.yml            # Dev infrastructure (PostgreSQL + Redis + LiveKit)
├── docker-compose.prod.yml       # Full production stack
├── Dockerfile                    # Backend Docker image
├── agora-ui/Dockerfile           # Frontend Docker image
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

### Port conflicts

- Backend: set `PORT` in `.env` to a different port
- Frontend: Vite automatically tries the next available port

### Reset everything

```bash
docker compose down -v
docker compose up -d
npm run migrate
```
