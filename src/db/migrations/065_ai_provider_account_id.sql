-- Some providers address an account as well as a key: Cloudflare Workers AI takes an
-- account ID in the URL and an API token as the key. The ID is not a secret, so it is
-- stored as it is; the token stays encrypted in api_key_enc.
ALTER TABLE ai_providers
    ADD COLUMN account_id VARCHAR(64)
        CHECK (account_id IS NULL OR account_id ~ '^[A-Za-z0-9_-]{1,64}$');
