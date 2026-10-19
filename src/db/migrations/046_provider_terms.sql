-- Provider-terms guardrails (docs/provider-terms.md).
--
-- Each hosted agent profile runs its CLI either on the CLI's own account login
-- ('subscription') or on an API key the host passes through its environment ('api_key').
-- The host reports this at start (POST /agent-hosts/@me/profiles); until it does, a
-- profile counts as 'subscription', the stricter mode. Only the server owner can trigger
-- runs on a subscription profile. Only the environment variable's NAME is stored, never
-- a key.
ALTER TABLE agent_profiles ADD COLUMN auth_mode VARCHAR(16) NOT NULL DEFAULT 'subscription'
    CHECK (auth_mode IN ('subscription', 'api_key'));
ALTER TABLE agent_profiles ADD COLUMN api_key_env VARCHAR(64)
    CHECK (api_key_env ~ '^[A-Z][A-Z0-9_]{0,63}$');
-- Every wake needs the owner's approval first (host config: requireRunApproval, forced on
-- for a Gemini profile on account login with allowSubscriptionAtOwnRisk).
ALTER TABLE agent_profiles ADD COLUMN run_approval BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_profiles ADD COLUMN auth_reported_at TIMESTAMPTZ;

-- One owner approval per wake, shown as a card in the session's channel. 'approved'
-- lets the next claim start; the batch it starts keeps the approval for its retries.
CREATE TABLE agent_run_approvals (
    id                 CHAR(26) PRIMARY KEY,
    server_id          CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    session_id         CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    status             VARCHAR(10) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    message_id         CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    decided_by         CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    decided_at         TIMESTAMPTZ,
    consumed_by_batch  CHAR(26) REFERENCES agent_batches(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- At most one open card per session
CREATE UNIQUE INDEX idx_agent_run_approvals_pending ON agent_run_approvals(session_id) WHERE status = 'pending';
CREATE INDEX idx_agent_run_approvals_session ON agent_run_approvals(session_id, status);

-- Written and read only by the server as the table owner, after the route's own checks
ALTER TABLE agent_run_approvals ENABLE ROW LEVEL SECURITY;
