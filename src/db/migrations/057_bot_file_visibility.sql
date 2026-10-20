-- Bots see the files of channels they were given (bot_channel_access), as they already see
-- those channels' messages. Without this, row-level security hid every attachment from a bot:
-- chat history showed a pasted screenshot's message with no attachment, so an agent could
-- not find the image to look at. PostgreSQL ORs SELECT policies, so human access is unchanged.
CREATE POLICY files_bot_select ON files
    FOR SELECT TO app_user
    USING (
        channel_id IS NOT NULL
        AND is_bot_channel_member(channel_id, current_setting('app.current_user_id', true))
    );
