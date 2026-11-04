-- 074: GitHub issues bridge (docs/github-issues.md).
-- A channel links to one GitHub repository. Agora stores no GitHub token: the host the owner
-- picks runs `gh` with the owner's own login, as Check PR does (src/routes/workspace-review.ts).

-- ─── The channel's linked repository ───
CREATE TABLE channel_github_repos (
    channel_id  CHAR(26) PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    server_id   CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    -- owner/name, as GitHub allows them
    repo        VARCHAR(140) NOT NULL CHECK (repo ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$'),
    -- The agent host whose `gh` reads issues for this channel
    host_id     CHAR(26) NOT NULL REFERENCES agent_hosts(id) ON DELETE CASCADE,
    linked_by   CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE channel_github_repos ENABLE ROW LEVEL SECURITY;

-- ─── A card made from an issue ───
ALTER TABLE task_cards
    ADD COLUMN issue_repo   VARCHAR(140),
    ADD COLUMN issue_number INTEGER CHECK (issue_number > 0),
    ADD COLUMN issue_url    VARCHAR(2048),
    -- The last pull request state commented on the issue (opened, merged, closed), so a
    -- repeated Check PR doesn't comment twice
    ADD COLUMN issue_reported VARCHAR(8) CHECK (issue_reported IN ('open', 'merged', 'closed')),
    ADD CONSTRAINT task_cards_issue_complete CHECK ((issue_repo IS NULL) = (issue_number IS NULL));
-- One card per issue per channel
CREATE UNIQUE INDEX idx_task_cards_issue ON task_cards(channel_id, lower(issue_repo), issue_number) WHERE issue_number IS NOT NULL;

-- ─── Commands for the host's `gh` ───
-- issue_list: open issues of the linked repo, for the picker. issue_comment: a fixed status
-- line on a card's issue when its pull request opens, merges or closes.
CREATE TABLE github_commands (
    id               CHAR(26) PRIMARY KEY,
    server_id        CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id       CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    host_id          CHAR(26) NOT NULL REFERENCES agent_hosts(id) ON DELETE CASCADE,
    -- NULL when the server queued it (an issue comment)
    requested_by     CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    action           VARCHAR(16) NOT NULL CHECK (action IN ('issue_list', 'issue_comment')),
    repo             VARCHAR(140) NOT NULL,
    payload          JSONB NOT NULL DEFAULT '{}',
    status           VARCHAR(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'succeeded', 'failed')),
    claim_token_hash TEXT,
    lease_until      TIMESTAMPTZ,
    result           JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at      TIMESTAMPTZ
);
CREATE INDEX idx_github_commands_host ON github_commands(host_id, id) WHERE status IN ('queued', 'claimed');
ALTER TABLE github_commands ENABLE ROW LEVEL SECURITY;
