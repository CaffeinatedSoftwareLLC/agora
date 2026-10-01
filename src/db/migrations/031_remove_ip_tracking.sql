-- IP tracking and IP bans are removed (013). An IP ban is easy to evade and can
-- block unrelated people behind the same address; registration policy, account
-- suspension and bot token revocation are the controls. This also deletes every
-- stored IP address, so nothing remains that needed IP_ENCRYPTION_KEY.
DROP TABLE IF EXISTS ip_bans;

DROP INDEX IF EXISTS idx_users_last_ip_hmac;
ALTER TABLE users DROP COLUMN IF EXISTS last_ip_hmac;
ALTER TABLE users DROP COLUMN IF EXISTS last_ip_encrypted;
