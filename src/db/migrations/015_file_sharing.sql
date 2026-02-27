-- ============================================================
-- 015_file_sharing.sql
-- File sharing: extend files table, instance settings, RLS
-- ============================================================

-- ─── Extend existing files table with new columns ───
ALTER TABLE files ADD COLUMN channel_id      CHAR(26) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE files ADD COLUMN message_id      CHAR(26) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN mime_type       VARCHAR(127);
ALTER TABLE files ADD COLUMN storage_key     VARCHAR(512);
ALTER TABLE files ADD COLUMN encryption_iv   BYTEA;
ALTER TABLE files ADD COLUMN encryption_tag  BYTEA;
ALTER TABLE files ADD COLUMN width           INTEGER;
ALTER TABLE files ADD COLUMN height          INTEGER;
ALTER TABLE files ADD COLUMN expires_at      TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN deleted_at      TIMESTAMPTZ;

-- ─── Indexes for efficient lookups ───
CREATE INDEX idx_files_channel  ON files(channel_id)  WHERE channel_id IS NOT NULL;
CREATE INDEX idx_files_message  ON files(message_id)  WHERE message_id IS NOT NULL;
CREATE INDEX idx_files_expires  ON files(expires_at)  WHERE expires_at IS NOT NULL;
CREATE INDEX idx_files_deleted  ON files(deleted_at)  WHERE deleted_at IS NOT NULL;

-- ─── Instance settings table (key-value config store) ───
CREATE TABLE IF NOT EXISTS instance_settings (
    key         VARCHAR(100) PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default file-sharing settings
INSERT INTO instance_settings (key, value) VALUES
    ('files.max_size_bytes',      '26214400'::jsonb),
    ('files.allowed_extensions',  '["jpg","jpeg","png","gif","webp","pdf","txt","md","zip","mp3","mp4","mov","csv","json"]'::jsonb),
    ('files.retention_days',      'null'::jsonb),
    ('files.storage_quota_bytes', 'null'::jsonb),
    ('files.exif_strip',          'true'::jsonb)
ON CONFLICT DO NOTHING;

-- ─── Grants ───
GRANT SELECT, INSERT, UPDATE, DELETE ON instance_settings TO app_user;

-- ─── Row Level Security on files ───
ALTER TABLE files ENABLE ROW LEVEL SECURITY;

-- app_user can SELECT files in channels they have access to (server member or DM participant)
CREATE POLICY files_select ON files
    FOR SELECT TO app_user
    USING (
        -- Files not associated with a channel are accessible (e.g. avatars)
        channel_id IS NULL
        OR EXISTS (
            SELECT 1 FROM channels c
            WHERE c.id = files.channel_id
            AND (
                -- Server channel: user is a member of the server
                (c.server_id IS NOT NULL AND is_server_member(c.server_id, current_setting('app.current_user_id', true)))
                -- DM channel: user is a participant
                OR (c.server_id IS NULL AND EXISTS (
                    SELECT 1 FROM channel_members cm
                    WHERE cm.channel_id = c.id
                    AND cm.user_id = current_setting('app.current_user_id', true)
                ))
            )
        )
    );

-- app_user can INSERT files (uploader must be current user)
CREATE POLICY files_insert ON files
    FOR INSERT TO app_user
    WITH CHECK (
        uploader_id = current_setting('app.current_user_id', true)
    );

-- app_user can UPDATE own files (e.g. linking to message after upload)
CREATE POLICY files_update ON files
    FOR UPDATE TO app_user
    USING (
        uploader_id = current_setting('app.current_user_id', true)
    );

-- app_user can DELETE (soft-delete) own files
CREATE POLICY files_delete ON files
    FOR DELETE TO app_user
    USING (
        uploader_id = current_setting('app.current_user_id', true)
    );
