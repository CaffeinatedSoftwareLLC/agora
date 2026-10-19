-- 044 is reserved by feat/auth-passkeys.
ALTER TABLE agent_sessions ADD COLUMN lurk_mode VARCHAR(8)
    CHECK (lurk_mode IN ('quiet', 'balanced', 'vocal'));
ALTER TABLE agent_inbox DROP CONSTRAINT agent_inbox_reason_check;
ALTER TABLE agent_inbox ADD CONSTRAINT agent_inbox_reason_check
    CHECK (reason IN ('direct', 'handoff', 'protocol', 'command', 'lurk'));

-- Durable per-run deduplication, including retries of a lost upload response.
CREATE TABLE agent_run_images (
    run_id CHAR(26) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    digest CHAR(64) NOT NULL,
    file_id CHAR(26) NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    message_id CHAR(26) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (run_id, digest)
);
ALTER TABLE agent_run_images ENABLE ROW LEVEL SECURITY;
