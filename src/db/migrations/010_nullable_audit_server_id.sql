-- Allow instance-level admin actions (no server context) in audit_log
ALTER TABLE audit_log ALTER COLUMN server_id DROP NOT NULL;
