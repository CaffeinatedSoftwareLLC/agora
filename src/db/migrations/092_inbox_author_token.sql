-- 092: the bot token a wake's message was posted with (src/lib/agent-sessions.ts routeMessage,
-- src/lib/handoffs.ts createOffer). The claim reruns the owner-bots check (provider-terms.ts
-- ownerBotOf) with it, so a token revoked, a session someone else started, or a terminal that
-- became mixed between routing and claim drops the pending wake. NULL for people's messages and
-- for rows routed before this migration (an owner bot's pending wake without it is dropped).

ALTER TABLE agent_inbox
    ADD COLUMN author_token_id CHAR(26) REFERENCES bot_tokens(id) ON DELETE SET NULL;
