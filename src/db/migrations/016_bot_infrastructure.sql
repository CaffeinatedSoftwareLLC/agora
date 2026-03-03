-- 016_bot_infrastructure.sql
-- Bot/agent infrastructure: bot users, tokens, channel access, read cursors

-- 1a. Make email/password nullable for bot users
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- 1b. Bot ownership and server scoping
-- Note: users.bot column already exists from core_tables (nullable, default false)
-- Ensure it's NOT NULL for CHECK constraints
UPDATE users SET bot = false WHERE bot IS NULL;
ALTER TABLE users ALTER COLUMN bot SET NOT NULL;
ALTER TABLE users ADD COLUMN bot_owner_id CHAR(26) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN server_id CHAR(26) REFERENCES servers(id) ON DELETE CASCADE;

-- 1b-constraints. Enforce bot AND human row invariants at the DB level.
ALTER TABLE users ADD CONSTRAINT ck_bot_has_server
    CHECK (bot = false OR server_id IS NOT NULL);
ALTER TABLE users ADD CONSTRAINT ck_bot_no_email
    CHECK (bot = false OR email IS NULL);
ALTER TABLE users ADD CONSTRAINT ck_bot_no_password
    CHECK (bot = false OR password_hash IS NULL);
ALTER TABLE users ADD CONSTRAINT ck_human_no_server
    CHECK (bot = true OR server_id IS NULL);
ALTER TABLE users ADD CONSTRAINT ck_human_no_owner
    CHECK (bot = true OR bot_owner_id IS NULL);
ALTER TABLE users ADD CONSTRAINT ck_human_has_email
    CHECK (bot = true OR email IS NOT NULL);
ALTER TABLE users ADD CONSTRAINT ck_human_has_password
    CHECK (bot = true OR password_hash IS NOT NULL);

-- 1c. Bot tokens
CREATE TABLE bot_tokens (
    id              CHAR(26) PRIMARY KEY,
    bot_id          CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    secret_hash     TEXT NOT NULL,
    name            VARCHAR(100),
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_bot_tokens_bot ON bot_tokens(bot_id);

-- 1d. Bot channel access (explicit allowlist)
CREATE TABLE bot_channel_access (
    bot_id          CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    granted_by      CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (bot_id, channel_id)
);

-- 1d-2. Per-channel bot limits
ALTER TABLE channels ADD COLUMN max_bot_hops INTEGER DEFAULT 4;
ALTER TABLE channels ADD COLUMN bot_rate_limit INTEGER DEFAULT 10;

-- 1e. Bot read cursors
CREATE TABLE bot_read_cursors (
    bot_id          CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    last_read_id    CHAR(26) NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (bot_id, channel_id)
);

-- 1f. RLS grants
GRANT SELECT, INSERT, UPDATE, DELETE ON bot_tokens TO app_user;
GRANT SELECT, INSERT, DELETE ON bot_channel_access TO app_user;
GRANT SELECT, INSERT, UPDATE ON bot_read_cursors TO app_user;

-- 1f-2. Additional RLS policy: bots can see channels they have access to via bot_channel_access.
-- PostgreSQL ORs multiple SELECT policies, so this doesn't affect human access.
CREATE OR REPLACE FUNCTION is_bot_channel_member(p_channel_id CHAR(26), p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM bot_channel_access
        WHERE channel_id = p_channel_id AND bot_id = p_user_id
    );
$$;

CREATE POLICY channels_bot_select ON channels
    FOR SELECT TO app_user
    USING (
        is_bot_channel_member(id, current_setting('app.current_user_id', true))
    );

-- 1h. DB integrity triggers

-- Trigger 1: bot_channel_access must target server channels only (not DMs)
CREATE OR REPLACE FUNCTION trg_bot_channel_access_server_only()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM channels WHERE id = NEW.channel_id AND server_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'bot_channel_access: channel % is not a server channel', NEW.channel_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_bot_channel_server_only
    BEFORE INSERT OR UPDATE ON bot_channel_access
    FOR EACH ROW EXECUTE FUNCTION trg_bot_channel_access_server_only();

-- Trigger 2: bot_channel_access bot must belong to same server as channel
CREATE OR REPLACE FUNCTION trg_bot_channel_same_server()
RETURNS TRIGGER AS $$
DECLARE
    v_bot_server CHAR(26);
    v_channel_server CHAR(26);
BEGIN
    SELECT server_id INTO v_bot_server FROM users WHERE id = NEW.bot_id;
    SELECT server_id INTO v_channel_server FROM channels WHERE id = NEW.channel_id;
    IF v_bot_server IS DISTINCT FROM v_channel_server THEN
        RAISE EXCEPTION 'bot_channel_access: bot server (%) != channel server (%)',
            v_bot_server, v_channel_server;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_bot_channel_same_server
    BEFORE INSERT OR UPDATE ON bot_channel_access
    FOR EACH ROW EXECUTE FUNCTION trg_bot_channel_same_server();

-- Trigger 3: bot_tokens.bot_id must reference a bot user
CREATE OR REPLACE FUNCTION trg_bot_tokens_bot_only()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.bot_id AND bot = true
    ) THEN
        RAISE EXCEPTION 'bot_tokens: user % is not a bot', NEW.bot_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_bot_tokens_bot_only
    BEFORE INSERT OR UPDATE ON bot_tokens
    FOR EACH ROW EXECUTE FUNCTION trg_bot_tokens_bot_only();
