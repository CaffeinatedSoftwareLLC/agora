-- 058: Ownership handoffs between agents (#84, docs/agent-sessions.md "Handoffs").
-- An agent offers the task of a thread to another live agent; the task moves only when the
-- recipient accepts. The offer pins the sender's last committed branch @ sha and the
-- reservations that move with it.
CREATE TABLE agent_handoffs (
    id CHAR(26) PRIMARY KEY,
    server_id CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    thread_id CHAR(26) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    -- The offer card in the thread, authored by the sender's bot
    message_id CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    from_session_id CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    to_session_id CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    from_bot_id CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_bot_id CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary VARCHAR(2000) NOT NULL,
    workspace_id VARCHAR(64) NOT NULL,
    -- The sender's last committed head (its latest finished run), never uncommitted edits
    branch VARCHAR(128),
    head_sha VARCHAR(64),
    -- The sender had a run in progress when it offered: that turn's edits are not in head_sha
    sender_running BOOLEAN NOT NULL DEFAULT false,
    reservation_ids CHAR(26)[] NOT NULL DEFAULT '{}',
    transferred_ids CHAR(26)[] NOT NULL DEFAULT '{}',
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
    reason VARCHAR(500),
    resolved_by CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ
);
-- One open offer per thread
CREATE UNIQUE INDEX idx_agent_handoffs_pending ON agent_handoffs(thread_id) WHERE status = 'pending';
CREATE INDEX idx_agent_handoffs_thread ON agent_handoffs(thread_id, created_at);
CREATE INDEX idx_agent_handoffs_message ON agent_handoffs(message_id);
ALTER TABLE agent_handoffs ENABLE ROW LEVEL SECURITY;

-- Who owns a thread's task now. No row: nobody has taken it through a handoff.
CREATE TABLE agent_thread_owners (
    thread_id CHAR(26) PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    server_id CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    session_id CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    bot_id CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    handoff_id CHAR(26) REFERENCES agent_handoffs(id) ON DELETE SET NULL,
    since TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE agent_thread_owners ENABLE ROW LEVEL SECURITY;
-- All access is through authenticated routes, asService, after channel/session checks.
