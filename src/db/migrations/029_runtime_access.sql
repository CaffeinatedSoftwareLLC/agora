-- Per-bot sandbox access (sandbox-isolation-spec §10): admins decide whether a bot
-- may submit code at all, and whether its runs need human approval.
--   none     → runs are denied (default)
--   approval → every run waits for a human with ManageBots/Administrator
--   auto     → runs execute once the rules clear them
ALTER TABLE users ADD COLUMN runtime_access VARCHAR(10) NOT NULL DEFAULT 'none'
    CHECK (runtime_access IN ('none', 'approval', 'auto'));

-- Structured data for system messages (e.g. the run approval card): { kind, runId, ... }
ALTER TABLE messages ADD COLUMN system_data JSONB;

-- Runtime retention default (days); null keeps code forever
INSERT INTO instance_settings (key, value) VALUES ('runtime.code_retention_days', '30'::jsonb)
ON CONFLICT DO NOTHING;
