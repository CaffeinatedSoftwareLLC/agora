-- Agent boxes (docs/agent-boxes.md): one persistent gVisor container per agent profile,
-- run by boxd, reached only through the edge. Every box is also an agent host of kind 'box'
-- with exactly that one profile.
--
-- Written only by the server as the table owner (asService), boxd and the edge; app_user
-- gets no grants here. Members see boxes through the routes, which check the owner.

-- ─── Boxes ───
CREATE TABLE agent_boxes (
    id                  CHAR(26) PRIMARY KEY,
    server_id           CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    profile_id          CHAR(26) NOT NULL UNIQUE REFERENCES agent_profiles(id) ON DELETE CASCADE,
    host_id             CHAR(26) NOT NULL UNIQUE REFERENCES agent_hosts(id) ON DELETE CASCADE,
    -- Where its edge request cards and notices go
    home_channel_id     CHAR(26) REFERENCES channels(id) ON DELETE SET NULL,
    -- Bumped on every container creation (create, rebuild, upgrade, reset, restore). Box host and
    -- bot tokens and the edge signature carry it; an old generation is dead (§4.1).
    generation          INTEGER NOT NULL DEFAULT 0,
    desired_state       VARCHAR(10) NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running', 'stopped', 'deleted')),
    state               VARCHAR(12) NOT NULL DEFAULT 'creating'
                        CHECK (state IN ('creating', 'running', 'stopped', 'failed', 'deleted')),
    -- An owner action boxd hasn't done yet
    pending_action      VARCHAR(10) CHECK (pending_action IN ('restart', 'rebuild', 'reset')),
    action_requested_at TIMESTAMPTZ,
    -- What boxd last created: box/VERSION of its image, the container, its /28
    image_version       INTEGER,
    container_id        VARCHAR(80),
    subnet              VARCHAR(18),
    cpus                NUMERIC(4,2) NOT NULL DEFAULT 2 CHECK (cpus > 0 AND cpus <= 16),
    memory_mb           INTEGER NOT NULL DEFAULT 4096 CHECK (memory_mb BETWEEN 512 AND 65536),
    pids                INTEGER NOT NULL DEFAULT 1024 CHECK (pids BETWEEN 64 AND 16384),
    -- Exact names or *.suffix entries the edge lets the box CONNECT to (§4.2)
    allowed_domains     TEXT[] NOT NULL DEFAULT '{}',
    -- auth "api_key" profiles: the key (encrypted with AGORA_ENCRYPTION_KEY) and its variable name
    api_key_env         VARCHAR(64),
    api_key_enc         TEXT,
    api_key_iv          TEXT,
    api_key_tag         TEXT,
    login_state         VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (login_state IN ('none', 'pending', 'logged_in', 'failed')),
    last_error          VARCHAR(500),
    last_error_at       TIMESTAMPTZ,
    failures            INTEGER NOT NULL DEFAULT 0,
    last_seen_at        TIMESTAMPTZ,
    deleted_at          TIMESTAMPTZ,
    -- A deleted box's home volume is kept until then (§9.6)
    volume_purge_after  TIMESTAMPTZ,
    created_by          CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_agent_boxes_server ON agent_boxes(server_id);
CREATE UNIQUE INDEX idx_agent_boxes_subnet ON agent_boxes(subnet) WHERE subnet IS NOT NULL AND deleted_at IS NULL;

-- ─── Repos attached to a box (github.com in v1, §5) ───
CREATE TABLE box_repos (
    box_id              CHAR(26) NOT NULL REFERENCES agent_boxes(id) ON DELETE CASCADE,
    owner               VARCHAR(39) NOT NULL CHECK (owner ~ '^[A-Za-z0-9-]{1,39}$'),
    repo                VARCHAR(100) NOT NULL CHECK (repo ~ '^[A-Za-z0-9._-]{1,100}$' AND repo NOT IN ('.', '..')),
    default_branch      VARCHAR(255),
    default_checked_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (box_id, owner, repo)
);

-- ─── Push and PR auto-allow, per box and channel (§5.2) ───
CREATE TABLE box_push_policies (
    box_id              CHAR(26) NOT NULL REFERENCES agent_boxes(id) ON DELETE CASCADE,
    channel_id          CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    auto_push           BOOLEAN NOT NULL DEFAULT false,
    auto_pr             BOOLEAN NOT NULL DEFAULT false,
    updated_by          CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (box_id, channel_id)
);

-- ─── Edge requests: domains, pushes, PRs waiting on the owner (§4.3) ───
CREATE TABLE box_edge_requests (
    id                  CHAR(26) PRIMARY KEY,
    server_id           CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    box_id              CHAR(26) NOT NULL REFERENCES agent_boxes(id) ON DELETE CASCADE,
    generation          INTEGER NOT NULL,
    kind                VARCHAR(6) NOT NULL CHECK (kind IN ('domain', 'push', 'pr')),
    -- domain: { host }; push: { owner, repo, commands: [[old, new, ref], ...] sorted };
    -- pr: { owner, repo, head, headSha, base, baseSha, payloadHash, title, draft }
    subject             JSONB NOT NULL,
    subject_hash        CHAR(64) NOT NULL,
    status              VARCHAR(9) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'in_flight', 'used', 'unknown', 'changed')),
    message_id          CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    decided_by          CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    decided_at          TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ NOT NULL,
    -- What the upstream said (PR number and URL, refs updated); never credentials
    result              JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One open card per box and subject
