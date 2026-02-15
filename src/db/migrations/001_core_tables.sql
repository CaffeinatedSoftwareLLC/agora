-- ============================================================
-- 001_core_tables.sql
-- Users, sessions, servers, roles
-- ============================================================

-- Users
CREATE TABLE users (
    id              CHAR(26) PRIMARY KEY,
    username        VARCHAR(32) NOT NULL,
    display_name    VARCHAR(64),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,  -- Argon2id
    avatar_id       CHAR(26),
    banner_id       CHAR(26),
    status_text     VARCHAR(128),
    status_mode     VARCHAR(12) DEFAULT 'online',
    profile_bio     TEXT,
    bot             BOOLEAN DEFAULT false,
    flags           INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_users_username UNIQUE (username)
);

CREATE INDEX idx_users_email ON users(email);

-- Sessions (refresh token records — Redis handles active session cache)
CREATE TABLE sessions (
    id              CHAR(26) PRIMARY KEY,
    user_id         CHAR(26) REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    token_hash      TEXT NOT NULL,  -- hashed refresh token, never raw
    device_info     JSONB,
    ip_address      INET,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Roles (created before servers because servers.everyone_role_id references roles)
-- We use DEFERRABLE constraints to handle the circular reference
CREATE TABLE roles (
    id              CHAR(26) PRIMARY KEY,
    server_id       CHAR(26) NOT NULL,  -- FK added after servers table
    name            VARCHAR(64) NOT NULL,
    color           VARCHAR(7),
    hoist           BOOLEAN DEFAULT false,
    position        INTEGER DEFAULT 0,
    permissions     BIGINT DEFAULT 0,
    mentionable     BOOLEAN DEFAULT false,
    is_everyone     BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT uq_roles_server_name UNIQUE (server_id, name)
);

-- Enforce exactly one @everyone role per server
CREATE UNIQUE INDEX uq_one_everyone_per_server 
    ON roles(server_id) WHERE is_everyone = true;

CREATE INDEX idx_roles_server ON roles(server_id);

-- Servers
CREATE TABLE servers (
    id                  CHAR(26) PRIMARY KEY,
    name                VARCHAR(100) NOT NULL,
    description         TEXT,
    owner_id            CHAR(26) REFERENCES users(id) NOT NULL,
    icon_id             CHAR(26),
    banner_id           CHAR(26),
    system_channel_id   CHAR(26),  -- FK added after channels table, DEFERRABLE
    everyone_role_id    CHAR(26) NOT NULL REFERENCES roles(id) DEFERRABLE INITIALLY DEFERRED,
    flags               INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_servers_owner ON servers(owner_id);

-- Now wire roles.server_id FK back to servers
ALTER TABLE roles 
    ADD CONSTRAINT fk_roles_server 
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;
