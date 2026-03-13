-- ai_provider_config: one AI config per server, encrypted API key
CREATE TABLE ai_provider_config (
    server_id       CHAR(26) PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    provider        VARCHAR(20) NOT NULL CHECK (provider IN ('claude', 'openai')),
    model           VARCHAR(100) NOT NULL,
    api_key_enc     TEXT NOT NULL,
    api_key_iv      TEXT NOT NULL,
    api_key_tag     TEXT NOT NULL,
    bot_id          CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    system_prompt   TEXT,
    max_context     INTEGER DEFAULT 20,
    enabled         BOOLEAN DEFAULT true NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ai_usage_events: append-only usage ledger
CREATE TABLE ai_usage_events (
    id              CHAR(26) PRIMARY KEY,
    server_id       CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id      CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id         CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    message_id      CHAR(26) NOT NULL,
    provider        VARCHAR(20) NOT NULL,
    model           VARCHAR(100) NOT NULL,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_usage_server ON ai_usage_events(server_id, created_at);

-- ai_dispatch_log: DB-backed idempotency for duplicate mention prevention
CREATE TABLE ai_dispatch_log (
    message_id      CHAR(26) NOT NULL,
    bot_id          CHAR(26) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (message_id, bot_id)
);

-- RLS grants
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_provider_config TO app_user;
GRANT SELECT, INSERT ON ai_usage_events TO app_user;
GRANT SELECT, INSERT ON ai_dispatch_log TO app_user;
