-- Provider registry: any number of configured providers per server, plus a
-- capability → provider/model routing table. Replaces the single provider/key
-- that lived on ai_provider_config (one per server, Claude/OpenAI only).

-- ULID generator for SQL-side inserts (backfill below). Crockford base32,
-- 48-bit ms timestamp + 80 random bits, same shape as src/utils/ulid.ts.
CREATE OR REPLACE FUNCTION gen_ulid() RETURNS CHAR(26) AS $$
DECLARE
    alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    ts BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
    out TEXT := '';
    i INT;
BEGIN
    FOR i IN REVERSE 9..0 LOOP
        out := out || substr(alphabet, ((ts >> (i * 5)) & 31)::INT + 1, 1);
    END LOOP;
    FOR i IN 1..16 LOOP
        out := out || substr(alphabet, floor(random() * 32)::INT + 1, 1);
    END LOOP;
    RETURN out;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ─── Configured providers ───
CREATE TABLE ai_providers (
    id              CHAR(26) PRIMARY KEY,
    server_id       CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    adapter         VARCHAR(40) NOT NULL,          -- validated against src/ai/adapters
    label           VARCHAR(100) NOT NULL,
    base_url        TEXT,                          -- adapter-specific API root (e.g. Ollama)
    api_key_enc     TEXT,                          -- AES-256-GCM; NULL for keyless local servers
    api_key_iv      TEXT,
    api_key_tag     TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, label),
    UNIQUE (id, server_id),
    CHECK ((api_key_enc IS NULL) = (api_key_iv IS NULL) AND (api_key_iv IS NULL) = (api_key_tag IS NULL))
);

-- ─── Capability routing ───
CREATE TABLE ai_capability_routes (
    server_id                    CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    capability                   VARCHAR(20) NOT NULL
                                 CHECK (capability IN ('chat', 'search', 'image', 'tts', 'video', 'decide')),
    provider_id                  CHAR(26) NOT NULL,
    model                        VARCHAR(100) NOT NULL,
    enabled                      BOOLEAN NOT NULL DEFAULT false,
    -- Optional daily budgets (NULL = unlimited)
    daily_request_limit          INTEGER CHECK (daily_request_limit > 0),
    daily_token_limit            BIGINT  CHECK (daily_token_limit > 0),
    daily_cost_limit_micros      BIGINT  CHECK (daily_cost_limit_micros > 0),
    -- Optional admin-entered prices (micro-USD per 1M tokens) → cost_micros on usage events
    input_price_micros_per_mtok  BIGINT  CHECK (input_price_micros_per_mtok >= 0),
    output_price_micros_per_mtok BIGINT  CHECK (output_price_micros_per_mtok >= 0),
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (server_id, capability),
    -- Route can only point at a provider in the same server
    FOREIGN KEY (provider_id, server_id) REFERENCES ai_providers(id, server_id) ON DELETE CASCADE
);

-- ─── Backfill from the single-provider config ───
INSERT INTO ai_providers (id, server_id, adapter, label, api_key_enc, api_key_iv, api_key_tag)
SELECT gen_ulid(),
       server_id,
       CASE provider WHEN 'claude' THEN 'anthropic' ELSE provider END,
       CASE provider WHEN 'claude' THEN 'Anthropic' ELSE 'OpenAI' END,
       api_key_enc, api_key_iv, api_key_tag
FROM ai_provider_config;

INSERT INTO ai_capability_routes (server_id, capability, provider_id, model, enabled)
SELECT c.server_id, 'chat', p.id, c.model, true
FROM ai_provider_config c
JOIN ai_providers p ON p.server_id = c.server_id;

-- ai_provider_config keeps assistant-only settings; the assistant uses the chat route.
-- Keys now live only in ai_providers.
ALTER TABLE ai_provider_config
    DROP CONSTRAINT ai_provider_config_provider_check,
    DROP COLUMN provider,
    DROP COLUMN model,
    DROP COLUMN api_key_enc,
    DROP COLUMN api_key_iv,
    DROP COLUMN api_key_tag;

-- ─── Usage ledger: non-chat calls may have no channel/message ───
ALTER TABLE ai_usage_events
    ALTER COLUMN channel_id DROP NOT NULL,
    ALTER COLUMN message_id DROP NOT NULL,
    ADD COLUMN capability VARCHAR(20) NOT NULL DEFAULT 'chat',
    ADD COLUMN provider_id CHAR(26) REFERENCES ai_providers(id) ON DELETE SET NULL,
    ADD COLUMN cost_micros BIGINT,
    ADD COLUMN run_id CHAR(26);

CREATE INDEX idx_ai_usage_server_capability ON ai_usage_events(server_id, capability, created_at);

-- ─── Instance setting: allow provider base URLs on private networks (local Ollama) ───
INSERT INTO instance_settings (key, value) VALUES ('ai.allow_private_base_urls', 'false'::jsonb)
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_providers TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_capability_routes TO app_user;
