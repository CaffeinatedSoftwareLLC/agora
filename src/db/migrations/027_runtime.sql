-- Sandboxed runtime (docs/planning/sandbox-isolation-spec.md §9).
-- exec_runs is the audit record for every submitted run, including denied ones.

CREATE TABLE exec_runs (
    id                      CHAR(26) PRIMARY KEY,
    server_id               CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id              CHAR(26) REFERENCES channels(id) ON DELETE SET NULL,
    thread_id               CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    submitted_by            CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    language                VARCHAR(20) NOT NULL DEFAULT 'deno-ts' CHECK (language IN ('deno-ts')),
    code                    TEXT,                     -- cleared by retention (code_pruned_at)
    code_sha256             CHAR(64) NOT NULL,
    code_pruned_at          TIMESTAMPTZ,
    requested_capabilities  TEXT[] NOT NULL DEFAULT '{}',
    time_profile            VARCHAR(20) NOT NULL DEFAULT 'standard'
                            CHECK (time_profile IN ('standard', 'generation')),
    limits                  JSONB NOT NULL,           -- clamped limits actually applied
    gate_decision           VARCHAR(20) CHECK (gate_decision IN ('auto_run', 'needs_approval', 'deny')),
    gate_source             VARCHAR(20),
    gate_confidence         REAL,
    gate_reason             TEXT,
    approved_by             CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    approved_at             TIMESTAMPTZ,
    status                  VARCHAR(20) NOT NULL DEFAULT 'submitted' CHECK (status IN (
                                'submitted', 'gated', 'awaiting_approval', 'queued', 'running',
                                'succeeded', 'failed', 'timeout', 'killed', 'error', 'denied')),
    exit_code               INTEGER,
    stdout_tail             TEXT,
    stderr_tail             TEXT,
    error                   TEXT,
    container_id            VARCHAR(80),
    capability_calls        INTEGER NOT NULL DEFAULT 0,
    cost_micros             BIGINT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at              TIMESTAMPTZ,
    finished_at             TIMESTAMPTZ
);

CREATE INDEX idx_exec_runs_server ON exec_runs(server_id, created_at DESC);
CREATE INDEX idx_exec_runs_active ON exec_runs(status) WHERE status IN ('queued', 'running');

-- Per-run capability tokens. Minted by the runner when a run starts, revoked when
-- it ends; only the SHA-256 hash is stored. Validated by cap-gateway (WBS 3.4).
CREATE TABLE exec_run_tokens (
    token_hash      CHAR(64) PRIMARY KEY,
    run_id          CHAR(26) NOT NULL REFERENCES exec_runs(id) ON DELETE CASCADE,
    server_id       CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    capabilities    TEXT[] NOT NULL DEFAULT '{}',
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_exec_run_tokens_run ON exec_run_tokens(run_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON exec_runs TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON exec_run_tokens TO app_user;
