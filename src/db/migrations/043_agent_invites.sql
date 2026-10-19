-- Only a digest of the short-lived, single-use secret is retained.
-- Unauthenticated redemption failures have no actor identity.
ALTER TABLE audit_log ALTER COLUMN actor_id DROP NOT NULL;
CREATE TABLE agent_invites (
    id CHAR(26) PRIMARY KEY,
    code_hash CHAR(64) NOT NULL UNIQUE,
    bot_id CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
    redeemed_at TIMESTAMPTZ
);
ALTER TABLE agent_invites ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON agent_invites TO app_user;
CREATE POLICY agent_invites_creator ON agent_invites
    USING (created_by = current_setting('app.current_user_id', true)::CHAR(26))
    WITH CHECK (created_by = current_setting('app.current_user_id', true)::CHAR(26));
