# Discord Alternative — 6-Hour TDD Sprint (Final)

## Rules

- **Only these 28 tests exist.** If it's not listed, it doesn't get built.
- No TTL/time-based assertions. No `setTimeout` hacks (except fail-fast socket timeout).
- No MinIO. No refresh rotation. No rate limiting. No presence. No reactions.
- Each hour: write that hour's tests, make them green, move on.
- AI agents execute everything. This document is the spec.

---

## Project Structure

```
src/
├── app.ts                  # buildApp() factory — returns { app, db, redis }
├── config.ts               # env-driven config with defaults for test
├── db/
│   ├── connection.ts       # pg Pool, exported for direct use
│   ├── migrate.ts          # migration runner
│   └── migrations/         # 001_core.sql ... 005_social.sql
├── auth/
│   ├── passwords.ts        # hashPassword, verifyPassword (argon2id)
│   ├── tokens.ts           # generateToken, verifyToken (JWT, no refresh)
│   └── middleware.ts       # requireAuth fastify preHandler
├── routes/
│   ├── auth.ts             # register, login
│   ├── servers.ts          # create, channels, invites
│   ├── channels.ts         # create channel
│   ├── messages.ts         # send, list, edit, delete
│   └── dms.ts              # create DM
├── permissions.ts          # computePermissions, Permissions enum, ALL_PERMS_MASK
├── gateway.ts              # Socket.IO attach, auth, Ready, room joins, broadcast
└── utils/
    └── ulid.ts             # monotonicFactory wrapper

test/
├── helpers.ts              # makeApp, request, authedUser, createServer, etc.
├── unit/
│   ├── auth.unit.test.ts
│   ├── ulid.unit.test.ts
│   └── permissions.unit.test.ts
└── integration/
    ├── infra.integration.test.ts
    ├── auth.integration.test.ts
    ├── servers.integration.test.ts
    ├── messages.integration.test.ts
    ├── dms.integration.test.ts
    └── websocket.integration.test.ts
```

---

## Critical Decisions (Locked Before Sprint)

**App factory returns everything tests need:**
```typescript
// src/app.ts
export async function buildApp(opts?: {
    logger?: boolean;
    jwtSecret?: string;
    dbUrl?: string;
}) {
    const app = fastify({ logger: opts?.logger ?? false });
    const db = new Pool({ connectionString: opts?.dbUrl ?? process.env.DATABASE_URL });
    app.decorate('db', db);
    // ... register routes, middleware, socket.io
    return { app, db };
}
```

**Response shapes are camelCase JSON, snake_case DB:**
All routes transform DB rows before responding. Tests assert camelCase.
`edited_at` → `editedAt`, `author_id` → `authorId`, etc.

**Monotonic ULIDs:**
```typescript
// src/utils/ulid.ts
import { monotonicFactory } from 'ulid';
const ulid = monotonicFactory();
export function generateUlid(): string { return ulid(); }
```

**Auth middleware is a Fastify preHandler:**
```typescript
// src/auth/middleware.ts — applied to all routes except /auth/* and /health
app.addHook('preHandler', requireAuth);
```

**DM creation is transactional with normalized ordering:**
```typescript
// Pseudocode for DM create
const [userA, userB] = [senderId, recipientId].sort();
BEGIN;
  -- Try insert dm_pair, on conflict return existing
  INSERT INTO dm_pairs (user_a, user_b, channel_id) VALUES ($1, $2, $3)
    ON CONFLICT (user_a, user_b) DO NOTHING
    RETURNING channel_id;
  -- If no rows returned, SELECT existing
  -- If new, also INSERT channel + channel_members for both users
COMMIT;
```

**Socket.IO only listens in websocket test file:**
REST integration tests use supertest injection (no port needed).
Only `websocket.integration.test.ts` calls `app.listen()`.

---

## Test Helpers

**File:** `test/helpers.ts`