CREATE UNIQUE INDEX idx_box_edge_requests_open ON box_edge_requests(box_id, kind, subject_hash) WHERE status = 'pending';
CREATE INDEX idx_box_edge_requests_lookup ON box_edge_requests(box_id, kind, subject_hash, status);

-- ─── The owner's GitHub token, used only by the edge (§3.2) ───
CREATE TABLE box_github_credentials (
    server_id           CHAR(26) PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    token_enc           TEXT NOT NULL,
    token_iv            TEXT NOT NULL,
    token_tag           TEXT NOT NULL,
    account_login       VARCHAR(39),
    set_by              CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    set_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CLI logins inside a box (§8.2) ───
CREATE TABLE box_login_requests (
    id                  CHAR(26) PRIMARY KEY,
    box_id              CHAR(26) NOT NULL REFERENCES agent_boxes(id) ON DELETE CASCADE,
    status              VARCHAR(13) NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested', 'claimed', 'awaiting_user', 'awaiting_code', 'code_sent', 'succeeded', 'failed', 'expired', 'cancelled')),
    -- What the CLI printed for the owner; deleted when the login ends
    verification_url    VARCHAR(2000),
    user_code           VARCHAR(64),
    -- The code the owner pasted (Claude), encrypted, deleted once the host has read it
    pasted_code_enc     TEXT,
    pasted_code_iv      TEXT,
    pasted_code_tag     TEXT,
    error               VARCHAR(300),
    requested_by        CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX idx_box_login_requests_open ON box_login_requests(box_id)
    WHERE status IN ('requested', 'claimed', 'awaiting_user', 'awaiting_code', 'code_sent');

-- ─── Hosts and tokens know their box (§3.2, §4.1) ───
ALTER TABLE agent_hosts
    ADD COLUMN kind           VARCHAR(7) NOT NULL DEFAULT 'machine' CHECK (kind IN ('machine', 'box')),
    ADD COLUMN box_id         CHAR(26),
    ADD COLUMN box_generation INTEGER;
CREATE INDEX idx_agent_hosts_box ON agent_hosts(box_id) WHERE box_id IS NOT NULL;

ALTER TABLE bot_tokens
    ADD COLUMN box_id         CHAR(26) REFERENCES agent_boxes(id) ON DELETE CASCADE,
    ADD COLUMN box_generation INTEGER;
CREATE INDEX idx_bot_tokens_box ON bot_tokens(box_id) WHERE box_id IS NOT NULL;

-- ─── Host mode: an agent run unboxed on the machine (§10) ───
ALTER TABLE agent_profiles
    ADD COLUMN host_mode        BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN host_mode_ack_at TIMESTAMPTZ,
    ADD COLUMN host_mode_ack_by CHAR(26) REFERENCES users(id) ON DELETE SET NULL;
-- Every profile so far runs on a machine host: that is host mode, acknowledged by being set up
UPDATE agent_profiles SET host_mode = true, host_mode_ack_at = NOW();

ALTER TABLE agent_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_push_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_edge_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_github_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_login_requests ENABLE ROW LEVEL SECURITY;
