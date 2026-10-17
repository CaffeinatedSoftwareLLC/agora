-- Who may give agents instructions (docs/api-reference.md, "Who directs agents").
--
-- Humans hold the DirectAgents permission (bit 29). The server owner has it
-- implicitly; Administrator does NOT imply it, and only the owner can grant it
-- through roles or channel overrides. Bots have no roles, so a bot directs in a
-- channel only when the owner sets can_direct on its access to that channel.

ALTER TABLE bot_channel_access ADD COLUMN can_direct BOOLEAN NOT NULL DEFAULT false;
GRANT UPDATE (can_direct) ON bot_channel_access TO app_user;

-- Stamped by the server when a message is posted or edited: did its author hold
-- DirectAgents in that channel at that moment? Read APIs also re-check current
-- authority, so a revoked director's old messages carry none. Existing messages,
-- and system, assistant and bridged posts, never do.
ALTER TABLE messages ADD COLUMN author_could_direct BOOLEAN NOT NULL DEFAULT false;
