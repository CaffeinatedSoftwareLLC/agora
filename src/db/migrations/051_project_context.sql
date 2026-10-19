-- 051: Channel project context and verify before yield (docs/project-context.md).
-- 050 is PR #105's; 052-054 are reserved for the other beta groups.
--
-- Project context: the owner and directors pin instructions and up to 10 files to a
-- channel. Every hosted wake carries them (agora-host's prompt) and agents read them with
-- the project_context MCP tool. `version` goes up on every change; a session remembers the
-- version its last successful run was given, so pinned file text is sent again only when it
-- changed or the agent starts a fresh conversation.
--
-- Verify before yield: an owner-set command the agent host runs in the session worktree
-- after a run that changed files. Off (NULL) by default. The host runs it only if its own
-- config lists the exact command (agora-host README, "Verify before yield").
CREATE TABLE channel_projects (
    channel_id          CHAR(26) PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    server_id           CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    instructions        TEXT NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 8000),
    version             INTEGER NOT NULL DEFAULT 0,
    -- Plain words only: the host splits on spaces and runs it without a shell
    verify_command      VARCHAR(300) CHECK (verify_command ~ '^[A-Za-z0-9_./:@=+,-]+( [A-Za-z0-9_./:@=+,-]+)*$'),
    verify_max_retries  SMALLINT NOT NULL DEFAULT 2 CHECK (verify_max_retries BETWEEN 0 AND 5),
    -- Who last wrote the instructions: subscription agents get them only from the owner
    instructions_by     CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    updated_by          CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE channel_project_files (
    channel_id  CHAR(26) NOT NULL REFERENCES channel_projects(channel_id) ON DELETE CASCADE,
    file_id     CHAR(26) NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    position    SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 9),
    pinned_by   CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    pinned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, file_id),
    UNIQUE (channel_id, position)
);

-- The project version a session's last successful run was given
ALTER TABLE agent_sessions ADD COLUMN project_version_seen INTEGER;
-- The project version a run was claimed with, and what its verify step found
ALTER TABLE agent_runs ADD COLUMN project_version INTEGER;
ALTER TABLE agent_runs ADD COLUMN verification JSONB;

-- Written and read only by the server as the table owner, after the route's own checks
ALTER TABLE channel_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_project_files ENABLE ROW LEVEL SECURITY;
