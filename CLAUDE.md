# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is This

Agora is a Discord-like chat platform. Backend is Fastify + PostgreSQL with Row Level Security. Frontend is React + Vite + Tailwind + Zustand. Real-time via Socket.IO.

## Commands

```bash
# Infrastructure
docker compose up                    # PostgreSQL 16 + Redis 7

# Backend (root directory)
npm run dev                          # Start backend (port 3000)
npm run migrate                      # Run SQL migrations
npm run build                        # tsc compile to dist/
npm test                             # vitest run (all tests)
npm run test:unit                    # vitest run test/unit
npm run test:integration             # vitest run test/integration
npx vitest run test/integration/servers.integration.test.ts  # Single test file
npx vitest run -t "test name"        # Single test by name

# Frontend (agora-ui/)
cd agora-ui && npm run dev           # Vite dev server (proxies API to :3000)
cd agora-ui && npm run build         # Production build
cd agora-ui && npm run lint          # ESLint
```

## Architecture

### Per-Request Transaction Lifecycle

Every HTTP request gets its own DB client and transaction. This is the backbone of the app:

1. `onRequest` → acquire client from pool, `BEGIN`
2. `preHandler` → check instance initialized, authenticate JWT, set RLS context (`SET LOCAL ROLE app_user` + `set_config('app.current_user_id', ...)`)
3. Route handler → use `(request as any).dbClient` for all queries
4. `onResponse` → `COMMIT`, then emit pending Socket.IO events, then release client
5. `onError` → `ROLLBACK`, release client

Socket.IO events are queued during the request (`(request as any).pendingEvents`) and only emitted after COMMIT succeeds. This guarantees clients never receive events for uncommitted data.

### Row Level Security (RLS)

Multi-tenant tables have RLS policies enforced at the DB level. The `app_user` role (set per-request) is subject to RLS; the table owner `accord` bypasses it. The `is_server_member()` helper is `SECURITY DEFINER` to avoid circular RLS lookups.

Routes still perform explicit authorization checks (membership queries returning 403) as defense-in-depth.

### Authorization Pattern

Every authenticated endpoint that accesses server resources must check membership:
```typescript
const member = await db.query(
    'SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2',
    [serverId, userId]
);
if (member.rows.length === 0) return reply.status(403).send({ error: 'forbidden' });
```

### Input Validation

Use Fastify JSON Schema on route definitions (`schema: { body: {...} }`). Fastify auto-returns 400 on validation failures. Never let unvalidated input reach DB queries.

### Permissions

Bitmask-based permission system (`src/permissions.ts`). Permissions are computed by layering: server owner → @everyone role → assigned roles → channel role overrides → channel member overrides. Uses `bigint` for the bitmask.

### IDs

ULID (26-char, chronologically sortable). Stored as `CHAR(26)` in Postgres which pads with spaces — always call `.trim()` on DB-returned ID values.

### Database Migrations

Custom runner at `src/db/migrate.ts` with SQL files in `src/db/migrations/`. Migrations tracked in `schema_migrations` table. Run via `npm run migrate`.

Circular FK between `roles` and `servers` uses `DEFERRABLE INITIALLY DEFERRED` constraints.

### WebSocket (Socket.IO)

`src/gateway.ts` — WebSocket-only transport (no polling). On connect: JWT auth, fetch user's servers/channels, join `channel:{channelId}` rooms, emit `Ready` event. Messages broadcast to channel rooms after REST endpoint commits.

### Instance Setup

Fresh instances require a one-time setup via `POST /instance/setup` with a setup token. Uses `pg_advisory_xact_lock` to serialize concurrent attempts. Registration policies: `open`, `invite_only`, `approval`.

## Testing

Tests run against real PostgreSQL (not mocked). Vitest with `fileParallelism: false`.

### Critical: Test Isolation

**Always** use `TRUNCATE ... CASCADE` for cleanup, **never** `DELETE FROM` (FK constraints cause cascade failures):
```typescript
await cleanDatabase(ctx.db);  // from test/helpers.ts
```

### Test Helpers (`test/helpers.ts`)

- `setupTestApp()` — creates app + pool + supertest agent
- `authedUser(req, name)` — register user, return `{ userId, token, auth }`
- `createServer(req, auth, name)` — create server, return `{ serverId, generalChannelId, everyoneRoleId }`
- `joinViaInvite(req, ownerAuth, joinerAuth, serverId)` — create invite + join
- `cleanDatabase(db)` — truncate all tables + re-seed `instance_config`
- `setupInstance(req)` — run instance setup for tests that need it

### Test File Pattern

```typescript
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => { ctx = await setupTestApp(); await cleanDatabase(ctx.db); });
afterAll(async () => { await ctx.close(); });
```

WebSocket tests use port 4999 and wait for the `Ready` event before asserting.

## Frontend

React 19 + Vite 7 + Tailwind v4 + Zustand for state. Vite dev server proxies `/api` to backend at `localhost:3000`.

Structure: `agora-ui/src/features/{auth,admin,setup,shell,servers,messages,live}/` with shared components in `components/ui/`. API client at `lib/api.ts`. Type contracts at `lib/contracts/`.

Current state: Auth flow, admin dashboard, and instance setup are implemented. Main chat UI is Phase 3.

## Race Condition Patterns

- DM creation: speculative insert with `SAVEPOINT` rollback if pair exists
- Concurrent invite use: `FOR UPDATE` lock on invite row
- Instance setup: `pg_advisory_xact_lock` to serialize
- Sub-transactions within the per-request transaction use `SAVEPOINT`/`RELEASE SAVEPOINT`

## Environment

Copy `.env.example` to `.env`. Defaults: `accord:accord@localhost:5432/accord_test`, JWT secret for dev.
