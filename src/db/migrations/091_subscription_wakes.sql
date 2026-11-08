-- 091: who besides the plan owner may wake a subscription (or siwc) agent on this server.
--
-- 'owner_bots' (default): the plan owner's own messages, and their own bots' posts (a bot whose
--   bot_owner_id is the plan owner, on a token nobody else made, not from a hosted session
--   someone else started) for every reason: direct, protocol, hand-off, lurk. Like the owner
--   opening several CLIs on their own account and asking them to work together.
-- 'owner_only': stricter. Direct and lurk wakes need the plan owner's own message; agent
--   hand-offs follow the #361 rule (sessions the plan owner started, or their terminal agent
--   on a personal or invite token they made).
--
-- Anyone else's messages and bots never wake it, in either mode (src/lib/provider-terms.ts,
-- docs/provider-terms.md). The server owner changes it in Settings -> Agents
-- (PATCH /servers/:serverId/agent-settings).

ALTER TABLE servers
    ADD COLUMN subscription_wakes VARCHAR(10) NOT NULL DEFAULT 'owner_bots'
        CHECK (subscription_wakes IN ('owner_bots', 'owner_only'));
