-- Agent sessions: an agent host on the owner's machine wakes agents headlessly when
-- something in a channel is addressed to them (docs/planning/agent-sessions-wbs.md).
--
-- Members read profiles and sessions through RLS. Every write goes through the server
-- (src/lib/agent-sessions.ts) as the service role, after the route's own authority
-- check; app_user gets no write grants here. Hosts authenticate with their own token
-- and never act as a user.

-- ─── Hosts: one per machine that runs agents ───
CREATE TABLE agent_hosts (
    id            CHAR(26) PRIMARY KEY,
    server_id     CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name          VARCHAR(64) NOT NULL,
    -- Token: ah_<id>.<secret>; only the secret's hash is kept
    secret_hash   TEXT NOT NULL,
    created_by    CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_agent_hosts_name ON agent_hosts(server_id, lower(name)) WHERE revoked_at IS NULL;

-- ─── Profiles: what /start <name> starts ───
-- The host maps workdir_alias to a directory and adapter to an executable; the server
-- never sends paths, flags or shell. Changing adapter, host or workdir bumps generation.
CREATE TABLE agent_profiles (
    id               CHAR(26) PRIMARY KEY,
    server_id        CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name             VARCHAR(32) NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]*$'),
    bot_id           CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_id          CHAR(26) NOT NULL REFERENCES agent_hosts(id) ON DELETE CASCADE,
    adapter          VARCHAR(16) NOT NULL CHECK (adapter IN ('codex', 'claude')),
    model            VARCHAR(64),
    effort           VARCHAR(16) CHECK (effort IN ('low', 'medium', 'high', 'xhigh')),
    workdir_alias    VARCHAR(64) NOT NULL CHECK (workdir_alias ~ '^[A-Za-z0-9_-]+$'),
    wake_budget      INTEGER NOT NULL DEFAULT 50 CHECK (wake_budget > 0),
    token_budget     BIGINT NOT NULL DEFAULT 2000000 CHECK (token_budget > 0),
    run_timeout_sec  INTEGER NOT NULL DEFAULT 900 CHECK (run_timeout_sec BETWEEN 60 AND 7200),
    generation       INTEGER NOT NULL DEFAULT 1,
    created_by       CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, name)
);

-- ─── Sessions: one agent in one channel ───
CREATE TABLE agent_sessions (
    id                 CHAR(26) PRIMARY KEY,
    server_id          CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id         CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    bot_id             CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id         CHAR(26) NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
    state              VARCHAR(8) NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'shelved', 'ended')),
    end_reason         VARCHAR(16) CHECK (end_reason IN ('user', 'budget', 'replaced', 'access_lost')),
    native_session_id  VARCHAR(128),
    summary            TEXT,
    wakes_used         INTEGER NOT NULL DEFAULT 0,
    tokens_used        BIGINT NOT NULL DEFAULT 0,
    started_by         CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    shelved_at         TIMESTAMPTZ,
    ended_at           TIMESTAMPTZ
);
-- At most one live session per agent per channel
CREATE UNIQUE INDEX idx_agent_sessions_live ON agent_sessions(channel_id, bot_id) WHERE state = 'live';
CREATE INDEX idx_agent_sessions_channel ON agent_sessions(channel_id, state, last_active_at DESC);
CREATE INDEX idx_agent_sessions_profile ON agent_sessions(profile_id);

-- ─── Collaboration threads opened inside sessions ───
CREATE TABLE agent_session_threads (
    thread_id             CHAR(26) PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id            CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    initiator_session_id  CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    session_ids           TEXT[] NOT NULL,
    state                 VARCHAR(8) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at             TIMESTAMPTZ
);

-- ─── Delivery batches: the messages one wake handles; immutable once created ───
CREATE TABLE agent_batches (
    id            CHAR(26) PRIMARY KEY,
    session_id    CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    delivery_key  VARCHAR(40) NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    status        VARCHAR(8) NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'retry', 'done', 'failed', 'dropped')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ
);
CREATE INDEX idx_agent_batches_retry ON agent_batches(session_id) WHERE status = 'retry';

-- ─── Inbox: written in the same transaction as the message ───
CREATE TABLE agent_inbox (
    id          CHAR(26) PRIMARY KEY,
    session_id  CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    message_id  CHAR(26) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    thread_id   CHAR(26) REFERENCES messages(id) ON DELETE CASCADE,
    -- 'command': the session notice a /start or /resume posts, so the agent wakes and says hello
    reason      VARCHAR(8) NOT NULL CHECK (reason IN ('direct', 'handoff', 'protocol', 'command')),
    batch_id    CHAR(26) REFERENCES agent_batches(id) ON DELETE SET NULL,
    acked_at    TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, message_id)
);
CREATE INDEX idx_agent_inbox_pending ON agent_inbox(session_id, id) WHERE batch_id IS NULL AND acked_at IS NULL;
CREATE INDEX idx_agent_inbox_batch ON agent_inbox(batch_id);

-- ─── Runs: one claim of a batch by a host ───
CREATE TABLE agent_runs (
    id                  CHAR(26) PRIMARY KEY,
    batch_id            CHAR(26) NOT NULL REFERENCES agent_batches(id) ON DELETE CASCADE,
    session_id          CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    host_id             CHAR(26) NOT NULL REFERENCES agent_hosts(id) ON DELETE CASCADE,
    claim_token_hash    CHAR(64) NOT NULL,
    attempt             INTEGER NOT NULL,
    profile_generation  INTEGER NOT NULL,
    status              VARCHAR(10) NOT NULL DEFAULT 'claimed'
                        CHECK (status IN ('claimed', 'succeeded', 'failed', 'expired')),
    lease_until         TIMESTAMPTZ NOT NULL,
    cancel_requested    BOOLEAN NOT NULL DEFAULT false,
    cancel_reason       VARCHAR(20),
    native_session_id   VARCHAR(128),
    tokens_used         BIGINT,
    summary             TEXT,
    error               VARCHAR(64),
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ
);
-- At most one claimed run per session
CREATE UNIQUE INDEX idx_agent_runs_claimed ON agent_runs(session_id) WHERE status = 'claimed';
CREATE INDEX idx_agent_runs_lease ON agent_runs(lease_until) WHERE status = 'claimed';

-- ─── Durable duplicate protection for posts (agents retry after a crash) ───
ALTER TABLE messages ADD COLUMN client_key VARCHAR(100);
CREATE UNIQUE INDEX idx_messages_client_key ON messages(author_id, client_key) WHERE client_key IS NOT NULL;

-- ─── Member read access ───
ALTER TABLE agent_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_profiles_select ON agent_profiles
    FOR SELECT TO app_user
    USING (is_server_member(server_id, current_setting('app.current_user_id', true)));

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_sessions_select ON agent_sessions
    FOR SELECT TO app_user
    USING (is_server_member(server_id, current_setting('app.current_user_id', true)));

ALTER TABLE agent_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON agent_profiles, agent_sessions TO app_user;
