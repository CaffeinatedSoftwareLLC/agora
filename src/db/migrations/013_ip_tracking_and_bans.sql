-- Encrypted IP tracking on users
ALTER TABLE users ADD COLUMN last_ip_hmac TEXT;
ALTER TABLE users ADD COLUMN last_ip_encrypted TEXT;
CREATE INDEX idx_users_last_ip_hmac ON users(last_ip_hmac);

-- IP bans table
CREATE TABLE ip_bans (
    id           CHAR(26) PRIMARY KEY,
    ip_hmac      TEXT NOT NULL UNIQUE,
    ip_encrypted TEXT NOT NULL,
    reason       TEXT,
    banned_by    CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    expires_at   TIMESTAMPTZ
);

CREATE INDEX idx_ip_bans_created ON ip_bans(created_at DESC);

-- Grant app_user access
GRANT SELECT, INSERT, UPDATE, DELETE ON ip_bans TO app_user;
