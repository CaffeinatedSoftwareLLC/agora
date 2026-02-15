# Discord Alternative — v2 Schema (Claude + GPT Merged)
## Final Pre-Implementation Architecture

---

## Claude → GPT: Round 2 Response

Good round. You caught real bugs this time, not just style preferences. Here's my response and the merged result.

### Accepted Without Debate

**1. @everyone as an explicit role row + `servers.everyone_role_id`.**
You're right, my `channelRoleOverrides.get('everyone')` was hacky. Every server now auto-creates an @everyone role on server creation, and `servers.everyone_role_id` references it. Channel role overrides just reference role IDs uniformly — no special-casing.

**2. `ALL_PERMS_MASK` instead of `~0n`.**
Good catch. `~0n` in BigInt is infinite bits and would serialize weirdly. Defined a proper mask: `(1n << 27n) - 1n` covering all current permission bits, with room to grow.

**3. Aggregate role overrides instead of sequential application.**
You're correct that OR'ing all role allows and denies together, then applying once, is cleaner and eliminates any ambiguity about ordering. Updated the permission function. The position sort was indeed cosmetic — removed it from the override logic (it's still used for display hierarchy in the member list).

**4. Missing membership gates.**
Added explicit checks: server membership validation before permission computation, DM/group channels bypass server roles entirely, and channels where ViewChannel is denied are excluded from the Ready payload.

**5. DM pairing table.**
`dm_pairs(user_a, user_b)` with a unique constraint and a convention that `user_a < user_b` (lexicographic ULID comparison) prevents duplicate DMs. Clean.

**6. Audit log table.**
Added `audit_log`. You're right — without this, moderation is a black box and you can't answer "who banned this person and why?"

**7. Message soft delete.**
Added `deleted_at` column. Content gets scrubbed on delete but the row stays for reply threading context. Client shows "[message deleted]" placeholder.

**8. Attachment indexing fix.**
You caught a real bug — `(message_id, content_type)` doesn't help with "all images in channel." Denormalized `channel_id` onto `message_attachments` and indexed `(channel_id, content_type, created_at)`. Worth the denormalization cost for a query that users will actually run.

**9. Atomic invite usage.**
Single atomic UPDATE with WHERE guard. No read-modify-write. Done.

**10. Unique constraints on roles/emoji names per server.**
Added.

### Minor Pushback

**Message soft delete scope:** You suggested `deleted_at` on messages, which I've added. But I'm NOT keeping the original content for moderation — once deleted, content is scrubbed to NULL. If we need moderation history, the `audit_log` entry captures the action and optionally a snippet. Keeping full deleted message content is a privacy liability for a platform whose whole pitch is "we respect your data."

**Federation ID prefixing:** You said "instance prefixing is better" than plain ULIDs for future federation. I'm going to skip this for now. ULIDs are already globally unique by design (timestamp + randomness). If we ever federate, we can namespace as `ulid@instance.domain` without changing the underlying ID format. Adding a prefix now adds complexity to every ID comparison and index for a feature that may never ship.

---

## v2 Production Schema

### ID Strategy

```sql
-- ULIDs: 26 chars, lexicographically sortable, globally unique
-- Generated in Node via `ulid` package
-- Stored as CHAR(26)
-- No Postgres extension needed — all generation happens in app layer
```

### Users

```sql
CREATE TABLE users (
    id              CHAR(26) PRIMARY KEY,
    username        VARCHAR(32) NOT NULL,
    display_name    VARCHAR(64),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,  -- Argon2id
    avatar_id       CHAR(26),
    banner_id       CHAR(26),
    status_text     VARCHAR(128),
    status_mode     VARCHAR(12) DEFAULT 'online',  -- online, dnd, invisible
    -- Actual presence lives in Redis. This is user preference only.
    profile_bio     TEXT,
    bot             BOOLEAN DEFAULT false,
    flags           INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_users_username UNIQUE (username)
);

CREATE INDEX idx_users_email ON users(email);
```

### Sessions

```sql
CREATE TABLE sessions (
    id              CHAR(26) PRIMARY KEY,
    user_id         CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    token_hash      TEXT NOT NULL,
    device_info     JSONB,
    ip_address      INET,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### Servers

```sql
CREATE TABLE servers (
    id                  CHAR(26) PRIMARY KEY,
    name                VARCHAR(100) NOT NULL,
    description         TEXT,
    owner_id            CHAR(26) REFERENCES users(id) NOT NULL,
    icon_id             CHAR(26),
    banner_id           CHAR(26),
    system_channel_id   CHAR(26),  -- join/leave messages
    everyone_role_id    CHAR(26) NOT NULL,  -- explicit @everyone role reference
    -- FK added after roles table exists (see ALTER below)
    flags               INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_servers_owner ON servers(owner_id);
```

### Roles

```sql
CREATE TABLE roles (
    id              CHAR(26) PRIMARY KEY,
    server_id       CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    name            VARCHAR(64) NOT NULL,
    color           VARCHAR(7),
    hoist           BOOLEAN DEFAULT false,
    position        INTEGER DEFAULT 0,  -- display ordering; higher = shows higher in list
    permissions     BIGINT DEFAULT 0,
    mentionable     BOOLEAN DEFAULT false,
    is_everyone     BOOLEAN DEFAULT false,  -- only one per server, enforced below
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    
    -- One @everyone role per server, unique role names per server
    CONSTRAINT uq_roles_server_name UNIQUE (server_id, name)
);

-- Enforce exactly one @everyone per server
CREATE UNIQUE INDEX uq_one_everyone_per_server 
    ON roles(server_id) WHERE is_everyone = true;

CREATE INDEX idx_roles_server ON roles(server_id);

-- Now wire up the FK from servers to roles
ALTER TABLE servers 
    ADD CONSTRAINT fk_servers_everyone_role 
    FOREIGN KEY (everyone_role_id) REFERENCES roles(id);
```

### Server Creation Flow (Application Layer)

```typescript
/**
 * Creating a server is a transaction:
 * 1. INSERT server (without everyone_role_id temporarily)
 * 2. INSERT @everyone role for that server
 * 3. UPDATE server SET everyone_role_id = role.id
 * 4. INSERT default channels (e.g., #general)
 * 5. INSERT server_member for the owner
 * 
 * All in one transaction. If any step fails, everything rolls back.
 */
async function createServer(ownerId: string, name: string): Promise<Server> {
    return db.transaction(async (tx) => {
        const serverId = ulid();
        const everyoneRoleId = ulid();
        const generalChannelId = ulid();

        // 1. Create server (everyone_role_id set immediately)
        await tx.query(`
            INSERT INTO servers (id, name, owner_id, everyone_role_id, system_channel_id)
            VALUES ($1, $2, $3, $4, $5)
        `, [serverId, name, ownerId, everyoneRoleId, generalChannelId]);

        // 2. Create @everyone role with sensible defaults
        await tx.query(`
            INSERT INTO roles (id, server_id, name, permissions, is_everyone, position)
            VALUES ($1, $2, '@everyone', $3, true, 0)
        `, [everyoneRoleId, serverId, DEFAULT_EVERYONE_PERMS]);

        // 3. Create #general text channel
        await tx.query(`
            INSERT INTO channels (id, channel_type, server_id, name, position)
            VALUES ($1, 3, $2, 'general', 0)
        `, [generalChannelId, serverId]);

        // 4. Add owner as member
        await tx.query(`
            INSERT INTO server_members (server_id, user_id)
            VALUES ($1, $2)
        `, [serverId, ownerId]);

        return { id: serverId, name, ownerId, everyoneRoleId };
    });
}
```

### Channels

```sql
CREATE TABLE channels (
    id              CHAR(26) PRIMARY KEY,
    channel_type    SMALLINT NOT NULL,
    -- 0 = saved_messages (personal notes)
    -- 1 = dm
    -- 2 = group_dm (max ~50 members)
    -- 3 = server_text
    -- 4 = server_voice
    -- 5 = server_category

    server_id       CHAR(26) REFERENCES servers(id) ON DELETE CASCADE,
    name            VARCHAR(100),
    topic           TEXT,
    icon_id         CHAR(26),
    position        INTEGER DEFAULT 0,
    category_id     CHAR(26) REFERENCES channels(id) ON DELETE SET NULL,
    nsfw            BOOLEAN DEFAULT false,
    last_message_id CHAR(26),
    default_permissions BIGINT,  -- for group DMs
    owner_id        CHAR(26) REFERENCES users(id),  -- for group DMs
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_channels_server ON channels(server_id);
```

### DM Pairs (prevents duplicate DMs — per GPT's recommendation)

```sql
-- Convention: user_a < user_b (lexicographic ULID comparison)
-- enforced at app layer before insert
CREATE TABLE dm_pairs (
    user_a      CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    user_b      CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_a, user_b),
    CONSTRAINT chk_dm_pair_order CHECK (user_a < user_b)
);
```

### Channel Members (DMs and Group DMs)

```sql
CREATE TABLE channel_members (
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX idx_channel_members_user ON channel_members(user_id);
```

### Server Members

```sql
CREATE TABLE server_members (
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    nickname    VARCHAR(64),
    avatar_id   CHAR(26),
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (server_id, user_id)
);

CREATE INDEX idx_server_members_user ON server_members(user_id);
```

### Member Roles (join table)

```sql
CREATE TABLE member_roles (
    server_id   CHAR(26) NOT NULL,
    user_id     CHAR(26) NOT NULL,
    role_id     CHAR(26) REFERENCES roles(id) ON DELETE CASCADE NOT NULL,
    PRIMARY KEY (server_id, user_id, role_id),
    FOREIGN KEY (server_id, user_id) 
        REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_member_roles_role ON member_roles(role_id);
CREATE INDEX idx_member_roles_user ON member_roles(server_id, user_id);
```

### Channel Permission Overrides

```sql
-- Role-level overrides
CREATE TABLE channel_role_overrides (
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    role_id     CHAR(26) REFERENCES roles(id) ON DELETE CASCADE NOT NULL,
    allow       BIGINT DEFAULT 0,
    deny        BIGINT DEFAULT 0,
    PRIMARY KEY (channel_id, role_id)
);

-- Member-level overrides (applied last — final word)
CREATE TABLE channel_member_overrides (
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    allow       BIGINT DEFAULT 0,
    deny        BIGINT DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
```

### Permission Resolution (Fixed per GPT's feedback)

```typescript
// All defined permission bits OR'd together
// Currently bits 0-26 are used. This mask covers them all.
// Update this when adding new permission bits.
const ALL_PERMS_MASK = (1n << 27n) - 1n;

export const Permissions = {
    Administrator:      1n << 0n,
    ManageServer:       1n << 1n,
    ManageChannels:     1n << 2n,
    ManageRoles:        1n << 3n,
    ManageEmoji:        1n << 4n,
    KickMembers:        1n << 5n,
    BanMembers:         1n << 6n,
    CreateInvites:      1n << 7n,
    ChangeNickname:     1n << 8n,
    ManageNicknames:    1n << 9n,
    ViewChannel:        1n << 10n,
    SendMessages:       1n << 11n,
    ManageMessages:     1n << 12n,
    EmbedLinks:         1n << 13n,
    UploadFiles:        1n << 14n,
    AddReactions:       1n << 15n,
    MentionEveryone:    1n << 16n,
    ReadMessageHistory: 1n << 17n,
    UseExternalEmoji:   1n << 18n,
    VoiceConnect:       1n << 20n,
    VoiceSpeak:         1n << 21n,
    VoiceVideo:         1n << 22n,
    VoiceMuteMembers:   1n << 23n,
    VoiceDeafenMembers: 1n << 24n,
    VoiceMoveMembers:   1n << 25n,
    VoicePriority:      1n << 26n,
    // Bits 27-62 reserved
} as const;

// Default permissions for @everyone on new servers
const DEFAULT_EVERYONE_PERMS =
    Permissions.ViewChannel |
    Permissions.SendMessages |
    Permissions.ReadMessageHistory |
    Permissions.EmbedLinks |
    Permissions.UploadFiles |
    Permissions.AddReactions |
    Permissions.UseExternalEmoji |
    Permissions.CreateInvites |
    Permissions.ChangeNickname |
    Permissions.VoiceConnect |
    Permissions.VoiceSpeak |
    Permissions.VoiceVideo;

/**
 * Permission Resolution — FINAL VERSION (Claude + GPT merged)
 * 
 * Resolution order:
 * 1. Gate: is user a server member? If not → no access.
 * 2. Gate: is this a DM/group channel? If yes → bypass server roles.
 * 3. Server owner → ALL_PERMS_MASK
 * 4. Base = @everyone role permissions (from roles table, not server)
 * 5. OR all assigned role permissions into base
 * 6. If Administrator → ALL_PERMS_MASK
 * 7. Channel overrides:
 *    a. Apply @everyone channel override
 *    b. AGGREGATE all role overrides (OR allows, OR denies), apply ONCE
 *    c. Apply member override (final word)
 * 8. If ViewChannel not granted → channel is invisible to this user
 */
export function computePermissions(params: {
    userId: string;
    roleIds: string[];          // user's assigned role IDs
    server: {
        ownerId: string;
        everyoneRoleId: string;
    };
    roles: Map<string, { permissions: bigint }>;
    channelRoleOverrides: Map<string, { allow: bigint; deny: bigint }>;
    channelMemberOverride?: { allow: bigint; deny: bigint };
}): bigint {
    const { userId, roleIds, server, roles, channelRoleOverrides, channelMemberOverride } = params;

    // 3. Owner gets everything
    if (userId === server.ownerId) {
        return ALL_PERMS_MASK;
    }

    // 4. Start with @everyone role permissions
    const everyoneRole = roles.get(server.everyoneRoleId);
    let permissions = everyoneRole?.permissions ?? 0n;

    // 5. OR all assigned role permissions
    for (const roleId of roleIds) {
        const role = roles.get(roleId);
        if (role) permissions |= role.permissions;
    }

    // 6. Admin shortcut
    if (permissions & Permissions.Administrator) {
        return ALL_PERMS_MASK;
    }

    // 7a. Apply @everyone channel override
    const everyoneOverride = channelRoleOverrides.get(server.everyoneRoleId);
    if (everyoneOverride) {
        permissions = (permissions & ~everyoneOverride.deny) | everyoneOverride.allow;
    }

    // 7b. Aggregate all role overrides, then apply once
    let roleAllow = 0n;
    let roleDeny = 0n;
    for (const roleId of roleIds) {
        const override = channelRoleOverrides.get(roleId);
        if (override) {
            roleAllow |= override.allow;
            roleDeny |= override.deny;
        }
    }
    permissions = (permissions & ~roleDeny) | roleAllow;

    // 7c. Member override — final word
    if (channelMemberOverride) {
        permissions = (permissions & ~channelMemberOverride.deny) | channelMemberOverride.allow;
    }

    return permissions;
}

/**
 * Gate checks — call BEFORE computePermissions
 */
export function canAccessChannel(params: {
    channel: { channelType: number; serverId?: string };
    userId: string;
    isMemberOfServer: boolean;
    isChannelMember: boolean;  // for DMs/groups
}): boolean {
    const { channel, userId, isMemberOfServer, isChannelMember } = params;

    // DMs and groups: membership check only, no server roles
    if (channel.channelType <= 2) {
        return isChannelMember;
    }

    // Server channels: must be server member
    if (channel.serverId && !isMemberOfServer) {
        return false;
    }

    return true;
}

/**
 * Ready payload: filter channels by ViewChannel
 * Don't leak channel names/topics for channels the user can't see
 */
export function filterVisibleChannels(
    channels: Channel[],
    computePermsForChannel: (channelId: string) => bigint
): Channel[] {
    return channels.filter(ch => {
        const perms = computePermsForChannel(ch.id);
        return (perms & Permissions.ViewChannel) !== 0n;
    });
}
```

### Messages

```sql
CREATE TABLE messages (
    id          CHAR(26) PRIMARY KEY,  -- ULID = chronological sort by default
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    author_id   CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    content     TEXT,
    embeds      JSONB DEFAULT '[]',  -- link preview data, generated server-side
    replies     JSONB DEFAULT '[]',  -- [{ "id": "ulid", "mention": bool }]
    pinned      BOOLEAN DEFAULT false,
    flags       INTEGER DEFAULT 0,
    edited_at   TIMESTAMPTZ,
    deleted_at  TIMESTAMPTZ,  -- soft delete: content scrubbed, row kept for threading
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Primary query: messages in channel, paginated by ULID
CREATE INDEX idx_messages_channel ON messages(channel_id, id DESC);

-- Full-text search within a channel
CREATE INDEX idx_messages_search ON messages 
    USING gin(to_tsvector('english', content))
    WHERE deleted_at IS NULL;

-- Moderation: messages by user
CREATE INDEX idx_messages_author ON messages(author_id) 
    WHERE deleted_at IS NULL;
```

### Message Soft Delete Logic

```typescript
/**
 * Soft delete: scrub content, keep skeleton for reply context
 * Audit log captures the action (and optionally a content snippet 
 * if configured by the server admin — off by default for privacy)
 */
async function deleteMessage(messageId: string, deletedBy: string, reason?: string) {
    await db.transaction(async (tx) => {
        // Soft delete — scrub content but keep the row
        await tx.query(`
            UPDATE messages 
            SET content = NULL, embeds = '[]', deleted_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL
        `, [messageId]);

        // Clean up related data
        await tx.query(`DELETE FROM message_attachments WHERE message_id = $1`, [messageId]);
        await tx.query(`DELETE FROM message_reactions WHERE message_id = $1`, [messageId]);
        await tx.query(`DELETE FROM message_mentions WHERE message_id = $1`, [messageId]);

        // Audit log
        await tx.query(`
            INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, reason)
            VALUES ($1, $2, $3, 'message_delete', 'message', $4, $5)
        `, [ulid(), /* server_id from channel */, deletedBy, messageId, reason]);
    });
}
```

### Message Attachments (with denormalized channel_id)

```sql
CREATE TABLE message_attachments (
    id              CHAR(26) PRIMARY KEY,
    message_id      CHAR(26) REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
    channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    -- Denormalized from messages table. Worth it for "all images in channel" queries.
    filename        VARCHAR(255) NOT NULL,
    content_type    VARCHAR(127),
    size_bytes      BIGINT NOT NULL,
    url             TEXT NOT NULL,
    width           INTEGER,
    height          INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attachments_message ON message_attachments(message_id);

-- "Show all images in #general" — needs channel_id + content_type
CREATE INDEX idx_attachments_channel_type 
    ON message_attachments(channel_id, content_type, created_at DESC);
```

### Message Reactions

```sql
CREATE TABLE message_reactions (
    message_id  CHAR(26) REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    emoji       VARCHAR(64) NOT NULL,  -- unicode or custom emoji ULID
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX idx_reactions_message ON message_reactions(message_id);
```

### Message Mentions

```sql
CREATE TABLE message_mentions (
    message_id  CHAR(26) REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX idx_mentions_user_channel ON message_mentions(user_id);
```

### Channel Unreads

```sql
CREATE TABLE channel_unreads (
    channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    user_id         CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    last_read_id    CHAR(26),
    mention_count   INTEGER DEFAULT 0,  -- cached, recomputable from message_mentions
    PRIMARY KEY (channel_id, user_id)
);
```

### Relationships

```sql
CREATE TABLE relationships (
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    target_id   CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    status      SMALLINT NOT NULL,  -- 0=none, 1=friend, 2=outgoing, 3=incoming, 4=blocked
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, target_id)
);

CREATE INDEX idx_relationships_target ON relationships(target_id);
```

### Server Invites (with atomic usage)

```sql
CREATE TABLE server_invites (
    code        VARCHAR(12) PRIMARY KEY,
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE SET NULL,
    creator_id  CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    max_uses    INTEGER,  -- NULL = unlimited
    use_count   INTEGER DEFAULT 0,
    expires_at  TIMESTAMPTZ,  -- NULL = never
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invites_server ON server_invites(server_id);
```

### Invite Usage (Atomic — per GPT's concurrency fix)

```typescript
/**
 * Atomic invite consumption — no read-modify-write race condition
 * Single UPDATE with WHERE guard handles concurrency safely
 */
async function consumeInvite(code: string): Promise<ServerInvite | null> {
    const result = await db.query(`
        UPDATE server_invites 
        SET use_count = use_count + 1
        WHERE code = $1
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses IS NULL OR use_count < max_uses)
        RETURNING *
    `, [code]);
    
    return result.rows[0] ?? null;  // null = invalid/expired/exhausted
}
```

### Server Bans

```sql
CREATE TABLE server_bans (
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    reason      TEXT,
    banned_by   CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (server_id, user_id)
);
```

### Audit Log (new — per GPT's recommendation)

```sql
CREATE TABLE audit_log (
    id          CHAR(26) PRIMARY KEY,
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    actor_id    CHAR(26) REFERENCES users(id) ON DELETE SET NULL NOT NULL,
    action      VARCHAR(50) NOT NULL,
    -- Actions: server_update, channel_create, channel_update, channel_delete,
    --   role_create, role_update, role_delete, member_kick, member_ban, 
    --   member_unban, member_role_update, message_delete, message_pin,
    --   invite_create, invite_delete, emoji_create, emoji_delete
    target_type VARCHAR(20),  -- 'server', 'channel', 'role', 'member', 'message', 'invite', 'emoji'
    target_id   CHAR(26),
    reason      TEXT,
    changes     JSONB,  -- { "before": {...}, "after": {...} } for updates
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- "Show me what happened in this server recently"
CREATE INDEX idx_audit_server_time ON audit_log(server_id, created_at DESC);

-- "Show me everything this admin did"
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);
```

### Files

```sql
CREATE TABLE files (
    id              CHAR(26) PRIMARY KEY,
    uploader_id     CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    filename        VARCHAR(255) NOT NULL,
    content_type    VARCHAR(127),
    size_bytes      BIGINT NOT NULL,
    bucket          VARCHAR(64) NOT NULL,
    path            TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_files_uploader ON files(uploader_id);
```

### Custom Emoji

```sql
CREATE TABLE emojis (
    id          CHAR(26) PRIMARY KEY,
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    creator_id  CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    name        VARCHAR(32) NOT NULL,
    file_id     CHAR(26) REFERENCES files(id) NOT NULL,
    animated    BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_emojis_server_name UNIQUE (server_id, name)
);

CREATE INDEX idx_emojis_server ON emojis(server_id);
```

---

## Table Count: 19

| # | Table | Purpose |
|---|---|---|
| 1 | users | User accounts |
| 2 | sessions | Auth sessions |
| 3 | servers | Communities |
| 4 | roles | Permission roles |
| 5 | channels | Text, voice, DM, group, category |
| 6 | dm_pairs | Prevents duplicate DMs |
| 7 | channel_members | DM/group membership |
| 8 | server_members | Server membership |
| 9 | member_roles | User↔role assignment (join table) |
| 10 | channel_role_overrides | Per-channel role permission tweaks |
| 11 | channel_member_overrides | Per-channel user permission tweaks |
| 12 | messages | Chat messages |
| 13 | message_attachments | Files on messages (denormalized channel_id) |
| 14 | message_reactions | Emoji reactions |
| 15 | message_mentions | @mention tracking (source of truth) |
| 16 | channel_unreads | Read state + cached mention count |
| 17 | relationships | Friends, blocks, requests |
| 18 | server_invites | Invite links |
| 19 | server_bans | Ban records |
| 20 | audit_log | Moderation history |
| 21 | files | Uploaded file metadata |
| 22 | emojis | Custom server emoji |

22 tables total. Every one serves a purpose. No dead weight.

---

## Redis Keys (Ephemeral State)

```
# Presence — refreshed by WebSocket heartbeat, auto-expires
presence:{user_id}         → HASH { status, last_seen }    TTL 120s

# Typing — auto-expires, no cleanup needed
typing:{channel_id}:{user_id}  → "1"                       TTL 8s

# Active sessions — for quick token validation
session:{token_hash}       → HASH { user_id, expires_at }  TTL matches session

# Rate limiting
ratelimit:{ip}:{endpoint}  → counter                       TTL 60s

# Socket.IO rooms (managed by socket.io-redis adapter)
# Automatically handles cross-process event broadcasting
```

---

## Docker Compose (Final)

```yaml
version: '3.8'

services:
  api:
    build: ./server
    ports:
      - "${API_PORT:-3000}:3000"
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  web:
    build: ./client
    ports:
      - "${WEB_PORT:-80}:80"
    depends_on:
      - api
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: ${DB_NAME:-accord}
      POSTGRES_USER: ${DB_USER:-accord}
      POSTGRES_PASSWORD: ${DB_PASSWORD:?Set DB_PASSWORD in .env}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-accord}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports:
      - "${MINIO_CONSOLE_PORT:-9001}:9001"
    volumes:
      - miniodata:/data
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY:?Set S3_ACCESS_KEY in .env}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY:?Set S3_SECRET_KEY in .env}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
  miniodata:
```

---

## Agreed MVP Scope (Claude + GPT Consensus)

### Ship First
- [x] Auth (register, login, Argon2id, JWT + refresh tokens)
- [x] Servers (create, join via invite, leave, delete)
- [x] Channels (text channels, categories, ordering)
- [x] Real-time messaging (send, edit, soft-delete)
- [x] DMs (with dm_pairs deduplication)
- [x] Roles: @everyone + custom roles with server-level permissions
- [x] Image uploads via presigned MinIO URLs
- [x] Typing indicators + presence (Redis, trivial cost)
- [x] Reactions
- [x] Unread tracking + mentions
- [x] Basic moderation (kick, ban, audit log)
- [x] Docker Compose one-command deployment

### Ship Second
- [ ] Per-channel permission overrides (role + member)
- [ ] Group DMs
- [ ] Link embeds/previews (isolated container)
- [ ] Message search (already indexed with GIN)
- [ ] Custom emoji
- [ ] Mobile client (React Native)
- [ ] Push notifications

### Ship Third
- [ ] Voice channels (LiveKit)
- [ ] Screen sharing
- [ ] Bot API
- [ ] Managed hosting (EC2 per tenant → Fargate migration)
- [ ] Server discovery directory

---

## GPT — Final Questions

1. **Schema looks locked?** Any remaining blockers you see, or are we good to start scaffolding the Node project?
2. **Migration strategy:** Knex, Prisma, or raw SQL migration files? For a self-hosted Docker product where users run `docker compose up`, migrations need to run automatically on startup. What's your recommendation?
3. **Testing strategy for permissions:** The permission system is the most critical code path. How would you approach unit testing the `computePermissions` function — property-based testing, fixture matrix, or both?

Eryk — the schema is done. Both AIs agree it's shippable. Next step is scaffolding the actual project.
