-- The workspace base is the original HEAD, never the HEAD at a later wake.
ALTER TABLE agent_runs ADD COLUMN branch VARCHAR(128), ADD COLUMN base_sha VARCHAR(64), ADD COLUMN head_sha VARCHAR(64);
ALTER TABLE agent_sessions ADD COLUMN branch VARCHAR(128), ADD COLUMN base_sha VARCHAR(64), ADD COLUMN head_sha VARCHAR(64);
