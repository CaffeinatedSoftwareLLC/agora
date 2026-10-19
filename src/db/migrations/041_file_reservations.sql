-- Owner-assigned logical repository identity within a server. Aliases are host-local
-- mappings and are deliberately not used here. Existing profiles share "primary".
ALTER TABLE agent_profiles ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT 'primary'
    CHECK (workspace_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
ALTER TABLE agent_sessions ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT 'primary';

CREATE TABLE agent_file_reservations (
    id CHAR(26) PRIMARY KEY,
    server_id CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    workspace_id VARCHAR(64) NOT NULL,
    session_id CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    thread_id CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    paths TEXT[] NOT NULL CHECK (cardinality(paths) BETWEEN 1 AND 100),
    reason VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ
);
CREATE INDEX idx_file_reservations_workspace ON agent_file_reservations(server_id, workspace_id) WHERE released_at IS NULL;
ALTER TABLE agent_file_reservations ENABLE ROW LEVEL SECURITY;
-- All access is through authenticated routes, asService, after channel/session checks.

CREATE FUNCTION release_ended_session_reservations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state = 'ended' THEN
        UPDATE agent_file_reservations SET released_at = clock_timestamp()
        WHERE session_id = NEW.id AND released_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER release_ended_session_reservations AFTER UPDATE OF state ON agent_sessions
    FOR EACH ROW EXECUTE FUNCTION release_ended_session_reservations();
