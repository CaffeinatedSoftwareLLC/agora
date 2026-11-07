-- 090: who minted each bot token and what it is for, and which token opened a terminal session.
--
-- The plan-owner rule (docs/provider-terms.md, src/lib/agent-sessions.ts termsAllow) lets the
-- plan owner's own agent in a terminal session hand off to an owner-started subscription agent.
-- A live terminal session only proves someone holds one of the bot's tokens, so it counts only
-- when the token that opened it was minted by the plan owner for personal use (not a host's,
-- box's or model agent's token) and the message was posted with that same token.
--
-- purpose: 'personal' (POST /servers/:id/bots/:id/tokens), 'invite' (a redeemed agent invite;
-- created_by is the invite's creator), 'host' (the token made with an agent for its host's
-- config, which hosted runs get as AGORA_BOT_TOKEN), 'box' (an agent box's token), 'model'
-- (a model agent's server-side token).
--
-- Backfill: purpose from what minted the token. created_by is unknown (NULL: counts as not the
-- plan owner's) except for invite tokens, whose redeem is in the audit log with the invite.

ALTER TABLE bot_tokens
    ADD COLUMN created_by CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN purpose    VARCHAR(8) NOT NULL DEFAULT 'personal'
        CHECK (purpose IN ('personal', 'invite', 'host', 'box', 'model'));

UPDATE bot_tokens SET purpose = CASE
        WHEN box_id IS NOT NULL THEN 'box'
        WHEN name = 'agent host' THEN 'host'
        WHEN name = 'model agent (server)' THEN 'model'
        WHEN name = 'Agent invite' THEN 'invite'
        ELSE 'personal' END;

UPDATE bot_tokens t SET created_by = i.created_by
FROM audit_log a
JOIN agent_invites i ON i.id = (a.changes->>'inviteId')
WHERE a.action = 'agent_invite_redeem'
  AND t.purpose = 'invite'
  AND t.id = (a.changes->>'tokenId')
  AND i.bot_id = t.bot_id;

-- The token whose socket opened a terminal session; NULL when unknown or when sockets with
-- different tokens shared the session (src/lib/terminal-sessions.ts attachTerminal)
ALTER TABLE agent_sessions
    ADD COLUMN token_id CHAR(26) REFERENCES bot_tokens(id) ON DELETE SET NULL;
