-- ============================================================
-- 002_channels_and_members.sql
-- Channels, DM pairs, channel members, server members, member roles
-- ============================================================

-- Channels
CREATE TABLE channels (
    id              CHAR(26) PRIMARY KEY,
    channel_type    SMALLINT NOT NULL,
    -- 0 = saved_messages
    -- 1 = dm
    -- 2 = group_dm
    -- 3 = server_text
    -- 4 = server_voice
    -- 5 = server_category

    server_id       CHAR(26) REFERENCES servers(id) ON DELETE CASCADE,
    name            VARCHAR(100),
    topic           TEXT,
    icon_id         CHAR(26),
    position        INTEGER DEFAULT 0,
    category_id     CHAR(26),  -- validated by trigger, not simple FK
    nsfw            BOOLEAN DEFAULT false,
    last_message_id CHAR(26),
    default_permissions BIGINT,  -- for group DMs
    owner_id        CHAR(26) REFERENCES users(id),  -- for group DMs
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    -- Server channels must have a server_id, non-server channels must not
    CONSTRAINT chk_channel_server CHECK (
        (channel_type IN (3, 4, 5) AND server_id IS NOT NULL)
        OR (channel_type IN (0, 1, 2) AND server_id IS NULL)
    )
);

CREATE INDEX idx_channels_server ON channels(server_id);

-- Wire up servers.system_channel_id FK now that channels exists
ALTER TABLE servers
    ADD CONSTRAINT fk_servers_system_channel
    FOREIGN KEY (system_channel_id) REFERENCES channels(id)
    DEFERRABLE INITIALLY DEFERRED;

-- Category validation trigger
-- Ensures category_id only references a category channel in the same server
CREATE OR REPLACE FUNCTION validate_category_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.category_id IS NOT NULL THEN
        -- Verify the target is a category (type 5) in the same server
        IF NOT EXISTS (
            SELECT 1 FROM channels 
            WHERE id = NEW.category_id 
              AND channel_type = 5 
              AND server_id = NEW.server_id
        ) THEN
            RAISE EXCEPTION 'category_id must reference a category channel in the same server';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_category_id
    BEFORE INSERT OR UPDATE ON channels
    FOR EACH ROW
    WHEN (NEW.category_id IS NOT NULL)
    EXECUTE FUNCTION validate_category_id();

-- DM Pairs — prevents duplicate DMs between same two users
CREATE TABLE dm_pairs (
    user_a      CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    user_b      CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_a, user_b),
    -- Convention: user_a < user_b (lexicographic), enforced at app layer + here
    CONSTRAINT chk_dm_pair_order CHECK (user_a < user_b),
    -- Can't DM yourself
    CONSTRAINT chk_dm_pair_distinct CHECK (user_a <> user_b)
);

-- Channel Members (DMs and group DMs)
CREATE TABLE channel_members (
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX idx_channel_members_user ON channel_members(user_id);

-- Server Members
CREATE TABLE server_members (
    server_id   CHAR(26) REFERENCES servers(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    nickname    VARCHAR(64),
    avatar_id   CHAR(26),
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (server_id, user_id)
);

CREATE INDEX idx_server_members_user ON server_members(user_id);

-- Member Roles (join table — NOT an array column)
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