```typescript
import { buildApp } from '../src/app';
import supertest from 'supertest';

// ─── App lifecycle ───
// Each test FILE calls this in beforeAll / afterAll.
// Returns app (Fastify), db (Pool), request (supertest).
export async function setupTestApp() {
    const { app, db } = await buildApp({
        logger: false,
        jwtSecret: 'test-secret-do-not-use-in-prod',
        dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
    });
    await app.ready(); // ensures plugins are loaded
    return {
        app,
        db,
        request: supertest(app.server),
        async close() {
            await app.close();
            await db.end();
        },
    };
}

// ─── Shortcut: register + return auth context ───
export async function authedUser(
    req: supertest.SuperTest<any>,
    name: string
) {
    const res = await req.post('/auth/register').send({
        username: name,
        email: `${name}@test.com`,
        password: 'TestPass123!',
    });
    if (res.status !== 201) {
        throw new Error(`authedUser(${name}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return {
        userId: res.body.user.id as string,
        token: res.body.accessToken as string,
        auth: { Authorization: `Bearer ${res.body.accessToken}` },
    };
}

// ─── Shortcut: create server + find #general ───
export async function createServer(
    req: supertest.SuperTest<any>,
    auth: object,
    name: string
) {
    const server = await req.post('/servers').set(auth).send({ name });
    if (server.status !== 201) {
        throw new Error(`createServer(${name}) failed: ${server.status}`);
    }

    const channels = await req.get(`/servers/${server.body.id}/channels`).set(auth);

    // Explicit lookup — never assume array order
    const general = channels.body.find((c: any) => c.name === 'general');
    if (!general) {
        throw new Error('Server created without #general channel');
    }

    return {
        serverId: server.body.id as string,
        generalChannelId: general.id as string,
        everyoneRoleId: server.body.everyoneRoleId as string,
    };
}

// ─── Shortcut: invite + join ───
export async function joinViaInvite(
    req: supertest.SuperTest<any>,
    ownerAuth: object,
    joinerAuth: object,
    serverId: string
) {
    const invite = await req
        .post(`/servers/${serverId}/invites`)
        .set(ownerAuth)
        .send({});

    const join = await req
        .post(`/invites/${invite.body.code}`)
        .set(joinerAuth);

    return join.body;
}
```

**Socket helper lives in the websocket test file only** —
keeps `socket.io-client` out of the dependency path for all other tests.

---

## Test Suite: 28 Tests

### Infrastructure (1 test)

**File:** `test/integration/infra.integration.test.ts`

```typescript
let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('Infrastructure', () => {
    test('API health ok and migrations ran', async () => {
        const res = await ctx.request.get('/health');
        expect(res.status).toBe(200);

        // Proves migrations ran — doesn't depend on runner internals
        await ctx.db.query('SELECT 1 FROM users LIMIT 0');
    });
});
```

---

### Auth Unit (6 tests)

**File:** `test/unit/auth.unit.test.ts`

```typescript
import { hashPassword, verifyPassword } from '../../src/auth/passwords';
import { generateToken, verifyToken } from '../../src/auth/tokens';

describe('Password Hashing', () => {
    test('produces argon2id hash', async () => {
        const hash = await hashPassword('test-password');
        expect(hash).toMatch(/^\$argon2id\$/);
    });

    test('verifies correct password', async () => {
        const hash = await hashPassword('my-password');
        expect(await verifyPassword('my-password', hash)).toBe(true);
    });

    test('rejects wrong password', async () => {
        const hash = await hashPassword('my-password');
        expect(await verifyPassword('wrong', hash)).toBe(false);
    });
});

describe('JWT', () => {
    test('generates three-segment token', () => {
        const token = generateToken({ userId: 'test-id' }, 'test-secret');
        expect(token.split('.')).toHaveLength(3);
    });

    test('round-trips userId through payload', () => {
        const token = generateToken({ userId: 'abc123' }, 'test-secret');
        const payload = verifyToken(token, 'test-secret');
        expect(payload.userId).toBe('abc123');
    });

    test('rejects tampered token', () => {
        const token = generateToken({ userId: 'abc123' }, 'test-secret');
        const tampered = token.slice(0, -4) + 'XXXX';
        expect(() => verifyToken(tampered, 'test-secret')).toThrow();
    });
});
```

No expiry tests. Expiry introduces time and flake.

---

### Auth Integration (5 tests)

**File:** `test/integration/auth.integration.test.ts`

```typescript
let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('POST /auth/register', () => {
    test('creates user, returns token, no password_hash leaked', async () => {
        const res = await ctx.request.post('/auth/register').send({
            username: 'newuser',
            email: 'new@test.com',
            password: 'SecurePass123!',
        });
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('accessToken');
        expect(res.body.user.username).toBe('newuser');
        expect(res.body.user).not.toHaveProperty('password_hash');
        expect(res.body.user).not.toHaveProperty('passwordHash');
    });

    test('rejects duplicate username or email', async () => {
        await ctx.request.post('/auth/register').send({
            username: 'taken', email: 'taken@test.com', password: 'SecurePass123!',
        });

        // Same username
        const dupeUser = await ctx.request.post('/auth/register').send({
            username: 'taken', email: 'different@test.com', password: 'SecurePass123!',
        });
        expect(dupeUser.status).toBe(409);

        // Same email
        const dupeEmail = await ctx.request.post('/auth/register').send({
            username: 'different', email: 'taken@test.com', password: 'SecurePass123!',
        });
        expect(dupeEmail.status).toBe(409);
    });

    test('rejects missing required fields', async () => {
        const res = await ctx.request.post('/auth/register').send({
            username: 'incomplete',
        });
        expect(res.status).toBe(400);
    });
});

