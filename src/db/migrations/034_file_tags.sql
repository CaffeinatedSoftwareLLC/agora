-- File tagging and ranking with the optional decision model
-- (docs/planning/jev-wbs.md, C). Tags come from a list each server's admins edit;
-- a decision model answers one yes/no question per tag about each uploaded file.
-- Nothing here runs unless file tagging is switched on for the server.
--
-- What is stored in plain text: tag names and criteria, and per file the
-- probability of each tag. No file text is stored (docs/storage-and-encryption.md).

-- ─── The tag vocabulary ───
CREATE TABLE file_tag_definitions (
    id              CHAR(26) PRIMARY KEY,
    server_id       CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name            VARCHAR(40) NOT NULL,
    -- The yes/no question asked about a file, and what counts as yes and as no
    instructions    TEXT NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 500),
    criteria_true   TEXT CHECK (char_length(criteria_true) <= 500),
    criteria_false  TEXT CHECK (char_length(criteria_false) <= 500),
    -- Goes up whenever the question or its criteria change: results made with an
    -- older revision are stale
    revision        INTEGER NOT NULL DEFAULT 1,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_file_tag_definitions_name ON file_tag_definitions(server_id, lower(name));

-- Whether this server has been given the default tag set (so deleting them all sticks)
ALTER TABLE ai_decision_settings ADD COLUMN tags_seeded BOOLEAN NOT NULL DEFAULT false;

-- ─── Tag results per file ───
CREATE TABLE file_tags (
    file_id          CHAR(26) NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag_id           CHAR(26) NOT NULL REFERENCES file_tag_definitions(id) ON DELETE CASCADE,
    -- The tag revision and question wording this result was made with
    tag_revision     INTEGER NOT NULL,
    question_version VARCHAR(40) NOT NULL,
    probability      REAL NOT NULL CHECK (probability BETWEEN 0 AND 1),
    -- The model that answered, as the provider reported it
    model            VARCHAR(100) NOT NULL,
    tagged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, tag_id)
);

CREATE INDEX idx_file_tags_tag ON file_tags(tag_id);

-- ─── The tagging queue: one row per file ───
-- pending → running → done | skipped | failed. A running job holds a lease; a
-- worker that outlives its lease is fenced out by claim_generation.
CREATE TABLE file_tag_jobs (
    file_id               CHAR(26) PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    server_id             CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    state                 VARCHAR(10) NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'running', 'done', 'skipped', 'failed')),
    attempts              INTEGER NOT NULL DEFAULT 0,
    claim_generation      INTEGER NOT NULL DEFAULT 0,
    lease_expires_at      TIMESTAMPTZ,
    -- Not before this time (retry backoff, waiting for budget)
    run_after             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 'full': the whole text was read; 'partial': the file was longer than the limits
    coverage              VARCHAR(10) CHECK (coverage IN ('full', 'partial')),
    -- Highest probability, over the text read, that it tries to instruct an AI reader
    injection_probability REAL CHECK (injection_probability BETWEEN 0 AND 1),
    -- Why the job was skipped or failed, or why it is waiting
    detail                TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_file_tag_jobs_claim ON file_tag_jobs(run_after) WHERE state IN ('pending', 'running');
CREATE INDEX idx_file_tag_jobs_server ON file_tag_jobs(server_id, state);

-- A soft-deleted file loses its tags and its job at once, whichever code path deleted it
CREATE OR REPLACE FUNCTION drop_file_tagging() RETURNS trigger AS $$
BEGIN
    DELETE FROM file_tags WHERE file_id = NEW.id;
    DELETE FROM file_tag_jobs WHERE file_id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER files_soft_delete_drops_tagging
    AFTER UPDATE OF deleted_at ON files
    FOR EACH ROW
    WHEN (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
    EXECUTE FUNCTION drop_file_tagging();

-- ─── Row Level Security ───
-- Definitions: any member of the server may read them (tag names appear on files);
-- routes restrict writes to administrators.
ALTER TABLE file_tag_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY file_tag_definitions_select ON file_tag_definitions
    FOR SELECT TO app_user
    USING (is_server_member(server_id, current_setting('app.current_user_id', true)));

CREATE POLICY file_tag_definitions_write ON file_tag_definitions
    FOR ALL TO app_user
    USING (is_server_member(server_id, current_setting('app.current_user_id', true)))
    WITH CHECK (is_server_member(server_id, current_setting('app.current_user_id', true)));

-- Results and jobs: visible exactly where the file is (the subquery is itself
-- filtered by the files policies). Only the worker, as table owner, writes results.
ALTER TABLE file_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY file_tags_select ON file_tags
    FOR SELECT TO app_user
    USING (EXISTS (SELECT 1 FROM files f WHERE f.id = file_tags.file_id));

ALTER TABLE file_tag_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY file_tag_jobs_select ON file_tag_jobs
    FOR SELECT TO app_user
    USING (EXISTS (SELECT 1 FROM files f WHERE f.id = file_tag_jobs.file_id));

-- Jobs are created and re-queued by the server itself (upload hook, sweep, and the
-- admin re-tag route after its Administrator check), never under a request's role.
GRANT SELECT, INSERT, UPDATE, DELETE ON file_tag_definitions TO app_user;
GRANT SELECT ON file_tags TO app_user;
GRANT SELECT ON file_tag_jobs TO app_user;
