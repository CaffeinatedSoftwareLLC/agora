-- ============================================================
-- 004_messages.sql
-- Messages, attachments, reactions, mentions, unreads
-- ============================================================

-- Files registry (referenced by attachments, avatars, icons, etc.)
CREATE TABLE files (
    id              CHAR(26) PRIMARY KEY,
    uploader_id     CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    filename        VARCHAR(255) NOT NULL,
    content_type    VARCHAR(127),
    size_bytes      BIGINT NOT NULL,
    bucket          VARCHAR(64) NOT NULL,
    path            TEXT NOT NULL,  -- S3 object key — URLs generated on demand
    -- GPT fix: do NOT store presigned URLs, they expire.
    -- Store bucket + path, generate URLs at read time.
    sha256          VARCHAR(64),  -- optional integrity check
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_files_uploader ON files(uploader_id);

-- Messages
CREATE TABLE messages (
    id              CHAR(26) PRIMARY KEY,  -- ULID = chronological by default
    channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    author_id       CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    content         TEXT,  -- NULL after soft delete
    embeds          JSONB DEFAULT '[]',  -- link preview data, server-generated
    replies         JSONB DEFAULT '[]',  -- [{ "id": "ulid", "mention": bool }]
    pinned          BOOLEAN DEFAULT false,
    flags           INTEGER DEFAULT 0,
    -- Mention hint flags — cheap to check without joining
    -- GPT fix: @everyone and @role mentions need special handling
    mentions_everyone BOOLEAN DEFAULT false,
    mentioned_role_ids CHAR(26)[] DEFAULT '{}',
    -- These flags allow efficient unread computation:
    -- "unread mentions for user X" = messages after last_read_id WHERE
    --   user is in message_mentions (direct @user)
    --   OR mentions_everyone = true
    --   OR ANY(mentioned_role_ids) IN (user's role IDs)
    
    edited_at       TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,  -- soft delete: content scrubbed, row kept
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Primary query: messages in channel, paginated by ULID
CREATE INDEX idx_messages_channel ON messages(channel_id, id DESC);

-- Full-text search (only non-deleted messages)
CREATE INDEX idx_messages_search ON messages 
    USING gin(to_tsvector('english', content))
    WHERE deleted_at IS NULL;

-- Messages by author (moderation, user data export/deletion)
CREATE INDEX idx_messages_author ON messages(author_id) 
    WHERE deleted_at IS NULL;

-- Message Attachments (denormalized channel_id for "all images in channel" queries)
-- GPT fix: URLs not stored — generate from files.bucket + files.path on demand
CREATE TABLE message_attachments (
    id              CHAR(26) PRIMARY KEY,
    message_id      CHAR(26) REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
    channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    file_id         CHAR(26) REFERENCES files(id) NOT NULL,
    -- Denormalized from files for quick access without join
    filename        VARCHAR(255) NOT NULL,
    content_type    VARCHAR(127),
    size_bytes      BIGINT NOT NULL,
    width           INTEGER,  -- images/video only
    height          INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attachments_message ON message_attachments(message_id);

-- "Show all images in #general" — the whole reason we denormalized channel_id
CREATE INDEX idx_attachments_channel_type 
    ON message_attachments(channel_id, content_type, created_at DESC);

-- Message Reactions
-- GPT fix: typed emoji instead of ambiguous VARCHAR
CREATE TABLE message_reactions (
    message_id      CHAR(26) REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
    user_id         CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    emoji_type      SMALLINT NOT NULL,  -- 0 = unicode, 1 = custom
    emoji_unicode   TEXT,               -- the actual unicode char(s), e.g. '👍'
    emoji_id        CHAR(26),           -- custom emoji ULID (FK added after emojis table)
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    
    -- Enforce exactly one of unicode or custom
    CONSTRAINT chk_reaction_emoji CHECK (
        (emoji_type = 0 AND emoji_unicode IS NOT NULL AND emoji_id IS NULL)
        OR (emoji_type = 1 AND emoji_unicode IS NULL AND emoji_id IS NOT NULL)
    ),
    -- One reaction per user per emoji per message
    -- Using a generated unique key since the PK components vary by type
    CONSTRAINT uq_reaction UNIQUE (message_id, user_id, emoji_type, emoji_unicode, emoji_id)
);

CREATE INDEX idx_reactions_message ON message_reactions(message_id);

-- Message Mentions (direct @user only — source of truth for mention counts)
-- @everyone and @role mentions are tracked via flags on the message itself
CREATE TABLE message_mentions (
    message_id  CHAR(26) REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX idx_mentions_user ON message_mentions(user_id);

-- Channel Unreads
CREATE TABLE channel_unreads (
    channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    user_id         CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    last_read_id    CHAR(26),  -- last acknowledged message ULID
    -- Cached mention count — can be recomputed from message_mentions + message flags
    -- Increment rules:
    --   +1 when message_mentions row inserted for this user
    --   +1 when message with mentions_everyone=true is sent in channel
    --   +1 when message mentions a role this user has
    -- Reset: set to 0 when user acknowledges (updates last_read_id)
    -- Recompute if drift suspected:
    --   SELECT COUNT(*) FROM messages m
    --   LEFT JOIN message_mentions mm ON mm.message_id = m.id AND mm.user_id = ?
    --   WHERE m.channel_id = ? AND m.id > last_read_id AND m.deleted_at IS NULL
    --   AND (mm.user_id IS NOT NULL OR m.mentions_everyone = true 
    --        OR m.mentioned_role_ids && ARRAY[user's role ids])
    mention_count   INTEGER DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
