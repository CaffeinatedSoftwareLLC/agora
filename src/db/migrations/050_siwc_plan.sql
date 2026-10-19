-- Codex on a person's own ChatGPT plan through Sign in with ChatGPT (docs/codex-chatgpt-plan.md).
--
-- A third auth mode, 'siwc': the host signed in to ChatGPT with OpenAI's open-source
-- token-sharing flow and runs `codex app-server` with that plan's OAuth access token. The
-- tokens stay on the host. Agora only learns that a profile is connected, and binds the
-- profile to the person whose plan it is (plan_owner_id): only that person can wake it,
-- the same rule as a 'subscription' profile and the server owner.
DO $$
DECLARE c TEXT;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'agent_profiles'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%auth_mode%'
    LOOP
        EXECUTE format('ALTER TABLE agent_profiles DROP CONSTRAINT %I', c);
    END LOOP;
END $$;
ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_auth_mode_check
    CHECK (auth_mode IN ('subscription', 'api_key', 'siwc'));
-- The person whose ChatGPT plan a 'siwc' profile uses. Set when the host reports a
-- completed sign-in; unused by the other modes.
ALTER TABLE agent_profiles ADD COLUMN plan_owner_id CHAR(26) REFERENCES users(id) ON DELETE SET NULL;

-- The connection state Settings → Agents shows, and the "Connect" request the host picks up.
-- status: requested (waiting for the host) → in_progress (browser open on the host) →
-- connected | scope_missing | failed; disconnect_requested → disconnected.
CREATE TABLE agent_plan_connections (
    profile_id     CHAR(26) PRIMARY KEY REFERENCES agent_profiles(id) ON DELETE CASCADE,
    server_id      CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    status         VARCHAR(24) NOT NULL CHECK (status IN ('requested', 'in_progress', 'connected', 'scope_missing',
                                                          'failed', 'disconnect_requested', 'disconnected')),
    requested_by   CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    -- The ChatGPT account's email, for the person to recognise it. Never a token.
    account_label  VARCHAR(320),
    error          VARCHAR(64),
    requested_at   TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_agent_plan_connections_server ON agent_plan_connections(server_id, status);

-- Written and read only by the server as the table owner, after the route's own checks
ALTER TABLE agent_plan_connections ENABLE ROW LEVEL SECURITY;
