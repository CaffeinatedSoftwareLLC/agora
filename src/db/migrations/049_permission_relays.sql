-- 049: Claude Code Channel permission relay (docs/claude-channel.md).
-- 046-048 are taken by other branches.
--
-- A Claude Code session the user runs themselves ("bring your own session") with the
-- agora channel loaded forwards its tool-permission prompts here. Each one is shown in the
-- channel as an approval card; the server owner allows or denies it, and the verdict goes
-- back to the bot's socket, which hands it to Claude Code. Unlike agent_tool_requests
-- there is no hosted session or profile behind it, only the bot.
CREATE TABLE permission_relays (
    id             CHAR(26) PRIMARY KEY,
    server_id      CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id     CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    bot_id         CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Claude Code's request_id: five lowercase letters a-z without l
    relay_id       CHAR(5) NOT NULL CHECK (relay_id ~ '^[a-km-z]{5}$'),
    tool_name      VARCHAR(200) NOT NULL,
    description    TEXT NOT NULL,
    input_preview  TEXT NOT NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'allow', 'deny')),
    message_id     CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    decided_by     CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    decided_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A repeated prompt with the same ID from the same bot doesn't post a second card
CREATE UNIQUE INDEX idx_permission_relays_pending ON permission_relays(bot_id, relay_id) WHERE status = 'pending';

-- Written and read only by the server as the table owner, after the route's own checks
ALTER TABLE permission_relays ENABLE ROW LEVEL SECURITY;
