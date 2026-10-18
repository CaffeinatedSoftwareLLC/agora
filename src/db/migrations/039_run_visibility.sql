-- Run visibility (#72, #82) and per-session token budgets (#81).
ALTER TABLE agent_runs ADD COLUMN changed_paths TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_sessions ADD COLUMN token_budget BIGINT CHECK (token_budget > 0);
CREATE INDEX idx_agent_runs_session_recent ON agent_runs(session_id, created_at DESC, id DESC);
