-- Tool presets and approvals for hosted agents (#73), and sleeping through rate limits (#87).
-- 042: PR D (workspace isolation) takes 040 and 041 in parallel.

-- Presets the owner picks in Settings → Agents (readonly, dev, research, or one the host
-- config defines) and tool rules approved "always". The host reads both at every claim.
ALTER TABLE agent_profiles ADD COLUMN tool_presets TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_profiles ADD COLUMN allowed_tools TEXT[] NOT NULL DEFAULT '{}';

-- A session whose CLI hit its rate limit sleeps until this time: its inbox rows are held
-- and delivered together in the first claim after it.
ALTER TABLE agent_sessions ADD COLUMN sleeping_until TIMESTAMPTZ;

-- A tool a hosted run was denied, shown in chat as an approval card. "once" grants the rule
-- to the session's next run (consumed_by_run); "always" adds it to the profile.
CREATE TABLE agent_tool_requests (
    id               CHAR(26) PRIMARY KEY,
    server_id        CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    session_id       CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    profile_id       CHAR(26) NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
    run_id           CHAR(26) REFERENCES agent_runs(id) ON DELETE SET NULL,
    tool             VARCHAR(310) NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'once', 'always', 'denied')),
    message_id       CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    decided_by       CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    decided_at       TIMESTAMPTZ,
    consumed_by_run  CHAR(26) REFERENCES agent_runs(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One open request per tool per session: a repeated denial doesn't post a second card
CREATE UNIQUE INDEX idx_agent_tool_requests_pending ON agent_tool_requests(session_id, tool) WHERE status = 'pending';
CREATE INDEX idx_agent_tool_requests_grants ON agent_tool_requests(session_id) WHERE status = 'once' AND consumed_by_run IS NULL;

-- Written and read only by the server as the table owner, after the route's own checks
ALTER TABLE agent_tool_requests ENABLE ROW LEVEL SECURITY;