describe('POST /auth/login', () => {
    beforeAll(async () => {
        await ctx.request.post('/auth/register').send({
            username: 'loginuser', email: 'login@test.com', password: 'SecurePass123!',
        });
    });

    test('returns token for valid credentials', async () => {
        const res = await ctx.request.post('/auth/login').send({
            email: 'login@test.com', password: 'SecurePass123!',
        });
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('accessToken');
    });

    test('401 for wrong password (same shape as nonexistent email)', async () => {
        const wrong = await ctx.request.post('/auth/login').send({
            email: 'login@test.com', password: 'WrongPassword!',
        });
        expect(wrong.status).toBe(401);

        const ghost = await ctx.request.post('/auth/login').send({
            email: 'ghost@test.com', password: 'Whatever!',
        });
        expect(ghost.status).toBe(401);

        // Same error shape — don't leak which emails exist
        expect(wrong.body.error).toBe(ghost.body.error);
    });
});
```

---

### Servers + Invites + Channels (4 tests)

**File:** `test/integration/servers.integration.test.ts`

```typescript
let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('Server Lifecycle', () => {
    test('creating a server produces @everyone role, #general, creator as member', async () => {
        const user = await authedUser(ctx.request, 'servermaker');

        const res = await ctx.request
            .post('/servers')
            .set(user.auth)
            .send({ name: 'Test Server' });

        expect(res.status).toBe(201);
        expect(res.body.ownerId).toBe(user.userId);
        expect(res.body.everyoneRoleId).toBeDefined();

        const channels = await ctx.request
            .get(`/servers/${res.body.id}/channels`)
            .set(user.auth);

        const general = channels.body.find((c: any) => c.name === 'general');
        expect(general).toBeDefined();
        expect(general.channelType).toBe(3); // server_text
    });

    test('unauthenticated server creation returns 401', async () => {
        const res = await ctx.request
            .post('/servers')
            .send({ name: 'No Auth Server' });

        expect(res.status).toBe(401);
    });

    test('invite create + join', async () => {
        const owner = await authedUser(ctx.request, 'inviteowner');
        const joiner = await authedUser(ctx.request, 'invitejoiner');
        const { serverId } = await createServer(ctx.request, owner.auth, 'Invite Server');

        // Owner creates invite
        const invite = await ctx.request
            .post(`/servers/${serverId}/invites`)
            .set(owner.auth)
            .send({});

        expect(invite.status).toBe(201);
        expect(typeof invite.body.code).toBe('string');
        expect(invite.body.code.length).toBeLessThanOrEqual(12);

        // Joiner uses invite
        const join = await ctx.request
            .post(`/invites/${invite.body.code}`)
            .set(joiner.auth);

        expect(join.status).toBe(200);
        expect(join.body.serverId).toBe(serverId);
        expect(join.body.userId).toBe(joiner.userId);
    });

    test('create channel and list it', async () => {
        const user = await authedUser(ctx.request, 'channelmaker');
        const { serverId } = await createServer(ctx.request, user.auth, 'Channel Server');

        const create = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(user.auth)
            .send({ name: 'dev-chat', channelType: 3 });

        expect(create.status).toBe(201);

        const list = await ctx.request
            .get(`/servers/${serverId}/channels`)
            .set(user.auth);

        expect(list.body.some((c: any) => c.name === 'dev-chat')).toBe(true);
    });
});
```

---

### Messages (5 tests)

**File:** `test/integration/messages.integration.test.ts`

```typescript
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: any, channelId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await authedUser(ctx.request, 'msgowner');
    const srv = await createServer(ctx.request, owner.auth, 'Msg Server');
    channelId = srv.generalChannelId;
});
afterAll(async () => { await ctx.close(); });

