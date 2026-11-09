-- 094: the run time limit a run was claimed with (agent_profiles.run_timeout_sec at claim time,
-- sent to the host as timeoutSeconds). A run the host stops there (run_timeout) gets a notice
-- naming that limit, even when the owner changed the profile's since. NULL: claimed before this.

ALTER TABLE agent_runs ADD COLUMN timeout_sec INTEGER;
