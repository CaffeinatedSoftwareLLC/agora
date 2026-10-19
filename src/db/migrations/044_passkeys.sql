-- Passkeys (WebAuthn credentials), optional and additive to passwords (#78).
-- A credential is bound to the RP ID (hostname) it was registered on.
CREATE TABLE user_passkeys (
    id CHAR(26) PRIMARY KEY,
    user_id CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- base64url credential ID as the browser reports it
    credential_id TEXT NOT NULL UNIQUE,
    public_key BYTEA NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    transports TEXT[] NOT NULL DEFAULT '{}',
    device_type TEXT NOT NULL,
    backed_up BOOLEAN NOT NULL DEFAULT false,
    rp_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX user_passkeys_user ON user_passkeys (user_id);
ALTER TABLE user_passkeys ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_passkeys TO app_user;
CREATE POLICY user_passkeys_owner ON user_passkeys
    USING (user_id = current_setting('app.current_user_id', true)::CHAR(26))
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::CHAR(26));