describe('Messages', () => {
    test('send a message', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Hello world!' });

        expect(res.status).toBe(201);
        expect(res.body.content).toBe('Hello world!');
        expect(res.body.authorId).toBe(owner.userId);
        expect(res.body.channelId).toBe(channelId);
        // ULID: 26 chars, Crockford base32
        expect(res.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    test('pagination: newest first, cursor produces no overlap', async () => {
        // Send 5 messages with known content
        for (let i = 0; i < 5; i++) {
            await ctx.request
                .post(`/channels/${channelId}/messages`)
                .set(owner.auth)
                .send({ content: `page-msg-${i}` });
        }

        // Page 1: limit 3, newest first
        const page1 = await ctx.request
            .get(`/channels/${channelId}/messages?limit=3`)
            .set(owner.auth);

        expect(page1.body).toHaveLength(3);
        const ids1 = page1.body.map((m: any) => m.id);
        expect(ids1).toEqual([...ids1].sort().reverse()); // descending ULIDs

        // Page 2: before oldest in page 1
        const cursor = ids1[ids1.length - 1];
        const page2 = await ctx.request
            .get(`/channels/${channelId}/messages?limit=3&before=${cursor}`)
            .set(owner.auth);

        // No overlap
        const ids2Set = new Set(page2.body.map((m: any) => m.id));
        for (const id of ids1) {
            expect(ids2Set.has(id)).toBe(false);
        }
    });

    test('edit own message sets editedAt', async () => {
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Original' });

        const edit = await ctx.request
            .patch(`/channels/${channelId}/messages/${msg.body.id}`)
            .set(owner.auth)
            .send({ content: 'Edited' });

        expect(edit.status).toBe(200);
        expect(edit.body.content).toBe('Edited');
        expect(edit.body.editedAt).toBeDefined();
    });

    test('soft delete nulls content, row persists with deletedAt', async () => {
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Delete me' });

        const del = await ctx.request
            .delete(`/channels/${channelId}/messages/${msg.body.id}`)
            .set(owner.auth);
        expect(del.status).toBe(200);

        const list = await ctx.request
            .get(`/channels/${channelId}/messages?limit=50`)
            .set(owner.auth);

        const deleted = list.body.find((m: any) => m.id === msg.body.id);
        expect(deleted).toBeDefined();
        expect(deleted.content).toBeNull();
        expect(deleted.deletedAt).toBeDefined();
    });

    test('non-member cannot send messages', async () => {
        const outsider = await authedUser(ctx.request, 'msgoutsider');

        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(outsider.auth)
            .send({ content: 'Sneaky' });

        expect(res.status).toBe(403);
    });
});
```

---

### DMs (2 tests)

**File:** `test/integration/dms.integration.test.ts`

```typescript
let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('Direct Messages', () => {
    test('create DM deduplicates: same pair both directions returns same channel', async () => {
        const user1 = await authedUser(ctx.request, 'dm1');
        const user2 = await authedUser(ctx.request, 'dm2');

        const dm1 = await ctx.request
            .post('/channels/dm')
            .set(user1.auth)
            .send({ recipientId: user2.userId });
        expect(dm1.status).toBe(201);
        expect(dm1.body.channelType).toBe(1); // DM

        // Same direction again
        const dm2 = await ctx.request
            .post('/channels/dm')
            .set(user1.auth)
            .send({ recipientId: user2.userId });
        expect(dm2.body.id).toBe(dm1.body.id);

        // Reverse direction
        const dm3 = await ctx.request
            .post('/channels/dm')
            .set(user2.auth)
            .send({ recipientId: user1.userId });
        expect(dm3.body.id).toBe(dm1.body.id);
    });

    test('both members can send and read messages in DM', async () => {
        const user1 = await authedUser(ctx.request, 'dmsend1');
        const user2 = await authedUser(ctx.request, 'dmsend2');

        const dm = await ctx.request
            .post('/channels/dm')
            .set(user1.auth)
            .send({ recipientId: user2.userId });

        // User1 sends
        const msg = await ctx.request
            .post(`/channels/${dm.body.id}/messages`)
            .set(user1.auth)
            .send({ content: 'Hey!' });
        expect(msg.status).toBe(201);

        // User2 reads
        const read = await ctx.request
            .get(`/channels/${dm.body.id}/messages`)
            .set(user2.auth);
        expect(read.body.some((m: any) => m.content === 'Hey!')).toBe(true);
    });
});
```

---

### Permissions Unit (3 tests)

**File:** `test/unit/permissions.unit.test.ts`

```typescript
import { computePermissions, Permissions, ALL_PERMS_MASK } from '../../src/permissions';

function baseScenario(opts: {
    isOwner?: boolean;
    everyonePerms?: bigint;
    rolePerms?: bigint;
    hasRole?: boolean;
}): bigint {
    const everyoneRoleId = 'role_everyone';
    const roles = new Map<string, { permissions: bigint }>();
    roles.set(everyoneRoleId, { permissions: opts.everyonePerms ?? 0n });

    const userRoleIds: string[] = [];
    if (opts.hasRole && opts.rolePerms !== undefined) {
        roles.set('extra_role', { permissions: opts.rolePerms });
        userRoleIds.push('extra_role');
    }

    return computePermissions({
        userId: opts.isOwner ? 'owner_id' : 'regular_user',
        roleIds: userRoleIds,
        server: { ownerId: 'owner_id', everyoneRoleId },
        roles,
        channelRoleOverrides: new Map(),
        channelMemberOverride: undefined,
    });
}

describe('Permissions — Sprint Minimum', () => {
    test('server owner always gets ALL_PERMS_MASK', () => {
        expect(baseScenario({ isOwner: true, everyonePerms: 0n })).toBe(ALL_PERMS_MASK);
    });

    test('Administrator from any role yields ALL_PERMS_MASK', () => {
        const result = baseScenario({
            everyonePerms: 0n,
            rolePerms: Permissions.Administrator,
            hasRole: true,
        });
        expect(result).toBe(ALL_PERMS_MASK);
    });

    test('@everyone base OR role permissions (no overlap with ungranted)', () => {
        const result = baseScenario({
            everyonePerms: Permissions.ViewChannel,
            rolePerms: Permissions.SendMessages,
            hasRole: true,
        });
        expect(result & Permissions.ViewChannel).toBeTruthy();
        expect(result & Permissions.SendMessages).toBeTruthy();
        expect(result & Permissions.ManageMessages).toBeFalsy();
    });
});
```

No override tests. Override semantics are deferred to post-sprint.

---

### ULID Unit (1 test)

**File:** `test/unit/ulid.unit.test.ts`

```typescript
import { generateUlid } from '../../src/utils/ulid';

describe('ULID', () => {
    test('26-char Crockford base32, monotonic pair sorts correctly', () => {
        const a = generateUlid();
        const b = generateUlid();

        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(b).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        // Monotonic factory guarantees this even within same millisecond
        expect(a < b).toBe(true);
    });
});
```

---

### WebSocket (1 test)

**File:** `test/integration/websocket.integration.test.ts`

This is the ONLY test file that starts a real TCP listener.

```typescript
import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite } from '../helpers';

const TEST_PORT = 4999;

// Socket helper — lives here, not in shared helpers.
// Resolves ONLY after Ready event. Ready = rooms joined (server contract).
function connectSocket(token: string): Promise<{ socket: Socket; ready: any }> {
    return new Promise((resolve, reject) => {
        const socket = io(`http://localhost:${TEST_PORT}`, {
            auth: { token },
            transports: ['websocket'],
        });

        const timeout = setTimeout(() => {
            socket.disconnect();
            reject(new Error('Socket connect + Ready timeout (2s)'));
        }, 2000);

        socket.on('Ready', (data: any) => {
            clearTimeout(timeout);
            resolve({ socket, ready: data });
        });

        socket.on('connect_error', (err: Error) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    // This is the only test file that actually listens on a port
    await ctx.app.listen({ port: TEST_PORT, host: '0.0.0.0' });
});

afterAll(async () => {
    await ctx.close();
});

describe('WebSocket Gateway', () => {
    test('member receives Message event after Ready', async () => {
        const user1 = await authedUser(ctx.request, 'ws1');
        const user2 = await authedUser(ctx.request, 'ws2');

        const { serverId, generalChannelId } = await createServer(
            ctx.request, user1.auth, 'WS Server'
        );
        await joinViaInvite(ctx.request, user1.auth, user2.auth, serverId);

        // User2 connects — resolves only after Ready (rooms joined)
        const { socket, ready } = await connectSocket(user2.token);

        expect(ready.user.id).toBe(user2.userId);
        expect(ready.servers.length).toBeGreaterThan(0);

        // Register listener BEFORE triggering the message send
        const messagePromise = new Promise<any>((resolve) => {
            socket.on('Message', resolve);
        });

        // User1 sends via REST
        await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(user1.auth)
            .send({ content: 'Real-time!' });

        // User2 should receive the broadcast
        const event = await messagePromise;
        expect(event.content).toBe('Real-time!');
        expect(event.authorId).toBe(user1.userId);
        expect(event.channelId).toBe(generalChannelId);

        socket.disconnect();
    });
});
```

**Why this doesn't flake:**
1. `connectSocket` doesn't resolve until Ready fires
2. Ready = room joins complete (server-side contract)
3. Message listener registered before REST call triggers broadcast
4. No polling, no setTimeout-then-assert, pure event sequencing
5. 2s fail-fast timeout prevents hanging — not a "wait then check"

---

## Final Test Count

| File | Tests |
|------|-------|
| infra.integration | 1 |
| auth.unit | 6 |
| auth.integration | 5 |
| servers.integration | 4 |
| messages.integration | 5 |
| dms.integration | 2 |
| permissions.unit | 3 |
| ulid.unit | 1 |
| websocket.integration | 1 |
| **Total** | **28** |

---

## Endpoint Contract (14 endpoints + 2 socket events)

```
GET    /health

POST   /auth/register       → 201 { user: { id, username }, accessToken }
POST   /auth/login           → 200 { user: { id, username }, accessToken }

POST   /servers              → 201 { id, name, ownerId, everyoneRoleId }
GET    /servers/:id/channels  → 200 [{ id, name, channelType }]
POST   /servers/:id/invites  → 201 { code }
POST   /invites/:code        → 200 { serverId, userId }
POST   /servers/:id/channels → 201 { id, name, channelType, serverId }

POST   /channels/:id/messages         → 201 { id, content, authorId, channelId }
GET    /channels/:id/messages?limit&before → 200 [messages newest-first]
PATCH  /channels/:id/messages/:msgId   → 200 { id, content, editedAt }
DELETE /channels/:id/messages/:msgId   → 200 { id, deletedAt }

POST   /channels/dm           → 201 { id, channelType }

WS connect(auth: { token })
  → server emits Ready { user, servers, channels }
  → server broadcasts Message { id, content, authorId, channelId }
```

---

## Explicit Stubs (Not Tested, Available for Demo)

- **Mentions:** Accept `mentions: [userId]` array, write as-is. MVP insecure — flagged.
- **Uploads:** `POST /upload/presign` → `{ fileId, uploadUrl: "https://stub" }`. No MinIO.
- **Presence:** All connected sockets = online. No Redis TTL. No heartbeat.

---

## What Comes After (Do Not Touch During Sprint)

Refresh rotation · Rate limiting · Presence TTL · Reactions · Unreads/ack ·
Channel overrides · Property-based permission tests · Real MinIO uploads ·
Category validation trigger · Invite expiry/max-use · Audit logging ·
Ban/kick · Custom emoji · Voice (LiveKit)

All have schema support from existing migrations. None needed to demo.

---

## Sprint Cadence

```
BEFORE   Docker up, migrations, helpers written.
         infra test GREEN.                              ~15 min

HOUR 1   Write 6 auth unit + 5 auth integration tests.
         Implement: passwords, tokens, middleware,
         register/login routes.
         ALL 12 GREEN.                                  60 min

HOUR 2   Write 4 server/invite/channel tests.
         Implement: server create transaction,
         invite create/consume, channel CRUD.
         ALL 16 GREEN.                                  60 min

HOUR 3   Write 5 message tests.
         Implement: message routes + pagination +
         edit + soft delete + membership gate.
         ALL 21 GREEN.                                  60 min

HOUR 4   Write 3 permission unit + 1 ULID + 2 DM tests.
         Implement: computePermissions, DM create
         with dm_pairs transaction.
         ALL 27 GREEN.                                  60 min

HOUR 5   Write 1 WebSocket test.
         Implement: Socket.IO gateway, auth,
         Ready payload, room joins, Message broadcast.
         ALL 28 GREEN.                                  60 min

HOUR 6   Full suite green. Polish response shapes.
         Optional: minimal web UI / CLI demo.
         Optional: "outsider can't read DMs" (29th test).
         Ship or don't — but it works and you can prove it.
```
