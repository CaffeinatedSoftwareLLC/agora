-- Add UPDATE policy for channels table so app_user can update channel settings
-- (e.g. max_bot_hops via PATCH /channels/:id/bot-config)
CREATE POLICY channels_update ON channels
    FOR UPDATE
    TO app_user
    USING (is_server_member(server_id, current_setting('app.current_user_id', true)));
