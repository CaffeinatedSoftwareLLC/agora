-- Model agents (docs/model-agents.md): named bots that run on the server, each with
-- its own provider and model, and that can call a fixed set of Agora tools. A server
-- can have any number of them, unlike the single built-in assistant.

CREATE TABLE model_agents (
    id                           CHAR(26) PRIMARY KEY,
    server_id                    CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    -- The agent's bot user. Deleting the bot deletes the agent.
    bot_id                       CHAR(26) NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    provider_id                  CHAR(26) NOT NULL,
    model                        VARCHAR(200) NOT NULL,
    system_prompt                TEXT,
    -- Tool names the model is offered (src/ai/model-agent-tools.ts); unknown names are refused by the API
    tools                        TEXT[] NOT NULL DEFAULT '{}',
    -- Model calls per mention, tool rounds included
    max_steps                    SMALLINT NOT NULL DEFAULT 6 CHECK (max_steps BETWEEN 1 AND 20),
    max_output_tokens            INTEGER NOT NULL DEFAULT 2048 CHECK (max_output_tokens BETWEEN 64 AND 32000),
    -- Optional daily budgets for this agent (NULL = none), on top of the server's chat route budget
    daily_request_limit          INTEGER CHECK (daily_request_limit > 0),
    daily_token_limit            BIGINT  CHECK (daily_token_limit > 0),
    daily_cost_limit_micros      BIGINT  CHECK (daily_cost_limit_micros > 0),
    -- Optional prices (micro-USD per 1M tokens) → cost_micros on usage events
    input_price_micros_per_mtok  BIGINT  CHECK (input_price_micros_per_mtok >= 0),
    output_price_micros_per_mtok BIGINT  CHECK (output_price_micros_per_mtok >= 0),
    enabled                      BOOLEAN NOT NULL DEFAULT true,
    -- The bot token the server uses to call Agora's own API as this agent, AES-256-GCM.
    -- The plaintext is never returned by the API.
    token_id                     CHAR(26) REFERENCES bot_tokens(id) ON DELETE SET NULL,
    token_enc                    TEXT,
    token_iv                     TEXT,
    token_tag                    TEXT,
    created_by                   CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The provider must be in the same server; a provider in use can't be deleted
    FOREIGN KEY (provider_id, server_id) REFERENCES ai_providers(id, server_id) ON DELETE RESTRICT,
    CHECK ((token_enc IS NULL) = (token_iv IS NULL) AND (token_iv IS NULL) = (token_tag IS NULL))
);

CREATE INDEX idx_model_agents_server ON model_agents(server_id, created_at);
CREATE INDEX idx_model_agents_provider ON model_agents(provider_id);

-- Settings are read and written by server admins through the API; the mention handler
-- reads them as the table owner
ALTER TABLE model_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY model_agents_member ON model_agents
    FOR ALL TO app_user
    USING (is_server_member(server_id, current_setting('app.current_user_id', true)))
    WITH CHECK (is_server_member(server_id, current_setting('app.current_user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON model_agents TO app_user;

-- Usage per agent
ALTER TABLE ai_usage_events
    ADD COLUMN model_agent_id CHAR(26) REFERENCES model_agents(id) ON DELETE SET NULL;

CREATE INDEX idx_ai_usage_model_agent ON ai_usage_events(model_agent_id, created_at)
    WHERE model_agent_id IS NOT NULL;

-- How model agents are budgeted on a server. `shared` (the default, also with no row):
-- agent calls are chat usage and count toward the Chat route's daily limits, with
-- @assistant. `separate`: agent calls count only toward the pool limits below, and the
-- Chat route's limits count @assistant's calls only. Per-agent limits apply in both.
CREATE TABLE ai_model_agent_settings (
    server_id                CHAR(26) PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    budget_mode              VARCHAR(10) NOT NULL DEFAULT 'shared' CHECK (budget_mode IN ('shared', 'separate')),
    -- Daily limits for all of the server's model agents together, in `separate` mode (NULL = none)
    daily_request_limit      INTEGER CHECK (daily_request_limit > 0),
    daily_token_limit        BIGINT  CHECK (daily_token_limit > 0),
    daily_cost_limit_micros  BIGINT  CHECK (daily_cost_limit_micros > 0),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_model_agent_settings TO app_user;
