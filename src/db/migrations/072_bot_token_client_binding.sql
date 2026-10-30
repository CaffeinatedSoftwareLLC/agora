-- Issue #39: bind each bot token to the MCP client that first uses it, and record where
-- it is used from. agora-mcp names its client (`X-Agora-Client`, from the MCP initialize
-- handshake); a token bound to one client is refused for any other (src/auth/token-binding.ts).
ALTER TABLE bot_tokens
    ADD COLUMN bound_client          VARCHAR(100),
    ADD COLUMN bound_at              TIMESTAMPTZ,
    ADD COLUMN last_used_client      VARCHAR(100),
    ADD COLUMN last_used_ip          VARCHAR(64),
    ADD COLUMN last_used_user_agent  VARCHAR(200),
    ADD COLUMN last_refused_at       TIMESTAMPTZ,
    ADD COLUMN last_refused_client   VARCHAR(100),
    ADD COLUMN last_refused_ip       VARCHAR(64);
