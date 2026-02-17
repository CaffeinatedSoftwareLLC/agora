-- Store the instance server ID in instance_config for efficient lookup.
-- Backfill from existing instances (picks the oldest server).
INSERT INTO instance_config (key, value)
SELECT 'instance_server_id', s.id FROM servers s ORDER BY s.created_at LIMIT 1
ON CONFLICT (key) DO NOTHING;
