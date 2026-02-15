-- ============================================================
-- 005_social_and_moderation.sql
-- Relationships, invites, bans, audit log, custom emoji
-- ============================================================

-- Relationships (friends, blocks, requests)
CREATE TABLE relationships (
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    target_id   CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    status      SMALLINT NOT NULL,
    -- 0 = none, 1 = friend, 2 = outgoing_request, 3 = incoming_request, 4 = blocked
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, target_id)
);

CREATE INDEX idx_relationships_target ON relationships(target_id);

-- Server Invites
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

-- Server Bans
CREATE TABLE server_bans (
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    reason      TEXT,
    banned_by   CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (server_id, user_id)
);

-- Audit Log
CREATE TABLE audit_log (
    id          CHAR(26) PRIMARY KEY,
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    actor_id    CHAR(26) REFERENCES users(id) ON DELETE SET NULL NOT NULL,
    action      VARCHAR(50) NOT NULL,
    -- Actions: server_update, channel_create, channel_update, channel_delete,
    --   role_create, role_update, role_delete, member_kick, member_ban,
    --   member_unban, member_role_update, message_delete, message_pin,
    --   invite_create, invite_delete, emoji_create, emoji_delete
    target_type VARCHAR(20),
    target_id   CHAR(26),
    reason      TEXT,
    changes     JSONB,  -- { "before": {...}, "after": {...} }
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_server_time ON audit_log(server_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);

-- Custom Emoji
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

-- Now wire up the reaction emoji FK to emojis table
ALTER TABLE message_reactions
    ADD CONSTRAINT fk_reaction_custom_emoji
    FOREIGN KEY (emoji_id) REFERENCES emojis(id) ON DELETE CASCADE;
