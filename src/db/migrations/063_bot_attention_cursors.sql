-- Attention delivery is independent of reading a channel/thread's full history.
CREATE TABLE bot_attention_cursors (
    bot_id CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id CHAR(26) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bot_id, channel_id)
);
ALTER TABLE bot_attention_cursors ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON bot_attention_cursors TO app_user;
CREATE POLICY attention_cursor_owner ON bot_attention_cursors TO app_user
    USING (
        bot_id = current_setting('app.current_user_id', true)
        AND public.is_bot_channel_member(channel_id, current_setting('app.current_user_id', true))
    )
    WITH CHECK (
        bot_id = current_setting('app.current_user_id', true)
        AND public.is_bot_channel_member(channel_id, current_setting('app.current_user_id', true))
    );

-- message_mentions already has a user_id index (004); this covers protocol YIELD.
CREATE INDEX idx_messages_attention_yield
    ON messages (channel_id, lower(protocol->>'yieldTo'), id)
    WHERE protocol IS NOT NULL;
