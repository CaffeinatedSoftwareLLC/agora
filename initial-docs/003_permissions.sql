-- ============================================================
-- 003_permissions.sql
-- Channel-level permission overrides (role + member)
-- ============================================================

-- Role-level channel overrides
CREATE TABLE channel_role_overrides (
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    role_id     CHAR(26) REFERENCES roles(id) ON DELETE CASCADE NOT NULL,
    allow       BIGINT DEFAULT 0,
    deny        BIGINT DEFAULT 0,
    PRIMARY KEY (channel_id, role_id)
);

-- Member-level channel overrides (applied last — final word)
CREATE TABLE channel_member_overrides (
    channel_id  CHAR(26) REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
    user_id     CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    allow       BIGINT DEFAULT 0,
    deny        BIGINT DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
