-- Migration 011: Grant app_user access to instance_config
-- instance_config was created in 007 after the blanket GRANT ALL TABLES in 006,
-- so app_user cannot read/write it. Admin routes need UPDATE + SELECT access.

GRANT SELECT, UPDATE ON instance_config TO app_user;
