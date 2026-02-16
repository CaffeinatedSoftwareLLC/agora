# Backend Architecture

Agora's backend is built on **Fastify 5**, **PostgreSQL 16**, **Socket.IO 4**, and **Redis 7** (ioredis 5). The core design principle is that every HTTP request runs inside a dedicated PostgreSQL transaction with Row Level Security (RLS) enforced, and WebSocket events are only emitted after the transaction commits.

---

## Table of Contents

- [Per-Request Transaction Lifecycle](#per-request-transaction-lifecycle)
- [Row Level Security (RLS)](#row-level-security-rls)
- [Authentication](#authentication)
- [Authorization](#authorization)
- [Permission System](#permission-system)
- [Database Schema](#database-schema)
- [Migrations](#migrations)
- [WebSocket Gateway](#websocket-gateway)
- [Race Condition Patterns](#race-condition-patterns)
- [Input Validation](#input-validation)

---

## Per-Request Transaction Lifecycle

This is the most important pattern in the codebase. Every HTTP request gets its own database client and transaction, ensuring isolation and enabling RLS enforcement.

**Source:** `src/app.ts`

```
    HTTP Request
        |
        v
  +-------------------+
  | onRequest          |  Acquire client from pool, BEGIN transaction
  +-------------------+
        |
        v
  +-------------------+
  | preHandler #1      |  Initialization gate: reject if instance not set up (503)
  +-------------------+
        |
        v
  +-------------------+
  | preHandler #2      |  Auth: verify JWT, set (request).userId
  |                    |  Skips: /health, /auth/*, /instance/*
  +-------------------+
        |
        v
  +-------------------+
  | preHandler #3      |  RLS context (if userId exists):
  |                    |    SET LOCAL ROLE app_user
  |                    |    set_config('app.current_user_id', userId, true)
  +-------------------+
        |
        v
  +-------------------+
  | Route Handler      |  Uses (request).dbClient for all queries
  |                    |  Stashes events in (request).pendingEvents
  +-------------------+
        |
    success?
   /        \
  yes        no
  |           |
  v           v
+----------+ +-----------+
| onResponse| | onError   |
| COMMIT    | | ROLLBACK  |
| emit WS   | | release   |
| events    | | client    |
| release   | +-----------+
| client    |
+----------+
```

### Key details

- **Client acquisition**: `onRequest` calls `db.connect()` to get a dedicated `PoolClient`, then immediately `BEGIN`s a transaction. The client is stored on `(request as any).dbClient`.

- **RLS activation**: After the auth middleware sets `userId`, a second `preHandler` runs `SET LOCAL ROLE app_user` and `set_config('app.current_user_id', userId, true)`. `SET LOCAL` scopes the role change to the current transaction only.

- **Pending events queue**: Route handlers never emit Socket.IO events directly. Instead, they push event descriptors onto `(request as any).pendingEvents`:
  ```typescript
  (request as any).pendingEvents = (request as any).pendingEvents || [];
  (request as any).pendingEvents.push({
      room: `channel:${channelId.trim()}`,
      event: 'Message',
      data: message,
  });
  ```

- **Post-commit emission**: The `onResponse` hook first `COMMIT`s, then iterates through `pendingEvents` and emits each one via Socket.IO. This guarantees clients never receive events for data that hasn't been committed.

- **ServerJoin room-join-before-emit**: When emitting a `ServerJoin` event, the `onResponse` hook first joins the user's sockets into the new channel rooms *before* emitting the event, preventing a race where the user could miss early channel events.

- **Pending disconnects**: Admin suspension routes stash user IDs in `(request as any).pendingDisconnects`. After commit, these users are force-disconnected from WebSocket with an `account_suspended` error.

- **Error path**: `onError` runs `ROLLBACK` and releases the client. No events are emitted.

---

## Row Level Security (RLS)

RLS provides defense-in-depth authorization at the database level, independent of application-layer checks.

**Source:** `src/db/migrations/006_row_level_security.sql`

### Roles

| Role | Purpose | RLS? |
|------|---------|------|
| `accord` | Table owner, used by migration runner and pool connection | Bypasses RLS |
| `app_user` | Non-login role, set per-request via `SET LOCAL ROLE` | Subject to RLS |

The `app_user` role is granted to the connection role (`GRANT app_user TO current_user`) so that `SET LOCAL ROLE app_user` works within transactions.

### Helper function

```sql
CREATE OR REPLACE FUNCTION is_server_member(p_server_id CHAR(26), p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER          -- Runs as the function owner (accord), bypassing RLS
SET search_path = public  -- Security best practice
AS $$
    SELECT EXISTS (
        SELECT 1 FROM server_members
        WHERE server_id = p_server_id AND user_id = p_user_id
    );
$$;
```

This function is `SECURITY DEFINER` because RLS on `server_members` would otherwise create a circular dependency: to read `server_members` you'd need to already be a server member.

### Active policies

**server_invites** (RLS enabled):
- `SELECT`: open to all (`USING (true)`) -- anyone can look up an invite code to consume it
- `INSERT`: only members (`is_server_member(server_id, current_user_id)`)
- `UPDATE`: open (`USING (true)`) -- use_count increment allowed for invite consumption

**server_members** (RLS enabled):
- `INSERT`: self-insert only (`user_id = current_user_id`)
- `SELECT`: own rows or co-members (`user_id = current_user_id OR is_server_member(server_id, current_user_id)`)

**channels** (RLS enabled):
- `SELECT`: DM channels open (`server_id IS NULL`), server channels require membership
- `INSERT`: same rule as SELECT

### Per-request RLS activation

```typescript
// src/app.ts, preHandler #3
app.addHook('preHandler', async (request) => {
    const client = (request as any).dbClient;
    const userId = (request as any).userId;
    if (client && userId) {
        await client.query('SET LOCAL ROLE app_user');
        await client.query(
            `SELECT set_config('app.current_user_id', $1, true)`,
            [userId]
        );
    }
});
```

The `true` parameter in `set_config` makes the setting local to the current transaction. When the transaction commits or rolls back, the role and setting are automatically cleared.

---

## Authentication

**Source:** `src/auth/tokens.ts`, `src/auth/passwords.ts`, `src/auth/middleware.ts`

### Password hashing

Passwords are hashed with **Argon2id** (via the `argon2` package, version 0.41+):

```typescript
// src/auth/passwords.ts
import argon2 from 'argon2';

export async function hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
        return await argon2.verify(hash, password);
    } catch {
        return false;
    }
}
```

### JWT tokens

Tokens are signed using `jsonwebtoken` with a configurable secret (`JWT_SECRET` env var, defaults to `dev-secret-do-not-use-in-prod`). Tokens carry a single claim: `{ userId: string }`.

```typescript
// src/auth/tokens.ts
export function generateToken(payload: TokenPayload, secret: string): string {
    return jwt.sign(payload, secret);  // No expiration set (v1 tradeoff)
}

export function verifyToken(token: string, secret: string): TokenPayload {
    return jwt.verify(token, secret) as TokenPayload;
}
```

**v1 tradeoff**: Tokens do not have an expiration. The `sessions` table exists in the schema (with refresh token hashing and expiry columns) but is not yet wired up. Tokens are held in memory only on the frontend.

### Auth middleware

```typescript
// src/auth/middleware.ts
export async function requireAuth(request, reply) {
    // 1. Extract Bearer token from Authorization header
    // 2. Verify JWT signature, extract userId
    // 3. Check account_status in DB:
    //    - 'pending' -> 403 account_pending
    //    - 'suspended' -> 403 account_suspended
    //    - 'active' -> proceed
    // 4. Set (request).userId
}
```

### Instance admin middleware

```typescript
export async function requireInstanceAdmin(request, reply) {
    // Checks users.is_instance_admin flag
    // Returns 403 insufficient_permissions if false
    // Sets (request).isInstanceAdmin = true
}
```

Admin routes use this as a `preHandler`:
```typescript
app.get('/admin/stats', {
    preHandler: [requireInstanceAdmin],
}, handler);
```

---

## Authorization

Authorization is enforced at two layers (defense-in-depth):

### Layer 1: Route-level membership checks

Every route that accesses server resources explicitly checks membership before proceeding:

```typescript
// Standard pattern used across all server-resource routes
const member = await db.query(
    'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
    [serverId, userId]
);
if (member.rows.length === 0) {
    return reply.status(403).send({ error: 'Not a member of this server' });
}
```

For channels, a shared utility handles both server and DM channels:

```typescript
// src/routes/shared.ts
export async function checkChannelMembership(db, channelId, userId): Promise<boolean> {
    // 1. Look up channel to get server_id
    // 2. If server channel: check server_members
    // 3. If DM channel: check channel_members
}
```

### Layer 2: RLS policies at the DB level

Even if a route-level check were accidentally skipped, the RLS policies on `server_members`, `channels`, and `server_invites` would prevent unauthorized data access.

---

## Permission System

**Source:** `src/permissions.ts`

Permissions use a **bigint bitmask** with 27 defined permission types:

| Bit | Permission | Bit | Permission |
|-----|-----------|-----|-----------|
| 0 | Administrator | 14 | UploadFiles |
| 1 | ManageServer | 15 | AddReactions |
| 2 | ManageChannels | 16 | MentionEveryone |
| 3 | ManageRoles | 17 | ReadMessageHistory |
| 4 | ManageEmoji | 18 | UseExternalEmoji |
| 5 | KickMembers | 20 | VoiceConnect |
| 6 | BanMembers | 21 | VoiceSpeak |
| 7 | CreateInvites | 22 | VoiceVideo |
| 8 | ChangeNickname | 23 | VoiceMuteMembers |
| 9 | ManageNicknames | 24 | VoiceDeafenMembers |
| 10 | ViewChannel | 25 | VoiceMoveMembers |
| 11 | SendMessages | 26 | VoicePriority |
| 12 | ManageMessages | | |
| 13 | EmbedLinks | | |

Note: Bit 19 is unused (reserved gap between text and voice permissions).

### Permission computation order

The `computePermissions()` function layers permissions in this order:

1. **Server owner**: If `userId === server.ownerId`, return `ALL_PERMS_MASK` (all 27 bits set).
2. **@everyone role**: Start with the `@everyone` role's permissions bitmask.
3. **Assigned roles**: OR all assigned role permissions together.
4. **Administrator shortcut**: If `Administrator` bit is set, return `ALL_PERMS_MASK`.
5. **@everyone channel override**: Apply the `@everyone` role's channel-specific allow/deny.
6. **Role channel overrides**: Aggregate all role overrides, then apply once.
7. **Member channel override**: Final word -- per-user channel override applied last.

The apply logic for each override step:
```
permissions = (permissions & ~deny) | allow
```

### Default @everyone permissions

New servers' `@everyone` role gets: `ViewChannel`, `SendMessages`, `ReadMessageHistory`, `EmbedLinks`, `UploadFiles`, `AddReactions`, `UseExternalEmoji`, `CreateInvites`, `ChangeNickname`, `VoiceConnect`, `VoiceSpeak`, `VoiceVideo`.

---

## Database Schema

### ID generation

All entities use **ULID** (Universally Unique Lexicographically Sortable Identifier) generated by a monotonic factory (`src/utils/ulid.ts`). ULIDs are 26-character, chronologically sortable strings.

**Important**: ULIDs are stored as `CHAR(26)` in PostgreSQL, which pads with trailing spaces. Always call `.trim()` on DB-returned ID values.

### Core tables

```
users
  id              CHAR(26) PK
  username        VARCHAR(32) UNIQUE
  email           VARCHAR(255) UNIQUE
  password_hash   TEXT (Argon2id)
  display_name    VARCHAR(64)
  avatar_id       CHAR(26)
  status_text     VARCHAR(128)
  status_mode     VARCHAR(12) DEFAULT 'online'
  is_instance_admin  BOOLEAN DEFAULT false
  account_status  VARCHAR(20) DEFAULT 'active'  -- 'active' | 'pending' | 'suspended'
  created_at      TIMESTAMPTZ

sessions
  id              CHAR(26) PK
  user_id         CHAR(26) FK -> users
  token_hash      TEXT
  expires_at      TIMESTAMPTZ
  (Not yet wired up -- v1 uses JWT only)

roles
  id              CHAR(26) PK
  server_id       CHAR(26) FK -> servers (DEFERRABLE INITIALLY DEFERRED)
  name            VARCHAR(64)
  permissions     BIGINT DEFAULT 0
  is_everyone     BOOLEAN DEFAULT false
  position        INTEGER DEFAULT 0
  -- Unique constraint: one @everyone per server

servers
  id              CHAR(26) PK
  name            VARCHAR(100)
  owner_id        CHAR(26) FK -> users
  everyone_role_id CHAR(26) FK -> roles (DEFERRABLE INITIALLY DEFERRED)
  system_channel_id CHAR(26) FK -> channels (DEFERRABLE INITIALLY DEFERRED)

channels
  id              CHAR(26) PK
  channel_type    SMALLINT    -- 0=saved_messages, 1=dm, 2=group_dm,
                              -- 3=server_text, 4=server_voice, 5=server_category
  server_id       CHAR(26) FK -> servers (NULL for DMs)
  name            VARCHAR(100)
  last_message_id CHAR(26)
  position        INTEGER DEFAULT 0
  -- CHECK: server channels require server_id; DMs forbid it

server_members
  server_id       CHAR(26) FK -> servers  \  composite PK
  user_id         CHAR(26) FK -> users    /
  nickname        VARCHAR(64)
  joined_at       TIMESTAMPTZ

member_roles
  server_id       CHAR(26)  \
  user_id         CHAR(26)   > composite PK
  role_id         CHAR(26)  /
  FK (server_id, user_id) -> server_members

messages
  id              CHAR(26) PK (ULID = chronological ordering)
  channel_id      CHAR(26) FK -> channels
  author_id       CHAR(26) FK -> users
  content         TEXT (NULL after soft delete)
  mentions_everyone  BOOLEAN DEFAULT false
  mentioned_role_ids CHAR(26)[]
  edited_at       TIMESTAMPTZ
  deleted_at      TIMESTAMPTZ (soft delete marker)

message_reactions
  message_id      CHAR(26) FK -> messages
  user_id         CHAR(26) FK -> users
  emoji_type      SMALLINT (0=unicode, 1=custom)
  emoji_unicode   TEXT
  emoji_id        CHAR(26) FK -> emojis
  -- CHECK: exactly one of unicode or custom
  -- UNIQUE: (message_id, user_id, emoji_type, emoji_unicode, emoji_id)

channel_unreads
  channel_id      CHAR(26) FK -> channels  \  composite PK
  user_id         CHAR(26) FK -> users     /
  last_read_id    CHAR(26)
  mention_count   INTEGER DEFAULT 0

dm_pairs
  user_a          CHAR(26) FK -> users  \  composite PK
  user_b          CHAR(26) FK -> users  /
  channel_id      CHAR(26) FK -> channels UNIQUE
  -- CHECK: user_a < user_b (lexicographic)
  -- CHECK: user_a != user_b
```

### Additional tables

- **channel_members**: For DM/group DM membership (PK: channel_id, user_id)
- **channel_role_overrides**: Per-channel permission overrides for roles (allow/deny bitmasks)
- **channel_member_overrides**: Per-channel permission overrides for individual users
- **message_mentions**: Direct @user mentions (PK: message_id, user_id)
- **message_attachments**: File attachments on messages (denormalized channel_id for "all images in channel" queries)
- **files**: File registry (bucket + path, no presigned URLs stored)
- **server_invites**: Invite codes with use counting and expiry
- **server_bans**: Ban records with reason and actor
- **relationships**: Friend/block/request status between users
- **audit_log**: Admin action log with before/after change tracking
- **emojis**: Custom server emoji (linked to files)
- **instance_config**: Key-value store for instance-level settings

### Circular foreign key: roles <-> servers

`roles.server_id` references `servers(id)` and `servers.everyone_role_id` references `roles(id)`. Both constraints are `DEFERRABLE INITIALLY DEFERRED`, which means they are checked at transaction commit, not at statement execution. This allows the server creation sequence:

1. Insert `@everyone` role (with server_id that doesn't exist yet)
2. Insert server (with everyone_role_id referencing the role)
3. Both FKs validated at COMMIT

---

## Migrations

**Source:** `src/db/migrate.ts`, `src/db/migrations/`

The custom migration runner reads `.sql` files from `src/db/migrations/`, applies them in sorted order, and tracks applied versions in a `schema_migrations` table. Each migration runs in its own transaction.

| # | File | Description |
|---|------|-------------|
| 001 | `001_core_tables.sql` | Creates `users`, `sessions`, `roles`, `servers` tables. Establishes the circular FK between roles and servers using `DEFERRABLE INITIALLY DEFERRED`. |
| 002 | `002_channels_and_members.sql` | Creates `channels` (with channel_type CHECK constraint), `dm_pairs`, `channel_members`, `server_members`, `member_roles`. Adds category validation trigger. |
| 003 | `003_permissions.sql` | Creates `channel_role_overrides` and `channel_member_overrides` for per-channel permission overrides. |
| 004 | `004_messages.sql` | Creates `files`, `messages` (with full-text search index), `message_attachments`, `message_reactions`, `message_mentions`, `channel_unreads`. |
| 005 | `005_social_and_moderation.sql` | Creates `relationships`, `server_invites`, `server_bans`, `audit_log`, `emojis`. Wires up reaction emoji FK to emojis table. |
| 006 | `006_row_level_security.sql` | Creates the `app_user` role, grants table access, creates the `is_server_member()` SECURITY DEFINER function, and enables RLS policies on `server_invites`, `server_members`, and `channels`. |
| 007 | `007_instance_config.sql` | Creates `instance_config` key-value table with default rows: `setup_complete=false`, `registration_policy=open`, `instance_name=Agora`. |
| 008 | `008_instance_admin.sql` | Adds `is_instance_admin BOOLEAN` column to `users`. |
| 009 | `009_user_account_status.sql` | Adds `account_status VARCHAR(20)` column to `users` with CHECK constraint (`active`, `pending`, `suspended`). Supports registration approval workflows. |
| 010 | `010_nullable_audit_server_id.sql` | Makes `audit_log.server_id` nullable to allow instance-level admin actions that have no server context. |
| 011 | `011_grant_instance_config_to_app_user.sql` | Grants `SELECT, UPDATE` on `instance_config` to `app_user`. Required because the table was created in migration 007, after the blanket `GRANT ALL TABLES` in migration 006. |

---

## WebSocket Gateway

**Source:** `src/gateway.ts`

### Transport

Socket.IO is configured with **WebSocket-only transport** (no HTTP long-polling fallback):

```typescript
const io = new Server(app.server, {
    transports: ['websocket'],
    cors: { origin: '*' },
});
```

### Connection authentication

Two middleware functions run in sequence before `connection`:

1. **Initialization gate**: Queries `instance_config` to verify `setup_complete = 'true'`. Rejects with `instance_not_initialized` error if not.

2. **JWT auth**: Extracts token from `socket.handshake.auth.token`, verifies it, then checks `account_status` in the database:
   - Missing/invalid token -> `Authentication required` / `Invalid token`
   - `account_status = 'pending'` -> `account_pending`
   - `account_status = 'suspended'` -> `account_suspended`

### Connection hydration

On successful connection, the gateway:

1. Joins the `user:{userId}` room (for targeted events like `ServerJoin`)
2. Fetches user info, servers, server channels, DM channels, unread state, and co-member IDs
3. Joins `channel:{channelId}` rooms for all channels
4. Stores channel room IDs on the socket for disconnect cleanup
5. Filters online users to only those sharing a server
6. Emits a **Ready** event with the full hydration payload

### Room structure

| Room pattern | Purpose |
|-------------|---------|
| `channel:{channelId}` | Broadcasting messages, reactions, typing indicators to channel participants |
| `user:{userId}` | Sending targeted events to a specific user (e.g., ServerJoin after accepting an invite) |

### Presence tracking

Presence is tracked in an in-memory `Map<string, Set<string>>` mapping userId to socket IDs. This supports multiple connections per user (tabs/devices):

- **Connect**: If user was not previously online, broadcast `PresenceUpdate { status: 'online' }` to all their channel rooms
- **Disconnect**: Remove socket ID from set. If set becomes empty, broadcast `PresenceUpdate { status: 'offline' }`

### WebSocket events

#### Server -> Client events

| Event | Payload | Trigger |
|-------|---------|---------|
| `Ready` | `{ user, servers[], channels[], unreads[], onlineUserIds[] }` | On connection, after hydration |
| `Message` | `{ id, content, authorId, authorUsername, channelId, createdAt, mentions[], mentionsEveryone }` | POST `/channels/:id/messages` commits |
| `MessageUpdate` | `{ id, channelId, content, editedAt }` | PATCH `/channels/:id/messages/:msgId` commits |
| `MessageDelete` | `{ id, channelId, deletedAt }` | DELETE `/channels/:id/messages/:msgId` commits |
| `ServerJoin` | `{ server: { id, name, ownerId }, channels[] }` | POST `/invites/:code` commits (new member only) |
| `PresenceUpdate` | `{ userId, status: 'online' \| 'offline' }` | Socket connect/disconnect |
| `Typing` | `{ channelId, userId, username }` | Client sends `Typing` event |
| `ReactionAdd` | `{ messageId, channelId, userId, emoji }` | PUT `/channels/:channelId/messages/:msgId/reactions` commits |
| `ReactionRemove` | `{ messageId, channelId, userId, emoji }` | DELETE `/channels/:channelId/messages/:msgId/reactions/:emoji` commits |

#### Ready event payload shape

```typescript
{
    user: {
        id: string,
        username: string,
    },
    servers: [{
        id: string,
        name: string,
        ownerId: string,
    }],
    channels: [{
        id: string,
        name: string,
        channelType: number,
        serverId: string | null,  // null for DM channels
    }],
    unreads: [{
        channelId: string,
        lastReadId: string | null,
        mentionCount: number,
    }],
    onlineUserIds: string[],  // filtered to co-members only
}
```

#### Client -> Server events

| Event | Payload | Effect |
|-------|---------|--------|
| `Typing` | `{ channelId: string }` | Broadcasts `Typing` event to the channel room (excluding sender) |

---

## Race Condition Patterns

### DM creation (SAVEPOINT rollback)

**Source:** `src/routes/dms.ts`

When two users simultaneously try to create a DM with each other:

1. Normalize pair ordering: `user_a < user_b` (lexicographic on trimmed values)
2. `SAVEPOINT dm_create`
3. Speculatively insert a new channel
4. Attempt `INSERT INTO dm_pairs ... ON CONFLICT DO NOTHING RETURNING channel_id`
5. If `RETURNING` gives a row: we won the race, wire up channel members, `RELEASE SAVEPOINT`
6. If `RETURNING` is empty: we lost the race, `ROLLBACK TO SAVEPOINT`, select existing pair

The `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pattern cleanly discards the speculative channel without rolling back the outer per-request transaction.

### Concurrent invite use (FOR UPDATE)

**Source:** `src/routes/auth.ts`

When an invite-only registration validates an invite code:

```sql
SELECT code, server_id, max_uses, use_count, expires_at
FROM server_invites
WHERE code = $1
FOR UPDATE
```

`FOR UPDATE` locks the invite row for the duration of the transaction, preventing concurrent registrations from exceeding `max_uses`.

### Instance setup serialization (advisory lock)

**Source:** `src/routes/instance.ts`

```sql
SELECT pg_advisory_xact_lock(hashtext('instance_setup'))
```

`pg_advisory_xact_lock` acquires an exclusive lock that is held until the transaction commits or rolls back. This serializes concurrent setup attempts even if the `setup_complete` row is missing (e.g., from partial migration or data damage). After acquiring the lock, the handler double-checks `setup_complete` and user count as belt-and-suspenders guards.

### Server creation (SAVEPOINT)

**Source:** `src/routes/servers.ts`

Server creation uses a `SAVEPOINT` because the insert order matters for both deferred FKs and RLS:

1. Insert `@everyone` role (references server that doesn't exist yet -- deferred FK)
2. Insert server (references role -- deferred FK)
3. Insert server member (required before channel insert because RLS checks membership)
4. Insert `#general` channel (RLS passes because membership now exists)

---

## Input Validation

All routes use **Fastify JSON Schema validation** on their route definitions. Fastify automatically returns 400 with a validation error if the request body doesn't match the schema. This prevents unvalidated input from reaching database queries.

Example from message creation:

```typescript
app.post('/channels/:id/messages', {
    schema: {
        body: {
            type: 'object',
            required: ['content'],
            properties: {
                content: { type: 'string', minLength: 1, maxLength: 4000 },
            },
        },
    },
}, handler);
```

Query parameter validation is also used on paginated endpoints:

```typescript
schema: {
    querystring: {
        type: 'object',
        properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: { type: 'string', enum: ['active', 'pending', 'suspended'] },
            search: { type: 'string', minLength: 1 },
        },
    },
}
```

All database queries use **parameterized queries** (`$1`, `$2`, etc.) -- there is no string concatenation of user input into SQL.
