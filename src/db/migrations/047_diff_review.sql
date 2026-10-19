-- 046 reserved for feat/terms-guardrails (main's highest was 045).
CREATE TABLE agent_workspace_commands (
    id CHAR(26) PRIMARY KEY,
    session_id CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    host_id CHAR(26) NOT NULL REFERENCES agent_hosts(id) ON DELETE CASCADE,
    profile_generation INTEGER NOT NULL,
    requested_by CHAR(26) NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('diff','discard','commit','merge','pr','restore','fork')),
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','succeeded','failed')),
    claim_token_hash TEXT,
    lease_until TIMESTAMPTZ,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX agent_workspace_commands_active ON agent_workspace_commands(session_id) WHERE status IN ('queued','claimed');
CREATE TABLE agent_checkpoints (
    id CHAR(26) PRIMARY KEY,
    session_id CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    run_id CHAR(26) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    message_id CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    sha TEXT NOT NULL CHECK (sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
    ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id), UNIQUE (session_id, ref)
);
CREATE INDEX agent_checkpoints_session ON agent_checkpoints(session_id, id DESC);
ALTER TABLE agent_workspace_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_checkpoints ENABLE ROW LEVEL SECURITY;
