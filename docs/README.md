# Agora

Agora is a self-hosted, Discord-like chat platform built with Fastify, PostgreSQL, and React. It supports servers, channels, direct messages, real-time messaging via Socket.IO, role-based permissions, and row-level security at the database layer.

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

- **Node.js 20+** (LTS recommended)
- **Docker** and **Docker Compose** (for PostgreSQL and Redis)
- **Git**

## Quick Start

### 1. Clone the repository

```bash
git clone <repo-url> agora
cd agora
```

### 2. Install dependencies

Install backend dependencies from the project root, then install frontend dependencies:

```bash
npm install
cd agora-ui && npm install && cd ..
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

The defaults in `.env.example` work out of the box for local development. See the [Environment Variables](#environment-variables) section below for details on each variable.

### 4. Start infrastructure

Launch PostgreSQL 16 and Redis 7 in Docker containers:

```bash
docker compose up -d
```

Wait a few seconds for the health checks to pass. You can verify with:

```bash
docker compose ps
```

Both services should show `healthy` status.

### 5. Run database migrations

```bash
npm run migrate
```

This runs 11 SQL migrations that create all tables, indexes, RLS policies, and seed data. Migrations are tracked in a `schema_migrations` table and are idempotent (safe to run multiple times).

### 6. Start the backend

```bash
npm run dev
```

The backend starts on **http://localhost:3000** using `tsx` for TypeScript execution. You should see:

```
Agora listening on 0.0.0.0:3000
```

### 7. Start the frontend

In a separate terminal:

```bash
cd agora-ui
npm run dev
```

The Vite dev server starts on **http://localhost:5173**. It proxies API requests (`/auth`, `/instance`, `/servers`, `/channels`, `/invites`, `/admin`, `/users`, `/health`) and WebSocket connections (`/socket.io`) to the backend at `localhost:3000`.

### 8. Open the app

Navigate to **http://localhost:5173** in your browser.

On first load, the app detects the instance is not yet configured and presents the setup flow. See [First-Time Instance Setup](#first-time-instance-setup) below.

## First-Time Instance Setup

Agora requires a one-time setup to create the first admin account and configure the instance. This is secured by a **setup token**.

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

The auto-generated token is saved to `.agora/setup-token` so it persists across restarts. If the file cannot be written (e.g., read-only filesystem), the token is only valid for the current process and a warning is printed.

### Completing setup

You can complete setup through the frontend UI or directly via the API:

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

Setup creates:
- An admin user with instance-admin privileges
- A default server named after the instance
- A `#general` channel in that server
- Instance configuration records

The endpoint returns a JWT access token so the admin is immediately authenticated.

Setup can only be run once. Subsequent calls return `409 instance_already_initialized`.

## Running Tests

Tests run against a real PostgreSQL database (not mocked). Make sure Docker is running and migrations have been applied.

```bash
# Run all tests
npm test

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run a specific test file
npx vitest run test/integration/servers.integration.test.ts

# Run a specific test by name
npx vitest run -t "creates a server"
```

Frontend tests:

```bash
cd agora-ui
npm test
```

## Project Structure

```
agora/
├── src/                          # Backend source code
│   ├── index.ts                  # Entry point — starts the Fastify server
│   ├── app.ts                    # App builder — hooks, middleware, route registration
│   ├── config.ts                 # Environment variable configuration
│   ├── gateway.ts                # Socket.IO WebSocket gateway
│   ├── permissions.ts            # Bitmask-based permission system
│   ├── auth/
│   │   ├── middleware.ts         # JWT authentication middleware
│   │   ├── passwords.ts         # Argon2 hashing
│   │   └── tokens.ts            # JWT generation/verification
│   ├── db/
│   │   ├── connection.ts         # PostgreSQL pool setup
│   │   ├── migrate.ts            # Migration runner
│   │   └── migrations/           # 11 SQL migration files
│   ├── instance/
│   │   ├── check-initialized.ts  # Instance initialization check
│   │   └── setup-token.ts        # Setup token resolution
│   ├── routes/
│   │   ├── instance.ts           # Instance setup and status
│   │   ├── auth.ts               # Registration and login
│   │   ├── servers.ts            # Server CRUD
│   │   ├── channels.ts           # Channel CRUD
│   │   ├── messages.ts           # Message CRUD
│   │   ├── reactions.ts          # Message reactions
│   │   ├── unreads.ts            # Unread tracking
│   │   ├── dms.ts                # Direct messages
│   │   ├── admin.ts              # Admin dashboard endpoints
│   │   ├── users.ts              # User profile endpoints
│   │   └── shared.ts             # Shared route helpers
│   └── utils/
│       └── ulid.ts               # ULID generation
├── test/
│   ├── helpers.ts                # Test setup utilities
│   ├── unit/                     # Unit tests
│   └── integration/              # Integration tests
├── agora-ui/                     # Frontend application
│   ├── src/
│   │   ├── main.tsx              # React entry point
│   │   ├── App.tsx               # Root component with routing
│   │   ├── components/ui/        # Shared UI components
│   │   ├── features/
│   │   │   ├── auth/             # Login, register, auth guard
│   │   │   ├── admin/            # Admin dashboard
│   │   │   ├── setup/            # Instance setup wizard
│   │   │   ├── shell/            # App layout, server rail, sidebars
│   │   │   ├── servers/          # Server and channel management
│   │   │   ├── messages/         # Message list, input, editing
│   │   │   └── live/             # Typing, presence, reactions, unreads
│   │   ├── stores/               # Zustand state stores
│   │   ├── hooks/                # Custom React hooks
│   │   └── lib/
│   │       ├── api.ts            # HTTP API client
│   │       ├── socketFactory.ts  # Socket.IO client factory
│   │       └── contracts/        # TypeScript type contracts
│   └── package.json
├── docker-compose.yml            # PostgreSQL 16 + Redis 7
├── package.json                  # Backend dependencies and scripts
├── tsconfig.json                 # TypeScript configuration
├── .env.example                  # Environment variable template
└── CLAUDE.md                     # AI assistant instructions
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

## Troubleshooting

### "instance_not_initialized" (503) on API requests

All API endpoints (except `/health` and `/instance/*`) return 503 until the instance setup is completed. Run the setup flow as described in [First-Time Instance Setup](#first-time-instance-setup).

### Database connection errors

Make sure PostgreSQL is running and healthy:

```bash
docker compose ps
docker compose logs postgres
```

If the container is not running, start it with `docker compose up -d` and wait for the health check to pass.

### Migration errors

If migrations fail, check that the database exists and the user has the correct permissions. The default `docker-compose.yml` creates the `accord_test` database with user `accord` and password `accord`.

```bash
# Reset the database (destroys all data)
docker compose down -v
docker compose up -d
npm run migrate
```

### Port conflicts

If port 3000 or 5173 is already in use:
- Backend: set the `PORT` env var in `.env` to a different port
- Frontend: Vite will automatically try the next available port and display it in the terminal

### Redis connection errors

If Redis is not reachable, Socket.IO real-time features will not work. Make sure Redis is running:

```bash
docker compose ps
docker compose logs redis
```
