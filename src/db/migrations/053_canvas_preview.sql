-- 053: canvas artifacts and browser previews (docs/canvas-and-preview.md).
-- 050-052 are taken by other branches.

-- An artifact is a rendered document (HTML, Markdown, Mermaid or SVG) a message carries.
-- Each post that carries it adds a version; the UI shows it in a sandboxed side pane.
CREATE TABLE artifacts (
    id             CHAR(26) PRIMARY KEY,
    server_id      CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id     CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_by     CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    title          VARCHAR(200) NOT NULL,
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('html', 'markdown', 'mermaid', 'svg')),
    -- Highest version number ever assigned; numbers are never reused after a delete
    last_version   INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_artifacts_channel ON artifacts(channel_id, updated_at DESC);

CREATE TABLE artifact_versions (
    artifact_id CHAR(26) NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL CHECK (version >= 1),
    -- The post that carried this version. Deleting the post deletes the version.
    message_id  CHAR(26) NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    author_id   CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    title       VARCHAR(200) NOT NULL,
    kind        VARCHAR(10) NOT NULL CHECK (kind IN ('html', 'markdown', 'mermaid', 'svg')),
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (artifact_id, version)
);

-- A headless-browser screenshot of a page a hosted session serves on localhost. Queued
-- by the session's agent (or a director), claimed by the session's host, which posts the
-- screenshot back; the API stores it through storeFile() and posts it as the session bot.
CREATE TABLE browser_previews (
    id                 CHAR(26) PRIMARY KEY,
    session_id         CHAR(26) NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    channel_id         CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    thread_id          CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    host_id            CHAR(26) NOT NULL REFERENCES agent_hosts(id) ON DELETE CASCADE,
    profile_generation INTEGER NOT NULL,
    requested_by       CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url                VARCHAR(2048) NOT NULL,
    options            JSONB NOT NULL DEFAULT '{}',
    status             VARCHAR(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'succeeded', 'failed')),
    claim_token_hash   TEXT,
    lease_until        TIMESTAMPTZ,
    result             JSONB,
    message_id         CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    file_id            CHAR(26) REFERENCES files(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at        TIMESTAMPTZ
);
-- One preview at a time per session
CREATE UNIQUE INDEX browser_previews_active ON browser_previews(session_id) WHERE status IN ('queued', 'claimed');
CREATE INDEX browser_previews_host ON browser_previews(host_id, status);

-- Written and read only by the server as the table owner, after the routes' own checks
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_previews ENABLE ROW LEVEL SECURITY;
