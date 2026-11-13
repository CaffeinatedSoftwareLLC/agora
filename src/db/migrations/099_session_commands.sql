-- Agent commands (docs/agent-commands.md): `@claude /compact` in a message becomes a row here,
-- which the session's agent host claims and runs as the CLI's own command (no model turn).
-- Same shape as agent_workspace_commands (047): one active command per session, a claim token,
-- a lease, a result. Service-only: every access is through asService after the route's checks.
CREATE TABLE agent_session_commands (
    id                 CHAR(26) PRIMARY KEY,
    session_id         CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    host_id            CHAR(26) NOT NULL REFERENCES agent_hosts(id) ON DELETE CASCADE,
    profile_generation INTEGER NOT NULL,
    requested_by       CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    -- The message that asked for it, and the thread it was sent in (the result is posted there)
    message_id         CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    thread_id          CHAR(26),
    command            TEXT NOT NULL CHECK (command IN ('compact', 'context', 'clear')),
    status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'succeeded', 'failed')),
    claim_token_hash   TEXT,
    lease_until        TIMESTAMPTZ,
    result             JSONB,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX agent_session_commands_active ON agent_session_commands(session_id) WHERE status IN ('queued', 'claimed');
CREATE INDEX agent_session_commands_session ON agent_session_commands(session_id, id DESC);
ALTER TABLE agent_session_commands ENABLE ROW LEVEL SECURITY;

-- A host that polls for session commands says so (`?v=1`); the server queues a command only for a
-- host that did so lately, so an older agora-host never finds one it can't read.
ALTER TABLE agent_hosts ADD COLUMN session_commands_seen_at TIMESTAMPTZ;
