-- Version 0 accepts pre-migration JWTs until their user first revokes all sessions.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0);
