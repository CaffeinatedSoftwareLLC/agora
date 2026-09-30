-- Files posted by a run through cap-gateway (capped by limits.artifacts).
ALTER TABLE exec_runs ADD COLUMN artifact_count INTEGER NOT NULL DEFAULT 0;
