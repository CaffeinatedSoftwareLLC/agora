-- 092: the bot token a wake's message was posted with (src/lib/agent-sessions.ts routeMessage,
-- src/lib/handoffs.ts createOffer). The claim reruns the owner-bots check (provider-terms.ts
-- ownerBotOf) with it, so a token revoked, a session someone else started, or a terminal that
-- became mixed between routing and claim drops the pending wake. NULL for people's messages and
-- for rows routed before this migration (an owner bot's pending wake without it is dropped).

ALTER TABLE agent_inbox
    ADD COLUMN author_token_id CHAR(26) REFERENCES bot_tokens(id) ON DELETE SET NULL;

-- Lookups by message: the owner-bots loop guard (a message's 'direct' wakes) and the unreachable
-- @mention check. The unique (session_id, message_id) index doesn't serve them.
CREATE INDEX IF NOT EXISTS idx_agent_inbox_message ON agent_inbox (message_id);

-- Deleting a bot token sets its rows' author_token_id to NULL (ON DELETE SET NULL)
CREATE INDEX IF NOT EXISTS idx_agent_inbox_author_token ON agent_inbox (author_token_id) WHERE author_token_id IS NOT NULL;

-- The loop guard walks a channel's top-level posts newest first (thread replies use
-- idx_messages_thread_replies on (thread_id, id))
CREATE INDEX IF NOT EXISTS idx_messages_channel_top_level ON messages (channel_id, id DESC) WHERE thread_id IS NULL;
